// -----------------------------------------------------------------------------
// One TCP session with the hub: the handshake, the lines both ways, the
// keepalive. Lines are cut on carriage return (a line feed is accepted too),
// bounded in size; every line read is parsed and emitted as a 'message'.
//
// The session never reconnects by itself: src/app.js opens a new one (after a
// close, nothing of the old one is kept, nor answered).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createConnection as netConnect } from 'node:net';
import { API, LIMITS, TIMINGS } from '../constants.js';
import { hello, parseLine } from './protocol.js';

export class SessionError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

export class HubSession extends EventEmitter {
  constructor({
    createConnection = netConnect,
    timers = globalThis,
    monotonic = () => performance.now(),
  } = {}) {
    super();
    this.createConnection = createConnection;
    this.timers = timers;
    this.monotonic = monotonic;
    this.socket = undefined;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.waiters = new Set();
    this.lastWrite = 0;
    this.lastRead = 0;
    this.idleTimer = undefined;
    this.keepaliveTimer = undefined;
    this.ready = false;
  }

  /** Connects and runs the handshake; resolves once both sides said HANDSHAKE. */
  async open({ host, port = API.port, serialNumber, stamp }) {
    const socket = this.createConnection({ host, port });
    this.socket = socket;
    socket.setNoDelay?.(true);
    socket.setKeepAlive?.(true, 10_000);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => this.close('error'));
    socket.on('close', () => this.close('closed'));
    await this.until(
      new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('close', () => reject(new SessionError('unreachable')));
      }),
      TIMINGS.connectTimeout,
      'unreachable',
    );
    const answer = this.next(
      (m) => m.kind === 'hello' || m.kind === 'reject',
      TIMINGS.handshakeTimeout,
    );
    this.write(hello(serialNumber, stamp, API.version));
    const first = await answer;
    if (!first) throw new SessionError('timeout');
    if (first.kind === 'reject') {
      throw new SessionError(
        first.code === 1 ? 'serial' : first.code === 0 ? 'version' : 'protocol',
        `REJECT ${first.code}`,
      );
    }
    if (String(first.version).split('.')[0] !== API.version.split('.')[0]) {
      this.write('REJECT');
      throw new SessionError('version', `hub ${String(first.version).slice(0, 10)}`);
    }
    const done = this.next((m) => m.kind === 'handshake', TIMINGS.handshakeTimeout);
    this.write('HANDSHAKE');
    if (!(await done)) throw new SessionError('timeout');
    this.ready = true;
    this.armKeepalive();
  }

  /** G00: everything is emitted as messages; resolves at H05 (the end), rejects past the timeout. */
  async sync() {
    let count = 0;
    const counter = () => {
      count += 1;
      if (count > LIMITS.syncMessages) this.close('too-long');
    };
    this.on('message', counter);
    try {
      const end = this.next((m) => m.kind === 'hub' && m.cmd === 'H05', TIMINGS.syncTimeout);
      this.write('G00');
      const hub = await end;
      if (!hub) throw new SessionError(this.closed ? 'closed' : 'timeout');
      return hub;
    } finally {
      this.off('message', counter);
    }
  }

  /** Writes one line; false when the session is closed. */
  write(line) {
    if (this.closed || !this.socket) return false;
    this.lastWrite = this.monotonic();
    this.socket.write(`${line}\r`, 'utf8');
    return true;
  }

  /** The next message matching `match`, or undefined after `ms` or at the close. */
  next(match, ms) {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve(undefined);
        return;
      }
      const waiter = {
        match,
        resolve: (value) => {
          this.timers.clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          resolve(value);
        },
      };
      waiter.timer = this.timers.setTimeout(() => waiter.resolve(undefined), Math.max(0, ms));
      this.waiters.add(waiter);
    });
  }

  until(promise, ms, reason) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = this.timers.setTimeout(() => reject(new SessionError(reason)), ms);
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let start = 0;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const byte = this.buffer[i];
      if (byte !== 13 && byte !== 10) continue;
      if (i > start) this.onLine(this.buffer.subarray(start, i).toString('utf8'));
      if (this.closed) return;
      start = i + 1;
    }
    this.buffer = this.buffer.subarray(start);
    if (this.buffer.length > LIMITS.lineBytes) this.close('line-too-long');
  }

  onLine(line) {
    this.lastRead = this.monotonic();
    if (Buffer.byteLength(line) > LIMITS.lineBytes) {
      this.close('line-too-long');
      return;
    }
    const msg = parseLine(line);
    if (!msg) return;
    for (const waiter of [...this.waiters]) {
      if (waiter.match(msg)) waiter.resolve(msg);
    }
    this.emit('message', msg);
  }

  armKeepalive() {
    // Our own lines keep the session alive too: a keepalive only after 14 s without any.
    const tick = () => {
      if (this.closed) return;
      const now = this.monotonic();
      const due = this.lastWrite + TIMINGS.keepalive;
      if (now >= due) {
        this.write('KEEPALIVE');
        this.keepaliveTimer = this.timers.setTimeout(tick, TIMINGS.keepalive);
      } else {
        this.keepaliveTimer = this.timers.setTimeout(tick, due - now);
      }
    };
    this.keepaliveTimer = this.timers.setTimeout(tick, TIMINGS.keepalive);
  }

  /**
   * A hub that sends nothing for 75 s is asked for everything again (G00; the
   * document gives no other request that is always answered): without its end
   * (H05) within 20 s, the session is frozen and closed.
   */
  watchIdle() {
    this.lastRead = this.monotonic();
    const tick = async () => {
      if (this.closed) return;
      const now = this.monotonic();
      const due = this.lastRead + TIMINGS.idleTimeout;
      if (now < due) {
        this.idleTimer = this.timers.setTimeout(tick, due - now);
        return;
      }
      const end = this.next((m) => m.kind === 'hub' && m.cmd === 'H05', TIMINGS.syncTimeout);
      this.write('G00');
      if (!(await end)) {
        this.close('frozen');
        return;
      }
      if (!this.closed) this.idleTimer = this.timers.setTimeout(tick, TIMINGS.idleTimeout);
    };
    this.idleTimer = this.timers.setTimeout(tick, TIMINGS.idleTimeout);
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.timers.clearTimeout(this.keepaliveTimer);
    this.timers.clearTimeout(this.idleTimer);
    for (const waiter of [...this.waiters]) waiter.resolve(undefined);
    try {
      this.socket?.destroy();
    } catch {
      // already gone
    }
    this.emit('close', reason);
  }
}
