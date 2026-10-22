// -----------------------------------------------------------------------------
// One indoor unit of a CoolMasterNet bridge -> one Gladys device and its
// states, and the change a Gladys command asks for (pure).
//
// Identifier rule (frozen, it fixes the external ids):
//   `ext:<selector>:coolmasternet:<bridge>:<unit>`
//   <bridge>: the serial number of the bridge (the first of the `set` keys
//     "serial number", "serial", "s/n", "sn", "uid", "mac" holding 4 to 40
//     letters, digits, "-" or ":"; lower case, letters and digits only); when
//     the bridge shows none of them, the readable fallback "a-" + the address
//     typed (dots and colons as dashes): those devices then follow the address.
//   <unit>: the unit id of the bus, "L1.100" -> "l1-100".
// The feature keys and the option values are published forever.
//
// The air-conditioning features of the core, as MELCloud and the other
// climate integrations: on/off (`air-conditioning/binary`; a "turn everything
// off" reaching it only stops the unit, which is the protective way), mode,
// setpoint, fan speed, louver (only with "Read the louvers"); the room
// temperature, the filter sign and the error code. Units are those the core
// lists (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C, converted when the bridge
// shows °F. A device published again never loses a feature: those of the
// device already created in Gladys are kept as they are.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  AC_FAN_SPEED,
  AC_MODE,
  AC_SWING_VERTICAL,
  COMMAND_FEATURES,
  FEATURES,
  SETPOINT,
} from './constants.js';
import {
  DEVICE_NAME,
  ERROR_TEXTS,
  FAN_NAMES,
  FEATURE_NAMES,
  MODE_NAMES,
  SWING_NAMES,
  word,
} from './i18n.js';
import { COMMAND_FANS, toCelsius } from './coolmaster/protocol.js';

/** Bridge mode -> Gladys AC_MODE, in display order. */
export const MODE_MAP = [
  ['auto', AC_MODE.AUTO],
  ['cool', AC_MODE.COOLING],
  ['heat', AC_MODE.HEATING],
  ['dry', AC_MODE.DRYING],
  ['fan', AC_MODE.FAN],
];
/** Bridge fan speed -> Gladys AC_FAN_SPEED (vlow and top are shown, never sent). */
export const FAN_MAP = [
  ['auto', AC_FAN_SPEED.AUTO],
  ['vlow', AC_FAN_SPEED.QUIET],
  ['low', AC_FAN_SPEED.LOW],
  ['med', AC_FAN_SPEED.MID],
  ['high', AC_FAN_SPEED.HIGH],
  ['top', AC_FAN_SPEED.TURBO],
];
/** Bridge louver -> Gladys AC_SWING_VERTICAL. */
export const SWING_MAP = [
  ['auto', AC_SWING_VERTICAL.SWING],
  ['horizontal', AC_SWING_VERTICAL.POSITION_1],
  ['30', AC_SWING_VERTICAL.POSITION_2],
  ['45', AC_SWING_VERTICAL.POSITION_3],
  ['60', AC_SWING_VERTICAL.POSITION_4],
  ['vertical', AC_SWING_VERTICAL.POSITION_5],
  ['stop', AC_SWING_VERTICAL.OFF],
];

const toGladys = (table, value) => table.find((row) => row[0] === value)?.[1];
const fromGladys = (table, value) => table.find((row) => row[1] === value)?.[0];

const command = (definition) => ({
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...definition,
});
const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});

const options = (table, names, language) =>
  table
    .filter(([name]) => Object.hasOwn(names, name))
    .map(([name, value], index) => ({
      value,
      label: word(names[name], language),
      sort_order: index,
    }));

/** The features, by key, in display order. */
export function definitions(language) {
  return {
    [FEATURES.POWER]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.BINARY,
      min: 0,
      max: 1,
    }),
    [FEATURES.MODE]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.MODE,
      min: AC_MODE.AUTO,
      max: AC_MODE.FAN,
      supported_options: options(MODE_MAP, MODE_NAMES, language),
    }),
    [FEATURES.SETPOINT]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.TARGET_TEMPERATURE,
      unit: U.CELSIUS,
      min: SETPOINT.min,
      max: SETPOINT.max,
    }),
    [FEATURES.FAN]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.FAN_SPEED,
      min: AC_FAN_SPEED.AUTO,
      max: AC_FAN_SPEED.TURBO,
      supported_options: options(FAN_MAP, FAN_NAMES, language),
    }),
    [FEATURES.SWING]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.SWING_VERTICAL,
      min: AC_SWING_VERTICAL.OFF,
      max: AC_SWING_VERTICAL.POSITION_5,
      supported_options: options(SWING_MAP, SWING_NAMES, language),
    }),
    [FEATURES.ROOM]: sensor({
      category: C.TEMPERATURE_SENSOR,
      type: T.SENSOR.DECIMAL,
      unit: U.CELSIUS,
      min: -40,
      max: 60,
    }),
    [FEATURES.FILTER]: sensor({
      category: C.UNKNOWN,
      type: T.UNKNOWN.UNKNOWN,
      min: 0,
      max: 1,
    }),
    [FEATURES.ERROR]: sensor({
      category: C.TEXT,
      type: T.TEXT.TEXT,
      min: 0,
      max: 0,
      keep_history: false,
    }),
  };
}

export const KEYS = Object.values(FEATURES);

/** The fields of a feature Gladys stores (what is kept of a created feature). */
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

/** "L1.100" -> "l1-100", and back. */
export const unitKey = (uid) => uid.toLowerCase().replace('.', '-');
export const uidOf = (key) => key.toUpperCase().replace('-', '.');

/** The bridge part of the ids: the serial, else "a-" + the address. */
export const fallbackId = (addressText) =>
  `a-${addressText.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 80);

export const deviceIds = (gladys, bridgeId, uid) =>
  gladys.externalIds('coolmasternet', `${bridgeId}:${unitKey(uid)}`);

/** The bridge id, unit id and feature key of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const match = /:coolmasternet:([a-z0-9-]{4,80}):(l\d{1,2}-\d{2,4}):([a-z-]{1,40})$/.exec(
    externalId,
  );
  return match && KEYS.includes(match[3])
    ? { bridge: match[1], uid: uidOf(match[2]), key: match[3] }
    : undefined;
}

/** The bridge id and unit id of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = /:coolmasternet:([a-z0-9-]{4,80}):(l\d{1,2}-\d{2,4})$/.exec(
    String(externalId ?? '').slice(0, 300),
  );
  return match ? { bridge: match[1], uid: uidOf(match[2]) } : undefined;
}

/**
 * The Gladys device of one unit. `created`: the device already created in
 * Gladys, whose features are kept when the new build lacks them.
 */
export function buildDevice(gladys, { bridgeId, uid, version, swing }, { language, created }) {
  const ids = deviceIds(gladys, bridgeId, uid);
  const defs = definitions(language);
  const params = [
    { name: 'bridge', value: bridgeId },
    { name: 'unit', value: uid },
  ];
  if (version) {
    params.push({ name: 'firmware', value: version });
  }
  const keys = KEYS.filter((key) => key !== FEATURES.SWING || swing);
  const built = {
    name: word(DEVICE_NAME(uid), language),
    external_id: ids.device,
    model: 'CoolMasterNet',
    should_poll: false,
    features: keys.map((key) => ({
      name: word(FEATURE_NAMES[key], language),
      external_id: ids.feature(key),
      ...defs[key],
    })),
    params,
  };
  return keepCreatedFeatures(built, created);
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
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

/** A temperature of the bridge in °C (converted from °F), rounded to `step`. */
export function celsius(value, unit, step = 0.1) {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const c = unit === 'F' ? toCelsius(value) : unit === 'C' ? value : undefined;
  if (c === undefined) {
    return undefined;
  }
  const rounded = Math.round(c / step) * step;
  return Number(rounded.toFixed(2));
}

/** The current values of one unit (unknown values are left out, never sent as undefined or NaN). */
export function unitStates(ids, state, { language, swing }) {
  const states = [];
  const add = (key, value) => {
    if (value !== undefined && value !== null) {
      states.push({ device_feature_external_id: ids.feature(key), ...value });
    }
  };
  const number = (n) => (Number.isFinite(n) ? { state: n } : undefined);
  add(FEATURES.POWER, typeof state.on === 'boolean' ? { state: state.on ? 1 : 0 } : undefined);
  add(FEATURES.MODE, number(toGladys(MODE_MAP, state.mode)));
  add(FEATURES.SETPOINT, number(celsius(state.setpoint, state.unit, 0.5)));
  add(FEATURES.FAN, number(toGladys(FAN_MAP, state.fan)));
  if (swing) {
    add(FEATURES.SWING, number(toGladys(SWING_MAP, state.swing)));
  }
  const room = celsius(state.temperature, state.unit, 0.1);
  add(FEATURES.ROOM, room !== undefined && room >= -40 && room <= 60 ? { state: room } : undefined);
  add(
    FEATURES.FILTER,
    typeof state.filter === 'boolean' ? { state: state.filter ? 1 : 0 } : undefined,
  );
  if (state.error === null) {
    add(FEATURES.ERROR, { text: word(ERROR_TEXTS.none, language) });
  } else if (typeof state.error === 'string') {
    add(FEATURES.ERROR, { text: state.error });
  }
  return states;
}

/** A command value, strictly: a finite number, or a text that is exactly one. */
export function strictNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,3}(?:\.\d{1,3})?$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The change a command asks, checked on its own (before any read), or
 * undefined when the value is not one the feature takes. The setpoint is in
 * °C, rounded to 0.5 °C, within SETPOINT (never brought into it).
 */
export function commandValue(key, value) {
  if (!COMMAND_FEATURES.includes(key)) {
    return undefined;
  }
  const n = strictNumber(value);
  if (n === undefined) {
    return undefined;
  }
  switch (key) {
    case FEATURES.POWER:
      return n === 0 || n === 1 ? { on: n === 1 } : undefined;
    case FEATURES.MODE: {
      const mode = fromGladys(MODE_MAP, n);
      return mode === undefined ? undefined : { mode };
    }
    case FEATURES.FAN: {
      const fan = fromGladys(FAN_MAP, n);
      return fan !== undefined && COMMAND_FANS.includes(fan) ? { fan } : undefined;
    }
    case FEATURES.SWING: {
      const swing = fromGladys(SWING_MAP, n);
      return swing === undefined ? undefined : { swing };
    }
    case FEATURES.SETPOINT: {
      const celsiusValue = Math.round(n * 2) / 2;
      return { setpointC: celsiusValue };
    }
    default:
      return undefined;
  }
}
