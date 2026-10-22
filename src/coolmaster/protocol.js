// -----------------------------------------------------------------------------
// The CoolMasterNet ASCII protocol, pure: what the answers mean and what the
// commands look like. Ported from pycoolmasternet-async 0.2.6 (MIT,
// coolmasternet.py): the `set` info lines, the 8- and 9-field status lines of
// `stat2` / `ls2`, the louver characters, the command words.
//
// Everything here reads text from the network: one pass per line, bounded
// lengths, values kept in Maps or plain objects built field by field (never
// keyed by what the bridge sent). A field that is not exactly one of the known
// forms is undefined (unknown), never a default.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

/** Modes the command line knows (also the command words). */
export const MODES = ['auto', 'cool', 'dry', 'fan', 'heat'];
/** Fan speeds the status shows; only COMMAND_FANS are sent (the words Home Assistant sends). */
export const FANS = ['vlow', 'low', 'med', 'high', 'top', 'auto'];
export const COMMAND_FANS = ['low', 'med', 'high', 'auto'];
/** Louver characters of `query <uid> s` and `swing <uid> <c>`. */
export const SWINGS = {
  a: 'auto',
  h: 'horizontal',
  3: '30',
  4: '45',
  6: '60',
  v: 'vertical',
  x: 'stop',
};

/** A unit id: line and address, e.g. "L1.100" (the only form put in a command). */
export const UID = /^L\d{1,2}\.\d{2,4}$/;

/** A short text without control characters, else undefined. */
export function cleanText(value, max = LIMITS.textLength) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return clean === '' ? undefined : clean.slice(0, max);
}

/** The lines of an answer, bounded in number and length, empty ones left out. */
export function linesOf(text) {
  const lines = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (lines.length >= LIMITS.lines) {
      break;
    }
    const line = raw.slice(0, LIMITS.lineLength).trim();
    if (line !== '') {
      lines.push(line);
    }
  }
  return lines;
}

/** `set`: "key : value" lines -> Map of lower-case keys (first one wins). */
export function parseInfo(text) {
  const info = new Map();
  for (const line of linesOf(text)) {
    const index = line.indexOf(':');
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim().toLowerCase().replace(/\s+/g, ' ');
    const value = cleanText(line.slice(index + 1));
    if (key !== '' && value !== undefined && !info.has(key)) {
      info.set(key, value);
    }
  }
  return info;
}

/**
 * The identifier of the bridge, by a frozen rule (it keys the external ids):
 * the first of these `set` keys whose value is 4 to 40 letters, digits, "-"
 * or ":", lower-cased, letters and digits only. undefined when none.
 */
export const SERIAL_KEYS = ['serial number', 'serial', 's/n', 'sn', 'uid', 'mac'];
export function serialOf(info) {
  for (const key of SERIAL_KEYS) {
    const value = info.get(key);
    if (typeof value === 'string' && /^[A-Za-z0-9:-]{4,40}$/.test(value)) {
      const serial = value.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (serial.length >= 4) {
        return serial;
      }
    }
  }
  return undefined;
}

/** The firmware version shown in the device params, else undefined. */
export const versionOf = (info) => info.get('version') ?? info.get('ver') ?? undefined;

/** "20C", "68F", "25,5C", "-3.5C" -> { value, unit }, else undefined. */
export function parseTemperature(field) {
  const match = /^(-?\d{1,3}(?:[.,]\d{1,2})?)([CF])$/.exec(field ?? '');
  if (!match) {
    return undefined;
  }
  return { value: Number(match[1].replace(',', '.')), unit: match[2] === 'F' ? 'F' : 'C' };
}

/**
 * One status line of `ls2` (9 fields, with demand) or `stat2` (8 fields):
 * "L1.100 ON 20C 25,5C Low Cool OK - 1". -> the unit, or undefined when the
 * line is not a status line (its uid or its field count). Each field that
 * is not one of the known forms is undefined.
 */
export function parseStatusLine(line) {
  const fields = String(line ?? '')
    .trim()
    .split(/\s+/);
  if (fields.length !== 8 && fields.length !== 9) {
    return undefined;
  }
  const [uid, power, setpoint, room, fan, mode, error, filter, demand] = fields;
  if (!UID.test(uid)) {
    return undefined;
  }
  const target = parseTemperature(setpoint);
  const temperature = parseTemperature(room);
  const fanName = fan.toLowerCase();
  const modeName = mode.toLowerCase();
  return {
    uid,
    on: power === 'ON' ? true : power === 'OFF' ? false : undefined,
    unit: target?.unit,
    setpoint: target?.value,
    temperature: temperature && temperature.unit === target?.unit ? temperature.value : undefined,
    fan: FANS.includes(fanName) ? fanName : undefined,
    mode: MODES.includes(modeName) ? modeName : undefined,
    error: error === 'OK' ? null : cleanText(error, 16),
    filter:
      filter === '#' || filter === '1'
        ? true
        : filter === '-' || filter === '0'
          ? false
          : undefined,
    demand:
      demand === undefined ? undefined : demand === '1' ? true : demand === '0' ? false : undefined,
  };
}

/** Every status line of an answer, by uid (the first of each uid), bounded. */
export function parseStatus(text) {
  const units = new Map();
  for (const line of linesOf(text)) {
    if (units.size >= LIMITS.unitsPerBridge) {
      break;
    }
    const unit = parseStatusLine(line);
    if (unit && !units.has(unit.uid)) {
      units.set(unit.uid, unit);
    }
  }
  return units;
}

/** `query <uid> s` -> the louver name, else undefined. */
export function parseSwing(text) {
  const value = linesOf(text)[0];
  return value !== undefined && Object.hasOwn(SWINGS, value) ? SWINGS[value] : undefined;
}

/** °F <-> °C. */
export const toCelsius = (f) => ((f - 32) * 5) / 9;
export const toFahrenheit = (c) => (c * 9) / 5 + 32;

/** The setpoint written for a value in °C, in the unit the bridge shows: 0.5 °C, or 1 °F. */
export function setpointFor(celsius, unit) {
  if (unit === 'F') {
    return Math.round(toFahrenheit(celsius));
  }
  return Math.round(celsius * 2) / 2;
}

/** A number as the command line takes it: "22", "22.5". */
export const numberText = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The command line of a change, on a uid already checked against UID. */
export function commandLine(uid, change) {
  if (!UID.test(uid)) {
    throw new Error('Invalid unit id');
  }
  if (change.on !== undefined) {
    return `${change.on ? 'on' : 'off'} ${uid}`;
  }
  if (change.mode !== undefined && MODES.includes(change.mode)) {
    return `${change.mode} ${uid}`;
  }
  if (change.setpoint !== undefined && Number.isFinite(change.setpoint)) {
    return `temp ${uid} ${numberText(change.setpoint)}`;
  }
  if (change.fan !== undefined && COMMAND_FANS.includes(change.fan)) {
    return `fspeed ${uid} ${change.fan}`;
  }
  if (change.swing !== undefined) {
    const char = Object.keys(SWINGS).find((c) => SWINGS[c] === change.swing);
    if (char !== undefined) {
      return `swing ${uid} ${char}`;
    }
  }
  throw new Error('Invalid change');
}
