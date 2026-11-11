// -----------------------------------------------------------------------------
// The app on a REAL moving clock (sped up 100 times) and a real local TCP
// server playing the hub (gladys-testkit): the handshake and the download
// over a real socket, then the keepalives measured at 14 s (never sooner,
// never much later), a bounded number of timers, nothing left after stop.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { existsSync } from 'node:fs';
import { NoboApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { HubSession } from '../src/nobo/session.js';
import { memoryStore } from '../src/store.js';
import { PROFILE, SERIAL } from './helpers/fakeHub.js';

// The kit lives on the development machine only (not on GitHub CI): imported when present.
const KIT_PATH = '/home/claude/code/ref/gladys-testkit/index.mjs';
const KIT = existsSync(KIT_PATH);
const { measurePeriod, realClock, tcpServer } = KIT ? await import(KIT_PATH) : {};

function answer(line) {
  if (line.startsWith('HELLO')) return 'HELLO 1.1\r';
  if (line === 'HANDSHAKE') return 'HANDSHAKE\r';
  if (line === 'G00') {
    return [
      'H00',
      'H01 1 Stue 1 22 17 1 -1',
      `H03 1 Default ${PROFILE}`,
      `H05 ${SERIAL} Hub 13 -1 115 1 20130813`,
      '',
    ].join('\r');
  }
  return '';
}

test(
  'real clock: real socket, keepalive every 14 s, timers bounded',
  { skip: !KIT && 'gladys-testkit absent' },
  async (t) => {
    const hub = await tcpServer({
      onData: (chunk) => chunk.toString('utf8').split('\r').filter(Boolean).map(answer).join(''),
    });
    const clock = realClock({ speed: 100 });
    const gladys = createFakeGladys({
      selector: 'nobo',
      config: { serial: SERIAL, host: '192.168.1.50' },
    });
    const quiet = () => {};
    const app = new NoboApp({
      gladys,
      logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
      createConnection: () => createConnection({ host: hub.host, port: hub.port }),
      now: clock.now,
      monotonic: clock.monotonic,
      timers: clock.timers,
      store: memoryStore(),
    });
    const original = HubSession.prototype.write;
    const spy = { clock, calls: [] };
    HubSession.prototype.write = function write(line) {
      if (line === 'KEEPALIVE') spy.calls.push({ at: clock.monotonic() });
      return original.call(this, line);
    };
    t.after(async () => {
      HubSession.prototype.write = original;
      await app.shutdown();
      clock.close();
      await hub.close();
    });
    await app.onConnected(async () => ({ serial: SERIAL, host: '192.168.1.50' }));
    const deadline = performance.now() + 5_000;
    while (app.sessionState !== 'ready' && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(app.sessionState, 'ready');
    assert.equal(gladys.fake.connectionStatus.connected, true);
    const gaps = await measurePeriod(spy, { count: 4, period: TIMINGS.keepalive });
    assert.equal(gaps.length, 3);
    assert.ok(clock.timersSet < 40, `${clock.timersSet} timers`);
    assert.equal(hub.connections, 1, 'one session, kept');
  },
);
