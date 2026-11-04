/** Encode and Decode: offline features of the SDK (no API keys needed). */

import { ObjectId, RetailIdPair, VarInt, getShortUrl } from '@metrc/retailid';
import { shortCodeFromUrl } from '@metrc/retailid/api';

export const EXAMPLE_BATCH_ID = 'abcdef012345670000027190';
export const EXAMPLE_INDEX = 1;
export const EXAMPLE_URL = 'HTTPS://1A4.COM/10NOIEYKAJDG6CF0EXGJL';
export const DEFAULT_DOMAIN = '1a4.com';

// RetailIdPair prefers batch IDs with these prefixes; the SDK does not export the list.
export const RETAILID_PREFIXES = ['1a4', 'abc'];

// The SDK's varint encoder works on unsigned 32-bit integers.
const MAX_INDEX = 0xffffffff;

export function randomBatchId() {
  return new ObjectId().toHexString();
}

function guessEncoding(shortCode, pair, domain) {
  if (shortCodeFromUrl(pair.encode({ domain, base64: true })) === shortCode) return 'base64 (URL-safe)';
  if (shortCodeFromUrl(pair.encode({ domain })).toUpperCase() === shortCode.toUpperCase()) return 'base36';
  return 'unknown';
}

/** `getShortUrl`: batch ID + index -> Retail ID URL. Throws on bad input. */
export function encode({ batchId = '', index = '', domain = '', encoding = 'base36' } = {}) {
  const id = new ObjectId(String(batchId).trim());
  const indexText = String(index).trim();
  if (!/^\d+$/.test(indexText) || Number(indexText) > MAX_INDEX) {
    throw new RangeError(`Index must be a whole number from 0 to ${MAX_INDEX}, got '${indexText}'`);
  }
  const n = Number(indexText);
  const base64 = encoding === 'base64';
  const url = getShortUrl(id, n, { domain: String(domain).trim() || undefined, base64 });
  const varint = new VarInt(n);
  return {
    url,
    title: 'Encoded',
    urlKeys: ['URL'],
    fields: [
      ['URL', url],
      ['Short code', shortCodeFromUrl(url)],
      ['Encoding', base64 ? 'base64 (URL-safe)' : 'base36'],
      ['Batch ID', id.toHexString()],
      ['Index', `${n}  (varint bytes: ${varint.toHexString()})`],
      ['Payload', `${12 + varint.length()} bytes = 12-byte batch ID + ${varint.length()}-byte varint index`],
    ],
  };
}

/** `RetailIdPair`: Retail ID URL -> batch ID + index. Throws on bad input. */
export function decode({ url = '', strict = false } = {}) {
  const text = String(url).trim();
  if (!text) throw new RangeError('Enter a Retail ID URL or short code');
  const pair = new RetailIdPair(text, Boolean(strict));
  const shortCode = shortCodeFromUrl(text);

  let domain = DEFAULT_DOMAIN;
  if (text.includes('://')) domain = text.split('://')[1].split('/')[0].toLowerCase() || DEFAULT_DOMAIN;
  const hexId = pair.batchId.toHexString();
  const known = RETAILID_PREFIXES.some((prefix) => hexId.startsWith(prefix));
  return {
    title: 'Decoded',
    urlKeys: [],
    fields: [
      ['Batch ID', hexId],
      ['Index', String(pair.index)],
      ['Short code', shortCode],
      ['Detected encoding', guessEncoding(shortCode, pair, domain)],
      ['Known Retail ID prefix', known ? 'yes' : `no (known prefixes: ${RETAILID_PREFIXES.join(', ')})`],
      ['Re-encoded as base36', pair.encode({ domain })],
      ['Re-encoded as base64', pair.encode({ domain, base64: true })],
    ],
  };
}
