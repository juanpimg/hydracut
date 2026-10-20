# HydraCut Studio — PRODUCT.md

> Verdad de producto. Derivada del código y del comportamiento real del producto
> (auditoría 2026-10-19/20). Este documento **no** describe la interfaz: describe
> **qué es el producto, para quién, y qué debe ser verdad**. La verdad visual vive
> en `DESIGN.md`.

## Qué es

Un **editor de vídeo multitrack que funciona entero en el navegador**. Sin servidor, sin
cuentas, sin subidas, sin instalación: el vídeo no sale nunca del dispositivo del usuario.
Todo el pipeline (decodificación, composición, codificación, muxing) ocurre en el cliente
con WebCodecs, Web Audio y Canvas 2D.

## Para quién

- **Editor casual y móvil primero.** El caso de uso principal es alguien con un móvil que
  quiere cortar, ordenar y exportar un clip corto sin instalar nada. Por eso la experiencia
  táctil es una superficie de **primer nivel**, no una adaptación.
- **Poder Professional, nooberd de uso.** Someone que ya sabe editar quiere atajos, selección
  múltiple, keyframes, fundidos, paneo/EQ y un export que no bloquee. Por eso la densidad y
  la velocidad importan tanto como la belleza.
- **Privacidad como argumento de venta.** "100 % privado en tu navegador" no es un detalle
  de marketing: es una razón para elegirlo. La interfaz debe **demostrarlo**, no
  prometerlo.

## Los cuatro pilares (y qué significa cada uno en pantalla)

1. **Que funcione en el sitio.** El usuario debe poder abrir la URL y exportar un vídeo sin
   pedirle nada a nadie. Cualquier fricción de arranque es una fuga.
2. **Honestidad radical.** Si el export va por el respaldo en tiempo real, se dice. Si el
   formato pedido no es posible, se dice. Si algo se ha degradado, se dice. **La interfaz
   no promete capacidades que el motor no tiene.**
3. **El contenido es el héroe.** El vídeo del usuario manda. Todo lo demás se aparta.
4. **Sin establo ni adorno.** Un editor es una herramienta: se usa durante horas. El
   objetivo es que desaparezca y solo se vea el trabajo.

## La superficie (modo *Operate*)

El visitante **completa una tarea**: editar y exportar un vídeo. Por tanto:

- Escaneabilidad, consistencia y expectativa nativa por encima de la expresión.
- La identidad vive en los detalles precisos, no en la decoración.
- Cero "efecto" en la superficie de trabajo: el movimiento es ruido en un editor.

## Restricciones técnicas que la UI debe respetar

- **Rendimiento:** 60 FPS en el compositor. Nada en la UI puede provocar re-renders
  por frame ni bloquear el hilo principal.
- **Táctil:** objetivos ≥ 44 px, sin依赖 de hover, una columna de pulgar.
- **Teclado:** todo lo accionable con teclado, con foco visible y，短cuts documentados.
- **Responsive:** 320 px a 2560 px, retrato y apaisado, sin scroll horizontal.
- **A11y:** contraste ≥ 4.5:1 en texto, roles semánticos, `aria-live` en el progreso.
- **Español:** la superficie está en español. Solo el nombre de la marca va en inglés.

## Lo que el producto **no** es

- No es una suite de efectos: no hay transiciones de plantilla, ni chroma key, ni motion
  graphics. Es un editor de corte y montaje con las herramientas que un editor necesita
  de verdad.
- No es un producto de consumo con uphill: no hay gamificación, ni "insignias", ni
 渐 gradients decorativos, ni onboarding que se interponga más de una vez.
- No es un dashboard: los datos no son el producto, el vídeo lo es. Nada de tarjetas de
  métricas, ni rejillas de tarjetas con icono+título+texto.

## Superficies y su modo

| Superficie | Modo | Nota |
|---|---|---|
| Editor (escritorio) | Operate | Capas: app bar · rail · panel · visor · inspector · línea de tiempo |
| Editor (móvil) | Operate | Misma verdad, distinto chasis: visor arriba, línea de tiempo, hoja inferior |
| Galería de proyectos | Operate | Un proyecto = una fila, no una tarjeta con gradiente |
| Diálogos (export, ajustes, bienvenida) | Operate | Cortos, sin scroll, con una acción clara |

## Definición de "hecho" para una tarea de UI

- Se ve correcta en 320 px, 390 px, 768 px, 1440 px y en apaisado.
- Se ve correcta con contenido real (clips largos, nombres largos, sin contenido).
- Es operable con teclado, con dedo y con ratón.
- No introduce una regresión de rendimiento ni de los 155 checks de navegador.
- Las capturas de antes/después se comparan, no se describen.
