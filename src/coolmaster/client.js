// -----------------------------------------------------------------------------
// The TCP command line of a CoolMasterNet bridge, ported from
// pycoolmasternet-async 0.2.6 (MIT, `_make_request`): connect, wait for the
// prompt ">" (after a line feed when the bridge needs one to wake up), send
// one command and a line feed, read until "\n>", drop the trailing "OK".
// pycoolmasternet opens one connection per request; here one session (one
// connection) carries the few requests of one poll or one command, so the
// address stays the same for all of them, then closes.
//
// Reading is bounded in bytes and time: each chunk is looked at once (the
// terminator is searched in the chunk and the last bytes of the previous
// one), the chunks are joined once at the end, a session that sends more than
// the limit is closed. Nothing the bridge sends is ever logged.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';

export const ERROR_KINDS = {
  /** No connection: nothing was sent. */
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  /** The bridge closed the connection. */
  CLOSED: 'closed',
  /** An answer that is not what the protocol says (too long, no prompt, no unit). */
  PROTOCOL: 'protocol',
  /** The bridge answered with an error ("Unknown command", "Unsupported Feature"...). */
  REJECTED: 'rejected',
  /** Too late to start: nothing was sent. */
  LATE: 'late',
};

export class CoolError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'CoolError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/** The reason of an error for a log or a message: its kind, never what the bridge sent. */
export const errorReason = (err) => err?.kind ?? 'error';

/**
 * A real TCP connection -> { write(text), destroy(), on(data|close, fn) }.
 * Rejects UNREACHABLE when nothing accepted it in time.
 */
export function tcpConnect({ host, port }, { timeoutMs = TIMINGS.connectTimeout } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new CoolError(ERROR_KINDS.UNREACHABLE, err?.code ?? 'unreachable'));
      }
    };
    socket.setTimeout(Math.max(1, timeoutMs), () => fail({ code: 'timeout' }));
    socket.once('error', fail);
    socket.once('connect', () => {
      if (settled) {
        return;
      }
      settled = true;
      socket.setTimeout(0);
      socket.removeListener('error', fail);
      // Errors after the connection: a close follows, the session handles it.
      socket.on('error', () => {});
      resolve({
        write: (text) => socket.write(text, 'latin1'),
        destroy: () => socket.destroy(),
        on: (event, fn) => socket.on(event === 'close' ? 'close' : 'data', fn),
      });
    });
  });
}

/** One connection to a bridge, one request at a time. */
export class Session {
  constructor(socket, { now = Date.now, timers = globalThis } = {}) {
    this.socket = socket;
    this.now = now;
    this.timers = timers;
    this.chunks = [];
    this.size = 0;
    this.tail = '';
    this.waiter = undefined;
    this.closed = false;
    /** Whether a request was written (a command may have reached the bridge). */
    this.written = false;
    socket.on('data', (data) => this.onData(data));
    socket.on('close', () => this.onClose());
  }

  onData(data) {
    if (this.closed) {
      return;
    }
    const text = Buffer.isBuffer(data) ? data.toString('latin1') : String(data);
    const limit = this.waiter?.limit ?? LIMITS.responseBytes;
    // The terminator may straddle two chunks: searched in the tail of the
    // previous one plus this one, never in the whole buffer again.
    const window = this.tail + text;
    // The first of the terminators the waiter accepts (the earliest end wins).
    let index = -1;
    let length = 0;
    for (const terminator of this.waiter?.terminators ?? []) {
      const at = window.indexOf(terminator);
      if (at !== -1 && (index === -1 || at + terminator.length < index + length)) {
        index = at;
        length = terminator.length;
      }
    }
    if (index !== -1) {
      const before = this.tail.length;
      // Bytes of this chunk up to the end of the terminator.
      const cut = index + length - before;
      this.chunks.push(text.slice(0, Math.max(0, cut)));
      const all = this.chunks.join('');
      const rest = text.slice(Math.max(0, cut));
      this.chunks = rest === '' ? [] : [rest];
      this.size = rest.length;
      this.tail = rest.slice(-4);
      const waiter = this.waiter;
      this.waiter = undefined;
      this.timers.clearTimeout(waiter.timer);
      if (all.length > waiter.limit) {
        this.fail(new CoolError(ERROR_KINDS.PROTOCOL, 'Answer too long'), waiter);
        return;
      }
      waiter.resolve(all);
      return;
    }
    this.chunks.push(text);
    this.size += text.length;
    this.tail = window.slice(-4);
    if (this.size > limit) {
      this.fail(new CoolError(ERROR_KINDS.PROTOCOL, 'Answer too long'));
    }
  }

  onClose() {
    this.fail(new CoolError(ERROR_KINDS.CLOSED, 'Connection closed'));
  }

  fail(err, waiter = this.waiter) {
    this.waiter = undefined;
    if (waiter) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.close();
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.chunks = [];
      this.size = 0;
      try {
        this.socket.destroy();
      } catch {
        // already gone
      }
    }
  }

  /** Waits for one of `terminators`, within `timeoutMs`, at most `limit` characters. */
  readUntil(terminators, timeoutMs, limit) {
    if (this.closed) {
      return Promise.reject(new CoolError(ERROR_KINDS.CLOSED, 'Connection closed'));
    }
    return new Promise((resolve, reject) => {
      const waiter = { terminators, resolve, reject, limit, timer: undefined };
      waiter.timer = this.timers.setTimeout(
        () => {
          if (this.waiter === waiter) {
            this.fail(new CoolError(ERROR_KINDS.TIMEOUT, 'No answer in time'), waiter);
          }
        },
        Math.max(1, timeoutMs),
      );
      this.waiter = waiter;
      // What arrived before the wait (kept in the buffer) is looked at once.
      if (this.chunks.length > 0) {
        const pending = this.chunks.join('');
        this.chunks = [];
        this.size = 0;
        this.tail = '';
        this.onData(pending);
      }
    });
  }

  /**
   * The first prompt: ">" on its own, or, after the wake-up line feed, the
   * prompt that answers it ("\r\n>" or ">>", as pycoolmasternet reads it), so
   * a bridge that shows ">" on connection then again after the line feed
   * never leaves a prompt behind.
   */
  async prompt({ wakeup = false, timeoutMs = TIMINGS.requestTimeout } = {}) {
    if (wakeup) {
      this.socket.write('\n');
      await this.readUntil(['\n>', '>>'], timeoutMs, LIMITS.promptBytes);
    } else {
      await this.readUntil(['>'], timeoutMs, LIMITS.promptBytes);
    }
    this.discard();
  }

  /** Drops what is buffered: nothing that arrived before a request is its answer. */
  discard() {
    this.chunks = [];
    this.size = 0;
    this.tail = '';
  }

  /**
   * One request -> { text, ok }: `text` without the prompt nor the final
   * "OK"; `ok` when the answer ended with "OK". `beforeSend()` runs right
   * before the write: what it throws is rethrown marked `notSent`. "Unknown
   * command" and "Unsupported Feature" answers reject REJECTED.
   */
  async request(command, { timeoutMs = TIMINGS.requestTimeout, beforeSend } = {}) {
    if (this.closed) {
      throw new CoolError(ERROR_KINDS.CLOSED, 'Connection closed', { notSent: true });
    }
    if (beforeSend) {
      try {
        beforeSend();
      } catch (err) {
        throw Object.assign(err, { notSent: true, beforeSend: true });
      }
    }
    if (timeoutMs < 1) {
      throw new CoolError(ERROR_KINDS.LATE, 'Too late to send', { notSent: true });
    }
    this.discard();
    const reading = this.readUntil(['\n>'], timeoutMs, LIMITS.responseBytes);
    this.written = true;
    this.socket.write(`${command}\n`);
    let data;
    try {
      data = await reading;
    } catch (err) {
      // Written: this request may have reached the bridge.
      throw Object.assign(err, { sent: true });
    }
    return this.parse(command, data);
  }

  /** One answer (up to its prompt) -> { text, ok }; REJECTED (sent) on an error answer. */
  parse(command, raw) {
    const lines = raw.slice(0, -1).split(/\r?\n/); // without the prompt
    // An echo of the command, when the bridge echoes.
    if (lines[0]?.trim() === command) {
      lines.shift();
    }
    let text = lines.join('\n').trimEnd();
    let ok = false;
    if (/(^|\n)OK$/.test(text)) {
      ok = true;
      text = text.slice(0, -2).trimEnd();
    }
    if (/Unknown command|Unsupported Feature/i.test(text)) {
      throw new CoolError(ERROR_KINDS.REJECTED, 'Rejected by the bridge', {
        unknownCommand: /Unknown command/i.test(text),
        sent: true,
      });
    }
    return { text, ok };
  }

  /**
   * Several commands written at once, then their answers read in order (the
   * command line answers each line in turn). `beforeEach(i)` runs right
   * before the write of command i: what it throws skips it (`notSent`).
   * `timeoutMs()`: the time left for each answer. -> one result per command:
   * { answer } or { error } (`notSent`, or `sent` once written). After a
   * silence or a closed connection, the answers still missing are errors
   * marked `sent`.
   */
  async pipeline(commands, { beforeEach, timeoutMs }) {
    const results = new Array(commands.length);
    const written = [];
    this.discard();
    for (const [i, command] of commands.entries()) {
      if (this.closed) {
        results[i] = {
          error: new CoolError(ERROR_KINDS.CLOSED, 'Connection closed', { notSent: true }),
        };
        continue;
      }
      try {
        beforeEach?.(i);
      } catch (err) {
        results[i] = { error: Object.assign(err, { notSent: true, beforeSend: true }) };
        continue;
      }
      this.written = true;
      this.socket.write(`${command}\n`);
      written.push(i);
    }
    let broken;
    for (const i of written) {
      if (broken) {
        results[i] = { error: new CoolError(broken.kind, broken.message, { sent: true }) };
        continue;
      }
      try {
        const left = timeoutMs();
        if (left < 1) {
          throw new CoolError(ERROR_KINDS.TIMEOUT, 'No answer in time');
        }
        const data = await this.readUntil(['\n>'], left, LIMITS.responseBytes);
        results[i] = { answer: this.parse(commands[i], data) };
      } catch (err) {
        if (err.kind !== ERROR_KINDS.REJECTED) {
          broken = err;
          this.close();
        }
        results[i] = { error: Object.assign(err, { sent: true }) };
      }
    }
    return results;
  }
}

/** Opens a session: connection, then prompt, within `timeoutMs`. */
export async function openSession(
  address,
  { connect = tcpConnect, wakeup = false, timeoutMs = TIMINGS.connectTimeout, now, timers } = {},
) {
  const started = (now ?? Date.now)();
  const socket = await connect(address, { timeoutMs });
  const session = new Session(socket, { now, timers });
  try {
    const left = timeoutMs - ((now ?? Date.now)() - started);
    if (left < 1) {
      throw new CoolError(ERROR_KINDS.LATE, 'Too late', { notSent: true });
    }
    await session.prompt({ wakeup, timeoutMs: left });
  } catch (err) {
    session.close();
    // No prompt: nothing was sent but the wake-up line feed.
    throw Object.assign(err, { notSent: true });
  }
  return session;
}

/**
 * Connections to one bridge at once for the polls and the commands other
 * than a stop (`shared`, 2). Stops have their own lane (one connection more,
 * see app.js `runStops`): 3 connections in all, as pycoolmasternet.
 */
export class Slots {
  constructor(shared, { timers = globalThis } = {}) {
    this.shared = shared;
    this.timers = timers;
    this.used = 0;
    this.queue = [];
  }

  /** A release function that counts once. */
  releaser() {
    let done = false;
    return () => {
      if (done) {
        return;
      }
      done = true;
      const next = this.queue.shift();
      if (next) {
        next.grant();
      } else {
        this.used = Math.max(0, this.used - 1);
      }
    };
  }

  /** -> a release function. `waitMs`: a waiter still queued after it leaves the queue, rejected LATE. */
  acquire({ waitMs } = {}) {
    if (this.used < this.shared) {
      this.used += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const entry = {
        timer: undefined,
        grant: () => {
          this.timers.clearTimeout(entry.timer);
          resolve(this.releaser());
        },
      };
      if (waitMs !== undefined) {
        entry.timer = this.timers.setTimeout(
          () => {
            const index = this.queue.indexOf(entry);
            if (index !== -1) {
              this.queue.splice(index, 1);
              reject(new CoolError(ERROR_KINDS.LATE, 'Too late to send', { notSent: true }));
            }
          },
          Math.max(0, waitMs),
        );
      }
      this.queue.push(entry);
    });
  }
}
