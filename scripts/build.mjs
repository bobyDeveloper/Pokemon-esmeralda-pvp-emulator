import { transform } from 'esbuild';
import { readFile, writeFile, mkdir, rm, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist');
// The only recursively removed target is the fixed, resolved build directory.
if (dirname(output) !== resolve(root) || output === resolve(root)) throw new Error('Invalid output path');
try { if ((await lstat(output)).isSymbolicLink()) throw new Error('dist must not be a symlink'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await rm(output, { recursive: true, force: true });
const js = ['main', 'controls', 'emulator', 'storage', 'multiplayer', 'link', 'immersive', 'admin'].map(name => `js/${name}.js`);
const files = ['index.html', 'style.css', ...js, ...['em.js', 'em.wasm', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'].map(name => `core/${name}`)];
const sizes = {};
for (const name of files) {
  const source = await readFile(resolve(root, 'public', name));
  let result = source;
  if (js.includes(name) || name === 'style.css') {
    const transformed = await transform(source.toString('utf8'), {
      loader: name.endsWith('.css') ? 'css' : 'js', minify: true,
      ...(name.endsWith('.js') ? { format: 'esm' } : {}),
      target: ['chrome110', 'safari16.4', 'firefox110'], charset: 'utf8', legalComments: 'inline',
    });
    if (transformed.warnings.length) throw new Error(JSON.stringify(transformed.warnings));
    result = Buffer.from(transformed.code);
  } else if (name === 'index.html') {
    // Preserve whitespace/text semantics; only trim indentation, no HTML parser
    // tricks, SVG rewriting, inline JS/CSS or removal of accessible content.
    result = Buffer.from(source.toString('utf8').replaceAll('\r\n', '\n').replace(/^[ \t]+/gm, '').replace(/\n{2,}/g, '\n'));
  }
  const target = resolve(output, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, result);
  sizes[name] = { source: source.length, raw: result.length, gzip: gzipSync(result).length, brotli: brotliCompressSync(result).length };
}
const totals = Object.values(sizes).reduce((all, row) => {
  for (const key of ['source', 'raw', 'gzip', 'brotli']) all[key] += row[key];
  return all;
}, { source: 0, raw: 0, gzip: 0, brotli: 0 });
await mkdir(resolve(root, 'artifacts'), { recursive: true });
await writeFile(resolve(root, 'artifacts/build-sizes.json'), JSON.stringify({ files: sizes, totals }, null, 2));
console.log(`dist: ${files.length} files · ${totals.source} → ${totals.raw} B · gzip ${totals.gzip} B · Brotli ${totals.brotli} B (estimated compression)`);
