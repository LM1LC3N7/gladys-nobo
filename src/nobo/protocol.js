// -----------------------------------------------------------------------------
// The text protocol of the Nobø Hub API v1.1 (pure): lines read, lines
// written, names, timestamps and the week profiles.
//
// A client must ignore unknown commands and extra trailing arguments (§8 of
// the document): every parser below reads the fields it knows and nothing
// else, and returns undefined for a line it cannot trust (a field that is not
// the expected number): such a line changes nothing.
// -----------------------------------------------------------------------------

import { LIMITS, PROFILE_STATUS } from '../constants.js';

const NBSP = ' ';
const INT = /^-?\d{1,9}$/;

/** A strict integer, else undefined ('' and '1.5' are not integers). */
export function int(text) {
  return typeof text === 'string' && INT.test(text) ? Number(text) : undefined;
}

/** A 12-digit serial number, else undefined. */
export const serial = (text) =>
  typeof text === 'string' && /^\d{12}$/.test(text) ? text : undefined;

/** A name as shown: non-breaking spaces back to spaces, control characters removed, cut. */
export function displayName(raw) {
  const text = String(raw ?? '')
    .replaceAll(NBSP, ' ')
    .replace(/\p{Cc}/gu, '');
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return [...trimmed].slice(0, LIMITS.nameLength).join('');
}

/** A name token as written: it is sent back exactly as the hub sent it (never renamed here). */
const token = (raw) =>
  typeof raw === 'string' && raw !== '' && !/[ \t\r\n]/.test(raw) ? raw : undefined;

/** The local date and time `yyyyMMddHHmmss` of `epochMs` in `timeZone`. */
export function localStamp(epochMs, timeZone) {
  const parts = localParts(epochMs, timeZone);
  if (!parts) return undefined;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${parts.year}${p2(parts.month)}${p2(parts.day)}${p2(parts.hour)}${p2(parts.minute)}${p2(parts.second)}`;
}

const formatters = new Map();
/** Year, month, day, hour, minute, second and weekday (0 = Monday) of `epochMs` in `timeZone`. */
export function localParts(epochMs, timeZone) {
  if (!Number.isFinite(epochMs)) return undefined;
  let format = formatters.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      });
    } catch {
      return undefined;
    }
    formatters.set(timeZone, format);
  }
  const map = Object.fromEntries(format.formatToParts(epochMs).map((p) => [p.type, p.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(map.weekday);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday,
  };
}

/** True when the time zone is known to this runtime. */
export function validTimeZone(timeZone) {
  return typeof timeZone === 'string' && timeZone !== '' && localParts(0, timeZone) !== undefined;
}

// --- Lines written -----------------------------------------------------------

export const hello = (serialNumber, stamp, version) => `HELLO ${version} ${serialNumber} ${stamp}`;

/** A zone written back (U00): every field as read, but the two temperatures. */
export const updateZone = (zone, { comfort, eco }) =>
  `U00 ${zone.id} ${zone.rawName} ${zone.profileId} ${comfort} ${eco} ${zone.allowOverrides} -1`;

/** A new override (A03): the id is a dummy (the hub assigns it). */
export const addOverride = ({ mode, type, target, targetId }) =>
  `A03 -1 ${mode} ${type} -1 -1 ${target} ${targetId}`;

// --- Lines read --------------------------------------------------------------

function zoneOf(f) {
  const id = int(f[1]);
  const rawName = token(f[2]);
  const profileId = int(f[3]);
  const comfort = int(f[4]);
  const eco = int(f[5]);
  const allowOverrides = int(f[6]);
  if ([id, profileId, comfort, eco, allowOverrides].some((v) => v === undefined) || !rawName) {
    return undefined;
  }
  if (id < 0 || (allowOverrides !== 0 && allowOverrides !== 1)) return undefined;
  return { id, rawName, name: displayName(rawName), profileId, comfort, eco, allowOverrides };
}

function componentOf(f) {
  const id = serial(f[1]);
  const rawName = token(f[3]);
  const zoneId = int(f[5]);
  const sensorFor = int(f[7]);
  if (!id || !rawName || zoneId === undefined || sensorFor === undefined) return undefined;
  return { serial: id, name: displayName(rawName), zoneId, sensorFor };
}

function profileOf(f) {
  const id = int(f[1]);
  const rawName = token(f[2]);
  const slots = parseProfile(f[3]);
  if (id === undefined || !rawName) return undefined;
  return { id, name: displayName(rawName), slots };
}

function overrideOf(f) {
  const values = f.slice(1, 8).map(int);
  if (values.length < 7 || values.some((v) => v === undefined)) return undefined;
  const [id, mode, type, end, start, target, targetId] = values;
  return {
    id,
    mode,
    type,
    end: f[4],
    start: f[5],
    target,
    targetId,
    endValue: end,
    startValue: start,
  };
}

function hubOf(f) {
  const id = serial(f[1]);
  if (!id) return undefined;
  return {
    serial: id,
    name: displayName(f[2]),
    software: displayName(f[5]),
    hardware: displayName(f[6]),
  };
}

/**
 * One line of the hub -> `{ kind, ... }`, or `{ kind: 'unknown' }` for a
 * command this client does not use, or undefined for a known command whose
 * fields cannot be read.
 */
export function parseLine(line) {
  const f = line.split(' ');
  const cmd = f[0];
  switch (cmd) {
    case 'HELLO':
      return { kind: 'hello', version: f[1] };
    case 'REJECT':
      return { kind: 'reject', code: int(f[1]) };
    case 'HANDSHAKE':
      return { kind: 'handshake' };
    case 'H00':
      return { kind: 'sync-start' };
    case 'H01':
    case 'B00':
    case 'V00': {
      const zone = zoneOf(f);
      return zone ? { kind: 'zone', cmd, zone } : undefined;
    }
    case 'S00': {
      const id = int(f[1]);
      return id === undefined ? undefined : { kind: 'zone-removed', id };
    }
    case 'H02':
    case 'B01':
    case 'V01': {
      const component = componentOf(f);
      return component ? { kind: 'component', cmd, component } : undefined;
    }
    case 'S01': {
      const id = serial(f[1]);
      return id ? { kind: 'component-removed', serial: id } : undefined;
    }
    case 'H03':
    case 'B02':
    case 'V02': {
      const profile = profileOf(f);
      return profile ? { kind: 'profile', cmd, profile } : undefined;
    }
    case 'S02': {
      const id = int(f[1]);
      return id === undefined ? undefined : { kind: 'profile-removed', id };
    }
    case 'H04':
    case 'B03': {
      const override = overrideOf(f);
      return override ? { kind: 'override', cmd, override } : undefined;
    }
    case 'S03': {
      const id = int(f[1]);
      return id === undefined ? undefined : { kind: 'override-removed', id };
    }
    case 'H05':
    case 'V03': {
      const hub = hubOf(f);
      return hub ? { kind: 'hub', cmd, hub } : undefined;
    }
    case 'Y02': {
      const id = serial(f[1]);
      if (!id) return undefined;
      return { kind: 'temperature', serial: id, value: temperature(f[2]) };
    }
    default:
      if (/^E\d\d$/.test(cmd)) {
        return { kind: 'error', about: f[1] ?? '', message: f.slice(2).join(' ') };
      }
      return { kind: 'unknown', cmd: cmd.slice(0, 8) };
  }
}

/** A temperature of Y02: a decimal number, or null ("N/A": too old, unknown). */
export function temperature(text) {
  if (typeof text !== 'string' || !/^-?\d{1,3}(\.\d{1,4})?$/.test(text)) return null;
  return Number(text);
}

// --- Week profiles -----------------------------------------------------------

/**
 * "HHMMs,HHMMs,…" -> 7 days of `[{ minute, status }]` slots, each day starting
 * at 0000 (Monday first: to check on a real hub), or null when the text does
 * not follow the document (then the profile tells nothing).
 */
export function parseProfile(text) {
  if (typeof text !== 'string' || text.length > 672 * 6) return null;
  const days = [];
  for (const entry of text.split(',')) {
    const m = /^(\d\d)(\d\d)(\d)$/.exec(entry);
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    const status = Number(m[3]);
    if (hour > 23 || minute > 59 || !Object.values(PROFILE_STATUS).includes(status)) return null;
    const at = hour * 60 + minute;
    if (at === 0) {
      days.push([]);
    } else if (days.length === 0 || at <= days.at(-1).at(-1).minute) {
      return null;
    }
    days.at(-1).push({ minute: at, status });
  }
  return days.length === 7 ? days : null;
}

/** The status of a profile at a local time (weekday 0 = Monday), or undefined. */
export function profileStatusAt(slots, { weekday, hour, minute }) {
  if (!slots || !(weekday >= 0 && weekday <= 6)) return undefined;
  const at = hour * 60 + minute;
  let status;
  for (const slot of slots[weekday]) {
    if (slot.minute <= at) status = slot.status;
  }
  return status;
}
