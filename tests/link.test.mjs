import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Link, readStunServers } from '../public/js/link.js';

const hostId = '11111111-1111-4111-8111-111111111111';
const guestId = '22222222-2222-4222-8222-222222222222';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

class Rooms extends EventTarget {
  sent = [];
  room = { code: 'ABCDEFGHJK', role: 'guest', players: 2 };
  getState() { return { connection: 'connected', room: this.room }; }
  async sendSignal(data) { this.sent.push(structuredClone(data)); }
  signal(data) { this.dispatchEvent(new CustomEvent('signal', { detail: { from: this.room.role === 'host' ? 'guest' : 'host', data } })); }
}
class Channel extends EventTarget {
  label = 'link'; ordered = true; maxRetransmits = null; maxPacketLifeTime = null;
  readyState = 'connecting'; bufferedAmount = 0; sent = [];
  send(bytes) { this.sent.push(bytes.slice()); }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
}
class Peer extends EventTarget {
  remoteDescription = null; connectionState = 'new'; candidates = []; remoteCalls = 0; answers = 0;
  channel = new Channel();
  createDataChannel(label, options) { this.channel.label = label; this.channel.ordered = options.ordered; return this.channel; }
  async createOffer() { return { type: 'offer', sdp: 'test-offer' }; }
  async createAnswer() { this.answers++; return { type: 'answer', sdp: 'test-answer' }; }
  async setLocalDescription(description) { this.localDescription = { ...description, toJSON: () => description }; }
  async setRemoteDescription(description) { this.remoteCalls++; this.remoteDescription = description; }
  async addIceCandidate(candidate) { assert.ok(this.remoteDescription); this.candidates.push(candidate); }
  close() { this.connectionState = 'closed'; }
}
function setup(role = 'guest') {
  const rooms = new Rooms(); rooms.room.role = role;
  const core = { status: 'running', link: 'inactive', romId: 'a'.repeat(64) };
  const calls = { reserve: 0, attach: 0, stop: 0 };
  const emulator = {
    getState: () => core,
    reserveLink: () => calls.reserve++,
    startLink: options => { calls.attach++; core.link = 'handshake'; emulator.options = options; },
    stopLink: () => { calls.stop++; if (core.link !== 'inactive') emulator.options.onBytes(new Uint8Array([2, 0, 0, 0, 5, 1])); core.link = 'inactive'; },
    feedLink: () => {},
  };
  let pc;
  const link = new Link({ multiplayer: rooms, emulator, createPeerConnection: () => (pc = new Peer()) });
  const ready = async () => {
    link.connect();
    rooms.signal({ t: 'link-ready', id: role === 'host' ? guestId : hostId, romId: core.romId });
    await wait(0);
  };
  return { link, rooms, emulator, calls, core, ready, get pc() { return pc; } };
}

test('STUN is explicit and TURN or malformed configuration is rejected', () => {
  assert.deepEqual(readStunServers({ getItem: () => null }), []);
  assert.deepEqual(readStunServers({ getItem: () => '["stun:stun.example:3478"]' }), [{ urls: 'stun:stun.example:3478' }]);
  assert.throws(() => readStunServers({ getItem: () => '["turn:relay.example"]' }), /STUN/);
  assert.throws(() => readStunServers({ getItem: () => '{}' }), /STUN/);
});

test('legal diagnostic ROMs retain the exact pinned upstream bytes', async () => {
  const hashes = {
    attachtest: '4dc489ba2990e3c91219a57080d2572028d1e44a92ca2cf6aab91bdd70d31506',
    linktest: 'e4ff0b32961571cbc857d4885a3495ea1bd73066c4957786e0bf62bb740fc09a',
    normlinktest: 'ab1506603ae2f6d73fd4a147fb66141af2113697158ef96a2ebf677ef4f03b1f',
    norm32linktest: '86c7a9dc848001e59c3c6135a218b42f90d284924805a9facfd0747278290756',
  };
  for (const [name, hash] of Object.entries(hashes)) {
    const bytes = await readFile(new URL(`./fixtures/link/${name}.gba`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
  }
});

test('ICE is retained until remote SDP; duplicate offers do not restart negotiation', async () => {
  const f = setup();
  try {
    await f.ready();
    const session = f.link.session.id;
    f.rooms.signal({ t: 'ice', session, c: [{ candidate: 'one' }, { candidate: 'two' }, null] });
    await wait(0);
    assert.equal(f.pc.candidates.length, 0);
    const offer = { t: 'sdp', session, d: { type: 'offer', sdp: 'remote-offer' } };
    f.rooms.signal(offer); f.rooms.signal(offer);
    await wait(0);
    assert.equal(f.pc.remoteCalls, 1);
    assert.equal(f.pc.answers, 1);
    assert.deepEqual(f.pc.candidates, [{ candidate: 'one' }, { candidate: 'two' }, null]);
  } finally { await f.link.destroy(); }
});

test('old pairing packets cannot configure the current peer', async () => {
  const f = setup();
  try {
    await f.ready();
    f.rooms.signal({ t: 'sdp', session: 'stale', d: { type: 'offer', sdp: 'wrong-session' } });
    await wait(0);
    assert.equal(f.pc.remoteCalls, 0);
  } finally { await f.link.destroy(); }
});

test('the host creates exactly one reliable ordered Link channel', async () => {
  const f = setup('host');
  try {
    await f.ready();
    assert.equal(f.pc.channel.label, 'link');
    assert.equal(f.pc.channel.ordered, true);
    assert.equal(f.pc.channel.maxRetransmits, null);
    f.pc.channel.readyState = 'open';
    f.pc.channel.dispatchEvent(new Event('open'));
    f.pc.channel.dispatchEvent(new Event('open'));
    assert.equal(f.calls.attach, 1);
    assert.equal(f.pc.channel.binaryType, 'arraybuffer');
  } finally { await f.link.destroy(); }
});

test('backpressure queues packets and clean shutdown drains BYE before closing', async () => {
  const f = setup('host');
  await f.ready();
  const channel = f.pc.channel;
  channel.readyState = 'open'; channel.dispatchEvent(new Event('open'));
  channel.bufferedAmount = 200000;
  f.emulator.options.onBytes(new Uint8Array([1, 2, 3]));
  assert.equal(channel.sent.length, 0);
  channel.bufferedAmount = 0;
  channel.dispatchEvent(new Event('bufferedamountlow'));
  assert.deepEqual([...channel.sent[0]], [1, 2, 3]);
  await f.link.disconnect();
  assert.deepEqual([...channel.sent.at(-1)], [2, 0, 0, 0, 5, 1]);
  assert.equal(channel.readyState, 'closed');
  assert.equal(f.pc.connectionState, 'closed');
  assert.equal(f.link.session, null);
  await f.link.destroy();
});

test('oversized SDP is rejected before sending and ICE bursts are paced and batched', async () => {
  const f = setup();
  try {
    await f.ready();
    assert.throws(() => f.link.queueSignal({ t: 'sdp', d: { sdp: 'x'.repeat(16384) } }), /tamaño/);
    const session = f.link.session.id;
    for (let index = 0; index < 20; index++) f.link.queueSignal({ t: 'ice', session, c: { candidate: String(index) } });
    await wait(550);
    const sent = f.rooms.sent.filter(message => message.t === 'ice').flatMap(message => message.c);
    assert.equal(sent.length, 20);
    assert.ok(f.rooms.sent.every(message => new TextEncoder().encode(JSON.stringify(message)).length <= 15000));
    assert.ok(f.rooms.sent.length <= 4);
  } finally { await f.link.destroy(); }
});

test('room loss cancels negotiation and a failed old SDP cannot end a new attempt', async () => {
  const f = setup();
  try {
    await f.ready();
    let rejectOld;
    const oldPeer = f.pc;
    oldPeer.setRemoteDescription = () => new Promise((_, reject) => { rejectOld = reject; });
    f.rooms.signal({ t: 'sdp', session: f.link.session.id, d: { type: 'offer', sdp: 'old-offer' } });
    await wait(0);
    f.rooms.room = null;
    f.rooms.dispatchEvent(new CustomEvent('statechange', { detail: f.rooms.getState() }));
    assert.equal(f.link.getState().active, false);
    assert.equal(oldPeer.connectionState, 'closed');
    assert.equal(f.calls.stop, 1);
    f.rooms.room = { code: 'NEWROOM234', role: 'guest', players: 2 };
    f.rooms.dispatchEvent(new CustomEvent('statechange', { detail: f.rooms.getState() }));
    f.link.connect();
    rejectOld(new Error('old negotiation was closed'));
    await wait(0);
    assert.equal(f.link.getState().status, 'waiting');
    assert.equal(f.link.getState().active, true);
  } finally { await f.link.destroy(); }
});

test('invalid incoming binary ends the session with bounded cleanup', async () => {
  const f = setup('host');
  try {
    await f.ready();
    const channel = f.pc.channel;
    channel.readyState = 'open'; channel.dispatchEvent(new Event('open'));
    channel.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(65537) }));
    await wait(0);
    assert.equal(f.link.getState().status, 'error');
    assert.equal(f.link.getState().active, false);
    assert.equal(channel.readyState, 'closed');
    assert.equal(f.core.link, 'inactive');
  } finally { await f.link.destroy(); }
});

test('different or missing ROM SHA-256 is rejected before constructing RTC and remains specific after close', async () => {
  for (const romId of ['b'.repeat(64), undefined]) {
    const f = setup();
    try {
      f.link.connect();
      f.rooms.signal({ t: 'link-ready', id: hostId, romId });
      await wait(0);
      assert.equal(f.pc, undefined);
      assert.equal(f.calls.attach, 0);
      assert.equal(f.link.getState().status, 'error');
      assert.match(f.link.getState().message, /SHA-256/);
      assert.equal(f.rooms.sent.at(-1).code, 'ROM_SHA_MISMATCH');
      await f.link.disconnect('Rival desconectado');
      assert.match(f.link.getState().message, /SHA-256/);
    } finally { await f.link.destroy(); }
  }
});

test('specific peer CRC rejection survives channel and room teardown', async () => {
  const f = setup();
  try {
    await f.ready();
    f.rooms.signal({ t: 'link-stop', id: hostId, code: 'CRC_MISMATCH' });
    await wait(0);
    f.rooms.room = null;
    f.rooms.dispatchEvent(new CustomEvent('statechange', { detail: f.rooms.getState() }));
    assert.equal(f.link.getState().status, 'error');
    assert.match(f.link.getState().message, /CRC mismatch/);
    await f.link.disconnect('Error de transporte posterior', { error: true });
    assert.match(f.link.getState().message, /CRC mismatch/);
    assert.equal(f.link.getState().active, false);
  } finally { await f.link.destroy(); }
});
