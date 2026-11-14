import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gbaProbe } from './gba-probe.mjs';

import { origin, artifactDir, startBrowser, cdpSocket, page, until } from './browser.mjs';

const base64 = bytes => Buffer.from(bytes).toString('base64');
async function harness(client, fixture, saveByte) {
  const rom = fixture === 'probe' ? gbaProbe() : await readFile(new URL(`./fixtures/link/${fixture}.gba`, import.meta.url));
  await client.evaluate(`(async () => {
    const { createEmulator } = await import('/js/emulator.js');
    const { Multiplayer } = await import('/js/multiplayer.js');
    const { Link } = await import('/js/link.js');
    const decode = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
    const records = new Map();
    const errors = [];
    const storage = { get: async id => records.get(id), put: async (id, name, bytes) => {
      const updatedAt = Date.now(); records.set(id, { bytes: bytes.slice(), updatedAt }); return updatedAt;
    }};
    const emulator = createEmulator({ canvas: document.querySelector('canvas'), storage,
      onStateChange: () => {}, onError: error => errors.push(error.message) });
    await emulator.unlockAudio();
    try { await emulator.loadRom(new File([decode('${base64(gbaProbe())}')], 'probe.gba')); }
    catch (error) { throw new Error(error.message + ': ' + (error.cause?.stack ?? error.cause)); }
    emulator.pause();
    // Isolated MEMFS diagnostics: headerless upstream fixtures cannot enter the
    // production file picker. No app IndexedDB is ever opened by this harness.
    FS.writeFile('rom.gba', decode('${base64(rom)}'));
    FS.writeFile('rom.sav', new Uint8Array(32768).fill(${saveByte}));
    Module.ccall('initFromEmscripten', null, ['string'], ['rom.gba']);
    const metrics = { calls: {}, ticks: {}, sent: 0, received: 0, peerDone: 0, attaches: [], speculative: [], order: [], pointers: new Set() };
    for (const key of ['_netlink_attach', '_netlink_set_speculative', '_netlink_init', '_netlink_tick', '_netlink_feed', '_netlink_drain', '_netlink_exit', '_netlink_peer_done', '_loop_tick', '_malloc', '_free', '_initFromEmscripten']) {
      const original = Module[key];
      Module[key] = (...args) => {
        metrics.calls[key] = (metrics.calls[key] ?? 0) + 1;
        if (key === '_netlink_attach') metrics.attaches.push(args);
        if (key === '_netlink_set_speculative') metrics.speculative.push(args[0]);
        if (key === '_netlink_exit') metrics.order.push('exit');
        if (key === '_free') metrics.pointers.delete(args[0]);
        const result = original(...args);
        if (key === '_malloc') metrics.pointers.add(result);
        if (key === '_netlink_feed') metrics.received += args[1];
        if (key === '_netlink_drain' && result > 0) { metrics.sent += result; metrics.order.push('drain'); }
        if (key === '_netlink_tick') metrics.ticks[result] = (metrics.ticks[result] ?? 0) + 1;
        if (key === '_netlink_peer_done' && result) metrics.peerDone++;
        return result;
      };
    }
    const multiplayer = new Multiplayer();
    const link = new Link({ multiplayer, emulator });
    const signals = [];
    const send = multiplayer.sendSignal.bind(multiplayer);
    multiplayer.sendSignal = data => { signals.push(data); return send(data); };
    const word = offset => (Module._wasm_ew16(offset) | Module._wasm_ew16(offset + 2) << 16) >>> 0;
    window.h = { emulator, multiplayer, link, errors, records, metrics, signals, word,
      snapshot: () => ({ core: emulator.getState(), link: link.getState(), room: multiplayer.getState(),
        done: word(0x800), role: word(0x804), irq: word(0x808),
        log: Array.from({length: 16}, (_, i) => Module._wasm_ew16(i * 2)),
        log32: Array.from({length: 16}, (_, i) => word(i * 4)),
        log1: Array.from({length: 16}, (_, i) => Module._wasm_ew16(0x400 + i * 2)),
        debug: Module.UTF8ToString(Module._netlink_debug()), metrics: { ...metrics, pointers: [...metrics.pointers] }, errors }) };
    window.done = () => h.snapshot().done === 0xcafe;
  })()`);
}

async function available(client, expression) {
  await client.evaluate(`(async () => { for (let n = 0; n < 15; n++) {
    try { await ${expression}; return; } catch (e) { if (e.code !== 'RATE_LIMIT') throw e; await new Promise(r => setTimeout(r, 2100)); }
  } throw new Error('Room quota did not refill'); })()`);
}

async function room(host, guest, connect = true) {
  await available(host, 'h.multiplayer.createRoom()');
  const code = await host.evaluate('h.multiplayer.getState().room.code');
  await available(guest, `h.multiplayer.joinRoom('${code}')`);
  await until(host, 'h.multiplayer.getState().room?.players === 2');
  if (connect) {
    await host.evaluate('h.link.connect()');
    await guest.evaluate('h.link.connect()');
  }
}

test('real WebRTC / Netlify / Dingbat Link diagnostics and application regression', { timeout: 180000 }, async t => {
  assert.equal((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json())).ok, true, 'Start npx netlify dev first');
  const browser = await startBrowser();
  const browserCDP = await cdpSocket(browser.address);
  t.after(async () => { await browserCDP.call('Browser.close').catch(() => {}); browserCDP.socket.close(); browser.child.kill(); });
  const evidence = [{ environment: { browser: await browserCDP.call('Browser.getVersion'), node: process.version,
    time: new Date().toISOString(), origin, revision: '91709f81223ee6a8be61e251466a7d748141d458' } }];
  for (const fixture of ['attachtest', 'linktest', 'normlinktest', 'norm32linktest']) {
    await t.test(`${fixture}: 16 original SIO exchanges, local battery and clean detach`, async () => {
      const host = await page(browser);
      const guest = await page(browser);
      try {
        await Promise.all([harness(host, fixture, 0x11), harness(guest, fixture, 0x22)]);
        if (fixture === 'attachtest') {
          await Promise.all([host.evaluate('h.emulator.resume()'), guest.evaluate('h.emulator.resume()')]);
          await delay(150); // Prove attachment to already-running cores, not a reboot.
        }
        await room(host, guest);
        await Promise.all([until(host, 'done()'), until(guest, 'done()')]);
        const snapshots = await Promise.all([host.evaluate('h.snapshot()'), guest.evaluate('h.snapshot()')]);
        for (const [i, snapshot] of snapshots.entries()) {
          assert.equal(snapshot.irq, 16);
          const rounds = Array.from({ length: 16 }, (_, r) => r);
          if (fixture.startsWith('norm32')) assert.deepEqual(snapshot.log32, rounds.map(r => ((i ? 0xa5a50000 : 0x5a5a0000) | r) >>> 0));
          else if (fixture.startsWith('norm')) assert.deepEqual(snapshot.log, rounds.map(r => (i ? 0xc0 : 0xd0) | r));
          else {
            assert.deepEqual(snapshot.log, rounds.map(r => 0xa000 | r));
            assert.deepEqual(snapshot.log1, rounds.map(r => 0xb000 | r));
            assert.equal((snapshot.role >>> 4) & 3, i);
          }
          if (fixture.startsWith('norm')) assert.equal(snapshot.role & 1, i ? 0 : 1);
          assert.deepEqual(snapshot.metrics.attaches, [[i ? 0 : 1, 0]]);
          assert.deepEqual(snapshot.metrics.speculative, [0]);
          assert.equal(snapshot.metrics.calls._netlink_init ?? 0, 0);
          assert.equal(snapshot.metrics.calls._initFromEmscripten ?? 0, 0, 'attach must preserve the running game');
          assert.ok(snapshot.metrics.received > 0 && snapshot.metrics.sent > 0);
          assert.ok(snapshot.metrics.ticks[1] > 0 && snapshot.metrics.ticks[2] > 0);
          if (fixture !== 'attachtest') assert.equal(snapshot.metrics.calls._loop_tick ?? 0, 0);
          assert.equal(snapshot.room.room.players, 2);
          assert.equal(snapshot.room.connection, 'connected', 'WebSocket membership survives RTC open');
          assert.deepEqual(snapshot.errors, []);
        }
        assert.deepEqual(await host.evaluate(`(() => { const c = h.link.session.channel; return [c.label, c.ordered, c.maxRetransmits, c.maxPacketLifeTime, c.binaryType]; })()`), ['link', true, null, null, 'arraybuffer']);
        // Stop one peer: the other reaches a bounded lockstep stall, does not
        // manufacture frames and resumes by receiving CLOCK/REPLY on the wire.
        await guest.evaluate('h.emulator.pause()');
        await delay(300);
        await until(host, "h.emulator.getState().link === 'waiting'");
        assert.equal(await host.evaluate('Module._netlink_stalled()'), 1);
        assert.equal(await host.evaluate('Module._netlink_crc_mismatch()'), 0);
        const before = await host.evaluate('h.metrics.ticks[1]');
        await delay(200);
        assert.equal(await host.evaluate('h.metrics.ticks[1]'), before, 'no completed frames while the peer is stopped');
        await guest.evaluate('h.emulator.resume()');
        await until(host, `h.metrics.ticks[1] > ${before}`);
        for (const client of [host, guest]) {
          const blocked = await client.evaluate(`(async () => {
            const failures = [];
            for (const action of [() => h.emulator.reset(), () => h.emulator.loadRom(new File([], 'x.gba')), () => h.emulator.importSave(new File([], 'x.sav'))]) {
              try { await action(); } catch (e) { failures.push(e.message); }
            } return failures;
          })()`);
          assert.equal(blocked.length, 3);
          assert.ok(blocked.every(message => message.includes('Desconecta el cable')));
        }
        await host.evaluate('h.link.disconnect()');
        await until(guest, "!h.link.getState().active && h.emulator.getState().link === 'inactive'");
        for (const [i, client] of [host, guest].entries()) {
          const snap = await client.evaluate('h.snapshot()');
          assert.equal(snap.metrics.calls._netlink_exit, 1);
          if (i === 1) assert.ok(snap.metrics.peerDone > 0, 'the guest received the original BYE');
          const exit = snap.metrics.order.indexOf('exit');
          assert.ok(snap.metrics.order.slice(exit + 1).includes('drain'), 'BYE drained after netlink_exit');
          assert.deepEqual(snap.metrics.pointers, [], 'every WASM transport allocation freed');
          const solo = snap.metrics.calls._loop_tick ?? 0;
          await until(client, `(h.metrics.calls._loop_tick ?? 0) > ${solo}`);
          const save = await client.evaluate(`(() => { const { bytes } = h.emulator.exportSave(); return { size: bytes.length, intact: bytes.every(b => b === ${i ? 0x22 : 0x11}) }; })()`);
          assert.deepEqual(save, { size: 32768, intact: true });
          assert.equal(await client.evaluate('h.multiplayer.getState().room.players'), 2);
          assert.deepEqual(client.errors, []);
        }
        evidence.push({ fixture, snapshots });
      } finally {
        for (const client of [host, guest]) {
          await client.evaluate('h?.link.destroy().then(() => { h.multiplayer.disconnect(); h.emulator.destroy(); })').catch(() => {});
          await client.close();
        }
      }
    });
  }
  await t.test('different real SHA-256 identities fail before RTC/attach without exchanging ROMs', async () => {
    const host = await page(browser);
    const guest = await page(browser);
    try {
      await Promise.all([harness(host, 'probe', 0x11), harness(guest, 'probe', 0x22)]);
      const other = gbaProbe(); other[0x350] ^= 1;
      await guest.evaluate(`h.emulator.loadRom(new File([Uint8Array.from(atob('${base64(other)}'), c => c.charCodeAt(0))], 'different.gba'))`);
      await room(host, guest);
      await Promise.all([until(host, '!h.link.getState().active'), until(guest, '!h.link.getState().active')]);
      for (const client of [host, guest]) {
        assert.match(await client.evaluate('h.link.getState().message'), /SHA-256/);
        assert.equal(await client.evaluate('h.metrics.calls._netlink_attach ?? 0'), 0);
        assert.equal(await client.evaluate('h.link.session'), null);
        assert.deepEqual(client.errors, []);
      }
    } finally {
      for (const client of [host, guest]) {
        await client.evaluate('h?.link.destroy().then(() => { h.multiplayer.disconnect(); h.emulator.destroy(); })').catch(() => {});
        await client.close();
      }
    }
  });
  await t.test('strict CRC mismatch returns both peers to solo without a ROM transfer', async () => {
    const host = await page(browser);
    const guest = await page(browser);
    try {
      await Promise.all([harness(host, 'linktest', 0x11), harness(guest, 'normlinktest', 0x22)]);
      await room(host, guest);
      await Promise.all([until(host, '!h.link.getState().active'), until(guest, '!h.link.getState().active')]);
      assert.match(await host.evaluate('h.link.getState().message'), /CRC mismatch/);
      assert.match(await guest.evaluate('h.link.getState().message'), /CRC mismatch/);
      await delay(200);
      assert.match(await host.evaluate('h.link.getState().message'), /CRC mismatch/);
      assert.match(await guest.evaluate('h.link.getState().message'), /CRC mismatch/);
      assert.equal(await host.evaluate('h.emulator.getState().link'), 'inactive');
      assert.equal(await guest.evaluate('h.emulator.getState().link'), 'inactive');
      assert.deepEqual(host.errors, []);
      assert.deepEqual(guest.errors, []);
    } finally {
      for (const client of [host, guest]) {
        await client.evaluate('h?.link.destroy().then(() => { h.multiplayer.disconnect(); h.emulator.destroy(); })').catch(() => {});
        await client.close();
      }
    }
  });
  await t.test('approved app: menu, inputs, pause/focus, rotation and local IndexedDB remain functional', async () => {
    const host = await page(browser, true);
    const guest = await page(browser);
    const probePath = resolve(artifactDir, 'link-ui-probe.gba');
    await writeFile(probePath, gbaProbe());
    try {
      await until(host, "document.querySelector('#connect-link')");
      await host.evaluate(`(async () => {
        window.app = await import('/js/main.js'); window.originalCanvas = app.canvas;
        window.h = { emulator: app.emulator, multiplayer: app.multiplayer, link: app.link };
      })()`);
      const { root } = await host.call('DOM.getDocument');
      const { nodeId } = await host.call('DOM.querySelector', { nodeId: root.nodeId, selector: '#rom-file' });
      await host.call('DOM.setFileInputFiles', { nodeId, files: [probePath] });
      await until(host, "app.emulator.getState().status === 'running'");
      await host.evaluate(`app.emulator.importSave(new File([new Uint8Array(32768).fill(0x33)], 'probe.sav'))`);
      await harness(guest, 'probe', 0x22);
      await room(host, guest, false);
      await host.evaluate('h.emulator.setSpeed(2)');
      await host.evaluate(`document.querySelector('#connect-link').click()`);
      await until(host, 'h.emulator.getState().linkPending');
      assert.equal(await host.evaluate('h.emulator.getState().status'), 'paused', 'freeze the game during negotiation');
      assert.equal(await host.evaluate('h.emulator.getState().speed'), 1);
      assert.equal(await host.evaluate("document.querySelector('#fast-forward').disabled"), true);
      assert.equal(await host.evaluate("document.querySelector('#reset-game').disabled && document.querySelector('#load-rom').disabled && document.querySelector('#import-save').disabled"), true);
      await host.evaluate("document.querySelector('#connect-link').click()");
      await until(host, "!h.link.getState().active && h.emulator.getState().status === 'running'");
      await host.evaluate("document.querySelector('#connect-link').click()");
      await until(host, 'h.emulator.getState().linkPending');
      await host.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'))");
      await guest.evaluate('h.link.connect()');
      await until(host, "h.link.getState().connected && h.emulator.getState().status === 'paused'");
      await host.evaluate("delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))");
      await Promise.all([until(host, "h.emulator.getState().link === 'connected'"), until(guest, "h.emulator.getState().link === 'connected'")]);
      assert.equal(await host.evaluate("document.querySelector('#export-save').disabled"), false);
      assert.match(await host.evaluate("Promise.resolve().then(() => h.emulator.setSpeed(2)).then(() => '', e => e.message)"), /PvP/);
      assert.equal(await host.evaluate("document.querySelector('#connect-link').textContent"), 'Desconectar cable Link');
      await host.call('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyX', key: 'x' });
      await until(host, '(Module._wasm_ew16(0) & 1) === 0');
      await host.call('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyX', key: 'x' });
      await until(host, '(Module._wasm_ew16(0) & 1) === 1');
      await host.evaluate("window.dispatchEvent(new Event('blur'))");
      assert.equal(await host.evaluate('h.emulator.getState().status'), 'paused');
      await delay(300);
      await until(guest, "h.emulator.getState().link === 'waiting'");
      await host.evaluate("window.dispatchEvent(new Event('focus'))");
      await until(host, "h.emulator.getState().status === 'running' && h.emulator.getState().link === 'connected'");
      // User pause remains user-controlled across focus changes.
      await host.evaluate("document.querySelector('#pause-game').click(); window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus'))");
      assert.equal(await host.evaluate('h.emulator.getState().status'), 'paused');
      await host.evaluate("document.querySelector('#pause-game').click()");
      for (const [width, height] of [[390, 844], [844, 390]]) {
        await host.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
        await delay(100);
        assert.equal(await host.evaluate("app.canvas === originalCanvas && document.querySelectorAll('canvas').length === 1 && app.canvas.width === 240 && app.canvas.height === 160"), true);
        const ratio = await host.evaluate('app.canvas.getBoundingClientRect().width / app.canvas.getBoundingClientRect().height');
        assert.ok(Math.abs(ratio - 1.5) < 0.01);
        assert.equal(await host.evaluate('h.emulator.getState().status'), 'running');
      }
      await host.evaluate("document.querySelector('#connect-link').click()");
      await until(host, '!h.link.getState().active');
      await until(guest, '!h.link.getState().active');
      assert.equal(await host.evaluate("document.querySelector('#reset-game').disabled || document.querySelector('#load-rom').disabled || document.querySelector('#import-save').disabled"), false);
      assert.equal(await host.evaluate('h.multiplayer.getState().room.players'), 2);
      // A fresh pairing in the same surviving room must not reuse stale SDP,
      // ICE or listeners from the first connection.
      await host.evaluate("document.querySelector('#connect-link').click()");
      await guest.evaluate('h.link.connect()');
      await Promise.all([until(host, "h.emulator.getState().link === 'connected'"), until(guest, "h.emulator.getState().link === 'connected'")]);
      await host.evaluate('h.link.disconnect()');
      await until(guest, '!h.link.getState().active');
      // A pressed A writes 0x5a to SRAM in this legal ROM. Other save bytes
      // must retain the original local pattern and persist through a real reload.
      await host.evaluate('h.emulator.pause(); h.emulator.persist()');
      assert.deepEqual(await host.evaluate(`(() => { const { bytes } = h.emulator.exportSave(); return [bytes.length, bytes[0], bytes.slice(1).every(b => b === 0x33)]; })()`), [32768, 0x5a, true]);
      await host.call('Page.reload');
      await until(host, "document.readyState === 'complete' && document.querySelector('#connect-link')");
      await host.evaluate(`(async () => { window.app = await import('/js/main.js'); })()`);
      const doc = await host.call('DOM.getDocument');
      const input = await host.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#rom-file' });
      await host.call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [probePath] });
      await until(host, "app.emulator.getState().status === 'running'");
      assert.deepEqual(await host.evaluate(`(() => { app.emulator.pause(); const { bytes } = app.emulator.exportSave(); return [bytes.length, bytes[0], bytes.slice(1).every(b => b === 0x33)]; })()`), [32768, 0x5a, true]);
      // The production loader continues to reject the original headerless ROM.
      const headerless = base64(await readFile(new URL('./fixtures/link/linktest.gba', import.meta.url)));
      assert.match(await host.evaluate(`app.emulator.loadRom(new File([Uint8Array.from(atob('${headerless}'), c => c.charCodeAt(0))], 'headerless.gba')).then(() => '', e => e.message)`), /cabecera/);
      assert.deepEqual(host.errors, []);
      assert.deepEqual(guest.errors, []);
      evidence.push({ application: 'menu, cancellation, reconnect, inputs, rotation, pause/focus, IndexedDB reload', passed: true });
    } finally {
      await host.evaluate('app.link.destroy().then(() => { app.multiplayer.disconnect(); app.emulator.destroy(); })').catch(() => {});
      await guest.evaluate('h?.link.destroy().then(() => { h.multiplayer.disconnect(); h.emulator.destroy(); })').catch(() => {});
      await host.close();
      await guest.close();
    }
  });
  await writeFile(resolve(artifactDir, 'link-browser-results.json'), JSON.stringify(evidence, null, 2));
});
