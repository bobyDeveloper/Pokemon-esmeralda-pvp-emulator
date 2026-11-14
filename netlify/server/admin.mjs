import { getStore } from '@netlify/blobs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parsePasswordHash, verifyPassword } from './password.mjs';

const TTL = 15 * 60 * 1000;
const CACHE = { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' };
const ROUTES = new Map([
  ['/api/admin/login', 'POST'], ['/api/admin/session', 'GET'], ['/api/admin/logout', 'POST'],
  ['/api/admin/rom', 'GET'], ['/api/admin/save', 'GET'], ['/api/admin/health', 'GET'],
]);
const assets = { rom: { min: 192, max: 32 * 1024 * 1024 }, save: { min: 512, max: 131088 }, health: { min: 1, max: 1024 } };
const json = (status, data = { error: 'No disponible.' }, extra = {}) => Response.json(data, { status, headers: { ...CACHE, ...extra } });
const digest = text => createHash('sha256').update(text).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function adminConfiguration(env, context) {
  if (env.EMERALD_ADMIN_ENABLED !== 'true') return null;
  // CLI sets these server-side flags. Its current local context has an empty
  // deploy.context, so local execution must explicitly remain preview-only.
  const local = env.NETLIFY_DEV === 'true' || env.NETLIFY_LOCAL === 'true';
  const deployment = local ? 'dev' : context?.deploy?.context;
  const preview = deployment === 'deploy-preview' || deployment === 'dev';
  const store = preview ? 'emerald-private-preview' : deployment === 'production' ? 'emerald-private-production' : null;
  if (!store || env.EMERALD_PRIVATE_STORE !== store || typeof env.EMERALD_SESSION_SECRET !== 'string'
    || Buffer.byteLength(env.EMERALD_SESSION_SECRET) < 32 || Buffer.byteLength(env.EMERALD_SESSION_SECRET) > 256) return null;
  const password = parsePasswordHash(env.EMERALD_ADMIN_PASSWORD_HASH);
  if (!password) return null;
  return { store, preview, local, password, secret: env.EMERALD_SESSION_SECRET,
    credential: digest(env.EMERALD_ADMIN_PASSWORD_HASH) };
}

/** A bounded stream; no full-ROM buffer or private upstream headers/URLs escape. */
export function boundedStream(stream, { min, max, timeout = 15000, duration = 120000 }) {
  const reader = stream.getReader();
  const deadline = performance.now() + duration;
  let size = 0;
  return new ReadableStream({
    async pull(controller) {
      let timer;
      try {
        const remaining = Math.min(timeout, deadline - performance.now());
        if (remaining <= 0) throw new Error('Read timeout');
        const { done, value } = await Promise.race([reader.read(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Read timeout')), remaining);
        })]);
        if (done) {
          if (size < min) throw new Error('Invalid object size');
          reader.releaseLock(); controller.close(); return;
        }
        if (!(value instanceof Uint8Array) || (size += value.byteLength) > max) throw new Error('Object too large');
        controller.enqueue(value);
      } catch (error) { void reader.cancel().catch(() => {}); controller.error(error); }
      finally { clearTimeout(timer); }
    },
    cancel: reason => reader.cancel(reason),
  });
}

async function loginBody(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json'
    || Number(request.headers.get('content-length') ?? 0) > 2048 || !request.body) throw new Error('Invalid request');
  const limited = boundedStream(request.body, { min: 1, max: 2048, timeout: 3000, duration: 3000 });
  const value = JSON.parse(await new Response(limited).text());
  if (!value || Object.keys(value).length !== 1 || typeof value.password !== 'string'
    || !value.password.length || Buffer.byteLength(value.password) > 1024) throw new Error('Invalid request');
  return value.password;
}

/** Only this handler selects stores/keys. Auth sessions use strong persistent reads. */
export function createAdminHandler({ environment = () => process.env, openStore = getStore, now = Date.now } = {}) {
  const attempts = new Map();
  const requests = new Map();
  let hashing = 0;
  function allowed(buckets, ip, burst, interval) {
    const time = now();
    for (const [key, bucket] of buckets) if (time - bucket.at > 15 * 60 * 1000) buckets.delete(key);
    if (!buckets.has(ip) && buckets.size >= 1024) return false;
    const bucket = buckets.get(ip) ?? { tokens: burst, at: time };
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, time - bucket.at) / interval);
    bucket.at = time; buckets.set(ip, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens--; return true;
  }
  return async function admin(request, context) {
    const url = new URL(request.url);
    const config = adminConfiguration(environment(), context);
    if (!config || !ROUTES.has(url.pathname) || url.search) return json(404);
    const kind = url.pathname.slice('/api/admin/'.length);
    if (kind === 'health' && !config.preview) return json(404);
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    if ((origin && origin !== url.origin) || (site && site !== 'same-origin' && site !== 'none')
      || (request.method !== 'GET' && origin !== url.origin)) return json(403);
    if (request.method !== ROUTES.get(url.pathname)) return json(405, undefined, { Allow: ROUTES.get(url.pathname) });
    if (!allowed(requests, context?.ip ?? 'unknown', 60, 1000)) return json(429, undefined, { 'Retry-After': '60' });
    if (url.protocol !== 'https:' && !(config.local && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return json(404);
    const secure = url.protocol === 'https:';
    const cookieName = secure ? '__Host-emerald_admin' : 'emerald_admin_dev';
    const audience = `${config.store}\n${url.origin}\n${config.credential}`;
    const mac = (purpose, sid) => createHmac('sha256', config.secret).update(`${purpose}\n${audience}\n${sid}`).digest('base64url');
    const cookie = (value, seconds) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
    // Reject forged tokens BEFORE doing any storage operation.
    function token() {
      const all = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
      if (all.length !== 1) return null;
      const value = all[0].slice(cookieName.length + 1);
      const match = /^([\w-]{43})\.([\w-]{43})$/.exec(value);
      return match && equal(match[2], mac('session', match[1])) ? match[1] : null;
    }
    let store;
    const storage = () => store ??= openStore({ name: config.store, consistency: 'strong' });
    const sessionKey = sid => `admin/sessions/${digest(sid)}`;
    async function session() {
      const sid = token();
      if (!sid) return null;
      const data = await storage().get(sessionKey(sid), { type: 'stream', consistency: 'strong' });
      const record = data ? await new Response(boundedStream(data, { min: 1, max: 2048 })).json() : null;
      if (!record || record.audience !== audience || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt)
        || record.expiresAt <= now() || record.expiresAt > record.createdAt + TTL) {
        if (record) await storage().delete(sessionKey(sid));
        return null;
      }
      return { sid, expiresAt: record.expiresAt, csrf: mac('csrf', sid) };
    }
    try {
      if (kind === 'login') {
        if (request.headers.get('x-emerald-admin') !== '1') return json(403);
        if (hashing >= 2 || !allowed(attempts, context?.ip ?? 'unknown', 5, 60000)) return json(429, undefined, { 'Retry-After': '60' });
        hashing++;
        let password;
        let valid;
        try {
          try { password = await loginBody(request); } catch { return json(400); }
          valid = await verifyPassword(password, config.password);
        } finally { hashing--; password = null; }
        if (!valid) return json(401);
        const old = token();
        if (old) await storage().delete(sessionKey(old));
        const sid = randomBytes(32).toString('base64url');
        const expiresAt = now() + TTL;
        await storage().setJSON(sessionKey(sid), { audience, createdAt: now(), expiresAt });
        return json(200, { authenticated: true, csrf: mac('csrf', sid), expiresAt }, { 'Set-Cookie': cookie(`${sid}.${mac('session', sid)}`, TTL / 1000) });
      }
      const current = await session();
      if (!current) return json(401);
      if (kind === 'session') {
        const [rom, save] = await Promise.all(['admin/rom', 'admin/save'].map(key => storage().getMetadata(key, { consistency: 'strong' })));
        return json(200, { authenticated: true, csrf: current.csrf, expiresAt: current.expiresAt,
          files: { rom: Boolean(rom), save: Boolean(save) }, preview: config.preview });
      }
      if (!equal(request.headers.get('x-csrf-token'), current.csrf)) return json(403);
      if (kind === 'logout') {
        await storage().delete(sessionKey(current.sid)); // Commit revocation before clearing the browser cookie.
        return json(200, { authenticated: false }, { 'Set-Cookie': cookie('', 0) });
      }
      if (request.headers.has('range')) return json(416);
      const stream = await storage().get(`admin/${kind}`, { type: 'stream', consistency: 'strong' });
      if (!stream) return json(404);
      return new Response(boundedStream(stream, assets[kind]), { headers: {
        ...CACHE, 'Content-Type': kind === 'health' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${kind === 'rom' ? 'prueba-privada.gba' : kind === 'save' ? 'prueba-privada.sav' : 'diagnostico.txt'}"`,
      } });
    } catch { return json(503); } // Never return SDK errors, tokens, secrets, object URLs or paths.
  };
}
