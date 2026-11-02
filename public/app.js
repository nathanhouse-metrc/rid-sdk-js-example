// Retail ID SDK Explorer: the browser UI.
//
// Every SDK call runs in the local Node server (src/server.js); this page sends
// it the raw input text and shows what comes back. The saved API keys never
// reach this page, only masked.

// -- DOM helpers -------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined));
  return node;
}

let fieldId = 0;
const nextId = () => `f${++fieldId}`;

const textInput = (value = '', props = {}) => el('input', { type: 'text', value, spellcheck: 'false', autocomplete: 'off', ...props });

/** Pressing Enter in a single-line input runs `action`. */
function onEnter(input, action) {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      action();
    }
  });
  return input;
}

// -- server calls ------------------------------------------------------------

const UNREACHABLE = {
  title: 'Could not reach the explorer server',
  message: 'The page talks to the local Node server started by npm start.',
  detail: 'Check that it is still running, then try again.',
};

async function request(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, error: { title: `HTTP ${response.status}`, message: data.error ?? response.statusText, detail: '' } };
  }
  return data;
}

// -- shared widgets ------------------------------------------------------------

/** A white panel with a title, an optional hint and a grid of inputs. */
class Card {
  constructor(title, hint = '') {
    this.form = el('div', { class: 'form' });
    this.buttons = el('div', { class: 'buttons' });
    this.root = el('section', { class: 'card' },
      el('h2', { text: title }),
      hint ? el('p', { class: 'hint', text: hint }) : null,
      this.form, this.buttons);
  }

  addRow(label, control, hint = '') {
    const input = control.matches?.('input, textarea, select') ? control : control.querySelector?.('input, textarea, select');
    if (input && !input.id) input.id = nextId();
    this.form.append(
      el('label', { text: label, for: input?.id }),
      el('div', { class: 'control' }, control, hint ? el('span', { class: 'hint', text: hint }) : null),
    );
    return control;
  }

  addButton(text, onclick, kind = '') {
    const button = el('button', { type: 'button', class: `btn ${kind}`.trim(), text, onclick });
    this.buttons.append(button);
    return button;
  }
}

/** Read-only panel showing the outcome of the last action. */
class ResultView {
  constructor() {
    this.output = el('div', { class: 'output', tabindex: '0', 'aria-live': 'polite' });
    this.root = el('section', { class: 'results' },
      el('div', { class: 'results-top' },
        el('h2', { text: 'Results' }),
        el('button', { type: 'button', class: 'btn', text: 'Copy', onclick: () => this.copy() }),
        el('button', { type: 'button', class: 'btn', text: 'Clear', onclick: () => this.clear() })),
      this.output);
  }

  #write(...nodes) {
    this.output.replaceChildren(...nodes.flat().filter(Boolean));
    this.output.scrollTop = 0;
  }

  showPending(title) {
    this.#write(el('div', { class: 'pending', text: `… ${title}` }));
  }

  showSuccess(title, body = '', elapsedMs) {
    const timing = elapsedMs === undefined ? '' : `  (${(elapsedMs / 1000).toFixed(2)}s)`;
    this.#write(el('div', { class: 'ok', text: `✔ ${title}${timing}` }), body ? el('div', { class: 'value', text: body }) : null);
  }

  showFields(title, fields, urlKeys = []) {
    this.#write(el('div', { class: 'ok', text: `✔ ${title}` }),
      fields.flatMap(([key, value]) => [
        el('div', { class: 'label', text: key }),
        el('div', { class: urlKeys.includes(key) ? 'url' : 'value', text: value }),
      ]));
  }

  showError({ title, message, detail }) {
    this.#write(el('div', { class: 'error', text: `✖ ${title}` }),
      el('div', { class: 'value', text: message }),
      detail ? el('div', { class: 'value', text: detail }) : null);
  }

  clear() {
    this.#write();
  }

  text() {
    return [...this.output.children].map((node) => node.textContent).join('\n\n');
  }

  async copy() {
    try {
      await navigator.clipboard.writeText(this.text());
      setStatus('Results copied');
    } catch {
      setStatus('Could not copy to the clipboard', false);
    }
  }
}

// -- app shell ---------------------------------------------------------------

const app = {
  meta: null,
  settings: null,
  panels: new Map(), // slug -> { tab, panel }
  licenseInputs: [],
};

function setStatus(text, ok = true) {
  const status = document.getElementById('status');
  status.textContent = text;
  status.classList.toggle('failed', !ok);
}

const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** Add a tab whose panel has an input column and a results column. */
function addPanel(title) {
  const id = slug(title);
  const column = el('div', { class: 'column' });
  const results = new ResultView();
  const panel = el('div', { class: 'panel', id: `panel-${id}`, role: 'tabpanel', 'aria-labelledby': `tab-${id}`, hidden: true },
    column, results.root);
  const tab = el('button', {
    type: 'button', class: 'tab', id: `tab-${id}`, role: 'tab', 'aria-controls': `panel-${id}`,
    'aria-selected': 'false', text: title, onclick: () => selectTab(id),
  });
  document.getElementById('tabs').append(tab);
  document.getElementById('panels').append(panel);
  app.panels.set(id, { tab, panel });
  return { column, results };
}

function selectTab(id) {
  for (const [key, { tab, panel }] of app.panels) {
    const selected = key === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
}

// Arrow keys move between tabs.
document.addEventListener('keydown', (event) => {
  if (!event.target.matches?.('.tab') || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const ids = [...app.panels.keys()];
  const current = ids.indexOf(event.target.id.slice(4));
  const next = ids[(current + (event.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
  selectTab(next);
  app.panels.get(next).tab.focus();
});

/** Disable `button` while `work` runs. */
async function busy(button, work) {
  button.disabled = true;
  try {
    return await work();
  } finally {
    button.disabled = false;
  }
}

// -- Settings tab ------------------------------------------------------------

function buildSettings() {
  const { column, results } = addPanel('Settings');
  const card = new Card('Retail ID API settings',
    `Saved to ${app.meta.settingsPath} — this file is git-ignored. API tabs use the saved values. `
    + 'Saved keys stay on the server: leave a key blank to keep it.');
  column.append(card.root);

  const inputs = {};
  for (const f of app.meta.settingsFields) {
    inputs[f.key] = card.addRow(f.label, textInput('', { type: f.secret ? 'password' : 'text', 'data-secret': f.secret }), f.hint);
    inputs[f.key].addEventListener('input', updateDirty);
    onEnter(inputs[f.key], save);
  }
  const showKeys = el('input', { type: 'checkbox', id: nextId() });
  showKeys.addEventListener('change', () => {
    for (const input of Object.values(inputs)) {
      if (input.dataset.secret !== undefined) input.type = showKeys.checked ? 'text' : 'password';
    }
  });
  card.addRow('', el('label', { class: 'check' }, showKeys, 'Show keys'));
  const dirty = el('span', { class: 'dirty' });
  card.addRow('', dirty);

  card.addButton('Save', () => save(), 'primary');
  card.addButton('Revert', revert);
  const testButton = card.addButton('Test connection', testConnection);
  const forgetButton = card.addButton('Forget saved keys', forgetKeys);

  function fill(summary) {
    app.settings = summary;
    const form = summary.form;
    for (const key of ['state_code', 'base_url']) inputs[key].value = form[key];
    for (const key of ['vendor_api_key', 'user_api_key']) {
      inputs[key].value = '';
      inputs[key].placeholder = form[`${key}_set`] ? `Saved: ${form[key]} — type to replace` : 'Not set';
    }
    forgetButton.disabled = !form.vendor_api_key_set && !form.user_api_key_set;
    updateDirty();
    results.showFields(summary.title, summary.fields);
  }

  function updateDirty() {
    const form = app.settings?.form ?? {};
    const changed = inputs.vendor_api_key.value.trim() || inputs.user_api_key.value.trim()
      || inputs.state_code.value.trim() !== (form.state_code ?? '')
      || inputs.base_url.value.trim() !== (form.base_url ?? '');
    dirty.textContent = changed ? 'Unsaved changes' : '';
  }

  async function save(clearKeys = []) {
    const body = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
    const summary = await request('/api/settings', { ...body, clear_keys: clearKeys });
    if (summary.ok === false) return results.showError(summary.error);
    fill(summary);
    setStatus(summary.status);
  }

  function revert() {
    fill({ ...app.settings, title: 'Reverted to saved settings' });
  }

  function forgetKeys() {
    if (confirm('Remove both saved API keys from the settings file?')) save(['vendor_api_key', 'user_api_key']);
  }

  async function testConnection() {
    results.showPending(`GET ${app.settings.target}/facilities/v2/`);
    const outcome = await busy(testButton, () => request('/api/test-connection', {}));
    if (!outcome.ok) {
      results.showError(outcome.error);
      setStatus('Connection test failed', false);
      return;
    }
    results.showSuccess(outcome.title, outcome.body);
    setStatus('Connection test succeeded');
  }

  fill(app.settings);
}

// -- Encode and Decode tabs ----------------------------------------------------

function buildEncode(sendToDecode) {
  const { column, results } = addPanel('Encode');
  const ex = app.meta.examples;
  const card = new Card('Encode a Retail ID URL',
    'Combine a 24-character hex batch ID (an ObjectId) and an item index into the short URL '
    + 'printed in a Retail ID QR code. Uses getShortUrl().');
  column.append(card.root);

  const batchId = onEnter(textInput(ex.batchId), encode);
  const randomButton = el('button', { type: 'button', class: 'btn', text: 'Random', onclick: randomBatchId });
  card.addRow('Batch ID', el('div', { class: 'row' }, batchId, randomButton), `24 hex characters, e.g. ${ex.batchId}`);
  const index = card.addRow('Index', onEnter(textInput(ex.index), encode), 'Whole number ≥ 0 (the item\'s position in the batch)');
  const domain = card.addRow('Domain', onEnter(textInput(ex.domain), encode), `Leave as ${ex.domain} unless you use a custom domain`);
  const name = nextId();
  const radio = (value, label, checked) => el('label', {}, el('input', { type: 'radio', name, value, checked }), label);
  const radios = el('div', { class: 'radios', role: 'radiogroup' },
    radio('base36', 'Base36 (uppercase, smaller QR)', true),
    radio('base64', 'Base64 (URL-safe, shorter text)', false));
  card.addRow('Encoding', radios);

  card.addButton('Encode', encode, 'primary');
  card.addButton('Load example', loadExample);
  const decodeButton = card.addButton('Decode this URL →', () => lastUrl && sendToDecode(lastUrl));
  decodeButton.disabled = true;
  let lastUrl = '';

  async function randomBatchId() {
    const data = await request('/api/random-batch-id', {});
    if (data.batchId) batchId.value = data.batchId;
  }

  function loadExample() {
    batchId.value = ex.batchId;
    index.value = ex.index;
    domain.value = ex.domain;
    radios.querySelector('[value="base36"]').checked = true;
    encode();
  }

  async function encode() {
    const outcome = await request('/api/encode', {
      batchId: batchId.value,
      index: index.value,
      domain: domain.value,
      encoding: radios.querySelector('input:checked').value,
    });
    lastUrl = outcome.ok ? outcome.url : '';
    decodeButton.disabled = !lastUrl;
    if (!outcome.ok) return results.showError(outcome.error);
    results.showFields(outcome.title, outcome.fields, outcome.urlKeys);
  }
}

function buildDecode() {
  const { column, results } = addPanel('Decode');
  const ex = app.meta.examples;
  const card = new Card('Decode a Retail ID URL',
    'Paste a scanned QR URL (or just its short code). RetailIdPair detects base36 or base64 '
    + 'and returns the batch ID and index.');
  column.append(card.root);

  const url = card.addRow('URL or code', onEnter(textInput(ex.url), decode), `e.g. ${ex.url}`);
  const strict = el('input', { type: 'checkbox' });
  card.addRow('Strict', el('label', { class: 'check' }, strict, 'Require a known prefix or a valid ObjectId timestamp'));
  card.addButton('Decode', decode, 'primary');
  card.addButton('Load example', () => {
    url.value = ex.url;
    strict.checked = false;
    decode();
  });

  async function decode() {
    const outcome = await request('/api/decode', { url: url.value, strict: strict.checked });
    if (!outcome.ok) return results.showError(outcome.error);
    results.showFields(outcome.title, outcome.fields, outcome.urlKeys);
  }

  return (value) => {
    url.value = value;
    decode();
  };
}

// -- API tabs ------------------------------------------------------------------

/** The facility license number is shared by every API tab. */
function licenseInput() {
  const input = textInput(app.settings.form.license_number);
  input.addEventListener('input', () => {
    for (const other of app.licenseInputs) if (other !== input) other.value = input.value;
  });
  app.licenseInputs.push(input);
  return input;
}

const licenseNumber = () => app.licenseInputs[0]?.value.trim() ?? '';

function buildApiTab({ title, actions }) {
  const { column, results } = addPanel(title);
  if (actions.some((a) => a.needsLicense)) {
    const card = new Card('Facility',
      'The license number is sent as ?licenseNumber= on each call. It is shared by every API tab '
      + 'and remembered between runs.');
    card.addRow('License number', licenseInput());
    card.buttons.remove();
    column.append(card.root);
  }
  for (const action of actions) column.append(buildActionCard(action, results));
}

function buildActionCard(action, results) {
  const card = new Card(action.title, action.hint);
  card.form.before(el('div', { class: 'endpoint', text: action.endpoint }));
  const inputs = {};
  for (const f of action.fields) {
    let control;
    if (f.kind === 'lines' || f.kind === 'json') {
      control = el('textarea', { rows: f.kind === 'json' ? 12 : 4, spellcheck: 'false', wrap: 'off' });
      control.value = f.default;
    } else if (f.kind === 'choice') {
      control = el('select', {}, f.choices.map((c) => el('option', { value: c, text: c, selected: c === f.default })));
    } else {
      control = onEnter(textInput(f.default), () => send());
    }
    inputs[f.key] = card.addRow(f.label, control, f.hint);
  }
  const sendButton = card.addButton(action.changesData ? 'Send (changes data)' : 'Send', () => send(),
    action.changesData ? 'danger' : 'primary');

  async function send() {
    if (sendButton.disabled) return;
    if (action.changesData && !confirm(
      `${action.title} changes data in Metrc (${app.settings.target}).\n\nSend it?`)) return;
    results.showPending(`${action.title}: ${action.endpoint}`);
    const started = performance.now();
    const body = {
      licenseNumber: licenseNumber(),
      values: Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])),
    };
    const outcome = await busy(sendButton, () => request(`/api/actions/${action.key}`, body));
    const elapsed = performance.now() - started;
    if (!outcome.ok) {
      results.showError(outcome.error);
      setStatus(`${action.title} failed`, false);
      return;
    }
    results.showSuccess(outcome.title, outcome.body, elapsed);
    setStatus(`${action.title} succeeded in ${(elapsed / 1000).toFixed(2)}s`);
  }
  return card.root;
}

// -- start -------------------------------------------------------------------

async function start() {
  const [meta, summary] = await Promise.all([request('/api/meta'), request('/api/settings')]);
  if (meta.ok === false || summary.ok === false) {
    setStatus(`Could not load the app: ${(meta.error ?? summary.error).message}`, false);
    return;
  }
  app.meta = meta;
  app.settings = summary;
  document.getElementById('sdk-version').textContent = `retailid ${meta.sdkVersion}  ·  JavaScript SDK showcase`;

  buildSettings();
  let decodeUrl;
  buildEncode((url) => {
    selectTab('decode');
    decodeUrl(url);
  });
  decodeUrl = buildDecode();
  meta.tabs.forEach(buildApiTab);

  // Start on Encode when settings are already saved, otherwise on Settings.
  const fromHash = location.hash.slice(1);
  selectTab(app.panels.has(fromHash) ? fromHash : summary.anySaved ? 'encode' : 'settings');
  setStatus('Ready');
}

start();
