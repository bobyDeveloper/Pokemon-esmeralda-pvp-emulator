import { onShutdown, upgradeWebSocket } from '@netlify/server';
import { RoomManager } from './rooms.mjs';

const rooms = new RoomManager();
onShutdown(() => rooms.shutdown());

export default function handler(request, context) {
  const url = new URL(request.url);
  const json = (data, status = 200, headers = {}) => Response.json(data, {
    status, headers: { 'Cache-Control': 'no-store', ...headers },
  });
  if (url.pathname !== '/api/health' && url.pathname !== '/api/signal') {
    return json({ error: 'NOT_FOUND' }, 404);
  }
  if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'GET' });
  if (url.pathname === '/api/health') {
    return json({ ok: !rooms.stopping, service: 'emerald-signal', protocol: 1, instanceId: rooms.instanceId }, rooms.stopping ? 503 : 200);
  }
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'ORIGIN_NOT_ALLOWED' }, 403);
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return json({ error: 'WEBSOCKET_REQUIRED' }, 426, { Upgrade: 'websocket' });
  }
  const ip = context.ip ?? 'unknown';
  if (!rooms.canConnect(ip)) return json({ error: 'SERVER_BUSY' }, 503);
  const { socket, response } = upgradeWebSocket(request, { idleTimeout: 30 });
  rooms.attach(socket, ip);
  return response;
}
