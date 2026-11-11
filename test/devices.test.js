// -----------------------------------------------------------------------------
// The Gladys devices: ids, features, units, and the supported_options checked
// against the rules of the core (the SDK's fake Gladys does not check them).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { buildHub, buildZone, keepCreatedFeatures, parseExternalId } from '../src/devices.js';
import { HUB_KEY } from './helpers/fakeHub.js';

const CORE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const CORE_UNITS = '/home/claude/code/Gladys/server/utils/constants.js';
const normalizeSupportedOptions = existsSync(CORE)
  ? createRequire(import.meta.url)(CORE).normalizeSupportedOptions
  : undefined;

const gladys = createFakeGladys({ selector: 'nobo' });
const all = ['fr', 'en'].flatMap((language) => [
  buildZone(gladys, HUB_KEY, { id: 3, name: 'Stue' }, { language }),
  buildHub(gladys, HUB_KEY, { name: 'Hub' }, { language }),
]);

test('ids: the first 9 digits of the serial and the zone id; roles parsed back', () => {
  const [zone, hub] = all;
  assert.equal(zone.external_id, `ext:nobo:zone:${HUB_KEY}-3`);
  assert.equal(hub.external_id, `ext:nobo:hub:${HUB_KEY}`);
  assert.deepEqual(parseExternalId(`${zone.external_id}:mode`), {
    hubKey: HUB_KEY,
    target: 1,
    targetId: 3,
    role: 'mode',
  });
  assert.deepEqual(parseExternalId(`${hub.external_id}:mode`), {
    hubKey: HUB_KEY,
    target: 0,
    targetId: -1,
    role: 'mode',
  });
  assert.equal(parseExternalId(`${hub.external_id}:comfort-temperature`), undefined);
  assert.equal(parseExternalId(`${zone.external_id}:switch`), undefined);
  assert.equal(parseExternalId(`ext:nobo:zone:12-3:mode`), undefined);
});

test('no switch nor writable binary; units of the core; read-only where nothing is written', () => {
  for (const device of all) {
    for (const f of device.features) {
      assert.notEqual(f.category, 'switch');
      assert.ok(!(f.type === 'binary' && !f.read_only));
    }
  }
  const byRole = Object.fromEntries(
    all[0].features.map((f) => [f.external_id.split(':').at(-1), f]),
  );
  assert.equal(byRole.temperature.read_only, true);
  assert.equal(byRole['mode-in-force'].read_only, true);
  assert.equal(byRole['comfort-temperature'].min, 7);
  assert.equal(byRole['comfort-temperature'].max, 30);
  if (existsSync(CORE_UNITS)) {
    const { DEVICE_FEATURE_UNITS_BY_CATEGORY: units } = createRequire(import.meta.url)(CORE_UNITS);
    for (const f of all.flatMap((d) => d.features)) {
      if (f.unit) assert.ok(units[f.category].includes(f.unit), `${f.category} ${f.unit}`);
    }
  }
});

test('supported_options follow the rules of the core', () => {
  for (const f of all.flatMap((d) => d.features).filter((x) => x.supported_options)) {
    const options = f.supported_options;
    for (const o of options) {
      assert.equal(typeof o.label, 'string');
      assert.ok(o.label.trim() === o.label && o.label.length > 0, o.label);
      assert.ok(typeof o.value === 'string' && o.value.trim().length > 0, String(o.value));
      assert.ok(Number.isInteger(o.sort_order));
      assert.deepEqual(Object.keys(o).sort(), ['label', 'sort_order', 'value']);
    }
    assert.equal(new Set(options.map((o) => o.value)).size, options.length);
    if (normalizeSupportedOptions) {
      assert.deepEqual(normalizeSupportedOptions(options, { allowStringValues: true }), options);
    }
  }
});

test('a device published again keeps the features of the created one', () => {
  const createdDevice = {
    ...all[0],
    features: [
      ...all[0].features,
      { external_id: 'x:old', name: 'Old', category: 'battery', type: 'integer' },
    ],
  };
  const again = buildZone(
    gladys,
    HUB_KEY,
    { id: 3, name: 'New name' },
    { language: 'fr', created: createdDevice },
  );
  assert.equal(again.name, createdDevice.name, 'the name of the user stays');
  assert.ok(again.features.some((f) => f.external_id === 'x:old'));
  assert.equal(keepCreatedFeatures(all[0], undefined), all[0]);
});
