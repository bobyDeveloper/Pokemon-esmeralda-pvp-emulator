import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const secretSentinels = { EMERALD_ADMIN_PASSWORD_HASH: randomBytes(48).toString('base64url'), EMERALD_SESSION_SECRET: randomBytes(48).toString('base64url') };
const run = promisify(execFile);
const build = () => run(process.execPath, ['scripts/build.mjs'], { cwd: root, windowsHide: true, env: { ...process.env, ...secretSentinels } });
const read = name => readFile(new URL(`../${name}`, import.meta.url));
async function manifest() {
  const names = (await readdir(new URL('../dist/', import.meta.url), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => `${entry.parentPath}/${entry.name}`.replaceAll('\\', '/'));
  return Object.fromEntries(await Promise.all(names.sort().map(async name => [relative(resolve(root, 'dist'), name).replaceAll('\\', '/'), createHash('sha256').update(await readFile(name)).digest('hex')])));
}
before(build);
test('production build is reproducible, bounded to public assets and preserves the engine byte for byte', async () => {
  const first = await manifest();
  await build();
  assert.deepEqual(await manifest(), first);
  assert.equal(Object.keys(first).length, 15);
  assert.ok(Object.keys(first).every(name => /^(dist\/)?(index\.html|style\.css|js\/[\w-]+\.js|core\/(em\.js|em\.wasm|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md))$/.test(name)));
  for (const name of ['em.js', 'em.wasm', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
    assert.deepEqual(await read(`dist/core/${name}`), await read(`public/core/${name}`));
  }
});
test('build keeps module/WASM paths, native Canvas and CSP without publishing private inputs', async () => {
  const html = (await read('dist/index.html')).toString();
  assert.equal((html.match(/<canvas\b/g) ?? []).length, 1);
  assert.match(html, /width="240" height="160"/);
  assert.match(html, /src="\/js\/main.js"/);
  assert.match((await read('dist/js/emulator.js')).toString(), /\.\.\/core\//);
  const config = (await read('netlify.toml')).toString();
  assert.match(config, /command = "npm run build"/);
  assert.match(config, /path = "\/api\/\*"/);
  assert.match(config, /wasm-unsafe-eval/);
  assert.match(config, /must-revalidate/);
  assert.match(config, /application\/wasm/);
  assert.ok((await read('dist/style.css')).length < (await read('public/style.css')).length);
});
test('build never contains server secrets, private directories or server-side credentials', async () => {
  const paths = Object.keys(await manifest());
  assert.ok(paths.every(name => !/game_test|netlify\/server|\.env|test|artifacts/.test(name)));
  for (const name of paths) {
    const bytes = await read(`dist/${name}`);
    for (const value of Object.values(secretSentinels)) assert.equal(bytes.includes(Buffer.from(value)), false, name);
    assert.equal(bytes.includes(Buffer.from('EMERALD_SESSION_SECRET')), false, name);
    assert.equal(bytes.includes(Buffer.from('EMERALD_ADMIN_PASSWORD_HASH')), false, name);
  }
  assert.match((await read('.gitignore')).toString(), /^\/game_test\/$/m);
});
