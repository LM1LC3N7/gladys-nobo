// -----------------------------------------------------------------------------
// The hub and its zones -> Gladys devices and states (pure).
//
// Ids: `ext:<selector>:zone:<hub>-<zone id>` for a zone, `ext:<selector>:hub:<hub>`
// for the hub, `<hub>` being the first 9 digits of its serial number (what the
// hub announces itself; never the 12 digits) and the zone id the one of the
// hub's database (read only, §9 of the document). The feature roles (the last
// part of the feature external ids) are published forever: never rename them.
//
// A device published again never loses a feature: those of the device
// already created in Gladys are kept as they are.
//
// No switch, no writable binary: a "turn everything off" must never reach the
// heating. The commands are the comfort and eco temperatures
// (`thermostat/target-temperature`) and the mode (`text/select`), the
// mode of the whole house on the hub device; all off by default but the away
// mode (anti-frost), which is never refused by an option (src/app.js).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  ACTIVE,
  FEATURES as F,
  MODE,
  OVERRIDE_TARGET,
  SETPOINT,
  TEMPERATURE_RANGE,
} from './constants.js';
import {
  ACTIVE_NAMES,
  FEATURE_NAMES,
  HUB_MODE_NAME,
  MODE_NAMES,
  hubName,
  word,
  zoneName,
} from './i18n.js';

export const ZONE_ROLES = [F.TEMPERATURE, F.COMFORT, F.ECO, F.MODE, F.ACTIVE];
export const HUB_ROLES = [F.MODE];

const MODE_ORDER = [MODE.SCHEDULE, MODE.COMFORT, MODE.ECO, MODE.AWAY];
const ACTIVE_ORDER = [ACTIVE.COMFORT, ACTIVE.ECO, ACTIVE.AWAY, ACTIVE.OFF];

/** The options of a select: string values, string labels (the core requires both), ordered. */
export const modeOptions = (language) =>
  MODE_ORDER.map((value, i) => ({
    value,
    label: word(MODE_NAMES[value], language),
    sort_order: i,
  }));
export const activeOptions = (language) =>
  ACTIVE_ORDER.map((value, i) => ({
    value,
    label: word(ACTIVE_NAMES[value], language),
    sort_order: i,
  }));

export function definitionOf(role, language) {
  switch (role) {
    case F.TEMPERATURE:
      return {
        category: C.TEMPERATURE_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.CELSIUS,
        min: TEMPERATURE_RANGE.min,
        max: TEMPERATURE_RANGE.max,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      };
    case F.COMFORT:
    case F.ECO:
      return {
        category: C.THERMOSTAT,
        type: T.THERMOSTAT.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        min: SETPOINT.min,
        max: SETPOINT.max,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      };
    case F.MODE:
    case F.ACTIVE:
      return {
        category: C.TEXT,
        type: T.TEXT.SELECT,
        min: 0,
        max: 0,
        read_only: role === F.ACTIVE,
        has_feedback: role === F.MODE,
        keep_history: true,
        supported_options: role === F.MODE ? modeOptions(language) : activeOptions(language),
      };
    default:
      throw new Error(`unknown role ${role}`);
  }
}

const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

export const zoneIds = (gladys, hubKey, zoneId) =>
  gladys.externalIds('zone', `${hubKey}-${zoneId}`);
export const hubIds = (gladys, hubKey) => gladys.externalIds('hub', hubKey);

/**
 * What a device or feature external id points at: `{ hubKey, target,
 * targetId, role? }` (target 1 = a zone, 0 = the hub), else undefined.
 */
export function parseExternalId(externalId) {
  const text = String(externalId ?? '');
  const zone = /:zone:(\d{9})-(\d{1,6})(?::([a-z-]{1,40}))?$/.exec(text);
  if (zone) {
    const role = zone[3];
    if (role !== undefined && !ZONE_ROLES.includes(role)) return undefined;
    return { hubKey: zone[1], target: OVERRIDE_TARGET.ZONE, targetId: Number(zone[2]), role };
  }
  const hub = /:hub:(\d{9})(?::([a-z-]{1,40}))?$/.exec(text);
  if (hub) {
    const role = hub[2];
    if (role !== undefined && !HUB_ROLES.includes(role)) return undefined;
    return { hubKey: hub[1], target: OVERRIDE_TARGET.HUB, targetId: -1, role };
  }
  return undefined;
}

export function buildZone(gladys, hubKey, zone, { language, created }) {
  const ids = zoneIds(gladys, hubKey, zone.id);
  const built = {
    name: created?.name ?? word(zoneName(zone.name, zone.id), language),
    external_id: ids.device,
    model: 'Nobø zone',
    should_poll: false,
    features: ZONE_ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...definitionOf(role, language),
    })),
    params: [{ name: 'zone_id', value: String(zone.id) }],
  };
  return keepCreatedFeatures(built, created);
}

export function buildHub(gladys, hubKey, hub, { language, created }) {
  const ids = hubIds(gladys, hubKey);
  const built = {
    name: created?.name ?? word(hubName(hub?.name), language),
    external_id: ids.device,
    model: 'Nobø Hub',
    should_poll: false,
    features: [
      {
        name: word(HUB_MODE_NAME, language),
        external_id: ids.feature(F.MODE),
        ...definitionOf(F.MODE, language),
      },
    ],
    params: [],
  };
  return keepCreatedFeatures(built, created);
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) return built;
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

/**
 * The states of a zone: `[role, value]` pairs, only for what is known now (an
 * unknown temperature or mode publishes nothing).
 */
export function zoneStates(model, zone, local, stamp) {
  const states = [];
  const temperature = model.zoneTemperature(zone.id);
  if (temperature !== undefined) states.push([F.TEMPERATURE, { state: temperature }]);
  states.push([F.COMFORT, { state: zone.comfort }], [F.ECO, { state: zone.eco }]);
  const standing = model.standingMode(OVERRIDE_TARGET.ZONE, zone.id);
  if (standing !== undefined) states.push([F.MODE, { text: standing }]);
  const active = model.activeMode(zone.id, local, stamp);
  if (active !== undefined) states.push([F.ACTIVE, { text: active }]);
  return states;
}

export function hubStates(model) {
  const standing = model.standingMode(OVERRIDE_TARGET.HUB, -1);
  return standing === undefined ? [] : [[F.MODE, { text: standing }]];
}
