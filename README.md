# Emerald PVP · Fase 3A

Emulación GBA real con Dingbat WebAssembly, JavaScript vanilla y ES Modules. Se conserva la consola aprobada: Advance SP en vertical, Advance clásica en horizontal, un Canvas de 240 × 160 y el mismo sistema multitouch/teclado. Las salas de dos personas ya disponen de señalización WebSocket en Netlify Server. El juego sigue siendo individual: no hay WebRTC, cable Link ni sincronización del emulador.

## Iniciar

Node.js 24 existente y npm. Instalar las dependencias del proyecto con `npm ci`; no hay compilación frontend ni de Nim. No se instalan herramientas globales.

```sh
npm ci
npx netlify dev
```

Abrir **http://localhost:8888** para frontend y servidor de salas juntos. `npm run dev:online` es equivalente. Para pruebas sin acceso a Netlify, `npx netlify dev --offline --no-open` funciona sin login. El servidor estático original sigue disponible con `npm run dev` en **http://127.0.0.1:5173**, pero ese comando por sí solo no proporciona `/api/health` ni `/api/signal`. No ejecutar ambos modos simultáneamente: Netlify Dev inicia el mismo servidor estático en el puerto 5173.

La instalación existente encontrada en este equipo es `E:\tools\node-v24.22.3-win-x64` (Node 24.22.3, npm 11.19.1). Si esta terminal no la encuentra en PATH, añadirla solo al proceso actual:

```powershell
$env:Path = 'E:\tools\node-v24.22.3-win-x64;' + $env:Path
npx.cmd netlify dev
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
- ROMs y partidas no se suben a ningún servidor. La aplicación solicita sus propios recursos estáticos y, al usar las salas, abre un WebSocket de señalización en el mismo sitio. No envía ROMs, guardados ni controles del emulador al servidor. No se incluye la sincronización de Dingbat ni su service worker.

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
| `public/js/multiplayer.js` | API WebSocket, estado de sala, peticiones y reconexión limitada |
| `netlify/server/index.mjs` | Handler de Netlify Server, health, origen y upgrade WebSocket |
| `netlify/server/rooms.mjs` | Salas efímeras, roles, validación, cuotas y limpieza |
| `public/core/` | Dos artefactos oficiales y sus avisos/procedencia |
| `scripts/dev.mjs` | Servidor estático local sin dependencias; MIME WASM y CSP |
| `tests/` | Pruebas nativas de Node y generador de una ROM diagnóstica propia, sin contenido propietario |
| `references/` | Referencias originales `.jpg`, fuera del sitio publicado |

`controls.js` emite `emerald:input` con `{ button, pressed, pressedButtons }`. `main.js` conecta esos eventos al adaptador. Ningún archivo del motor instala otros listeners de teclado o táctil. `main.js` exporta `canvas`, `consoleElement`, `controls`, `standby`, `emulator` y `multiplayer` como punto de inspección e integración. El script clásico oficial requiere los globales `Module` y `FS`; su uso se limita al adaptador. La aplicación mantiene ES Modules.

## Verificación

```sh
npm run check
npm test
```

`check` verifica la sintaxis de los módulos propios. Las pruebas de `npm test` verifican los hashes oficiales, la compilación del WASM, MIME/CSP, configuración estática de Netlify, aislamiento de `public/`, rechazo de cargas HTTP, Canvas único y cabecera de la ROM diagnóstica, roles, aislamiento, permisos, limpieza, límites y apagado del administrador de salas. El hash de `em.js` se verifica con LF canónico: Git puede convertir su salto final a CRLF en Windows; no se reescribe el motor.

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

Validación en Safari/iOS y Android físicos, escucha de audio en hardware real y prueba completa con una ROM de Pokémon Esmeralda suministrada por el usuario. También queda por verificar en juego real la memoria FLASH/RTC de su guardado de 128 KiB. No se han implementado WebRTC, cable Link, partidas PvP, estados instantáneos, sincronización ni biblioteca de ROMs. El backend se limita a salud y señalización de salas; no realiza emulación.

## Salas · fase 3A

Acceso: **··· → Salas**. Crear una sala genera un código de 10 caracteres para compartir. Otra persona puede introducirlo para entrar como invitado; una tercera conexión se rechaza. El host puede cerrar la sala. Abandonar o desconectarse como host la cierra para ambos; si sale el invitado, el host conserva su sala y puede recibir otro invitado.

La interfaz muestra host/invitado y 1/2 o 2/2 personas conectadas. Esto confirma la pertenencia a la sala, no una partida multijugador. El motor, las entradas y la ROM siguen aislados de la red.

### API y protocolo

- `GET /api/health`: `{ ok, service, protocol, instanceId }`, sin caché.
- `GET /api/signal`: requiere upgrade WebSocket; sin upgrade devuelve HTTP 426. Otros métodos devuelven 405 y rutas API desconocidas 404.
- Se rechazan orígenes de navegador ajenos al sitio. Los clientes nativos sin `Origin` también pueden conectarse. El código funciona como invitación temporal, sin cuentas ni autenticación persistente.
- Al conectarse: `{ type: "welcome", protocol: 1, instanceId }`.
- Peticiones JSON: `{ type, requestId, ...campos }`. `requestId` contiene de 1 a 64 caracteres alfanuméricos, `_` o `-`.

| Petición | Campos adicionales | Resultado |
| --- | --- | --- |
| `create` | Ninguno | Evento `room`: código, rol `host`, participantes |
| `join` | `code` | Evento `room` como `guest`; actualiza al host |
| `leave` | Ninguno | `left`; el host que sale cierra la sala |
| `close` | Ninguno | `room-closed`; solo para host |
| `signal` | `data`: objeto JSON | Se entrega solo al otro miembro de la sala; emisor recibe `ok` |

Errores: `{ type: "error", requestId, code, message }`. Entre otros: `INVALID_MESSAGE`, `INVALID_CODE`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `ALREADY_IN_ROOM`, `FORBIDDEN`, `PEER_UNAVAILABLE` y `RATE_LIMIT`. Ningún cliente puede elegir el destinatario de una señal ni enviar un rol para atribuírselo.

```js
import { Multiplayer } from './js/multiplayer.js';
const rooms = new Multiplayer(); // /api/signal del mismo origen
rooms.addEventListener('statechange', event => console.log(event.detail));
rooms.addEventListener('signal', event => console.log(event.detail));
await rooms.createRoom();
// En otro cliente: await rooms.joinRoom(codigo);
// API disponible: sendSignal(objeto), leaveRoom(), closeRoom(), disconnect().
```

La aplicación no envía señales de juego ni crea conexiones WebRTC. `signal` es únicamente un canal JSON entre los dos miembros, disponible para una fase posterior.

### Límites y reinicios

Códigos criptográficos de 50 bits, alfabeto de 32 símbolos sin I/O, una sala por conexión y dos conexiones por sala. Límites de aplicación por instancia:

- Hasta 200 conexiones, 8 por IP y 100 salas.
- Solo mensajes de texto JSON, hasta 16 KiB UTF-8. Los binarios se cierran con 1003; exceso de tamaño, con 1009.
- Ráfaga de 20 mensajes por conexión, recarga de 10 por segundo. El exceso cierra con 1008.
- Crear/unirse: ráfaga de 10 intentos por IP y recarga de 0,5 por segundo. La cuota se conserva temporalmente al reconectar.
- Profundidad JSON máxima 8, hasta 512 valores por señal y cola de salida máxima 64 KiB. Se eliminan conexiones lentas.
- Los contadores IP están acotados y se eliminan al quedar inactivos; el administrador limpia inmediatamente miembros y salas al cerrar/error/desconectar.
- `idleTimeout: 30` activa el ping/pong del SDK para detectar conexiones perdidas.

El hook `onShutdown` avisa con `server-restarting`, vacía las salas y cierra con 1012. El cliente también gestiona caídas abruptas: descarta su sala y las peticiones pendientes y reintenta conexión hasta cinco veces con espera creciente. No reproduce `create`/`join` ni promete recuperar una sala perdida. Al conectarse de nuevo, el usuario crea otra sala o introduce un nuevo código.

`[server.scale] max = 1` evita repartir normalmente las salas entre instancias independientes. **No hay persistencia ni coordinación entre instancias**: un reinicio, despliegue o reemplazo pierde las salas. Incluso con ese máximo, Netlify puede solapar instancias durante reemplazos o despliegues; una invitación de la instancia anterior puede devolver `ROOM_NOT_FOUND`. No se ha añadido una base de datos para ocultar esta limitación.

### Pruebas de la fase 3A

```sh
npm run check
npm test
# En una terminal:
npx netlify dev --offline --no-open
# En otra:
npm run test:online
```

`npm test` ejecuta 15 pruebas con `node:test`. `test:online` requiere Netlify Dev activo en localhost:8888, usa WebSockets nativos reales y permite otro origen mediante `SIGNAL_TEST_URL`. Respeta el limitador de intentos del servidor incluso entre casos de prueba.

Se verificaron: health/upgrade, dos clientes, crear/unirse, tercer cliente rechazado, señales aisladas, códigos inválidos, permisos, salida, cierre, desconexión, reconexión sin resucitar salas, mensajes binarios/grandes, ráfagas y cancelación de conexión. Los tests unitarios cubren además JSON malformado/profundo, cuotas por IP, receptores lentos y el hook de apagado.

En Chrome headless se usó la UI real para crear como host y unirse como invitado, se probaron vertical/horizontal y se mantuvo emulación individual real con la ROM diagnóstica propia. También se provocó una recarga real del servidor: cambió `instanceId`, el navegador descartó su sala y se reconectó sin reiniciar el Canvas ni el motor. Sin errores de JavaScript ni CSP. Evidencia local: `artifacts/phase3-browser-results.json` y capturas `phase3-*.png`.

En Windows, Netlify CLI puede detener el proceso sin ejecutar `SIGTERM`; por eso el apagado elegante se comprueba con `node:test`, y la recuperación abrupta se verificó además con un reinicio real. No se afirma haber probado el hook en producción.

### Dependencias y despliegue

- Runtime: `@netlify/server@0.1.6`, para el upgrade WebSocket y lifecycle oficiales. Su dependencia interna `ws` pertenece al SDK; la aplicación no incorpora otro servidor WebSocket ni usa Express o Socket.IO.
- Desarrollo: `netlify-cli@27.19.0`, instalado localmente. `npm ci` reproduce `package-lock.json`.
- No se reinstaló Node ni se instalaron herramientas globales. Las verificaciones usaron un perfil de CLI aislado en `artifacts/netlify-profile` mediante variables de entorno del proceso, sin cambiar configuración del usuario.
- `npm audit --omit=dev`: 0 vulnerabilidades. La CLI trae 15 avisos transitivos de desarrollo (2 bajos, 13 moderados). El remedio propuesto por npm para varios implica degradar a una CLI antigua incompatible con Netlify Server; no se aplicó `audit fix --force` ni overrides sin verificar.

Netlify sirve `public/` y enruta `/api/*` al handler de `netlify/server/index.mjs`. El frontend estático conserva su servidor de desarrollo. Se declara Node 24 y una sola instancia desde `netlify.toml`; CSP permite el WebSocket seguro y el endpoint local. No se necesita un backend externo ni compilar el motor en producción.

APIs contrastadas con la documentación oficial: [Netlify Server](https://docs.netlify.com/build/server/), [API y upgradeWebSocket](https://docs.netlify.com/build/server/api/), [configuración](https://docs.netlify.com/build/server/configuration/), [desarrollo local](https://docs.netlify.com/build/server/local-development/) y [lifecycle](https://docs.netlify.com/build/server/lifecycle/).

Pendiente: publicar esta rama por el flujo habitual del usuario y verificar `/api/health` y dos navegadores en producción. Netlify Server está en Early Access y requiere un plan compatible; que el frontend estático ya esté publicado no confirma por sí solo esa disponibilidad. No se hizo deploy, commit ni push. No se avanzó a WebRTC ni al cable Link.
