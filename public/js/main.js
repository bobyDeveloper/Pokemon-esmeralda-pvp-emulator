import { createControls } from './controls.js';

const consoleElement = document.querySelector('#console');
const canvas = document.querySelector('#game-screen');
const standby = document.querySelector('#standby');
const inputStatus = document.querySelector('#input-status');
const modelLabel = document.querySelector('#model-label');
const dialog = document.querySelector('#controls-help');
const orientation = window.matchMedia('(orientation: landscape)');
const controls = createControls(consoleElement);

consoleElement.addEventListener('emerald:input', ({ detail }) => {
  inputStatus.textContent = detail.pressedButtons.length
    ? detail.pressedButtons.map(button => ({ UP: '↑', RIGHT: '→', DOWN: '↓', LEFT: '←' })[button] ?? button).join(' + ')
    : 'CONTROLES LISTOS';
});

function updateModel() {
  // Only CSS changes the layout. Neither the Canvas nor the controls are replaced.
  controls.releaseAll();
  const model = orientation.matches ? 'ADVANCE' : 'ADVANCE SP';
  modelLabel.textContent = model;
  consoleElement.setAttribute('aria-label', `Game Boy ${model}, controles de juego`);
}

orientation.addEventListener('change', updateModel);
updateModel();

document.querySelector('.help-toggle').addEventListener('click', () => {
  controls.releaseAll();
  dialog.showModal();
});

dialog.addEventListener('click', event => {
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});

// Integration seam for the future engine: use this SAME Canvas, subscribe to
// `emerald:input` on consoleElement, and hide standby once real video is ready.
// No context is created here: the engine can choose 2D, WebGL, or another backend.
export { canvas, consoleElement, controls, standby };
