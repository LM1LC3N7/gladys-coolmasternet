// -----------------------------------------------------------------------------
// The TCP session against a real local server (127.0.0.1, an ephemeral port):
// prompt, answers split anywhere, echo, errors, bounds in bytes and in time.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ERROR_KINDS, Slots, openSession, tcpConnect } from '../src/coolmaster/client.js';

/** A local server; `reply(line, socket)` answers each line. */
async function server(t, { prompt = '>', reply, onConnect } = {}) {
  const sockets = new Set();
  const srv = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    onConnect?.(socket);
    if (prompt) {
      socket.write(prompt);
    }
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString('latin1');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line !== '') {
          reply?.(line, socket);
        }
      }
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const s of sockets) s.destroy();
    srv.close();
  });
  return { host: '127.0.0.1', port: srv.address().port };
}

test('a session: prompt, answers split byte by byte, OK dropped, several requests', async (t) => {
  const address = await server(t, {
    reply: (line, socket) => {
      const answer = line === 'ls2' ? 'L1.100 ON 20C 25C Low Cool OK - 1\r\nOK\r\n>' : 'OK\r\n>';
      for (const char of answer) {
        socket.write(char);
      }
    },
  });
  const session = await openSession(address);
  t.after(() => session.close());
  const first = await session.request('ls2');
  assert.equal(first.text, 'L1.100 ON 20C 25C Low Cool OK - 1');
  assert.equal(first.ok, true);
  const second = await session.request('on L1.100');
  assert.deepEqual(second, { text: '', ok: true });
});

test('an echo of the command is dropped; Unknown command is rejected', async (t) => {
  const address = await server(t, {
    reply: (line, socket) => {
      socket.write(`${line}\r\n${line === 'ls2' ? 'Unknown command' : 'OK'}\r\n>`);
    },
  });
  const session = await openSession(address);
  t.after(() => session.close());
  assert.deepEqual(await session.request('set'), { text: '', ok: true });
  await assert.rejects(session.request('ls2'), (err) => {
    assert.equal(err.kind, ERROR_KINDS.REJECTED);
    assert.equal(err.unknownCommand, true);
    return true;
  });
});

test('the wake-up line feed when the bridge needs one', async (t) => {
  const address = await server(t, {
    prompt: '',
    reply: () => {},
    onConnect: (socket) => {
      socket.once('data', () => socket.write('\r\n>'));
    },
  });
  const session = await openSession(address, { wakeup: true, timeoutMs: 2_000 });
  session.close();
  await assert.rejects(openSession(address, { timeoutMs: 300 }), (err) => {
    assert.equal(err.kind, ERROR_KINDS.TIMEOUT);
    assert.equal(err.notSent, true);
    return true;
  });
});

test('an answer that never ends is cut at the byte limit', async (t) => {
  const address = await server(t, {
    reply: (_line, socket) => {
      const chunk = 'x'.repeat(4096);
      for (let i = 0; i < 20; i += 1) {
        socket.write(chunk);
      }
    },
  });
  const session = await openSession(address);
  await assert.rejects(session.request('ls2', { timeoutMs: 3_000 }), (err) => {
    assert.equal(err.kind, ERROR_KINDS.PROTOCOL);
    return true;
  });
  assert.equal(session.closed, true);
});

test('a silent bridge: timeout, the request counted as written', async (t) => {
  const address = await server(t, { reply: () => {} });
  const session = await openSession(address);
  await assert.rejects(session.request('on L1.100', { timeoutMs: 200 }), (err) => {
    assert.equal(err.kind, ERROR_KINDS.TIMEOUT);
    return true;
  });
  assert.equal(session.written, true);
});

test('beforeSend refuses before anything is written', async (t) => {
  const lines = [];
  const address = await server(t, { reply: (line) => lines.push(line) });
  const session = await openSession(address);
  t.after(() => session.close());
  await assert.rejects(
    session.request('on L1.100', {
      beforeSend: () => {
        throw new Error('off');
      },
    }),
    (err) => err.notSent === true && err.beforeSend === true,
  );
  assert.equal(session.written, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(lines, []);
});

test('nothing listening: unreachable, nothing sent', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  await assert.rejects(tcpConnect({ host: '127.0.0.1', port }, { timeoutMs: 1_000 }), (err) => {
    assert.equal(err.kind, ERROR_KINDS.UNREACHABLE);
    return true;
  });
});

test('slots: two shared, a late waiter leaves the queue', async () => {
  const slots = new Slots(2);
  const a = await slots.acquire();
  const b = await slots.acquire();
  await assert.rejects(slots.acquire({ waitMs: 20 }), (err) => err.kind === ERROR_KINDS.LATE);
  const waiting = slots.acquire();
  a();
  a();
  const c = await waiting;
  b();
  c();
  assert.equal(slots.used, 0);
});

test('wake-up: ">" on connection, then "\r\n>" for the line feed: no answer shifted', async (t) => {
  const address = await server(t, {
    reply: (line, socket) => {
      if (line === 'set') {
        socket.write('serial number : 283B96001234\r\nOK\r\n>');
      } else if (line === 'ls2') {
        socket.write('L1.100 ON 20C 25C Low Cool OK - 1\r\nOK\r\n>');
      }
    },
    onConnect: (socket) => {
      socket.on('data', (data) => {
        if (data.toString('latin1') === '\n') {
          setTimeout(() => socket.write('\r\n>'), 20);
        }
      });
    },
  });
  const session = await openSession(address, { wakeup: true, timeoutMs: 2_000 });
  t.after(() => session.close());
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match((await session.request('set')).text, /serial number/);
  assert.match((await session.request('ls2')).text, /^L1\.100 ON/);
});

test('what arrives before a request is never taken for its answer', async (t) => {
  const address = await server(t, {
    reply: (line, socket) => {
      if (line === 'set') {
        // A stray prompt, then the answer.
        socket.write('\r\n>');
        setTimeout(() => socket.write('version : 1\r\nOK\r\n>'), 30);
      } else {
        socket.write('L1.100 ON 20C 25C Low Cool OK - 1\r\nOK\r\n>');
      }
    },
  });
  const session = await openSession(address);
  t.after(() => session.close());
  const first = await session.request('set');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const second = await session.request('ls2');
  assert.match(second.text, /^L1\.100 ON/, `set answered ${JSON.stringify(first)}`);
});
