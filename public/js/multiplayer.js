const MESSAGE_BYTES = 16384;
const REQUEST_TIMEOUT = 10000;

/** Signaling only. This module never reads the ROM, Canvas or emulator inputs. */
export class Multiplayer extends EventTarget {
  constructor(url = new URL('/api/signal', globalThis.location.href)) {
    super();
    this.url = new URL(url);
    this.url.protocol = this.url.protocol === 'https:' || this.url.protocol === 'wss:' ? 'wss:' : 'ws:';
    this.state = { connection: 'disconnected', room: null, notice: '', instanceId: null };
    this.socket = null;
    this.connectionPromise = null;
    this.pending = new Map();
    this.sequence = 0;
    this.attempts = 0;
    this.active = false;
    this.retryTimer = null;
    this.cancelConnection = null;
  }

  getState() { return { ...this.state, room: this.state.room ? { ...this.state.room } : null }; }
  notify() { this.dispatchEvent(new CustomEvent('statechange', { detail: this.getState() })); }

  connect() {
    if (this.state.connection === 'connected') return Promise.resolve();
    if (this.connectionPromise) return this.connectionPromise;
    this.active = true;
    clearTimeout(this.retryTimer);
    this.state.connection = this.attempts ? 'reconnecting' : 'connecting';
    this.notify();
    let resolveConnection;
    let rejectConnection;
    const promise = new Promise((resolve, reject) => { resolveConnection = resolve; rejectConnection = reject; });
    this.connectionPromise = promise;
    let socket;
    try { socket = new WebSocket(this.url); }
    catch (error) {
      this.connectionPromise = null;
      this.state.connection = 'disconnected';
      this.notify();
      rejectConnection(error);
      return promise;
    }
    this.socket = socket;
    const timeout = setTimeout(() => socket.close(4001, 'Connection timeout'), REQUEST_TIMEOUT);
    let settled = false;
    const settle = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (this.connectionPromise === promise) {
        this.connectionPromise = null;
        this.cancelConnection = null;
      }
      if (error) rejectConnection(error);
      else resolveConnection();
    };
    this.cancelConnection = settle;
    socket.addEventListener('message', event => {
      if (socket !== this.socket) return;
      let message;
      try {
        if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > MESSAGE_BYTES) throw new Error();
        message = JSON.parse(event.data);
        if (!message || typeof message.type !== 'string') throw new Error();
      } catch { socket.close(4000, 'Invalid protocol'); return; }
      if (message.type === 'welcome') {
        if (message.protocol !== 1 || typeof message.instanceId !== 'string') {
          socket.close(4000, 'Unsupported protocol'); return;
        }
        this.state.connection = 'connected';
        this.state.instanceId = message.instanceId;
        this.attempts = 0;
        settle();
      } else if (message.type === 'room') {
        this.state.room = { code: message.code, role: message.role, players: message.players };
        this.state.notice = '';
      } else if (message.type === 'left' || message.type === 'room-closed') {
        this.state.room = null;
        this.state.notice = message.reason === 'host-disconnected' ? 'El host se desconectó. La sala se ha cerrado.' : 'Has salido de la sala.';
      } else if (message.type === 'server-restarting') {
        this.state.room = null;
        this.state.notice = 'El servidor se reinicia. La sala anterior ya no está disponible.';
      } else if (message.type === 'signal') {
        this.dispatchEvent(new CustomEvent('signal', { detail: { from: message.from, data: message.data } }));
      } else if (message.type === 'error') this.state.notice = message.message;

      const pending = this.pending.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        if (message.type === 'error') {
          const error = new Error(message.message);
          error.code = message.code;
          pending.reject(error);
        } else pending.resolve(message);
      }
      if (message.type !== 'signal' && message.type !== 'ok') this.notify();
    });
    socket.addEventListener('error', () => { /* The close event or timeout handles recovery. */ });
    socket.addEventListener('close', () => {
      if (socket !== this.socket) { settle(new Error('Conexión cerrada.')); return; }
      const hadRoom = Boolean(this.state.room);
      this.socket = null;
      settle(new Error('No se pudo mantener la conexión con el servidor de salas.'));
      this.rejectPending();
      this.state.room = null;
      this.state.connection = 'disconnected';
      if (hadRoom) this.state.notice = 'Se perdió la conexión y la sala anterior. Crea una sala nueva o únete de nuevo.';
      // A reconnect never restores stale membership or replays a create/join.
      if (this.active && this.attempts < 5) {
        const delay = Math.min(500 * 2 ** this.attempts++, 5000) + Math.random() * 250;
        this.state.connection = 'reconnecting';
        this.retryTimer = setTimeout(() => this.connect().catch(() => {}), delay);
      } else if (this.active) this.state.notice = 'Servidor de salas no disponible. Vuelve a crear o unirte para intentarlo otra vez.';
      this.notify();
    });
    return promise;
  }

  rejectPending() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('La conexión se cerró antes de recibir la respuesta.'));
    }
    this.pending.clear();
  }

  async request(type, fields = {}) {
    await this.connect();
    if (this.pending.size >= 20 || this.socket?.readyState !== 1) throw new Error('Espera a que termine la operación anterior.');
    const requestId = `req-${++this.sequence}`;
    const message = JSON.stringify({ type, requestId, ...fields });
    if (new TextEncoder().encode(message).length > MESSAGE_BYTES) throw new Error('La señal supera el tamaño permitido.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('El servidor no respondió a tiempo. Se ha cerrado la conexión para descartar la sala anterior.'));
        this.socket?.close(4001, 'Request timeout');
      }, REQUEST_TIMEOUT);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        if (this.socket.bufferedAmount > 65536) throw new Error('La conexión está saturada.');
        this.socket.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  createRoom() { return this.request('create'); }
  joinRoom(code) { return this.request('join', { code: String(code).trim().toUpperCase() }); }
  leaveRoom() { return this.request('leave'); }
  closeRoom() { return this.request('close'); }
  sendSignal(data) { return this.request('signal', { data }); }

  disconnect() {
    this.active = false;
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.cancelConnection?.(new Error('Conexión cancelada.'));
    this.socket = null;
    this.rejectPending();
    this.state.connection = 'disconnected';
    this.state.room = null;
    socket?.close(1000, 'Client leaving');
    this.notify();
  }
}
