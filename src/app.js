// -----------------------------------------------------------------------------
// The integration: one TCP session with the Nobø hub, kept open (the hub
// pushes every change), the zones published to Gladys, the commands.
//
// Session: connect (the configured address, else the hub heard in UDP on port
// 10000 through the mediated scan of Gladys), handshake with the 12-digit
// serial, send the away commands still pending, download everything (G00),
// then follow what the hub pushes. A closed session is opened again after
// 5 s, 10 s, 20 s… up to 5 min (persisted: a restart never connects sooner).
// A serial the hub refuses (REJECT 1) is not sent again by itself: a new
// serial, or the "Test the connection" button, tries again.
//
// Commands (Gladys waits 5 s for the ack): one in flight at a time, the next
// waiting its turn (a scene setting several zones), each decided on the state
// of the current session (the hub pushes every change to its clients, so this
// state is the hub's own while the session lives) and refused without a
// session whose download is complete. The away mode (anti-frost) is the
// protective command: never refused by an option, a missing session, a full
// queue nor a pause; written before the waiting commands (those of its target
// are dropped, nothing queued before it leaves after it), kept in /data until
// the hub confirms it (B03), written again 3 times at most within 15 min.
// -----------------------------------------------------------------------------

import { normalizeConfig, isComplete, serialMark, unicastAddress } from './config.js';
import {
  API,
  FEATURES as F,
  LIMITS,
  OVERRIDE_MODE,
  OVERRIDE_TARGET,
  OVERRIDE_TYPE,
  MODE,
  MODE_TO_OVERRIDE,
  SETPOINT,
  TIMINGS,
} from './constants.js';
import {
  buildHub,
  buildZone,
  hubIds,
  hubStates,
  parseExternalId,
  zoneIds,
  zoneStates,
} from './devices.js';
import { COMMAND, STATUS, TEST, word } from './i18n.js';
import { HubModel } from './nobo/model.js';
import { addOverride, localParts, localStamp, updateZone } from './nobo/protocol.js';
import { HubSession } from './nobo/session.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** A command refused or unconfirmed: the message Gladys shows. */
export class CommandError extends Error {
  constructor(texts, language) {
    super(word(texts, language));
    this.texts = texts;
  }
}

const sameTarget = (a, b) =>
  a.hubKey === b.hubKey && a.target === b.target && a.targetId === b.targetId;

export class NoboApp {
  constructor({
    gladys,
    logger = console,
    createConnection,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.createConnection = createConnection;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = undefined;
    this.generation = 0;
    this.session = undefined;
    this.sessionState = 'idle';
    this.model = undefined;
    this.backoff = 0;
    this.openedAt = 0;
    this.reconnectTimer = undefined;
    this.configTimer = undefined;
    this.configTries = 0;
    this.evalTimer = undefined;
    this.retryTimer = undefined;
    this.storeTimer = undefined;
    this.queue = [];
    this.busy = undefined;
    this.memory = normalizeMemory(null, now());
    this.memoryLoaded = false;
    this.memoryLoading = undefined;
    this.statusKey = undefined;
    this.stopped = false;
  }

  get language() {
    return this.config?.language ?? 'fr';
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Every (re)connection to Gladys: read the configuration (again on failure), then start or refresh. */
  async onConnected(getConfig) {
    this.publisher.start();
    await this.loadMemory();
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      this.logger.warn(`Reading the configuration failed: ${err.message}`);
      const wait = TIMINGS.configRetry[Math.min(this.configTries, TIMINGS.configRetry.length - 1)];
      this.configTries += 1;
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = this.timers.setTimeout(() => {
        this.onConnected(getConfig).catch((e) => this.logger.error(`Start failed: ${e.message}`));
      }, wait);
      await this.setStatus(false, STATUS.configUnread(Math.round(wait / 1000)));
      return;
    }
    this.configTries = 0;
    this.timers.clearTimeout(this.configTimer);
    const config = normalizeConfig(raw);
    if (this.config && JSON.stringify(config) === JSON.stringify(this.config)) {
      // Same configuration (Gladys came back): nothing stale is published again.
      this.statusKey = undefined;
      this.gladys.forgetPublishedStates?.();
      await this.publishDiscovery();
      this.publishAll();
      await this.refreshStatus();
      return;
    }
    await this.apply(config);
  }

  /** The configuration changed (saved by the user). */
  async configUpdated(raw) {
    const config = normalizeConfig(raw);
    if (this.config && JSON.stringify(config) === JSON.stringify(this.config)) {
      await this.refreshStatus();
      return;
    }
    await this.apply(config);
  }

  async apply(config) {
    const sameHub =
      this.config &&
      this.config.serialNumber === config.serialNumber &&
      this.config.host === config.host &&
      this.config.timezone === config.timezone;
    this.config = config;
    if (sameHub && this.sessionState !== 'idle') {
      // Only options or the language changed: the session stays.
      await this.refreshStatus();
      return;
    }
    this.restart();
    await this.start();
  }

  restart() {
    this.generation += 1;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.timers.clearInterval(this.evalTimer);
    this.evalTimer = undefined;
    const session = this.session;
    this.session = undefined;
    this.sessionState = 'idle';
    this.model = undefined;
    session?.close('restart');
    this.backoff = 0;
  }

  async start() {
    const config = this.config;
    if (config.serialError) {
      await this.setStatus(
        false,
        config.serialError === 'missing' ? STATUS.serialMissing : STATUS.serialInvalid,
      );
      return;
    }
    if (config.hostError) {
      await this.setStatus(false, STATUS.hostInvalid);
      return;
    }
    if (this.isRefused()) {
      await this.setStatus(false, STATUS.serialRefused);
      return;
    }
    // Never sooner than the first step of the backoff after the last attempt, even across a restart.
    const last = this.memory.lastAttemptAt;
    const wait =
      last === null
        ? 0
        : Math.max(0, Math.min(TIMINGS.reconnect[0], last + TIMINGS.reconnect[0] - this.now()));
    this.scheduleConnect(wait);
    await this.setStatus(false, STATUS.connecting);
  }

  isRefused() {
    const r = this.memory.refusal;
    return Boolean(
      r &&
      this.config &&
      r.hubKey === this.config.hubKey &&
      r.mark === serialMark(this.memory.salt, this.config.serialNumber),
    );
  }

  scheduleConnect(wait) {
    const gen = this.generation;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(gen).catch((err) => this.logger.error(`Connection failed: ${err.message}`));
    }, wait);
  }

  /** Connects now when nothing is under way (an away command waiting). */
  connectSoon() {
    if (this.stopped || !this.config || !isComplete(this.config) || this.isRefused()) return;
    if (this.sessionState !== 'idle') return;
    this.scheduleConnect(0);
  }

  async connect(gen) {
    if (gen !== this.generation || this.stopped || this.sessionState !== 'idle') return;
    const config = this.config;
    this.sessionState = 'connecting';
    this.memory.lastAttemptAt = this.now();
    this.saveMemory();
    const hosts = config.host ? [config.host] : await this.discover(config.hubKey);
    if (gen !== this.generation) return;
    if (hosts.length === 0) {
      this.failed(gen, (wait) => STATUS.notFound(wait));
      return;
    }
    let rejected = 0;
    for (const host of hosts) {
      const session = new HubSession({
        createConnection: this.createConnection,
        timers: this.timers,
        monotonic: this.monotonic,
      });
      try {
        const local = localStamp(this.now(), config.timezone);
        await session.open({
          host,
          port: API.port,
          serialNumber: config.serialNumber,
          stamp: local,
        });
      } catch (err) {
        session.close('failed');
        if (gen !== this.generation) return;
        if (err.reason === 'serial') {
          rejected += 1;
          continue;
        }
        if (err.reason === 'version') {
          this.sessionState = 'idle';
          await this.setStatus(false, STATUS.versionRefused);
          return;
        }
        this.logger.warn(`Session with the hub failed: ${err.reason ?? err.message}`);
        continue;
      }
      if (gen !== this.generation) {
        session.close('stale');
        return;
      }
      await this.opened(gen, session);
      return;
    }
    if (rejected === hosts.length) {
      // Every hub heard refused this serial: no new try by itself.
      this.sessionState = 'idle';
      this.memory.refusal = {
        hubKey: config.hubKey,
        mark: serialMark(this.memory.salt, config.serialNumber),
      };
      this.saveMemory();
      this.logger.warn('The hub refused the serial number');
      await this.setStatus(false, STATUS.serialRefused);
      return;
    }
    this.failed(gen, (wait) => STATUS.unreachable(wait));
  }

  /** The hubs heard announcing the first 9 digits of the serial (mediated UDP scan), unicast only. */
  async discover(hubKey) {
    let results;
    try {
      results = await this.gladys.scanNetwork('udp-broadcast', {
        timeoutSeconds: TIMINGS.scanSeconds,
      });
    } catch (err) {
      this.logger.warn(`Network scan failed: ${err.message}`);
      return [];
    }
    const hosts = [];
    for (const entry of Array.isArray(results) ? results.slice(0, LIMITS.datagrams) : []) {
      const b64 = entry?.payload_base64;
      if (typeof b64 !== 'string' || b64.length > 64) continue;
      const text = Buffer.from(b64, 'base64').toString('latin1');
      const match = API.announce.exec(text);
      const host = unicastAddress(entry?.source_ip);
      if (match && match[1] === hubKey && host && !hosts.includes(host)) hosts.push(host);
      if (hosts.length >= 4) break;
    }
    return hosts;
  }

  failed(gen, status) {
    if (gen !== this.generation) return;
    this.sessionState = 'idle';
    const wait = TIMINGS.reconnect[Math.min(this.backoff, TIMINGS.reconnect.length - 1)];
    this.backoff += 1;
    this.scheduleConnect(wait);
    this.setStatus(false, status(Math.round(wait / 1000))).catch(() => {});
  }

  async opened(gen, session) {
    this.session = session;
    this.openedAt = this.monotonic();
    this.model = new HubModel();
    this.sessionState = 'syncing';
    session.on('message', (msg) => this.onMessage(session, msg));
    session.on('close', (reason) => this.onClosed(gen, session, reason));
    // A new session: if the refusal was lifted by the button, it is gone for good.
    if (this.memory.refusal) {
      this.memory.refusal = null;
      this.saveMemory();
    }
    // Away commands waiting: written right after the handshake, before anything else.
    this.sendPending();
    try {
      await session.sync();
    } catch (err) {
      if (gen !== this.generation || session !== this.session) return;
      this.logger.warn(`Download from the hub failed: ${err.reason ?? err.message}`);
      session.close('sync-failed');
      return;
    }
    if (gen !== this.generation || session !== this.session) return;
    this.sessionState = 'ready';
    this.timers.clearInterval(this.evalTimer);
    this.evalTimer = this.timers.setInterval(() => this.publishAll(), TIMINGS.evaluate);
    this.logger.info(
      `Connected to the hub ${this.config.hubKey}: ${this.model.zones.size} zone(s)`,
    );
    await this.publishDiscovery();
    this.publishAll();
    await this.refreshStatus();
    this.pump();
  }

  onClosed(gen, session, reason) {
    if (session !== this.session) return;
    this.session = undefined;
    this.model = undefined;
    this.timers.clearInterval(this.evalTimer);
    this.evalTimer = undefined;
    this.sessionState = 'idle';
    this.busyDone();
    if (gen !== this.generation || this.stopped) return;
    this.logger.warn(`Session with the hub closed: ${reason}`);
    if (this.monotonic() - this.openedAt >= TIMINGS.stableAfter) this.backoff = 0;
    this.failed(gen, (wait) => STATUS.unreachable(wait));
  }

  onMessage(session, msg) {
    if (session !== this.session || !this.model) return;
    if (msg.kind === 'override') this.overrideSeen(msg);
    const changed = this.model.apply(msg);
    if (changed && this.sessionState === 'ready') {
      if (msg.kind === 'zone' || msg.kind === 'zone-removed' || msg.kind === 'hub') {
        this.publishDiscovery().catch(() => {});
      }
      this.publishAll();
    }
  }

  /**
   * An override seen: one in away mode on a target confirms its pending away
   * command; a new one (B03) in another mode is a newer command (the app, a
   * switch, another client): the away command is not sent again over it.
   */
  overrideSeen({ cmd, override }) {
    const hubKey = this.config?.hubKey;
    const before = this.memory.pending.length;
    this.memory.pending = this.memory.pending.filter(
      (p) =>
        !(
          p.hubKey === hubKey &&
          p.target === override.target &&
          p.targetId === override.targetId &&
          (override.mode === OVERRIDE_MODE.AWAY || cmd === 'B03')
        ),
    );
    if (this.memory.pending.length !== before) this.saveMemory();
  }

  async shutdown() {
    this.stopped = true;
    this.restart();
    this.publisher.stop();
    for (const t of [this.configTimer, this.retryTimer, this.storeTimer])
      this.timers.clearTimeout(t);
    for (const item of this.queue.splice(0))
      item.reject(new CommandError(COMMAND.notReady, this.language));
    await this.saveMemory();
  }

  // --- /data -----------------------------------------------------------------

  async loadMemory() {
    if (this.memoryLoaded) return;
    this.memoryLoading ??= (async () => {
      try {
        const raw = await this.store.load();
        const loaded = normalizeMemory(raw, this.now());
        // Away commands made while /data was unreadable are kept, newest per target.
        for (const p of this.memory.pending) {
          loaded.pending = loaded.pending.filter((q) => !sameTarget(p, q));
          loaded.pending.push(p);
        }
        this.memory = loaded;
        this.memoryLoaded = true;
      } catch (err) {
        // Unreadable is not empty: nothing is written over it; read again later.
        this.logger.warn(`Reading /data failed: ${err.message}`);
        this.timers.clearTimeout(this.storeTimer);
        this.storeTimer = this.timers.setTimeout(() => {
          this.loadMemory().then(() => this.sendPending());
        }, TIMINGS.storeRetry);
      } finally {
        this.memoryLoading = undefined;
      }
    })();
    await this.memoryLoading;
  }

  saveMemory() {
    if (!this.memoryLoaded) return Promise.resolve();
    return this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Writing /data failed: ${err.message}`));
  }

  // --- Gladys ----------------------------------------------------------------

  createdIds() {
    return new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
  }

  async publishDiscovery() {
    if (this.sessionState !== 'ready' || !this.model) return;
    const created = this.createdIds();
    const hubKey = this.config.hubKey;
    const language = this.language;
    const devices = [
      buildHub(this.gladys, hubKey, this.model.hub, {
        language,
        created: created.get(hubIds(this.gladys, hubKey).device),
      }),
      ...[...this.model.zones.values()].map((zone) =>
        buildZone(this.gladys, hubKey, zone, {
          language,
          created: created.get(zoneIds(this.gladys, hubKey, zone.id).device),
        }),
      ),
    ];
    try {
      await this.gladys.publishDiscoveredDevices(devices);
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** The states of the created devices, from the live session only (nothing stale). */
  publishAll() {
    if (this.sessionState !== 'ready' || !this.model) return;
    const created = this.createdIds();
    const hubKey = this.config.hubKey;
    const now = this.now();
    const local = localParts(now, this.config.timezone);
    const stamp = localStamp(now, this.config.timezone);
    const hub = hubIds(this.gladys, hubKey);
    if (created.has(hub.device)) {
      for (const [role, value] of hubStates(this.model))
        this.publisher.push(hub.feature(role), value);
    }
    for (const zone of this.model.zones.values()) {
      const ids = zoneIds(this.gladys, hubKey, zone.id);
      if (!created.has(ids.device)) continue;
      for (const [role, value] of zoneStates(this.model, zone, local, stamp)) {
        this.publisher.push(ids.feature(role), value);
      }
    }
  }

  async scan() {
    if (this.sessionState === 'ready') {
      await this.publishDiscovery();
    }
  }

  async deviceCreated() {
    this.publishAll();
  }

  async deviceDeleted(device) {
    this.publisher.forget(device?.external_id ?? '');
  }

  async testConnection() {
    const language = this.language;
    if (this.sessionState === 'ready') {
      return word(TEST.ok(this.model.zones.size, this.model.components.size), language);
    }
    if (this.config && this.isRefused()) {
      // The button lifts a refusal: one new try, now.
      this.memory.refusal = null;
      await this.saveMemory();
      this.restart();
      this.scheduleConnect(0);
      await this.setStatus(false, STATUS.connecting);
    }
    return word(this.lastStatus ?? STATUS.connecting, language);
  }

  async refreshStatus() {
    if (this.sessionState === 'ready') {
      await this.setStatus(true, STATUS.connected(this.model.zones.size));
    } else if (this.lastStatus) {
      this.statusKey = undefined;
      await this.setStatus(false, this.lastStatus);
    }
  }

  /** One setConnectionStatus per state. */
  async setStatus(connected, message) {
    this.lastStatus = message;
    const key = JSON.stringify([connected, message]);
    if (key === this.statusKey) return;
    this.statusKey = key;
    try {
      await this.gladys.setConnectionStatus(connected, message);
    } catch (err) {
      this.statusKey = undefined;
      this.logger.warn(`Setting the status failed: ${err.message}`);
    }
  }

  // --- Commands --------------------------------------------------------------

  async setValue(_device, feature, value) {
    const language = this.language;
    const ref = parseExternalId(feature?.external_id);
    if (!ref || !ref.role) throw new CommandError(COMMAND.badValue, language);
    if (ref.role === F.MODE) {
      const mode = typeof value === 'string' ? value : undefined;
      if (!MODE_TO_OVERRIDE.has(mode)) throw new CommandError(COMMAND.badValue, language);
      if (mode === MODE.AWAY) return this.away(ref);
      if (this.config && ref.hubKey !== this.config.hubKey)
        throw new CommandError(COMMAND.otherHub, language);
      if (!this.config?.allowModes) throw new CommandError(COMMAND.modesOff, language);
      return this.enqueue({ ref, kind: 'mode', mode: MODE_TO_OVERRIDE.get(mode) });
    }
    if ((ref.role === F.COMFORT || ref.role === F.ECO) && ref.target === OVERRIDE_TARGET.ZONE) {
      if (this.config && ref.hubKey !== this.config.hubKey)
        throw new CommandError(COMMAND.otherHub, language);
      if (!this.config?.allowSetpoints) throw new CommandError(COMMAND.setpointsOff, language);
      const number = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
      if (!Number.isInteger(number) || number < SETPOINT.min || number > SETPOINT.max) {
        throw new CommandError(COMMAND.outOfRange(SETPOINT.min, SETPOINT.max), language);
      }
      return this.enqueue({ ref, kind: 'setpoint', role: ref.role, value: number });
    }
    throw new CommandError(COMMAND.badValue, language);
  }

  enqueue(item) {
    const language = this.language;
    if (this.sessionState !== 'ready')
      return Promise.reject(new CommandError(COMMAND.notReady, language));
    if (this.queue.length >= LIMITS.commandQueue)
      return Promise.reject(new CommandError(COMMAND.queueFull, language));
    const at = this.monotonic();
    return new Promise((resolve, reject) => {
      this.queue.push({
        ...item,
        sendBy: at + TIMINGS.commandSendBy,
        answerBy: at + TIMINGS.commandAnswerBy,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  /** Serves the queue: one command in flight. */
  pump() {
    if (this.busy || this.queue.length === 0) return;
    const item = this.queue.shift();
    const language = this.language;
    const fail = (texts) => {
      item.reject(new CommandError(texts, language));
      this.pump();
    };
    const at = this.monotonic();
    if (at > item.sendBy) return fail(COMMAND.late);
    if (this.sessionState !== 'ready' || !this.session) return fail(COMMAND.notReady);
    const { ref } = item;
    let line;
    let match;
    if (item.kind === 'mode') {
      if (ref.target === OVERRIDE_TARGET.ZONE && !this.model.zones.has(ref.targetId))
        return fail(COMMAND.unknownZone);
      line = addOverride({
        mode: item.mode,
        type: OVERRIDE_TYPE.CONSTANT,
        target: ref.target,
        targetId: ref.targetId,
      });
      match = (m) =>
        m.kind === 'override' &&
        m.cmd === 'B03' &&
        m.override.target === ref.target &&
        m.override.targetId === ref.targetId
          ? m.override.mode === item.mode
            ? 'ok'
            : 'other'
          : m.kind === 'error' && m.about === 'A03'
            ? 'refused'
            : undefined;
    } else {
      const zone = this.model.zones.get(ref.targetId);
      if (!zone) return fail(COMMAND.unknownZone);
      const wanted = {
        comfort: item.role === F.COMFORT ? item.value : zone.comfort,
        eco: item.role === F.ECO ? item.value : zone.eco,
      };
      if (wanted.comfort < wanted.eco) return fail(COMMAND.comfortBelowEco);
      line = updateZone(zone, wanted);
      match = (m) =>
        m.kind === 'zone' && m.cmd === 'V00' && m.zone.id === ref.targetId
          ? m.zone.comfort === wanted.comfort && m.zone.eco === wanted.eco
            ? 'ok'
            : 'other'
          : m.kind === 'error' && m.about === 'U00'
            ? 'refused'
            : undefined;
    }
    // Just before the first byte: the option is read again (it may have been unticked meanwhile).
    if (item.kind === 'mode' ? !this.config.allowModes : !this.config.allowSetpoints) {
      return fail(item.kind === 'mode' ? COMMAND.modesOff : COMMAND.setpointsOff);
    }
    const session = this.session;
    let answer;
    const reply = session.next((m) => {
      const verdict = match(m);
      if (verdict) answer = { verdict, m };
      return Boolean(verdict);
    }, item.answerBy - at);
    if (!session.write(line)) return fail(COMMAND.notReady);
    // A newer command of this target has left: an away command pending on it is not sent again.
    const before = this.memory.pending.length;
    this.memory.pending = this.memory.pending.filter((p) => !sameTarget(p, ref));
    if (before !== this.memory.pending.length) this.saveMemory();
    let release;
    this.busy = new Promise((resolve) => {
      release = resolve;
    });
    this.busyRelease = release;
    reply.then(() => {
      this.busyDone();
      if (!answer) item.reject(new CommandError(COMMAND.unconfirmed, language));
      else if (answer.verdict === 'ok') item.resolve();
      else if (answer.verdict === 'refused')
        item.reject(new CommandError(COMMAND.refused(cleanError(answer.m.message)), language));
      else item.reject(new CommandError(COMMAND.notApplied, language));
      this.pump();
    });
    return undefined;
  }

  busyDone() {
    const release = this.busyRelease;
    this.busy = undefined;
    this.busyRelease = undefined;
    release?.();
  }

  /**
   * The away mode (anti-frost) of a zone or of the whole house: never refused
   * by an option, a missing session nor a full queue.
   */
  async away(ref) {
    const language = this.language;
    // Nothing waiting for this target (all of the hub's for the whole house) leaves after it.
    const dropped = this.queue.filter(
      (item) =>
        item.ref.hubKey === ref.hubKey &&
        (ref.target === OVERRIDE_TARGET.HUB || sameTarget(item.ref, ref)),
    );
    this.queue = this.queue.filter((item) => !dropped.includes(item));
    for (const item of dropped) item.reject(new CommandError(COMMAND.cancelled, language));
    const entry = {
      hubKey: ref.hubKey,
      target: ref.target,
      targetId: ref.targetId,
      at: this.now(),
      sends: 0,
    };
    this.memory.pending = this.memory.pending
      .filter((p) => !sameTarget(p, entry))
      .slice(-(LIMITS.pending - 1));
    this.memory.pending.push(entry);
    this.saveMemory();
    const session = this.session;
    if (!session?.ready || ref.hubKey !== this.config?.hubKey) {
      this.connectSoon();
      this.armRetry();
      throw new CommandError(COMMAND.awayPending, language);
    }
    // A command in flight: its answer awaited 250 ms at most, then the away command goes anyway.
    if (this.busy) {
      let timer;
      await Promise.race([
        this.busy,
        new Promise((resolve) => (timer = this.timers.setTimeout(resolve, TIMINGS.protectiveWait))),
      ]);
      this.timers.clearTimeout(timer);
    }
    const reply = this.session?.next(
      (m) =>
        (m.kind === 'override' &&
          m.cmd === 'B03' &&
          m.override.target === ref.target &&
          m.override.targetId === ref.targetId &&
          m.override.mode === OVERRIDE_MODE.AWAY) ||
        (m.kind === 'error' && m.about === 'A03'),
      TIMINGS.commandAnswerBy - TIMINGS.protectiveWait,
    );
    if (!this.writeAway(entry)) {
      this.connectSoon();
      this.armRetry();
      throw new CommandError(COMMAND.awayPending, language);
    }
    this.armRetry();
    const answer = await reply;
    if (answer?.kind === 'override') return undefined;
    if (answer?.kind === 'error') {
      // Refused by the hub (a zone that does not allow overrides…): sending it again changes nothing.
      this.memory.pending = this.memory.pending.filter((p) => p !== entry);
      this.saveMemory();
      throw new CommandError(COMMAND.refused(cleanError(answer.message)), language);
    }
    throw new CommandError(COMMAND.awayPending, language);
  }

  /** Writes one away command on the live session; false when it cannot leave now. */
  writeAway(entry) {
    const session = this.session;
    if (!session?.ready || entry.hubKey !== this.config?.hubKey) return false;
    const line = addOverride({
      mode: OVERRIDE_MODE.AWAY,
      type: OVERRIDE_TYPE.CONSTANT,
      target: entry.target,
      targetId: entry.targetId,
    });
    if (!session.write(line)) return false;
    entry.sends += 1;
    this.saveMemory();
    return true;
  }

  /** Every pending away command still in time, written at once (a new session, a retry). */
  sendPending() {
    this.prunePending();
    for (const entry of this.memory.pending) this.writeAway(entry);
    this.armRetry();
  }

  /** Drops the away commands past their 15 min or their 3 sends (wall clock: they live in /data). */
  prunePending() {
    const now = this.now();
    const before = this.memory.pending.length;
    this.memory.pending = this.memory.pending.filter(
      (p) =>
        p.at <= now && now - p.at <= TIMINGS.protectiveLife && p.sends < TIMINGS.protectiveSends,
    );
    if (before !== this.memory.pending.length) this.saveMemory();
  }

  armRetry() {
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.prunePending();
    if (this.memory.pending.length === 0 || this.stopped) return;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.session?.ready) this.sendPending();
      else {
        this.connectSoon();
        this.armRetry();
      }
    }, TIMINGS.protectiveRetry);
  }
}

/** An error message of the hub, shown bounded and printable only. */
export function cleanError(text) {
  const clean = String(text ?? '')
    .replace(/\p{Cc}/gu, '')
    .trim();
  return clean === '' ? 'E00' : [...clean].slice(0, LIMITS.errorLength).join('');
}
