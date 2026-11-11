// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
//
// The 12-digit serial number of the hub is what the handshake asks for: it is
// kept by Gladys in its database, never shown again, never logged, never in
// /data nor in a status. Only its first 9 digits, which the hub itself
// announces on the network every 2 s, name the hub here (ids, /data).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { validTimeZone } from './nobo/protocol.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  host: '',
  timezone: 'Europe/Oslo',
  allow_modes: false,
  allow_setpoints: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/**
 * An IPv4 or IPv6 unicast address, else undefined: no broadcast, multicast,
 * unspecified nor loopback address (the hub is another machine of the LAN).
 */
export function unicastAddress(raw) {
  const text = String(raw ?? '').trim();
  const kind = isIP(text);
  if (kind === 4) {
    const parts = text.split('.').map(Number);
    if (parts[0] === 0 || parts[0] === 127 || parts[0] >= 224) return undefined;
    if (parts[3] === 255 || parts[3] === 0) return undefined;
    return text;
  }
  if (kind === 6) {
    const lower = text.toLowerCase();
    if (lower === '::' || lower === '::1' || lower.startsWith('ff')) return undefined;
    return lower;
  }
  return undefined;
}

/** The serial typed by the user: 12 digits once spaces and dashes are removed, else ''. */
export function normalizeSerial(raw) {
  const text = String(raw ?? '').replace(/[\s-]/g, '');
  return /^\d{12}$/.test(text) ? text : '';
}

/** A boolean option: true only when the value is `true` or the text "true". */
const flag = (value, fallback) =>
  value === true || value === 'true'
    ? true
    : value === false || value === 'false'
      ? false
      : fallback;

export function normalizeConfig(raw = {}) {
  const serialNumber = normalizeSerial(raw?.serial);
  const hostText = String(raw?.host ?? '').trim();
  const host = hostText === '' ? '' : unicastAddress(hostText);
  const timezone = String(raw?.timezone ?? '').trim() || DEFAULTS.timezone;
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  return {
    serialNumber,
    serialError:
      serialNumber === ''
        ? String(raw?.serial ?? '').trim() === ''
          ? 'missing'
          : 'invalid'
        : undefined,
    /** The first 9 digits: the name of the hub here. */
    hubKey: serialNumber.slice(0, 9),
    host: host ?? '',
    hostError: host === undefined ? 'invalid' : undefined,
    timezone: validTimeZone(timezone) ? timezone : DEFAULTS.timezone,
    timezoneError: validTimeZone(timezone) ? undefined : 'invalid',
    allowModes: flag(raw?.allow_modes, DEFAULTS.allow_modes),
    allowSetpoints: flag(raw?.allow_setpoints, DEFAULTS.allow_setpoints),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/** True when the hub can be reached: a serial, and no invalid address. */
export const isComplete = (config) => config.serialNumber !== '' && config.hostError === undefined;

/**
 * The mark of a serial the hub refused: 8 bits of a salted hash, so /data never
 * holds the serial, and a brute force on the mark tells nothing useful.
 */
export const serialMark = (salt, serialNumber) =>
  createHash('sha256').update(`${salt}:${serialNumber}`, 'utf8').digest('hex').slice(0, 2);
