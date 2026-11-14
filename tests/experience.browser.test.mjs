import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startBrowser, cdpSocket, page, until } from './browser.mjs';
import { gbaProbe } from './gba-probe.mjs';

const preview = process.env.PREVIEW_TEST_URL ?? 'http://localhost:4173';
const bytes64 = Buffer.from(gbaProbe()).toString('base64');
const probe = resolve('artifacts/rc-probe.gba');
const wrong = resolve('artifacts/rc-different.gba');
async function select(client, file = probe) {
  const { root } = await client.call('DOM.getDocument');
  const { nodeId } = await client.call('DOM.querySelector', { nodeId: root.nodeId, selector: '#rom-file' });
  await client.call('DOM.setFileInputFiles', { nodeId, files: [file] });
}
async function app(client) {
  await until(client, "document.querySelector('#connect-link')");
  await client.evaluate("import('/js/main.js').then(module => { window.app = module; window.originalCanvas = app.canvas; })");
}
async function viewport(client, width = 390, height = 844) {
  await client.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
  await delay(80);
}
async function key(client, type, code, key) { await client.call('Input.dispatchKeyEvent', { type, code, key }); }
async function point(client, button) {
  return client.evaluate(`(() => { const r = document.querySelector('[data-button="${button}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
}
async function touch(client, type, points = []) {
  await client.call('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, id) => ({ id, radiusX: 3, radiusY: 3, ...p })) });
}
const pressed = client => client.evaluate('app.controls.getPressedButtons().sort()');
async function reload(client) {
  await client.call('Page.reload');
  await until(client, "document.readyState === 'complete' && document.querySelector('#connect-link')");
  await app(client);
}

test('RC experience with the real core, native Pointer Events and production resources', { timeout: 180000 }, async t => {
  const browser = await startBrowser();
  const controller = await cdpSocket(browser.address);
  let client;
  t.after(async () => {
    await client?.evaluate('app?.emulator.destroy()').catch(() => {});
    await client?.close().catch(() => {});
    await controller.call('Browser.close').catch(() => {}); controller.socket.close(); browser.child.kill();
  });
  await writeFile(probe, gbaProbe());
  const other = gbaProbe(); other[0x350] ^= 1; await writeFile(wrong, other);
  client = await page(browser, true);
  await app(client);
  await viewport(client);
  await client.call('Page.setInterceptFileChooserDialog', { enabled: true });
  await client.evaluate("document.querySelector('#remember-rom').click()");
  await until(client, "!document.querySelector('#load-rom').disabled");
  await select(client);
  await until(client, "app.emulator.getState().status === 'running' && !document.querySelector('#continue-rom').hidden");
  const results = { browser: await controller.call('Browser.getVersion') };

  await t.test('real 1x/2x scheduler, bounded silent fast-forward and PvP reservation at 1x', async () => {
    await client.evaluate(`(() => { window.frames = 0; const original = Module._loop_tick; Module._loop_tick = (...args) => { window.frames++; return original(...args); }; })()`);
    const sample = async speed => client.evaluate(`new Promise(resolve => {
      app.emulator.setSpeed(${speed}); const start = performance.now(), frames = window.frames;
      setTimeout(() => resolve({ frames: window.frames - frames, elapsed: performance.now() - start }), 900);
    })`);
    const normal = await sample(1), fast = await sample(2);
    const ratio = (fast.frames / fast.elapsed) / (normal.frames / normal.elapsed);
    assert.ok(ratio > 1.75 && ratio < 2.25, JSON.stringify({ normal, fast, ratio }));
    assert.equal(await client.evaluate('Module._getAudioBufferLen()'), 0);
    await client.evaluate('app.emulator.reserveLink()');
    assert.equal(await client.evaluate('app.emulator.getState().speed'), 1);
    assert.equal(await client.evaluate("document.querySelector('#fast-forward').disabled"), true);
    assert.match(await client.evaluate("Promise.resolve().then(() => app.emulator.setSpeed(2)).then(() => '', e => e.message)"), /PvP/);
    await client.evaluate('app.emulator.stopLink()');
    assert.equal(await client.evaluate("document.querySelector('#fast-forward').disabled"), false);
    await client.evaluate("document.querySelector('#fast-forward').click()");
    assert.equal(await client.evaluate('app.emulator.getState().speed'), 2);
    await client.evaluate("document.querySelector('#fast-forward').click()");
    assert.equal(await client.evaluate('app.emulator.getState().speed'), 1);
    results.speed = { normal, fast, ratio };
  });

  await t.test('multitouch A+B+direction, keyboard aggregation, cancellation, capture loss and dpad sliding', async () => {
    await client.evaluate(`window.lastPointer = null; window.pointerLog = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
        app.consoleElement.addEventListener(type, event => {
          if (type === 'pointerdown') window.lastPointer = event.pointerId;
          window.pointerLog.push([type, event.pointerId, event.target.id || event.target.dataset.button, app.consoleElement.hasPointerCapture(event.pointerId)]);
        });
      }`);
    const a = await point(client, 'A'), b = await point(client, 'B'), up = await point(client, 'UP'), right = await point(client, 'RIGHT');
    await touch(client, 'touchStart', [a, b, up]);
    assert.deepEqual(await pressed(client), ['A', 'B', 'UP']);
    await key(client, 'keyDown', 'KeyX', 'x');
    await touch(client, 'touchCancel');
    assert.deepEqual(await pressed(client), ['A'], 'a cancelled finger must not release the held keyboard key');
    await key(client, 'keyUp', 'KeyX', 'x');
    assert.deepEqual(await pressed(client), [], JSON.stringify(await client.evaluate('window.pointerLog')));
    await touch(client, 'touchStart', [a]);
    await touch(client, 'touchMove', [{ ...a, x: a.x + 2 }]); // Deliver gotpointercapture before testing its loss.
    await client.evaluate('app.consoleElement.releasePointerCapture(window.lastPointer)');
    await touch(client, 'touchMove', [{ ...a, x: a.x + 4 }]);
    await until(client, "window.pointerLog.some(event => event[0] === 'lostpointercapture' && event[1] === window.lastPointer)");
    assert.deepEqual(await pressed(client), [], JSON.stringify(await client.evaluate('window.pointerLog')));
    await touch(client, 'touchEnd');
    await touch(client, 'touchStart', [up]);
    await touch(client, 'touchMove', [right]);
    await until(client, "app.controls.getPressedButtons().includes('RIGHT')");
    assert.deepEqual(await pressed(client), ['RIGHT']);
    await touch(client, 'touchMove', [{ x: 3, y: 3 }]);
    await touch(client, 'touchEnd');
    assert.deepEqual(await pressed(client), []);
    // Mouse up outside the shell is also a final release boundary.
    await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...a, button: 'left', clickCount: 1 });
    await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', clickCount: 1 });
    assert.deepEqual(await pressed(client), []);
  });

  await t.test('standard Gamepad and touch aggregate; blur/visibility/rotation release without stuck buttons', async () => {
    // Browser gamepad enumeration is injected; the production poller, aggregation,
    // Pointer Events and real core remain in use. No physical gamepad claimed.
    await client.evaluate(`(() => {
      window.pad = { index: 0, connected: true, mapping: 'standard', axes: [0, 0], buttons: Array.from({length: 16}, () => ({ pressed: false, value: 0 })) };
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [window.pad] });
      window.dispatchEvent(new Event('gamepadconnected'));
    })()`);
    await delay(50);
    await client.evaluate('window.pad.buttons[0].pressed = true');
    await until(client, "app.controls.getPressedButtons().includes('A')");
    await touch(client, 'touchStart', [await point(client, 'A')]);
    await touch(client, 'touchEnd');
    assert.deepEqual(await pressed(client), ['A']);
    await client.evaluate("window.dispatchEvent(new Event('blur'))");
    assert.deepEqual(await pressed(client), []);
    await client.evaluate("window.dispatchEvent(new Event('focus'))");
    await delay(50);
    assert.deepEqual(await pressed(client), [], 'held pad stays suppressed until neutral');
    await client.evaluate('window.pad.buttons[0].pressed = false; app.emulator.resume()');
    await delay(50);
    await client.evaluate('window.pad.axes[0] = 0.8');
    await until(client, "app.controls.getPressedButtons().includes('RIGHT')");
    await client.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'))");
    assert.deepEqual(await pressed(client), []);
    assert.equal(await client.evaluate('app.emulator.getState().status'), 'paused');
    await client.evaluate("delete document.hidden; window.pad.axes[0] = 0; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); app.emulator.resume()");
    await delay(50);
    await touch(client, 'touchStart', [await point(client, 'A')]);
    await viewport(client, 844, 390);
    assert.deepEqual(await pressed(client), []);
    assert.equal(await client.evaluate('app.emulator.getState().status'), 'running');
    await touch(client, 'touchEnd');
    await client.evaluate("window.pad.connected = false; window.dispatchEvent(new Event('gamepaddisconnected'))");
    await viewport(client);
    assert.deepEqual(await pressed(client), []);
  });

  await t.test('CSS immersive fallback and native Fullscreen API keep one screen, all controls and a visible exit', async () => {
    await client.evaluate("Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false })");
    await client.evaluate('app.immersive.toggle()');
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1920, 1080]]) {
      await viewport(client, width, height);
      const geometry = await client.evaluate(`(() => {
        const c = app.canvas.getBoundingClientRect(), exit = document.querySelector('#immersive-toggle').getBoundingClientRect();
        return { single: app.canvas === originalCanvas && document.querySelectorAll('canvas').length === 1,
          buffer: [app.canvas.width, app.canvas.height], ratio: c.width / c.height,
          exit: exit.width > 0 && exit.height > 0 && exit.top >= 0 && exit.right <= innerWidth,
          hidden: ['#load-rom', '#session-toggle', '.help-toggle', '.app-footer'].every(s => document.querySelector(s).getClientRects().length === 0),
          controls: [...document.querySelectorAll('[data-button]')].every(el => el.getBoundingClientRect().width > 0),
          scroll: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight };
      })()`);
      assert.equal(geometry.single, true); assert.deepEqual(geometry.buffer, [240, 160]);
      assert.ok(Math.abs(geometry.ratio - 1.5) < .01); assert.equal(geometry.exit, true);
      assert.equal(geometry.hidden, true); assert.equal(geometry.controls, true); assert.equal(geometry.scroll, false);
    }
    await client.evaluate('app.immersive.toggle(); delete document.fullscreenEnabled');
    assert.equal(await client.evaluate('app.immersive.active()'), false);
    await viewport(client);
    await client.call('Emulation.clearDeviceMetricsOverride');
    await client.call('Page.bringToFront');
    await client.evaluate(`(() => { const request = document.documentElement.requestFullscreen;
      document.documentElement.requestFullscreen = function(...args) { return request.apply(this, args).catch(error => { window.fullscreenFailure = error.message; throw error; }); };
    })()`);
    const fullscreenButton = await client.evaluate("(() => { const r = document.querySelector('#immersive-toggle').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
    await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...fullscreenButton, button: 'left', clickCount: 1 });
    await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...fullscreenButton, button: 'left', clickCount: 1 });
    await delay(150);
    assert.equal(await client.evaluate('document.fullscreenElement === document.documentElement'), true,
      JSON.stringify(await client.evaluate('({ enabled: document.fullscreenEnabled, error: window.fullscreenFailure })')));
    await client.evaluate('document.exitFullscreen()');
    await until(client, '!app.immersive.active()');
    await client.evaluate('app.emulator.resume()');
    await client.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await client.evaluate("getComputedStyle(document.querySelector('.action')).transitionDuration"), '0s');
    await client.call('Emulation.setEmulatedMedia', { features: [] });
  });

  await t.test('authorized continuation, wrong file rejection, native persisted handle and corrupt-save recovery', async () => {
    const seed = new Uint8Array(32768).fill(0x44);
    await client.evaluate(`app.emulator.importSave(new File([new Uint8Array(32768).fill(0x44)], 'probe.sav')).then(() => app.emulator.pause())`);
    await reload(client);
    await until(client, "!document.querySelector('#continue-rom').hidden");
    await client.evaluate("document.querySelector('#continue-rom').click()");
    await select(client, wrong);
    await until(client, "document.querySelector('#notification-message').textContent.includes('no coincide')");
    assert.equal(await client.evaluate('app.emulator.getState().romId'), null);
    await client.evaluate("document.querySelector('#continue-rom').click()");
    await select(client);
    await until(client, "app.emulator.getState().status === 'running'");
    assert.equal(await client.evaluate('app.emulator.exportSave().bytes.every(b => b === 0x44)'), true);
    // An actual structured-cloneable FileSystemFileHandle in this disposable
    // profile exercises persistence/permission/getFile. OPFS is only a test
    // fixture: application code never copies ROM data into browser storage.
    await client.evaluate(`(async () => {
      const directory = await navigator.storage.getDirectory();
      const handle = await directory.getFileHandle('authorized.gba', { create: true });
      const writer = await handle.createWritable();
      await writer.write(Uint8Array.from(atob('${bytes64}'), c => c.charCodeAt(0))); await writer.close();
      const { romAccess } = await import('/js/storage.js');
      await romAccess.put({ romId: app.emulator.getState().romId, name: 'authorized.gba', handle });
      app.emulator.pause(); await app.emulator.persist();
    })()`);
    await reload(client);
    await until(client, "!document.querySelector('#continue-rom').hidden");
    await client.evaluate("document.querySelector('#continue-rom').click()");
    await until(client, "app.emulator.getState().status === 'running'");
    assert.equal(await client.evaluate('app.emulator.exportSave().bytes.every(b => b === 0x44)'), true);
    await client.evaluate(`(async () => {
      app.emulator.pause(); await app.emulator.persist();
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('emerald-pvp', 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('saves', 'readwrite'), store = tx.objectStore('saves');
        const r = store.get(app.emulator.getState().romId);
        r.onsuccess = () => { const record = r.result; record.bytes[7] ^= 1; store.put(record); };
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      }); db.close();
    })()`);
    await reload(client);
    await until(client, "!document.querySelector('#continue-rom').hidden");
    await client.evaluate("document.querySelector('#continue-rom').click()");
    await until(client, "app.emulator.getState().status === 'paused' && !app.emulator.getState().persistence");
    await delay(2100);
    const preserved = await client.evaluate(`new Promise(resolve => { const r = indexedDB.open('emerald-pvp', 2); r.onsuccess = () => {
      const db = r.result, tx = db.transaction('saves'), q = tx.objectStore('saves').get(app.emulator.getState().romId);
      q.onsuccess = () => resolve(q.result.bytes[7]); tx.oncomplete = () => db.close();
    }; })`);
    assert.equal(preserved, seed[7] ^ 1);
    await client.evaluate(`app.emulator.importSave(new File([new Uint8Array(32768).fill(0x44)], 'repair.sav'))`);
    assert.equal(await client.evaluate('app.emulator.getState().persistence && app.emulator.exportSave().bytes.every(b => b === 0x44)'), true);
    await client.evaluate("document.querySelector('#remember-rom').click()");
    await until(client, "document.querySelector('#continue-rom').hidden");
    assert.equal(await client.evaluate("import('/js/storage.js').then(s => s.romAccess.get()).then(r => r === undefined)"), true);
    assert.equal(await client.evaluate('app.emulator.exportSave().bytes.every(b => b === 0x44)'), true);
  });

  await t.test('minified production app loads the unchanged WASM and revalidates stable URLs', async () => {
    const built = await page(browser, true, preview);
    try {
      await app(built);
      const loads = [];
      for (let i = 0; i < 5; i++) {
        if (i) { await built.call('Network.clearBrowserCache'); await reload(built); }
        loads.push(await built.evaluate(`(async () => {
          const start = performance.now(); await app.emulator.unlockAudio();
          await app.emulator.loadRom(new File([Uint8Array.from(atob('${bytes64}'), c => c.charCodeAt(0))], 'probe.gba'));
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const timing = { documentMs: performance.getEntriesByType('navigation')[0].loadEventEnd,
            wasmToFrameMs: performance.now() - start, totalMs: performance.now() };
          app.emulator.pause(); return timing;
        })()`));
      }
      const response = await fetch(`${preview}/core/em.wasm`);
      assert.match(response.headers.get('content-type'), /application\/wasm/);
      assert.match(response.headers.get('content-security-policy'), /wasm-unsafe-eval/);
      assert.match(response.headers.get('cache-control'), /must-revalidate/);
      assert.equal((await fetch(`${preview}/core/em.wasm`, { headers: { 'If-None-Match': response.headers.get('etag') } })).status, 304);
      for (const url of ['/tests/gba-probe.mjs', '/game_test/test.gba', '/package.json', '/references/portrait.jpg']) assert.equal((await fetch(preview + url)).status, 404);
      assert.deepEqual(built.errors, []);
      results.productionLoads = loads;
    } finally { await built.evaluate('app?.emulator.destroy()').catch(() => {}); await built.close(); }
  });
  assert.deepEqual(client.errors, []);
  await writeFile(resolve('artifacts/rc-experience-results.json'), JSON.stringify(results, null, 2));
});
