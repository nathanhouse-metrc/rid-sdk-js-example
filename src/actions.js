/**
 * The Retail ID API tabs: one card per `RetailIdClient` method.
 *
 * Each card is described by an action (its inputs and the client call), so the
 * tabs below are mostly data. The browser renders the cards from `publicTabs()`
 * and sends the raw input text back; parsing and the SDK call happen here.
 */

import {
  RetailIdApiError,
  RetailIdConfigError,
  RetailIdNetworkError,
  RetailIdResponseError,
  RetailIdTimeoutError,
  SALES_ENDPOINTS,
} from '@metrc/retailid/api';

/** Bad input typed into the UI. */
export class InputError extends Error {
  name = 'InputError';
}

/** kind: text | int | optional_int | lines | json | choice */
const field = (key, label, { kind = 'text', value = '', hint = '', choices = [] } = {}) => ({
  key, label, kind, default: value, hint, choices,
});

const action = (key, title, endpoint, hint, call, fields = [], { needsLicense = true, changesData = false } = {}) => ({
  key, title, endpoint, hint, call, fields, needsLicense, changesData,
});

// -- input parsing ---------------------------------------------------------

export function parse(f, rawValue) {
  const raw = String(rawValue ?? '').trim();
  switch (f.kind) {
    case 'int':
      if (!/^-?\d+$/.test(raw)) throw new InputError(`${f.label} must be a whole number`);
      return Number(raw);
    case 'optional_int':
      if (!raw) return undefined;
      if (!/^\d+$/.test(raw)) throw new InputError(`${f.label} must be a whole number or blank`);
      return Number(raw);
    case 'lines': {
      const items = raw.replaceAll(',', '\n').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (items.length === 0) throw new InputError(`${f.label}: enter at least one value`);
      return items;
    }
    case 'json':
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw new InputError(`${f.label} is not valid JSON: ${error.message}`);
      }
    case 'choice':
      if (!f.choices.includes(raw)) throw new InputError(`${f.label} must be one of: ${f.choices.join(', ')}`);
      return raw;
    default:
      if (!raw) throw new InputError(`${f.label} is required`);
      return raw;
  }
}

const salesRecords = (value) => (Array.isArray(value) ? value : [value]);

export const SAMPLE_RECEIPT = JSON.stringify([{
  SalesDateTime: '2026-01-01T12:00:00Z',
  SalesCustomerType: 'Consumer',
  Transactions: [{
    PackageLabel: '1A4060300007777000000001',
    Quantity: 1,
    UnitOfMeasure: 'Each',
    TotalAmount: 10.0,
    QrCodes: ['HTTPS://1A4.COM/10NOIEYKAJDG6CF0EXGJL'],
  }],
}], null, 2);

// -- the actions -----------------------------------------------------------

const PACKAGE = field('package_label', 'Package label', { hint: 'e.g. 1A4060300007777000000001' });

const ACCESS = [
  action('facilities', 'Check access: list facilities', 'GET /facilities/v2/',
    'Confirms the saved keys work and lists the facilities this user can see. '
    + 'Use one of the license numbers above.',
    (c) => c.getFacilities(), [], { needsLicense: false }),
];

const LABEL_PRINTING = [
  action('allotment', 'Allotment', 'GET /retailid/v2/allotment',
    'Remaining Retail Item IDs for the facility (New York only).',
    (c, lic) => c.getAllotment(lic)),
  action('available_tags', 'Available tags', 'GET /tags/v2/package/available',
    'Unused package tags, for staging labels.',
    (c, lic) => c.getAvailableTags(lic)),
  action('package', 'Get package', 'GET /packages/v2/{id or label}',
    'Package details, including ProductLabel.',
    (c, lic, v) => c.getPackage(lic, v.id_or_label),
    [field('id_or_label', 'ID or label', { hint: 'Numeric package ID or package label' })]),
  action('packages_info', 'Package Retail ID info', 'POST /retailid/v2/packages/info',
    'QR count, issuances and verification status. Read-only; sent in batches of 10.',
    (c, lic, v) => c.getPackagesInfo(lic, v.labels),
    [field('labels', 'Package labels', { kind: 'lines', hint: 'One per line (or comma-separated)' })]),
  action('generate', 'Generate Retail IDs', 'POST /retailid/v2/generate',
    'Creates Retail IDs for a package. Changes data and is not retried; if it times out, '
    + 'check Package Retail ID info before trying again.',
    (c, lic, v) => c.generate(lic, v.package_label, v.quantity),
    [PACKAGE, field('quantity', 'Quantity', { kind: 'int', value: '1' })], { changesData: true }),
];

const RECEIVING = [
  action('receive', 'Receive by package label', 'GET /retailid/v2/receive/{label}',
    'QR URLs (eaches) and receiving status for a package.',
    (c, lic, v) => c.receive(lic, v.package_label), [PACKAGE]),
  action('receive_qr', 'Receive by scanned QR', 'GET /retailid/v2/receive/qr/{shortCode}',
    'Start from one scanned unit: paste its QR URL or short code.',
    (c, lic, v) => c.receiveByQr(lic, v.qr),
    [field('qr', 'QR URL or code', { value: 'HTTPS://1A4.COM/10NOIEYKAJDG6CF0EXGJL' })]),
  action('associate', 'Scan and associate', 'POST /retailid/v2/associate',
    'Link scanned units to the package they are physically in. Use full QR URLs, '
    + 'not short codes. Changes data.',
    (c, lic, v) => c.associatePackage(lic, v.package_label, v.qr_urls),
    [PACKAGE, field('qr_urls', 'QR URLs', { kind: 'lines', hint: 'One full URL per line' })],
    { changesData: true }),
  action('merge', 'Merge packages', 'POST /retailid/v2/merge',
    'The target keeps and receives all Retail ID links; the source gives its links up. '
    + 'Changes data.',
    (c, lic, v) => c.merge(lic, v.target, v.source),
    [field('target', 'Target label'), field('source', 'Source label')], { changesData: true }),
];

const POINT_OF_SALE = [
  action('sales', 'Report sales with Retail IDs', 'POST /sales/v2/…',
    "Sales objects from the market's Sales docs; Retail IDs go in "
    + 'Transactions[].QrCodes next to PackageLabel. At most 10 records. Changes data.',
    (c, lic, v) => c.postSales(lic, salesRecords(v.records), { endpoint: v.endpoint }),
    [field('endpoint', 'Endpoint', { kind: 'choice', value: 'receipts', choices: Object.keys(SALES_ENDPOINTS) }),
      field('records', 'Records (JSON)', { kind: 'json', value: SAMPLE_RECEIPT })],
    { changesData: true }),
];

const CATALOG = [
  action('global_products', 'Global products for a brand', 'GET /globalproducts/v2?brandId=',
    'Every Global Product for the brand, across all pages.',
    (c, lic, v) => c.getGlobalProducts(v.brand_id, { pageSize: v.page_size }),
    [field('brand_id', 'Brand ID'), field('page_size', 'Page size', { kind: 'optional_int', hint: 'Optional' })],
    { needsLicense: false }),
  action('global_product', 'Global product by ID', 'GET /globalproducts/v2/{id}',
    'One Global Product.',
    (c, lic, v) => c.getGlobalProduct(v.product_id),
    [field('product_id', 'Product ID')], { needsLicense: false }),
];

export const TABS = [
  ['Access', ACCESS],
  ['Label printing', LABEL_PRINTING],
  ['Receiving', RECEIVING],
  ['Point of sale', POINT_OF_SALE],
  ['Catalog', CATALOG],
];

export const ACTIONS = new Map(TABS.flatMap(([, actions]) => actions.map((a) => [a.key, a])));

/** The tab and card descriptions the browser renders (everything but the calls). */
export function publicTabs() {
  return TABS.map(([title, actions]) => ({
    title,
    actions: actions.map(({ call, ...rest }) => rest),
  }));
}

/** Parse the raw input text for `action`; throws InputError on bad input. */
export function parseInputs(act, raw = {}) {
  return Object.fromEntries(act.fields.map((f) => [f.key, parse(f, raw[f.key] ?? f.default)]));
}

// -- results and errors ----------------------------------------------------

export function formatResult(value) {
  if (value === null || value === undefined || value === '') return '(empty response)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/** Return { title, message, detail } for an error thrown by an API call. */
export function describeError(e) {
  if (e instanceof RetailIdConfigError) {
    return {
      title: 'Settings incomplete',
      message: e.message,
      detail: 'Open the Settings tab, fill in the keys and a state code or base URL, and Save.',
    };
  }
  if (e instanceof RetailIdApiError) {
    return {
      title: `${e.method} ${e.path} → HTTP ${e.statusCode} (${e.name})`,
      message: e.apiMessage ?? '',
      detail: e.body === null || e.body === '' ? '' : formatResult(e.body),
    };
  }
  if (e instanceof RetailIdTimeoutError) {
    return {
      title: 'Request timed out',
      message: e.message,
      detail: 'Calls that change data are not retried; check the result before sending again.',
    };
  }
  if (e instanceof RetailIdNetworkError) {
    return { title: 'Could not connect', message: e.message, detail: 'Check the state code or base URL in Settings.' };
  }
  if (e instanceof RetailIdResponseError) {
    return {
      title: 'Unexpected response',
      message: e.message,
      detail: 'If this call changes data, the change was applied; do not send it again.'
        + (e.body === undefined || e.body === null ? '' : `\n\n${formatResult(e.body)}`),
    };
  }
  if (e instanceof InputError || e instanceof TypeError || e instanceof RangeError) {
    return { title: 'Invalid input', message: e.message, detail: '' };
  }
  return { title: e?.name ?? 'Error', message: String(e?.message ?? e), detail: '' };
}
