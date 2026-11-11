// -----------------------------------------------------------------------------
// A fake Nobø hub in process: a socket-like object per connection, the
// handshake, G00, A03 and U00 answered as the document describes. Lines the
// client wrote are kept in `hub.lines`. Built from the document only.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const SERIAL = '102000000123';
export const HUB_KEY = '102000000';
const NBSP = ' ';

/** Monday to Sunday: comfort 06:00-22:00, eco otherwise. */
export const PROFILE = Array.from({ length: 7 }, () => '00000,06001,22000').join(',');

export function defaultWorld() {
  return {
    serial: SERIAL,
    hubName: `My${NBSP}hub`,
    zones: [
      { id: 1, name: `Living${NBSP}room`, profileId: 1, comfort: 22, eco: 17, allow: 1 },
      { id: 2, name: 'Office', profileId: 1, comfort: 21, eco: 16, allow: 0 },
    ],
    components: [
      { serial: '200154035201', name: 'Heater', zoneId: 1, sensorFor: -1 },
      { serial: '234000012006', name: `Switch${NBSP}SW4`, zoneId: 1, sensorFor: 1 },
    ],
    temperatures: { 234000012006: '21.125', 200154035201: 'N/A' },
    profiles: [{ id: 1, name: 'Default', profile: PROFILE }],
    overrides: [],
    nextOverride: 10,
  };
}

const zoneLine = (cmd, z) =>
  `${cmd} ${z.id} ${z.name} ${z.profileId} ${z.comfort} ${z.eco} ${z.allow} -1`;
const overrideLine = (cmd, o) =>
  `${cmd} ${o.id} ${o.mode} ${o.type} -1 -1 ${o.target} ${o.targetId}`;

export function fakeHub(world = defaultWorld(), { clock } = {}) {
  const hub = {
    world,
    lines: [],
    connections: 0,
    open: new Set(),
    unreachable: false,
    silent: false,
    refuseA03: false,
    ignoreU00: false,
    /** ms before an answer (on the virtual clock when one is given). */
    latency: 0,
  };
  const later = (fn) => {
    if (hub.latency && clock) clock.sleep(hub.latency).then(fn);
    else queueMicrotask(fn);
  };

  class Socket extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      hub.connections += 1;
      setImmediate(() => {
        if (hub.unreachable) {
          this.emit('error', new Error('ECONNREFUSED'));
          this.destroy();
          return;
        }
        hub.open.add(this);
        this.emit('connect');
      });
    }
    setNoDelay() {}
    setKeepAlive() {}
    write(text) {
      for (const line of text.split('\r').filter(Boolean)) {
        hub.lines.push(line);
        later(() => this.handle(line));
      }
      return true;
    }
    send(...lines) {
      if (this.destroyed) return;
      this.emit('data', Buffer.from(lines.map((l) => `${l}\r`).join(''), 'utf8'));
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      hub.open.delete(this);
      setImmediate(() => this.emit('close'));
    }
    handle(line) {
      if (this.destroyed) return;
      const f = line.split(' ');
      switch (f[0]) {
        case 'HELLO':
          this.send(f[2] === world.serial ? 'HELLO 1.1' : 'REJECT 1');
          break;
        case 'HANDSHAKE':
          this.send('HANDSHAKE');
          break;
        case 'G00':
          this.send(
            'H00',
            ...world.zones.map((z) => zoneLine('H01', z)),
            ...world.components.map(
              (c) => `H02 ${c.serial} 0 ${c.name} 0 ${c.zoneId} -1 ${c.sensorFor}`,
            ),
            ...Object.entries(world.temperatures).map(([s, t]) => `Y02 ${s} ${t}`),
            ...world.profiles.map((p) => `H03 ${p.id} ${p.name} ${p.profile}`),
            ...world.overrides.map((o) => overrideLine('H04', o)),
            'V06 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
            `H05 ${world.serial} ${world.hubName} 13 -1 115 11123610_rev._1 20130813`,
          );
          break;
        case 'A03': {
          if (hub.silent) break;
          if (hub.refuseA03) {
            this.send('E00 A03 Zone does not allow overrides');
            break;
          }
          const [, , mode, type, , , target, targetId] = f.map(Number);
          const removed = world.overrides.filter(
            (o) => o.target === target && o.targetId === targetId,
          );
          world.overrides = world.overrides.filter((o) => !removed.includes(o));
          const o = { id: world.nextOverride++, mode, type, target, targetId };
          world.overrides.push(o);
          for (const s of hub.open) {
            s.send(overrideLine('B03', o), ...removed.map((r) => overrideLine('S03', r)));
          }
          break;
        }
        case 'U00': {
          if (hub.silent) break;
          const zone = world.zones.find((z) => z.id === Number(f[1]));
          if (!zone) {
            this.send('E00 U00 Unknown zone');
            break;
          }
          if (!hub.ignoreU00) {
            zone.comfort = Number(f[4]);
            zone.eco = Number(f[5]);
          }
          for (const s of hub.open) s.send(zoneLine('V00', zone));
          break;
        }
        default:
          break;
      }
    }
  }

  hub.hosts = [];
  hub.createConnection = (options) => {
    hub.hosts.push(options?.host);
    return new Socket();
  };
  /** A push of the hub to every client (a temperature, an override ending…). */
  hub.push = (...lines) => {
    for (const s of hub.open) s.send(...lines);
  };
  hub.dropAll = () => {
    for (const s of [...hub.open]) s.destroy();
  };
  return hub;
}
