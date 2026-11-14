import { createControls } from './controls.js';
import { createEmulator } from './emulator.js';
import { saveStorage, romAccess, sha256 } from './storage.js';
import { Multiplayer } from './multiplayer.js';
import { Link, readStunServers } from './link.js';
import { createImmersive } from './immersive.js';
import { createAdminTest } from './admin.js';

const consoleElement = document.querySelector('#console');
const canvas = document.querySelector('#game-screen');
const standby = document.querySelector('#standby');
const inputStatus = document.querySelector('#input-status');
const modelLabel = document.querySelector('#model-label');
const helpDialog = document.querySelector('#controls-help');
const sessionDialog = document.querySelector('#session-panel');
const roomsDialog = document.querySelector('#rooms-panel');
const orientation = window.matchMedia('(orientation: landscape)');
const romInput = document.querySelector('#rom-file');
const saveInput = document.querySelector('#save-file');
const notification = document.querySelector('#notification');
const loadButton = document.querySelector('#load-rom');
const pauseButton = document.querySelector('#pause-game');
const controls = createControls(consoleElement);
let busy = false;
let resumeAfterPicker = false;
let link = null;
let resumeLinkedOnFocus = false;
let rememberedAccess = null;
let lastRomFile = null;
let lastRomHandle = null;
let continueExpectedId = null;
let adminTest = null;
const rememberRom = document.querySelector('#remember-rom');

function showMessage(error) {
  document.querySelector('#notification-message').textContent = error.message ?? String(error);
  notification.hidden = false;
  if (sessionDialog.open) {
    const message = document.querySelector('#session-message');
    message.textContent = error.message ?? String(error);
    message.hidden = false;
  }
}

function updateSession(state) {
  // RTC may open after a mobile tab lost visibility during negotiation.
  // Attaching must not restart a hidden/unfocused CPU.
  if (state.status === 'running' && state.link !== 'inactive'
    && (document.hidden || !document.hasFocus())) {
    resumeLinkedOnFocus = true;
    controls.releaseAll();
    emulator.pause();
    return;
  }
  const loaded = Boolean(state.romId);
  const usable = loaded && !['error', 'loading'].includes(state.status) && !busy;
  const locked = state.linkPending || state.link !== 'inactive' || link?.getState().active;
  loadButton.disabled = busy || state.status === 'error' || Boolean(locked);
  pauseButton.disabled = !usable || state.linkPending;
  const speedButton = document.querySelector('#fast-forward');
  speedButton.disabled = !usable || Boolean(locked);
  speedButton.setAttribute('aria-pressed', String(state.speed === 2));
  speedButton.setAttribute('aria-label', state.speed === 2 ? 'Volver a velocidad 1x' : 'Activar avance rápido 2x');
  speedButton.querySelector('.speed-label').textContent = `${state.speed}×`;
  const continueButton = document.querySelector('#continue-rom');
  continueButton.hidden = !rememberedAccess;
  continueButton.textContent = rememberedAccess ? `Continuar · ${rememberedAccess.name}` : 'Continuar ROM local';
  continueButton.disabled = busy || Boolean(locked) || state.status === 'error';
  rememberRom.disabled = busy;
  pauseButton.textContent = state.status === 'running' ? 'Pausar' : 'Reanudar';
  document.querySelector('#reset-game').disabled = !usable || Boolean(locked);
  document.querySelector('#import-save').disabled = !usable || Boolean(locked);
  document.querySelector('#export-save').disabled = !loaded || busy;
  document.querySelector('#rom-name').textContent = state.romName || 'Ninguna ROM cargada';
  document.querySelector('#session-status').textContent = {
    idle: 'Carga una ROM .gba para comenzar.', loading: 'Preparando el motor…',
    running: 'En juego', paused: 'En pausa', error: 'El motor necesita reiniciarse. Recarga la página.',
  }[state.status];
  document.querySelector('#save-status').textContent = !state.persistence
    ? 'Guardado automático no disponible. Exporta una copia .sav.'
    : state.savedAt
      ? `Partida guardada en este dispositivo · ${new Date(state.savedAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`
      : 'Guardado automático activo. Guarda también desde el propio juego.';
  standby.hidden = loaded && state.status !== 'loading';
  if (link) updateRoom();
  adminTest?.refresh();
}

const emulator = createEmulator({ canvas, storage: saveStorage, onStateChange: updateSession, onError: showMessage });
updateSession(emulator.getState());

consoleElement.addEventListener('emerald:input', ({ detail }) => {
  emulator.setButton(detail.button, detail.pressed);
  inputStatus.textContent = detail.pressedButtons.length
    ? detail.pressedButtons.map(button => ({ UP: '↑', RIGHT: '→', DOWN: '↓', LEFT: '←' })[button] ?? button).join(' + ')
    : 'CONTROLES LISTOS';
});

function updateModel() {
  controls.releaseAll();
  const model = orientation.matches ? 'ADVANCE' : 'ADVANCE SP';
  modelLabel.textContent = model;
  consoleElement.setAttribute('aria-label', `Game Boy ${model}, controles de juego`);
  // CSS switches shells. The core, its memory and its Canvas survive rotation.
}

orientation.addEventListener('change', updateModel);
updateModel();

function openDialog(dialog) {
  controls.releaseAll();
  document.querySelector('#session-message').hidden = true;
  dialog.showModal();
}
document.querySelector('.help-toggle').addEventListener('click', () => openDialog(helpDialog));
document.querySelector('#session-toggle').addEventListener('click', () => openDialog(sessionDialog));

for (const dialog of [helpDialog, sessionDialog, roomsDialog]) {
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
}
document.querySelector('#dismiss-notification').addEventListener('click', () => { notification.hidden = true; });

async function perform(action, { rethrow = false } = {}) {
  if (busy) return;
  busy = true;
  controls.releaseAll();
  updateSession(emulator.getState());
  try { return await action(); }
  catch (error) { showMessage(error); if (rethrow) throw error; }
  finally {
    busy = false;
    updateSession(emulator.getState());
  }
}

function chooseFile(input) {
  resumeAfterPicker = emulator.getState().status === 'running';
  emulator.pause();
  controls.releaseAll();
  // Unlock during the original gesture, before file reading or IndexedDB awaits.
  emulator.unlockAudio().catch(showMessage);
  input.value = '';
  input.click();
}
loadButton.addEventListener('click', async () => {
  continueExpectedId = null;
  if (!rememberRom.checked || !window.showOpenFilePicker) { chooseFile(romInput); return; }
  resumeAfterPicker = emulator.getState().status === 'running';
  emulator.pause();
  controls.releaseAll();
  emulator.unlockAudio().catch(showMessage);
  try {
    const [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'ROM GBA local', accept: { 'application/octet-stream': ['.gba'] } }] });
    await acceptRom(await handle.getFile(), handle);
  } catch (error) {
    if (error.name !== 'AbortError') showMessage(error);
    if (resumeAfterPicker) emulator.resume();
  } finally { resumeAfterPicker = false; }
});
document.querySelector('#import-save').addEventListener('click', () => chooseFile(saveInput));
for (const input of [romInput, saveInput]) {
  input.addEventListener('cancel', () => {
    if (resumeAfterPicker) emulator.resume();
    else emulator.pause();
    resumeAfterPicker = false;
    continueExpectedId = null;
  });
}
async function rememberCurrentRom() {
  if (!rememberRom.checked || !lastRomFile) return;
  const record = { romId: emulator.getState().romId, name: lastRomFile.name, handle: lastRomHandle };
  await romAccess.put(record);
  rememberedAccess = record;
}
async function acceptRom(file, handle = null) {
  const expectedId = continueExpectedId;
  await perform(async () => {
    let loaded = false;
    try {
      if (expectedId) {
        const bytes = await file.arrayBuffer();
        if (await sha256(bytes) !== expectedId) {
          throw new Error('Esta ROM no coincide con la autorizada. La partida actual permanece intacta. Selecciona el archivo original o usa Cargar ROM.');
        }
        // Boot the exact bytes just verified, even if the underlying file is
        // edited between permission checking and the emulator's read.
        file = new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
      }
      await emulator.loadRom(file);
      loaded = true;
      lastRomFile = file;
      lastRomHandle = handle;
      try { await rememberCurrentRom(); } catch (error) { showMessage(new Error('La ROM funciona, pero no se pudo recordar su acceso local.', { cause: error })); }
      sessionDialog.close();
    } finally {
      if (!loaded && resumeAfterPicker && emulator.getState().status === 'paused') emulator.resume();
      resumeAfterPicker = false;
      continueExpectedId = null;
    }
  });
}
romInput.addEventListener('change', () => {
  if (romInput.files[0]) void acceptRom(romInput.files[0]);
});
rememberRom.addEventListener('change', () => perform(async () => {
  if (rememberRom.checked) await rememberCurrentRom();
  else { await romAccess.remove(); rememberedAccess = null; }
}));
document.querySelector('#continue-rom').addEventListener('click', async () => {
  if (!rememberedAccess) return;
  continueExpectedId = rememberedAccess.romId;
  if (!rememberedAccess.handle) { chooseFile(romInput); return; }
  try {
    const handle = rememberedAccess.handle;
    const permission = await handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted' && await handle.requestPermission({ mode: 'read' }) !== 'granted') {
      throw new Error('Autoriza de nuevo el acceso o selecciona la ROM local para continuar.');
    }
    emulator.unlockAudio().catch(showMessage);
    await acceptRom(await handle.getFile(), handle);
  } catch (error) {
    // A moved/revoked file requires a new gesture and selection, never an
    // automatic substitution or an upload. Saves remain untouched.
    rememberedAccess = { ...rememberedAccess, handle: null };
    continueExpectedId = null;
    showMessage(new Error(`No se pudo abrir el archivo autorizado. Pulsa Continuar para seleccionarlo de nuevo. ${error.message}`));
  }
});
saveInput.addEventListener('change', () => {
  const file = saveInput.files[0];
  if (!file) return;
  perform(async () => {
    try {
      await emulator.importSave(file);
      showMessage(new Error('Partida importada. El juego se ha reiniciado para cargarla.'));
    } finally {
      if (resumeAfterPicker) emulator.resume();
      resumeAfterPicker = false;
    }
  });
});
pauseButton.addEventListener('click', () => {
  resumeLinkedOnFocus = false;
  controls.releaseAll();
  if (emulator.getState().status === 'running') emulator.pause();
  else emulator.resume();
});
document.querySelector('#fast-forward').addEventListener('click', () => {
  controls.releaseAll();
  try { emulator.setSpeed(emulator.getState().speed === 2 ? 1 : 2); } catch (error) { showMessage(error); }
});
const immersive = createImmersive(document.querySelector('#immersive-toggle'), () => {
  controls.releaseAll();
  for (const dialog of [helpDialog, sessionDialog, roomsDialog]) if (dialog.open) dialog.close();
});
document.querySelector('#reset-game').addEventListener('click', () => perform(() => emulator.reset()));
document.querySelector('#sound-enabled').addEventListener('change', event => emulator.setMuted(!event.target.checked));
document.querySelector('#export-save').addEventListener('click', () => {
  try {
    const { bytes, name } = emulator.exportSave();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) { showMessage(error); }
});

for (const type of ['pointerdown', 'keydown']) {
  consoleElement.addEventListener(type, () => {
    if (emulator.getState().status === 'running') emulator.unlockAudio().catch(showMessage);
  });
}
function pauseForPage() {
  if (link?.getState().connected && emulator.getState().status === 'running') resumeLinkedOnFocus = true;
  controls.releaseAll();
  emulator.pause();
}
function resumeForPage() {
  if (!document.hidden && resumeLinkedOnFocus && link?.getState().connected) {
    resumeLinkedOnFocus = false;
    emulator.resume();
  }
}
window.addEventListener('blur', pauseForPage);
window.addEventListener('focus', resumeForPage);
window.addEventListener('pagehide', () => { controls.releaseAll(); emulator.pause(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseForPage();
  else resumeForPage();
});

const multiplayer = new Multiplayer();
let roomBusy = false;
let iceServers = [];
try { iceServers = readStunServers(); } catch (error) { showMessage(error); }
link = new Link({ multiplayer, emulator, iceServers });
const linkButton = document.createElement('button');
linkButton.id = 'connect-link';
linkButton.type = 'button';
linkButton.className = 'room-opener';
document.querySelector('#current-room .session-grid').prepend(linkButton);
document.querySelector('#room-note').textContent = 'Cada persona conserva su ROM y su partida. Conecta el cable en ambos dispositivos antes de iniciar la conexión del Club Cable.';
link.addEventListener('statechange', () => {
  if (!link.getState().active) resumeLinkedOnFocus = false;
  updateSession(emulator.getState());
});
function updateRoom(state = multiplayer.getState()) {
  const room = state.room;
  const cable = link?.getState();
  document.querySelector('#room-entry').hidden = Boolean(room);
  document.querySelector('#current-room').hidden = !room;
  document.querySelector('#room-code').textContent = room?.code ?? '';
  document.querySelector('#room-members').textContent = room ? `${room.role === 'host' ? 'Host' : 'Invitado'} · ${room.players}/2 personas` : '';
  document.querySelector('#close-room').hidden = room?.role !== 'host';
  document.querySelector('#open-room').textContent = room ? `Sala · ${room.players}/2` : 'Salas';
  document.querySelector('#room-status').textContent = (cable?.status === 'error' ? cable.message : state.notice || cable?.message) || {
    disconnected: 'Crea una sala o introduce un código para conectarte.',
    connecting: 'Conectando con el servidor de salas…',
    reconnecting: 'Reconectando. Las salas anteriores no se recuperan automáticamente.',
    connected: room ? (room.players === 2 ? 'Las dos personas están conectadas. Conecta el cable Link en ambos dispositivos.' : 'Esperando rival. Comparte tu código para invitar a otra persona.') : 'Conexión disponible. Crea una sala o introduce un código.',
  }[state.connection];
  for (const button of roomsDialog.querySelectorAll('button:not(.dialog-close)')) button.disabled = roomBusy;
  if (linkButton) {
    linkButton.textContent = cable?.active ? 'Desconectar cable Link' : 'Conectar cable Link';
    linkButton.disabled = roomBusy || busy || (!cable?.active && (room?.players !== 2 || !['running', 'paused'].includes(emulator.getState().status)));
  }
}
multiplayer.addEventListener('statechange', ({ detail }) => updateRoom(detail));
document.querySelector('#open-room').addEventListener('click', () => {
  sessionDialog.close();
  openDialog(roomsDialog);
  updateRoom();
});
async function roomAction(action) {
  if (roomBusy) return;
  roomBusy = true;
  updateRoom();
  let failure;
  try { await action(); }
  catch (error) { failure = error; }
  finally {
    roomBusy = false;
    updateRoom();
    if (failure) document.querySelector('#room-status').textContent = failure.message;
  }
}
document.querySelector('#create-room').addEventListener('click', () => roomAction(() => multiplayer.createRoom()));
document.querySelector('#join-room').addEventListener('submit', event => {
  event.preventDefault();
  roomAction(() => multiplayer.joinRoom(document.querySelector('#room-code-input').value));
});
linkButton.addEventListener('click', () => roomAction(() => {
  if (link.getState().active) return link.disconnect();
  controls.releaseAll();
  emulator.unlockAudio().catch(showMessage);
  link.connect();
}));
document.querySelector('#leave-room').addEventListener('click', () => roomAction(async () => { await link.disconnect(); await multiplayer.leaveRoom(); }));
document.querySelector('#close-room').addEventListener('click', () => roomAction(async () => { await link.disconnect(); await multiplayer.closeRoom(); }));
window.addEventListener('pagehide', () => { void link.disconnect(); multiplayer.disconnect(); });
updateRoom();
adminTest = createAdminTest({
  canLoad: () => !busy && !link.getState().active && !['loading', 'error'].includes(emulator.getState().status),
  onOpen: () => { controls.releaseAll(); sessionDialog.close(); },
  onGesture: () => { emulator.unlockAudio().catch(showMessage); },
  loadFiles: async ({ rom, save }) => {
    if (busy || link.getState().active) throw new Error('Termina la operación actual y desconecta el cable para cargar la prueba.');
    return perform(async () => {
      const id = await sha256(await rom.arrayBuffer());
      // Do not replace existing/corrupt progress with a server template. The
      // normal loader still owns header, battery integrity and chip checks.
      const local = await saveStorage.get(id);
      await emulator.loadRom(rom);
      emulator.pause();
      if (!local) await emulator.importSave(save);
      lastRomFile = lastRomHandle = null;
      if (!document.hidden && document.hasFocus()) emulator.resume();
      return local ? 'Prueba abierta. Se conservó tu partida local.' : 'Prueba abierta con la plantilla. El progreso se guarda localmente.';
    }, { rethrow: true });
  },
});
romAccess.get().then(record => {
  if (record && /^[a-f0-9]{64}$/.test(record.romId) && typeof record.name === 'string') {
    rememberedAccess = record;
    rememberRom.checked = true;
  }
  updateSession(emulator.getState());
}).catch(() => { /* Optional file access must not prevent playing or save export. */ });

export { canvas, consoleElement, controls, standby, emulator, multiplayer, link, immersive };
