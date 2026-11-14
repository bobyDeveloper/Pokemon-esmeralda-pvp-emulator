import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const options = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
export function parsePasswordHash(value) {
  if (typeof value !== 'string') return null;
  const match = /^scrypt\$65536\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return null;
  const salt = Buffer.from(match[1], 'base64url'), key = Buffer.from(match[2], 'base64url');
  return salt.length === 16 && key.length === 32 ? { salt, key } : null;
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || Buffer.byteLength(password) < 16 || Buffer.byteLength(password) > 1024) {
    throw new Error('Usa entre 16 y 1024 bytes de contraseña.');
  }
  const salt = randomBytes(16);
  const key = await derive(password, salt, 32, options);
  return `scrypt$65536$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function verifyPassword(password, parsed) {
  const key = await derive(password, parsed.salt, 32, options);
  return timingSafeEqual(key, parsed.key);
}
