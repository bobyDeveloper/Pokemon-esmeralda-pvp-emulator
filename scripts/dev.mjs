import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const preview = process.argv.includes('--dist');
const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), preview ? '../dist' : '../public');
const port = Number(process.env.PORT ?? (preview ? 4173 : 5173));
const host = process.env.HOST ?? '127.0.0.1';
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  try {
    const url = new URL(request.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const file = resolve(publicDirectory, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${publicDirectory}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    if (!(await stat(file)).isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    const body = await readFile(file);
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    if (preview && request.headers['if-none-match'] === etag) {
      response.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=0, must-revalidate' }).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': preview ? 'public, max-age=0, must-revalidate' : 'no-store',
      ...(preview ? { ETag: etag } : {}),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' wss: ws://localhost:8888 ws://127.0.0.1:8888; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    const status = error instanceof URIError ? 400 : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500;
    response.writeHead(status).end(status === 400 ? 'Bad request' : status === 404 ? 'Not found' : 'Server error');
    if (status === 500) console.error(error);
  }
});

server.on('error', error => {
  console.error(`No se pudo iniciar el servidor: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Emerald PVP · http://${host}:${server.address().port}`);
  console.log('Ctrl+C para detener. Sin dependencias ni compilación.');
});
