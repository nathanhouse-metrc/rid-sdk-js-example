/**
 * Persist the Retail ID API settings between runs.
 *
 * Settings are stored as JSON in `settings.json` at the repository root (or the
 * path in `$RID_EXAMPLE_SETTINGS`). The file uses the same keys as the SDK's
 * `config.json`, so it can be handed straight to `loadConfig()` /
 * `createClientFromConfigFile()` from `@metrc/retailid/node`.
 * It holds API keys, so it is git-ignored; never commit it.
 */

import { chmod, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SETTINGS_ENV_VAR = 'RID_EXAMPLE_SETTINGS';
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SETTINGS_FILE = join(REPO_ROOT, 'settings.json');

// Fields shown on the Settings tab, in order.
export const FIELDS = ['vendor_api_key', 'user_api_key', 'state_code', 'base_url'];
export const KEY_FIELDS = ['vendor_api_key', 'user_api_key'];

// Remembered between runs for convenience; not a secret.
export const LICENSE_FIELD = 'license_number';

const STORED = [...FIELDS, LICENSE_FIELD];

export function settingsPath() {
  return resolve(process.env[SETTINGS_ENV_VAR] || DEFAULT_SETTINGS_FILE);
}

/** The settings path for showing in the UI: relative to the repo, or with ~ for home. */
export function displayPath(path = settingsPath()) {
  for (const [base, prefix] of [[REPO_ROOT, ''], [homedir(), '~']]) {
    const rel = relative(base, path);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return prefix ? join(prefix, rel) : rel;
  }
  return path;
}

async function readObject(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  try {
    const data = JSON.parse(text.replace(/^﻿/, ''));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** Return the saved settings, or empty values if nothing has been saved yet. */
export async function loadSettings(path = settingsPath()) {
  const data = await readObject(path);
  return Object.fromEntries(STORED.map((key) => [key, data[key] == null ? '' : String(data[key])]));
}

/** Write the settings, keeping any extra keys (timeout, max_retries, ...) already in the file. */
export async function saveSettings(values, path = settingsPath()) {
  const existing = await readObject(path);
  for (const key of STORED) {
    // The SDK treats a missing/null base_url or state_code as "not set".
    existing[key] = String(values[key] ?? '').trim() || null;
  }
  await writeFile(path, JSON.stringify(existing, null, 4) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Not supported everywhere (e.g. some Windows filesystems).
  }
  return path;
}

/** Mask an API key for display: only the last four characters are shown. */
export function mask(key) {
  if (!key) return '(not set)';
  return key.length > 8 ? '•'.repeat(8) + key.slice(-4) : '•'.repeat(key.length);
}
