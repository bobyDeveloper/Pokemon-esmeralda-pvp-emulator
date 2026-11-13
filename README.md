# Emerald PVP · Fase 1

Una interfaz de consola inspirada en las referencias incluidas: Game Boy Advance SP abierta en vertical y Game Boy Advance clásica en horizontal. Carcasa índigo, controles blancos, bisagra, LED, altavoz y una pantalla única de 240 × 160.

## Desarrollo local

Requiere Node.js 22 o posterior (incluye npm). No hay dependencias que instalar.

```sh
npm run dev
```

Abrir **http://127.0.0.1:5173**. El servidor sirve solo `public/`, sin compilación. Recargar el navegador después de editar. `PORT` cambia el puerto y `HOST=0.0.0.0` permite probar desde un teléfono en la misma red (usar la IP local del equipo y permitir el acceso en el firewall).

```sh
npm run check
```

Comprueba la sintaxis de todos los módulos JavaScript. Para la validación visual, probar al menos 390 × 844, 844 × 390, 768 × 1024 y 1440 × 900; verificar safe areas y multitouch también en dispositivos físicos.

## Controles

| Control | Teclado |
| --- | --- |
| Cruceta | Flechas o WASD |
| A / B | X / Z o K / J |
| L / R | Q / E |
| Start | Intro |
| Select | Mayúsculas o Retroceso |

Los botones también admiten ratón, lápiz, táctil, navegación con Tab y activación con Espacio. Es posible deslizar entre direcciones de la cruceta, mantener varios dedos y combinar táctil con teclado. Cada fuente se registra por separado. Las entradas se liberan al cancelar un puntero, perder foco, ocultar la pestaña, abrir la guía o cambiar de orientación.

## Archivos y responsabilidades

- `public/index.html`: documento accesible, una consola, un Canvas y controles compartidos; SVG decorativo propio.
- `public/style.css`: materiales, volumen, layouts por orientación, safe areas y estados de presión.
- `public/js/controls.js`: fuentes de entrada, estado agregado y eventos de botones.
- `public/js/main.js`: inicialización, identificación de modelo, guía y punto de integración.
- `scripts/dev.mjs`: servidor estático local sin dependencias; no es un backend de juego.
- `references/`: imágenes de referencia originales `.jpg` (no `.jpeg`), fuera del contenido publicado.
- `netlify.toml`: publicación de `public/` y cabeceras para esta fase.

## Contrato para el futuro motor

Motor previsto: [Dingbat](https://github.com/mattrbeck/dingbat). **No está descargado, instalado, compilado ni conectado.** No se distribuyen juegos, ROMs ni BIOS. El estado de espera es HTML/SVG propio; no es una simulación del juego.

`main.js` exporta `canvas`, `consoleElement`, `controls` y `standby`. El Canvas conserva sus atributos `width="240" height="160"` y su relación 3:2 en ambos layouts. No se llama a `getContext()` para permitir que el motor elija su backend gráfico. Cuando exista salida real del motor, se podrá ocultar la capa de espera con `standby.hidden = true`.

El elemento de consola emite un `CustomEvent` con burbujeo por cada cambio efectivo:

```js
consoleElement.addEventListener('emerald:input', ({ detail }) => {
  // detail.button: UP | RIGHT | DOWN | LEFT | A | B | L | R | START | SELECT
  // detail.pressed: boolean
  // detail.pressedButtons: copia del conjunto actual de botones pulsados
});
```

`controls.getPressedButtons()` devuelve una copia del estado; `controls.releaseAll()` libera las entradas; `controls.destroy()` libera y elimina sus listeners. Este contrato pertenece a la interfaz; el adaptador a la API concreta de Dingbat queda pendiente. Al integrarlo se revisarán las cabeceras CSP y los requisitos reales del motor.

## Netlify

Vincular este repositorio con Netlify: directorio publicado `public`, sin comando de build. `netlify.toml` ya contiene la configuración. Esta fase prepara el despliegue; no crea sitios ni publica automáticamente.

## Límites de esta fase

Sin emulación, carga de juegos, audio, guardado, partidas, matchmaking ni servicios de red. El LED indica que la interfaz está disponible. Los controles actualizan su apariencia y emiten eventos, pero todavía no ejecutan un juego. Las referencias se recrean con CSS/SVG y no se utilizan como imágenes de fondo.
