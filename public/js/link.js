const SIGNAL_BYTES = 15000; // Leaves room for Multiplayer's request envelope.
const QUEUE_BYTES = 262144;
const BINARY_HIGH_WATER = 131072;
const BINARY_LOW_WATER = 32768;
const BINARY_QUEUE_BYTES = 1048576;
const encoder = new TextEncoder();
const sizeOf = data => encoder.encode(JSON.stringify(data)).length;
const validId = id => typeof id === 'string' && /^[\da-f-]{36}$/i.test(id);
const validHash = hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
const ROM_ERROR = 'ROM incompatible: ambas ROMs deben tener el mismo SHA-256. Las partidas .sav pueden ser distintas.';
const CRC_ERROR = 'CRC mismatch: el núcleo rechazó la ROM del rival. Usa exactamente la misma ROM en ambos dispositivos.';

export function readStunServers(storage = globalThis.localStorage) {
  const urls = JSON.parse(storage?.getItem('emerald:link:stun') ?? '[]');
  if (!Array.isArray(urls) || urls.length > 4
    || urls.some(url => typeof url !== 'string' || url.length > 256 || !/^stuns?:[^\s]+$/i.test(url))) {
    throw new Error('La configuración STUN debe contener hasta cuatro URL stun: o stuns:. TURN no está habilitado.');
  }
  return urls.map(url => ({ urls: url }));
}

/** One RTC/SIO session over the existing room. No ROMs, states or inputs cross it. */
export class Link extends EventTarget {
  constructor({ multiplayer, emulator, iceServers = [], createPeerConnection = options => new RTCPeerConnection(options) }) {
    super();
    if (iceServers.some(server => Object.keys(server).some(key => key !== 'urls')
      || (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => typeof url !== 'string' || !/^stuns?:/i.test(url)))) {
      throw new Error('Solo se admite configuración STUN, sin TURN.');
    }
    this.multiplayer = multiplayer;
    this.emulator = emulator;
    this.iceServers = iceServers;
    this.createPeerConnection = createPeerConnection;
    this.status = 'idle';
    this.message = '';
    this.room = multiplayer.getState().room;
    this.localId = null;
    this.remoteId = null;
    this.remoteRomId = null;
    this.failure = null;
    this.session = null;
    this.closing = null;
    this.signals = null;
    this.incoming = Promise.resolve();
    this.abort = new AbortController();
    multiplayer.addEventListener('statechange', ({ detail }) => this.roomChanged(detail), { signal: this.abort.signal });
    multiplayer.addEventListener('signal', ({ detail }) => {
      this.incoming = this.incoming.then(async () => {
        const session = this.session;
        try { await this.receiveSignal(detail); }
        catch (error) { if (this.session === session) this.fail(error); }
      });
    }, { signal: this.abort.signal });
  }

  getState() {
    let status = this.status;
    let message = this.message;
    const core = this.emulator.getState();
    if (this.session?.attached && !this.closing) {
      status = core.link === 'connected' ? 'connected' : 'synchronizing';
      message = core.status === 'paused'
        ? 'Tu juego está en pausa; el rival espera. Reanuda para continuar.'
        : core.link === 'connected' ? 'Cable Link conectado.'
          : 'Esperando sincronización. El rival puede estar en pausa.';
    }
    return { status, message, active: Boolean(this.localId || this.session || this.closing), connected: Boolean(this.session?.attached) };
  }

  notify() { this.dispatchEvent(new CustomEvent('statechange', { detail: this.getState() })); }

  roomChanged(state) {
    const next = state.room;
    const fresh = next && (next.code !== this.room?.code || next.players === 2 && this.room?.players !== 2);
    const changed = !next || next.code !== this.room?.code || next.role !== this.room?.role || next.players !== 2;
    if (changed) {
      this.remoteId = null;
      if (this.localId || this.session) void this.disconnect('Rival desconectado. Se recuperó el modo individual.', { notifyPeer: false });
    }
    this.room = next;
    if (fresh && !this.localId && !this.session && !this.closing) {
      this.status = 'idle';
      this.message = '';
      this.failure = null;
    }
    this.notify();
  }

  connect() {
    if (this.closing) throw new Error('Espera a que termine de cerrarse el cable anterior.');
    if (!this.room || this.room.players !== 2) throw new Error('Esperando rival. La sala necesita dos personas.');
    if (this.localId) return;
    const romId = this.emulator.getState().romId;
    if (!validHash(romId)) throw new Error('Carga una ROM local verificada antes de conectar el cable.');
    this.failure = null;
    this.emulator.reserveLink();
    this.localId = crypto.randomUUID();
    this.status = 'waiting';
    this.message = 'Esperando a que el rival conecte su cable Link.';
    this.signals = { queue: [], bytes: 0, sending: false, timer: null };
    this.queueSignal({ t: 'link-ready', id: this.localId, romId });
    this.maybeStart();
    this.notify();
  }

  queueSignal(data) {
    const state = this.signals;
    if (!state) return;
    const bytes = sizeOf(data);
    if (bytes > SIGNAL_BYTES || state.bytes + bytes > QUEUE_BYTES) {
      throw new Error('La negociación supera el tamaño de señalización permitido; no se ha truncado ningún candidato.');
    }
    state.queue.push({ data, bytes });
    state.bytes += bytes;
    this.flushSignals(state);
  }

  async flushSignals(state) {
    if (state !== this.signals || state.sending || state.timer || !state.queue.length) return;
    state.sending = true;
    const item = state.queue.shift();
    state.bytes -= item.bytes;
    // Batch adjacent ICE candidates without dropping any, including end-of-ICE.
    if (item.data.t === 'ice') {
      const candidates = [item.data.c];
      while (candidates.length < 8 && state.queue[0]?.data.t === 'ice'
        && state.queue[0].data.session === item.data.session) {
        const next = state.queue[0];
        if (sizeOf({ ...item.data, c: [...candidates, next.data.c] }) > SIGNAL_BYTES) break;
        candidates.push(next.data.c);
        state.queue.shift();
        state.bytes -= next.bytes;
      }
      item.data = { ...item.data, c: candidates };
    }
    try { await this.multiplayer.sendSignal(item.data); }
    catch (error) { if (state === this.signals) this.fail(error); }
    finally {
      state.sending = false;
      if (state === this.signals) {
        // Below the existing ten-message/second quota, including ICE bursts.
        state.timer = setTimeout(() => { state.timer = null; this.flushSignals(state); }, 150);
      }
    }
  }

  maybeStart() {
    if (!this.localId || !this.remoteId || this.session || this.closing) return;
    if (this.remoteRomId !== this.emulator.getState().romId) {
      void this.disconnect(ROM_ERROR, { error: true, code: 'ROM_SHA_MISMATCH' });
      return;
    }
    try {
      const host = this.room.role === 'host';
      const id = host ? `${this.localId}:${this.remoteId}` : `${this.remoteId}:${this.localId}`;
      const pc = this.createPeerConnection({ iceServers: this.iceServers });
      const session = {
        id, pc, host, channel: null, attached: false, abort: new AbortController(),
        ice: [], iceBytes: 0, received: [], receivedBytes: 0, binary: [], binaryBytes: 0,
      };
      this.session = session;
      this.status = 'negotiating';
      this.message = 'Negociando WebRTC…';
      session.deadline = setTimeout(() => {
        if (this.session === session) this.fail(new Error('No se abrió el canal. Comprueba STUN y la red; sin TURN algunas NAT no permiten conectar.'));
      }, 45000);
      const options = { signal: session.abort.signal };
      pc.addEventListener('icecandidate', event => {
        if (this.session !== session || this.closing) return;
        try { this.queueSignal({ t: 'ice', c: event.candidate?.toJSON() ?? null, session: id }); }
        catch (error) { this.fail(error); }
      }, options);
      pc.addEventListener('connectionstatechange', () => {
        if (this.session !== session || this.closing) return;
        clearTimeout(session.disconnected);
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          this.fail(new Error('Rival desconectado o conexión WebRTC perdida.'));
        } else if (pc.connectionState === 'disconnected') {
          this.message = 'Esperando que se recupere la conexión WebRTC…';
          this.notify();
          session.disconnected = setTimeout(() => {
            if (this.session === session) this.fail(new Error('La conexión no se recuperó. Vuelve a conectar el cable.'));
          }, 10000);
        }
      }, options);
      pc.addEventListener('datachannel', event => this.adoptChannel(session, event.channel), options);
      if (host) {
        this.adoptChannel(session, pc.createDataChannel('link', { ordered: true }));
        void this.offer(session);
      }
      this.notify();
    } catch (error) { this.fail(error); }
  }

  async offer(session) {
    try {
      const offer = await session.pc.createOffer();
      if (this.session !== session || this.closing) return;
      await session.pc.setLocalDescription(offer);
      if (this.session === session && !this.closing) this.queueSignal({ t: 'sdp', d: session.pc.localDescription.toJSON(), session: session.id });
    } catch (error) { if (this.session === session) this.fail(error); }
  }

  async receiveSignal({ from, data }) {
    if (!data || typeof data !== 'object' || !this.room || this.room.players !== 2
      || from === this.room.role || this.closing) return;
    if (data.t === 'link-ready' && validId(data.id)) {
      if (this.remoteId && this.remoteId !== data.id && this.session) {
        await this.disconnect('El rival inició otra conexión. Conecta de nuevo.', { notifyPeer: false });
      }
      this.remoteId = data.id;
      this.remoteRomId = validHash(data.romId) ? data.romId : null;
      this.maybeStart();
      return;
    }
    if (data.t === 'link-stop' && data.id === this.remoteId) {
      const message = data.code === 'ROM_SHA_MISMATCH' ? ROM_ERROR : data.code === 'CRC_MISMATCH' ? CRC_ERROR : null;
      await this.disconnect(message ?? 'Rival desconectado. Se recuperó el modo individual.',
        { notifyPeer: false, error: Boolean(message), code: data.code });
      return;
    }
    const session = this.session;
    if (!session || data.session !== session.id) return; // Ignore stale pairings.
    const pc = session.pc;
    if (data.t === 'ice') {
      for (const candidate of Array.isArray(data.c) ? data.c : [data.c]) {
        if (candidate !== null && (!candidate || typeof candidate.candidate !== 'string')) throw new Error('Candidato ICE inválido.');
        const bytes = sizeOf(candidate);
        if (session.iceBytes + bytes > QUEUE_BYTES) throw new Error('Demasiados candidatos ICE pendientes.');
        if (pc.remoteDescription) await pc.addIceCandidate(candidate);
        else { session.ice.push(candidate); session.iceBytes += bytes; }
        if (this.session !== session) return;
      }
    } else if (data.t === 'sdp') {
      const description = data.d;
      if (!description || typeof description.sdp !== 'string'
        || description.type !== (session.host ? 'answer' : 'offer')) throw new Error('Descripción SDP incompatible con el rol de la sala.');
      if (pc.remoteDescription) {
        if (pc.remoteDescription.type === description.type && pc.remoteDescription.sdp === description.sdp) return;
        throw new Error('Se recibió una oferta duplicada incompatible.');
      }
      await pc.setRemoteDescription(description);
      if (this.session !== session || this.closing) return;
      for (const candidate of session.ice.splice(0)) {
        await pc.addIceCandidate(candidate);
        if (this.session !== session || this.closing) return;
      }
      session.iceBytes = 0;
      if (!session.host) {
        const answer = await pc.createAnswer();
        if (this.session !== session || this.closing) return;
        await pc.setLocalDescription(answer);
        if (this.session === session && !this.closing) this.queueSignal({ t: 'sdp', d: pc.localDescription.toJSON(), session: session.id });
      }
    }
  }

  adoptChannel(session, channel) {
    if (this.session !== session || session.channel || channel.label !== 'link'
      || !channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
      channel.close();
      if (!session.channel && this.session === session) this.fail(new Error('Se requiere un DataChannel Link fiable y ordenado.'));
      return;
    }
    session.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BINARY_LOW_WATER;
    const options = { signal: session.abort.signal };
    channel.addEventListener('open', () => this.openChannel(session), options);
    channel.addEventListener('bufferedamountlow', () => {
      try { this.flushBinary(session); } catch (error) { this.fail(error); }
    }, options);
    channel.addEventListener('message', event => {
      if (this.session !== session || this.closing) return;
      try {
        if (!(event.data instanceof ArrayBuffer) || !event.data.byteLength || event.data.byteLength > 65536) throw new Error('Paquete binario Link inválido.');
        const bytes = new Uint8Array(event.data);
        if (!session.attached) {
          if (session.receivedBytes + bytes.length > QUEUE_BYTES) throw new Error('Demasiados paquetes antes del handshake.');
          session.received.push(bytes);
          session.receivedBytes += bytes.length;
        } else this.emulator.feedLink(bytes);
      } catch (error) { this.fail(error); }
    }, options);
    channel.addEventListener('close', () => {
      if (this.session === session && !this.closing) void this.disconnect('Rival desconectado. Se recuperó el modo individual.', { notifyPeer: false });
    }, options);
    channel.addEventListener('error', () => { if (!this.closing) this.fail(new Error('Error de transporte en el cable Link.')); }, options);
    if (channel.readyState === 'open') this.openChannel(session);
  }

  openChannel(session) {
    if (this.session !== session || session.attached || this.closing) return;
    try {
      clearTimeout(session.deadline);
      this.emulator.startLink({
        isHost: session.host,
        onBytes: bytes => this.sendBinary(session, bytes),
        onEnd: ({ reason, message }) => {
          if (this.session === session && !this.closing) {
            const crc = reason === 'core-error' && /CRC|ROM mismatch|BYE reason 2/i.test(message);
            void this.disconnect(crc ? CRC_ERROR : reason === 'core-error' ? `Error del núcleo: ${message}` : message,
              { notifyPeer: crc, error: reason === 'core-error', code: crc ? 'CRC_MISMATCH' : 'CORE_ERROR' });
          }
        },
      });
      session.attached = true;
      session.handshakeDeadline = setTimeout(() => {
        if (this.session === session && this.emulator.getState().link === 'handshake') this.fail(new Error('El rival no completó el handshake SIO.'));
      }, 15000);
      this.status = 'synchronizing';
      this.message = 'Esperando sincronización del cable Link…';
      for (const bytes of session.received.splice(0)) {
        if (this.session !== session || this.closing) break;
        this.emulator.feedLink(bytes);
      }
      session.receivedBytes = 0;
      this.notify();
    } catch (error) { this.fail(error); }
  }

  sendBinary(session, bytes) {
    if (this.session !== session || session.channel?.readyState !== 'open') throw new Error('El canal Link no está abierto.');
    if (session.binaryBytes + bytes.length > BINARY_QUEUE_BYTES) throw new Error('La conexión Link no puede vaciar su cola de salida.');
    session.binary.push(bytes);
    session.binaryBytes += bytes.length;
    this.flushBinary(session);
  }

  flushBinary(session) {
    const channel = session.channel;
    while (channel?.readyState === 'open' && channel.bufferedAmount <= BINARY_HIGH_WATER && session.binary.length) {
      const bytes = session.binary[0];
      channel.send(bytes);
      session.binary.shift();
      session.binaryBytes -= bytes.length;
    }
  }

  fail(error) { void this.disconnect(`Error del núcleo o transporte Link: ${error.message}`, { error: true }); }

  disconnect(message = 'Cable Link desconectado. Modo individual.', { notifyPeer = true, error = false, code = 'LINK_ERROR' } = {}) {
    // A terminal incompatibility survives later close/BYE/room-loss events.
    if (error && !['ROM_SHA_MISMATCH', 'CRC_MISMATCH'].includes(this.failure?.code)) this.failure = { message, code };
    if (this.failure) { message = this.failure.message; code = this.failure.code; error = true; }
    if (this.closing) { this.message = message; this.notify(); return this.closing; }
    const session = this.session;
    const localId = this.localId;
    this.status = 'closing';
    this.message = message;
    this.localId = null;
    this.remoteId = null;
    this.remoteRomId = null;
    if (this.signals) clearTimeout(this.signals.timer);
    this.signals = null;
    // Set the guard BEFORE stopLink's callback. BYE is still accepted by sendBinary.
    let finish;
    this.closing = new Promise(resolve => { finish = resolve; });
    const done = this.closing;
    // Once attached, BYE is the shutdown protocol. A WS stop is only needed
    // before attach or when the binary channel has already failed.
    if (notifyPeer && localId && (code === 'CRC_MISMATCH' || !session?.attached || session.channel?.readyState !== 'open')
      && this.multiplayer.getState().connection === 'connected') {
      this.multiplayer.sendSignal({ t: 'link-stop', id: localId, ...(error ? { code } : {}) }).catch(() => {});
    }
    try { this.emulator.stopLink(); }
    catch (failure) { this.message = `Error al desconectar Link: ${failure.message}`; error = true; }
    this.notify();
    const cleanup = () => {
      if (session) {
        clearTimeout(session.deadline);
        clearTimeout(session.handshakeDeadline);
        clearTimeout(session.disconnected);
        session.abort.abort();
        session.channel?.close();
        session.pc.close();
        session.binary.length = 0;
        session.received.length = 0;
        session.ice.length = 0;
      }
      this.session = null;
      this.closing = null;
      this.status = this.failure || error ? 'error' : 'disconnected';
      this.notify();
      finish();
    };
    if (!session || session.channel?.readyState !== 'open') cleanup();
    else {
      const channel = session.channel;
      // Preserve the original exit -> drain BYE -> close ordering. A bounded
      // wait permits SCTP to flush; an abrupt browser/network kill cannot promise it.
      channel.bufferedAmountLowThreshold = 0;
      let completed = false;
      let timer;
      const check = () => {
        if (completed) return;
        try { this.flushBinary(session); } catch { /* Close below if transport failed. */ }
        if (channel.readyState === 'open' && (channel.bufferedAmount || session.binary.length)) return;
        finishDrain();
      };
      const finishDrain = () => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        channel.removeEventListener('bufferedamountlow', check);
        channel.removeEventListener('close', finishDrain);
        cleanup();
      };
      timer = setTimeout(finishDrain, 1000);
      channel.addEventListener('bufferedamountlow', check);
      channel.addEventListener('close', finishDrain);
      check();
    }
    return done;
  }

  async destroy() { this.abort.abort(); await this.disconnect(); }
}
