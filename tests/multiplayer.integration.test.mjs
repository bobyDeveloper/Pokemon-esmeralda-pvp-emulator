import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Multiplayer } from '../public/js/multiplayer.js';

const origin = process.env.SIGNAL_TEST_URL ?? 'http://localhost:8888';
const endpoint = new URL('/api/signal', origin);
endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
const clients = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function client() {
  const peer = new Multiplayer(endpoint);
  clients.push(peer);
  await peer.connect();
  return peer;
}
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the real server.');
    await wait(20);
  }
}
// All clients share localhost's IP. Respect the production join/create quota
// across test cases rather than disabling the server's rate limiter for tests.
async function available(action) {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      if (error.code !== 'RATE_LIMIT' || attempt >= 10) throw error;
      await wait(2100);
    }
  }
}
afterEach(async () => {
  for (const peer of clients.splice(0)) peer.disconnect();
  await wait(100);
});

test('Netlify dev serves health, static assets and the required upgrade route', async () => {
  const health = await fetch(new URL('/api/health', origin));
  assert.equal(health.status, 200);
  const data = await health.json();
  assert.equal(data.ok, true);
  assert.equal(data.protocol, 1);
  assert.match(data.instanceId, /^[\da-f-]{36}$/);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const privateFile = await fetch(new URL('/api/admin/rom', origin));
  assert.ok([401, 404].includes(privateFile.status));
  assert.equal(privateFile.headers.get('cache-control'), 'private, no-store');
  assert.equal(privateFile.headers.has('access-control-allow-origin'), false);
  assert.equal((await fetch(new URL('/api/signal', origin))).status, 426);
  assert.equal((await fetch(new URL('/api/missing', origin))).status, 404);
  assert.equal((await fetch(new URL('/api/health', origin), { method: 'POST' })).status, 405);
  assert.equal((await fetch(new URL('/api/signal', origin), { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="game-screen" width="240" height="160"/);
});

test('two real native WebSockets create/join; a third is rejected; messages stay in their room', async () => {
  const host = await client(), guest = await client(), outsider = await client();
  const created = await available(() => host.createRoom());
  assert.equal(created.role, 'host');
  assert.match(created.code, /^[A-HJ-NP-Z2-9]{10}$/);
  const joined = await available(() => guest.joinRoom(created.code.toLowerCase()));
  assert.equal(joined.role, 'guest');
  await until(() => host.getState().room?.players === 2);
  await assert.rejects(available(() => outsider.joinRoom(created.code)), { code: 'ROOM_FULL' });
  await available(() => outsider.createRoom());
  const guestSignals = [], outsiderSignals = [];
  guest.addEventListener('signal', event => guestSignals.push(event.detail));
  outsider.addEventListener('signal', event => outsiderSignals.push(event.detail));
  await host.sendSignal({ kind: 'probe', sequence: 1 });
  await until(() => guestSignals.length === 1);
  assert.deepEqual(guestSignals[0], { from: 'host', data: { kind: 'probe', sequence: 1 } });
  await wait(60);
  assert.deepEqual(outsiderSignals, []);
  await assert.rejects(outsider.sendSignal({ kind: 'probe' }), { code: 'PEER_UNAVAILABLE' });
});

test('bad codes fail; leaving frees a slot; guest cannot close; host close clears both clients', async () => {
  const host = await client(), guest = await client();
  await assert.rejects(available(() => guest.joinRoom('INVALID')), { code: 'INVALID_CODE' });
  const { code } = await available(() => host.createRoom());
  await available(() => guest.joinRoom(code));
  await assert.rejects(guest.closeRoom(), { code: 'FORBIDDEN' });
  await guest.leaveRoom();
  await until(() => host.getState().room?.players === 1);
  assert.equal(guest.getState().room, null);
  await available(() => guest.joinRoom(code));
  await host.closeRoom();
  await until(() => guest.getState().room === null);
  assert.equal(host.getState().room, null);
});

test('disconnect cleans the host room and permits another room without reviving the old code', async () => {
  const host = await client(), guest = await client();
  const { code } = await available(() => host.createRoom());
  await available(() => guest.joinRoom(code));
  host.disconnect();
  await until(() => guest.getState().room === null);
  assert.match(guest.getState().notice, /host se desconectó/);
  await assert.rejects(available(() => guest.joinRoom(code)), { code: 'ROOM_NOT_FOUND' });
  await available(() => guest.createRoom());
  assert.equal(guest.getState().room.role, 'host');
});

test('unexpected socket loss clears membership and reconnects without replaying join/create', async () => {
  const host = await client();
  await available(() => host.createRoom());
  host.socket.close(4000, 'Integration disconnect');
  await until(() => host.getState().room === null);
  await until(() => host.getState().connection === 'connected');
  assert.equal(host.getState().room, null);
  assert.match(host.getState().notice, /sala anterior/);
});

test('binary and oversized raw messages are rejected by the real WebSocket endpoint', async () => {
  for (const [payload, code] of [[new Uint8Array([1, 2]), 1003], ['x'.repeat(16385), 1009]]) {
    const socket = new WebSocket(endpoint);
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Close timeout')), 4000);
      socket.addEventListener('close', event => { clearTimeout(timer); resolve(event.code); });
      socket.addEventListener('error', () => {});
    });
    await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
    socket.send(payload);
    assert.equal(await closed, code);
  }
});

test('the real endpoint closes message floods without disabling its rate limiter', async () => {
  const socket = new WebSocket(endpoint);
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Rate-limit close timeout')), 4000);
    socket.addEventListener('close', event => { clearTimeout(timer); resolve(event.code); });
    socket.addEventListener('error', () => {});
  });
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  for (let index = 0; index < 25; index++) socket.send(JSON.stringify({ type: 'leave', requestId: `flood-${index}` }));
  assert.equal(await closed, 1008);
});

test('cancelling a connection does not poison the next connection attempt', async () => {
  const peer = new Multiplayer(endpoint);
  clients.push(peer);
  const pending = peer.connect();
  const cancelled = assert.rejects(pending, /cancelada/);
  peer.disconnect();
  await cancelled;
  await peer.connect();
  assert.equal(peer.getState().connection, 'connected');
  assert.equal(peer.getState().room, null);
});
