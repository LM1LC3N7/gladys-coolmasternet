// -----------------------------------------------------------------------------
// The integration: the CoolMasterNet bridges typed in the configuration, one
// read of each bridge every poll interval (its serial number with `set`, the
// units with `ls2`, the louvers with `query` when asked), one Gladys device per
// indoor unit and its states, the transport badges, the "Test the connection"
// button, and the commands (on/off, mode, setpoint, fan speed, louver),
// refused unless the configuration allows them. index.js only wires the SDK.
//
// Reads are never sooner than the interval: the time of the last attempt is
// kept in /data (written before the read, at most once a minute) and a
// restart, a reconnection to Gladys, the Discovery tab, a configuration saved
// unchanged or the test button never read again before it is due. A read or
// a command answer that arrives after a restart (an older configuration)
// publishes nothing and sets no status (the generation is checked after each
// await).
//
// The commands follow the rules learnt on the previous modules:
//   - each one opens its own connection, checks the serial number of the
//     bridge (`set`) and reads the unit (`ls2 <uid>`) just before: decided on
//     that read only, never on the state kept in memory; refused when a value
//     it needs is unknown, or when the serial number is not the device's;
//   - the "Allow the commands" option is checked on arrival and again right
//     before the write; written within 3.5 s of the click or refused unsent;
//   - confirmed only by a read back equal to what was asked (by 4.3 s), else
//     "sent, without confirmation", a guard and one more read 5 s later;
//   - the ack never waits for a publication to Gladys;
//   - one command at a time per unit; a stop (off) is never refused for that:
//     it cancels the command waiting for the same unit, goes through the stop
//     lane of its bridge (one connection more, never behind a poll; 3 at most
//     per bridge in all), needs no read before it, is never skipped as
//     "already off" and works after a restart before the first read (id and
//     serial kept in /data); other commands wait for it ("still running").
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import { CONNECTIONS, FEATURES, LIMITS, SECOND, SETPOINT, TIMINGS } from './constants.js';
import {
  buildDevice,
  commandValue,
  deviceIds,
  fallbackId,
  parseDeviceId,
  parseFeatureId,
  unitStates,
} from './devices.js';
import { ERRORS, T, age, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory, serializeMemory } from './store.js';
import {
  CoolError,
  ERROR_KINDS,
  Slots,
  errorReason,
  openSession,
  tcpConnect,
} from './coolmaster/client.js';
import {
  commandLine,
  parseInfo,
  parseStatus,
  parseSwing,
  serialOf,
  setpointFor,
  versionOf,
} from './coolmaster/protocol.js';

const both = (en, fr) => ({ en, fr });
const join = (...texts) => both(texts.map((t) => t.en).join(' '), texts.map((t) => t.fr).join(' '));

/** A bridge as nothing was read yet. */
const freshBridge = (address, timers) => ({
  address,
  key: addressKey(address),
  /** The id of its devices (serial, or the address fallback), from the last good read. */
  id: undefined,
  /** Whether the serial number was read (or the fallback applies) at the last read. */
  verified: false,
  version: undefined,
  /** uid -> the state of the unit (protocol.js parseStatusLine, plus `swing`). */
  units: new Map(),
  statusCmd: undefined,
  online: undefined,
  otherBridge: false,
  duplicateOf: undefined,
  failures: 0,
  wait: undefined,
  nextAt: 0,
  timer: undefined,
  running: undefined,
  followUp: undefined,
  slots: new Slots(CONNECTIONS.shared, { timers }),
  /** The stop lane: stops waiting, and the session that writes them (see queueStop). */
  stops: { queue: [], running: undefined },
  /** The serial number kept for the address (the identity check). */
  serial: undefined,
});

export class CoolMasterApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'coolmasternet' }),
    connect = tcpConnect,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** addressKey -> bridge */
    this.bridges = new Map();
    this.generation = 0;
    this.started = false;
    this.lifecycle = Promise.resolve();
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastTestAt = -Infinity;
    /** `${bridge id}:${uid}` -> { cancelled } of the command in flight. */
    this.inFlight = new Map();
    /** `${bridge id}:${uid}` -> the number of stops in flight. */
    this.stopping = new Map();
    /** `${bridge id}:${uid}:${field}` -> { from, expected, moved, until }: sent, not seen yet. */
    this.guards = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Starts, connections and configuration changes run one after the other. */
  serialized(fn) {
    const run = this.lifecycle.then(fn, fn);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  start(raw = {}) {
    this.disableAtOnce(raw);
    return this.serialized(() => this.doStart(raw));
  }

  async doStart(raw) {
    this.stop();
    const generation = this.generation;
    this.config = this.configOf(raw);
    await Promise.all([...this.bridges.values()].map((b) => b.running));
    const loaded = await this.store.load().catch(() => null);
    if (generation !== this.generation) {
      return;
    }
    // An internal restart (configuration saved) keeps what this process knows
    // better than /data: the attempt time is written at most once a minute.
    const known = this.memory.bridges;
    this.memory = normalizeMemory(loaded, this.now());
    const exact = new Set();
    for (const [key, entry] of known) {
      const stored = this.memory.bridges.get(key);
      const readAt = Math.max(entry.attemptAt, entry.readAt ?? 0);
      if (!stored) {
        this.memory.bridges.set(key, { ...entry, readAt });
      } else {
        stored.readAt = Math.max(stored.attemptAt, readAt);
      }
      exact.add(key);
    }
    this.bridges = new Map(
      this.config.addresses.map((a) => [addressKey(a), freshBridge(a, this.timers)]),
    );
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    await this.publishAll(generation);
    // The first read of each bridge: never sooner than the interval after the
    // last attempt. Read back from /data only (a container restart), the time
    // may be up to a minute old: then at least a minute after it.
    for (const bridge of this.bridges.values()) {
      const entry = this.memory.bridges.get(bridge.key);
      const exactly = exact.has(bridge.key);
      const attemptAt = (exactly ? entry?.readAt : entry?.attemptAt) ?? 0;
      const wait = exactly ? this.interval : Math.max(this.interval, TIMINGS.attemptSave);
      this.schedule(bridge, Math.max(0, attemptAt + wait - this.now()));
    }
  }

  stop() {
    this.generation += 1;
    for (const bridge of this.bridges.values()) {
      this.clearTimers(bridge);
    }
    this.publisher.stop();
  }

  clearTimers(bridge) {
    if (bridge.timer) {
      this.timers.clearTimeout(bridge.timer);
      bridge.timer = undefined;
    }
    if (bridge.followUp) {
      this.timers.clearTimeout(bridge.followUp);
      bridge.followUp = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery list, badges) and the
   * last states, without reading the bridges again.
   */
  connected(raw = {}) {
    this.disableAtOnce(raw);
    return this.serialized(() => this.doConnected(raw));
  }

  /** Commands turned off apply at once, before the queue; turning them on waits its turn. */
  disableAtOnce(raw) {
    this.latestAllow = normalizeConfig(raw).allowCommands;
    if (!this.latestAllow && this.config.allowCommands) {
      this.config = { ...this.config, allowCommands: false };
      this.logger.info('CoolMasterNet commands disabled');
    }
  }

  /** A configuration taken from the queue never turns back on commands turned off later. */
  configOf(raw) {
    const config = normalizeConfig(raw);
    return this.latestAllow === false ? { ...config, allowCommands: false } : config;
  }

  async doConnected(raw) {
    if (!this.started) {
      this.started = true;
      await this.doStart(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.doStart(raw);
      return;
    }
    this.config = this.configOf(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.publishAll(this.generation);
  }

  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      next.pollInterval !== this.config.pollInterval ||
      next.swing !== this.config.swing ||
      next.wakeup !== this.config.wakeup ||
      JSON.stringify(next.addresses) !== JSON.stringify(this.config.addresses)
    );
  }

  /** New addresses, interval or read options restart; the commands option and the language apply at once. */
  configUpdated(raw = {}) {
    this.disableAtOnce(raw);
    return this.serialized(() => this.doConfigUpdated(raw));
  }

  async doConfigUpdated(raw) {
    if (this.needsRestart(raw)) {
      await this.doStart(raw);
      return;
    }
    const previous = this.config;
    this.config = this.configOf(raw);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(
        `CoolMasterNet commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`,
      );
    }
    if (this.config.language !== previous.language || previous.invalid !== this.config.invalid) {
      this.published = undefined;
      await this.publishAll(this.generation);
    } else {
      await this.updateStatus(this.generation);
    }
  }

  async setStatus(generation, connected, message) {
    if (generation !== this.generation) {
      return;
    }
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** Saves the memory; resolves false when /data refused it. */
  async saveMemory() {
    const current = new Set(this.bridges.keys());
    for (const key of [...this.memory.bridges.keys()]) {
      if (this.memory.bridges.size <= LIMITS.bridges * 2) {
        break;
      }
      if (!current.has(key)) {
        this.memory.bridges.delete(key);
      }
    }
    try {
      await this.store.save(serializeMemory(this.memory));
      return true;
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err.code ?? err.message}`);
      return false;
    }
  }

  bridgeMemory(bridge) {
    let entry = this.memory.bridges.get(bridge.key);
    if (!entry) {
      entry = { id: undefined, fallback: false, serial: undefined, attemptAt: 0 };
      this.memory.bridges.set(bridge.key, entry);
    }
    return entry;
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  current(bridge) {
    return this.bridges.get(bridge.key) === bridge;
  }

  /** The next read in `delay` ms (by default: the backoff after a failure, else the interval). */
  schedule(bridge, delay) {
    if (bridge.timer) {
      this.timers.clearTimeout(bridge.timer);
      bridge.timer = undefined;
    }
    if (!this.current(bridge)) {
      return;
    }
    const wait = Math.max(
      0,
      delay ?? (bridge.online === false ? (bridge.wait ?? this.interval) : this.interval),
    );
    const generation = this.generation;
    bridge.nextAt = this.now() + wait;
    bridge.timer = this.timers.setTimeout(() => {
      bridge.timer = undefined;
      if (generation === this.generation && this.current(bridge)) {
        this.tick(bridge).catch(() => this.logger.error('CoolMasterNet refresh failed'));
      }
    }, wait);
  }

  /** One read at a time per bridge: a tick during a read joins it. */
  tick(bridge) {
    if (!this.current(bridge)) {
      return Promise.resolve();
    }
    if (!bridge.running) {
      bridge.running = this.run(bridge).finally(() => {
        bridge.running = undefined;
      });
    }
    return bridge.running;
  }

  async run(bridge) {
    const generation = this.generation;
    if (bridge.timer) {
      this.timers.clearTimeout(bridge.timer);
      bridge.timer = undefined;
    }
    // The attempt is kept in /data before the read (at most once a minute).
    const memory = this.bridgeMemory(bridge);
    // The exact time stays in memory (a configuration restart reads it); /data
    // gets it at most once a minute.
    memory.readAt = this.now();
    if (this.now() - memory.attemptAt >= TIMINGS.attemptSave) {
      memory.attemptAt = this.now();
      await this.saveMemory();
      if (generation !== this.generation) {
        return;
      }
    }
    bridge.nextAt = this.now() + this.interval;
    try {
      const read = await this.read(bridge);
      if (generation !== this.generation || !this.current(bridge)) {
        return;
      }
      await this.applyPoll(bridge, read);
    } catch (err) {
      if (generation !== this.generation || !this.current(bridge)) {
        return;
      }
      this.failed(bridge, err);
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll(generation);
    if (generation === this.generation) {
      this.schedule(bridge);
    }
  }

  /** The status command of a bridge: `ls2`, else `stat2` (older firmware), remembered. */
  async status(session, bridge, uid, timeoutMs) {
    const suffix = uid ? ` ${uid}` : '';
    const commands = bridge.statusCmd ? [bridge.statusCmd] : ['ls2', 'stat2'];
    let last;
    for (const command of commands) {
      try {
        const { text } = await session.request(`${command}${suffix}`, { timeoutMs: timeoutMs() });
        bridge.statusCmd = command;
        return parseStatus(text);
      } catch (err) {
        if (!err.unknownCommand) {
          throw err;
        }
        last = err;
      }
    }
    throw last;
  }

  /** One session: `set`, the status of every unit, the louvers when asked. */
  async read(bridge) {
    const deadline = this.now() + TIMINGS.pollBudget;
    const left = () => Math.min(TIMINGS.requestTimeout, deadline - this.now());
    const release = await bridge.slots.acquire();
    let session;
    try {
      session = await openSession(bridge.address, {
        connect: this.connect,
        wakeup: this.config.wakeup,
        timeoutMs: TIMINGS.connectTimeout,
        now: this.now,
        timers: this.timers,
      });
      const info = parseInfo((await session.request('set', { timeoutMs: left() })).text);
      const units = await this.status(session, bridge, undefined, left);
      if (this.config.swing) {
        for (const unit of units.values()) {
          if (left() < 1) {
            break;
          }
          try {
            unit.swing = parseSwing(
              (await session.request(`query ${unit.uid} s`, { timeoutMs: left() })).text,
            );
          } catch (err) {
            if (err.kind !== ERROR_KINDS.REJECTED) {
              throw err;
            }
          }
        }
      }
      return { info, units };
    } finally {
      session?.close();
      release();
    }
  }

  /** The identity of the bridge, then its units. */
  async applyPoll(bridge, { info, units }) {
    const memory = this.bridgeMemory(bridge);
    const serial = serialOf(info);
    bridge.version = versionOf(info);
    const before = JSON.stringify(memory);
    if (!memory.id) {
      // The id of the devices, chosen once per address and kept in /data: the
      // serial number, or the readable fallback when none is shown (or when
      // devices of this address were already created under the fallback).
      const fallback = fallbackId(bridge.key);
      const createdUnderFallback = (this.gladys.devices ?? []).some(
        (d) => parseDeviceId(d?.external_id)?.bridge === fallback,
      );
      memory.fallback = !serial || createdUnderFallback;
      memory.id = memory.fallback ? fallback : serial;
    }
    if (serial) {
      if (memory.serial && memory.serial !== serial) {
        // Another bridge answers at this address (a DHCP swap): its own devices.
        this.logger.warn(`CoolMasterNet ${bridge.key}: another bridge answers at this address`);
        bridge.otherBridge = true;
        memory.id = serial;
        memory.fallback = false;
      } else if (memory.serial === serial) {
        // The serial kept: the note of a previous swap is over.
        bridge.otherBridge = false;
      }
      memory.serial = serial;
      bridge.verified = true;
    } else {
      // Unreadable this time (a serial was seen before): not "another bridge",
      // but nothing is shown on it. Never seen: the fallback, verified.
      bridge.verified = !memory.serial;
    }
    if (bridge.id !== undefined && bridge.id !== memory.id) {
      bridge.units = new Map();
    }
    bridge.id = memory.id;
    bridge.serial = memory.serial;
    if (JSON.stringify(memory) !== before) {
      await this.saveMemory();
    }
    const owner = [...this.bridges.values()].find(
      (b) =>
        b !== bridge &&
        !b.duplicateOf &&
        b.online &&
        (b.id === bridge.id || (bridge.serial && b.serial === bridge.serial)),
    );
    bridge.duplicateOf = owner && bridge.verified ? owner.key : undefined;
    bridge.online = true;
    bridge.failures = 0;
    bridge.wait = undefined;
    if (bridge.verified && !bridge.duplicateOf) {
      bridge.units = units;
      for (const uid of units.keys()) {
        this.observe(bridge, uid);
      }
    }
  }

  failed(bridge, err) {
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(bridge.failures, TIMINGS.backoff.length - 1)],
    );
    bridge.failures += 1;
    bridge.online = false;
    bridge.verified = false;
    bridge.wait = wait;
    this.logger.warn(
      `CoolMasterNet ${bridge.key}: ${errorReason(err)}; next try in ${Math.round(wait / 1000)} s`,
    );
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((d) => d?.external_id === externalId);
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** Whether the units of a bridge are current (read at the last poll, identity checked). */
  live(bridge) {
    return Boolean(bridge?.online === true && bridge.verified && bridge.id && !bridge.duplicateOf);
  }

  async publishAll(generation) {
    if (generation !== this.generation) {
      return;
    }
    await this.publishDevices(generation);
    this.queueStates();
    await this.flush();
    await this.publishBadge(generation);
    await this.updateStatus(generation);
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  buildDevices() {
    const devices = [];
    for (const bridge of this.bridges.values()) {
      if (!this.live(bridge)) {
        continue;
      }
      for (const uid of bridge.units.keys()) {
        devices.push(
          buildDevice(
            this.gladys,
            { bridgeId: bridge.id, uid, version: bridge.version, swing: this.config.swing },
            {
              language: this.config.language,
              created: this.createdDevice(deviceIds(this.gladys, bridge.id, uid).device),
            },
          ),
        );
      }
    }
    return devices;
  }

  async publishDevices(generation) {
    const devices = this.buildDevices();
    if (devices.length === 0 || generation !== this.generation) {
      return;
    }
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  queueStates(created = this.createdFeatures()) {
    for (const bridge of this.bridges.values()) {
      if (!this.live(bridge)) {
        continue;
      }
      for (const [uid, state] of bridge.units) {
        const ids = deviceIds(this.gladys, bridge.id, uid);
        for (const { device_feature_external_id: id, ...value } of unitStates(ids, state, {
          language: this.config.language,
          swing: this.config.swing,
        })) {
          if (created.has(id)) {
            this.publisher.push(id, value);
          }
        }
      }
    }
  }

  async publishBadge(generation) {
    const entries = [];
    const bridges = [...this.bridges.values()];
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseDeviceId(device?.external_id);
      if (
        !parsed ||
        deviceIds(this.gladys, parsed.bridge, parsed.uid).device !== device.external_id
      ) {
        continue;
      }
      const bridge = bridges.find((b) => b.id === parsed.bridge && !b.duplicateOf);
      if (!bridge && bridges.some((b) => b.online === undefined)) {
        continue;
      }
      if (bridge && bridge.online === undefined) {
        continue;
      }
      const local = this.live(bridge) && bridge.units.has(parsed.uid);
      entries.push({
        external_id: device.external_id,
        transport: local ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge || generation !== this.generation) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  async updateStatus(generation = this.generation) {
    const [connected, message] = this.statusText();
    await this.setStatus(generation, connected, message);
  }

  /** The connection status of the configuration screen. */
  statusText() {
    const notes = [];
    if (this.config.invalid) {
      notes.push(T.invalid(this.config.invalid));
    }
    if (this.config.dropped > 0) {
      notes.push(T.dropped(this.config.dropped));
    }
    const bridges = [...this.bridges.values()];
    if (bridges.length === 0) {
      return [false, join(T.noAddress, ...notes)];
    }
    const counted = bridges.filter((b) => !b.duplicateOf);
    const down = counted.filter((b) => b.online === false);
    const up = counted.filter((b) => b.online === true);
    if (down.length > 0) {
      notes.unshift(T.unreachable(down.map((b) => b.key).join(', ')));
    }
    const unverified = up.filter((b) => !b.verified);
    if (unverified.length > 0) {
      notes.push(T.unverified(unverified.map((b) => b.key).join(', ')));
    }
    const other = up.filter((b) => b.otherBridge);
    if (other.length > 0) {
      notes.push(T.otherBridge(other.map((b) => b.key).join(', ')));
    }
    const empty = up.filter((b) => b.verified && b.units.size === 0);
    if (empty.length > 0) {
      notes.push(T.noUnits(empty.map((b) => b.key).join(', ')));
    }
    const duplicates = bridges.filter((b) => b.duplicateOf);
    if (duplicates.length > 0) {
      notes.push(T.duplicate(duplicates.map((b) => `${b.key} = ${b.duplicateOf}`).join(', ')));
    }
    if (up.length === 0) {
      if (down.length === 0) {
        return [false, join(T.connecting, ...notes)];
      }
      return [false, join(...notes)];
    }
    const units = up.filter((b) => this.live(b)).reduce((n, b) => n + b.units.size, 0);
    return [true, join(T.connected(up.length, counted.length, units), ...notes)];
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge(this.generation);
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the devices of the last reads, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices(this.generation);
  }

  // --- Configuration button --------------------------------------------------

  async testConnection() {
    if (this.bridges.size === 0) {
      return this.statusText()[1];
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      return join(T.test.cooldown, this.statusText()[1]);
    }
    this.lastTestAt = this.now();
    // A bridge is read now only when its read is due: never sooner than the interval.
    const waiting = [];
    const reads = Promise.all(
      [...this.bridges.values()].map((bridge) => {
        if (bridge.running) {
          return bridge.running;
        }
        if (bridge.nextAt > this.now()) {
          waiting.push(T.test.waiting(bridge.key, age(bridge.nextAt - this.now())));
          return undefined;
        }
        return this.tick(bridge);
      }),
    );
    let timer;
    await Promise.race([
      reads,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(resolve, TIMINGS.testAnswerBy);
      }),
    ]);
    this.timers.clearTimeout(timer);
    return join(this.statusText()[1], ...waiting);
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /** The bridge of a device: by its id, or by the id kept in /data for its address. */
  bridgeFor(bridgeId) {
    for (const bridge of this.bridges.values()) {
      if (bridge.id === bridgeId && !bridge.duplicateOf) {
        return bridge;
      }
    }
    for (const bridge of this.bridges.values()) {
      const memory = this.memory.bridges.get(bridge.key);
      if (bridge.id === undefined && memory?.id === bridgeId) {
        return bridge;
      }
    }
    return undefined;
  }

  /**
   * Whether the bridge that answers is the one of the device: 'ok', 'other'
   * (another serial number) or 'identity' (no serial shown where one was).
   * The id kept for the address names the device; the serial kept checks it.
   */
  identity(bridge, deviceBridgeId, serial) {
    const memory = this.memory.bridges.get(bridge.key);
    if (memory?.id === deviceBridgeId) {
      if (!memory.serial) {
        return 'ok';
      }
      if (!serial) {
        return 'identity';
      }
      return serial === memory.serial ? 'ok' : 'other';
    }
    if (!memory?.id) {
      if (serial) {
        return serial === deviceBridgeId ? 'ok' : 'other';
      }
      return deviceBridgeId === fallbackId(bridge.key) ? 'ok' : 'identity';
    }
    return 'other';
  }

  /** The setpoint bounds: SETPOINT, within the bounds of the created feature. */
  setpointBounds(feature) {
    let { min, max } = SETPOINT;
    if (Number.isFinite(feature?.min) && Number.isFinite(feature?.max)) {
      min = Math.max(min, feature.min);
      max = Math.min(max, feature.max);
    }
    return [min, max];
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target) {
      throw this.refusal(ERRORS.readOnly);
    }
    const change = commandValue(target.key, value);
    if (change === undefined) {
      throw this.refusal(
        [FEATURES.ROOM, FEATURES.FILTER, FEATURES.ERROR].includes(target.key)
          ? ERRORS.readOnly
          : ERRORS.badValue,
      );
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (target.key === FEATURES.SWING && !this.config.swing) {
      throw this.refusal(ERRORS.swingDisabled);
    }
    if (change.setpointC !== undefined) {
      // The bounds on the value asked, before any rounding.
      const [min, max] = this.setpointBounds(feature);
      if (change.asked < min || change.asked > max) {
        throw this.refusal(ERRORS.outOfRange(min, max));
      }
    }
    const protective = change.on === false;
    const unitRef = `${target.bridge}:${target.uid}`;
    const pending = this.inFlight.get(unitRef);
    if (protective) {
      // A stop cancels the command waiting for the same unit (not written yet).
      if (pending) {
        pending.cancelled = true;
      }
    } else if (pending || this.stopping.has(unitRef)) {
      // Never "already so" on a state a stop in flight is about to change.
      throw this.refusal(ERRORS.stillRunning);
    }
    const bridge = this.bridgeFor(target.bridge);
    if (!bridge || (!protective && !this.live(bridge))) {
      throw this.refusal(ERRORS.unknownUnit);
    }
    if (protective) {
      this.stopping.set(unitRef, (this.stopping.get(unitRef) ?? 0) + 1);
      try {
        return await this.queueStop(bridge, target, received);
      } finally {
        const left = (this.stopping.get(unitRef) ?? 1) - 1;
        if (left > 0) {
          this.stopping.set(unitRef, left);
        } else {
          this.stopping.delete(unitRef);
        }
      }
    }
    const entry = { cancelled: false };
    this.inFlight.set(unitRef, entry);
    try {
      return await this.command(bridge, target, change, { received, entry });
    } finally {
      if (this.inFlight.get(unitRef) === entry) {
        this.inFlight.delete(unitRef);
      }
    }
  }

  // --- Stops -----------------------------------------------------------------

  /**
   * A stop joins the stop lane of its bridge: one connection of its own (never
   * behind the polls nor the other commands), one at a time per bridge. The
   * stops that arrive while it is open are added in order: `set` once (the
   * identity), one `off <uid>` per stop (each within its own deadline, checked
   * right before its write), then one `ls2` to confirm the lot. Never refused
   * for a command in flight, a configuration saved meanwhile (generation) or a
   * slow state read: a stop needs no read before it.
   */
  queueStop(bridge, target, received) {
    return new Promise((resolve, reject) => {
      bridge.stops.queue.push({
        target,
        sendBy: received + TIMINGS.commandSendBy,
        answerBy: received + TIMINGS.commandAnswerBy,
        resolve,
        reject,
      });
      this.startStops(bridge);
    });
  }

  startStops(bridge) {
    if (bridge.stops.running || bridge.stops.queue.length === 0) {
      return;
    }
    bridge.stops.running = this.runStops(bridge)
      .catch((err) => this.logger.error(`CoolMasterNet stop lane failed: ${err.message}`))
      .finally(() => {
        bridge.stops.running = undefined;
        this.startStops(bridge);
      });
  }

  async runStops(bridge) {
    const queue = bridge.stops.queue;
    while (queue.length > 0) {
      const latest = Math.max(...queue.map((job) => job.sendBy));
      let session;
      try {
        session = await openSession(bridge.address, {
          connect: this.connect,
          wakeup: this.config.wakeup,
          timeoutMs: Math.min(TIMINGS.connectTimeout, latest - 300 - this.now()),
          now: this.now,
          timers: this.timers,
        });
      } catch (err) {
        const text =
          err.kind === ERROR_KINDS.LATE || err.kind === ERROR_KINDS.TIMEOUT
            ? ERRORS.tooSlow
            : ERRORS.notSent(errorReason(err));
        for (const job of queue.splice(0)) {
          job.reject(this.refusal(text));
        }
        return;
      }
      try {
        await this.stopSession(bridge, session, queue);
      } finally {
        session.close();
      }
    }
  }

  async stopSession(bridge, session, queue) {
    let serial;
    try {
      const latest = Math.max(...queue.map((job) => job.sendBy));
      const timeoutMs = Math.min(TIMINGS.requestTimeout, latest - this.now());
      serial = serialOf(parseInfo((await session.request('set', { timeoutMs })).text));
    } catch (err) {
      const text =
        err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.unknownState(errorReason(err));
      for (const job of queue.splice(0)) {
        job.reject(this.refusal(text));
      }
      return;
    }
    const written = [];
    while (queue.length > 0 && !session.closed) {
      const job = queue.shift();
      const check = this.identity(bridge, job.target.bridge, serial);
      if (check !== 'ok') {
        job.reject(this.refusal(check === 'other' ? ERRORS.otherBridge : ERRORS.identityUnknown));
        continue;
      }
      this.logger.info(`CoolMasterNet ${bridge.key}: ${job.target.uid} power -> off`);
      try {
        const answer = await session.request(`off ${job.target.uid}`, {
          timeoutMs: Math.min(TIMINGS.requestTimeout, job.answerBy - this.now()),
          beforeSend: () => {
            if (!this.config.allowCommands) {
              throw this.refusal(ERRORS.disabled);
            }
            if (this.now() > job.sendBy) {
              throw this.refusal(ERRORS.tooSlow);
            }
          },
        });
        if (answer.ok) {
          written.push(job);
        } else {
          job.reject(this.refusal(ERRORS.refused));
        }
      } catch (err) {
        if (err.beforeSend) {
          job.reject(err);
        } else if (!err.sent) {
          job.reject(this.refusal(ERRORS.notSent(errorReason(err))));
        } else if (err.kind === ERROR_KINDS.REJECTED) {
          job.reject(this.refusal(ERRORS.refused));
        } else {
          // A silence or a closed connection after the write: it may have been applied.
          this.stopUnconfirmed(bridge, job, errorReason(err));
        }
      }
    }
    if (written.length === 0) {
      return;
    }
    // One read back for the lot.
    const by = Math.min(...written.map((job) => job.answerBy));
    let units;
    try {
      if (session.closed) {
        throw new CoolError(ERROR_KINDS.CLOSED, 'Connection closed');
      }
      units = await this.status(session, bridge, undefined, () =>
        Math.min(TIMINGS.requestTimeout, by - this.now()),
      );
    } catch (err) {
      for (const job of written) {
        this.stopUnconfirmed(bridge, job, errorReason(err));
      }
      return;
    }
    for (const job of written) {
      const state = units.get(job.target.uid);
      this.applyUnit(bridge, job.target, state);
      if (state?.on === false) {
        this.guards.delete(`${job.target.bridge}:${job.target.uid}:on`);
        job.resolve();
      } else {
        this.stopUnconfirmed(bridge, job, 'state not changed yet');
      }
    }
  }

  stopUnconfirmed(bridge, job, reason) {
    const key = `${job.target.bridge}:${job.target.uid}`;
    this.guard({
      key: `${key}:on`,
      from: this.bridgeFor(job.target.bridge)?.units.get(job.target.uid)?.on ?? true,
      expected: false,
    });
    this.scheduleFollowUp(bridge);
    job.reject(this.refusal(ERRORS.sentUnconfirmed(reason)));
  }

  /** The checks right before the write, on the latest configuration. */
  beforeSend(generation, entry, sendBy) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (entry.cancelled) {
      throw this.refusal(ERRORS.cancelled);
    }
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.unknownUnit);
    }
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
  }

  async command(bridge, target, change, { received, entry }) {
    const generation = this.generation;
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const left = (by) => Math.min(TIMINGS.requestTimeout, by - this.now());
    let release;
    try {
      release = await bridge.slots.acquire({ waitMs: sendBy - 1_000 - this.now() });
    } catch {
      throw this.refusal(ERRORS.tooSlow);
    }
    let session;
    try {
      try {
        session = await openSession(bridge.address, {
          connect: this.connect,
          wakeup: this.config.wakeup,
          timeoutMs: Math.min(TIMINGS.connectTimeout, sendBy - 300 - this.now()),
          now: this.now,
          timers: this.timers,
        });
      } catch (err) {
        if (err.kind === ERROR_KINDS.LATE || err.kind === ERROR_KINDS.TIMEOUT) {
          throw this.refusal(ERRORS.tooSlow);
        }
        throw this.refusal(ERRORS.notSent(errorReason(err)));
      }
      const state = await this.freshState(session, bridge, target, change, sendBy);
      if (generation !== this.generation) {
        throw this.refusal(ERRORS.unknownUnit);
      }
      // The command, on the bridge's own units.
      const wanted = this.wanted(change, state);
      const field = Object.keys(wanted)[0];
      const guardKey = `${target.bridge}:${target.uid}:${field}`;
      if (state[field] === undefined || (field === 'setpoint' && state.unit === undefined)) {
        throw this.refusal(ERRORS.incompleteState);
      }
      this.checkPrevious(target, field, state);
      if (this.same(field, state[field], wanted[field]) && !this.guardActive(guardKey)) {
        // Already so: nothing sent.
        return;
      }
      const line = commandLine(target.uid, wanted);
      this.logger.info(
        `CoolMasterNet ${bridge.key}: ${target.uid} ${target.key} -> ${line.split(' ')[0]}`,
      );
      const plan = { key: guardKey, from: state[field], expected: wanted[field] };
      let answer;
      try {
        answer = await session.request(line, {
          timeoutMs: left(answerBy),
          beforeSend: () => this.beforeSend(generation, entry, sendBy),
        });
      } catch (err) {
        if (err.beforeSend) {
          throw err;
        }
        if (!err.sent) {
          throw this.refusal(ERRORS.notSent(errorReason(err)));
        }
        if (err.kind === ERROR_KINDS.REJECTED) {
          throw this.refusal(ERRORS.refused);
        }
        // A silence or a closed connection after the write: it may have been applied.
        this.guard(plan);
        this.scheduleFollowUp(bridge);
        throw this.refusal(ERRORS.sentUnconfirmed(errorReason(err)));
      }
      if (!answer.ok) {
        // The bridge answered, without its "OK": an error of its own, not applied.
        throw this.refusal(ERRORS.refused);
      }
      // Confirmed only by the state read back.
      let back;
      try {
        back = await this.readUnit(session, bridge, target.uid, field === 'swing', () =>
          left(answerBy),
        );
      } catch (err) {
        this.guard(plan);
        this.scheduleFollowUp(bridge);
        throw this.refusal(ERRORS.sentUnconfirmed(errorReason(err)));
      }
      if (generation === this.generation) {
        this.applyUnit(bridge, target, back);
      }
      if (!back || !this.same(field, back[field], wanted[field])) {
        this.guard(plan);
        this.scheduleFollowUp(bridge);
        throw this.refusal(ERRORS.sentUnconfirmed('state not changed yet'));
      }
      this.guards.delete(guardKey);
    } finally {
      session?.close();
      release();
    }
  }

  /** The identity of the bridge and the state of the unit, read just before. */
  async freshState(session, bridge, target, change, sendBy) {
    const left = () => Math.min(TIMINGS.requestTimeout, sendBy - this.now());
    let info;
    let state;
    try {
      info = parseInfo((await session.request('set', { timeoutMs: left() })).text);
      const check = this.identity(bridge, target.bridge, serialOf(info));
      if (check !== 'ok') {
        throw new CoolError(check, 'identity');
      }
      state = await this.readUnit(session, bridge, target.uid, change.swing !== undefined, left);
    } catch (err) {
      if (err.kind === 'other') {
        throw this.refusal(ERRORS.otherBridge);
      }
      if (err.kind === 'identity') {
        throw this.refusal(ERRORS.identityUnknown);
      }
      if (err.kind === ERROR_KINDS.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      throw this.refusal(ERRORS.unknownState(errorReason(err)));
    }
    if (!state) {
      throw this.refusal(ERRORS.unknownState('unit not listed'));
    }
    // Shown in the background: the ack never waits for Gladys.
    this.applyUnit(bridge, target, state);
    return state;
  }

  /** `ls2 <uid>` (and its louver) -> the state of the unit, or undefined when not listed. */
  async readUnit(session, bridge, uid, withSwing, left) {
    const unit = (await this.status(session, bridge, uid, left)).get(uid);
    if (unit && withSwing) {
      unit.swing = parseSwing(
        (await session.request(`query ${uid} s`, { timeoutMs: left() })).text,
      );
    }
    return unit;
  }

  /** A state read by a command: kept and shown when the bridge is the device's and current. */
  applyUnit(bridge, target, state) {
    if (!state || !this.current(bridge) || bridge.id !== target.bridge || !bridge.verified) {
      return;
    }
    const previous = bridge.units.get(target.uid);
    if (previous?.swing !== undefined && state.swing === undefined) {
      state.swing = previous.swing;
    }
    bridge.units.set(target.uid, state);
    this.observe(bridge, target.uid);
    this.publishAll(this.generation).catch((err) =>
      this.logger.warn(`Publishing failed: ${err.message}`),
    );
  }

  /** The fields of the unit a change writes, in the unit the bridge shows. */
  wanted(change, state) {
    if (change.setpointC !== undefined) {
      return { setpoint: setpointFor(change.setpointC, state.unit) };
    }
    return change;
  }

  same(field, a, b) {
    if (field === 'setpoint') {
      return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.05;
    }
    return a === b;
  }

  /** A previous command on another field of the unit, not visible yet: refused. */
  checkPrevious(target, field, state) {
    const prefix = `${target.bridge}:${target.uid}:`;
    for (const [key, guard] of this.guards) {
      const other = key.slice(prefix.length);
      if (
        key.startsWith(prefix) &&
        other !== field &&
        this.guardActive(key) &&
        !guard.moved &&
        state[other] === guard.from &&
        state[other] !== guard.expected
      ) {
        throw this.refusal(ERRORS.previousPending);
      }
    }
  }

  /** One read of the bridge a few seconds after a command not confirmed (never two at once). */
  scheduleFollowUp(bridge) {
    if (bridge.followUp) {
      return;
    }
    const generation = this.generation;
    bridge.followUp = this.timers.setTimeout(() => {
      bridge.followUp = undefined;
      if (generation === this.generation && this.current(bridge) && bridge.online !== false) {
        this.tick(bridge).catch(() => this.logger.error('CoolMasterNet refresh failed'));
      }
    }, TIMINGS.followUp);
  }

  // --- Guards ----------------------------------------------------------------

  /**
   * After a command that may have been applied, until the unit shows it: a new
   * command is always sent, never answered "already so". The start value is
   * kept: a read equal to it lifts nothing until a move was seen.
   */
  guard({ key, from, expected }) {
    this.guards.set(key, { from, expected, moved: false, until: this.now() + TIMINGS.guard });
  }

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /** A read of a unit, through its guards: never lifted on an unknown value. */
  observe(bridge, uid) {
    const state = bridge.units.get(uid);
    if (!state || !bridge.id) {
      return;
    }
    const prefix = `${bridge.id}:${uid}:`;
    for (const key of [...this.guards.keys()]) {
      if (!key.startsWith(prefix) || !this.guardActive(key)) {
        continue;
      }
      const field = key.slice(prefix.length);
      const value = state[field];
      if (value === undefined) {
        continue;
      }
      const guard = this.guards.get(key);
      if (!this.same(field, value, guard.from)) {
        guard.moved = true;
      }
      if (
        this.same(field, value, guard.expected) &&
        (guard.moved || this.same(field, guard.from, guard.expected))
      ) {
        this.guards.delete(key);
      }
    }
  }
}
