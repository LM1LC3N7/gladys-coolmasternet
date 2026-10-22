// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  allow_commands: false,
  swing_support: false,
  wakeup_prompt: false,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * One address typed by the user: an IPv4 address or a host name, with an
 * optional port (10102 by default).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '');
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:@]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") turns an option on: anything else, missing included, is off. */
const strictTrue = (value) => value === true || value === 'true';

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const addresses = [];
  const invalid = [];
  const seen = new Set();
  let dropped = 0;
  const typed = String(c.addresses ?? '')
    .slice(0, 2000)
    .split(/[\s,;]+/)
    .filter((part) => part !== '');
  for (const part of typed) {
    const address = parseAddress(part);
    if (!address) {
      invalid.push(part.slice(0, 60));
      continue;
    }
    const key = addressKey(address);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (addresses.length < LIMITS.bridges) {
      addresses.push(address);
    } else {
      dropped += 1;
    }
  }
  const interval = Number(c.poll_interval);
  return {
    addresses,
    /** What was typed and is not a valid address (shown in the status). */
    invalid: invalid.length > 0 ? invalid.slice(0, 5).join(', ') : undefined,
    /** Addresses left out: more than the integration reads. */
    dropped,
    allowCommands: strictTrue(c.allow_commands),
    swing: strictTrue(c.swing_support),
    wakeup: strictTrue(c.wakeup_prompt),
    pollInterval:
      Number.isFinite(interval) && String(c.poll_interval).trim() !== ''
        ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
        : POLL_INTERVAL.default,
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
