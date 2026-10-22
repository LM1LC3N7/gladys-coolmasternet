// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), readable by the container user only (0600), in one file
// rewritten as it changes (temporary file, fsync, rename):
//   coolmasternet-state.json: per address typed in the configuration, the id
//   chosen for its devices the first time (the serial number, or the
//   readable fallback "a-<address>" with `fallback`; kept for good, so the
//   external ids never change), the serial number last read there (the
//   identity check: a stop command can then be sent after a restart, before
//   the first read, to the right bridge) and the time of the last read attempt (written before the read, at most once a
//   minute: a restart never reads sooner than the interval).
// Nothing secret: the command line has no password.
// -----------------------------------------------------------------------------

import { open, readFile, rename } from 'node:fs/promises';
import { LIMITS } from './constants.js';

export const STATE_FILE = '/data/coolmasternet-state.json';

const ADDRESS = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
const SERIAL = /^[a-z0-9]{4,40}$/;
const ID = /^[a-z0-9-]{4,80}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** A file written whole or not at all: temporary file, fsync, rename. */
async function writeDurably(path, text) {
  const temporary = `${path}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 256 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(() => writeDurably(path, text));
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trips as the file; `failing` refuses every save. */
export function memoryStore(initial = null, { failing = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failing,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failing) {
        throw new Error('EROFS');
      }
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/**
 * The persisted state, repaired and bounded: only known keys of the expected
 * shape (never an inherited or `__proto__` key). An attempt "in the future"
 * (a clock set back) counts as now.
 */
export function normalizeMemory(raw, now) {
  const bridges = new Map();
  const rawBridges = own(raw, 'bridges');
  if (isObject(rawBridges)) {
    for (const key of Object.keys(rawBridges).slice(0, LIMITS.bridges * 4)) {
      const entry = own(rawBridges, key);
      if (!ADDRESS.test(key) || !isObject(entry)) {
        continue;
      }
      const serial = own(entry, 'serial');
      const attemptAt = own(entry, 'attemptAt');
      const id = own(entry, 'id');
      bridges.set(key, {
        id: typeof id === 'string' && ID.test(id) ? id : undefined,
        fallback: own(entry, 'fallback') === true,
        serial: typeof serial === 'string' && SERIAL.test(serial) ? serial : undefined,
        attemptAt: Number.isFinite(attemptAt) && attemptAt > 0 ? Math.min(attemptAt, now) : 0,
      });
    }
  }
  return { bridges };
}

/** The persisted form (plain objects of validated keys only). */
export function serializeMemory(memory) {
  return {
    bridges: Object.fromEntries(
      [...memory.bridges].map(([key, { id, fallback, serial, attemptAt }]) => [
        key,
        {
          ...(id ? { id } : {}),
          ...(fallback ? { fallback: true } : {}),
          ...(serial ? { serial } : {}),
          attemptAt,
        },
      ]),
    ),
  };
}
