/**
 * Drive every panel's server endpoint against the real SDK.
 *
 * API calls go to a small local HTTP server that stands in for the Retail ID
 * API, so the tests need no keys and change nothing in Metrc. Run with:
 *
 *     npm test
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import { RetailIdPair } from '@metrc/retailid';

import { createApp } from '../src/server.js';
import { calls, fakeApi } from './fake-api.js';

const VENDOR = 'vendor-key-123';
const USER = 'user-key-456';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

let fakeUrl;
let app;
let appUrl;
let tmp;
let settingsFile;

async function get(path) {
  const response = await fetch(appUrl + path);
  return response.json();
}

async function post(path, body = {}) {
  const response = await fetch(appUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

const configure = () => post('/api/settings', {
  vendor_api_key: VENDOR, user_api_key: USER, state_code: 'MD', base_url: fakeUrl,
});

before(async () => {
  await listen(fakeApi);
  fakeUrl = `http://127.0.0.1:${fakeApi.address().port}`;
  app = createApp();
  await listen(app);
  appUrl = `http://127.0.0.1:${app.address().port}`;
});

after(async () => {
  await close(app);
  await close(fakeApi);
});

beforeEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = await mkdtemp(join(tmpdir(), 'rid-example-'));
  settingsFile = join(tmp, 'settings.json');
  process.env.RID_EXAMPLE_SETTINGS = settingsFile;
  calls.length = 0;
});

after(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

// -- the page ----------------------------------------------------------------

describe('page', () => {
  test('serves the UI and metadata', async () => {
    const html = await (await fetch(appUrl + '/')).text();
    assert.match(html, /Retail ID SDK Explorer/);
    const meta = await get('/api/meta');
    assert.match(meta.sdkVersion, /^\d+\.\d+\.\d+/);
    assert.deepEqual(meta.tabs.map((t) => t.title), ['Access', 'Label printing', 'Receiving', 'Point of sale', 'Catalog']);
    assert.ok(meta.tabs.every((t) => t.actions.every((a) => !('call' in a))));
  });

  test('rejects requests from other sites', async () => {
    // fetch() does not let callers set Host, so use node:http for the DNS-rebinding case.
    const wrongHost = await new Promise((resolve, reject) => {
      httpGet(appUrl + '/api/settings', { headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(wrongHost, 403);
    const crossOrigin = await fetch(appUrl + '/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: '{}',
    });
    assert.equal(crossOrigin.status, 403);
    const formPost = await fetch(appUrl + '/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}',
    });
    assert.equal(formPost.status, 403);
  });
});

// -- settings ----------------------------------------------------------------

describe('settings', () => {
  test('persist between runs, with keys never sent to the page', async () => {
    const summary = await configure();
    const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
    assert.equal(saved.vendor_api_key, VENDOR);
    assert.equal(saved.state_code, 'md');
    assert.equal(saved.base_url, fakeUrl);
    assert.equal(summary.title, 'Settings saved');
    assert.equal(summary.target, fakeUrl);

    const reloaded = await get('/api/settings');
    assert.equal(reloaded.form.state_code, 'md');
    assert.equal(reloaded.form.user_api_key_set, true);
    const text = JSON.stringify(reloaded);
    assert.ok(!text.includes(VENDOR) && !text.includes(USER), 'keys must be masked');
    assert.ok(text.includes('••••••••-123'));
  });

  test('a blank key keeps the saved key; forget clears both', async () => {
    await configure();
    await post('/api/settings', { vendor_api_key: '', user_api_key: '', state_code: 'ny', base_url: fakeUrl });
    let saved = JSON.parse(await readFile(settingsFile, 'utf8'));
    assert.equal(saved.vendor_api_key, VENDOR);
    assert.equal(saved.state_code, 'ny');
    await post('/api/settings', { state_code: 'ny', clear_keys: ['vendor_api_key', 'user_api_key'] });
    saved = JSON.parse(await readFile(settingsFile, 'utf8'));
    assert.equal(saved.vendor_api_key, null);
    assert.equal(saved.user_api_key, null);
  });

  test('test connection', async () => {
    await configure();
    const outcome = await post('/api/test-connection');
    assert.equal(outcome.ok, true);
    assert.match(outcome.title, /Connected — 1 facility/);
    assert.match(outcome.body, /LIC-1 {2}Test Dispensary/);
    assert.equal(calls.at(-1).auth, `${VENDOR}:${USER}`);
  });

  test('API calls without settings report incomplete settings', async () => {
    const outcome = await post('/api/actions/facilities');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.title, 'Settings incomplete');
    assert.equal(calls.length, 0);
  });
});

// -- encode / decode ---------------------------------------------------------

describe('encode and decode', () => {
  test('encode a known vector', async () => {
    let outcome = await post('/api/encode', {
      batchId: 'abcdef012345670000027190', index: '1', domain: '1a4.com', encoding: 'base36',
    });
    assert.equal(outcome.url, 'HTTPS://1A4.COM/10NOIEYKAJDG6CF0EXGJL');
    outcome = await post('/api/encode', {
      batchId: 'abcdef012345670000027190', index: '1', domain: 'example.com', encoding: 'base64',
    });
    assert.ok(outcome.url.startsWith('https://example.com/'));
    const pair = new RetailIdPair(outcome.url);
    assert.deepEqual([pair.batchId.toHexString(), pair.index], ['abcdef012345670000027190', 1]);
  });

  test('encode rejects bad input', async () => {
    let outcome = await post('/api/encode', { batchId: 'xyz', index: '1' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.title, 'Could not encode');
    outcome = await post('/api/encode', { batchId: 'abcdef012345670000027190', index: '-1' });
    assert.match(outcome.error.message, /whole number/);
  });

  test('random batch IDs are valid ObjectIds', async () => {
    const { batchId } = await post('/api/random-batch-id');
    assert.match(batchId, /^[0-9a-f]{24}$/);
  });

  test('encode then decode round trip', async () => {
    const encoded = await post('/api/encode', { batchId: 'abcdef012345670000027190', index: '300', encoding: 'base64' });
    const decoded = await post('/api/decode', { url: encoded.url });
    const fields = Object.fromEntries(decoded.fields);
    assert.equal(fields['Batch ID'], 'abcdef012345670000027190');
    assert.equal(fields.Index, '300');
    assert.match(fields['Detected encoding'], /base64/);
  });

  test('decode a known vector', async () => {
    const outcome = await post('/api/decode', { url: 'HTTPS://1A4.COM/10NOIEYKAJDG6CF0EXGJL' });
    const fields = Object.fromEntries(outcome.fields);
    assert.equal(fields['Batch ID'], 'abcdef012345670000027190');
    assert.equal(fields.Index, '1');
    assert.equal(fields['Detected encoding'], 'base36');
    assert.equal(fields['Known Retail ID prefix'], 'yes');
  });

  test('decode rejects bad input', async () => {
    const outcome = await post('/api/decode', { url: 'https://1a4.com/!!' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.title, 'Could not decode');
  });
});

// -- API tabs ----------------------------------------------------------------

async function runAction(key, values = {}, licenseNumber = 'LIC-1') {
  const outcome = await post(`/api/actions/${key}`, { licenseNumber, values });
  assert.equal(outcome.ok, true, `${key} failed: ${JSON.stringify(outcome.error)}`);
  return [outcome, calls.at(-1)];
}

describe('API tabs', () => {
  test('every API action', async () => {
    await configure();

    let [out, call] = await runAction('facilities');
    assert.match(out.body, /Test Dispensary/);
    assert.equal(call.query.get('licenseNumber'), null);

    [out, call] = await runAction('allotment');
    assert.match(out.body, /"allotment": 500/);
    assert.equal(call.query.get('licenseNumber'), 'LIC-1');

    [out] = await runAction('available_tags');
    assert.match(out.body, /1A4000000000000000000001/);

    [out] = await runAction('package', { id_or_label: 'PKG-1' });
    assert.match(out.body, /Gummies/);

    [out, call] = await runAction('packages_info', { labels: 'PKG-1\nPKG-2' });
    assert.deepEqual(call.body, { packageLabels: ['PKG-1', 'PKG-2'] });
    assert.match(out.body, /"qrCount": 3/);

    [out, call] = await runAction('generate', { package_label: 'PKG-1', quantity: '3' });
    assert.deepEqual(call.body, { PackageLabel: 'PKG-1', Quantity: 3 });
    assert.match(out.body, /iss-42/);

    [out] = await runAction('receive', { package_label: 'PKG-1' });
    assert.match(out.body, /10NOIEYKAJDG6CF0EXGJL/);

    [, call] = await runAction('receive_qr');
    assert.equal(call.path, '/retailid/v2/receive/qr/10NOIEYKAJDG6CF0EXGJL');

    [, call] = await runAction('associate', { package_label: 'PKG-1', qr_urls: 'https://1a4.com/a\nhttps://1a4.com/b' });
    assert.deepEqual(call.body, [{ PackageLabel: 'PKG-1', QrUrls: ['https://1a4.com/a', 'https://1a4.com/b'] }]);

    [, call] = await runAction('merge', { target: 'PKG-1', source: 'PKG-2' });
    assert.deepEqual(call.body, { packageLabels: ['PKG-1', 'PKG-2'] });

    [out, call] = await runAction('sales');
    assert.equal(call.path, '/sales/v2/receipts');
    assert.deepEqual(call.body[0].Transactions[0].QrCodes, ['HTTPS://1A4.COM/10NOIEYKAJDG6CF0EXGJL']);
    assert.equal(out.body, '(empty response)');

    [out, call] = await runAction('global_products', { brand_id: '5', page_size: '20' });
    assert.equal(call.query.get('brandId'), '5');
    assert.equal(call.query.get('pageSize'), '20');
    assert.match(out.title, /1 record/);

    [out] = await runAction('global_product', { product_id: '9' });
    assert.match(out.body, /Widget/);

    // The license number is remembered between runs.
    assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).license_number, 'LIC-1');
  });

  test('API errors are shown', async () => {
    await configure();
    const outcome = await post('/api/actions/receive', { licenseNumber: 'LIC-1', values: { package_label: 'MISSING' } });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error.title, /HTTP 404 \(NotFoundError\)/);
    assert.match(outcome.error.message, /Package not found/);
  });

  test('a license number is required', async () => {
    await configure();
    const outcome = await post('/api/actions/allotment', { licenseNumber: '' });
    assert.match(outcome.error.message, /license number/);
    assert.equal(calls.length, 0);
  });

  test('invalid JSON input is reported', async () => {
    await configure();
    const outcome = await post('/api/actions/sales', { licenseNumber: 'LIC-1', values: { records: '{not json' } });
    assert.match(outcome.error.message, /not valid JSON/);
  });

  test('connection failures are explained', async () => {
    await post('/api/settings', { vendor_api_key: VENDOR, user_api_key: USER, base_url: 'http://127.0.0.1:1' });
    const outcome = await post('/api/actions/facilities');
    assert.equal(outcome.error.title, 'Could not connect');
  });
});
