// -----------------------------------------------------------------------------
// The text protocol and the model, against the examples of the document.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addOverride,
  displayName,
  int,
  localParts,
  localStamp,
  parseLine,
  parseProfile,
  profileStatusAt,
  updateZone,
} from '../src/nobo/protocol.js';
import { HubModel, overrideLive } from '../src/nobo/model.js';
import { normalizeConfig, serialMark, unicastAddress } from '../src/config.js';
import { normalizeMemory } from '../src/store.js';
import { PROFILE } from './helpers/fakeHub.js';

test('the examples of the document are read', () => {
  assert.deepEqual(parseLine('H01 2 ZoneName 1 23 15 0 -1').zone, {
    id: 2,
    rawName: 'ZoneName',
    name: 'ZoneName',
    profileId: 1,
    comfort: 23,
    eco: 15,
    allowOverrides: 0,
  });
  assert.deepEqual(parseLine('H02 200154035201 0 component_name 0 -1 23 2').component, {
    serial: '200154035201',
    name: 'component_name',
    zoneId: -1,
    sensorFor: 2,
  });
  assert.equal(parseLine('Y02 234000012006 24.125').value, 24.125);
  assert.equal(parseLine('Y02 234000012006 N/A').value, null, 'N/A is unknown, never 0');
  assert.equal(parseLine('Y02 234000012006 ').value, null);
  assert.deepEqual(parseLine('H04 1 2 0 -1 -1 0 1').override.mode, 2);
  assert.equal(
    parseLine('H05 200045185039 name_of_hub 13 23 1.2 1f 20130813').hub.serial,
    '200045185039',
  );
  assert.deepEqual(parseLine('E00 U06 Wrong number of/format of arguments'), {
    kind: 'error',
    about: 'U06',
    message: 'Wrong number of/format of arguments',
  });
  assert.equal(parseLine('REJECT 1').code, 1);
  // Extra trailing arguments are allowed (§8); unknown commands ignored.
  assert.equal(parseLine('H01 2 Z 1 23 15 0 -1 extra 7').zone.id, 2);
  assert.equal(parseLine('Y09 whatever').kind, 'unknown');
});

test('dated overrides (12-digit times) are read; an unreadable time is unknown, the line kept', () => {
  assert.deepEqual(parseLine('H04 5 1 2 202611111800 202611111600 1 1').override, {
    id: 5,
    mode: 1,
    type: 2,
    end: '202611111800',
    start: '202611111600',
    target: 1,
    targetId: 1,
  });
  const timer = parseLine('B03 9 1 1 202611111800 -1 1 1').override;
  assert.equal(timer.end, '202611111800');
  assert.equal(timer.start, -1);
  const odd = parseLine('H04 6 1 2 soon later 1 1').override;
  assert.equal(odd.start, null);
  assert.equal(overrideLive(odd, '20261111120000'), undefined);
  assert.equal(parseLine('H04 x 1 2 -1 -1 1 1'), undefined);
});

test('a known command with unreadable fields changes nothing', () => {
  assert.equal(
    parseLine('H01 2 ZoneName 1 23.5 15 0 -1'),
    undefined,
    'a decimal is not an integer',
  );
  assert.equal(parseLine('H01 x ZoneName 1 23 15 0 -1'), undefined);
  assert.equal(parseLine('H01 2 ZoneName 1  15 0 -1'), undefined, 'empty is unknown, not 0');
  assert.equal(parseLine('H02 12345 0 c 0 -1 -1 2'), undefined, 'a serial has 12 digits');
  assert.equal(parseLine('H04 1 2 0 -1 -1 0'), undefined);
  assert.equal(int(''), undefined);
  assert.equal(int('1.5'), undefined);
  assert.equal(int('-1'), -1);
});

test('names: non-breaking spaces shown as spaces, sent back as received', () => {
  const zone = parseLine('H01 3 Living room 1 22 17 1 -1').zone;
  assert.equal(zone.name, 'Living room');
  assert.equal(updateZone(zone, { comfort: 23, eco: 16 }), 'U00 3 Living room 1 23 16 1 -1');
  assert.equal(displayName('A\u0007B\u0085C'), 'ABC');
  assert.equal([...displayName('x'.repeat(500))].length, 60);
  assert.equal(addOverride({ mode: 3, type: 3, target: 1, targetId: 3 }), 'A03 -1 3 3 -1 -1 1 3');
});

test('week profiles: 7 days from 0000, the status at a local time', () => {
  const slots = parseProfile(PROFILE);
  assert.equal(slots.length, 7);
  assert.equal(profileStatusAt(slots, { weekday: 2, hour: 5, minute: 59 }), 0);
  assert.equal(profileStatusAt(slots, { weekday: 2, hour: 6, minute: 0 }), 1);
  assert.equal(profileStatusAt(slots, { weekday: 6, hour: 22, minute: 0 }), 0);
  // The example of the document: 7 days (four with one slot), 02:15 status 4 (off).
  const example = parseProfile('00000,02154,13453,00001,08000,16301,00000,00001,00001,00002,00002');
  assert.deepEqual(
    example.map((d) => d.length),
    [3, 3, 1, 1, 1, 1, 1],
  );
  assert.equal(profileStatusAt(example, { weekday: 0, hour: 3, minute: 0 }), 4);
  assert.equal(parseProfile('00000,06001'), null, 'one day only');
  assert.equal(parseProfile(PROFILE.replace('06001', '06009')), null, 'unknown status');
  assert.equal(parseProfile(PROFILE.replace('22000', '05000')), null, 'times out of order');
  assert.equal(profileStatusAt(null, { weekday: 0, hour: 1, minute: 0 }), undefined);
});

test('local time: Oslo in winter and summer, across the change of hour', () => {
  // 2026-11-11 is a Wednesday.
  assert.deepEqual(localParts(Date.UTC(2026, 10, 11, 23, 30), 'Europe/Oslo'), {
    year: 2026,
    month: 11,
    day: 12,
    hour: 0,
    minute: 30,
    second: 0,
    weekday: 3,
  });
  assert.equal(localStamp(Date.UTC(2026, 6, 1, 22, 0, 5), 'Europe/Oslo'), '20260702000005');
  // 2026-03-29 01:00 UTC: Oslo goes from 02:00 to 03:00.
  assert.equal(localStamp(Date.UTC(2026, 2, 29, 0, 59, 59), 'Europe/Oslo'), '20260329015959');
  assert.equal(localStamp(Date.UTC(2026, 2, 29, 1, 0, 0), 'Europe/Oslo'), '20260329030000');
  // West of UTC at midnight.
  assert.equal(localParts(Date.UTC(2026, 10, 11, 4, 0), 'America/New_York').weekday, 1);
  assert.equal(localParts(Date.UTC(2026, 10, 11, 4, 0), 'America/New_York').hour, 23);
  assert.equal(localParts(0, 'Not/AZone'), undefined);
});

function model(lines) {
  const m = new HubModel();
  for (const line of lines) m.apply(parseLine(line));
  return m;
}

const BASE = [
  'H01 1 Living 1 22 17 1 -1',
  'H01 2 Office 1 21 16 0 -1',
  `H03 1 Default ${PROFILE}`,
  'H02 200154035201 0 Heater 0 1 -1 -1',
  'H02 234000012006 0 Switch 0 1 -1 1',
  'H02 234000012007 0 Switch2 0 2 -1 -1',
];
const DAY = { weekday: 2, hour: 11, minute: 0 };
const NIGHT = { weekday: 2, hour: 23, minute: 0 };

test('mode in force: zone override, then hub override when allowed, then the profile', () => {
  const m = model(BASE);
  assert.equal(m.activeMode(1, DAY), 'comfort');
  assert.equal(m.activeMode(1, NIGHT), 'eco');
  assert.equal(m.standingMode(1, 1), 'schedule');
  m.apply(parseLine('H04 5 3 3 -1 -1 0 -1'));
  assert.equal(m.activeMode(1, DAY), 'away', 'the hub away applies to a zone allowing overrides');
  assert.equal(m.activeMode(2, DAY), 'comfort', 'not to a zone that does not');
  m.apply(parseLine('H04 6 2 3 -1 -1 1 1'));
  assert.equal(m.activeMode(1, DAY), 'eco', 'the zone override wins');
  assert.equal(m.standingMode(1, 1), 'eco');
  m.apply(parseLine('S03 6 2 3 -1 -1 1 1'));
  assert.equal(m.activeMode(1, DAY), 'away');
  m.apply(parseLine('H04 7 9 3 -1 -1 1 1'));
  assert.equal(m.standingMode(1, 1), undefined, 'an unknown override mode publishes nothing');
  assert.equal(m.activeMode(1, DAY), undefined);
  assert.equal(m.activeMode(99, DAY), undefined);
});

test('a from-to override is in force once its start has come; unreadable = unknown', () => {
  const o = { type: 2, start: '202611111200' };
  assert.equal(overrideLive(o, '20261111115900'), false);
  assert.equal(overrideLive(o, '20261111120000'), true);
  assert.equal(overrideLive({ type: 2, start: '-1' }, '20261111120000'), undefined);
  assert.equal(overrideLive({ type: 7 }, '20261111120000'), undefined);
});

test('zone temperature: its sensors, else its components; N/A and out of range are unknown', () => {
  const m = model([...BASE, 'Y02 234000012006 21.5', 'Y02 200154035201 30']);
  assert.equal(m.zoneTemperature(1), 21.5, 'the named sensor only');
  m.apply(parseLine('Y02 234000012006 N/A'));
  assert.equal(m.zoneTemperature(1), undefined, 'never the other component, never 0');
  assert.equal(m.zoneTemperature(2), undefined);
  m.apply(parseLine('Y02 234000012007 19.25'));
  assert.equal(m.zoneTemperature(2), 19.25, 'the components of the zone without a named sensor');
  m.apply(parseLine('Y02 234000012007 85'));
  assert.equal(m.zoneTemperature(2), undefined);
});

test('the model is bounded', () => {
  const m = new HubModel();
  for (let i = 0; i < 100; i += 1) m.apply(parseLine(`H01 ${i} Z 1 22 17 1 -1`));
  assert.equal(m.zones.size, 64);
});

test('config: serial, address, time zone; a refused serial is marked with 8 bits', () => {
  const c = normalizeConfig({ serial: '102 000 000 123', host: ' 192.168.1.50 ' });
  assert.equal(c.serialNumber, '102000000123');
  assert.equal(c.hubKey, '102000000');
  assert.equal(c.host, '192.168.1.50');
  assert.equal(c.timezone, 'Europe/Oslo');
  assert.equal(c.allowModes, false);
  assert.equal(c.allowSetpoints, false);
  assert.equal(normalizeConfig({ serial: '10200000012' }).serialError, 'invalid');
  assert.equal(normalizeConfig({}).serialError, 'missing');
  for (const bad of [
    '255.255.255.255',
    '224.0.0.1',
    '239.0.1.187',
    '0.0.0.0',
    '127.0.0.1',
    'ff02::1',
    'hub.local',
    '192.168.1.255',
  ]) {
    assert.equal(unicastAddress(bad), undefined, bad);
    assert.equal(normalizeConfig({ serial: '102000000123', host: bad }).hostError, 'invalid', bad);
  }
  assert.equal(
    normalizeConfig({ serial: '102000000123', timezone: 'Mars/Base' }).timezone,
    'Europe/Oslo',
  );
  const mark = serialMark('a'.repeat(32), '102000000123');
  assert.match(mark, /^[0-9a-f]{2}$/);
  // 8 bits: many serials share a mark, so the mark never gives the serial back.
  const same = Array.from(
    { length: 1000 },
    (_, i) => `102000000${String(i).padStart(3, '0')}`,
  ).filter((s) => serialMark('a'.repeat(32), s) === mark);
  assert.ok(same.length >= 2, `${same.length} serials share the mark`);
});

test('/data read back: bounded, repaired, future dates dropped', () => {
  const now = Date.UTC(2026, 10, 11);
  const m = normalizeMemory(
    {
      salt: 'x',
      refusal: { hubKey: '102000000', mark: 'zz' },
      pending: [
        { hubKey: '102000000', target: 1, targetId: 3, at: now - 1000, sends: 9 },
        { hubKey: '102000000', target: 0, targetId: -1, at: now + 1000 },
        { hubKey: '102000000', target: 0, targetId: 4, at: now },
        { hubKey: '102000000', target: 1, targetId: 2e6, at: now },
        { hubKey: '102000000', target: 1, targetId: 1.5, at: now },
        { hubKey: '1020', target: 1, targetId: 3, at: now },
        { hubKey: '102000000', target: 1, targetId: 3, at: now - 3_600_000 },
      ],
      lastAttemptAt: now + 5,
    },
    now,
  );
  assert.match(m.salt, /^[0-9a-f]{32}$/);
  assert.equal(m.refusal, null);
  assert.deepEqual(m.pending, [
    { hubKey: '102000000', target: 1, targetId: 3, at: now - 1000, sends: 6, afterId: null },
  ]);
  assert.equal(m.lastAttemptAt, null);
});
