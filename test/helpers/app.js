// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, the fake hub and a virtual clock.
// The monotonic clock moves 1 µs per read of it, so that a decision reading
// the clock twice is caught.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NoboApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { buildHub, buildZone } from '../../src/devices.js';
import { memoryStore } from '../../src/store.js';
import { HUB_KEY, SERIAL, fakeHub } from './fakeHub.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'nobo';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
/** 2026-11-11 10:00 UTC = 11:00 in Oslo (comfort in the default profile). */
export const NOW = Date.UTC(2026, 10, 11, 10, 0, 0);
export const ADDRESS = '192.168.1.50';
export const CONFIG = { serial: SERIAL, host: ADDRESS };
export const ZONE = (id) => `ext:${SELECTOR}:zone:${HUB_KEY}-${id}`;
export const ZF = (id, role) => `${ZONE(id)}:${role}`;
export const HUB = `ext:${SELECTOR}:hub:${HUB_KEY}`;
export const HF = (role) => `${HUB}:${role}`;

/** The devices as the user created them from the Discovery list. */
export function created(zoneIds = [1, 2], { hub = true } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const devices = zoneIds.map((id) =>
    buildZone(gladys, HUB_KEY, { id, name: `Zone ${id}` }, { language: 'en' }),
  );
  if (hub) devices.push(buildHub(gladys, HUB_KEY, { name: 'Hub' }, { language: 'en' }));
  return devices;
}

export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

export async function setup({
  devices = created(),
  store = memoryStore(),
  now = NOW,
  config = CONFIG,
  world,
  scanResults,
  start = true,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices, scanResults });
  const { clock, timers, advance } = createFakeClock(now);
  const hub = fakeHub(world, { clock });
  let drift = 0;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new NoboApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    createConnection: hub.createConnection,
    now: () => clock.now,
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store,
  });
  registerHandlers(gladys, app, { error: log });
  const wait = async (ms) => {
    await advance(ms);
    await settle();
  };
  /** Awaits a promise while the virtual clock moves (50 ms steps). */
  const act = async (promise, max = 30_000) => {
    let done = false;
    const result = promise.then(
      (value) => ((done = true), { value }),
      (error) => ((done = true), { error }),
    );
    await settle();
    for (let t = 0; !done && t < max; t += 50) {
      await advance(50);
      await settle();
    }
    if (!done) throw new Error('the promise did not settle');
    return result;
  };
  /** A command through the fake Gladys: its ack `{ success, error? }`. */
  const cmd = async (featureId, value) => {
    const device = gladys.devices.find((d) => featureId.startsWith(`${d.external_id}:`)) ?? {
      features: [],
    };
    const feature = device.features.find((f) => f.external_id === featureId) ?? {
      external_id: featureId,
    };
    const { value: ack } = await act(gladys.fake.setValue(device, feature, value));
    return ack;
  };
  if (start) {
    await gladys.connect();
    await wait(0);
    await wait(100);
    // A loaded machine settles promises more slowly: the first session gets a few more turns.
    for (let i = 0; i < 10 && ['connecting', 'syncing'].includes(app.sessionState); i += 1) {
      await settle(100);
    }
  }
  return { app, gladys, clock, store, hub, wait, act, cmd, lines, advance };
}
