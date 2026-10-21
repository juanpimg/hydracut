# HydraCut Studio — DESIGN.md

> El mundo visual de HydraCut Studio. Deriva de `PRODUCT.md` (qué es el producto) y de la
> investigación `07-ux-research.md` (qué hacen los editores profesionales reales).
> Este documento es **normativo**: las decisiones que contradigan este documento son un bug.

## El mundo

**"Instrumento de precisión"** — un taller de edición, no una landing page.

Superficies de grafito neutro, planas y apiladas por luminosidad, no por sombra. Un único acento
frío que solo aparece donde significa algo. Cero gradientes, cero brillos, cero glassmorphism,
cero tarjetas gigantes, cero voz de marketing. El movimiento es casi inexistente: **la animación
del producto es el vídeo del usuario**.

El criterio de éxito es el inverso del habitual: **cuanto menos se nota la interfaz, mejor**.
Se nota cuando algo está mal.

## Por qué este mundo (y no otro)

Siete editores profesionales convergen en lo mismo —DaVinci Resolve, Premiere Pro, Final Cut Pro,
CapCut desktop, iMovie, Kdenlive, Shotcut—: monitor arriba-centro, línea de tiempo abajo al
~45 % de la altura, bin a la izquierda, **inspector a la derecha**, grises neutros nunca negros
puros, un solo acento, y movimiento casi nulo. Nuestra app ya tenía los ingredientes pero los
mezcló con una estética de *dashboard* (gradientes azul-violeta, tarjetas grandes, pills por
todo, seis colores de acento, voz de marketing). Ese híbrido es exactamente lo que se lee como
"IA".

## Sistema de color

### Superficies (planas, por luminosidad — nunca negro puro: el negro puro se come los
### negros del vídeo)
| Token | Hex | Uso |
|---|---|---|
| `app` | `#0D1117` | lienzo de la app, detrás de todo |
| `panel` | `#161B22` | bins, well de la línea de tiempo, rail |
| `raised` | `#1F242E` | tarjetas, secciones del inspector, toolbar |
| `overlay` | `#262D38` | menús, popovers, tooltips, hojas |
| `border-subtle` | `#21262D` | separadores internos, wells |
| `border` | `#30363D` | hairlines de 1 px |

### Texto (3 pasos, contraste ≥ 4.5:1 sobre `panel` y `raised`)
| Token | Hex | Uso |
|---|---|---|
| `text-1` | `#F0F3F6` | primario |
| `text-2` | `#9AA4B2` | etiquetas secundarias, metadatos |
| `text-3` | `#8B949E` | hints, metadatos tenues, deshabilitado |

Medido (WCAG 2.1): `text-3` sobre `panel` = 5.62:1 y sobre `raised` = 5.06:1;
`text-2` sobre `panel` = 6.86:1. `text-3` nunca es cuerpo de lectura: solo
hints, metadatos tenues y estados deshabilitados. (Corrección audit2 H4: el
`#636C76` anterior solo daba 3.24:1 sobre `panel` y no cumplía lo prometido.)

### Acento — **uno solo**, y significa siempre lo mismo
| Rol | Hex | Dónde |
|---|---|---|
| `accent` | `#22D3EE` | cabezal, anillo de selección, foco, enlaces, icono activo |
| `accent-fill` | `#06748F` | relleno de botón primario (mismo tono, un peso menos; blanco sobre el relleno = 5.38:1, sigue leyéndose cian) |
| `accent-soft` | `rgba(34,211,238,.12)` | fondo de estado activo, chip |

El acento **nunca** decora: no tiñe tarjetas, no colorea iconos por gusto, no pinta headings.
Presupuesto: **≤ 5 % de los píxeles visibles**.

### Semánticos (solo cuando significan algo)
| Rol | Hex | Uso |
|---|---|---|
| `danger` | `#F85149` | borrar, error |
| `warning` | `#D29922` | avisos reales (cuota, codec) |
| `success` | `#3FB950` | export listo, guardado |

### Tintes de clip (relleno suave + texto claro, nunca neón)
`clip-video` `#1F6FEB` · `clip-audio` `#238636` · `clip-text` `#8957E5` · `clip-fx` `#9E6A03`

### Prohibido
`#2F81F7` y cualquier azul de "marca" como acento secundario · gradientes · `backdrop-blur` ·
sombras de color · texto con gradiente · emoji en la UI.

> Nota: el azul **sí** se usa, pero **solo** como tinte de clip de vídeo, no como color de interfaz.

## Tipografía

Familia: `Inter` (ya presente) para UI; `JetBrains Mono` con `font-variant-numeric: tabular-nums`
**solo** para timecodes, duraciones y números de medida. Monoespaciado como disfraz de "técnico"
está prohibido en otro sitio.

| Token | Tamaño / interlineado / peso | Uso |
|---|---|---|
| `caption` | 11 / 16 / 500, `0.04em`, mayúsculas | cabeceras de panel, títulos de sección, etiquetas de pista |
| `body-sm` | 12 / 18 / 400 | etiquetas del inspector, metadatos del bin, tooltips |
| `body` | 13 / 20 / 400 | texto de UI de escritorio por defecto |
| `body-lg` | 14 / 22 / 400 | móvil por defecto, copy de estado vacío |
| `title` | 15 / 22 / 600 | títulos de diálogo y hoja |
| `timecode` | 12 mono / 500 | regla, transporte, duraciones |

## Espaciado, radio, bordes, alturas

- **Espaciado**: base 4 → `2 · 4 · 8 · 12 · 16 · 24 · 32`. Padding de panel 12, hueco de sección 16,
  hueco de toolbar 4–8, separación de pistas 2.
- **Radio**: `4` botones/inputs/badges · `6` tarjetas/clips · `8` hojas/diálogos/viewer.
  **Nada por encima de 12** salvo toggles tipo pill diminutos. Un radio por clase de componente.
- **Bordes**: 1 px siempre. `border-subtle` en wells, `border` en elementos interactivos.
  Anillo de foco: `2px accent` con `offset 1px`.
- **Alturas de control**: escritorio `28` (filas densas, toggles) / `32` (botones e inputs) /
  `36` (transporte, primario). Móvil `40` mínimo, **44 px** el objetivo táctil.
- **Iconos**: 16 px escritorio, 20–24 px móvil, un solo trazo y grosor (Lucide, 1.5 px).

## Estructura de la interfaz

### Escritorio (≥ 1024 px)
```
┌────────────────────────────────────────────────────────────────┐
│ app bar 40px: marca · proyecto · ratio · deshacer/rehacer · Exportar │
├──────┬───────────────┬──────────────────────────┬───────────────┤
│ rail │  bin/panel   │       VISOR (héroe)       │   INSPECTOR   │
│ 48px │   260–300px   │          flex            │   280–320px   │
│      │               │  transporte 36px         │  secciones    │
├──────┴───────────────┴──────────────────────────┴───────────────┤
│ línea de tiempo 280–360px (redimensionable, mín. 200)            │
│   toolbar 36px: dividir · borrar · imán · +pista | zoom        │
└────────────────────────────────────────────────────────────────┘
```
- El **inspector va a la derecha**, como en los siete editores. Antes era una pestaña del rail
  izquierdo; eso es exactamente lo que hace que la app no se lea como un NLE.
- El **visor es el héroe**:chrome mínimo, transporte discreto, sin decoración.
- La **línea de tiempo es el segundo héroe**: ~40 % de la altura.
- El rail izquierdo queda para **lo que aporta medios** (Medios / Texto / Audio), no para las
  propiedades del clip.

### Móvil (< 1024 px)
```
┌──────────────────────┐
│ app bar 48px  [Exportar]│
├──────────────────────┤
│ VISOR 38 %           │
│ transporte compacto    │
├──────────────────────┤
│ LÍNEA DE TIEMPO 30 %  │
├──────────────────────┤
│ TIRA DE HERRAMIENTAS   │
│ (contextual a la sel.) │
└──────────────────────┘
```
Nunca paneles laterales en móvil. La tira inferior **cambia con la selección**: sin clip → herramientas
globales (Medios/Texto/Audio); con clip → herramientas del clip (Editar/Velocidad/Volumen/Borrar).
Es el modelo de CapCut, y es el que hace que el móvil no se sienta como un escritorio encogido.

## Inventario de componentes (primitivas a construir)

Una familia por función, sin variantes ad-hoc:

| Familia | Variantes | Regla |
|---|---|---|
| `Button` | `ghost` · `secondary` · `primary` · `danger` · `icon` | 32 px (28 en filas densas, 36 en transporte), radio 4, un icono opcional, etiqueta obligatoria salvo `icon` |
| `IconButton` | `sm` `md` | 28/32 px, **siempre** con `aria-label` + tooltip |
| `SegmentedControl` | 1–4 opciones | para mutually exclusive (ratio, fps, formato) — sustituye a los grupos de botones llenos |
| `Slider` | con campo numérico | slider + número editable + unidad, alineados; se resetea con un punto por sección |
| `Select` / `Input` | 32 px | fondo `raised`, borde 1 px, foco acento |
| `Checkbox` / `Toggle` | — | el toggle muestra estado activo persistente (`accent-soft` + icono acento) |
| `Panel` | — | fondo `panel`, borde inferior `border-subtle`, cabecera `caption` |
| `Section` | colapsable | cabecera `caption` + reset; **máx. 5 secciones visibles** en el inspector |
| `Badge` | `neutral` `accent` `danger` `warning` `success` | **nunca** como color decorativo de estado rutinario |
| `Tooltip` | — | delay 400 ms, también en `title` para teclado |
| `Toast` | `info` `error` `success` | esquina inferior, **nunca encima del contenido**, auto-dismiss 5 s |
| `Dialog` / `Sheet` | — | máx. 560 px de alto (`max-h-[min(560px,calc(100dvh-3rem))]`), un `✕` y `Esc`; **sin scroll, salvo diálogos-lista** |
| `Menu` | — | en portal, `overlay`, sombra única `0 8px 24px rgba(0,0,0,.5)` |
| `MediaCard` | — | miniatura 16:9, nombre en 2 líneas, **una** acción de añadir, borrar en menú |
| `TrackHeader` | — | 48–64 px, nombre corto legible, 2–3 micro-controles |
| `Clip` | — | radio 6, filmstrip en vídeo, waveform en audio, badges de fx |

Alcance de la regla «sin scroll» (corrección audit2 L6): vale para los
diálogos que caben —exportar, bienvenida, atajos—. Una galería con N
proyectos es un diálogo-lista y no puede cumplirla: lleva su propia cota
(`max-h-[90dvh]`) con desplazamiento interno y queda exenta.

## Movimiento

- Presupuesto: **150 ms** de feedback de UI. Nada más.
- Solo se animan: hover, foco, aparición/desaparición de un panel, y el progreso del export.
- Curva: `cubic-bezier(.2,.8,.2,1)` (ease-out exponencial) desde un estado **ya visible**.
- Prohibido: rebotes, paralaje, entradas escalonadas, pulsos, animaciones de fondo.

## Reglas de copy (dentro del producto)

- Las herramientas **nombran su acción**: "Dividir clip", no "Cuchilla"; "Añadir al fondo".
- Los errores **nombran el problema y la recuperación**: qué pasó y qué hacer.
- **Nada de voz de marketing** dentro del producto: "100 % acelerado en el cliente (GPU nativa)" y
  "Aceleración WebCodecs Activa" son promessas de landing page. En la app: "H.264 por GPU" o
  "Respaldo en tiempo real".
- Idioma: español. Solo la marca en inglés. Unidades explícitas (px, %, dB, s, MB).

## Anti-patrones (prohibidos)

1. Gradientes en el chrome. 2. `backdrop-blur` en paneles. 3. Brillos/sombras de color.
4. Tarjetas redondeadas gigantes (≥16 px) para filas rutinarias. 5. Pills flotantes.
6. Emoji en la UI. 7. Badges de color para estado rutinario. 8. Un segundo acento.
9. Voz de marketing dentro del producto. 10. Estados vacíos de 3 tarjetas con icono+título+texto.
11. Espaciados o radios inconsistentes. 12. Animación más allá de 150 ms.
13. Layout centrado dentro de la superficie de trabajo. 14. Iconos sin etiqueta donde el icono
    es ambiguo (deshacer/rehacer). 15. Redundancia funcional (3 formas de añadir un medio,
    dos de dividir).

## Criterios de aceptación de una revisión de UI

- Capturas antes/después en 1440×900, 768×1024, 390×844 y 844×390, comparadas **lado a lado**.
- 0 gradientes, 0 `backdrop-blur`, 0 sombras de color en el chrome (verificable con grep).
- ≤ 5 % de píxeles con el acento.
- Consola limpia, 0 overflow horizontal, los 155 checks de navegador en verde.
- Teclado: todo accionable con foco visible; `Esc` cierra lo que deba.
- Táctil: objetivos ≥ 44 px en móvil.
