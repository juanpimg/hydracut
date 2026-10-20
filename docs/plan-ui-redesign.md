# PLAN — Rediseño de UI y workflow de HydraCut Studio

> Objetivo: que la interfaz deje de leerse como generada y pase a leerse como una herramienta
> profesional. Verdad de producto en `PRODUCT.md`, sistema visual en `DESIGN.md`, evidencia en
> `07-ux-research.md`.
> **Toda decisión visual se toma contra `DESIGN.md`, no contra el gusto del implementador.**

## Diagnóstico (por qué sigue viéndose IA)

Capturas reales del 2026-10-21 (`/tmp/opencode/shots/`) + medición del código:

| # | Problema | Evidencia |
|---|---|---|
| 1 | **Dos acentos compitiendo** (cyan 237 usos / blue 136) | grep de clases |
| 2 | **Token muerto**: `accent` definido en el config, **0 usos** | `tailwind.config.js` |
| 3 | **6 colores de acento** en la UI (cyan, blue, purple, emerald, rose, amber×104) | grep |
| 4 | Gradientes, `backdrop-blur`, sombras de color | 13 / 13 / 63 |
| 5 | **Radio inconsistente**: 16 `rounded-full`, 30 `rounded-xl`, 4 `rounded-2xl` | grep |
| 6 | **Inspector en una pestaña del rail izquierdo** — ningún editor profesional lo hace | captura 04 |
| 7 | **3 formas de añadir un medio** (+ sobre la miniatura, botón "Añadir", clic en la tarjeta) | captura 03 |
| 8 | **"Cuchilla" y "Dividir (S)"** = la misma función, duplicadas | captura 04 |
| 9 | Nombres truncados a **1 carácter** ("I.", "B", "A"), "T1 Te...", "Vid..." | capturas 03/08 |
| 10 | **Tarjetas grandes para lo que son opciones de radio** (4 preajustes de export en rejilla 2×2) | captura 06 |
| 11 | 6 grupos de control para 4 números (preajustes + resolución + fps + bitrate + rango) | captura 06 |
| 12 | **Modal de export de 900 px** que hace scroll | captura 06 |
| 13 | Voz de marketing dentro del producto ("100 % acelerado en el cliente (GPU nativa)") | capturas 02/06 |
| 14 | En móvil, el **transporte se come el 33 % de la altura** | captura 08 |
| 15 | Iconos de la barra móvil con **4 colores distintos** | captura 08 |
| 16 | "Seleccionar todo" **huérfano y solapando** las pistas | capturas 04/08 |
| 17 | Toast **encima** del contenido | captura 08 |
| 18 | Controles sin etiqueta ambigua (deshacer/rehacer, 3 iconos del header) | capturas 04/08 |

## Principios (de `07-ux-research.md`, convergencia de 7 editores)

1. Monitor centro · bin izquierda · **inspector derecha** · línea de tiempo abajo ~40 %.
2. Grises neutros, nunca negro puro. 3. **Un** acento, ≤ 5 % de píxeles, con un único significado.
4. Densidad = producto (28/32/36 px). 5. Icono solo para lo momentáneo, etiqueta para modos y
acciones destructivas. 6. El inspector es un **formulario**, no una galería. 7. Móvil = bandas
apiladas + tira inferior contextual, nunca paneles laterales. 8. Movimiento ≈ 0. 9. Los estados
vacíos son superficies diseñadas: un titular + una acción.

## Oleadas

| Ola | Alcance | Ficheros | Depende |
|---|---|---|---|
| **U0** | **Fundamento**: tokens + familia de primitivas | `tailwind.config.js`, `src/index.css`, NUEVO `src/components/ui/**` | — |
| **U1** | **Chasis de escritorio**: app bar 40 px, rail 48, bin 264, visor, **inspector a la derecha** 300, timeline abajo | `layout/*`, NUEVO `components/inspector/InspectorPanel.tsx` | U0 |
| **U2** | **Línea de tiempo**: toolbar 36, cabeceras 56, clips con filmstrip/waveform, cabezal 1 px, "seleccionar todo" recolocado, "Cuchilla" eliminada | `timeline/*` | U0, U1 |
| **U3** | **Bin y tarjetas**: miniatura 16:9, nombre 2 líneas, **una** acción de añadir, borrar en menú, panel de almacenamiento compacto | `media/*` | U0 |
| **U4** | **Visor y transporte**: jerarquía del monitor, transporte compacto, sin glow | `player/*` | U0, U1 |
| **U5** | **Móvil**: 3 bandas, tira contextual a la selección, 44 px, sin paneles laterales | `mobile/*` | U0, U1 |
| **U6** | **Diálogos + copy**: export compacto sin scroll, proyectos, bienvenida, atajos; copy de herramienta | `modals/*`, `export/ExportModal.tsx` | U0 |
| **U7** | **Barrido final**: 0 gradientes, 0 blur, radios unificados, copy honesto, capturas | transversal | U1–U6 |

## Verificación (entre oleadas, y al final)

1. `npm test` (946), `npx tsc --noEmit`, `npx eslint .` → 0 errores.
2. `npm run test:browser` → 155/155 (los checks miden layout real: overflow, alto del visor, foco).
3. **Capturas comparadas** en 1440×900, 768×1024, 390×844, 844×390.
4. **Grep de anti-patrones**: `gradient-to-` = 0, `backdrop-blur` = 0, `rounded-full` ≤ 8,
   `rounded-2xl` = 0, `shadow-*` de color = 0.
5. Contraste ≥ 4.5:1 en el texto.

## Reglas de ejecución

- Un worker por ola, **exclusividad de ficheros**; las olas que no dependen entre sí van en paralelo.
- Cada worker **no puede** inventar tokens: usa los de `DESIGN.md` y `src/components/ui/**`.
- Prohibido introducir un componente nuevo sin estar en el inventario de `DESIGN.md`.
- Si una restricción choca con `DESIGN.md`, se reporta: `DESIGN.md` manda, pero se documenta.
- Nada de "mejoras" de producto en estas olas: es un rediseño, no una ampliación.
- Al final de cada ola: captura antes/después y revisión de las 5 comprobaciones de aceptación.
