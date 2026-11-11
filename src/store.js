// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), bounded and repaired when read back:
//   - the away commands not yet confirmed by the hub (sent again after a
//     restart, until the hub shows them or a newer choice replaces them,
//     6 sends and 15 min at most);
//   - the mark of a serial number the hub refused (8 bits of a salted hash,
//     never the serial), so a refused serial is not sent again by itself;
//   - the time of the last connection attempt (a restart never connects sooner
//     than the backoff).
// The serial number itself is never written. A small JSON file, written
// through a temporary file and a rename, one save after the other, readable by
// the container user only (0600).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import { LIMITS, OVERRIDE_TARGET, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/nobo-state.json';
const MAX_STATE_BYTES = 64 * 1024;

export function fileStore(path = STATE_FILE) {
  let chain = Promise.resolve();
  return {
    /** null when there is no file (a fresh install); throws when it cannot be read or parsed. */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error('state file too large');
      return JSON.parse(text);
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        const file = await open(temporary, 'w', 0o600);
        try {
          await file.writeFile(text, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** The same in memory (tests). */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    fail: false,
    unreadable: false,
    async load() {
      if (this.unreadable) throw new Error('unreadable');
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      if (this.fail) throw new Error('read-only');
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

const HUB_KEY = /^\d{9}$/;

/** One pending away command, repaired; undefined when it cannot be trusted. */
function pendingOf(raw, now) {
  if (!raw || typeof raw !== 'object' || !HUB_KEY.test(raw.hubKey)) return undefined;
  const target = raw.target;
  const targetId = raw.targetId;
  if (target === OVERRIDE_TARGET.HUB ? targetId !== -1 : target !== OVERRIDE_TARGET.ZONE)
    return undefined;
  if (!Number.isInteger(targetId) || targetId < -1 || targetId > 1e6) return undefined;
  // A date in the future is not ours (clock jump, hand edit): dropped.
  if (!Number.isFinite(raw.at) || raw.at > now || now - raw.at > TIMINGS.protectiveLife)
    return undefined;
  const sends = Number.isInteger(raw.sends)
    ? Math.max(0, Math.min(raw.sends, TIMINGS.protectiveSends))
    : 0;
  const afterId =
    Number.isInteger(raw.afterId) && raw.afterId >= -1 && raw.afterId < 1e9 ? raw.afterId : null;
  return { hubKey: raw.hubKey, target, targetId, at: raw.at, sends, afterId };
}

export function normalizeMemory(raw, now = Date.now()) {
  const salt =
    typeof raw?.salt === 'string' && /^[0-9a-f]{32}$/.test(raw.salt)
      ? raw.salt
      : randomBytes(16).toString('hex');
  const r = raw?.refusal;
  const refusal =
    r && HUB_KEY.test(r.hubKey) && typeof r.mark === 'string' && /^[0-9a-f]{2}$/.test(r.mark)
      ? { hubKey: r.hubKey, mark: r.mark }
      : null;
  const pending = (Array.isArray(raw?.pending) ? raw.pending.slice(0, LIMITS.pending) : [])
    .map((p) => pendingOf(p, now))
    .filter(Boolean);
  const last = raw?.lastAttemptAt;
  return {
    salt,
    refusal,
    pending,
    lastAttemptAt: Number.isFinite(last) && last > 0 && last <= now ? last : null,
  };
}
