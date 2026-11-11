// -----------------------------------------------------------------------------
// Constants: the Nobø Hub local API, the feature roles, the manifest keys, the
// limits and the timings.
//
// Written from the official document "Nobo Hub – API version 1.1 for
// communication between a client and a Nobo Hub" (Glen Dimplex Nordic AS,
// version 4, 2018-03-26; the manufacturer's link is dead, read from the copy
// of the Internet Archive). No third-party library is read nor ported.
//
//   - plain text over TCP port 27779, every command ended by a carriage return
//     (13), UTF-8, spaces of names sent as non-breaking spaces (C2 A0);
//   - handshake: "HELLO 1.1 <12-digit serial> <yyyyMMddHHmmss>", the hub
//     answers "HELLO <version>" or "REJECT <code>", then "HANDSHAKE" both ways;
//   - "G00" downloads everything (H00, H01 zones, H02 components, Y02
//     temperatures, H03 week profiles, H04 overrides, V06, then H05 = the end);
//   - the hub pushes every change to the connected clients; the session is
//     closed after 30 s without traffic ("KEEPALIVE" every 14 s);
//   - the hub announces itself every 2 s in UDP broadcast on port 10000:
//     "__NOBOHUB__" and the first 9 digits of its serial.
// -----------------------------------------------------------------------------

export const API = {
  port: 27779,
  version: '1.1',
  discoveryPort: 10000,
  announce: /^__NOBOHUB__(\d{9})$/,
};

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  TEMPERATURE: 'temperature',
  COMFORT: 'comfort-temperature',
  ECO: 'eco-temperature',
  MODE: 'mode',
  ACTIVE: 'mode-in-force',
};

/** The modes of an override (Override.Mode). */
export const OVERRIDE_MODE = { NORMAL: 0, COMFORT: 1, ECO: 2, AWAY: 3 };
/** The types of an override (Override.Type). */
export const OVERRIDE_TYPE = { NOW: 0, TIMER: 1, FROM_TO: 2, CONSTANT: 3 };
/** The targets of an override (Override.Target). */
export const OVERRIDE_TARGET = { HUB: 0, ZONE: 1 };

/**
 * The status of a week profile slot (the last digit): 0 eco, 1 comfort,
 * 2 anti-frost ("away"), 3 off. The structure section of the document also
 * names 4 for off: both read as off.
 */
export const PROFILE_STATUS = { ECO: 0, COMFORT: 1, AWAY: 2, OFF: 3, OFF_ALT: 4 };

/**
 * The mode of a zone or of the whole house, a `text/select` in Gladys (works
 * on every Gladys 5.x; `thermostat/preset` needs 5.2 and its "in force"
 * counterpart is not known to the SDK 0.16): the standing choice, and the
 * override mode each one writes.
 */
export const MODE = { SCHEDULE: 'schedule', COMFORT: 'comfort', ECO: 'eco', AWAY: 'away' };
export const MODE_TO_OVERRIDE = new Map([
  [MODE.SCHEDULE, OVERRIDE_MODE.NORMAL],
  [MODE.COMFORT, OVERRIDE_MODE.COMFORT],
  [MODE.ECO, OVERRIDE_MODE.ECO],
  [MODE.AWAY, OVERRIDE_MODE.AWAY],
]);
export const OVERRIDE_TO_MODE = new Map([...MODE_TO_OVERRIDE].map(([mode, o]) => [o, mode]));

/** The mode in force in a zone (read only): its override, else its week profile. */
export const ACTIVE = { COMFORT: 'comfort', ECO: 'eco', AWAY: 'away', OFF: 'off' };

/** The comfort and eco temperatures of a zone: integers, 7 to 30 °C (the document). */
export const SETPOINT = { min: 7, max: 30 };

/** A temperature outside this range (°C) is not a measurement. */
export const TEMPERATURE_RANGE = { min: -30, max: 60 };

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

export const LIMITS = {
  /** Gladys: 300 states per minute; a margin is kept. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** A line from the hub longer than this is not ours: the session is closed. */
  lineBytes: 8 * 1024,
  /** The messages of one G00 download; beyond, the session is closed. */
  syncMessages: 2_000,
  /** Zones, components, week profiles and overrides kept. */
  zones: 64,
  components: 256,
  profiles: 64,
  overrides: 128,
  /** Names: 100 bytes (zones) to 150 bytes (hub, profiles) on the hub; cut to this length here. */
  nameLength: 60,
  /** An error message of the hub shown in a refusal: cut to this length. */
  errorLength: 80,
  /** Datagrams of a discovery scan looked at. */
  datagrams: 64,
  /** Commands waiting their turn (a scene setting several zones). */
  commandQueue: 16,
  /** Away commands kept until confirmed. */
  pending: 70,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** TCP connection, then each step of the handshake. */
  connectTimeout: 5 * SECOND,
  handshakeTimeout: 5 * SECOND,
  /** The G00 download ends with H05 by then, or the session is closed. */
  syncTimeout: 20 * SECOND,
  /** The hub closes after 30 s without traffic: a keepalive after 14 s of silence from us. */
  keepalive: 14 * SECOND,
  /** Nothing received for this long: everything asked again (G00); no end within syncTimeout = frozen, closed. */
  idleTimeout: 75 * SECOND,
  /** A dead session is opened again after 5 s, 10 s, 20 s… up to 5 min. */
  reconnect: [
    5 * SECOND,
    10 * SECOND,
    20 * SECOND,
    40 * SECOND,
    80 * SECOND,
    160 * SECOND,
    5 * MINUTE,
  ],
  /** A session open this long resets the backoff. */
  stableAfter: 2 * MINUTE,
  /** The UDP scan for the hub when no address is set (it announces every 2 s). */
  scanSeconds: 5,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The active preset follows the week profile: evaluated every 30 s. */
  evaluate: 30 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): written by 3 s after the click
   * or refused unsent; the answer of the hub awaited until 3.5 s, after which
   * the command is "sent, without confirmation".
   */
  commandSendBy: 3_000,
  commandAnswerBy: 3_500,
  /** An away command waits at most this long for the answer of a command in flight before it is written. */
  protectiveWait: 250,
  /** An away command not confirmed is written again (6 times at most, a new session each time), until this deadline. */
  protectiveRetry: 10 * SECOND,
  protectiveLife: 15 * MINUTE,
  protectiveSends: 6,
  /** The configuration of Gladys not read: new tries 5 s, 15 s, 1 min, then every 5 min. */
  configRetry: [5 * SECOND, 15 * SECOND, MINUTE, 5 * MINUTE],
  /** /data unreadable: read again every 10 s. */
  storeRetry: 10 * SECOND,
  /** The "Test the connection" button waits 30 s in Gladys: it answers by 20 s. */
  testBudget: 20 * SECOND,
};
