import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, LIMITS, ROOM_CODE_PATTERN } from '../netlify/server/rooms.mjs';

class Socket extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  messages = [];
  send(raw) { this.messages.push(JSON.parse(raw)); }
  close(code = 1000) { this.code = code; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  input(message) { this.dispatchEvent(new MessageEvent('message', { data: typeof message === 'string' ? message : JSON.stringify(message) })); }
}

function fixture() {
  let now = 1000;
  const manager = new RoomManager({ now: () => now });
  let sequence = 0;
  const peer = (ip = 'local') => { const socket = new Socket(); manager.attach(socket, ip); return socket; };
  const command = (socket, type, fields = {}) => {
    const requestId = `unit-${++sequence}`;
    socket.input({ type, requestId, ...fields });
    return socket.messages.find(message => message.requestId === requestId);
  };
  const room = host => command(host, 'create').code;
  return { manager, peer, command, room, advance: ms => { now += ms; } };
}

test('secure codes, roles, two-person capacity and room isolation', () => {
  const { peer, command, room } = fixture();
  const host = peer(), guest = peer(), third = peer(), other = peer();
  const code = room(host);
  assert.match(code, ROOM_CODE_PATTERN);
  assert.equal(host.messages.at(-1).role, 'host');
  assert.equal(command(guest, 'join', { code }).role, 'guest');
  assert.equal(command(third, 'join', { code }).code, 'ROOM_FULL');
  const otherCode = room(other);
  assert.notEqual(code, otherCode);
  assert.equal(command(host, 'signal', { data: { kind: 'probe', value: 42 } }).type, 'ok');
  assert.deepEqual(guest.messages.at(-1), { type: 'signal', from: 'host', data: { kind: 'probe', value: 42 } });
  assert.equal(other.messages.some(message => message.type === 'signal'), false);
  assert.equal(third.messages.some(message => message.type === 'signal'), false);
});

test('guest leave frees a slot; only host closes; disconnects clean every membership', () => {
  const { manager, peer, command, room } = fixture();
  const host = peer(), guest = peer(), replacement = peer();
  const code = room(host);
  command(guest, 'join', { code });
  assert.equal(command(guest, 'close').code, 'FORBIDDEN');
  assert.equal(command(guest, 'leave').type, 'left');
  assert.equal(host.messages.at(-1).players, 1);
  command(replacement, 'join', { code });
  host.close();
  assert.equal(manager.rooms.size, 0);
  assert.equal(replacement.messages.at(-1).reason, 'host-disconnected');
  assert.equal(manager.clients.get(replacement).room, null);
  assert.equal(command(guest, 'join', { code }).code, 'ROOM_NOT_FOUND');
  room(replacement);
  assert.equal(command(replacement, 'close').reason, 'host-closed');
  assert.equal(manager.rooms.size, 0);
  guest.close(); replacement.close();
  assert.equal(manager.clients.size, 0);
});

test('invalid input cannot mutate rooms or throw through the message listener', () => {
  const { manager, peer, command, room } = fixture();
  const host = peer();
  room(host);
  for (const code of ['', 'XXXXXXXXX', 'IIIIIIIIII', 'ABCDEFGHIJ', 123, {}, '../health']) {
    const socket = peer(String(code));
    assert.equal(command(socket, 'join', { code }).code, 'INVALID_CODE');
    socket.close();
  }
  for (const raw of ['null', '[]', '{', '{"type":{"toString":0},"requestId":"x"}', '{"type":"__proto__","requestId":"x"}']) {
    const socket = peer(raw);
    assert.doesNotThrow(() => socket.input(raw));
    assert.equal(socket.messages.at(-1).code, 'INVALID_MESSAGE');
    socket.close();
  }
  assert.equal(manager.rooms.size, 1);
});

test('byte size, binary frames, JSON depth and message rate are bounded', () => {
  const { peer, command } = fixture();
  const large = peer(); large.input('é'.repeat(LIMITS.messageBytes));
  assert.equal(large.code, 1009);
  const binary = peer(); binary.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(2) }));
  assert.equal(binary.code, 1003);
  const nested = peer();
  let data = {};
  for (let depth = 0; depth < 12; depth++) data = { child: data };
  assert.equal(command(nested, 'signal', { data }).code, 'INVALID_DATA');
  const flood = peer();
  for (let index = 0; index <= LIMITS.messageBurst; index++) command(flood, 'leave');
  assert.equal(flood.code, 1008);
});

test('join throttling survives reconnect; expired IP records are removed', () => {
  const { manager, peer, command, advance } = fixture();
  for (let index = 0; index < LIMITS.actionBurst; index++) {
    const socket = peer('same-ip'); command(socket, 'join', { code: 'ABCDEFGHJK' }); socket.close();
  }
  const next = peer('same-ip');
  assert.equal(command(next, 'create').code, 'RATE_LIMIT');
  advance(2000);
  assert.equal(command(next, 'create').type, 'room');
  next.close();
  advance(61000); manager.sweep();
  assert.equal(manager.ips.size, 0);
});

test('slow receivers are removed without relaying elsewhere', () => {
  const { manager, peer, command, room } = fixture();
  const host = peer(), guest = peer();
  const code = room(host); command(guest, 'join', { code });
  guest.bufferedAmount = LIMITS.bufferedBytes + 1;
  assert.equal(command(host, 'signal', { data: { kind: 'probe' } }).code, 'PEER_UNAVAILABLE');
  assert.equal(guest.code, 1008);
  assert.equal(manager.rooms.get(code).guest, null);
});

test('shutdown invalidates rooms, announces restart and closes with 1012', () => {
  const { manager, peer, command, room } = fixture();
  const host = peer(), guest = peer();
  command(guest, 'join', { code: room(host) });
  manager.shutdown();
  assert.equal(manager.rooms.size, 0);
  assert.equal(manager.clients.size, 0);
  assert.equal(manager.ips.size, 0);
  assert.equal(host.code, 1012);
  assert.equal(guest.code, 1012);
  assert.equal(host.messages.at(-1).type, 'server-restarting');
  assert.equal(manager.canConnect('new'), false);
  const replacement = new RoomManager();
  assert.notEqual(replacement.instanceId, manager.instanceId);
  assert.equal(replacement.rooms.size, 0);
});

test('each connection receives exactly one welcome even if open fires later', () => {
  const { peer } = fixture();
  const socket = peer();
  socket.dispatchEvent(new Event('open'));
  assert.equal(socket.messages.filter(message => message.type === 'welcome').length, 1);
});

test('connection limits are enforced per IP and release on disconnect', () => {
  const { manager, peer } = fixture();
  const sockets = Array.from({ length: LIMITS.connectionsPerIp }, () => peer());
  assert.equal(manager.canConnect('local'), false);
  const rejected = peer(); assert.equal(rejected.code, 1008);
  sockets[0].close();
  assert.equal(manager.canConnect('local'), true);
});
