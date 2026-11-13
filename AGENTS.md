# Emerald PVP

- Fase actual: interfaz y arquitectura base. No integrar emulación, ROMs, BIOS, red ni backend sin una solicitud nueva.
- HTML semántico en `public/index.html`; estilos en `public/style.css`; ES Modules vanilla en `public/js/`. Sin frameworks, bundler ni dependencias de producción.
- `main.js` inicializa la interfaz y ofrece el punto de integración del motor. `controls.js` concentra teclado, Pointer Events, multitouch, estados visuales y eventos `emerald:input`.
- Mantener exactamente un Canvas de 240 × 160. No crear su contexto hasta integrar el motor. No reemplazar nodos ni reconstruir el DOM al girar; el layout depende de la media query de orientación.
- Las referencias visuales son `references/portrait.jpg` y `references/landscape.jpg`. Recrear carcasa y controles mediante CSS/SVG; no servir las referencias como fondos.
- Mantener el estado por fuente de entrada para no soltar un botón que otra tecla o dedo sigue pulsando. Liberar entradas al perder foco, cambiar orientación o cancelar un puntero.
- Respetar safe areas, relación 3:2 de la pantalla, accesibilidad, movimiento reducido y ausencia de scroll en juego.
- Favorecer funciones pequeñas y responsabilidades concretas. Crear archivos nuevos solo por necesidad técnica. No añadir abstracciones para fases futuras.
- `npm run dev` sirve exclusivamente `public/` con módulos nativos de Node. `npm run check` verifica sintaxis. Validar también ambas orientaciones y combinaciones de entrada en navegador al modificar controles o layout.
- Netlify publica `public/` sin paso de build. No publicar ni modificar infraestructura externa sin que forme parte de la solicitud.
