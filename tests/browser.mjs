import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export const origin = process.env.SIGNAL_TEST_URL ?? 'http://localhost:8888';
const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const artifactDir = resolve('artifacts');

// Real installed browser, native WebRTC and official WASM. No test framework,
// production route, test-only loader flag or alternate signaling server.
export async function startBrowser() {
  await mkdir(artifactDir, { recursive: true });
  const profile = await mkdtemp(resolve(artifactDir, 'link-browser-'));
  const child = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const address = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome CDP did not start')), 20000);
    let stderr = '';
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited: ${code}: ${stderr}`)); });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); accept(match[1]); }
    });
  }).catch(error => { child.kill(); throw error; });
  return { child, address, http: address.replace(/^ws:/, 'http:').replace(/\/devtools\/.*/, '') };
}

export async function cdpSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((accept, reject) => {
    socket.addEventListener('open', accept, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('close', () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP closed')); }
    pending.clear();
  });
  socket.addEventListener('message', ({ data }) => {
    const event = JSON.parse(data);
    if (event.id) {
      const item = pending.get(event.id);
      if (!item) return;
      pending.delete(event.id);
      clearTimeout(item.timer);
      if (event.error) item.reject(new Error(JSON.stringify(event.error)));
      else item.accept(event.result);
    }
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails);
    if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') errors.push(event.params.entry);
  });
  const call = (method, params = {}) => new Promise((accept, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { accept, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return { socket, call, evaluate, errors };
}

export async function page(browser, app = false, address = origin) {
  const target = await fetch(`${browser.http}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const client = await cdpSocket(target.webSocketDebuggerUrl);
  await client.call('Runtime.enable');
  await client.call('Log.enable');
  await client.call('Page.enable');
  await client.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (!app) {
    // Keep a real localhost document/address space; suppress only the app
    // coordinator so diagnostics never open its IndexedDB or lifecycle hooks.
    await client.call('Network.enable');
    await client.call('Network.setBlockedURLs', { urls: [`${address}/js/main.js`] });
  }
  await client.call('Page.navigate', { url: address });
  await until(client, `location.origin === ${JSON.stringify(new URL(address).origin)} && document.readyState === 'complete'`);
  if (!app) {
    assert.ok(client.errors.every(error => error.url === `${address}/js/main.js` && /ERR_BLOCKED_BY_CLIENT/.test(error.text)), JSON.stringify(client.errors));
    client.errors.length = 0;
    await client.call('Network.setBlockedURLs', { urls: [] });
  }
  client.close = async () => {
    await fetch(`${browser.http}/json/close/${target.id}`);
    client.socket.close();
  };
  return client;
}

export async function until(client, expression, timeout = 18000) {
  const value = await client.evaluate(`new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      if (${expression}) resolve(true);
      else if (Date.now() - start > ${timeout}) resolve(false);
      else setTimeout(check, 40);
    }; check();
  })`);
  assert.equal(value, true, `Timed out: ${expression}; ${await client.evaluate('window.h?.snapshot?.() ?? location.href').then(JSON.stringify)}`);
}
