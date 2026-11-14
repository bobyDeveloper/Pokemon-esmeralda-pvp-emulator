import { randomBytes } from 'node:crypto';
import { hashPassword } from '../netlify/server/password.mjs';

function hidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) { reject(new Error('Ejecuta este comando en una terminal interactiva.')); return; }
    process.stdout.write(prompt);
    let text = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    function finish(error) {
      process.stdin.off('data', input); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
      if (error) reject(error); else resolve(text);
    }
    function input(chunk) {
      for (const char of chunk) {
        if (char === '\u0003' || char === '\u0004') { finish(new Error('Cancelado.')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') text = [...text].slice(0, -1).join('');
        else if (char >= ' ' && Buffer.byteLength(text) < 1024) text += char;
      }
    }
    process.stdin.on('data', input);
  });
}
try {
  let password = await hidden('Contraseña (mínimo 16 bytes, no se mostrará): ');
  let confirmation = await hidden('Repite la contraseña: ');
  if (password !== confirmation) throw new Error('Las contraseñas no coinciden.');
  const hash = await hashPassword(password);
  password = confirmation = null;
  console.log('Copia estos valores únicamente a variables privadas de Netlify (scope Functions):');
  console.log(`EMERALD_ADMIN_PASSWORD_HASH: ${hash}`);
  console.log(`EMERALD_SESSION_SECRET: ${randomBytes(48).toString('base64url')}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
