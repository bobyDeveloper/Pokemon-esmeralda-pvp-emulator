const KEY_BINDINGS = Object.freeze({
  ArrowUp: 'UP', KeyW: 'UP',
  ArrowRight: 'RIGHT', KeyD: 'RIGHT',
  ArrowDown: 'DOWN', KeyS: 'DOWN',
  ArrowLeft: 'LEFT', KeyA: 'LEFT',
  KeyX: 'A', KeyK: 'A',
  KeyZ: 'B', KeyJ: 'B',
  KeyQ: 'L', KeyE: 'R',
  Enter: 'START', NumpadEnter: 'START',
  ShiftLeft: 'SELECT', ShiftRight: 'SELECT', Backspace: 'SELECT',
});

/** Shared input for both shells. A button stays down until ALL its sources release. */
export function createControls(root) {
  const elements = new Map(
    [...root.querySelectorAll('[data-button]')].map(element => [element.dataset.button, element]),
  );
  const sources = new Map();
  const pointers = new Set();
  const pressed = new Set();
  const abortController = new AbortController();
  const { signal } = abortController;

  function updateButton(button) {
    if (!button) return;
    const isPressed = [...sources.values()].includes(button);
    if (pressed.has(button) === isPressed) return;

    if (isPressed) pressed.add(button);
    else pressed.delete(button);

    const element = elements.get(button);
    element.classList.toggle('is-pressed', isPressed);
    element.setAttribute('aria-pressed', String(isPressed));
    root.dispatchEvent(new CustomEvent('emerald:input', {
      bubbles: true,
      detail: { button, pressed: isPressed, pressedButtons: [...pressed] },
    }));
  }

  function setSource(source, button = null) {
    const previous = sources.get(source);
    if (button) sources.set(source, button);
    else sources.delete(source);
    updateButton(previous);
    if (previous !== button) updateButton(button);
  }

  function releasePointer(pointerId) {
    pointers.delete(pointerId);
    setSource(`pointer:${pointerId}`);
    if (root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId);
  }

  function releaseAll() {
    sources.clear();
    for (const pointerId of [...pointers]) releasePointer(pointerId);
    for (const button of [...pressed]) updateButton(button);
  }

  function findButton(target) {
    const element = target?.closest('[data-button]');
    return element && root.contains(element) ? element : null;
  }

  root.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const element = findButton(event.target);
    if (!element) return;
    event.preventDefault();
    pointers.add(event.pointerId);
    root.setPointerCapture(event.pointerId);
    element.focus({ preventScroll: true });
    setSource(`pointer:${event.pointerId}`, element.dataset.button);
  }, { signal });

  root.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    const element = findButton(document.elementFromPoint(event.clientX, event.clientY));
    setSource(`pointer:${event.pointerId}`, element?.dataset.button);
  }, { signal });

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    root.addEventListener(type, event => releasePointer(event.pointerId), { signal });
  }

  function inputIsBlocked(event) {
    return event.ctrlKey || event.metaKey || event.altKey
      || event.target?.closest('input, textarea, select, [contenteditable="true"], dialog[open], button:not([data-button]), a')
      || document.querySelector('dialog[open]');
  }

  window.addEventListener('keydown', event => {
    if (inputIsBlocked(event)) return;
    // Space activates the currently focused control, using real keyup semantics.
    const button = event.code === 'Space'
      ? findButton(document.activeElement)?.dataset.button
      : KEY_BINDINGS[event.code];
    if (!button) return;
    event.preventDefault();
    setSource(`key:${event.code}`, button);
  }, { signal });

  window.addEventListener('keyup', event => {
    const source = `key:${event.code}`;
    if (!sources.has(source)) return;
    event.preventDefault();
    setSource(source);
  }, { signal });

  // Assistive technology can activate native buttons without pointer/key events.
  root.addEventListener('click', event => {
    const element = findButton(event.target);
    if (!element || event.detail !== 0 || pressed.has(element.dataset.button)) return;
    const source = `accessible:${element.dataset.button}`;
    setSource(source, element.dataset.button);
    queueMicrotask(() => setSource(source));
  }, { signal });

  root.addEventListener('contextmenu', event => event.preventDefault(), { signal });
  window.addEventListener('blur', releaseAll, { signal });
  window.addEventListener('pagehide', releaseAll, { signal });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
  }, { signal });

  return {
    getPressedButtons: () => [...pressed],
    releaseAll,
    destroy() {
      releaseAll();
      abortController.abort();
    },
  };
}
