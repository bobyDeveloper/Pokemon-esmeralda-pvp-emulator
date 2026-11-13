import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gbaProbe } from './gba-probe.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(new URL(`../${path}`, import.meta.url));
let server;
let origin;

before(async () => {
  server = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('El servidor de prueba no respondió.')), 10000);
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.stdout.on('data', chunk => {
      const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
  });
});
after(() => server?.kill());

test('official Dingbat artifacts match their published SHA-256 hashes', async () => {
  for (const [name, hash] of Object.entries({
    'em.js': 'd53bf029c62b57309ef5caa202953f74af7590d5713a2834811e8d14652726da',
    'em.wasm': '1525942f460c63707bc2f6565007bbb131b94ef4895a1fc2d6b936e555b43268',
  })) {
    const bytes = await read(`public/core/${name}`);
    // Git on Windows can translate the JS's final LF to CRLF on checkout.
    // Verify the canonical upstream text without rewriting the engine file.
    const canonical = name.endsWith('.js') ? bytes.toString('utf8').replaceAll('\r\n', '\n') : bytes;
    assert.equal(createHash('sha256').update(canonical).digest('hex'), hash);
  }
});

test('the real core compiles as valid WebAssembly', async () => {
  const module = await WebAssembly.compile(await read('public/core/em.wasm'));
  assert.ok(WebAssembly.Module.exports(module).length > 50);
});

test('the local server serves WASM and JS with MIME and CSP compatible with Netlify', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/core/em.wasm', 'application/wasm'], ['/core/em.js', 'text/javascript'], ['/js/emulator.js', 'text/javascript'], ['/js/storage.js', 'text/javascript']]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('Content-Type').startsWith(type), path);
    assert.ok(response.headers.get('Content-Security-Policy').includes("'wasm-unsafe-eval'"));
    if (path.endsWith('.wasm')) assert.deepEqual(Buffer.from(await response.arrayBuffer()), await read('public/core/em.wasm'));
    else await response.arrayBuffer();
  }
  const netlify = (await read('netlify.toml')).toString();
  assert.match(netlify, /publish = "public"/);
  assert.match(netlify, /wasm-unsafe-eval/);
  assert.match(netlify, /application\/wasm/);
});

test('the server exposes public assets only and refuses uploads', async () => {
  for (const path of ['/package.json', '/references/portrait.jpg', '/tests/gba-probe.mjs']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404);
  }
  assert.equal((await fetch(`${origin}/%2e%2e%2fpackage.json`)).status, 403);
  assert.equal((await fetch(origin, { method: 'POST', body: 'not a ROM' })).status, 405);
  assert.equal((await fetch(origin, { method: 'HEAD' })).status, 200);
});

test('the shared screen remains a single native-resolution Canvas', async () => {
  const html = (await read('public/index.html')).toString();
  assert.equal((html.match(/<canvas\b/g) ?? []).length, 1);
  assert.match(html, /id="game-screen" width="240" height="160"/);
});

test('the original diagnostic ROM has a valid header and SRAM signature', () => {
  const bytes = gbaProbe();
  assert.equal(bytes[0xb2], 0x96);
  assert.equal((bytes.slice(0xa0, 0xbe).reduce((sum, value) => sum + value, 0x19)) & 255, 0);
  assert.ok(Buffer.from(bytes).includes(Buffer.from('SRAM_V113')));
});
