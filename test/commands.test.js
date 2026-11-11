// -----------------------------------------------------------------------------
// Commands: the options, the bounds, the confirmation by the hub's answer, the
// queue, and the away mode (protective): never refused by an option, a missing
// session, a full queue; kept in /data; written again 3 times at most.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { HUB_KEY } from './helpers/fakeHub.js';
import { ADDRESS, CONFIG, HF, MINUTE, NOW, SECOND, ZF, settle, setup } from './helpers/app.js';

const ALLOW = { ...CONFIG, allow_modes: true, allow_setpoints: true };
const written = (s, prefix) => s.hub.lines.filter((l) => l.startsWith(prefix));

test('off by default: modes and temperatures refused, nothing sent', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  for (const [id, value] of [
    [ZF(1, 'mode'), 'comfort'],
    [ZF(1, 'mode'), 'eco'],
    [ZF(1, 'mode'), 'schedule'],
    [HF('mode'), 'comfort'],
    [ZF(1, 'comfort-temperature'), 23],
    [ZF(1, 'eco-temperature'), 16],
  ]) {
    const ack = await s.cmd(id, value);
    assert.equal(ack.success, false, `${id} ${value}`);
    assert.match(ack.error, /désactivées/);
  }
  assert.equal(written(s, 'A03').length + written(s, 'U00').length, 0);
});

test('read-only features and unknown values are refused', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  for (const [id, value] of [
    [ZF(1, 'mode-in-force'), 'eco'],
    [ZF(1, 'temperature'), 20],
    [ZF(1, 'mode'), 'off'],
    [ZF(1, 'mode'), 2],
    [HF('comfort-temperature'), 20],
    ['ext:nobo:zone:102000000-1:switch', 1],
  ]) {
    assert.equal((await s.cmd(id, value)).success, false, `${id} ${value}`);
  }
  assert.equal(written(s, 'A03').length, 0);
});

test('mode allowed: a constant override of the zone, confirmed by B03', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  assert.deepEqual(await s.cmd(ZF(1, 'mode'), 'eco'), { success: true });
  assert.deepEqual(written(s, 'A03'), ['A03 -1 2 3 -1 -1 1 1']);
  await s.wait(1500);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode')), 'eco');
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode-in-force')), 'eco');
  assert.deepEqual(await s.cmd(ZF(1, 'mode'), 'schedule'), { success: true });
  assert.deepEqual(written(s, 'A03').at(-1), 'A03 -1 0 3 -1 -1 1 1');
  await s.wait(1500);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode')), 'schedule');
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode-in-force')), 'comfort');
  assert.deepEqual(await s.cmd(HF('mode'), 'comfort'), { success: true });
  assert.deepEqual(written(s, 'A03').at(-1), 'A03 -1 1 3 -1 -1 0 -1');
});

test('temperature allowed: U00 with the zone as read, confirmed by V00', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  assert.deepEqual(await s.cmd(ZF(1, 'comfort-temperature'), 23), { success: true });
  assert.deepEqual(written(s, 'U00'), ['U00 1 Living room 1 23 17 1 -1']);
  assert.deepEqual(await s.cmd(ZF(1, 'eco-temperature'), 16), { success: true });
  assert.deepEqual(written(s, 'U00').at(-1), 'U00 1 Living room 1 23 16 1 -1');
  await s.wait(1500);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'comfort-temperature')), 23);
});

test('temperature bounds: whole numbers 7 to 30, comfort never below eco', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  for (const value of [6, 31, 21.5, '', '22a', NaN, -1, 1e9]) {
    const ack = await s.cmd(ZF(1, 'comfort-temperature'), value);
    assert.equal(ack.success, false, String(value));
    assert.match(ack.error, /entier de 7 à 30/);
  }
  const below = await s.cmd(ZF(1, 'comfort-temperature'), 16);
  assert.match(below.error, /confort ne peut pas être sous/);
  const above = await s.cmd(ZF(1, 'eco-temperature'), 23);
  assert.match(above.error, /confort ne peut pas être sous/);
  assert.equal(written(s, 'U00').length, 0);
  assert.equal((await s.cmd(ZF(1, 'comfort-temperature'), 7)).success, false, 'below eco 17');
  assert.equal((await s.cmd(ZF(1, 'eco-temperature'), 7)).success, true);
  assert.equal((await s.cmd(ZF(1, 'comfort-temperature'), 30)).success, true);
});

test('answers: none = sent without confirmation; E00 = refused; other values = not applied', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  s.hub.silent = true;
  let ack = await s.cmd(ZF(1, 'comfort-temperature'), 23);
  assert.match(ack.error, /Envoyée, sans confirmation/);
  s.hub.silent = false;
  s.hub.ignoreU00 = true;
  ack = await s.cmd(ZF(1, 'comfort-temperature'), 24);
  assert.match(ack.error, /pas appliquée/);
  s.hub.ignoreU00 = false;
  s.hub.refuseA03 = true;
  ack = await s.cmd(ZF(2, 'mode'), 'comfort');
  assert.equal(ack.error, 'Le hub a refusé la commande (Zone does not allow overrides).');
  ack = await s.cmd(ZF(9, 'mode'), 'comfort');
  assert.match(ack.error, /ne connaît pas cette zone/);
});

test('without a downloaded session: nothing sent (but away)', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  s.hub.unreachable = true;
  s.hub.dropAll();
  await s.wait(100);
  const ack = await s.cmd(ZF(1, 'mode'), 'comfort');
  assert.match(ack.error, /Rien envoyé : le hub n’est pas connecté/);
  // An option off is told as such, session or not.
  await s.app.configUpdated(CONFIG);
  assert.match((await s.cmd(ZF(1, 'mode'), 'comfort')).error, /commandes de mode sont désactivées/);
  assert.match((await s.cmd(ZF(1, 'eco-temperature'), 16)).error, /température sont désactivées/);
});

test('the option unticked while a command waits: refused just before the first byte', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  s.hub.latency = 1000;
  const first = s.gladys.fake.setValue({}, { external_id: ZF(1, 'comfort-temperature') }, 23);
  const second = s.gladys.fake.setValue({}, { external_id: ZF(2, 'comfort-temperature') }, 22);
  await settle();
  await s.app.configUpdated({ ...ALLOW, allow_setpoints: false });
  const [a, b] = (await Promise.all([s.act(first), s.act(second)])).map((r) => r.value);
  assert.equal(a.success, true);
  assert.match(b.error, /désactivées/);
  assert.equal(written(s, 'U00').length, 1);
});

test('a command that cannot leave by 3 s is refused unsent', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  s.hub.latency = 1600;
  const acks = await Promise.all(
    [1, 2, 1].map((id, i) =>
      s.act(
        s.gladys.fake.setValue(
          {},
          { external_id: ZF(id, i === 2 ? 'eco-temperature' : 'comfort-temperature') },
          20 - i,
        ),
      ),
    ),
  );
  assert.equal(acks[0].value.success, true);
  assert.equal(acks[1].value.success, true);
  assert.match(acks[2].value.error, /occupé trop longtemps/);
  assert.equal(written(s, 'U00').length, 2);
});

test('a scene on 5 slow zones: the 5 set, one at a time', async (t) => {
  const world = (await import('./helpers/fakeHub.js')).defaultWorld();
  for (let id = 3; id <= 5; id += 1) {
    world.zones.push({ id, name: `Room${id}`, profileId: 1, comfort: 21, eco: 16, allow: 1 });
  }
  const s = await setup({ config: ALLOW, world });
  t.after(() => s.app.shutdown());
  s.hub.latency = 600;
  const acks = await Promise.all(
    [1, 2, 3, 4, 5].map((id) =>
      s.act(s.gladys.fake.setValue({}, { external_id: ZF(id, 'comfort-temperature') }, 25)),
    ),
  );
  assert.deepEqual(
    acks.map((a) => a.value.success),
    [true, true, true, true, true],
  );
  assert.equal(written(s, 'U00').length, 5);
});

test('away: never refused by the option; a constant override in away mode, confirmed', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  assert.deepEqual(await s.cmd(ZF(1, 'mode'), 'away'), { success: true });
  assert.deepEqual(written(s, 'A03'), ['A03 -1 3 3 -1 -1 1 1']);
  assert.deepEqual(s.store.data.pending, [], 'confirmed: nothing kept');
  assert.deepEqual(await s.cmd(HF('mode'), 'away'), { success: true });
  assert.deepEqual(written(s, 'A03').at(-1), 'A03 -1 3 3 -1 -1 0 -1');
  await s.wait(1500);
  assert.equal(
    s.gladys.fake.lastState(ZF(2, 'mode-in-force')),
    'comfort',
    'office does not allow overrides',
  );
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode-in-force')), 'away');
});

test('away without a session: kept in /data, sent right after the handshake, before G00', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  s.hub.unreachable = true;
  s.hub.dropAll();
  await s.wait(100);
  const ack = await s.cmd(ZF(1, 'mode'), 'away');
  assert.match(ack.error, /Mode absent retenu/);
  assert.equal(s.store.data.pending.length, 1);
  assert.deepEqual(Object.keys(s.store.data.pending[0]).sort(), [
    'at',
    'hubKey',
    'sends',
    'target',
    'targetId',
  ]);
  s.hub.unreachable = false;
  await s.wait(11 * SECOND);
  const after = s.hub.lines.slice(s.hub.lines.lastIndexOf('HANDSHAKE'));
  assert.deepEqual(after.slice(0, 3), ['HANDSHAKE', 'A03 -1 3 3 -1 -1 1 1', 'G00']);
  assert.deepEqual(s.store.data.pending, []);
});

test('away after a restart: sent from /data at the first session, even before the config was read twice', async (t) => {
  const store = memoryStore({
    pending: [{ hubKey: HUB_KEY, target: 0, targetId: -1, at: NOW - MINUTE, sends: 1 }],
  });
  const s = await setup({ store });
  t.after(() => s.app.shutdown());
  assert.deepEqual(s.hub.lines.slice(0, 4), [
    'HELLO 1.1 102000000123 20261111110000',
    'HANDSHAKE',
    'A03 -1 3 3 -1 -1 0 -1',
    'G00',
  ]);
  assert.deepEqual(store.data.pending, []);
});

test('an away of 20 min ago, or dated in the future, is not replayed', async (t) => {
  const store = memoryStore({
    pending: [
      { hubKey: HUB_KEY, target: 1, targetId: 1, at: NOW - 20 * MINUTE, sends: 0 },
      { hubKey: HUB_KEY, target: 1, targetId: 2, at: NOW + MINUTE, sends: 0 },
    ],
  });
  const s = await setup({ store });
  t.after(() => s.app.shutdown());
  assert.equal(written(s, 'A03').length, 0);
});

test('away unconfirmed: written again every 10 s, 3 times at most', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  s.hub.silent = true;
  const ack = await s.cmd(ZF(1, 'mode'), 'away');
  assert.match(ack.error, /Mode absent retenu/);
  await s.wait(5 * MINUTE);
  assert.equal(written(s, 'A03').length, 3);
});

test('away goes before the waiting commands and drops those of its target', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  s.hub.latency = 1000;
  const first = s.gladys.fake.setValue({}, { external_id: ZF(2, 'comfort-temperature') }, 23);
  const waiting = s.gladys.fake.setValue({}, { external_id: ZF(1, 'comfort-temperature') }, 24);
  const other = s.gladys.fake.setValue({}, { external_id: ZF(2, 'eco-temperature') }, 15);
  await settle();
  const away = s.gladys.fake.setValue({}, { external_id: ZF(1, 'mode') }, 'away');
  const acks = (await Promise.all([first, waiting, other, away].map((p) => s.act(p)))).map(
    (r) => r.value,
  );
  assert.equal(acks[0].success, true);
  assert.match(acks[1].error, /une commande « absent » est arrivée après/);
  assert.equal(acks[2].success, true);
  assert.equal(acks[3].success, true);
  const order = s.hub.lines.filter((l) => /^(A03|U00)/.test(l));
  assert.deepEqual(order, [
    'U00 2 Office 1 23 16 0 -1',
    'A03 -1 3 3 -1 -1 1 1',
    'U00 2 Office 1 23 15 0 -1',
  ]);
});

test('the whole-house away drops every waiting command of the hub', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  s.hub.latency = 1000;
  const first = s.gladys.fake.setValue({}, { external_id: ZF(2, 'comfort-temperature') }, 23);
  const waiting = s.gladys.fake.setValue({}, { external_id: ZF(1, 'mode') }, 'comfort');
  await settle();
  const away = s.gladys.fake.setValue({}, { external_id: HF('mode') }, 'away');
  const acks = (await Promise.all([first, waiting, away].map((p) => s.act(p)))).map((r) => r.value);
  assert.match(acks[1].error, /« absent »/);
  assert.equal(acks[2].success, true);
  assert.equal(written(s, 'A03').length, 1);
});

test('a newer command of the target sent after an unconfirmed away: the away is not written again', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  s.hub.silent = true;
  await s.cmd(ZF(1, 'mode'), 'away');
  s.hub.silent = false;
  assert.deepEqual(await s.cmd(ZF(1, 'mode'), 'comfort'), { success: true });
  await s.wait(MINUTE);
  assert.deepEqual(written(s, 'A03'), ['A03 -1 3 3 -1 -1 1 1', 'A03 -1 1 3 -1 -1 1 1']);
  // But a command of another zone does not cancel it.
  s.hub.silent = true;
  await s.cmd(ZF(1, 'mode'), 'away');
  s.hub.silent = false;
  await s.cmd(ZF(2, 'mode'), 'comfort');
  await s.wait(11 * SECOND);
  assert.equal(written(s, 'A03').filter((l) => l === 'A03 -1 3 3 -1 -1 1 1').length, 3);
});

test('a newer command of the target that left without an answer also stops the away resend', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  s.hub.silent = true;
  await s.cmd(ZF(1, 'mode'), 'away');
  const ack = await s.cmd(ZF(1, 'mode'), 'comfort');
  assert.match(ack.error, /sans confirmation/);
  await s.wait(MINUTE);
  assert.equal(written(s, 'A03').filter((l) => l === 'A03 -1 3 3 -1 -1 1 1').length, 1);
});

test('a new mode set from the app (B03 pushed) stops the resend of an unconfirmed away', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  s.hub.silent = true;
  await s.cmd(ZF(1, 'mode'), 'away');
  s.hub.push('B03 50 1 3 -1 -1 1 1');
  await s.wait(MINUTE);
  assert.equal(written(s, 'A03').length, 1);
});

test('away with /data unreadable or read-only still leaves; nothing written over an unreadable file', async (t) => {
  const store = memoryStore({
    salt: 'a'.repeat(32),
    refusal: null,
    pending: [],
    lastAttemptAt: null,
    marker: 1,
  });
  store.unreadable = true;
  const s = await setup({ store });
  t.after(() => s.app.shutdown());
  assert.deepEqual(await s.cmd(ZF(1, 'mode'), 'away'), { success: true });
  assert.equal(store.saves, 0, 'never written over');
  assert.equal(store.data.marker, 1);
  store.unreadable = false;
  store.fail = true;
  await s.wait(11 * SECOND);
  assert.deepEqual(await s.cmd(ZF(2, 'mode'), 'away'), { success: true });
  assert.equal(written(s, 'A03').length, 2);
});

test('away while a command is in flight: written after its answer or 250 ms', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  s.hub.silent = true;
  const slow = s.gladys.fake.setValue({}, { external_id: ZF(2, 'comfort-temperature') }, 23);
  await settle();
  const started = s.clock.now;
  s.hub.silent = false;
  s.hub.latency = 0;
  const away = s.gladys.fake.setValue({}, { external_id: ZF(1, 'mode') }, 'away');
  await settle();
  await s.advance(200);
  await settle();
  assert.equal(written(s, 'A03').length, 0);
  await s.advance(100);
  await settle();
  assert.equal(written(s, 'A03').length, 1);
  assert.ok(s.clock.now - started < 400);
  await Promise.all([s.act(slow), s.act(away)]);
});

test('commands to another hub are refused (away is kept for it, never sent here)', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  const ack = await s.cmd('ext:nobo:zone:999999999-1:mode', 'comfort');
  assert.match(ack.error, /un autre hub/);
  await s.cmd('ext:nobo:zone:999999999-1:mode', 'away');
  await s.wait(MINUTE);
  assert.equal(written(s, 'A03').length, 0);
  void ADDRESS;
});

test('away pending while the hub stays down: tries spaced 10 s, given up after 15 min', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  s.hub.unreachable = true;
  s.hub.dropAll();
  await s.wait(100);
  await s.cmd(ZF(1, 'mode'), 'away');
  const at = s.hub.connections;
  await s.wait(16 * MINUTE);
  const during = s.hub.connections - at;
  assert.ok(during <= 16 * 6 + 2, `${during} connections in 16 min`);
  assert.deepEqual(s.store.data.pending, [], 'given up after 15 min');
  const after = s.hub.connections;
  await s.wait(10 * MINUTE);
  assert.ok(s.hub.connections - after <= 3, 'back to the backoff (5 min at most)');
});
