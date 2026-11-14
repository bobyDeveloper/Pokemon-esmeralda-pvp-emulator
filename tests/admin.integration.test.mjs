import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { adminFixture } from './admin-fixture.mjs';
import { startBrowser, cdpSocket, page, until } from './browser.mjs';
import { gbaProbe } from './gba-probe.mjs';
import { Multiplayer } from '../public/js/multiplayer.js';

test('private Admin Test with official Netlify Dev, real SDK/local Blobs and the real browser core', { timeout: 180000 }, async t => {
  const fixture = await adminFixture();
  t.after(() => fixture.close());
  const text = 'Diagnóstico privado correcto ✓';
  // Only harmless data, written to the SDK's isolated LOCAL sandbox. No cloud
  // upload, personal ROM, game_test read or user store is involved.
  await fixture.store().set('admin/health', text);
  await fixture.productionStore().set('admin/health', 'LOCAL production-isolation sentinel');
  const request = (path, { method = 'GET', body, cookie, csrf, headers } = {}) => fetch(fixture.origin + '/api/admin/' + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: {
      Origin: fixture.origin, 'X-Emerald-Admin': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers,
    },
  });
  let session;
  await t.test('unauthorized binaries denied; text diagnostic only after authentication and CSRF', async () => {
    for (const path of ['rom', 'save', 'health', 'session']) assert.equal((await request(path)).status, 401, path);
    assert.equal((await request('login', { method: 'POST', body: { password: randomBytes(24).toString('hex') } })).status, 401);
    const response = await request('login', { method: 'POST', body: { password: fixture.password } });
    assert.equal(response.status, 200);
    session = { cookie: response.headers.get('set-cookie').split(';')[0], ...(await response.json()) };
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await request('health', { cookie: session.cookie })).status, 403);
    const diagnostic = await request('health', session);
    assert.equal(diagnostic.headers.get('cache-control'), 'private, no-store');
    assert.equal(diagnostic.headers.has('access-control-allow-origin'), false);
    assert.equal(await diagnostic.text(), text);
    assert.equal(await (await request('health', { ...session, headers: { 'x-nf-deploy-context': 'production' } })).text(), text);
    assert.equal((await request('health?store=emerald-private-production', session)).status, 404);
    const state = await (await request('session', session)).json();
    assert.deepEqual(state.files, { rom: false, save: false }); assert.equal(state.preview, true);
    assert.equal((await request('rom', session)).status, 404);
  });
  if (!session) return; // Do not turn one failed auth setup into binary/browser noise.
  await t.test('binary integrity, restart persistence, CSRF/Origin rejection and real logout revocation', async () => {
    const rom = gbaProbe(), save = new Uint8Array(32768).fill(0x11);
    await fixture.store().set('admin/rom', rom.buffer);
    await fixture.store().set('admin/save', save.buffer);
    assert.deepEqual(Buffer.from(await (await request('rom', session)).arrayBuffer()), Buffer.from(rom));
    assert.deepEqual(Buffer.from(await (await request('save', session)).arrayBuffer()), Buffer.from(save));
    const large = new Uint8Array(8 * 1024 * 1024); large.set(rom);
    await fixture.store().set('admin/rom', large.buffer);
    const largeResponse = await request('rom', session);
    assert.equal(largeResponse.status, 200);
    const actual = Buffer.from(await largeResponse.arrayBuffer());
    assert.equal(actual.length, large.byteLength);
    assert.equal(createHash('sha256').update(actual).digest('hex'), createHash('sha256').update(large).digest('hex'));
    await fixture.store().set('admin/rom', rom.buffer);
    assert.equal((await request('rom', { ...session, headers: { Origin: 'https://other.example.test' } })).status, 403);
    assert.equal((await request('rom?key=admin/save', session)).status, 404);
    assert.equal((await request('rom', { ...session, headers: { Range: 'bytes=0-1' } })).status, 416);
    await fixture.restart();
    assert.equal((await request('session', session)).status, 200);
    assert.equal((await request('logout', { ...session, method: 'POST' })).status, 200);
    assert.equal((await request('rom', session)).status, 401);
    await fixture.restart();
    assert.equal((await request('session', session)).status, 401);
  });
  await t.test('lock menu loads one emulator, keeps local progress/template immutable and can still create rooms', async () => {
    const browser = await startBrowser(), control = await cdpSocket(browser.address);
    let client, guest;
    try {
      client = await page(browser, true, fixture.origin);
      await until(client, "document.querySelector('#admin-open')");
      await client.evaluate("import('/js/main.js').then(module => { window.app = module; window.initialCanvas = app.canvas; document.querySelector('#admin-open').click(); })");
      await client.evaluate(`document.querySelector('#admin-password').value = ${JSON.stringify(fixture.password)}; document.querySelector('#admin-login').requestSubmit()`);
      await until(client, "app.emulator.getState().status === 'running' && document.querySelector('#admin-panel').open === false");
      assert.equal(await client.evaluate('app.emulator.getState().romName'), 'prueba-privada.gba');
      assert.equal(await client.evaluate('app.canvas === initialCanvas && document.querySelectorAll("canvas").length === 1'), true);
      assert.equal(await client.evaluate('app.emulator.exportSave().bytes.every(byte => byte === 0x11)'), true);
      assert.equal(await client.evaluate("document.cookie.includes('emerald_admin')"), false);
      assert.equal(await client.evaluate("sessionStorage.getItem('emerald:admin:active')"), '1');
      await client.evaluate(`app.emulator.importSave(new File([new Uint8Array(32768).fill(0x33)], 'local.sav')).then(() => app.emulator.persist())`);
      await fixture.store().set('admin/save', new Uint8Array(32768).fill(0x77).buffer);
      await client.call('Page.reload');
      await until(client, "document.readyState === 'complete' && document.querySelector('#connect-link')");
      await client.evaluate("import('/js/main.js').then(module => { window.app = module; })");
      await until(client, "app.emulator.getState().status === 'running' && !document.querySelector('#admin-panel').open");
      assert.equal(await client.evaluate('app.emulator.exportSave().bytes.every(byte => byte === 0x33)'), true);
      const endpoint = new URL('/api/signal', fixture.origin);
      guest = new Multiplayer(endpoint);
      await client.evaluate('app.multiplayer.createRoom()');
      const code = await client.evaluate('app.multiplayer.getState().room.code');
      await guest.joinRoom(code);
      await until(client, 'app.multiplayer.getState().room?.players === 2');
      await client.evaluate('app.multiplayer.closeRoom()'); guest.disconnect();
      await client.evaluate("document.querySelector('#admin-open').click()");
      await until(client, "!document.querySelector('#admin-logout').disabled");
      await client.evaluate("document.querySelector('#admin-logout').click()");
      await until(client, "document.querySelector('#admin-status').textContent.includes('revocada')");
      assert.equal(await client.evaluate("sessionStorage.getItem('emerald:admin:active')"), null);
      assert.equal(await client.evaluate('app.emulator.getState().romId !== null'), true, 'logout does not destroy already loaded local progress');
      assert.deepEqual(new Uint8Array(await fixture.store().get('admin/save', { type: 'arrayBuffer' })), new Uint8Array(32768).fill(0x77));
      assert.deepEqual(client.errors, []);
      await writeFile(resolve('artifacts/admin-browser-results.json'), JSON.stringify({ localNetlifyDev: true, textDiagnostic: true,
        authenticatedBinary: true, restart: true, logoutRevoked: true, localProgressPreserved: true, templateReadOnly: true,
        singleCanvas: true, roomSmoke: true, browser: await control.call('Browser.getVersion') }, null, 2));
    } finally {
      guest?.disconnect();
      await client?.evaluate('app?.emulator.destroy(); app?.multiplayer.disconnect()').catch(() => {});
      await client?.close().catch(() => {});
      await control.call('Browser.close').catch(() => {}); control.socket.close(); browser.child.kill();
    }
  });
});
