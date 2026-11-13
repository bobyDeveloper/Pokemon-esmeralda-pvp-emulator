# Dingbat — artefactos web oficiales

Autor: Matthew Beck. Licencia: MIT. Se conservan `LICENSE` y
`THIRD_PARTY_NOTICES.md` del mismo commit que identifica la versión publicada.

- Repositorio: https://github.com/mattrbeck/dingbat
- Revisión publicada: `91709f8`
- Commit completo: `91709f81223ee6a8be61e251466a7d748141d458`
- Fuente de los binarios: https://dingbat.gg/em.js y https://dingbat.gg/em.wasm
- Manifiesto oficial consultado: https://dingbat.gg/asset-manifest.json
- Build ID publicado: `a6e20365772b723a 91709f8`
- Estado: artefactos precompilados oficiales, reutilizados sin modificar.
  No se compiló Nim localmente ni se instalaron compiladores.

| Archivo | Bytes | SHA-256 verificado |
| --- | ---: | --- |
| em.js | 81687 | d53bf029c62b57309ef5caa202953f74af7590d5713a2834811e8d14652726da |
| em.wasm | 960784 | 1525942f460c63707bc2f6565007bbb131b94ef4895a1fc2d6b936e555b43268 |

Los dos archivos se sirven desde el propio sitio. No se consulta Dingbat ni
GitHub durante la ejecución. El frontend original, su service worker,
sincronización, señalización, ROM de demostración y núcleo DS no se distribuyen.

`em.js` es un script clásico de Emscripten: define `Module` y `FS` globalmente.
`public/js/emulator.js` encapsula su uso desde la aplicación ES Modules.
El motor usa su BIOS HLE incorporada; no se incluye una BIOS propietaria.

Para reconstruir una versión, seguir `docs/building.md` y
`.github/workflows/deploy-pages.yml` de la revisión fijada. La ruta web requiere
Nim, Emscripten y zippy; no necesita SDL, Docker, Azure ni Cloudflare. Cualquier
instalación de compiladores requiere autorización previa. No es un paso de
desarrollo normal ni de despliegue en Netlify.
