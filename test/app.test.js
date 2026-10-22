// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and fake bridges behind `connect`. Timers and Date are mocked: the
// tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CoolMasterApp } from '../src/app.js';
import { ACTIONS, MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  HOST,
  HOST2,
  NOW,
  SERIAL,
  SERIAL2,
  bridge,
  fakeBridges,
  settle,
  unit,
} from './helpers/fakeBridge.js';

const CONFIG = { addresses: HOST };
const ALLOWED = { addresses: HOST, allow_commands: true };
const device = (uid = 'l1-100', serial = SERIAL) =>
  `ext:test-integration:coolmasternet:${serial}:${uid}`;
const feature = (key, uid, serial) => `${device(uid, serial)}:${key}`;

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

async function setup(
  t,
  { config = CONFIG, server = fakeBridges(), store = memoryStore(), create = true, logs = [] } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new CoolMasterApp({
    gladys,
    logger: recorder(logs),
    connect: (address, options) => server.connect(address, options),
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app);
  const advance = async (ms, step = 100) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  const connecting = gladys.connect();
  await settle();
  await advance(2 * SECOND);
  await connecting;
  t.after(() => app.stop());
  if (create) {
    for (const d of [...gladys.fake.discoveredDevices]) {
      await gladys.fake.deviceCreated(d);
    }
    await settle();
  }
  const send = async (key, value, { uid = 'l1-100', serial = SERIAL, wait = 6 * SECOND } = {}) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device(uid, serial));
    const target = d.features.find((f) => f.external_id === feature(key, uid, serial));
    const ack = gladys.fake.setValue(d, target, value);
    await settle();
    await advance(wait);
    return ack;
  };
  return { gladys, app, server, store, advance, logs, send };
}

const last = (gladys, key, uid, serial) => gladys.fake.lastState(feature(key, uid, serial));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const transportOf = (gladys, uid = 'l1-100') =>
  gladys.fake.transports.filter((x) => x.device_external_id === device(uid)).at(-1)?.transport;
const failure = (ack) => ack.error ?? ack.data?.error ?? ack.message ?? JSON.stringify(ack);

test('without an address, the status asks for it and nothing is connected', async (t) => {
  const server = fakeBridges();
  const { gladys } = await setup(t, { config: {}, server });
  assert.equal(server.connections.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /adresse IP/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  assert.equal(server.connections.length, 0);
});

test('first read: one session, the units become devices keyed by the serial number', async (t) => {
  const server = fakeBridges();
  const { gladys } = await setup(t, { server });
  assert.equal(server.connections.length, 1);
  assert.deepEqual(
    server.lines.map((l) => l.line),
    ['set', 'ls2'],
  );
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.deepEqual(ids, [device('l1-100'), device('l1-101')]);
  const d = gladys.fake.discoveredDevices.find((x) => x.external_id === device());
  assert.deepEqual(
    d.features.map((f) => f.external_id.split(':').at(-1)),
    [
      'power',
      'mode',
      'target-temperature',
      'fan-speed',
      'room-temperature',
      'clean-filter',
      'error-code',
    ],
  );
  for (const f of d.features) {
    if (f.unit) {
      assert.equal(f.unit, 'celsius');
    }
    if (f.category === 'air-conditioning' && f.type === 'binary') {
      assert.equal(f.read_only, false);
    }
  }
  assert.equal(last(gladys, 'power'), 1);
  assert.equal(last(gladys, 'mode'), 1);
  assert.equal(last(gladys, 'target-temperature'), 21);
  assert.equal(last(gladys, 'fan-speed'), 1);
  assert.equal(last(gladys, 'room-temperature'), 23.5);
  assert.equal(last(gladys, 'clean-filter'), 0);
  assert.equal(last(gladys, 'error-code'), 'Aucune erreur');
  assert.equal(last(gladys, 'power', 'l1-101'), 0);
  assert.equal(last(gladys, 'mode', 'l1-101'), 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).en, /1 of 1 bridge answering, 2 units/);
  assert.equal(transportOf(gladys), DEVICE_TRANSPORTS.LOCAL);
  for (const s of gladys.fake.publishedStates ?? []) {
    assert.ok(s.state === undefined || Number.isFinite(s.state));
  }
});

test('a bridge in °F: the values are converted to °C', async (t) => {
  const server = fakeBridges({
    [HOST]: bridge({ units: { 'L1.100': unit({ unit: 'F', setpoint: 70, temperature: 74.5 }) } }),
  });
  const { gladys } = await setup(t, { server });
  assert.equal(last(gladys, 'target-temperature'), 21);
  assert.equal(last(gladys, 'room-temperature'), 23.6);
});

test('an older firmware without ls2: stat2, remembered', async (t) => {
  const server = fakeBridges({ [HOST]: bridge({ stat2Only: true }) });
  const { gladys, advance } = await setup(t, { server });
  assert.deepEqual(
    server.lines.map((l) => l.line),
    ['set', 'ls2', 'stat2'],
  );
  assert.equal(last(gladys, 'power'), 1);
  await advance(MINUTE);
  assert.deepEqual(
    server.lines.slice(3).map((l) => l.line),
    ['set', 'stat2'],
  );
});

test('the louvers are read only when asked, and the feature then appears', async (t) => {
  const server = fakeBridges();
  const { gladys } = await setup(t, { server, config: { ...CONFIG, swing_support: true } });
  assert.deepEqual(
    server.lines.map((l) => l.line),
    ['set', 'ls2', 'query L1.100 s', 'query L1.101 s'],
  );
  assert.equal(last(gladys, 'swing-vertical'), 1);
});

test('never read sooner than the interval: button, connected, Discovery, same config, restart', async (t) => {
  const server = fakeBridges();
  const store = memoryStore();
  const { gladys, app, advance } = await setup(t, { server, store });
  assert.equal(server.connections.length, 1);
  assert.ok(store.data.bridges[HOST].attemptAt > 0, 'attempt kept in /data');
  assert.equal(store.data.bridges[HOST].serial, SERIAL);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /read again in/);
  await app.connected(CONFIG);
  await app.scan();
  await app.configUpdated(CONFIG);
  await advance(10 * SECOND);
  assert.equal(server.connections.length, 1);
  // A restart (a new app on the same /data) waits for the rest of the interval.
  const gladys2 = createFakeGladys({ config: CONFIG });
  const app2 = new CoolMasterApp({
    gladys: gladys2,
    logger: recorder([]),
    connect: (a, o) => server.connect(a, o),
    now: () => Date.now(),
    store,
  });
  t.after(() => app2.stop());
  await app2.start(CONFIG);
  await advance(30 * SECOND);
  assert.equal(server.connections.length, 1, 'not before the interval');
  await advance(25 * SECOND);
  assert.ok(server.connections.length >= 2);
});

test('the attempt time is written at most once a minute', async (t) => {
  const store = memoryStore();
  const { advance } = await setup(t, { store, config: { ...CONFIG, poll_interval: 30 } });
  const first = store.saves;
  await advance(30 * SECOND);
  const second = store.saves;
  await advance(30 * SECOND);
  assert.equal(second, first, '30 s later: not written');
  assert.equal(store.saves, first + 1, '60 s later: written');
});

test('a bridge that does not answer: backoff, unreachable badge, never sooner than the interval', async (t) => {
  const server = fakeBridges();
  const { gladys, advance } = await setup(t, { server });
  server.bridges[HOST].down = true;
  await advance(MINUTE);
  assert.equal(server.connections.length, 2);
  assert.equal(transportOf(gladys), DEVICE_TRANSPORTS.UNREACHABLE);
  assert.match(message(gladys).en, /No answer from: 192\.168\.1\.50/);
  await advance(57 * SECOND);
  assert.equal(server.connections.length, 2);
  await advance(2 * SECOND);
  assert.equal(server.connections.length, 3);
});

test('another bridge at the address: its own devices, commands to the old ones refused', async (t) => {
  const server = fakeBridges();
  const { gladys, advance, send, logs } = await setup(t, { server, config: ALLOWED });
  server.bridges[HOST].serial = SERIAL2;
  await advance(MINUTE);
  assert.ok(gladys.fake.discoveredDevices.some((d) => d.external_id === device('l1-100', SERIAL2)));
  assert.match(message(gladys).en, /Another bridge now answers/);
  assert.ok(logs.some((l) => /another bridge/.test(l)));
  const ack = await send('target-temperature', 22);
  assert.equal(ack.success, false);
  assert.equal(server.writes().length, 0);
});

test('a serial number unreadable this time: no state shown, no command, not another bridge', async (t) => {
  const server = fakeBridges();
  const { gladys, advance, send } = await setup(t, { server, config: ALLOWED });
  server.bridges[HOST].info = ['version : 0.9.1'];
  server.bridges[HOST].units['L1.100'].setpoint = 25;
  await advance(MINUTE);
  assert.equal(last(gladys, 'target-temperature'), 21);
  assert.match(message(gladys).en, /Serial number unreadable/);
  const ack = await send('target-temperature', 22);
  assert.equal(ack.success, false);
  assert.equal(server.writes().length, 0);
});

test('a bridge without any serial: the readable fallback id, kept', async (t) => {
  const server = fakeBridges({ [HOST]: bridge({ serial: undefined }) });
  const { gladys } = await setup(t, { server });
  assert.ok(
    gladys.fake.discoveredDevices.some((d) => d.external_id === device('l1-100', 'a-192-168-1-50')),
  );
});

test('commands are off by default: refused, nothing connected', async (t) => {
  const server = fakeBridges();
  const { send } = await setup(t, { server });
  const ack = await send('power', 0);
  assert.equal(ack.success, false);
  assert.match(failure(ack), /commandes/i);
  assert.equal(server.connections.length, 1);
});

test('a setpoint: checked, read just before, written, confirmed by the read back', async (t) => {
  const server = fakeBridges();
  const { gladys, send } = await setup(t, { server, config: ALLOWED });
  const before = server.lines.length;
  const ack = await send('target-temperature', 22.5);
  assert.equal(ack.success, true, failure(ack));
  assert.deepEqual(
    server.lines.slice(before).map((l) => l.line),
    ['set', 'ls2 L1.100', 'temp L1.100 22.5', 'ls2 L1.100'],
  );
  assert.equal(last(gladys, 'target-temperature'), 22.5);
});

test('a setpoint in °F is written in °F', async (t) => {
  const server = fakeBridges({
    [HOST]: bridge({ units: { 'L1.100': unit({ unit: 'F', setpoint: 70, temperature: 74 }) } }),
  });
  const { send } = await setup(t, { server, config: ALLOWED });
  const ack = await send('target-temperature', 23);
  assert.equal(ack.success, true, failure(ack));
  assert.equal(server.commands('temp').at(-1).line, 'temp L1.100 73');
});

test('values outside the bounds or not strict are refused without connecting', async (t) => {
  const server = fakeBridges();
  const { send } = await setup(t, { server, config: ALLOWED });
  for (const [key, value] of [
    ['target-temperature', 31],
    ['target-temperature', 15],
    ['target-temperature', 'abc'],
    ['target-temperature', ''],
    ['power', 2],
    ['mode', 9],
    ['fan-speed', 6],
    ['room-temperature', 20],
  ]) {
    const ack = await send(key, value);
    assert.equal(ack.success, false, `${key}=${value}`);
  }
  assert.equal(server.connections.length, 1);
});

test('already so: nothing written', async (t) => {
  const server = fakeBridges();
  const { send } = await setup(t, { server, config: ALLOWED });
  const ack = await send('mode', 1);
  assert.equal(ack.success, true);
  assert.equal(server.writes().length, 0);
});

test('not applied by the unit: "sent, without confirmation", one read 5 s later', async (t) => {
  const server = fakeBridges({ [HOST]: bridge({ applies: false }) });
  const { send } = await setup(t, { server, config: ALLOWED });
  const sessions = server.connections.length;
  const ack = await send('fan-speed', 5);
  assert.equal(ack.success, false);
  assert.match(failure(ack), /sans confirmation/);
  assert.equal(server.commands('fspeed').at(-1).line, 'fspeed L1.100 high');
  assert.equal(server.connections.length, sessions + 2, 'the command, then one follow-up read');
  // A second command is sent (the guard), never answered "already so".
  const again = await send('fan-speed', 5);
  assert.equal(again.success, false);
  assert.equal(server.commands('fspeed').length, 2);
});

test('silence after the write: "sent, without confirmation" within the ack time', async (t) => {
  const server = fakeBridges({ [HOST]: bridge({ silent: ['on'] }) });
  const { send } = await setup(t, { server, config: ALLOWED });
  const ack = await send('power', 1, { uid: 'l1-101' });
  assert.equal(ack.success, false);
  assert.match(failure(ack), /sans confirmation/);
});

test('the fresh read too slow: refused unsent, nothing written', async (t) => {
  const server = fakeBridges();
  const { send } = await setup(t, { server, config: ALLOWED });
  server.bridges[HOST].delays = { ls2: 3_600 };
  const ack = await send('target-temperature', 22, { wait: 8 * SECOND });
  assert.equal(ack.success, false);
  assert.match(failure(ack), /non envoyée/);
  assert.equal(server.writes().length, 0);
});

test('commands turned off during the fresh read: nothing written', async (t) => {
  const server = fakeBridges();
  const { gladys, app, advance, send } = await setup(t, { server, config: ALLOWED });
  server.bridges[HOST].delays = { ls2: 1_000 };
  const d = gladys.fake.devices.find((x) => x.external_id === device());
  const f = d.features.find((x) => x.external_id === feature('target-temperature'));
  const ack = gladys.fake.setValue(d, f, 22);
  await advance(500);
  app.configUpdated(CONFIG);
  await advance(5 * SECOND);
  const result = await ack;
  assert.equal(result.success, false);
  assert.equal(server.writes().length, 0);
  void send;
});

test('a stop: never refused for a command in flight, cancels it, never skipped as already off', async (t) => {
  const server = fakeBridges({ [HOST]: bridge({ delays: { ls2: 1_500 } }) });
  const { gladys, advance } = await setup(t, { server, config: ALLOWED });
  const d = gladys.fake.devices.find((x) => x.external_id === device('l1-101'));
  const power = d.features.find((x) => x.external_id === feature('power', 'l1-101'));
  const mode = d.features.find((x) => x.external_id === feature('mode', 'l1-101'));
  const start = gladys.fake.setValue(d, mode, 1);
  await advance(200);
  const stop = gladys.fake.setValue(d, power, 0);
  await advance(6 * SECOND);
  const [started, stopped] = await Promise.all([start, stop]);
  assert.equal(started.success, false, 'the waiting command is cancelled');
  assert.match(failure(started), /Annulée|Cancelled/);
  assert.equal(stopped.success, true, failure(stopped));
  assert.deepEqual(
    server.writes().map((l) => l.line),
    ['off L1.101'],
    'the unit was already off: the stop is sent anyway',
  );
});

test('a stop after a restart, before the first read: the serial kept in /data', async (t) => {
  const server = fakeBridges();
  const store = memoryStore();
  const first = await setup(t, { server, store, config: ALLOWED });
  const created = first.gladys.fake.devices;
  first.app.stop();
  const gladys = createFakeGladys({ config: ALLOWED, devices: created });
  const app = new CoolMasterApp({
    gladys,
    logger: recorder([]),
    connect: (a, o) => server.connect(a, o),
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  await gladys.connect();
  await settle();
  const reads = server.commands('set').length;
  assert.equal(reads, 1, 'no read yet');
  const d = gladys.devices.find((x) => x.external_id === device());
  const power = d.features.find((x) => x.external_id === feature('power'));
  const ack = gladys.fake.setValue(d, power, 0);
  for (let i = 0; i < 30; i += 1) {
    t.mock.timers.tick(100);
    await settle();
  }
  const result = await ack;
  assert.equal(result.success, true, failure(result));
  assert.equal(server.writes().at(-1).line, 'off L1.100');
  // A start is refused until the bridge is read.
  const on = gladys.fake.setValue(d, power, 1);
  await settle();
  assert.equal((await on).success, false);
});

test('a late read of an older configuration publishes nothing', async (t) => {
  const server = fakeBridges({
    [HOST]: bridge(),
    [HOST2]: bridge({ serial: SERIAL2, delays: { ls2: 3_000 } }),
  });
  const { gladys, app, advance } = await setup(t, {
    server,
    config: { addresses: `${HOST}, ${HOST2}` },
    create: false,
  });
  // The second bridge is still answering when the configuration drops it.
  const updating = app.configUpdated({ addresses: HOST });
  await advance(5 * SECOND);
  await updating;
  assert.ok(
    !gladys.fake.discoveredDevices.some((d) => d.external_id.includes(SERIAL2)),
    'nothing of the dropped bridge',
  );
});

test('the same bridge typed twice is read once for the devices', async (t) => {
  const server = fakeBridges({ [HOST]: bridge(), [HOST2]: bridge() });
  const { gladys } = await setup(t, { server, config: { addresses: `${HOST}, ${HOST2}` } });
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(message(gladys).en, /Same bridge typed twice/);
});

test('a reconnection to Gladys republishes the status and the devices, without reading', async (t) => {
  const server = fakeBridges();
  const { gladys, app } = await setup(t, { server });
  const published = gladys.fake.discoveredDevices.length;
  const statuses = gladys.fake.connectionStatuses?.length;
  await app.connected(CONFIG);
  assert.ok(gladys.fake.discoveredDevices.length >= published);
  if (statuses !== undefined) {
    assert.ok(gladys.fake.connectionStatuses.length > statuses);
  }
  assert.equal(server.connections.length, 1);
});

test('nothing logged holds what the bridge sent', async (t) => {
  const logs = [];
  const server = fakeBridges();
  const { send } = await setup(t, { server, config: ALLOWED, logs });
  await send('target-temperature', 24);
  for (const line of logs) {
    assert.doesNotMatch(line, /283B96|serial number|Baud/i);
  }
});

// --- Review 1 ------------------------------------------------------------------

function bigBridge(n) {
  const units = {};
  for (let i = 0; i < n; i += 1) {
    units[`L1.${100 + i}`] = unit();
  }
  return bridge({ units });
}

function stopAll(gladys, n) {
  const acks = [];
  for (let i = 0; i < n; i += 1) {
    const uid = `l1-${100 + i}`;
    const d = gladys.fake.devices.find((x) => x.external_id === device(uid));
    const f = d.features.find((x) => x.external_id === feature('power', uid));
    acks.push(gladys.fake.setValue(d, f, 0));
  }
  return acks;
}

test('I1: wake-up with a bridge that prompts again for the line feed: units read', async (t) => {
  const server = fakeBridges({ [HOST]: bridge({ wakeupReply: true }) });
  const { gladys } = await setup(t, { server, config: { ...CONFIG, wakeup_prompt: true } });
  assert.deepEqual(
    server.lines.map((l) => l.line),
    ['set', 'ls2'],
  );
  assert.equal(gladys.fake.discoveredDevices.length, 2);
  assert.equal(last(gladys, 'power'), 1);
});

test('I2: twenty stops at once: one stop lane, 3 connections at most, every stop written', async (t) => {
  const server = fakeBridges({ [HOST]: bigBridge(20) });
  const { gladys, advance } = await setup(t, { server, config: ALLOWED });
  const before = server.connections.length;
  const acks = stopAll(gladys, 20);
  await settle();
  await advance(6 * SECOND);
  const results = await Promise.all(acks);
  assert.ok(server.maxOpen <= 3, `maxOpen ${server.maxOpen}`);
  assert.equal(server.commands('off').length, 20);
  assert.ok(
    results.every((r) => r.success),
    results.map(failure).join(' | '),
  );
  assert.ok(server.connections.length - before <= 2, 'one or two lane sessions');
  const after = server.lines.slice(server.lines.findIndex((l) => l.line.startsWith('off')));
  assert.equal(after.filter((l) => l.line === 'ls2').length, 1, 'one read back for the lot');
});

test('I2: a bridge that takes 4 sessions only: every stop is still written', async (t) => {
  const server = fakeBridges({ [HOST]: bigBridge(20) });
  const { gladys, app, advance } = await setup(t, { server, config: ALLOWED });
  app.connect = (a, o) =>
    server.open >= 4
      ? Promise.reject(Object.assign(new Error('refused'), { kind: 'unreachable' }))
      : server.connect(a, o);
  const acks = stopAll(gladys, 20);
  await settle();
  await advance(6 * SECOND);
  const results = await Promise.all(acks);
  assert.equal(server.commands('off').length, 20);
  assert.ok(results.every((r) => r.success));
});

test('I3: fallback id, then a serial shown: same external ids, commands accepted', async (t) => {
  const server = fakeBridges({ [HOST]: bridge({ serial: undefined }) });
  const store = memoryStore();
  const { gladys, advance, send } = await setup(t, { server, store, config: ALLOWED });
  const fallback = 'a-192-168-1-50';
  assert.equal(store.data.bridges[HOST].id, fallback);
  assert.equal(store.data.bridges[HOST].fallback, true);
  server.bridges[HOST].serial = SERIAL;
  await advance(MINUTE + SECOND);
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.ok(!ids.some((id) => id.includes(SERIAL)), 'no device under the serial');
  assert.equal(store.data.bridges[HOST].id, fallback);
  assert.equal(store.data.bridges[HOST].serial, SERIAL, 'kept for the identity check');
  assert.equal(transportOf(gladys, 'l1-100'), undefined);
  const ack = await send('power', 0, { serial: fallback });
  assert.equal(ack.success, true, failure(ack));
  assert.doesNotMatch(message(gladys).en, /Another bridge/);
  // From now on, another serial at this address is another bridge.
  server.bridges[HOST].serial = SERIAL2;
  await advance(MINUTE);
  const refused = await send('target-temperature', 22, { serial: fallback });
  assert.equal(refused.success, false);
});

test('M2: a configuration restart never reads sooner than the interval (30 s)', async (t) => {
  const server = fakeBridges();
  const { app, advance } = await setup(t, {
    server,
    config: { addresses: HOST, poll_interval: 30 },
  });
  await advance(30 * SECOND);
  const lastRead = server.connections.at(-1).at;
  await advance(SECOND);
  await app.configUpdated({ addresses: HOST, poll_interval: 30, swing_support: true });
  await advance(40 * SECOND);
  const reads = server.connections.filter((c) => c.at > lastRead);
  assert.ok(reads.length > 0);
  assert.ok(reads[0].at - lastRead >= 30 * SECOND, `${(reads[0].at - lastRead) / 1000} s`);
});

test('M2: after a container restart with an interval under a minute, a minute at least', async (t) => {
  const server = fakeBridges();
  const store = memoryStore({
    bridges: { [HOST]: { id: SERIAL, serial: SERIAL, attemptAt: NOW } },
  });
  await setup(t, { server, store, config: { addresses: HOST, poll_interval: 30 }, create: false });
  assert.equal(server.connections.length, 0);
});

test('M3: a stop during a configuration restart is still sent', async (t) => {
  const server = fakeBridges({ [HOST]: bridge({ delays: { set: 800 } }) });
  const { gladys, app, advance } = await setup(t, { server, config: ALLOWED });
  await advance(MINUTE);
  const d = gladys.fake.devices.find((x) => x.external_id === device());
  const f = d.features.find((x) => x.external_id === feature('power'));
  const ack = gladys.fake.setValue(d, f, 0);
  await advance(300);
  app.configUpdated({ ...ALLOWED, poll_interval: 120 });
  await advance(6 * SECOND);
  const result = await ack;
  assert.equal(result.success, true, failure(result));
  assert.equal(server.commands('off').length, 1);
});

test('M4: a stop needs no read of the unit before it', async (t) => {
  const server = fakeBridges();
  const { send } = await setup(t, { server, config: ALLOWED });
  server.bridges[HOST].delays = { ls2: 3_400 };
  const before = server.lines.length;
  const ack = await send('power', 0);
  const lines = server.lines.slice(before).map((l) => l.line);
  assert.deepEqual(lines.slice(0, 2), ['set', 'off L1.100']);
  assert.equal(ack.success, true, failure(ack));
});

test('M1: an "on" while a stop is in flight is refused, never "already so"', async (t) => {
  const server = fakeBridges({ [HOST]: bridge({ delays: { set: 400 } }) });
  const { gladys, advance } = await setup(t, { server, config: ALLOWED });
  const d = gladys.fake.devices.find((x) => x.external_id === device());
  const f = d.features.find((x) => x.external_id === feature('power'));
  const stop = gladys.fake.setValue(d, f, 0);
  await advance(100);
  const start = gladys.fake.setValue(d, f, 1);
  await settle();
  await advance(6 * SECOND);
  const [a, b] = await Promise.all([stop, start]);
  assert.equal(a.success, true);
  assert.equal(b.success, false);
  assert.match(failure(b), /encore en cours/);
  assert.deepEqual(
    server.writes().map((l) => l.line),
    ['off L1.100'],
  );
});

test('M5: an error answer of the bridge is "refused", not "sent, without confirmation"', async (t) => {
  const server = fakeBridges({ [HOST]: bridge({ errors: { temp: 'Error 5' } }) });
  const { send } = await setup(t, { server, config: ALLOWED });
  const ack = await send('target-temperature', 23);
  assert.equal(ack.success, false);
  assert.match(failure(ack), /refusé/);
  assert.doesNotMatch(failure(ack), /sans confirmation/);
});

test('M6: the bounds are checked before rounding', async (t) => {
  const server = fakeBridges();
  const { send } = await setup(t, { server, config: ALLOWED });
  const ack = await send('target-temperature', 15.76);
  assert.equal(ack.success, false);
  assert.equal(server.connections.length, 1);
});

test('M8: the "another bridge" note goes once the new serial is the kept one', async (t) => {
  const server = fakeBridges();
  const { gladys, advance } = await setup(t, { server });
  server.bridges[HOST].serial = SERIAL2;
  await advance(MINUTE);
  assert.match(message(gladys).en, /Another bridge now answers/);
  await advance(MINUTE);
  assert.doesNotMatch(message(gladys).en, /Another bridge/);
});

// --- Approval 1 ----------------------------------------------------------------

/** When each `off` was written, in ms after `start`. */
const offTimes = (server, start) => server.commands('off').map((l) => [l.line, l.at - start]);

test('A1 (R10): a slow answer to one stop never holds the next one back', async (t) => {
  const server = fakeBridges({ [HOST]: bigBridge(2) });
  const { gladys, advance } = await setup(t, { server, config: ALLOWED });
  server.bridges[HOST].lineDelays = { 'off L1.100': 3_200 };
  const start = Date.now();
  const acks = stopAll(gladys, 2);
  await settle();
  await advance(6 * SECOND);
  const results = await Promise.all(acks);
  const times = offTimes(server, start);
  assert.equal(times.length, 2);
  assert.ok(
    times.every(([, ms]) => ms < 3_500),
    JSON.stringify(times),
  );
  assert.ok(
    results.every((r) => r.success),
    results.map(failure).join(' | '),
  );
});

test('A1 (R10b): a silent bridge after the first stop: both written, both "without confirmation"', async (t) => {
  const server = fakeBridges({ [HOST]: bigBridge(2) });
  const { gladys, advance } = await setup(t, { server, config: ALLOWED });
  server.bridges[HOST].hang = ['off L1.100'];
  const start = Date.now();
  const acks = stopAll(gladys, 2);
  await settle();
  await advance(6 * SECOND);
  const results = await Promise.all(acks);
  const times = offTimes(server, start);
  assert.deepEqual(
    times.map(([line]) => line),
    ['off L1.100', 'off L1.101'],
  );
  assert.ok(times.every(([, ms]) => ms < 3_500));
  for (const r of results) {
    assert.equal(r.success, false);
    assert.match(failure(r), /sans confirmation/);
  }
});

test('A1 (R14): forty stops, 150 ms per answer: all written within 3.5 s, 3 connections at most', async (t) => {
  const server = fakeBridges({ [HOST]: bigBridge(40) });
  const { gladys, advance } = await setup(t, { server, config: ALLOWED });
  server.bridges[HOST].delays = { off: 150 };
  const start = Date.now();
  const acks = stopAll(gladys, 40);
  await settle();
  await advance(6 * SECOND);
  const results = await Promise.all(acks);
  const times = offTimes(server, start);
  assert.equal(times.length, 40);
  assert.ok(times.every(([, ms]) => ms < 3_500));
  assert.ok(server.maxOpen <= 3, `maxOpen ${server.maxOpen}`);
  // Exact acks: confirmed only by the read back, else "sent, without confirmation".
  for (const r of results) {
    assert.ok(r.success || /sans confirmation/.test(failure(r)), failure(r));
  }
});

test('A1: forty stops answered at once are all confirmed by one read back', async (t) => {
  const server = fakeBridges({ [HOST]: bigBridge(40) });
  const { gladys, advance } = await setup(t, { server, config: ALLOWED });
  const acks = stopAll(gladys, 40);
  await settle();
  await advance(6 * SECOND);
  const results = await Promise.all(acks);
  assert.ok(results.every((r) => r.success));
  assert.equal(server.commands('off').length, 40);
});
