# Emerald PVP · Fase 2

Emulación GBA real con Dingbat WebAssembly, JavaScript vanilla y ES Modules. Se conserva la consola aprobada: Advance SP en vertical, Advance clásica en horizontal, un Canvas de 240 × 160 y el mismo sistema multitouch/teclado. No hay backend, multijugador ni frameworks.

## Iniciar

Node.js 22 o posterior y npm. No hay paquetes npm que instalar ni paso de compilación.

```sh
npm run dev
```

Abrir **http://127.0.0.1:5173**. `PORT` cambia el puerto. Recargar después de editar.

La instalación existente encontrada en este equipo es `E:\tools\node-v24.22.3-win-x64` (Node 24.22.3, npm 11.19.1). Si esta terminal no la encuentra en PATH, añadirla solo al proceso actual:

```powershell
$env:Path = 'E:\tools\node-v24.22.3-win-x64;' + $env:Path
npm.cmd run dev
```

No se descargó ni reinstaló Node y no se modificó la configuración global. La API SHA-256 exige HTTPS o localhost; un teléfono que acceda por una IP HTTP de la LAN necesitará servir el sitio mediante HTTPS. Netlify ofrece el contexto HTTPS requerido. No abrir `index.html` directamente como `file://`.

## Usar la consola

1. Pulsar **Cargar ROM** en la barra superior y elegir una ROM local `.gba` válida, de hasta 32 MiB. No se distribuyen juegos ni BIOS propietarios.
2. Jugar con los botones táctiles o el teclado. El audio se activa mediante interacción del usuario.
3. Abrir **···** para pausar/reanudar, reiniciar, importar/exportar `.sav` o silenciar el audio. Reiniciar conserva la memoria de guardado del cartucho; no es un borrado de partida.
4. Guardar desde el menú del propio juego. La memoria de batería se persiste en IndexedDB cada dos segundos cuando cambia, y también al pausar, cambiar de ROM, reiniciar y ocultar la página.
5. Tras recargar, seleccionar la misma ROM: su SHA-256 recupera su partida incluso si el archivo tiene otro nombre. La ROM se conserva solo en memoria, no en IndexedDB.

| Control | Teclado |
| --- | --- |
| Cruceta | Flechas o WASD |
| A / B | X / Z o K / J |
| L / R | Q / E |
| Start | Intro |
| Select | Mayúsculas o Retroceso |

Se pueden combinar teclas y dedos, mantener varios botones y deslizar la cruceta. Tab y Espacio permiten activar los controles. Las entradas se liberan al cancelar un puntero, perder foco, ocultar la pestaña, abrir un diálogo o cambiar de orientación. El emulador se pausa al perder foco; se reanuda desde ···. Girar la pantalla conserva el motor, la memoria y el Canvas y no pausa ni reinicia la partida.

## Partidas locales

- Formato: memoria de batería `.sav`; no son estados instantáneos del emulador.
- Tamaños admitidos: 512 B, 8, 32, 64 y 128 KiB, con un registro RTC opcional de 16 B. Se rechazan tamaños incompatibles con una partida ya generada por el juego.
- La importación reinicia el núcleo para cargar la partida. Si el juego estaba pausado, permanece pausado. Un `.sav` no contiene necesariamente la identidad del juego: elegir una copia correspondiente a la ROM cargada.
- Cada partida se identifica por SHA-256 de la ROM. Sus bytes se copian y se almacenan con un segundo SHA-256. La escritura solo se considera completada cuando termina la transacción IndexedDB.
- Si la verificación de integridad falla, se conserva el registro existente, se bloquea el autoguardado y se carga la ROM en pausa. Importar una copia válida repara el registro de manera explícita. No se sobrescribe automáticamente con una partida nueva.
- Si IndexedDB no está disponible, se puede jugar y exportar manualmente; la interfaz avisa que el guardado automático no está disponible. Un fallo de escritura se informa y el autoguardado vuelve a intentarse.
- ROMs y partidas no se suben a ningún servidor. Los únicos recursos que solicita la aplicación son sus propios archivos estáticos. No se incluye la sincronización de Dingbat ni su service worker.

Exportar copias antes de borrar los datos del navegador. La navegación privada, la cuota del dispositivo y el cierre forzado pueden afectar a IndexedDB; cerrar inmediatamente después de guardar puede impedir que se complete la última transacción. El guardado automático conserva memoria de batería, no el punto exacto de ejecución.

## Auditoría y procedencia del motor

Motor: [Dingbat](https://github.com/mattrbeck/dingbat), Matthew Beck, licencia MIT.

- Commit fijado: **`91709f81223ee6a8be61e251466a7d748141d458`**.
- Versión web publicada: `91709f8`; build ID: `a6e20365772b723a 91709f8`.
- Se reutilizaron sin modificar `em.js` y `em.wasm` publicados en el sitio oficial, verificados contra su [manifiesto de hashes](https://dingbat.gg/asset-manifest.json).
- Compilación local: **no necesaria**. No se instalaron Nim, Emscripten ni otras herramientas. La documentación oficial indica `nimble wasm`, que necesita Nim, Emscripten y zippy. No necesita SDL para la web.
- Atribuciones, tamaños y hashes completos: `public/core/README.md`, `LICENSE` y `THIRD_PARTY_NOTICES.md`.

La API se comprobó en el código de esa revisión: `initFromEmscripten` inicia el núcleo desde MEMFS, `loop_tick` avanza un frame, `setInput` recibe los ordinales de `common/input.nim`, `wasm_fb_ptr` entrega RGBA y `getAudioBufferPtr/Len` entregan PCM estéreo float32 a 32768 Hz. `wasm_flush_save` actualiza `rom.sav` antes de leerlo. El motor usa su BIOS HLE incorporada.

## Arquitectura

| Archivo | Responsabilidad |
| --- | --- |
| `public/index.html` | Una consola compartida, un Canvas, diálogos y selectores de archivos locales |
| `public/style.css` | Estilos aprobados de las carcasas y estilos adicionales de las acciones de fase 2 |
| `public/js/main.js` | Coordinación de interfaz, archivos, eventos y ciclo de vida de la página |
| `public/js/controls.js` | Única fuente de entradas: teclado, Pointer Events, multitouch y accesibilidad |
| `public/js/emulator.js` | Adaptador real: carga del núcleo, MEMFS, frames, Canvas, Web Audio y batería |
| `public/js/storage.js` | IndexedDB, SHA-256 y verificación de integridad |
| `public/core/` | Dos artefactos oficiales y sus avisos/procedencia |
| `scripts/dev.mjs` | Servidor estático local sin dependencias; MIME WASM y CSP |
| `tests/` | Pruebas nativas de Node y generador de una ROM diagnóstica propia, sin contenido propietario |
| `references/` | Referencias originales `.jpg`, fuera del sitio publicado |

`controls.js` emite `emerald:input` con `{ button, pressed, pressedButtons }`. `main.js` conecta esos eventos al adaptador. Ningún archivo del motor instala otros listeners de teclado o táctil. `main.js` exporta `canvas`, `consoleElement`, `controls`, `standby` y `emulator` como punto de inspección e integración. El script clásico oficial requiere los globales `Module` y `FS`; su uso se limita al adaptador. La aplicación mantiene ES Modules.

## Verificación

```sh
npm run check
npm test
```

`check` verifica la sintaxis de los módulos propios. Las seis pruebas de `npm test` verifican los hashes oficiales, la compilación del WASM, MIME/CSP, configuración estática de Netlify, aislamiento de `public/`, rechazo de cargas HTTP, Canvas único y cabecera de la ROM diagnóstica.

También se ejecutaron en Chrome headless, con el CSP de desarrollo activo:

- Carga real del WASM mediante el selector de ROMs.
- ROM diagnóstica propia generada por `tests/gba-probe.mjs`: vídeo, PCM no nulo programado en Web Audio y lectura de los diez botones en el registro KEYINPUT real de la GBA.
- Multitouch A+B, combinación táctil/teclado, deslizamiento de cruceta y teclado con foco en la barra de acciones.
- Diez tamaños, de 320 × 568 a 1920 × 1080, sin scroll ni desbordamiento de la barra. Se conservan el mismo núcleo, su estado y el mismo Canvas con relación 3:2 al girar.
- Pausa de CPU y audio, reanudación y reinicio conservando memoria de batería.
- Importación/exportación de un `.sav` de 32768 B idéntico byte a byte y recuperación del mismo SHA-256 tras recargar.
- Importación, exportación y persistencia idénticas byte a byte de un `.sav` FLASH de 128 KiB con un registro adicional de RTC de 16 B (131088 B en total).
- Detección de datos corruptos, protección contra autoguardado y reparación explícita mediante importación.
- Rechazo de ROM inválida y `.sav` de tamaño incompatible sin sustituir la sesión vigente.
- Ejecución de `blendprobe.gba`, homebrew del repositorio oficial con código fuente, con 14 colores distintos renderizados en ambas orientaciones. No se publica esa ROM.
- Sin errores de JavaScript, consola ni CSP en esos recorridos. Las capturas y el informe local están en `artifacts/`, ignorado por Git.

No se ejecutó Pokémon Esmeralda: no se proporcionó una ROM. Las pruebas diagnósticas no equivalen a verificar su jugabilidad completa.

## Netlify

`netlify.toml` publica **public/**, sin comando de build ni compilación de Nim en producción. Incluye `application/wasm` y CSP con `wasm-unsafe-eval`; no habilita evaluación genérica de JavaScript. Los artefactos del motor ya están incluidos. Se comprobó la configuración y su equivalente local; no se realizó un despliegue ni se hicieron commits o pushes.

## Pendiente

Validación en Safari/iOS y Android físicos, escucha de audio en hardware real y prueba completa con una ROM de Pokémon Esmeralda suministrada por el usuario. También queda por verificar en juego real la memoria FLASH/RTC de su guardado de 128 KiB. No se han implementado PvP, partidas en red, estados instantáneos, sincronización, biblioteca de ROMs ni backend.
