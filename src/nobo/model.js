// -----------------------------------------------------------------------------
// What one session knows of the hub: zones, components, week profiles,
// overrides and temperatures, filled by the G00 download, then by what the
// hub pushes. Never kept between sessions (§5.7 of the document: download
// everything again after a new handshake).
// -----------------------------------------------------------------------------

import {
  ACTIVE,
  LIMITS,
  MODE,
  OVERRIDE_MODE,
  OVERRIDE_TARGET,
  OVERRIDE_TO_MODE,
  OVERRIDE_TYPE,
  PROFILE_STATUS,
  TEMPERATURE_RANGE,
} from '../constants.js';
import { profileStatusAt } from './protocol.js';

const STATUS_TO_ACTIVE = new Map([
  [PROFILE_STATUS.ECO, ACTIVE.ECO],
  [PROFILE_STATUS.COMFORT, ACTIVE.COMFORT],
  [PROFILE_STATUS.AWAY, ACTIVE.AWAY],
  [PROFILE_STATUS.OFF, ACTIVE.OFF],
  [PROFILE_STATUS.OFF_ALT, ACTIVE.OFF],
]);
const MODE_TO_ACTIVE = new Map([
  [OVERRIDE_MODE.COMFORT, ACTIVE.COMFORT],
  [OVERRIDE_MODE.ECO, ACTIVE.ECO],
  [OVERRIDE_MODE.AWAY, ACTIVE.AWAY],
]);

export class HubModel {
  constructor() {
    this.hub = undefined;
    this.zones = new Map();
    this.components = new Map();
    this.profiles = new Map();
    this.overrides = new Map();
    this.temperatures = new Map();
  }

  /** Applies one parsed message; true when something Gladys shows may have changed. */
  apply(msg) {
    switch (msg?.kind) {
      case 'zone':
        if (!this.zones.has(msg.zone.id) && this.zones.size >= LIMITS.zones) return false;
        this.zones.set(msg.zone.id, msg.zone);
        return true;
      case 'zone-removed':
        return this.zones.delete(msg.id);
      case 'component':
        if (
          !this.components.has(msg.component.serial) &&
          this.components.size >= LIMITS.components
        ) {
          return false;
        }
        this.components.set(msg.component.serial, msg.component);
        return true;
      case 'component-removed':
        this.temperatures.delete(msg.serial);
        return this.components.delete(msg.serial);
      case 'profile':
        if (!this.profiles.has(msg.profile.id) && this.profiles.size >= LIMITS.profiles)
          return false;
        this.profiles.set(msg.profile.id, msg.profile);
        return true;
      case 'profile-removed':
        return this.profiles.delete(msg.id);
      case 'override':
        if (!this.overrides.has(msg.override.id) && this.overrides.size >= LIMITS.overrides) {
          return false;
        }
        this.overrides.set(msg.override.id, msg.override);
        return true;
      case 'override-removed':
        return this.overrides.delete(msg.id);
      case 'temperature':
        if (!this.temperatures.has(msg.serial) && this.temperatures.size >= LIMITS.components) {
          return false;
        }
        this.temperatures.set(msg.serial, msg.value);
        return true;
      case 'hub':
        this.hub = msg.hub;
        return true;
      default:
        return false;
    }
  }

  /**
   * The temperature of a zone: the mean of the components the hub names as
   * its temperature sensors, else of the components of the zone, counting
   * only the values the hub knows (never "N/A"); undefined without any.
   */
  zoneTemperature(zoneId) {
    const components = [...this.components.values()];
    let sensors = components.filter((c) => c.sensorFor === zoneId);
    if (sensors.length === 0) sensors = components.filter((c) => c.zoneId === zoneId);
    const values = sensors
      .map((c) => this.temperatures.get(c.serial))
      .filter(
        (v) => typeof v === 'number' && v >= TEMPERATURE_RANGE.min && v <= TEMPERATURE_RANGE.max,
      );
    if (values.length === 0) return undefined;
    return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000;
  }

  /** The newest override on a target (the highest id the hub assigned). */
  overrideOn(target, targetId) {
    let found;
    for (const o of this.overrides.values()) {
      if (o.target === target && o.targetId === targetId && (!found || o.id > found.id)) found = o;
    }
    return found;
  }

  /** The standing choice of a target: its override, else the week profile; undefined for an unknown mode. */
  standingMode(target, targetId) {
    const o = this.overrideOn(target, targetId);
    if (!o) return MODE.SCHEDULE;
    return OVERRIDE_TO_MODE.get(o.mode);
  }

  /**
   * The mode in force in a zone at a local time (ACTIVE),
   * or undefined when it cannot be told: the override of the zone, else the
   * override of the hub when the zone allows overrides, else its week profile.
   */
  activeMode(zoneId, local, localStamp) {
    const zone = this.zones.get(zoneId);
    if (!zone) return undefined;
    const layers = [this.overrideOn(OVERRIDE_TARGET.ZONE, zoneId)];
    if (zone.allowOverrides === 1) layers.push(this.overrideOn(OVERRIDE_TARGET.HUB, -1));
    for (const o of layers) {
      if (!o || o.mode === OVERRIDE_MODE.NORMAL) continue;
      const live = overrideLive(o, localStamp);
      if (live === undefined) return undefined;
      if (live) return MODE_TO_ACTIVE.get(o.mode);
    }
    const profile = this.profiles.get(zone.profileId);
    const status = profileStatusAt(profile?.slots, local);
    return status === undefined ? undefined : STATUS_TO_ACTIVE.get(status);
  }
}

/**
 * Whether an override is in force: now, timer and constant ones are while the
 * hub keeps them (it removes them with S03); a from-to one once its start
 * (`yyyyMMddHHmm`, local time) has come; undefined when that cannot be read.
 */
export function overrideLive(o, localStamp) {
  if (o.type !== OVERRIDE_TYPE.FROM_TO) {
    return [OVERRIDE_TYPE.NOW, OVERRIDE_TYPE.TIMER, OVERRIDE_TYPE.CONSTANT].includes(o.type)
      ? true
      : undefined;
  }
  if (typeof o.start !== 'string' || !/^\d{12}$/.test(o.start) || typeof localStamp !== 'string') {
    return undefined;
  }
  return o.start <= localStamp.slice(0, 12);
}
