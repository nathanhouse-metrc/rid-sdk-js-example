/**
 * Retail ID SDK Explorer: a local web app for trying the @metrc/retailid SDK.
 *
 * The SDK's API client is server-side only (it carries API keys and refuses to
 * run in a browser), so this small Node server runs every SDK call and the
 * browser page in `public/` is only the UI. The server listens on 127.0.0.1
 * and never sends the saved API keys to the page.
 *
 *   npm start                 start and open the app in the default browser
 *   npm start -- --no-open    start without opening a browser
 *   PORT=9000 npm start       use another port (default 8640)
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RetailIdClient } from '@metrc/retailid/api';
import { loadConfig } from '@metrc/retailid/node';

import { ACTIONS, describeError, formatResult, parseInputs, publicTabs } from './actions.js';
import * as codec from './codec.js';
import * as settings from './settings.js';

const PUBLIC_DIR = join(settings.REPO_ROOT, 'public');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
const MAX_BODY_BYTES = 1024 * 1024;

const SETTINGS_LABELS = {
  vendor_api_key: ['Vendor API key', "Your software's key (Basic auth username)"],
  user_api_key: ['User API key', "The Metrc user's key (Basic auth password)"],
  state_code: ['State code', 'Two-letter market, e.g. md → https://api-md.metrc.com'],
  base_url: ['Base URL', 'Optional; overrides the state code (use for the Sandbox)'],
};

async function sdkVersion() {
  const entry = fileURLToPath(import.meta.resolve('@metrc/retailid'));
  const pkg = JSON.parse(await readFile(join(entry, '..', '..', 'package.json'), 'utf8'));
  return pkg.version;
}

/** The SDK config built from the saved settings file (throws RetailIdConfigError). */
const savedConfig = () => loadConfig(settings.settingsPath());

const clientFor = (config) => RetailIdClient.fromConfig(config);

// -- handlers ----------------------------------------------------------------

async function meta() {
  return {
    sdkVersion: await sdkVersion(),
    settingsPath: settings.displayPath(),
    settingsFields: settings.FIELDS.map((key) => ({
      key,
      label: SETTINGS_LABELS[key][0],
      hint: SETTINGS_LABELS[key][1],
      secret: settings.KEY_FIELDS.includes(key),
    })),
    examples: {
      batchId: codec.EXAMPLE_BATCH_ID,
      index: String(codec.EXAMPLE_INDEX),
      url: codec.EXAMPLE_URL,
      domain: codec.DEFAULT_DOMAIN,
    },
    tabs: publicTabs(),
  };
}

/** What the Settings tab shows. Keys are only ever sent masked. */
async function settingsSummary(title) {
  const saved = await settings.loadSettings();
  let target;
  let status;
  try {
    target = clientFor(await savedConfig()).baseUrl;
    status = 'Ready: API tabs will use these settings.';
  } catch (error) {
    target = '(incomplete)';
    status = `Incomplete: ${error.message}`;
  }
  const anySaved = settings.FIELDS.some((key) => saved[key]);
  return {
    title: title ?? (anySaved ? 'Loaded settings' : 'No settings saved yet'),
    anySaved,
    target,
    form: {
      state_code: saved.state_code,
      base_url: saved.base_url,
      license_number: saved[settings.LICENSE_FIELD],
      vendor_api_key: settings.mask(saved.vendor_api_key),
      user_api_key: settings.mask(saved.user_api_key),
      vendor_api_key_set: Boolean(saved.vendor_api_key),
      user_api_key_set: Boolean(saved.user_api_key),
    },
    fields: [
      ['Vendor API key', settings.mask(saved.vendor_api_key)],
      ['User API key', settings.mask(saved.user_api_key)],
      ['State code', saved.state_code || '(not set)'],
      ['Base URL', saved.base_url || '(not set)'],
      ['Requests go to', target],
      ['Status', status],
    ],
  };
}

/**
 * Save the Settings form. A blank key field keeps the saved key (keys are never
 * sent back to the page); `clear_keys` lists keys to remove.
 */
async function saveSettingsForm(body) {
  const saved = await settings.loadSettings();
  const values = { ...saved };
  for (const key of settings.FIELDS) {
    const value = typeof body[key] === 'string' ? body[key].trim() : '';
    if (settings.KEY_FIELDS.includes(key) && !value) continue;
    values[key] = value;
  }
  for (const key of Array.isArray(body.clear_keys) ? body.clear_keys : []) {
    if (settings.KEY_FIELDS.includes(key)) values[key] = '';
  }
  values.state_code = values.state_code.toLowerCase();
  const path = await settings.saveSettings(values);
  return { ...(await settingsSummary('Settings saved')), status: `Settings saved to ${path}` };
}

async function testConnection() {
  const facilities = await clientFor(await savedConfig()).getFacilities();
  const names = facilities.map((f) => (f && typeof f === 'object' && !Array.isArray(f)
    ? `${f.License?.Number ?? '?'}  ${f.Name ?? ''}`
    : String(f)));
  return { title: `Connected — ${facilities.length} facility(ies) visible`, body: names.join('\n') };
}

async function rememberLicense(licenseNumber) {
  const saved = await settings.loadSettings();
  if (licenseNumber !== saved[settings.LICENSE_FIELD]) {
    await settings.saveSettings({ ...saved, [settings.LICENSE_FIELD]: licenseNumber });
  }
}

async function runAction(key, body) {
  const act = ACTIONS.get(key);
  if (!act) return null;
  const values = parseInputs(act, body.values ?? {});
  const licenseNumber = String(body.licenseNumber ?? '').trim();
  if (act.needsLicense && !licenseNumber) throw new RangeError('Enter a facility license number first');
  const config = await savedConfig();
  await rememberLicense(licenseNumber);
  const result = await act.call(clientFor(config), licenseNumber, values);
  const count = Array.isArray(result) ? ` — ${result.length} record(s)` : '';
  return { title: `${act.title}${count}`, body: formatResult(result) };
}

/** Run `work`; report success as { ok: true, ... } and failures as { ok: false, error }. */
async function outcome(work) {
  try {
    return { ok: true, ...(await work()) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

function codecOutcome(work, failTitle) {
  try {
    return { ok: true, ...work() };
  } catch (error) {
    return { ok: false, error: { title: failTitle, message: error.message, detail: '' } };
  }
}

// -- HTTP --------------------------------------------------------------------

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(data);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // fall through
  }
  throw Object.assign(new Error('Request body must be a JSON object'), { status: 400 });
}

/**
 * Only answer requests addressed to this local server, and only accept JSON
 * POSTs from its own page, so other websites cannot drive it (DNS rebinding,
 * cross-site form posts).
 */
function allowed(req, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(String(req.headers.host).toLowerCase())) return false;
  if (req.method !== 'POST') return true;
  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.some((host) => origin.toLowerCase() === `http://${host}`)) return false;
  return String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
}

const POST_ROUTES = {
  '/api/settings': (body) => saveSettingsForm(body),
  '/api/test-connection': () => outcome(testConnection),
  '/api/encode': (body) => codecOutcome(() => codec.encode(body), 'Could not encode'),
  '/api/decode': (body) => codecOutcome(() => codec.decode(body), 'Could not decode'),
  '/api/random-batch-id': () => ({ batchId: codec.randomBatchId() }),
};

const GET_ROUTES = {
  '/api/meta': () => meta(),
  '/api/settings': () => settingsSummary(),
};

async function handle(req, res, port) {
  if (!allowed(req, port)) return send(res, 403, { error: 'Forbidden' });
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET') {
    if (STATIC_FILES[pathname]) {
      const [file, type] = STATIC_FILES[pathname];
      return send(res, 200, await readFile(join(PUBLIC_DIR, file)), type);
    }
    if (GET_ROUTES[pathname]) return send(res, 200, await GET_ROUTES[pathname]());
    return send(res, 404, { error: 'Not found' });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  const body = await readJsonBody(req);
  if (POST_ROUTES[pathname]) return send(res, 200, await POST_ROUTES[pathname](body));
  const match = pathname.match(/^\/api\/actions\/([a-z_]+)$/);
  if (match && ACTIONS.has(match[1])) return send(res, 200, await outcome(() => runAction(match[1], body)));
  return send(res, 404, { error: 'Not found' });
}

/** Create the app server (not yet listening). */
export function createApp() {
  const server = createServer((req, res) => {
    handle(req, res, server.address().port).catch((error) => {
      if (!res.headersSent) send(res, error.status ?? 500, { error: error.message });
      else res.destroy();
    });
  });
  return server;
}

function openBrowser(url) {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

export function main(argv = process.argv.slice(2)) {
  const port = Number(process.env.PORT || 8640);
  const server = createApp();
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is in use. Start with another port, e.g. PORT=8641 npm start`
      : error.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(`Retail ID SDK Explorer running at ${url}`);
    console.log(`Settings file: ${settings.settingsPath()}`);
    console.log('Press Ctrl+C to stop.');
    if (!argv.includes('--no-open')) openBrowser(url);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
