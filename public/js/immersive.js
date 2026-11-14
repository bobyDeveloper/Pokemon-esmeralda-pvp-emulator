/** Native fullscreen when supported; the same DOM also provides an iPhone fallback. */
export function createImmersive(button, onChange) {
  const root = document.documentElement;
  let native = false;
  let pending = false;
  const active = () => root.classList.contains('is-immersive');
  function apply(value) {
    root.classList.toggle('is-immersive', value);
    button.setAttribute('aria-pressed', String(value));
    button.setAttribute('aria-label', value ? 'Salir del modo inmersivo' : 'Pantalla completa / modo inmersivo');
    button.title = value ? 'Salir del modo inmersivo' : 'Pantalla completa / modo inmersivo';
    onChange();
  }
  async function toggle() {
    if (pending) return;
    pending = true;
    const entering = !active();
    apply(entering);
    try {
      if (entering && document.fullscreenEnabled && root.requestFullscreen) {
        try { await root.requestFullscreen(); native = document.fullscreenElement === root; }
        catch { native = false; } // CSS fallback stays active and has a visible exit.
      } else if (!entering && document.fullscreenElement === root) await document.exitFullscreen();
    } finally { pending = false; }
  }
  function changed() {
    if (document.fullscreenElement === root) native = true;
    else if (native) { native = false; apply(false); }
  }
  button.addEventListener('click', toggle);
  document.addEventListener('fullscreenchange', changed);
  const keydown = event => { if (event.key === 'Escape' && active() && !document.fullscreenElement) apply(false); };
  window.addEventListener('keydown', keydown);
  return { active, toggle, destroy() {
    button.removeEventListener('click', toggle);
    document.removeEventListener('fullscreenchange', changed);
    window.removeEventListener('keydown', keydown);
    if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {});
    apply(false);
  } };
}
