/**
 * A small local HTTP server that stands in for the Retail ID API, used by the
 * tests and by tools/take-screenshots.mjs. It records every call in `calls`.
 */

import { createServer } from 'node:http';

export const RESPONSES = {
  'GET /facilities/v2/': { Data: [{ Name: 'Test Dispensary', License: { Number: 'LIC-1' } }] },
  'GET /retailid/v2/allotment': { FacilityId: 1, FacilityLicenseNumber: 'LIC-1', Allotment: 500 },
  'GET /tags/v2/package/available': { Data: [{ Label: '1A4000000000000000000001' }] },
  'GET /packages/v2/PKG-1': { Id: 7, Label: 'PKG-1', ProductLabel: 'Gummies' },
  'POST /retailid/v2/packages/info': [{ PackageLabel: 'PKG-1', QrCount: 3, HasQrs: true, Issuances: [] }],
  'POST /retailid/v2/generate': { IssuanceId: 'iss-42' },
  'GET /retailid/v2/receive/PKG-1': {
    Eaches: ['HTTPS://1A4.COM/10NOIEYKAJDG6CF0EXGJL'], SiblingTags: [], RequiresVerification: false,
  },
  'GET /retailid/v2/receive/qr/10NOIEYKAJDG6CF0EXGJL': { Eaches: ['X'], SiblingTags: ['PKG-2'] },
  'POST /retailid/v2/associate': { Ids: [1] },
  'POST /retailid/v2/merge': { Ids: [2], Warnings: null },
  'POST /sales/v2/receipts': null,
  'GET /globalproducts/v2': { Data: [{ Id: 9 }], TotalPages: 1 },
  'GET /globalproducts/v2/9': { Id: 9, Name: 'Widget' },
};

export const calls = [];

export const fakeApi = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fake');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  const auth = Buffer.from(req.headers.authorization.split(' ')[1], 'base64').toString();
  calls.push({ method: req.method, path: url.pathname, query: url.searchParams, body: text ? JSON.parse(text) : null, auth });
  const key = `${req.method} ${url.pathname}`;
  const reply = (status, payload) => {
    const data = payload === null ? '' : JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };
  if (url.pathname === '/retailid/v2/receive/MISSING') reply(404, { Message: 'Package not found' });
  else if (key in RESPONSES) reply(200, RESPONSES[key]);
  else reply(404, { Message: `no fake for ${key}` });
});
