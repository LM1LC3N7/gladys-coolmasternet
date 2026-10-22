// -----------------------------------------------------------------------------
// CoolMasterNet constants, manifest keys, limits and timings.
//
// A CoolMasterNet bridge (CoolAutomation) sits on the bus of a ducted, VRF or
// multi-split air-conditioning system and serves its ASCII command line over
// TCP (port 10102 by default), as pycoolmasternet-async (MIT, 0.2.6) and the
// Home Assistant "coolmaster" integration use it:
//   connect, wait for the prompt ">", send "<command>\n", read until "\n>";
//   `set`            the general info of the bridge (its serial number);
//   `ls2` / `stat2`  one line per indoor unit (on/off, setpoint, temperature,
//                    fan, mode, error code, filter sign, demand);
//   `query <uid> s`  the louver (swing) position of a unit;
//   `on|off <uid>`, `cool|heat|auto|dry|fan <uid>`, `temp <uid> <t>`,
//   `fspeed <uid> <speed>`, `swing <uid> <a|h|3|4|6|v|x>` the commands.
// The command line has no password: the bridge must stay on a trusted network.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 10102;

/** Feature keys (the last part of the feature external ids): frozen. */
export const FEATURES = {
  POWER: 'power',
  MODE: 'mode',
  SETPOINT: 'target-temperature',
  FAN: 'fan-speed',
  SWING: 'swing-vertical',
  ROOM: 'room-temperature',
  FILTER: 'clean-filter',
  ERROR: 'error-code',
};

export const COMMAND_FEATURES = [
  FEATURES.POWER,
  FEATURES.MODE,
  FEATURES.SETPOINT,
  FEATURES.FAN,
  FEATURES.SWING,
];

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** Gladys core values (server/utils/constants.js; the SDK does not export them). */
export const AC_MODE = { AUTO: 0, COOLING: 1, HEATING: 2, DRYING: 3, FAN: 4 };
export const AC_FAN_SPEED = { AUTO: 0, LOW: 1, MID: 3, HIGH: 5, QUIET: 6, TURBO: 7 };
export const AC_SWING_VERTICAL = {
  OFF: 0,
  SWING: 1,
  POSITION_1: 2,
  POSITION_2: 3,
  POSITION_3: 4,
  POSITION_4: 5,
  POSITION_5: 6,
};

/**
 * The setpoint Gladys may send, in °C: the usual range of indoor units. A
 * value outside is refused, never brought into it.
 */
export const SETPOINT = { min: 16, max: 30 };

export const POLL_INTERVAL = { min: 30, max: 600, default: 60 };

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Bridges of one installation. */
  bridges: 4,
  /** Indoor units read per bridge (a CoolMasterNet serves up to 64 per line). */
  unitsPerBridge: 64,
  /** One answer of the bridge (64 units of about 40 characters: under 4 KB). */
  responseBytes: 32 * 1024,
  /** What may come before the first prompt. */
  promptBytes: 4 * 1024,
  /** Lines of one answer, and characters of one line. */
  lines: 128,
  lineLength: 200,
  /** Longest text kept from an answer (versions, error codes). */
  textLength: 40,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** The whole poll of one bridge (connection, `set`, status, louvers). */
  pollBudget: 30 * SECOND,
  /** One request of a poll (pycoolmasternet: 1 s, 5 s with the louvers). */
  requestTimeout: 5 * SECOND,
  connectTimeout: 5 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The time of the last attempt is written to /data at most this often. */
  attemptSave: MINUTE,
  /** The "Test the connection" button: at most this often, answered within 80 s (timeout 90 s). */
  testCooldown: 10 * SECOND,
  testAnswerBy: 80 * SECOND,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): written by 3.5 s after the click
   * or refused unsent; the answer and the read back are awaited until 4.3 s,
   * after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** One read of the state after a command that was not confirmed. */
  followUp: 5 * SECOND,
  /** A command not confirmed keeps its guard until the state shows it, or 90 s. */
  guard: 90 * SECOND,
};

/** Connections to one bridge at once: polls and commands share 2, a stop has its own (3 in all, as pycoolmasternet). */
export const CONNECTIONS = { shared: 2 };
