// -----------------------------------------------------------------------------
// Commands: the options, the bounds, the confirmation by the hub's answer, the
// queue, and the away mode (protective): never refused by an option, a missing
// session, a full queue; kept in /data; written again 3 times at most.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { HUB_KEY, defaultWorld } from './helpers/fakeHub.js';
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

test('the temperature taken back from the hub is bounded too: out of 7–30 °C, nothing sent', async (t) => {
  const world = defaultWorld();
  world.zones[0].eco = 3;
  world.zones[1].comfort = 45;
  const s = await setup({ config: ALLOW, world });
  t.after(() => s.app.shutdown());
  let ack = await s.cmd(ZF(1, 'comfort-temperature'), 25);
  assert.match(ack.error, /l’autre température de la zone/);
  ack = await s.cmd(ZF(2, 'eco-temperature'), 16);
  assert.match(ack.error, /l’autre température de la zone/);
  assert.equal(written(s, 'U00').length, 0);
  // Setting the wrong one itself works.
  assert.equal((await s.cmd(ZF(1, 'eco-temperature'), 16)).success, true);
  await s.wait(1500);
  assert.equal(
    s.gladys.fake.states.filter(
      (x) => x.device_feature_external_id === ZF(2, 'comfort-temperature'),
    ).length,
    0,
    'never published out of range',
  );
});

test('white box: a command without a ready session never reaches the queue nor pump()', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  s.app.sessionState = 'syncing';
  let pumps = 0;
  const pump = s.app.pump.bind(s.app);
  s.app.pump = () => {
    pumps += 1;
    return pump();
  };
  await assert.rejects(
    s.app.enqueue({ ref: { hubKey: HUB_KEY, target: 1, targetId: 1 }, kind: 'mode', mode: 1 }),
  );
  assert.equal(pumps, 0);
  assert.equal(s.app.queue.length, 0);
});

test('an error message of the hub is shown cut to 80 characters', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  const original = s.hub.createConnection;
  void original;
  s.hub.refuseA03 = true;
  const sock = [...s.hub.open][0];
  const handle = sock.handle.bind(sock);
  sock.handle = (line) =>
    line.startsWith('A03') ? sock.send(`E00 A03 ${'x'.repeat(300)}`) : handle(line);
  const ack = await s.cmd(ZF(1, 'mode'), 'comfort');
  assert.equal(ack.error, `Le hub a refusé la commande (${'x'.repeat(80)}).`);
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
  // A value out of bounds is told as such, session or not.
  for (const value of [6, 31, 21.5]) {
    assert.match(
      (await s.cmd(ZF(1, 'comfort-temperature'), value)).error,
      /un nombre entier de 7 à 30 °C est attendu/,
    );
  }
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
  const world = defaultWorld();
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

test('away without a session: kept in /data, sent right after the download of the next session', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  s.hub.unreachable = true;
  s.hub.dropAll();
  await s.wait(100);
  const ack = await s.cmd(ZF(1, 'mode'), 'away');
  assert.match(ack.error, /Mode absent retenu/);
  assert.equal(s.store.data.pending.length, 1);
  assert.deepEqual(Object.keys(s.store.data.pending[0]).sort(), [
    'afterId',
    'at',
    'hubKey',
    'sends',
    'target',
    'targetId',
  ]);
  s.hub.unreachable = false;
  await s.wait(11 * SECOND);
  const after = s.hub.lines.slice(s.hub.lines.lastIndexOf('HANDSHAKE'));
  assert.deepEqual(after.slice(0, 3), ['HANDSHAKE', 'G00', 'A03 -1 3 3 -1 -1 1 1']);
  assert.deepEqual(s.store.data.pending, []);
});

test('away after a restart: sent from /data at the first session', async (t) => {
  const store = memoryStore({
    pending: [{ hubKey: HUB_KEY, target: 0, targetId: -1, at: NOW - MINUTE, sends: 1 }],
  });
  const s = await setup({ store });
  t.after(() => s.app.shutdown());
  assert.deepEqual(s.hub.lines.slice(0, 4), [
    'HELLO 1.1 102000000123 20261111110000',
    'HANDSHAKE',
    'G00',
    'A03 -1 3 3 -1 -1 0 -1',
  ]);
  assert.deepEqual(store.data.pending, []);
});

test('away in /data: not sent over a newer choice made in the app, nor when already applied', async (t) => {
  const world = defaultWorld();
  // Comfort for 2 hours, set in the app after the away command (id above its afterId).
  world.overrides.push({ id: 12, mode: 1, type: 1, end: '202611111300', target: 1, targetId: 1 });
  world.overrides.push({ id: 13, mode: 3, type: 3, target: 1, targetId: 2 });
  const store = memoryStore({
    pending: [
      { hubKey: HUB_KEY, target: 1, targetId: 1, at: NOW - MINUTE, sends: 1, afterId: 11 },
      { hubKey: HUB_KEY, target: 1, targetId: 2, at: NOW - MINUTE, sends: 1, afterId: 11 },
    ],
  });
  const s = await setup({ store, world });
  t.after(() => s.app.shutdown());
  await s.wait(MINUTE);
  assert.equal(written(s, 'A03').length, 0);
  assert.deepEqual(store.data.pending, []);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode')), 'comfort', 'the dated override is read');
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode-in-force')), 'comfort');
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

test('away without an answer: the session is closed, the away written again on the next, 6 times at most', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  s.hub.silent = true;
  const ack = await s.cmd(ZF(1, 'mode'), 'away');
  assert.match(ack.error, /Mode absent envoyé, sans confirmation/);
  assert.equal(s.store.data.pending.length, 1, 'written is not confirmed');
  await s.wait(SECOND);
  assert.equal(s.hub.connections, 1);
  await s.wait(5 * SECOND);
  assert.equal(s.hub.connections, 2, 'a new session at once (5 s), not a backoff');
  await s.wait(70 * SECOND);
  assert.equal(written(s, 'A03').length, 6, 'each new session at once, never a growing backoff');
  // Those closings were not failures: a later loss of the hub is retried after 5 s.
  const before = s.hub.connections;
  s.hub.dropAll();
  await s.wait(6 * SECOND);
  assert.equal(s.hub.connections, before + 1);
  s.hub.silent = true;
  await s.wait(5 * MINUTE);
  assert.equal(written(s, 'A03').length, 6);
  const connections = s.hub.connections;
  assert.ok(connections <= 8, `${connections} sessions`);
  // Each send in its own session.
  const perSession = s.hub.lines
    .join('\n')
    .split('HANDSHAKE')
    .map((x) => (x.match(/A03/g) ?? []).length);
  assert.ok(
    perSession.every((n) => n <= 1),
    String(perSession),
  );
});

test('a frozen hub: the away closes the session, and is applied once the hub answers again', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  s.hub.frozen = true;
  const ack = await s.cmd(ZF(1, 'mode'), 'away');
  assert.match(ack.error, /sans confirmation/);
  await s.wait(30 * SECOND);
  assert.notEqual(s.app.sessionState, 'ready');
  assert.equal(s.store.data.pending.length, 1);
  s.hub.frozen = false;
  await s.wait(3 * MINUTE);
  assert.equal(s.app.sessionState, 'ready');
  assert.deepEqual(s.store.data.pending, []);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode')), 'away');
});

test('a frozen hub without any command: asked again after 75 s of silence, closed 20 s later', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  s.hub.frozen = true;
  await s.wait(74 * SECOND);
  assert.equal(s.hub.lines.filter((l) => l === 'G00').length, 1);
  await s.wait(2 * SECOND);
  assert.equal(s.hub.lines.filter((l) => l === 'G00').length, 2);
  assert.equal(s.app.sessionState, 'ready');
  await s.wait(21 * SECOND);
  assert.notEqual(s.app.sessionState, 'ready');
  s.hub.frozen = false;
  await s.wait(MINUTE);
  assert.equal(s.app.sessionState, 'ready');
});

test('a live hub answering the probe keeps its session', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  await s.wait(10 * MINUTE);
  assert.equal(s.hub.connections, 1);
  assert.equal(s.app.sessionState, 'ready');
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

test('a newer mode of the target that left after an unconfirmed away: the away is not sent again', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  s.hub.silent = true;
  const away = s.gladys.fake.setValue({}, { external_id: ZF(1, 'mode') }, 'away');
  await settle();
  const comfort = s.gladys.fake.setValue({}, { external_id: ZF(1, 'mode') }, 'comfort');
  await Promise.all([s.act(away), s.act(comfort)]);
  s.hub.silent = false;
  await s.wait(MINUTE);
  assert.equal(written(s, 'A03').filter((l) => l === 'A03 -1 3 3 -1 -1 1 1').length, 1);
  assert.deepEqual(s.store.data.pending, []);
});

test('a temperature of the target does not stop the away resend; another zone neither', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  s.hub.silent = true;
  const away = s.gladys.fake.setValue({}, { external_id: ZF(1, 'mode') }, 'away');
  await settle();
  const setpoint = s.gladys.fake.setValue({}, { external_id: ZF(1, 'comfort-temperature') }, 21);
  const other = s.gladys.fake.setValue({}, { external_id: ZF(2, 'mode') }, 'comfort');
  await Promise.all([s.act(away), s.act(setpoint), s.act(other)]);
  s.hub.silent = false;
  await s.wait(MINUTE);
  assert.equal(written(s, 'A03').filter((l) => l === 'A03 -1 3 3 -1 -1 1 1').length, 2);
  assert.deepEqual(s.store.data.pending, [], 'confirmed on the next session');
});

test('a new mode set from the app (B03 pushed, with an end time) stops the resend of an unconfirmed away', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  s.hub.silent = true;
  const away = s.gladys.fake.setValue({}, { external_id: ZF(1, 'mode') }, 'away');
  await settle();
  s.hub.push('B03 50 1 1 202611111300 -1 1 1');
  await s.act(away);
  s.hub.silent = false;
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

test('I3: a choice made in the app between two sessions, with no override known at the click, is never overwritten', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  assert.equal(s.hub.world.overrides.length, 0, 'the house follows its programme');
  s.hub.silent = true;
  const ack = await s.cmd(ZF(1, 'mode'), 'away');
  assert.match(ack.error, /sans confirmation/);
  assert.equal(s.store.data.pending[0].afterId, -1, 'a complete download without any override');
  // Between the two sessions, comfort for 2 hours from the app.
  s.hub.world.overrides.push({
    id: s.hub.world.nextOverride++,
    mode: 1,
    type: 1,
    end: '202611111300',
    target: 1,
    targetId: 1,
  });
  s.hub.silent = false;
  await s.wait(MINUTE);
  assert.equal(written(s, 'A03').length, 1);
  assert.deepEqual(s.store.data.pending, []);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode')), 'comfort');
});

test('I3: an away made without a complete download (no order known) is still sent over an older override', async (t) => {
  const world = defaultWorld();
  world.overrides.push({ id: 4, mode: 1, type: 3, target: 1, targetId: 1 });
  const store = memoryStore({
    pending: [{ hubKey: HUB_KEY, target: 1, targetId: 1, at: NOW - MINUTE, sends: 1 }],
  });
  const s = await setup({ store, world });
  t.after(() => s.app.shutdown());
  await s.wait(SECOND);
  assert.deepEqual(written(s, 'A03'), ['A03 -1 3 3 -1 -1 1 1']);
  assert.deepEqual(store.data.pending, []);
});

function slowG00(s, { never = false, delay = 0 } = {}) {
  const original = s.hub.createConnection;
  s.app.createConnection = (o) => {
    const sock = original(o);
    const handle = sock.handle.bind(sock);
    sock.handle = (line) => {
      if (line !== 'G00') return handle(line);
      if (never) return sock.send('H00');
      return s.clock.sleep(delay).then(() => handle(line));
    };
    return sock;
  };
}

test('I4: an away from /data leaves within 3 s even when the download never ends', async (t) => {
  const store = memoryStore({
    pending: [{ hubKey: HUB_KEY, target: 1, targetId: 1, at: NOW - MINUTE, sends: 1 }],
  });
  const s = await setup({ store, start: false });
  t.after(() => s.app.shutdown());
  slowG00(s, { never: true });
  await s.gladys.connect();
  await s.wait(2 * SECOND);
  assert.equal(written(s, 'A03').length, 0, 'the download first');
  await s.wait(1100);
  assert.deepEqual(written(s, 'A03'), ['A03 -1 3 3 -1 -1 1 1']);
  assert.deepEqual(store.data.pending, [], 'applied: B03');
});

test('I4: a download that fails at once still lets the waiting away leave before the close', async (t) => {
  const store = memoryStore({
    pending: [{ hubKey: HUB_KEY, target: 1, targetId: 1, at: NOW - MINUTE, sends: 1 }],
  });
  const s = await setup({ store, start: false });
  t.after(() => s.app.shutdown());
  s.app.createConnection = (o) => {
    const sock = s.hub.createConnection(o);
    const handle = sock.handle.bind(sock);
    sock.handle = (line) => (line === 'G00' ? sock.send(`H01 ${'x'.repeat(9000)}`) : handle(line));
    return sock;
  };
  await s.gladys.connect();
  await s.wait(500);
  assert.equal(written(s, 'A03').length, 0, 'a line too long closes the session itself');
  // The retry of the waiting away opens a new session, whose download is slow but ends.
  s.app.createConnection = s.hub.createConnection;
  await s.wait(20 * SECOND);
  assert.ok(written(s, 'A03').length >= 1);
});

test('K2: an away written early (slow download) is not written again in the same session', async (t) => {
  const store = memoryStore({
    pending: [{ hubKey: HUB_KEY, target: 1, targetId: 1, at: NOW - MINUTE, sends: 1 }],
  });
  const s = await setup({ store, start: false });
  t.after(() => s.app.shutdown());
  s.hub.latency = 0;
  // A03 answered late (after the download ends at 3.2 s).
  const original = s.hub.createConnection;
  s.app.createConnection = (o) => {
    const sock = original(o);
    const handle = sock.handle.bind(sock);
    sock.handle = (line) =>
      line === 'G00'
        ? s.clock.sleep(3200).then(() => handle(line))
        : line.startsWith('A03')
          ? s.clock.sleep(1000).then(() => handle(line))
          : handle(line);
    return sock;
  };
  await s.gladys.connect();
  await s.wait(10 * SECOND);
  assert.deepEqual(written(s, 'A03'), ['A03 -1 3 3 -1 -1 1 1']);
  assert.equal(s.hub.connections, 1);
});

test('I5: an away never shown by the hub is given up with a warning and a status that stays', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  s.hub.silent = true;
  await s.cmd(ZF(1, 'mode'), 'away');
  await s.wait(2 * MINUTE);
  assert.equal(written(s, 'A03').length, 6);
  assert.deepEqual(s.store.data.pending, []);
  assert.ok(
    s.lines.some((l) => /Away mode of zone 1 not applied by the hub/.test(l)),
    s.lines.join('\n'),
  );
  const status = s.gladys.fake.connectionStatus;
  assert.equal(status.connected, false);
  assert.match(status.message.fr, /Mode absent de la zone 1 NON appliqué/);
  const from = s.gladys.fake.connectionStatuses.findIndex((x) =>
    /NON appliqué/.test(x.message?.fr ?? ''),
  );
  s.hub.silent = false;
  await s.wait(2 * MINUTE);
  assert.match(s.gladys.fake.connectionStatus.message.fr, /NON appliqué/, 'stays over "connected"');
  assert.ok(
    s.gladys.fake.connectionStatuses
      .slice(from)
      .every((x) => /NON appliqué/.test(x.message?.fr ?? '')),
    'no other status in between',
  );
  // A new away, confirmed: cleared.
  assert.deepEqual(await s.cmd(ZF(1, 'mode'), 'away'), { success: true });
  await s.wait(SECOND);
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
});

test('K3: the 6th send waiting for its answer is not given up before it', async (t) => {
  const s = await setup();
  t.after(() => s.app.shutdown());
  s.hub.silent = true;
  await s.cmd(ZF(1, 'mode'), 'away');
  // Five sends without an answer, then the hub answers the sixth.
  for (let i = 0; i < 120 && written(s, 'A03').length < 5; i += 1) await s.wait(SECOND);
  assert.equal(written(s, 'A03').length, 5);
  s.hub.silent = false;
  await s.wait(MINUTE);
  assert.equal(written(s, 'A03').length, 6);
  assert.ok(!s.lines.some((l) => /given up/.test(l)), 'never told given up');
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode')), 'away');
});

test('K1: an E00 about A03 while another mode command is in flight is not the away refusal', async (t) => {
  const s = await setup({ config: ALLOW });
  t.after(() => s.app.shutdown());
  const sock = [...s.hub.open][0];
  const handle = sock.handle.bind(sock);
  sock.handle = (line) => {
    if (line === 'A03 -1 1 3 -1 -1 1 2')
      return s.clock.sleep(400).then(() => sock.send('E00 A03 Zone does not allow overrides'));
    if (line === 'A03 -1 3 3 -1 -1 1 1') return s.clock.sleep(1000).then(() => handle(line));
    return handle(line);
  };
  const other = s.gladys.fake.setValue({}, { external_id: ZF(2, 'mode') }, 'comfort');
  await settle();
  const away = s.gladys.fake.setValue({}, { external_id: ZF(1, 'mode') }, 'away');
  const [a, b] = (await Promise.all([s.act(other), s.act(away)])).map((r) => r.value);
  assert.match(a.error, /refusé/);
  assert.notEqual(b.error ?? '', '', 'not taken as its own answer…');
  assert.doesNotMatch(b.error, /refusé/);
  await s.wait(MINUTE);
  assert.equal(s.gladys.fake.lastState(ZF(1, 'mode')), 'away', '…and applied later');
});

test('m1: an invalid time zone: the away still leaves, then the session is closed and the status kept', async (t) => {
  const s = await setup({ config: { ...CONFIG, timezone: 'Mars/Olympus' } });
  t.after(() => s.app.shutdown());
  assert.equal(s.hub.connections, 0);
  await s.cmd(ZF(1, 'mode'), 'away');
  await s.wait(5 * SECOND);
  assert.equal(s.hub.open.size, 0, 'the session is closed');
  assert.ok(written(s, 'A03').length >= 1);
  assert.equal(s.hub.lines.filter((l) => l === 'G00').length, 0, 'no download, nothing else');
  assert.notEqual(s.app.sessionState, 'ready');
  assert.match(s.gladys.fake.connectionStatus.message.en, /time zone/);
});

test('#21: an away from /data (no order known) is not sent again over a B03 of the app', async (t) => {
  const store = memoryStore({
    pending: [{ hubKey: HUB_KEY, target: 1, targetId: 1, at: NOW - MINUTE, sends: 1 }],
  });
  const s = await setup({ store, start: false });
  t.after(() => s.app.shutdown());
  s.hub.silent = true;
  await s.gladys.connect();
  await s.wait(500);
  assert.equal(written(s, 'A03').length, 1);
  s.hub.push('B03 50 1 1 202611111300 -1 1 1');
  await s.wait(MINUTE);
  assert.equal(written(s, 'A03').length, 1);
  assert.deepEqual(store.data.pending, []);
});

test('I3: an away clicked during a download takes no order from the partial model', async (t) => {
  const world = defaultWorld();
  world.overrides.push({ id: 4, mode: 1, type: 3, target: 1, targetId: 1 });
  const s = await setup({ world, start: false });
  t.after(() => s.app.shutdown());
  const original = s.hub.createConnection;
  s.app.createConnection = (o) => {
    const sock = original(o);
    const handle = sock.handle.bind(sock);
    sock.handle = (line) => {
      if (line !== 'G00') return handle(line);
      sock.send('H00');
      return s.clock.sleep(2000).then(() => handle(line));
    };
    return sock;
  };
  s.hub.silent = true;
  await s.gladys.connect();
  await s.wait(200);
  assert.equal(s.app.sessionState, 'syncing');
  const away = s.gladys.fake.setValue({}, { external_id: ZF(1, 'mode') }, 'away');
  await s.act(away);
  assert.equal(
    s.store.data.pending.length,
    1,
    'the older override (id 4) listed later does not drop it',
  );
  s.hub.silent = false;
  await s.wait(MINUTE);
  assert.ok(written(s, 'A03').length >= 2);
  assert.deepEqual(s.store.data.pending, []);
});

test('I4: an away from /data keeps its 10 s retry while sessions fail, whatever the backoff', async (t) => {
  const store = memoryStore({
    pending: [{ hubKey: HUB_KEY, target: 1, targetId: 1, at: NOW - MINUTE, sends: 1 }],
  });
  const s = await setup({ store, start: false });
  t.after(() => s.app.shutdown());
  let bad = 3;
  s.app.createConnection = (o) => {
    const sock = s.hub.createConnection(o);
    const handle = sock.handle.bind(sock);
    sock.handle = (line) =>
      line === 'G00' && bad > 0 ? ((bad -= 1), sock.send(`H01 ${'x'.repeat(9000)}`)) : handle(line);
    return sock;
  };
  await s.gladys.connect();
  await s.wait(29 * SECOND);
  assert.equal(written(s, 'A03').length, 1, `sessions: ${s.hub.connections}`);
});
