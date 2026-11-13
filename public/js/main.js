import { createControls } from './controls.js';
import { createEmulator } from './emulator.js';
import { saveStorage } from './storage.js';
import { Multiplayer } from './multiplayer.js';

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
  const loaded = Boolean(state.romId);
  const usable = loaded && !['error', 'loading'].includes(state.status) && !busy;
  loadButton.disabled = busy || state.status === 'error';
  pauseButton.disabled = !usable;
  pauseButton.textContent = state.status === 'running' ? 'Pausar' : 'Reanudar';
  document.querySelector('#reset-game').disabled = !usable;
  document.querySelector('#import-save').disabled = !usable;
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

async function perform(action) {
  if (busy) return;
  busy = true;
  controls.releaseAll();
  updateSession(emulator.getState());
  try { await action(); }
  catch (error) { showMessage(error); }
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
loadButton.addEventListener('click', () => chooseFile(romInput));
document.querySelector('#import-save').addEventListener('click', () => chooseFile(saveInput));
for (const input of [romInput, saveInput]) {
  input.addEventListener('cancel', () => {
    if (resumeAfterPicker) emulator.resume();
    else emulator.pause();
    resumeAfterPicker = false;
  });
}
romInput.addEventListener('change', () => {
  const file = romInput.files[0];
  if (!file) return;
  perform(async () => {
    let loaded = false;
    try {
      await emulator.loadRom(file);
      loaded = true;
      sessionDialog.close();
    } finally {
      if (!loaded && resumeAfterPicker && emulator.getState().status === 'paused') emulator.resume();
      resumeAfterPicker = false;
    }
  });
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
  controls.releaseAll();
  if (emulator.getState().status === 'running') emulator.pause();
  else emulator.resume();
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
window.addEventListener('blur', () => { controls.releaseAll(); emulator.pause(); });
window.addEventListener('pagehide', () => { controls.releaseAll(); emulator.pause(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { controls.releaseAll(); emulator.pause(); }
});

const multiplayer = new Multiplayer();
let roomBusy = false;
function updateRoom(state = multiplayer.getState()) {
  const room = state.room;
  document.querySelector('#room-entry').hidden = Boolean(room);
  document.querySelector('#current-room').hidden = !room;
  document.querySelector('#room-code').textContent = room?.code ?? '';
  document.querySelector('#room-members').textContent = room ? `${room.role === 'host' ? 'Host' : 'Invitado'} · ${room.players}/2 personas` : '';
  document.querySelector('#close-room').hidden = room?.role !== 'host';
  document.querySelector('#open-room').textContent = room ? `Sala · ${room.players}/2` : 'Salas';
  document.querySelector('#room-status').textContent = state.notice || {
    disconnected: 'Crea una sala o introduce un código para conectarte.',
    connecting: 'Conectando con el servidor de salas…',
    reconnecting: 'Reconectando. Las salas anteriores no se recuperan automáticamente.',
    connected: room ? (room.players === 2 ? 'Las dos personas están conectadas a la sala.' : 'Comparte tu código para invitar a otra persona.') : 'Conexión disponible. Crea una sala o introduce un código.',
  }[state.connection];
  for (const button of roomsDialog.querySelectorAll('button:not(.dialog-close)')) button.disabled = roomBusy;
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
  try { await action(); }
  catch (error) { document.querySelector('#room-status').textContent = error.message; }
  finally {
    roomBusy = false;
    for (const button of roomsDialog.querySelectorAll('button:not(.dialog-close)')) button.disabled = false;
  }
}
document.querySelector('#create-room').addEventListener('click', () => roomAction(() => multiplayer.createRoom()));
document.querySelector('#join-room').addEventListener('submit', event => {
  event.preventDefault();
  roomAction(() => multiplayer.joinRoom(document.querySelector('#room-code-input').value));
});
document.querySelector('#leave-room').addEventListener('click', () => roomAction(() => multiplayer.leaveRoom()));
document.querySelector('#close-room').addEventListener('click', () => roomAction(() => multiplayer.closeRoom()));
window.addEventListener('pagehide', () => multiplayer.disconnect());
updateRoom();

export { canvas, consoleElement, controls, standby, emulator, multiplayer };
