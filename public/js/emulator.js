import { sha256 } from './storage.js';

// Ordinals from Dingbat's src/dingbat/common/input.nim at the pinned revision.
const INPUTS = Object.freeze({ UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, SELECT: 6, START: 7, L: 8, R: 9 });
const FRAME_TIME = 1000 / 59.7275;
const SAMPLE_RATE = 32768;
const ROM_PATH = 'rom.gba';
const SAVE_PATH = 'rom.sav';
const SAVE_SIZES = [512, 8192, 32768, 65536, 131072];
let runtimePromise;

function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('El motor no respondió. Recarga la página e inténtalo de nuevo.')), 45000);
      const fail = () => {
        clearTimeout(timeout);
        reject(new Error('No se pudo cargar Dingbat. Comprueba los archivos del motor y recarga la página.'));
      };
      // Official em.js is a classic Emscripten script, not an ES module. Keep
      // its two globals inside this adapter; do not import the upstream UI.
      globalThis.Module = {
        locateFile: name => new URL(`../core/${name}`, import.meta.url).href,
        onAbort: fail,
        onRuntimeInitialized() {
          clearTimeout(timeout);
          queueMicrotask(() => resolve({ module: globalThis.Module, fs: globalThis.FS }));
        },
      };
      const script = document.createElement('script');
      script.src = new URL('../core/em.js', import.meta.url).href;
      script.onerror = fail;
      document.head.append(script);
    });
  }
  return runtimePromise;
}

function sameBytes(first, second) {
  return first?.length === second?.length && first.every((value, index) => value === second[index]);
}

function saveChipSize(length) {
  return SAVE_SIZES.find(size => length === size || length === size + 16);
}

/** One real core, one render loop, one Canvas. ROMs never leave this browser. */
export function createEmulator({ canvas, storage, onStateChange, onError }) {
  let module;
  let fs;
  let context;
  let image;
  let status = 'idle';
  let romId = null;
  let romName = '';
  let lastSavedBytes;
  let savedAt = null;
  let persistence = true;
  let saveNeedsRecovery = false;
  let saveQueue = Promise.resolve();
  let saveErrorReported = false;
  let animationFrame;
  let lastTime = null;
  let accumulator = 0;
  let audioContext;
  let gain;
  let muted = false;
  let audioTime = 0;
  let destroyed = false;
  const sources = new Set();
  const heldButtons = new Set();

  const getState = () => ({ status, romName, romId, savedAt, persistence, muted, audio: audioContext?.state ?? 'locked' });
  const notify = () => onStateChange(getState());

  function releaseButtons() {
    for (const button of heldButtons) module._setInput(INPUTS[button], 0);
    heldButtons.clear();
  }

  function clearAudio() {
    for (const source of sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    sources.clear();
    audioTime = 0;
    module?._clearAudioBuffer();
  }

  function unlockAudio() {
    try {
      if (!audioContext) {
        const AudioContext = window.AudioContext ?? window.webkitAudioContext;
        if (!AudioContext) return Promise.reject(new Error('Este navegador no permite audio Web Audio. Puedes jugar sin sonido.'));
        audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
        gain = audioContext.createGain();
        gain.gain.value = muted ? 0 : 0.65;
        gain.connect(audioContext.destination);
        audioContext.onstatechange = notify;
        // Unlock from the original user gesture, before any ROM/IndexedDB await.
        const silent = audioContext.createBufferSource();
        silent.buffer = audioContext.createBuffer(1, 1, SAMPLE_RATE);
        silent.connect(gain);
        silent.onended = () => silent.disconnect();
        silent.start();
      }
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
      return audioContext.state === 'running' ? Promise.resolve() : audioContext.resume();
    } catch (error) {
      return Promise.reject(new Error('No se pudo activar el audio. Puedes continuar sin sonido.', { cause: error }));
    }
  }

  function pushAudio() {
    const length = module._getAudioBufferLen();
    if (!length) return;
    try {
      if (!audioContext || audioContext.state !== 'running' || muted) return;
      const now = audioContext.currentTime;
      // Bound queued sound after a slow frame or a backgrounded browser.
      if (audioTime > now + 0.1) return;
      audioTime = Math.max(audioTime, now + 0.008);
      const samples = new Float32Array(module.memory.buffer, module._getAudioBufferPtr(), length);
      const buffer = audioContext.createBuffer(2, length / 2, SAMPLE_RATE);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let index = 0; index < length / 2; index++) {
        left[index] = samples[index * 2];
        right[index] = samples[index * 2 + 1];
      }
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.playbackRate.value = 1 + Math.max(-0.004, Math.min(0.004, (audioTime - now - 0.02) * 0.15));
      sources.add(source);
      source.onended = () => { sources.delete(source); source.disconnect(); };
      source.start(audioTime);
      audioTime += buffer.duration / source.playbackRate.value;
    } finally {
      module._clearAudioBuffer();
    }
  }

  function render() {
    const pointer = module._wasm_fb_ptr();
    if (!pointer) return;
    // Read the current heap each time: Emscripten can grow its memory.
    image.data.set(new Uint8Array(module.memory.buffer, pointer, 240 * 160 * 4));
    context.putImageData(image, 0, 0);
  }

  function fail(error) {
    cancelAnimationFrame(animationFrame);
    releaseButtons();
    clearAudio();
    status = 'error';
    notify();
    onError(new Error('El motor se detuvo. Exporta tu partida si está disponible y recarga la página.', { cause: error }));
  }

  function tick(time) {
    if (status !== 'running' || destroyed) return;
    try {
      if (lastTime === null) lastTime = time - FRAME_TIME;
      accumulator = Math.min(accumulator + time - lastTime, FRAME_TIME * 4);
      lastTime = time;
      while (accumulator >= FRAME_TIME) {
        module._loop_tick();
        pushAudio();
        accumulator -= FRAME_TIME;
      }
      render();
      animationFrame = requestAnimationFrame(tick);
    } catch (error) {
      fail(error);
    }
  }

  function readSave() {
    if (!romId) return null;
    module._wasm_flush_save();
    try { return fs.readFile(SAVE_PATH).slice(); }
    catch (error) {
      if (error.errno === 44) return null; // Emscripten ENOENT: no battery file yet.
      throw error;
    }
  }

  function persist() {
    const bytes = readSave();
    if (!bytes?.length || !persistence || sameBytes(bytes, lastSavedBytes)) return saveQueue;
    const id = romId;
    const name = romName;
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      const timestamp = await storage.put(id, name, bytes);
      if (id === romId) {
        lastSavedBytes = bytes;
        savedAt = timestamp;
        saveErrorReported = false;
        notify();
      }
    });
    return saveQueue;
  }

  function reportSaveError(error) {
    if (saveErrorReported) return;
    saveErrorReported = true;
    onError(error);
  }

  function pause() {
    if (status !== 'running') return;
    cancelAnimationFrame(animationFrame);
    status = 'paused';
    releaseButtons();
    clearAudio();
    audioContext?.suspend().catch(() => {});
    notify();
    try { persist().catch(reportSaveError); } catch (error) { reportSaveError(error); }
  }

  function resume() {
    if (status !== 'paused') return;
    unlockAudio().catch(onError);
    status = 'running';
    lastTime = null;
    accumulator = 0;
    notify();
    animationFrame = requestAnimationFrame(tick);
  }

  function boot() {
    module.ccall('initFromEmscripten', null, ['string'], [ROM_PATH]);
    status = 'paused';
    render();
    notify();
  }

  async function loadRom(file) {
    if (!/\.gba$/i.test(file.name) || file.size < 192 || file.size > 32 * 1024 * 1024) {
      throw new Error('Selecciona una ROM .gba válida, de hasta 32 MiB.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let checksum = 0x19;
    for (let index = 0xa0; index <= 0xbc; index++) checksum += bytes[index];
    if (bytes[0xb2] !== 0x96 || ((checksum + bytes[0xbd]) & 0xff) !== 0) {
      throw new Error('La cabecera de esta ROM GBA no es válida. El archivo puede estar incompleto o dañado.');
    }
    const id = await sha256(bytes);
    // A corrupt stored save must never be silently replaced with a fresh game.
    let stored;
    let nextPersistence = true;
    let nextNeedsRecovery = false;
    try {
      stored = await storage.get(id);
    } catch (error) {
      nextPersistence = false;
      if (error.code === 'SAVE_INTEGRITY') {
        nextNeedsRecovery = true;
        onError(error);
      } else {
        onError(new Error('El guardado automático no está disponible. Exporta tus partidas .sav antes de salir.', { cause: error }));
      }
    }
    pause();
    await persist();
    status = 'loading';
    notify();
    try {
      ({ module, fs } = await loadRuntime());
      if (!module._loop_tick || !module._wasm_flush_save || !fs) throw new Error('API de Dingbat incompatible.');
      if (!context) {
        context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Este navegador no permite dibujar en Canvas.');
        image = context.createImageData(240, 160);
      }
      module._setRewindEnabled(0);
      module._wasm_set_gba_bios_mode(0); // Official built-in HLE; no proprietary BIOS.
      module._wasm_set_gba_run_bios(0);
      fs.writeFile(ROM_PATH, bytes);
      try { fs.unlink(SAVE_PATH); } catch (error) { if (error.errno !== 44) throw error; }
      if (stored) fs.writeFile(SAVE_PATH, stored.bytes);
      persistence = nextPersistence;
      saveNeedsRecovery = nextNeedsRecovery;
      romId = id;
      romName = file.name;
      savedAt = stored?.updatedAt ?? null;
      lastSavedBytes = stored?.bytes;
      saveErrorReported = false;
      clearAudio();
      boot();
      if (!saveNeedsRecovery) resume();
    } catch (error) {
      status = 'error';
      notify();
      throw new Error('No se pudo iniciar Dingbat. Recarga la página antes de volver a cargar una ROM.', { cause: error });
    }
  }

  async function reset() {
    if (!romId || status === 'error') return;
    const wasRunning = status === 'running';
    pause();
    await persist();
    boot();
    if (wasRunning) resume();
  }

  async function importSave(file) {
    if (!romId || status === 'error') throw new Error('Carga una ROM antes de importar su partida.');
    if (!/\.sav$/i.test(file.name) || !saveChipSize(file.size)) {
      throw new Error('Selecciona un .sav sin comprimir de 512 B, 8, 32, 64 o 128 KiB, con un registro RTC opcional de 16 B.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const existing = readSave();
    if (existing?.length && saveChipSize(existing.length) !== saveChipSize(bytes.length)) {
      throw new Error('El tamaño de esta partida no coincide con la memoria de guardado del juego cargado.');
    }
    const wasRunning = status === 'running';
    pause();
    await persist();
    // Commit first. If IndexedDB refuses the write, the running save is intact.
    if (persistence || saveNeedsRecovery) {
      savedAt = await storage.put(romId, romName, bytes);
      persistence = true;
      saveNeedsRecovery = false;
    }
    fs.writeFile(SAVE_PATH, bytes);
    lastSavedBytes = persistence ? bytes.slice() : undefined;
    boot();
    if (wasRunning) resume();
  }

  function exportSave() {
    const bytes = readSave();
    if (!bytes?.length) throw new Error('Este juego todavía no ha generado una partida. Guarda primero desde el propio juego.');
    return { bytes, name: romName.replace(/\.gba$/i, '.sav') };
  }

  const autosave = setInterval(() => {
    if (!romId || status === 'loading' || status === 'error') return;
    try { persist().catch(reportSaveError); } catch (error) { reportSaveError(error); }
  }, 2000);

  return {
    loadRom, pause, resume, reset, importSave, exportSave, persist, getState, unlockAudio,
    setButton(button, pressed) {
      if (!(button in INPUTS) || !romId || status !== 'running') return;
      module._setInput(INPUTS[button], pressed ? 1 : 0);
      if (pressed) heldButtons.add(button);
      else heldButtons.delete(button);
    },
    setMuted(value) {
      muted = Boolean(value);
      if (gain) gain.gain.setValueAtTime(muted ? 0 : 0.65, audioContext.currentTime);
      if (muted) clearAudio();
      else if (status === 'running') unlockAudio().catch(onError);
      notify();
    },
    destroy() {
      pause();
      destroyed = true;
      clearInterval(autosave);
      audioContext?.close().catch(() => {});
    },
  };
}
