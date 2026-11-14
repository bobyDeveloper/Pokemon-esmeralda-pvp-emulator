const LIMITS = { rom: [192, 33554432], save: [512, 131088], health: [1, 1024] };
const HINT = 'emerald:admin:active'; // Boolean UI hint only; never a credential.

async function binary(response, kind) {
  const [min, max] = LIMITS[kind];
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) < min || Number(length) > max)) throw new Error('Tamaño de archivo de prueba no permitido.');
  if (!response.body) throw new Error('Archivo de prueba no disponible.');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error('Archivo de prueba demasiado grande.');
      chunks.push(value);
    }
    if (size < min) throw new Error('Archivo de prueba incompleto.');
    if (kind === 'save' && ![512, 8192, 32768, 65536, 131072].some(n => size === n || size === n + 16)) throw new Error('La plantilla .sav no tiene un tamaño válido.');
    return new File(chunks, kind === 'rom' ? 'prueba-privada.gba' : kind === 'save' ? 'prueba-privada.sav' : 'diagnostico.txt');
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** Auth and private downloads only. Main reuses the existing emulator/save loader. */
export function createAdminTest({ loadFiles, canLoad, onOpen, onGesture }) {
  const dialog = document.querySelector('#admin-panel');
  const status = document.querySelector('#admin-status');
  const login = document.querySelector('#admin-login');
  const password = document.querySelector('#admin-password');
  const load = document.querySelector('#admin-load');
  const logout = document.querySelector('#admin-logout');
  const health = document.querySelector('#admin-health');
  let session = null, pending = false, controller = null, expiry;
  const hint = value => { try { if (value) sessionStorage.setItem(HINT, '1'); else sessionStorage.removeItem(HINT); } catch { /* Optional tab UI hint. */ } };
  function authenticated(value) {
    session = value;
    hint(Boolean(value)); clearTimeout(expiry);
    if (value) expiry = setTimeout(() => { authenticated(null); status.textContent = 'La sesión ha caducado. Vuelve a entrar.'; }, Math.max(0, value.expiresAt - Date.now()));
    update();
  }
  function update() {
    login.hidden = Boolean(session);
    load.hidden = logout.hidden = !session;
    health.hidden = !session?.preview;
    for (const button of dialog.querySelectorAll('button')) button.disabled = pending;
    load.disabled = pending || !session?.files?.rom || !session?.files?.save || !canLoad();
  }
  async function request(path, options = {}) {
    const response = await fetch(`/api/admin/${path}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      ...options, signal: controller.signal,
      headers: { 'X-Emerald-Admin': '1', ...(session ? { 'X-CSRF-Token': session.csrf } : {}), ...options.headers } });
    if (!response.ok) {
      if (response.status === 401 || response.status === 404 && ['session', 'login'].includes(path)) authenticated(null);
      const error = new Error(response.status === 429 ? 'Espera un minuto antes de volver a intentar.'
        : response.status === 404 ? 'Admin Test no disponible.' : 'No se pudo completar el acceso privado.');
      error.status = response.status; throw error;
    }
    return response;
  }
  async function run(action) {
    if (pending) return;
    pending = true; controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    update();
    try { await action(); }
    catch (error) { status.textContent = error.name === 'AbortError' ? 'La operación ha terminado por tiempo de espera.' : error.message; controller.abort(); }
    finally { clearTimeout(timer); pending = false; password.value = ''; update(); }
  }
  async function state() {
    const value = await (await request('session')).json();
    authenticated(value);
    status.textContent = 'Sesión administrativa activa.';
    update();
  }
  async function loadPrivate() {
    if (!session?.files?.rom || !session?.files?.save) { status.textContent = 'Sesión activa. Faltan archivos de prueba; puedes verificar el diagnóstico.'; return; }
    if (!canLoad()) throw new Error('Desconecta el cable y termina la operación actual antes de cargar la prueba.');
    status.textContent = 'Preparando prueba privada…';
    const [rom, save] = await Promise.all(['rom', 'save'].map(async kind => binary(await request(kind), kind)));
    const result = await loadFiles({ rom, save });
    status.textContent = result;
    dialog.close();
  }
  login.addEventListener('submit', event => {
    event.preventDefault();
    onGesture();
    void run(async () => {
      const body = JSON.stringify({ password: password.value }); password.value = '';
      await request('login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      await state(); await loadPrivate();
    });
  });
  logout.addEventListener('click', () => void run(async () => {
    await request('logout', { method: 'POST' }); authenticated(null); status.textContent = 'Sesión cerrada y revocada.';
  }));
  load.addEventListener('click', () => { onGesture(); void run(async () => { await state(); await loadPrivate(); }); });
  health.addEventListener('click', () => void run(async () => {
    const file = await binary(await request('health'), 'health'); status.textContent = await file.text();
  }));
  dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  dialog.addEventListener('close', () => { password.value = ''; });
  function open() {
    onOpen();
    if (!dialog.open) dialog.showModal();
    update();
    if (session) void run(state);
    else password.focus();
  }
  document.querySelector('#admin-open').addEventListener('click', open);
  // Reload in a tab that explicitly authenticated can restore its HttpOnly
  // session. The hint grants no access; the server revalidates every request.
  try {
    if (sessionStorage.getItem(HINT) === '1') {
      open(); void run(async () => { await state(); await loadPrivate(); });
    }
  } catch { /* Session storage may be disabled. Manual login remains available. */ }
  return { open, refresh: () => { if (dialog.open) update(); } };
}
