// -----------------------------------------------------------------------------
// The session with the hub, end to end through the SDK wiring: handshake,
// download, publication, discovery, refusal, reconnection, configuration and
// /data failures.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { HUB_KEY, SERIAL } from './helpers/fakeHub.js';
import {
  ADDRESS,
  CONFIG,
  HF,
  MINUTE,
  NOW,
  SECOND,
  ZF,
  ZONE,
  created,
  settle,
  setup,
} from './helpers/app.js';

const states = (gladys, id) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === id);
const everything = (t) =>
  JSON.stringify([
    t.lines,
    t.gladys.fake.connectionStatuses,
    t.store.data,
    t.gladys.fake.states,
    t.gladys.fake.discoveredDevices,
  ]);

test('handshake with the serial and the local time, G00, then zones and states published', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  assert.deepEqual(s.hub.lines, ['HELLO 1.1 102000000123 20261111110000', 'HANDSHAKE', 'G00']);
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
  const discovered = s.gladys.fake.discoveredDevices;
  assert.deepEqual(
    discovered.map((d) => d.external_id),
    [`ext:nobo:hub:${HUB_KEY}`, ZONE(1), ZONE(2)],
  );
  await s.wait(1500);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'temperature')), 21.125);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'comfort-temperature')), 22);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'eco-temperature')), 17);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode')), 'schedule');
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode-in-force')), 'comfort');
  assert.equal(s.gladys.fake.lastState(HF('mode')), 'schedule');
  // Office: no sensor heard, no temperature (never 0).
  assert.equal(states(s.gladys, ZF(2, 'temperature')).length, 0);
});

test('pushes of the hub update the states; the mode in force follows the clock', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  await s.wait(1500);
  s.hub.push('Y02 234000012006 19.5');
  await s.wait(1500);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'temperature')), 19.5);
  s.hub.push('Y02 234000012006 N/A');
  await s.wait(1500);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'temperature')), 19.5, 'N/A publishes nothing');
  // 22:00 in Oslo (21:00 UTC): eco.
  await s.wait(11 * 60 * MINUTE);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode-in-force')), 'eco');
});

test('a device not created gets no state; a device created then gets the live ones', async (t) => {
  const s = await setup({ devices: created([2], { hub: false }) });
  t.after(() => s.app.shutdown());
  await s.wait(1500);
  assert.equal(states(s.gladys, ZF(1, 'comfort-temperature')).length, 0);
  assert.equal(states(s.gladys, ZF(2, 'comfort-temperature')).length, 1);
});

test('no address: the hub announcing the first 9 digits is found by the mediated scan', async (t) => {
  const payload = (text) => Buffer.from(text, 'latin1').toString('base64');
  const s = await setup({
    config: { serial: SERIAL },
    scanResults: {
      'udp-broadcast': [
        {
          source_ip: '192.168.1.60',
          source_port: 1,
          payload_base64: payload('__NOBOHUB__999999999'),
        },
        {
          source_ip: '255.255.255.255',
          source_port: 1,
          payload_base64: payload(`__NOBOHUB__${HUB_KEY}`),
        },
        {
          source_ip: '192.168.1.61',
          source_port: 1,
          payload_base64: payload(`__NOBOHUB__${HUB_KEY}`),
        },
      ],
    },
  });
  t.after(() => s.app.shutdown());
  assert.equal(s.gladys.fake.scans.length, 1);
  assert.deepEqual(s.hub.hosts, ['192.168.1.61'], 'never another hub, never a broadcast address');
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
});

test('no hub heard: a clear status, new tries spaced 5 s, 10 s, 20 s…', async (t) => {
  const s = await setup({ config: { serial: SERIAL }, scanResults: { 'udp-broadcast': [] } });
  t.after(() => s.app.shutdown());
  assert.match(s.gladys.fake.connectionStatus.message.en, /No hub with this serial number heard/);
  assert.equal(s.gladys.fake.scans.length, 1);
  await s.wait(4 * SECOND);
  assert.equal(s.gladys.fake.scans.length, 1, 'never sooner than 5 s');
  await s.wait(1100);
  assert.equal(s.gladys.fake.scans.length, 2);
  await s.wait(9 * SECOND);
  assert.equal(s.gladys.fake.scans.length, 2);
  await s.wait(1100);
  assert.equal(s.gladys.fake.scans.length, 3);
});

test('a refused serial: status, kept in /data as an 8-bit mark, never sent again by itself', async (t) => {
  const store = memoryStore();
  const s = await setup({ store, config: { serial: '102000000999', host: ADDRESS } });
  t.after(() => s.app.shutdown());
  assert.match(s.gladys.fake.connectionStatus.message.en, /refused this serial/);
  assert.equal(store.data.refusal.hubKey, HUB_KEY);
  assert.match(store.data.refusal.mark, /^[0-9a-f]{2}$/);
  assert.doesNotMatch(JSON.stringify(store.data), /102000000999/);
  assert.doesNotMatch(everything(s), /102000000999/, 'nor in the logs and statuses');
  await s.wait(30 * MINUTE);
  assert.equal(s.hub.connections, 1, 'no new try by itself');
  // A restart with the same serial: still refused, nothing sent.
  const again = await setup({ store, config: { serial: '102000000999', host: ADDRESS } });
  t.after(() => again.app.shutdown());
  assert.equal(again.hub.connections, 0);
  assert.match(again.gladys.fake.connectionStatus.message.en, /refused this serial/);
  // A new serial is always tried.
  await again.gladys.fake.configUpdated?.({ serial: SERIAL, host: ADDRESS });
  if (!again.gladys.fake.configUpdated)
    await again.app.configUpdated({ serial: SERIAL, host: ADDRESS });
  await again.wait(6 * SECOND);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.refusal, null, 'lifted by the success');
});

test('the button lifts a refusal with one new try', async (t) => {
  const s = await setup({ config: { serial: '102000000999', host: ADDRESS } });
  t.after(() => s.app.shutdown());
  s.hub.world.serial = '102000000999';
  const ack = await s.act(s.gladys.fake.action('test_connection', {}));
  assert.ok(ack.value.success);
  await s.wait(SECOND);
  assert.equal(s.hub.connections, 2);
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
});

test('a closed session opens again after 5 s; nothing stale published meanwhile', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  await s.wait(1500);
  const before = s.gladys.fake.states.length;
  s.hub.unreachable = true;
  s.hub.dropAll();
  await s.wait(SECOND);
  assert.match(s.gladys.fake.connectionStatus.message.en, /does not answer/);
  await s.wait(3 * SECOND);
  assert.equal(s.hub.connections, 1, 'not sooner than 5 s');
  await s.wait(60 * SECOND);
  assert.equal(s.gladys.fake.states.length, before, 'no state without a session');
  s.hub.unreachable = false;
  await s.wait(2 * MINUTE);
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
  assert.equal(s.hub.lines.filter((l) => l === 'G00').length, 2, 'downloaded again (§5.7)');
});

test('a restart never connects sooner than 5 s after the last attempt', async (t) => {
  const store = memoryStore({ lastAttemptAt: NOW - 2 * SECOND });
  const s = await setup({ store });
  t.after(() => s.app.shutdown());
  assert.equal(s.hub.connections, 0);
  await s.wait(3 * SECOND);
  assert.equal(s.hub.connections, 1);
});

test('getConfig() failing in connected: retried, spaced, with a status, then the start', async (t) => {
  const s = await setup({ start: false });
  t.after(() => s.app.shutdown());
  let calls = 0;
  const getConfig = async () => {
    calls += 1;
    if (calls === 1) throw new Error('Gladys busy');
    return CONFIG;
  };
  await s.app.onConnected(getConfig);
  assert.match(s.gladys.fake.connectionStatus.message.en, /configuration could not be read/);
  await s.wait(4 * SECOND);
  assert.equal(calls, 1);
  await s.wait(1500);
  assert.equal(calls, 2);
  await s.wait(SECOND);
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
});

test('Gladys comes back with the same configuration: the session stays, the states are sent again', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  await s.wait(1500);
  const count = states(s.gladys, ZF(1, 'comfort-temperature')).length;
  await s.app.onConnected(async () => CONFIG);
  await s.wait(1500);
  assert.equal(s.hub.connections, 1);
  assert.equal(states(s.gladys, ZF(1, 'comfort-temperature')).length, count + 1);
});

test('a line longer than 8 KB closes the session', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  s.hub.push(`H01 ${'x'.repeat(9000)}`);
  await settle();
  assert.equal(s.app.sessionState, 'idle');
  const half = 'y'.repeat(9000);
  await s.wait(6 * SECOND);
  assert.equal(s.app.sessionState, 'ready');
  // Without any line end either.
  for (const sock of s.hub.open) sock.emit('data', Buffer.from(half));
  await settle();
  assert.equal(s.app.sessionState, 'idle');
});

test('a hub that never ends G00 is closed after 20 s and opened again', async (t) => {
  const s = await setup({ start: false });
  t.after(() => s.app.shutdown());
  const original = s.hub.createConnection;
  s.app.createConnection = (o) => {
    const sock = original(o);
    const handle = sock.handle.bind(sock);
    sock.handle = (line) =>
      line === 'G00' ? sock.send('H00', 'H01 1 Stue 1 22 17 1 -1') : handle(line);
    return sock;
  };
  await s.gladys.connect();
  await s.wait(10 * SECOND);
  await s.app.deviceCreated();
  await s.app.onConnected(async () => CONFIG);
  await s.wait(9 * SECOND);
  assert.equal(s.app.sessionState, 'syncing');
  await s.wait(2 * SECOND);
  assert.equal(s.app.sessionState, 'idle');
  assert.equal(s.gladys.fake.states.length, 0, 'an incomplete download publishes nothing');
});

test('keepalive 14 s after our last line, whatever it was', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  await s.wait(10 * SECOND);
  await s.cmd(ZF(1, 'mode'), 'away');
  await s.wait(13 * SECOND);
  assert.equal(
    s.hub.lines.filter((l) => l === 'KEEPALIVE').length,
    0,
    'not 14 s after the handshake',
  );
  await s.wait(2 * SECOND);
  assert.equal(s.hub.lines.filter((l) => l === 'KEEPALIVE').length, 1);
});

test('keepalive after 14 s without a line from us', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  await s.wait(13 * SECOND);
  assert.equal(s.hub.lines.filter((l) => l === 'KEEPALIVE').length, 0);
  await s.wait(2 * SECOND);
  assert.equal(s.hub.lines.filter((l) => l === 'KEEPALIVE').length, 1);
  await s.wait(14 * SECOND);
  assert.equal(s.hub.lines.filter((l) => l === 'KEEPALIVE').length, 2);
});

test('the serial never reaches the logs, the statuses, /data, the states nor the devices', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  await s.cmd(ZF(1, 'mode'), 'away');
  s.hub.dropAll();
  await s.wait(10 * SECOND);
  assert.doesNotMatch(everything(s), new RegExp(SERIAL));
});

test('the language: English names when asked', async (t) => {
  const s = await setup({ devices: [], config: { ...CONFIG, language: 'en' } });
  t.after(() => s.app.shutdown());
  const zone = s.gladys.fake.discoveredDevices.find((d) => d.external_id === ZONE(1));
  assert.equal(zone.name, 'Living room (Nobø)');
  assert.deepEqual(
    zone.features.map((f) => f.name),
    ['Temperature', 'Comfort temperature', 'Eco temperature', 'Mode', 'Mode in force'],
  );
});
