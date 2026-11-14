import { NetlifyDev } from '@netlify/dev'; // Already supplied by the pinned local Netlify CLI.
import { getStore } from '@netlify/blobs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../netlify/server/password.mjs';

/** Official Netlify Dev + real SDK/local Blobs, never a remote/cloud store. */
export async function adminFixture() {
  await mkdir(resolve('artifacts'), { recursive: true });
  const root = await mkdtemp(resolve('artifacts/admin-dev-'));
  await mkdir(resolve(root, 'netlify/server'), { recursive: true });
  for (const name of ['index', 'rooms', 'admin', 'password']) await copyFile(resolve(`netlify/server/${name}.mjs`), resolve(root, `netlify/server/${name}.mjs`));
  for (const folder of ['js', 'core']) await mkdir(resolve(root, `public/${folder}`), { recursive: true });
  const assets = ['index.html', 'style.css', ...['main', 'controls', 'emulator', 'storage', 'multiplayer', 'link', 'immersive', 'admin'].map(name => `js/${name}.js`),
    ...['em.js', 'em.wasm', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'].map(name => `core/${name}`)];
  for (const name of assets) await copyFile(resolve('public', name), resolve(root, 'public', name));
  await writeFile(resolve(root, 'netlify.toml'), '[build]\npublish = "public"\n[server]\npath = "/api/*"\n');
  const password = randomBytes(24).toString('base64url');
  const values = { NETLIFY_DEV: 'true', EMERALD_ADMIN_ENABLED: 'true', EMERALD_PRIVATE_STORE: 'emerald-private-preview',
    EMERALD_ADMIN_PASSWORD_HASH: await hashPassword(password), EMERALD_SESSION_SECRET: randomBytes(48).toString('base64url') };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  let dev;
  async function start() {
    dev = new NetlifyDev({ projectRoot: root, serverAddress: null, skipGitignore: true,
      server: { enabled: true }, blobs: { enabled: true }, database: { enabled: false }, environmentVariables: { enabled: false },
      functions: { enabled: false }, edgeFunctions: { enabled: false }, images: { enabled: false }, geolocation: { enabled: false }, aiGateway: { enabled: false } });
    await dev.start();
    const blobContext = JSON.parse(Buffer.from(process.env.NETLIFY_BLOBS_CONTEXT, 'base64').toString());
    if (!/^http:\/\/localhost:\d+$/.test(blobContext.edgeURL)) throw new Error('Refusing non-local test storage');
  }
  await start();
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = ['GET', 'HEAD'].includes(incoming.method) ? undefined : Readable.toWeb(incoming);
      const request = new Request(`http://localhost:${server.address().port}${incoming.url}`, {
        method: incoming.method, headers: { ...incoming.headers, 'x-forwarded-host': incoming.headers.host, 'x-forwarded-proto': 'http' }, ...(body ? { body, duplex: 'half' } : {}),
      });
      const response = await dev.handle(request) ?? new Response('Not found', { status: 404 });
      const headers = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie(); if (cookies.length) headers['set-cookie'] = cookies;
      outgoing.writeHead(response.status, headers);
      if (response.body) Readable.fromWeb(response.body).on('error', () => outgoing.destroy()).pipe(outgoing);
      else outgoing.end();
    } catch { outgoing.writeHead(503).end(); }
  });
  server.on('upgrade', (request, socket, head) => {
    void dev.handleUpgrade(request, socket, head).then(handled => { if (!handled) socket.destroy(); }).catch(() => socket.destroy());
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const origin = `http://localhost:${server.address().port}`;
  return { origin, password,
    store: () => getStore({ name: 'emerald-private-preview', consistency: 'strong' }),
    productionStore: () => getStore({ name: 'emerald-private-production', consistency: 'strong' }), // Local sentinel only.
    async restart() { await dev.stop(); await start(); },
    async close() {
      server.closeAllConnections(); await new Promise(accept => server.close(accept)); await dev.stop();
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    },
  };
}
