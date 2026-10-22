// -----------------------------------------------------------------------------
// The pure parts: the answers of the bridge, the command lines, the device
// values and the persisted state, against hostile input too.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandLine,
  parseInfo,
  parseStatus,
  parseStatusLine,
  parseSwing,
  serialOf,
  setpointFor,
} from '../src/coolmaster/protocol.js';
import { commandValue, fallbackId, parseFeatureId, unitStates } from '../src/devices.js';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { normalizeMemory, serializeMemory } from '../src/store.js';
import { StatePublisher } from '../src/publisher.js';

test('status lines: ls2 (9 fields) and stat2 (8 fields), as pycoolmasternet reads them', () => {
  assert.deepEqual(parseStatusLine('L1.100 ON 20C 25,5C Low Cool OK - 1'), {
    uid: 'L1.100',
    on: true,
    unit: 'C',
    setpoint: 20,
    temperature: 25.5,
    fan: 'low',
    mode: 'cool',
    error: null,
    filter: false,
    demand: true,
  });
  const f = parseStatusLine('L1.101 OFF 68F 50F High Heat Err1 # ');
  assert.equal(f.on, false);
  assert.equal(f.unit, 'F');
  assert.equal(f.error, 'Err1');
  assert.equal(f.filter, true);
  assert.equal(f.demand, undefined);
});

test('a field that is not one of the known forms is unknown, never a default', () => {
  const u = parseStatusLine('L1.102 MAYBE 20X 25C ULTRA Turbo OK ? 7');
  assert.equal(u.on, undefined);
  assert.equal(u.setpoint, undefined);
  assert.equal(u.temperature, undefined, 'a room temperature without a known setpoint unit');
  assert.equal(u.fan, undefined);
  assert.equal(u.mode, undefined);
  assert.equal(u.filter, undefined);
  assert.equal(u.demand, undefined);
  assert.equal(parseStatusLine('L1.100 ON 20C'), undefined);
  assert.equal(parseStatusLine('Lx.100 ON 20C 25C Low Cool OK - 1'), undefined);
  assert.equal(parseStatusLine('L1.100; ON 20C 25C Low Cool OK - 1'), undefined);
});

test('the status is bounded and linear on a hostile answer', () => {
  const many = Array.from({ length: 1000 }, (_, i) => `L1.${100 + i} ON 20C 25C Low Cool OK - 1`);
  assert.equal(parseStatus(many.join('\r\n')).size, 64);
  const long = `L1.100 ON 20C 25C Low Cool OK - 1${' x'.repeat(100_000)}`;
  const started = Date.now();
  assert.equal(parseStatus(long).size, 0);
  assert.ok(Date.now() - started < 500);
});

test('set: keys in a Map, the serial by its frozen rule, no prototype pollution', () => {
  const info = parseInfo(
    '__proto__ : polluted\r\nconstructor : x\r\nversion : 0.9.1\r\nserial number : 283B9600-1234\r\nS/N : other',
  );
  assert.equal({}.polluted, undefined);
  assert.equal(info.get('__proto__'), 'polluted');
  assert.equal(serialOf(info), '283b96001234');
  assert.equal(serialOf(parseInfo('S/N : ABCD-12\r\n')), 'abcd12');
  assert.equal(serialOf(parseInfo('serial : x\r\n')), undefined);
  assert.equal(serialOf(parseInfo('serial : 12 34 56\r\n')), undefined);
  assert.equal(serialOf(parseInfo('version : 1\r\n')), undefined);
});

test('louvers and command lines; a uid that is not one is never put in a command', () => {
  assert.equal(parseSwing('a\r\n'), 'auto');
  assert.equal(parseSwing('6'), '60');
  assert.equal(parseSwing('constructor'), undefined);
  assert.equal(parseSwing('__proto__'), undefined);
  assert.equal(commandLine('L1.100', { on: false }), 'off L1.100');
  assert.equal(commandLine('L1.100', { mode: 'heat' }), 'heat L1.100');
  assert.equal(commandLine('L1.100', { setpoint: 22.5 }), 'temp L1.100 22.5');
  assert.equal(commandLine('L1.100', { fan: 'med' }), 'fspeed L1.100 med');
  assert.equal(commandLine('L1.100', { swing: 'vertical' }), 'swing L1.100 v');
  assert.throws(() => commandLine('L1.100\nreset', { on: true }));
  assert.throws(() => commandLine('L1.100', { mode: 'reset' }));
  assert.throws(() => commandLine('L1.100', { fan: 'top' }));
  assert.equal(setpointFor(22.3, 'C'), 22.5);
  assert.equal(setpointFor(23, 'F'), 73);
});

test('commands: strict values, the setpoint in 0.5 °C', () => {
  assert.deepEqual(commandValue('power', 0), { on: false });
  assert.deepEqual(commandValue('power', '1'), { on: true });
  assert.equal(commandValue('power', ''), undefined);
  assert.equal(commandValue('power', null), undefined);
  assert.equal(commandValue('power', true), undefined);
  assert.deepEqual(commandValue('mode', 2), { mode: 'heat' });
  assert.deepEqual(commandValue('fan-speed', 3), { fan: 'med' });
  assert.equal(commandValue('fan-speed', 7), undefined, 'top is shown, never sent');
  assert.deepEqual(commandValue('target-temperature', 21.3), { setpointC: 21.5 });
  assert.equal(commandValue('target-temperature', Number.NaN), undefined);
  assert.equal(commandValue('room-temperature', 20), undefined);
});

test('external ids: parsed strictly, the fallback readable', () => {
  assert.deepEqual(parseFeatureId('ext:sel:coolmasternet:283b96001234:l1-100:power'), {
    bridge: '283b96001234',
    uid: 'L1.100',
    key: 'power',
  });
  assert.equal(parseFeatureId('ext:sel:coolmasternet:283b96001234:l1-100:hack'), undefined);
  assert.equal(parseFeatureId('ext:sel:other:283b96001234:l1-100:power'), undefined);
  assert.equal(fallbackId('192.168.1.50:10103'), 'a-192-168-1-50-10103');
});

test('states: never undefined nor NaN', () => {
  const ids = { feature: (k) => k };
  const states = unitStates(
    ids,
    { on: undefined, setpoint: Number.NaN, unit: 'C', temperature: 99, error: undefined },
    { language: 'en', swing: true },
  );
  assert.deepEqual(states, []);
});

test('addresses: IPv4 or host name, port 10102 by default, 4 bridges at most', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), { host: '192.168.1.50', port: 10102 });
  assert.deepEqual(parseAddress('coolmaster.lan:10103'), { host: 'coolmaster.lan', port: 10103 });
  assert.equal(parseAddress('1.2.3'), undefined);
  assert.equal(parseAddress('a b'), undefined);
  const c = normalizeConfig({ addresses: '1.1.1.1, 1.1.1.2, 1.1.1.3, 1.1.1.4, 1.1.1.5, bad_host' });
  assert.equal(c.addresses.length, 4);
  assert.equal(c.dropped, 1);
  assert.equal(c.allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
});

test('the persisted state: known keys only, an attempt in the future counts as now', () => {
  const now = 1_000_000;
  const raw = JSON.parse(
    '{"bridges":{"__proto__":{"serial":"x"},"192.168.1.50":{"serial":"283b96001234","attemptAt":2000000},"bad key!":{}}}',
  );
  const memory = normalizeMemory(raw, now);
  assert.deepEqual([...memory.bridges.keys()], ['192.168.1.50']);
  assert.equal(memory.bridges.get('192.168.1.50').attemptAt, now);
  assert.deepEqual(serializeMemory(memory), {
    bridges: { '192.168.1.50': { serial: '283b96001234', attemptAt: now } },
  });
  assert.deepEqual(normalizeMemory('garbage', now).bridges.size, 0);
});

test('the publisher keeps to 300 states a minute, even with many units', async () => {
  let clock = 0;
  const sent = [];
  const publisher = new StatePublisher({
    gladys: {
      publishChangedStates: async (batch) => {
        sent.push(...batch);
        return { count: batch.length };
      },
    },
    logger: { warn() {} },
    now: () => clock,
    timers: { setInterval() {}, clearInterval() {} },
  });
  for (let i = 0; i < 500; i += 1) {
    publisher.push(`f${i}`, { state: i });
  }
  await Promise.all([publisher.flush(), publisher.flush()]);
  for (let i = 0; i < 10; i += 1) {
    clock += 1_000;
    await publisher.flush();
  }
  assert.equal(sent.length, 300);
  clock += 60_000;
  await publisher.flush();
  await publisher.flush();
  assert.equal(sent.length, 500);
});
