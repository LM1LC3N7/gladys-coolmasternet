// -----------------------------------------------------------------------------
// Fake CoolMasterNet bridges behind the `connect` the integration is given:
// the prompt, `set`, `ls2` / `stat2`, `query <uid> s` and the commands, as
// pycoolmasternet-async 0.2.6 reads and writes them (made up from its code and
// tests, never captured from a real bridge). Records every connection and
// every line. No network. Delays use setTimeout, so the mocked clock drives
// them; immediate answers use setImmediate.
// -----------------------------------------------------------------------------

export const HOST = '192.168.1.50';
export const HOST2 = '192.168.1.51';
export const SERIAL = '283b96001234';
export const SERIAL2 = '283b96005678';
export const NOW = Date.UTC(2026, 9, 22, 18, 0, 0);

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function unit(over = {}) {
  return {
    on: true,
    unit: 'C',
    setpoint: 21,
    temperature: 23.5,
    fan: 'low',
    mode: 'cool',
    error: null,
    filter: false,
    demand: true,
    swing: 'a',
    ...over,
  };
}

export function bridge(over = {}) {
  return {
    serial: SERIAL,
    /** Lines of `set` (undefined: the default, with the serial). */
    info: undefined,
    units: { 'L1.100': unit(), 'L1.101': unit({ on: false, mode: 'heat', fan: 'auto' }) },
    /** Only `stat2` (an older firmware). */
    stat2Only: false,
    /** Nothing accepts the connection. */
    down: false,
    /** The command line echoes what it receives. */
    echo: false,
    /** command word -> ms before answering ("ls2", "temp", ...). */
    delays: {},
    /** command words never answered. */
    silent: [],
    /** false: a command answers OK and changes nothing. */
    applies: true,
    ...over,
  };
}

function statusLine(uid, u, demand) {
  const t = (v) => `${String(v).replace('.', ',')}${u.unit}`;
  const fields = [
    uid,
    u.on ? 'ON' : 'OFF',
    `${u.setpoint}${u.unit}`,
    t(u.temperature),
    cap(u.fan),
    cap(u.mode),
    u.error ?? 'OK',
    u.filter ? '#' : '-',
  ];
  if (demand) {
    fields.push(u.demand ? '1' : '0');
  }
  return fields.join(' ');
}

const ok = (lines = []) => `${lines.map((l) => `${l}\r\n`).join('')}OK\r\n>`;

export function fakeBridges(map = { [HOST]: bridge() }) {
  const server = {
    bridges: map,
    /** Every line received: { host, line, at }. */
    lines: [],
    connections: [],
    open: 0,
    maxOpen: 0,
    commands(word) {
      return server.lines.filter((l) => l.line.split(' ')[0] === word);
    },
    writes() {
      return server.lines.filter(
        (l) => !['set', 'ls2', 'stat2', 'query'].includes(l.line.split(' ')[0]),
      );
    },
    answer(b, line) {
      const [word, ...args] = line.trim().split(/\s+/);
      switch (word) {
        case 'set':
          return ok(
            b.info ?? [
              'Baud Rate      : 9600',
              'version        : 0.9.1',
              ...(b.serial ? [`serial number  : ${b.serial.toUpperCase()}`] : []),
            ],
          );
        case 'ls2':
        case 'stat2': {
          if (word === 'ls2' && b.stat2Only) {
            return 'Unknown command\r\n>';
          }
          const uids = args[0] ? [args[0]] : Object.keys(b.units);
          return ok(
            uids.filter((u) => b.units[u]).map((u) => statusLine(u, b.units[u], word === 'ls2')),
          );
        }
        case 'query':
          return b.units[args[0]] ? ok([b.units[args[0]].swing]) : 'Unknown unit\r\n>';
        default: {
          const u = b.units[args.at(-1)] ?? b.units[args[0]];
          if (!u) {
            return 'Unknown unit\r\n>';
          }
          if (b.applies) {
            if (word === 'on' || word === 'off') u.on = word === 'on';
            else if (['cool', 'heat', 'auto', 'dry', 'fan'].includes(word)) u.mode = word;
            else if (word === 'temp') u.setpoint = Number(args[1]);
            else if (word === 'fspeed') u.fan = args[1];
            else if (word === 'swing') u.swing = args[1];
            else return 'Unknown command\r\n>';
          }
          return ok();
        }
      }
    },
    connect({ host, port }) {
      const b = server.bridges[host];
      const record = { host, port, at: Date.now(), closed: false };
      server.connections.push(record);
      if (!b || b.down) {
        return Promise.reject(Object.assign(new Error('refused'), { kind: 'unreachable' }));
      }
      const handlers = { data: [], close: [] };
      let buffer = '';
      let closed = false;
      server.open += 1;
      server.maxOpen = Math.max(server.maxOpen, server.open);
      const emit = (text) => {
        if (!closed) {
          for (const fn of handlers.data) fn(Buffer.from(text, 'latin1'));
        }
      };
      const socket = {
        on(event, fn) {
          handlers[event === 'close' ? 'close' : 'data'].push(fn);
        },
        destroy() {
          if (!closed) {
            closed = true;
            record.closed = true;
            server.open -= 1;
          }
        },
        write(text) {
          buffer += text;
          let index;
          while ((index = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);
            if (line === '') {
              continue;
            }
            server.lines.push({ host, line, at: Date.now() });
            const word = line.split(' ')[0];
            if (b.silent.includes(word)) {
              continue;
            }
            const reply = (b.echo ? `${line}\r\n` : '') + server.answer(b, line);
            const delay = b.delays[word];
            if (delay) {
              setTimeout(() => emit(reply), delay);
            } else {
              setImmediate(() => emit(reply));
            }
          }
        },
      };
      setImmediate(() => emit('>'));
      return Promise.resolve(socket);
    },
  };
  return server;
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
