import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;
export const LIMITS = Object.freeze({
  messageBytes: 16384, bufferedBytes: 65536,
  connections: 200, connectionsPerIp: 8, rooms: 100, ipEntries: 2048,
  messageBurst: 20, messagesPerSecond: 10,
  actionBurst: 10, actionsPerSecond: 0.5,
});

function consume(bucket, burst, rate, now) {
  bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.at) * rate / 1000);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens--;
  return true;
}

function validData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const stack = [[data, 0]];
  let count = 0;
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (++count > 512 || depth > 8) return false;
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) stack.push([child, depth + 1]);
    }
  }
  return true;
}

/** Ephemeral rooms belong to this instance. No identities or game data are stored. */
export class RoomManager {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.instanceId = randomUUID();
    this.clients = new Map();
    this.rooms = new Map();
    this.ips = new Map();
    this.stopping = false;
  }

  sweep() {
    const now = this.now();
    for (const [ip, entry] of this.ips) {
      if (entry.connections === 0 && now - entry.at > 60000) this.ips.delete(ip);
    }
  }

  canConnect(ip) {
    this.sweep();
    if (this.stopping || this.clients.size >= LIMITS.connections) return false;
    const entry = this.ips.get(ip);
    if (!entry && this.ips.size >= LIMITS.ipEntries) return false;
    return !entry || entry.connections < LIMITS.connectionsPerIp;
  }

  attach(socket, ip) {
    if (!this.canConnect(ip)) { socket.close(1008, 'Connection limit'); return; }
    const now = this.now();
    const entry = this.ips.get(ip) ?? { connections: 0, tokens: LIMITS.actionBurst, at: now };
    entry.connections++;
    this.ips.set(ip, entry);
    const client = {
      socket, ip, room: null, role: null, violations: 0,
      bucket: { tokens: LIMITS.messageBurst, at: now },
    };
    this.clients.set(socket, client);
    let welcomed = false;
    const welcome = () => {
      if (welcomed) return;
      welcomed = true;
      this.send(client, { type: 'welcome', protocol: 1, instanceId: this.instanceId });
    };
    socket.addEventListener('open', welcome, { once: true });
    socket.addEventListener('message', event => this.receive(client, event.data));
    socket.addEventListener('close', () => this.disconnect(client));
    socket.addEventListener('error', () => this.drop(client, 1011, 'Connection error'));
    if (socket.readyState === 1) welcome();
  }

  send(client, message) {
    if (!this.clients.has(client.socket)) return false;
    if (client.socket.readyState !== 1 || client.socket.bufferedAmount > LIMITS.bufferedBytes) {
      this.drop(client, 1008, 'Slow connection');
      return false;
    }
    try { client.socket.send(JSON.stringify(message)); return true; }
    catch { this.drop(client, 1011, 'Send failed'); return false; }
  }

  error(client, requestId, code, message) {
    this.send(client, { type: 'error', requestId, code, message });
  }

  drop(client, code, reason) {
    this.disconnect(client);
    try { client.socket.close(code, reason); } catch { /* Already closed. */ }
  }

  disconnect(client) {
    if (!this.clients.delete(client.socket)) return;
    const entry = this.ips.get(client.ip);
    entry.connections--;
    entry.at = this.now();
    this.depart(client, 'host-disconnected');
  }

  roomState(client, requestId) {
    const room = client.room;
    if (!room) return;
    this.send(client, { type: 'room', requestId, code: room.code, role: client.role, players: room.guest ? 2 : 1 });
  }

  closeRoom(room, reason, requestId) {
    this.rooms.delete(room.code);
    for (const member of [room.host, room.guest]) {
      if (!member) continue;
      member.room = null;
      member.role = null;
      this.send(member, { type: 'room-closed', reason, requestId: member === room.host ? requestId : undefined });
    }
  }

  depart(client, reason = 'host-left') {
    const room = client.room;
    if (!room) return;
    if (client.role === 'host') this.closeRoom(room, reason);
    else {
      room.guest = null;
      client.room = null;
      client.role = null;
      this.roomState(room.host);
    }
  }

  receive(client, raw) {
    if (!this.clients.has(client.socket) || this.stopping) return;
    if (typeof raw !== 'string') { this.drop(client, 1003, 'Text JSON required'); return; }
    if (Buffer.byteLength(raw, 'utf8') > LIMITS.messageBytes) { this.drop(client, 1009, 'Message too large'); return; }
    if (!consume(client.bucket, LIMITS.messageBurst, LIMITS.messagesPerSecond, this.now())) {
      this.drop(client, 1008, 'Message rate exceeded'); return;
    }
    let message;
    try { message = JSON.parse(raw); } catch { /* Validated below. */ }
    const allowed = { create: [], join: ['code'], leave: [], close: [], signal: ['data'] };
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || typeof message.type !== 'string'
      || !Object.hasOwn(allowed, message.type)
      || typeof message.requestId !== 'string' || !/^[\w-]{1,64}$/.test(message.requestId)
      || Object.keys(message).some(key => !['type', 'requestId', ...allowed[message.type]].includes(key))) {
      this.error(client, null, 'INVALID_MESSAGE', 'Mensaje de señalización inválido.');
      if (++client.violations >= 3) this.drop(client, 1008, 'Invalid protocol');
      return;
    }
    const { type, requestId } = message;
    if (type === 'create' || type === 'join') {
      if (!consume(this.ips.get(client.ip), LIMITS.actionBurst, LIMITS.actionsPerSecond, this.now())) {
        this.error(client, requestId, 'RATE_LIMIT', 'Demasiados intentos. Espera unos segundos.'); return;
      }
      if (client.room) { this.error(client, requestId, 'ALREADY_IN_ROOM', 'Abandona tu sala antes de entrar en otra.'); return; }
    }

    switch (type) {
      case 'create': {
        if (this.rooms.size >= LIMITS.rooms) { this.error(client, requestId, 'SERVER_BUSY', 'No hay espacio para otra sala.'); return; }
        let code;
        do { code = [...randomBytes(10)].map(byte => ALPHABET[byte & 31]).join(''); }
        while (this.rooms.has(code));
        const room = { code, host: client, guest: null };
        this.rooms.set(code, room);
        client.room = room;
        client.role = 'host';
        this.roomState(client, requestId);
        break;
      }
      case 'join': {
        if (typeof message.code !== 'string' || !ROOM_CODE_PATTERN.test(message.code)) {
          this.error(client, requestId, 'INVALID_CODE', 'El código debe tener 10 letras o números válidos.'); return;
        }
        const room = this.rooms.get(message.code);
        if (!room) { this.error(client, requestId, 'ROOM_NOT_FOUND', 'La sala no existe o ya se cerró.'); return; }
        if (room.guest) { this.error(client, requestId, 'ROOM_FULL', 'La sala ya tiene dos personas.'); return; }
        room.guest = client;
        client.room = room;
        client.role = 'guest';
        this.roomState(client, requestId);
        this.roomState(room.host);
        break;
      }
      case 'leave':
        this.depart(client);
        this.send(client, { type: 'left', requestId });
        break;
      case 'close':
        if (!client.room || client.role !== 'host') {
          this.error(client, requestId, 'FORBIDDEN', 'Solo el host puede cerrar esta sala.'); return;
        }
        this.closeRoom(client.room, 'host-closed', requestId);
        break;
      case 'signal': {
        if (!validData(message.data)) { this.error(client, requestId, 'INVALID_DATA', 'La señal debe ser un objeto JSON pequeño.'); return; }
        const room = client.room;
        const peer = client.role === 'host' ? room?.guest : room?.host;
        if (!peer || !this.send(peer, { type: 'signal', from: client.role, data: message.data })) {
          this.error(client, requestId, 'PEER_UNAVAILABLE', 'La otra persona no está conectada.'); return;
        }
        this.send(client, { type: 'ok', requestId });
        break;
      }
    }
  }

  shutdown() {
    this.stopping = true;
    this.rooms.clear();
    for (const client of [...this.clients.values()]) {
      client.room = null;
      client.role = null;
      this.send(client, { type: 'server-restarting' });
      this.drop(client, 1012, 'Server restarting');
    }
    this.ips.clear();
  }
}
