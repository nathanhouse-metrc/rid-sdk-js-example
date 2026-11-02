/**
 * Regenerate the README screenshots in docs/screenshots/.
 *
 * Starts the app with sample settings, runs one action per tab (API calls go to
 * the local fake Retail ID API from the tests, so no keys are needed and nothing
 * changes in Metrc) and captures the page at 1280×820 in headless Chrome or
 * Edge, driven over the DevTools protocol (no extra npm packages):
 *
 *     node tools/take-screenshots.mjs
 *
 * Set CHROME_PATH if Chrome/Edge is not in a standard location.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';
import * as settings from '../src/settings.js';
import { fakeApi } from '../test/fake-api.js';

const OUT = join(settings.REPO_ROOT, 'docs', 'screenshots');
const WIDTH = 1280;
const HEIGHT = 820;

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

// One step per screenshot: the tab, and what to do on it first (run in the page).
const STEPS = [
  ['settings', ''],
  ['encode', "click('Encode a Retail ID URL', 'Load example');"],
  ['decode', "click('Decode a Retail ID URL', 'Load example');"],
  ['access', "click('Check access: list facilities', 'Send');"],
  ['label-printing', "set('Package Retail ID info', 'Package labels', 'PKG-1'); click('Package Retail ID info', 'Send');"],
  ['receiving', "set('Receive by package label', 'Package label', 'PKG-1'); click('Receive by package label', 'Send');"],
  ['point-of-sale', "click('Report sales with Retail IDs', 'Send (changes data)');"],
  ['catalog', "set('Global product by ID', 'Product ID', '9'); click('Global product by ID', 'Send');"],
];

const stepScript = (tab, actions) => `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const panel = document.getElementById('panel-${tab}');
  document.getElementById('tab-${tab}').click();
  const card = (title) => [...panel.querySelectorAll('.card')].find((c) => c.querySelector('h2').textContent === title);
  const click = (title, text) => {
    card(title).scrollIntoView({ block: 'nearest' });
    [...card(title).querySelectorAll('.btn')].find((b) => b.textContent === text).click();
  };
  const set = (title, label, value) => {
    const row = [...card(title).querySelectorAll('.form > label')].find((l) => l.textContent === label);
    row.nextElementSibling.querySelector('input, textarea, select').value = value;
  };
  window.confirm = () => true;
  ${actions}
  await wait(100);
  for (let i = 0; i < 100 && panel.querySelector('.output .pending'); i++) await wait(100);
  const status = document.getElementById('status');
  status.textContent = 'Ready';
  status.classList.remove('failed');
  document.activeElement?.blur();
  await wait(200);
})()`;

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => {
  server.close(resolve);
  server.closeAllConnections(); // keep-alive sockets would hold close() open
});

function findBrowser() {
  const path = BROWSERS.find((candidate) => candidate && existsSync(candidate));
  if (!path) throw new Error('Chrome or Edge not found; set CHROME_PATH to its executable.');
  return path;
}

/** Start a headless browser; resolve with the process and its DevTools HTTP port. */
function launchBrowser(profileDir) {
  const browser = spawn(findBrowser(), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    `--window-size=${WIDTH},${HEIGHT}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '';
    browser.stderr.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (match) resolve({ browser, port: Number(match[1]) });
    });
    browser.on('exit', (code) => reject(new Error(`Browser exited (${code}) before DevTools started:\n${output}`)));
  });
}

/** A minimal DevTools protocol session on one page. */
async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  return { send, evaluate, close: () => socket.close() };
}

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'rid-screenshots-'));
  process.env[settings.SETTINGS_ENV_VAR] = join(tmp, 'settings.json');
  const sample = {
    vendor_api_key: 'sample-vendor-key-0001',
    user_api_key: 'sample-user-key-0002',
    state_code: 'md',
    base_url: '',
    license_number: 'LIC-1',
  };
  await settings.saveSettings(sample);

  await listen(fakeApi);
  const app = createApp();
  await listen(app);
  const { browser, port } = await launchBrowser(join(tmp, 'profile'));
  const page = await connect(port);

  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.navigate', { url: `http://127.0.0.1:${app.address().port}/` });
    await page.evaluate(`(async () => {
      for (let i = 0; i < 100 && document.getElementById('status')?.textContent !== 'Ready'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Show the default location rather than this run's temporary file.
      const hint = document.querySelector('#panel-settings .card > .hint');
      hint.textContent = hint.textContent.replace(${JSON.stringify(process.env[settings.SETTINGS_ENV_VAR])}, 'settings.json');
    })()`);

    await mkdir(OUT, { recursive: true });
    for (const [index, [tab, actions]] of STEPS.entries()) {
      if (index === 1) {
        // After the Settings screenshot: point API calls at the fake server.
        await settings.saveSettings({ ...sample, base_url: `http://127.0.0.1:${fakeApi.address().port}` });
      }
      await page.evaluate(stepScript(tab, actions));
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      const file = join(OUT, `${tab}.png`);
      await writeFile(file, Buffer.from(data, 'base64'));
      console.log(`wrote ${file}`);
    }
  } finally {
    page.close();
    const exited = new Promise((resolve) => browser.once('exit', resolve));
    browser.kill();
    await exited;
    await close(app);
    await close(fakeApi);
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

await main();
