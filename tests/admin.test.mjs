import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createAdminHandler, adminConfiguration, boundedStream } from '../netlify/server/admin.mjs';
import { hashPassword, parsePasswordHash, verifyPassword } from '../netlify/server/password.mjs';

const password = randomBytes(24).toString('base64url');
const passwordHash = await hashPassword(password);
const secret = randomBytes(48).toString('base64url');
const environment = () => ({ EMERALD_ADMIN_ENABLED: 'true', EMERALD_ADMIN_PASSWORD_HASH: passwordHash,
  EMERALD_SESSION_SECRET: secret, EMERALD_PRIVATE_STORE: 'emerald-private-preview' });
const context = { ip: 'unit-test', deploy: { context: 'deploy-preview' } };
const origin = 'https://preview.example.test';
function fixture(env = environment()) {
  const records = new Map(), reads = [], names = [];
  let time = Date.now();
  const store = {
    get: async (key, options) => {
      reads.push([key, options]); const record = records.get(key);
      if (record === undefined) return null;
      return options.type === 'stream' && !(record instanceof ReadableStream) ? new Blob([JSON.stringify(record)]).stream() : record;
    },
    setJSON: async (key, value) => { records.set(key, structuredClone(value)); },
    delete: async key => { records.delete(key); },
    getMetadata: async key => records.has(key) ? { metadata: {} } : null,
  };
  const make = () => createAdminHandler({ environment: () => env, now: () => time, openStore: options => {
    assert.equal(options.consistency, 'strong'); names.push(options.name); return store;
  } });
  let handler = make();
  const call = (path, { method = 'GET', body, cookie, csrf, headers, ctx = context } = {}) => handler(new Request(origin + '/api/admin/' + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: {
      Origin: origin, 'X-Emerald-Admin': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers,
    },
  }), ctx);
  const login = async () => {
    const response = await call('login', { method: 'POST', body: { password } });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], ...(await response.json()) };
  };
  return { call, login, records, reads, names, store, restart() { handler = make(); }, advance(ms) { time += ms; } };
}

test('scrypt has random salts, fixed safe parameters and constant-size comparison', async () => {
  const second = await hashPassword(password);
  assert.notEqual(second, passwordHash);
  assert.equal(await verifyPassword(password, parsePasswordHash(second)), true);
  assert.equal(await verifyPassword(randomBytes(20).toString('hex'), parsePasswordHash(second)), false);
  assert.equal(parsePasswordHash(second.replace('65536', '999999999')), null);
});
test('admin is disabled by default and a preview cannot select the production store', async () => {
  assert.equal(adminConfiguration({}, context), null);
  assert.equal(adminConfiguration(environment(), { deploy: { context: '' } }), null);
  assert.equal(adminConfiguration({ ...environment(), NETLIFY_DEV: 'true', EMERALD_PRIVATE_STORE: 'emerald-private-production' }, { deploy: { context: 'production' } }), null);
  for (const env of [{}, { ...environment(), EMERALD_PRIVATE_STORE: 'emerald-private-production' },
    { ...environment(), EMERALD_ADMIN_PASSWORD_HASH: 'invalid' }]) {
    const f = fixture(env);
    assert.equal((await f.call('rom')).status, 404); assert.deepEqual(f.names, []);
  }
  const f = fixture({ ...environment(), EMERALD_ADMIN_ENABLED: undefined, EMERALD_PRIVATE_STORE: 'emerald-private-production' });
  assert.equal((await f.call('rom', { ctx: { ...context, deploy: { context: 'production' } } })).status, 404);
  const preview = fixture(), session = await preview.login();
  const production = fixture({ ...environment(), EMERALD_PRIVATE_STORE: 'emerald-private-production' });
  assert.equal((await production.call('rom', { ...session, ctx: { ...context, deploy: { context: 'production' } } })).status, 401);
  assert.deepEqual(production.names, [], 'a preview cookie must not even query the production store');
});
test('correct/incorrect credentials, cookie flags, persistent restart and expiry', async () => {
  const f = fixture();
  assert.equal((await f.call('login', { method: 'POST', body: { password: randomBytes(16).toString('hex') } })).status, 401);
  const response = await f.call('login', { method: 'POST', body: { password } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^__Host-emerald_admin=/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=900', 'Path=/']) assert.ok(response.headers.get('set-cookie').includes(flag));
  const session = { cookie: response.headers.get('set-cookie').split(';')[0], ...(await response.json()) };
  f.restart();
  assert.equal((await f.call('session', session)).status, 200);
  f.advance(900001);
  assert.equal((await f.call('session', session)).status, 401);
  assert.equal(f.records.size, 0);
});
test('logout requires CSRF and revokes server-side access even with a copied old cookie', async () => {
  const f = fixture(), session = await f.login();
  assert.equal((await f.call('logout', { ...session, csrf: undefined, method: 'POST' })).status, 403);
  assert.equal((await f.call('logout', { ...session, method: 'POST' })).status, 200);
  f.restart();
  assert.equal((await f.call('rom', session)).status, 401);
  assert.equal((await f.call('session', session)).status, 401);
});
test('Origin, request shapes, CSRF and forged cookies fail before any binary lookup', async () => {
  const f = fixture();
  assert.equal((await f.call('rom')).status, 401);
  assert.equal((await f.call('rom', { cookie: `__Host-emerald_admin=${randomBytes(32).toString('base64url')}.${randomBytes(32).toString('base64url')}` })).status, 401);
  assert.deepEqual(f.reads, []);
  assert.equal((await f.call('login', { method: 'POST', body: { password }, headers: { Origin: 'https://other.example.test' } })).status, 403);
  assert.equal((await f.call('login', { method: 'POST', body: { password }, headers: { 'X-Emerald-Admin': '0' } })).status, 403);
  assert.equal((await f.call('login', { method: 'POST', body: { password, key: 'admin/rom' } })).status, 400);
  const session = await f.login();
  assert.equal((await f.call('rom', { ...session, csrf: undefined })).status, 403);
  assert.equal((await f.call('rom?store=emerald-private-production', session)).status, 404);
  assert.equal((await f.call('unknown', session)).status, 404);
  assert.equal(f.reads.some(([key]) => key === 'admin/rom'), false);
});
test('rate limits and concurrent hash/body work are bounded', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) assert.equal((await f.call('login', { method: 'POST', body: {} })).status, 400);
  assert.equal((await f.call('login', { method: 'POST', body: { password } })).status, 429);
  f.advance(60001); assert.equal((await f.call('login', { method: 'POST', body: { password } })).status, 200);
  const flood = fixture();
  for (let i = 0; i < 60; i++) assert.equal((await flood.call('session')).status, 401);
  assert.equal((await flood.call('session')).status, 429);
});
test('authenticated files are streamed unchanged, no-store, and diagnostic is preview-only', async () => {
  const f = fixture(), session = await f.login();
  const bytes = randomBytes(1024);
  f.records.set('admin/rom', new Blob([bytes]).stream());
  const response = await f.call('rom', session);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.has('access-control-allow-origin'), false);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.ok(f.names.every(name => name === 'emerald-private-preview'));
  const production = fixture({ ...environment(), EMERALD_PRIVATE_STORE: 'emerald-private-production' });
  assert.equal((await production.call('health', { ctx: { ...context, deploy: { context: 'production' } } })).status, 404);
  assert.deepEqual(production.names, []);
});
test('oversized, incomplete and stalled streams fail within bounds', async () => {
  for (const bytes of [new Uint8Array(0), new Uint8Array(65)]) {
    const stream = boundedStream(new Blob([bytes]).stream(), { min: 1, max: 64 });
    await assert.rejects(new Response(stream).arrayBuffer());
  }
  const stalled = new ReadableStream({ pull: () => new Promise(() => {}) });
  await assert.rejects(new Response(boundedStream(stalled, { min: 1, max: 64, timeout: 20 })).arrayBuffer(), /timeout/);
});
test('storage failure cannot return a binary or report a successful revocation', async () => {
  const f = fixture(), session = await f.login();
  f.store.delete = async () => { throw new Error(secret); };
  const logout = await f.call('logout', { ...session, method: 'POST' });
  assert.equal(logout.status, 503);
  assert.equal(logout.headers.has('set-cookie'), false);
  assert.equal((await logout.text()).includes(secret), false);
  f.store.get = async () => { throw new Error(passwordHash); };
  const file = await f.call('rom', session);
  assert.equal(file.status, 503);
  assert.equal(file.headers.get('content-type').includes('application/json'), true);
  assert.equal((await file.text()).includes(passwordHash), false);
});
