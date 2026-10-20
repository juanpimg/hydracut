# HydraCut Studio — Especificación de microcopy

> Para el implementador hispanohablante. Norma: `PRODUCT.md` (herramienta, honestidad radical),
> `DESIGN.md` § «Reglas de copy» y § «Anti-patrones». Cada cadena citada existe en el código con su
> `fichero:línea` real. Veredictos: `KEEP` (se queda), `REWRITE` (cambiar por el propuesto),
> `DELETE` (eliminar). Todo el UI va en español, caso oración, con acentos (`vídeo`, no `video`).

## 1. Inventario por clase de problema

### 1.1 Voz de marketing dentro del producto → informar, no vender

| Actual | Ubicación | Veredicto → propuesto |
|---|---|---|
| `100% acelerado en el cliente (GPU nativa)` | `export/ExportModal.tsx:785` | REWRITE → `H.264 por GPU (WebCodecs)` |
| `Aceleración WebCodecs Activa` | `export/ExportModal.tsx:812` | REWRITE → `H.264 por GPU` |
| `Codificación H.264 acelerada por GPU mediante WebCodecs y mp4-muxer.` | `export/ExportModal.tsx:816` | REWRITE → `Codifica con WebCodecs y empaqueta en MP4.` |
| `Navegador sin WebCodecs completo; utilizando renderizador de respaldo.` | `export/ExportModal.tsx:817` | REWRITE → `Este navegador no codifica H.264: el archivo será WebM.` |
| `Grabación en tiempo real (respaldo MediaRecorder)` | `export/ExportModal.tsx:784` | REWRITE → `Respaldo en tiempo real (MediaRecorder)` |
| `Exportar Video MP4` / `Exportar Video WebM` / `Exportar Video MP4 (WebM en este navegador)` | `export/ExportModal.tsx:776-780` | REWRITE → título único `Exportar vídeo` (el formato lo dice el selector) |
| `Generar Clips de Prueba (1-Click)` | `media/MediaBin.tsx:451` | REWRITE → `Generar clips de prueba` |
| `Generando clips de muestra en el navegador...` | `media/MediaBin.tsx:446` | REWRITE → `Generando clips…` |
| `100% privado en tu navegador (OPFS local)` | `media/MediaBin.tsx:497` | REWRITE → `Se guarda solo en este navegador` (constatable, sin promesa ni sigla) |
| `Almacenamiento 100% privado en tu navegador (IndexedDB)` | `modals/ProjectsModal.tsx:382` | REWRITE → `Se guarda solo en este navegador` |
| `Panel de Medios` | `media/MediaBin.tsx:415` | REWRITE → `Medios` |
| `Karaoke Progresivo (Apple Music)` | `inspector/ClipInspector.tsx:929` | REWRITE → `Karaoke` (sin marcas ajenas) |
| `Rebote / Pop de Palabra (TikTok / Reels)` | `inspector/ClipInspector.tsx:930` | REWRITE → `Rebote` |
| `Mis Proyectos` (título) | `modals/ProjectsModal.tsx:376` | REWRITE → `Mis proyectos` (caso oración) |
| `Nuevo Proyecto` | `modals/ProjectsModal.tsx:408` | REWRITE → `Nuevo proyecto` |
| `Atajos de Teclado` | `modals/ShortcutsModal.tsx:62`, `layout/Header.tsx:174` | REWRITE → `Atajos de teclado` |
| `Crear Proyecto Ahora` | `modals/ProjectsModal.tsx:459` | REWRITE → `Crear proyecto` |
| `¿Eliminar Proyecto?` | `modals/ProjectsModal.tsx:651` | REWRITE → `¿Eliminar proyecto?` |
| `Sí, Eliminar` | `modals/ProjectsModal.tsx:671` | REWRITE → `Eliminar` |
| `Política de Solapamiento` | `inspector/ClipInspector.tsx:560` | REWRITE → `Política de solapamiento` |
| `Contenido y Estilo de Texto` | `inspector/ClipInspector.tsx:715` | REWRITE → `Texto` |
| `Transformación & Visibilidad` | `inspector/ClipInspector.tsx:982` | REWRITE → `Transformación` |
| `Color del Clip` | `inspector/ClipInspector.tsx:1249` | REWRITE → `Color` |
| `Audio del Clip` | `inspector/ClipInspector.tsx:1343` | REWRITE → `Audio` |
| `Velocidad de Reproducción` | `inspector/ClipInspector.tsx:1688`, `mobile/MobileCapCutLayout.tsx:152` | REWRITE → `Velocidad` |
| `Transiciones y Fundidos` | `inspector/ClipInspector.tsx:1764` | REWRITE → `Fundidos` (no hay transiciones; ver §3) |
| `Inspector de Clip` (2 cabeceras) | `inspector/ClipInspector.tsx:252,662` | REWRITE → `Inspector` |
| `Capas de Texto` | `layout/Sidebar.tsx:126`, `mobile/MobileCapCutLayout.tsx:150` | REWRITE → `Texto` |
| `Biblioteca de Medios` (título de hoja) | `mobile/MobileCapCutLayout.tsx:146` | REWRITE → `Medios` |
| `Volumen de Audio` (título de hoja) | `mobile/MobileCapCutLayout.tsx:154` | REWRITE → `Volumen` |
| `Opacidad y Transparencia` (título de hoja) | `mobile/MobileCapCutLayout.tsx:158` | REWRITE → `Opacidad` |
| `Animaciones y Transiciones` (título de hoja) | `mobile/MobileCapCutLayout.tsx:156` | REWRITE → `Fundidos` |
| `Propiedades del Clip` (título de hoja) | `mobile/MobileCapCutLayout.tsx:160` | REWRITE → `Inspector` |
| `Propiedades del clip` (botón móvil) | `mobile/MobileBottomBar.tsx:159-160` | REWRITE → visible `Inspector`, aria `Abrir el inspector` |
| `Ajustes` (botón móvil, abre lo mismo) | `mobile/MobileBottomBar.tsx:164` | DELETE como nombre → unificar en `Inspector` |
| `En Edición` (badge, duplica al `Abierto` de la fila) | `modals/ProjectsModal.tsx:533` | DELETE (el estado `Abierto` de `:571` ya lo dice) |
| Código en GitHub en la barra de la app | `layout/Header.tsx:192-202` | DELETE (ruido en una herramienta; vive en el Hub, no en el editor) |

### 1.2 Funciones duplicadas con dos nombres → un nombre, una puerta

1. **Dividir.** `Cuchilla` (etiqueta visible `timeline/TimelineToolbar.tsx:187`, título `:184
   `Cortar clip con un clic (herramienta de cuchilla)`) y `Dividir (S)` (`:207`) hacen lo mismo.
   Canónico: **`Dividir`**. Puerta canónica: el botón `Dividir` en el cabezal (`S`). La cuchilla
   como modo (`activeTool === 'split'`) se **elimina**: un modo que cambia el clic compite con la
   selección y duplica el camino.
2. **Añadir medio.** Tres puertas en `media/MediaItemCard.tsx`: clic en la tarjeta (`:52`),
   `+` flotante sobre la miniatura (`:106-113`), botón `Añadir` (`:145-153`). Canónico: el botón
   **`Añadir`** (visible, táctil, con nombre). El `+` flotante se **elimina**; el clic en la tarjeta
   se **mantiene** como atajo silencioso (no se anuncia como puerta). La papelera se queda donde
   está hasta que exista menú de tarjeta.
3. **Dividir en móvil.** `Dividir clip` (modo clip, `mobile/MobileBottomBar.tsx:97-98`) y
   `Dividir en cabezal` (modo global, `:112-113`) ejecutan el mismo `splitAtPlayhead`.
   Canónico visible: **`Dividir`**; aria único: `Dividir en el cabezal`.
4. **Texto: dos fichas para lo mismo.** Escritorio (`layout/Sidebar.tsx:143-161`) y móvil
   (`mobile/MobileCapCutLayout.tsx:287-306`) describen distinto lo idéntico. Canónico:
   `Título` / `Aperturas y destacados` y `Subtítulo` / `Explicaciones o créditos` en ambas
   superficies. Además el escritorio crea el clip con texto `Título Principal` y el móvil igual,
   pero el store usa por defecto `Título Nuevo` (`store/useProjectStore.ts:2981`): unificar en
   **`Título`** y **`Subtítulo`**.
5. **Tres iconos misteriosos en la barra** (`layout/Header.tsx:171-202`: ayuda, guía, GitHub).
   Se quedan ayuda y guía con tooltip; GitHub se elimina (§1.1).

### 1.3 Controles de solo-icono → `aria-label` + etiqueta visible o tooltip

- **Deshacer/Rehacer** (escritorio, `layout/Header.tsx:143-164`): tienen `title` + `aria-label`,
  pero largos (`Deshacer última acción (Ctrl+Z)`). Propuesto: aria y tooltip idénticos y cortos:
  `Deshacer (Ctrl+Z)` / `Rehacer (Ctrl+Y)`. Sin etiqueta visible (iconos estándar con tooltip,
  válido según `DESIGN.md` para `IconButton`).
- **Deshacer/Rehacer** (móvil, `mobile/MobileHeader.tsx:166-188`): aria `Deshacer` / `Rehacer` sin
  atajo (correcto: no hay teclado), tooltip igual. KEEP tras unificar mayúsculas.
- **Ayuda y guía** (escritorio): tooltip `Atajos de teclado` / `Guía de inicio`, aria idénticos.
  REWRITE menor (caso oración en ayuda).
- **Exportar en móvil** (`mobile/MobileHeader.tsx:213-221`, icono `Sparkles` con `animate-pulse`):
  REWRITE → icono `Download` (paridad con escritorio), sin pulso (movimiento prohibido),
  etiqueta visible `Exportar` siempre, aria `Exportar vídeo`.
- **Pista: ojo, altavoz, candado, ⋮** (`timeline/TrackHeader.tsx:171-246`): tienen `title` + `aria`.
  REWRITE menor: `Activar audio` → `Activar sonido` (paridad con el patrón Silenciar X / Activar
  sonido de X); el resto KEEP.
- **`-1f` / `+1f`** (`player/PlayerControls.tsx:129,152`, `mobile/MobilePreviewPlayer.tsx:546,555`):
  el glifo es críptico; se queda por densidad, pero el tooltip y el aria deben coincidir:
  `Retroceder 1 fotograma` / `Avanzar 1 fotograma` (hoy mezclan `cuadro` y `fotograma`).
- **Volver** (móvil con clip, `mobile/MobileBottomBar.tsx:145-153`, icono X): `Volver` promete
  navegación; lo que hace es quitar la selección. REWRITE → visible `Cerrar`, aria
  `Quitar la selección`.
- **Regla de tiempo**: hoy sin nombre accesible. ADD `aria-label="Regla de tiempo"` al contenedor
  (no hay cadena que corregir; es la única adición de este spec).

### 1.4 Truncamiento → estrategia

Regla general (vale para las 6 superficies):

1. **Nunca menos de ~8 caracteres visibles.** El mínimo es el código corto de pista (`V1`, `A1`,
   `T1`), no un nombre recortado a 1 carácter (`I.`, `B`, `T1 Te...`, `Vid...`).
2. **Recorte siempre al final con ellipsis**, nunca en medio. Una línea en cabeceras y clips;
   **dos líneas con clamp** en tarjetas de medio (`DESIGN.md`: «nombre en 2 líneas»).
3. **Nombre completo siempre** en `title` + `aria-label` (o `aria-labelledby`).
4. El tooltip existe para teclado y táctil con pulsación larga; no se confía en `hover`.

Aplicación:

| Caso | Actual | Decisión |
|---|---|---|
| Badge de pista `max-w-[56px]` + nombre oculto bajo `md` (`timeline/TrackHeader.tsx:148-159`) | `T1 Te...` ilegible | KEEP la estructura; el badge muestra código + icono (mín. 44 px) y el nombre completo va en `title` (ya existe, `:151`) y en el menú (`:275`). Nada de iniciales de 1 carácter: el código corto ya es el mínimo. |
| Nombre de medio 1 línea (`media/MediaItemCard.tsx:134-136`) | 1 carácter visible en rejilla estrecha | REWRITE → clamp a 2 líneas + `title` (ya existe). |
| Nombre de clip en la línea de tiempo (`timeline/ClipItem.tsx:857-859`) | truncate + aria completa (`:709-711`) | KEEP (patrón correcto). |
| Nombre de proyecto (barra, bienvenida, galería) | truncate + `title` en los tres | KEEP. |
| `X clip(s)` (`media/MediaBin.tsx:595`) | paréntesis de programador | REWRITE → `X clips` (el ternario singular/plural ya existe en la galería, `modals/ProjectsModal.tsx:549,554`; aplicar el mismo patrón). |

### 1.5 Vocabulario inconsistente → tabla de migración

Ver glosario canónico en §3. Migraciones concretas:

| Seguir llamando | Pasar a llamar | Dónde aparece hoy |
|---|---|---|
| `capa` (texto) | `pista` / `texto` | `Capas de Texto` (`Sidebar.tsx:126`), `Añadir capa de texto` (`MobileBottomBar.tsx:246`) |
| `cuadro` | `fotograma` | `Retroceder 1 cuadro`, `Avanzar 1 cuadro`, `Tasa de Cuadros (FPS)`, `Cuadro actual:` |
| `elemento` | `clip` o `medio` según contexto | (reservar; no usar `elemento` para nada seleccionable) |
| `archivo` para piezas de la biblioteca | `medio` | `El archivo de este medio…` se reescribe a `Este medio…` |
| `renderizar`, `renderizador`, `Codificando fotogramas con GPU...`, `Generando archivo…` | `exportar`, `codificar`, `generar` | `ExportModal.tsx:817,1104-1105` |
| `transición` para fundidos | `fundido` | `Transiciones y Fundidos`, `Animación`, `Transiciones`, `Animaciones y Transiciones`, badge `FADE` + `Transición activa` (`ClipItem.tsx:869-873`) |
| `fade`, `Fade In/Out`, `FADE`, `In/Out` en UI | `fundido`, `entrada`, `salida` | `ClipItem.tsx:794,818,803,828`, títulos `:794,818`, hojas móviles `:416,479` |
| `preset` / `plantilla` | `preajuste` | `Preset de color:` (`ClipInspector.tsx:1256`), `Plantillas:` (`:846`), `Aplicar plantilla…` |
| `maestro` (audio) | `general` | `Volumen maestro`, `sonido maestro`, `volumen maestro` (player ×2, ambas superficies) |
| `pitch` | `tono` | `Preservar el tono (pitch)` (`ClipInspector.tsx:1748`) |
| `Ripple` (etiqueta) | `Desplazar` | opción `Ripple (desplazar)` (`ClipInspector.tsx:575`) |
| `Medios` (banda de EQ) | `Medias` | colisiona con el panel `Medios` (`ClipInspector.tsx:161`) |
| `negrito` (errata) | `negrita` | `Sidebar.tsx:144` |
| `timeline` en español | `línea de tiempo` | `Añade al menos un clip al timeline…` (`ExportModal.tsx:1085`), `Ir al inicio del timeline`, `Zoom… en el timeline` (`ShortcutsModal.tsx:41,43`), `Monitor: N clips en el timeline` (se mantiene: es el término canónico, ver §3) |
| `video` sin acento | `vídeo` | `Exportar Video…`, `Tu video MP4…`, `Video V1/V2…`, `Mi Proyecto de Video`, `Arrastra videos…` |
| `Sin proyecto` / defaults ingleses | — | `Mi Proyecto de Video` (`useProjectStore.ts:1153`) → `Mi proyecto de vídeo`; `Video V2 (Superposición)` (`:1146`) → `Vídeo V2 (superposición)`; `Video V1 (Principal)` (`:1147`) → `Vídeo V1 (principal)` |
| `«»` vs `" "` mezclados en errores del store | `«»` siempre | `useProjectStore.ts:1597,1636,2010,2205,3208` usan `" "`; el resto `«»` |
| `Clips silenciados` como `title` (describe estado, no acción) | `Activar sonido` | `ClipInspector.tsx:331,1369` |

### 1.6 Estados vacíos, carga y errores → titular + una acción, voz de herramienta

| Estado | Actual | Propuesto (titular + acción) |
|---|---|---|
| Bin vacío (`MediaBin.tsx:494-498`) | `Arrastra videos, audios o fotos aquí` + `o haz clic para importar` + promesa de privacidad | Titular `Sin medios` · secundario `Arrastra archivos o impórtalos` · botón `Importar` (la privacidad vive en una línea tenue: `Se guarda solo en este navegador`) |
| Visor vacío (`PreviewPlayer.tsx:247-250`, `MobilePreviewPlayer.tsx:448-452`) | `Timeline vacío` + `Importa videos o genera clips de prueba para verlos aquí.` | Titular `Sin clips` · secundario `Añade un clip para empezar a editar` (sin botón dentro del lienzo: el lienzo no lleva acciones) |
| Inspector vacío (`ClipInspector.tsx:602-605`) | `Ningún clip seleccionado` + `Haz clic sobre un clip…` (`clic` excluye táctil) | Titular KEEP · secundario `Selecciona un clip de la línea de tiempo para editarlo.` |
| Hoja móvil sin selección (`MobileCapCutLayout.tsx:574-577`) | `Ningún clip seleccionado` + `Toca un clip…` + `Cerrar panel` | Titular KEEP · secundario `Selecciona un clip para ajustar sus propiedades.` · botón `Cerrar` |
| Sin keyframes (`ClipInspector.tsx:1236-1237`) | ya es voz de herramienta | KEEP |
| Sin vecino para fundido (`ClipInspector.tsx:2028`) | `Sin clip vecino para fundir.` | KEEP |
| Sin audio (hoja móvil, `:247-256`) | `No hay audio importado` + `Abrir biblioteca de medios` | KEEP titular; acción → `Abrir medios` |
| Galería vacía (`ProjectsModal.tsx:449-454`) | `No tienes proyectos guardados aún` + párrafo + `Crear Proyecto Ahora` | Titular `Sin proyectos` · secundario `Crea uno o arrastra un .hydra / .json.` · botón `Crear proyecto` |
| Sin resultados de búsqueda (`:449,452`) | correcto | KEEP |
| Export sin clips (`ExportModal.tsx:1085`) | `Añade al menos un clip al timeline antes de exportar.` | `No hay nada que exportar. Añade un clip a la línea de tiempo.` |
| Rango incompleto (`:1046`) | `Marca la entrada y la salida del rango…` | KEEP |
| Cargando medios (`MediaBin.tsx:485`) | `Importando y extrayendo fotogramas...` | KEEP |
| `Calculando...` (ETA, `ExportModal.tsx:30`) | correcto y con regla de ocultado | KEEP |
| `Creando copia...`, `Eliminando...` | correctos | KEEP |
| Errores del store (pista bloqueada, solape, tipo incompatible) | voz honesta con recuperación (`useProjectStore.ts:452-454,1597,2010,2205`) | KEEP estructura; unificar comillas a `«»` y `tipo incompatible` → `«X» es audio y no cabe en «Y»: usa una pista de audio.` |
| `alert(...)` nativos (bienvenida, galería) | 9 avisos bloqueantes | REWRITE (fuera de oleada: migrar a toast; el texto se mantiene pero sin `alert`) |

### 1.7 Diálogo de exportación → copy exacto

Título fijo: **`Exportar vídeo`**. Subtítulo según capacidad (una línea, factual):

- Con WebCodecs: `H.264 por GPU (WebCodecs)`.
- Sin WebCodecs: `Respaldo en tiempo real: el archivo será WebM`.
- Con formato WebM elegido: `WebM se graba en tiempo real (sin GPU)`.

Insignia de capacidad (sustituye al bloque `:804-820`):

- Con WebCodecs — insignia `H.264 por GPU` + `Codifica con WebCodecs y empaqueta en MP4.`
- Sin WebCodecs — insignia `Respaldo en tiempo real` + `Este navegador no codifica H.264:
  aunque pidas MP4, el archivo será WebM.`

Selector de formato: etiqueta `Formato`; botones `MP4` / `WebM`; aria
`Formato MP4 (H.264 por GPU)` / `Formato WebM (tiempo real)`. Nota WebM (`:865-868`): KEEP,
recortada a `WebM se graba en tiempo real: 10 s de proyecto tardan 10 s. Sin GPU.`

Preajustes: etiqueta `Preajuste`; etiquetas y hints KEEP (`Web`, `Social 1080p`,
`Vertical 1080×1920`, `Alta calidad` + sus hints). Resolución: etiqueta `Resolución`;
`720p HD` / `1080p FHD` / `4K UHD` KEEP. Línea de dimensiones (`:932`): KEEP.
Aviso de aspecto (`:936-943`): KEEP. FPS: etiqueta `Fotogramas por segundo`; botones
`30 FPS` / `60 FPS`. Calidad: etiqueta `Calidad`; valor `8 Mbps` (aria `Calidad en megabits
por segundo`). Rango: etiqueta `Rango`; `Todo el proyecto` / `Rango personalizado`;
`Marcar entrada` / `Marcar salida`; línea de cabezal KEEP (`Cabezal de reproducción: …`);
resumen `Exportando 00:00:05:00 → 00:00:12:00 (7 s)` o `Exportando el proyecto completo` KEEP.
Resumen: `Duración:` / `Fotogramas:` / `Clips:` (+ `Rango:` si aplica). Vacío:
`No hay nada que exportar. Añade un clip a la línea de tiempo.`

Progreso: `Codificando…` (GPU) / `Grabando en tiempo real…` (respaldo) /
`Generando el MP4…` / `Generando el WebM…` / `Exportación lista` / `Error al exportar`.
`Fotograma:` (no `Cuadro actual:`), `Tiempo restante:` KEEP, `Tamaño del archivo:` KEEP,
`Bitrate efectivo:` KEEP. Éxito: `Vídeo MP4 descargado.` / `Vídeo WebM descargado.` /
desajuste: `Pediste MP4, pero este navegador no graba MP4: se ha descargado un WebM.`
Botones: `Exportar` (deshabilitado con motivo: `Añade clips a la línea de tiempo` /
`Marca la entrada y la salida del rango`), `Cancelar`, `Cancelar exportación` (durante),
`Cerrar` (al terminar). Cierre con `✕`: aria `Cerrar`.

### 1.8 Diálogo de bienvenida → aparece una vez, no interrumpe

Ya es de primer arranque (`markWelcomeSeen`). Copy propuesto (cambios mínimos, todos REWRITE):

- Título KEEP `HydraCut Studio`. Subtítulo `¿Qué quieres hacer hoy?` → **`Elige cómo empezar`**.
- Añadir bajo el subtítulo una línea factual (12 px, tenue):
  **`Tus vídeos no salen de este navegador.`** (demuestra el pilar de privacidad sin vender).
- `Último proyecto` KEEP. `Seguir editando` / `Continúa donde lo dejaste` KEEP.
  `Nuevo proyecto en blanco` / `El actual queda guardado` KEEP.
  `Abrir o importar…` / `Galería y archivos .hydra / .json` KEEP. `Recientes` KEEP.
- Cierre `✕`: aria `Cerrar y continuar`, tooltip `Continuar (Esc)` KEEP.
- Nada de casilla «no volver a mostrar»: ya no se muestra sola; la guía la reabre a propósito.

---

## 2. Tabla de copy por ola

`fichero:línea | actual | propuesto | veredicto | motivo`

### U1 — Chasis (barra, rail, inspector, errores del store)

| Fichero:línea | Actual | Propuesto | V | Motivo |
|---|---|---|---|---|
| `layout/Header.tsx:73` | `HydraCut — HydraApps Suite (volver al Hub)` (title) | `Volver al Hub` | REWRITE | el title repite la marca; nombra la acción |
| `layout/Header.tsx:74` | `Volver al Hub de HydraApps` (aria) | `Volver al Hub` | REWRITE | corto; el Hub ya es HydraApps |
| `layout/Header.tsx:90` | `Gestor de Proyectos (Abrir, Nuevo, Guardar, Respaldos)` | `Abrir proyectos` | REWRITE | el title debe decir lo que hace |
| `layout/Header.tsx:91` | `Abrir gestor de proyectos` | `Abrir proyectos` | REWRITE | una palabra para un concepto (§3) |
| `layout/Header.tsx:94` | `Proyectos` | = | KEEP | corto y correcto |
| `layout/Header.tsx:101` | `Nombre del proyecto` | = | KEEP | preciso |
| `layout/Header.tsx:110` | `Relación de aspecto del proyecto` | = | KEEP | preciso |
| `layout/Header.tsx:129-130` | `Formato 16:9 Panorámico`… | `Formato 16:9 panorámico`… | REWRITE | caso oración |
| `layout/Header.tsx:149-150` | `Deshacer última acción (Ctrl+Z)` | `Deshacer (Ctrl+Z)` | REWRITE | el verbo basta; title = aria |
| `layout/Header.tsx:160-161` | `Rehacer última acción (Ctrl+Y)` | `Rehacer (Ctrl+Y)` | REWRITE | ídem |
| `layout/Header.tsx:174-175` | `Atajos de Teclado` | `Atajos de teclado` | REWRITE | caso oración |
| `layout/Header.tsx:185-186` | `Guía de inicio` | = | KEEP | correcto |
| `layout/Header.tsx:192-202` | enlace GitHub en la barra | — | DELETE | ruido en la herramienta |
| `layout/Header.tsx:208` | `Abrir modal de exportación de vídeo` | `Exportar vídeo` | REWRITE | el aria nombra la acción, no el widget |
| `layout/Header.tsx:212` | `Exportar vídeo` | = | KEEP | verbo + objeto, perfecto |
| `layout/Header.tsx:67` | `¿Volver al Hub de HydraApps? Tu proyecto está autoguardado en este navegador.` | `¿Volver al Hub? El proyecto queda guardado en este navegador.` | REWRITE | corto; `autoguardado` es jerga |
| `layout/Sidebar.tsx:44-47` | `Medios` / `Texto` / `Inspector` | = | KEEP | un término por concepto |
| `layout/Sidebar.tsx:126` | `Capas de Texto` | `Texto` | REWRITE | `capa` prohibido (§3) |
| `layout/Sidebar.tsx:130-132` | `Agrega títulos, subtítulos o rótulos superpuestos sobre tu video.` | `Títulos y rótulos sobre el vídeo.` | REWRITE | sin segunda persona, con acento |
| `layout/Sidebar.tsx:143` | `Título Grande` | `Título` | REWRITE | paridad móvil + nombre del clip creado |
| `layout/Sidebar.tsx:144` | `Texto llamativo en negrito para aperturas` | `Texto grande en negrita para aperturas` | REWRITE | errata + paridad (`Aperturas y destacados` es aún más corto; vale cualquiera de los dos, uno solo) |
| `layout/Sidebar.tsx:157` | `Subtítulo / Rótulo` | `Subtítulo` | REWRITE | un nombre |
| `layout/Sidebar.tsx:158` | `Texto mediano para explicaciones o créditos` | `Explicaciones o créditos` | REWRITE | paridad móvil |
| `layout/MainLayout.tsx:139,156` | `Cerrar aviso de guardado` / `Cerrar aviso` | `Cerrar aviso` | REWRITE | unificar |
| `layout/MainLayout.tsx:204` | `Clip seleccionado: X` | = | KEEP | anuncio útil |
| `layout/MainLayout.tsx:319-337` | `Clip copiado: usa Ctrl+V…` / `Clip pegado` / `Clip duplicado` (+ plurales) | = | KEEP | voz de herramienta |
| `inspector/ClipInspector.tsx:252,662` | `Inspector de Clip` | `Inspector` | REWRITE | el tab ya se llama así |
| `inspector/ClipInspector.tsx:256,262` | `¿Eliminar los N clips seleccionados? Puedes deshacerlo con Ctrl+Z.` | = | KEEP | pregunta + recuperación |
| `inspector/ClipInspector.tsx:261` | `Eliminar N clips (Supr)` | = | KEEP | atajo explícito |
| `inspector/ClipInspector.tsx:275` | `N clips seleccionados` | = | KEEP | el usuario sabe que es lote |
| `inspector/ClipInspector.tsx:281-292` | `Clips:` / `Pistas:` + nota de lote | = | KEEP | honesto |
| `inspector/ClipInspector.tsx:299,352,389` | `Audio (en lote)` / `Opacidad (en lote)` / `Velocidad (en lote)` | `Audio` / `Opacidad` / `Velocidad` | REWRITE | el banner de conteo ya dice que es lote |
| `inspector/ClipInspector.tsx:303-305` | `Volumen:` / `Mixto` | = | KEEP | `Mixto` es la palabra exacta |
| `inspector/ClipInspector.tsx:331` | `Clips silenciados` (title) | `Activar sonido` | REWRITE | el title dice lo que hace el clic |
| `inspector/ClipInspector.tsx:560` | `Política de Solapamiento` | `Política de solapamiento` | REWRITE | caso oración |
| `inspector/ClipInspector.tsx:563-564` | `Qué pasa al insertar un clip donde ya hay contenido:` | = | KEEP | lenguaje llano ejemplar |
| `inspector/ClipInspector.tsx:573-575` | `Bloquear (recomendado)` / `Sobrescribir` / `Ripple (desplazar)` | `Bloquear (recomendado)` / `Sobrescribir` / `Desplazar` | REWRITE | fuera anglicismo en etiqueta (el hint ya explica) |
| `inspector/ClipInspector.tsx:602-605` | `Ningún clip seleccionado` + `Haz clic sobre un clip…` | titular = · `Selecciona un clip de la línea de tiempo para editarlo.` | REWRITE | `clic` excluye el dedo |
| `inspector/ClipInspector.tsx:671-672` | `Eliminar clip (Supr)` / `Eliminar clip X` | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:680-691` | `Nombre:` / `Pista:` / `Duración:` | = | KEEP | ficha mínima correcta |
| `inspector/ClipInspector.tsx:704-705` | `El archivo de este medio no está disponible… Revínculalo desde el panel de medios.` | `Este medio no está disponible: el clip se ve negro y sin sonido. Revínculalo desde Medios.` | REWRITE | `medio` no `archivo`; `Medios` no `panel de medios` |
| `inspector/ClipInspector.tsx:719-727` | `Texto:` + área | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:732-766` | `Tipografía:` / `Tamaño: 48px` + familias | `Tamaño: 48 px` (resto =) | REWRITE | espacio antes de la unidad (familias: nombres propios, =) |
| `inspector/ClipInspector.tsx:773,790` | `Color de Texto:` / `Fondo de Texto:` | `Color del texto:` / `Fondo:` | REWRITE | caso oración + corto |
| `inspector/ClipInspector.tsx:809-810` | `Sin fondo` | `Quitar fondo` | REWRITE | nombra la acción |
| `inspector/ClipInspector.tsx:818` | `Alineación:` | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:845-847` | `Plantillas:` | `Preajustes:` | REWRITE | un término (§3) |
| `inspector/ClipInspector.tsx:861,863` | `Aplicar plantilla X` | `Aplicar preajuste X` | REWRITE | ídem |
| `inspector/ClipInspector.tsx:901-903` | `Aplicar una plantilla no borra tu texto y se puede deshacer con Ctrl+Z.` | `Aplicar un preajuste no borra el texto. Se deshace con Ctrl+Z.` | REWRITE | sin segunda persona |
| `inspector/ClipInspector.tsx:909` | `Efecto de Animación:` | `Animación:` | REWRITE | corto |
| `inspector/ClipInspector.tsx:928-931` | `Estático (Sin animación)` / `Karaoke Progresivo (Apple Music)` / `Rebote / Pop de Palabra (TikTok / Reels)` / `Desvanecimiento Suave (Fade In / Out)` | `Sin animación` / `Karaoke` / `Rebote` / `Fundido` | REWRITE | sin marcas ni inglés |
| `inspector/ClipInspector.tsx:937` | `Color de Palabra Activa:` | `Palabra activa:` | REWRITE | corto |
| `inspector/ClipInspector.tsx:982` | `Transformación & Visibilidad` | `Transformación` | REWRITE | `&` prohibido; basta el sustantivo |
| `inspector/ClipInspector.tsx:988-996` | `Editando el keyframe de X s: los controles…` | = | KEEP | aviso obligatorio y claro |
| `inspector/ClipInspector.tsx:1002-1047` | `Escala:` / `Opacidad:` / `Posición X:` / `Posición Y:` (+ `%`, `px`) | `Posición X: 12 px` (espacio; resto =) | REWRITE | unidades con espacio |
| `inspector/ClipInspector.tsx:1092` | `Restablecer Transformación` | `Restablecer transformación` | REWRITE | caso oración |
| `inspector/ClipInspector.tsx:1102` | `Keyframes de animación` | = | KEEP | término correcto |
| `inspector/ClipInspector.tsx:1133-1136` | `Añadir keyframe en el cabezal de reproducción` / `Añadir keyframe en el cabezal` | visible `Añadir keyframe`, aria largo | REWRITE | visible corto, aria completo |
| `inspector/ClipInspector.tsx:1144-1146` | `El cabezal está fuera de este clip…` | = | KEEP | honesto |
| `inspector/ClipInspector.tsx:1210-1213` | `Volver a los valores fijos` | = | KEEP | preciso |
| `inspector/ClipInspector.tsx:1218` | `¿Borrar todos los keyframes de este clip? Puedes deshacerlo con Ctrl+Z.` | = | KEEP | pregunta + recuperación |
| `inspector/ClipInspector.tsx:1227` | `Borrar keyframes` | = | KEEP | verbo + objeto |
| `inspector/ClipInspector.tsx:1236-1237` | `Sin keyframes: el clip usa su transformación fija…` | = | KEEP | estado vacío ejemplar |
| `inspector/ClipInspector.tsx:1249` | `Color del Clip` | `Color` | REWRITE | corto |
| `inspector/ClipInspector.tsx:1255-1256` | `Preset de color:` | `Preajuste de color:` | REWRITE | un término |
| `inspector/ClipInspector.tsx:1278` | `Personalizado` | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:80-138` | `Brillo` / `Contraste` / `Saturación` / `Temperatura` / `Blanco y negro` / `Sepia` (+ `Cálido/Frío/Neutra`) | = | KEEP | vocabulario estándar |
| `inspector/ClipInspector.tsx:1320` | `Restablecer color` | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:1343` | `Audio del Clip` | `Audio` | REWRITE | corto |
| `inspector/ClipInspector.tsx:1348-1349` | `Volumen:` | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:1365-1369` | `Silenciar clip` / `Clip silenciado` | `Silenciar clip` / `Activar sonido del clip` | REWRITE | title = acción |
| `inspector/ClipInspector.tsx:1380` | `Fundidos de audio` | = | KEEP | término canónico |
| `inspector/ClipInspector.tsx:1391,1446` | `Fundido de entrada:` / `Fundido de salida:` | = | KEEP | canónico |
| `inspector/ClipInspector.tsx:1416-1417,1471-1472` | `Curva de entrada:` / `Curva de salida:` | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:1438-1439,1493-1494` | `Potencia igual (recomendada)` / `Lineal` | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:1505` | `Quitar fundidos` | = | KEEP | verbo + objeto |
| `inspector/ClipInspector.tsx:1515` | `Efectos de audio` | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:1527` | `Paneo:` | = | KEEP | término estándar |
| `inspector/ClipInspector.tsx:1549-1551` | `−1 = izquierda, 0 = centro, +1 = derecha.` | = | KEEP | microcopy didáctico |
| `inspector/ClipInspector.tsx:155,161,167` | `Graves` / `Medios` / `Agudos` | `Graves` / `Medias` / `Agudos` | REWRITE | `Medios` colisiona con el panel Medios |
| `inspector/ClipInspector.tsx:1630` | `Ducking: bajar cuando entra la voz` | = | KEEP | claro |
| `inspector/ClipInspector.tsx:1635-1636` | hints de ducking (`Se atenúa 8 dB…`) | = | KEEP | honesto y cuantificado |
| `inspector/ClipInspector.tsx:1641-1642` | `Rol de la pista «X»:` | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:1656-1658` | `Sin rol` / `Diálogo (voz)` / `Música` / `Efectos` | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:1675` | `Restablecer efectos de audio` | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:1688` | `Velocidad de Reproducción` | `Velocidad` | REWRITE | corto |
| `inspector/ClipInspector.tsx:1693` | `Factor actual:` | `Velocidad:` | REWRITE | paridad móvil |
| `inspector/ClipInspector.tsx:1717-1719` | `0.25x` / `1x (Normal)` / `4.0x` | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:1748` | `Preservar el tono (pitch)` | `Preservar el tono` | REWRITE | fuera inglés |
| `inspector/ClipInspector.tsx:1764` | `Transiciones y Fundidos` | `Fundidos` | REWRITE | no hay transiciones |
| `inspector/ClipInspector.tsx:1770,1832` | `Fundido de Entrada (In):` / `Fundido de Salida (Out):` | `Fundido de entrada:` / `Fundido de salida:` | REWRITE | caso oración, sin `(In)` |
| `inspector/ClipInspector.tsx:1778,1804,1840,1866` | `Efecto:` / `Duración:` | = | KEEP | correcto |
| `inspector/ClipInspector.tsx:1896` | `Fundido de cruce` | = | KEEP | término canónico |
| `inspector/ClipInspector.tsx:1903-1905,1948-1950` | `«A» sale y «B» entra (0.40 s).` / `Vecino: «B»…` | = | KEEP | el mejor microcopy del panel |
| `inspector/ClipInspector.tsx:1933,1986,2011` | `Eliminar fundido` / `Crear fundido` | = | KEEP | verbo + objeto |
| `inspector/ClipInspector.tsx:2018-2019` | `La pista está bloqueada: desbloquéala para poder crear el fundido de cruce.` | = | KEEP | problema + recuperación |
| `inspector/ClipInspector.tsx:2028` | `Sin clip vecino para fundir.` | = | KEEP | estado vacío perfecto |
| `store/useProjectStore.ts:1153` | `Mi Proyecto de Video` | `Mi proyecto de vídeo` | REWRITE | caso oración + acento |
| `store/useProjectStore.ts:1145-1148` | `Texto T1` / `Video V2 (Superposición)` / `Video V1 (Principal)` / `Audio A1` | `Texto T1` / `Vídeo V2 (superposición)` / `Vídeo V1 (principal)` / `Audio A1` | REWRITE | acento + caso oración (código corto intacto) |
| `store/useProjectStore.ts:2981,2985` | `Título Nuevo` / `Pista de Texto` | `Título` / nombre `Texto T{n}` como las demás | REWRITE | paridad con botones |
| `store/useProjectStore.ts:452-454` | negativa de solape (`No se puede insertar «X» en «Y»: se solapa… Muévelo…`) | = (unificar comillas a `«»` en todo el store) | KEEP | patrón problema + recuperación |
| `store/useProjectStore.ts:1597,2010,2366,2777` | `La pista "X" está bloqueada…` | `La pista «X» está bloqueada…` | REWRITE | solo comillas |
| `store/useProjectStore.ts:2205,3208` | `"X" es audio y no puede colocarse en la pista "Y".` | `«X» es audio y no cabe en «Y»: usa una pista de audio.` | REWRITE | comillas + recuperación |
| `store/useProjectStore.ts:2823` | `Los clips copiados se solapan…` | = | KEEP | honesto |
| `store/useProjectStore.ts:2567,2613,2579` | `Selecciona un clip de audio o de vídeo.` / `Indica la duración…` | = | KEEP | imperativo preciso |
| `store/useProjectStore.ts:543,556,569` | `Selecciona sólo clips con audio/imagen…` | = | KEEP | imperativo preciso |

### U2 — Línea de tiempo

| Fichero:línea | Actual | Propuesto | V | Motivo |
|---|---|---|---|---|
| `timeline/TimelineToolbar.tsx:184,187` | `Cortar clip con un clic (herramienta de cuchilla)` / `Cuchilla` | — | DELETE | función duplicada (§1.2); la puerta es `Dividir` |
| `timeline/TimelineToolbar.tsx:194,200-204` | `Dividir clip en el cabezal (S)` / `Dividir (S)` | visible `Dividir`, aria/title `Dividir en el cabezal (S)` | REWRITE | un nombre; el visible cabe en 320 px |
| `timeline/TimelineToolbar.tsx:203` | `…(no disponible: coloca el cabezal dentro de un clip)` | `Sin clip bajo el cabezal` | REWRITE | corto; el motivo basta |
| `timeline/TimelineToolbar.tsx:215-221` | `Eliminar clip seleccionado (Supr)` / `Borrar` | aria `Eliminar clip (Supr)`, visible `Eliminar` | REWRITE | un verbo (`Eliminar` gana a `Borrar`: ya se usa en 6 sitios) |
| `timeline/TimelineToolbar.tsx:233,239` | `Imán: snapping magnético` / `Imán / Snapping magnético` | `Imán: ajuste magnético` / `Ajuste magnético` | REWRITE | fuera `snapping`; title = aria |
| `timeline/TimelineToolbar.tsx:257` | `Añadir pista` | = | KEEP | correcto |
| `timeline/TimelineToolbar.tsx:262` | `Pista` (visible) | = | KEEP | cabe con el icono `+` |
| `timeline/TimelineToolbar.tsx:349,358,367` | `+ Pista Video` / `+ Pista Audio` / `+ Pista Texto` | `Pista de vídeo` / `Pista de audio` / `Pista de texto` | REWRITE | el `+` ya lo pone el botón; caso oración |
| `timeline/TimelineToolbar.tsx:158` | `Pista de vídeo/audio/texto añadida` | = | KEEP | anuncio correcto |
| `timeline/TimelineToolbar.tsx:276,274` | `Ajustar` / `Ajustar a Pantalla (Fit to Screen)` | `Ajustar` / `Ajustar a la pantalla` | REWRITE | fuera inglés del tooltip |
| `timeline/TimelineToolbar.tsx:286-288` | `Alejar zoom` / `Alejar Zoom (-)` | `Alejar` / `Alejar la línea de tiempo` | REWRITE | no existe tecla `-`; el title mentía |
| `timeline/TimelineToolbar.tsx:299` | `Nivel de zoom del timeline` | `Zoom de la línea de tiempo` | REWRITE | español |
| `timeline/TimelineToolbar.tsx:307-310` | `Acercar zoom` / `Acercar Zoom (+)` | `Acercar` / `Acercar la línea de tiempo` | REWRITE | ídem |
| `timeline/Timeline.tsx:424-427` | `Pistas` + conteo | = | KEEP | correcto |
| `timeline/Timeline.tsx:446-447,452` | `Seleccionar todos los clips` / `Seleccionar todo (Ctrl+A)` / `Seleccionar todo` | = | KEEP | reubicado y con atajo |
| `timeline/TrackHeader.tsx:151,156` | badge corto + nombre con `title` | = | KEEP | estrategia §1.4 |
| `timeline/TrackHeader.tsx:182-183` | `Ocultar pista` / `Mostrar pista` | = | KEEP | correcto |
| `timeline/TrackHeader.tsx:201-202` | `Activar audio` / `Silenciar pista` | `Activar sonido` / `Silenciar pista` | REWRITE | paridad de patrón |
| `timeline/TrackHeader.tsx:223-224` | `Bloquear pista` / `Desbloquear pista` | = | KEEP | correcto |
| `timeline/TrackHeader.tsx:240-241` | `Opciones de pista` | = | KEEP | correcto |
| `timeline/TrackHeader.tsx:329,351,373,393` | `Duplicar pista` / `Subir pista` / `Bajar pista` / `Eliminar pista` | = | KEEP | verbo + objeto, los cuatro |
| `timeline/ClipItem.tsx:709-711` | `Clip X, duración …` (+ `, seleccionado`) | = | KEEP | aria completa |
| `timeline/ClipItem.tsx:838,849` | `Recortar inicio de X` (+ title con ayuda de teclado) | = | KEEP | `recortar` es el término (§3) |
| `timeline/ClipItem.tsx:974,985` | `Recortar final de X` | = | KEEP | ídem |
| `timeline/ClipItem.tsx:870-872` | badge `FADE` + `Transición activa` | badge `Fundido` + `Fundido activo` | REWRITE | español + término canónico |
| `timeline/ClipItem.tsx:794,818` | `Fade In: tipo (0.8s)` / `Fade Out: …` (titles) | `Fundido de entrada: tipo (0,8 s)` / `Fundido de salida: …` | REWRITE | español + coma decimal + espacio |
| `timeline/ClipItem.tsx:803,828` | `▲ In` / `▼ Out` | `▲ Entrada` / `▼ Salida` | REWRITE | español |
| `timeline/ClipItem.tsx:884-885` | `El archivo de este medio no está disponible…` / `…no se puede decodificar…` | `Este medio no está disponible…` / `Este medio no se puede decodificar…` | REWRITE | `medio`, no `archivo` |
| `timeline/ClipItem.tsx:894` | `medio ausente` / `error de medio` | = | KEEP | preciso |
| `timeline/ClipItem.tsx:918-920,939,951,962` | `Copiar X` / `Copiar` / `Pegar` / `Duplicar` | `Pegar en X` → `Pegar` (resto =) | REWRITE | `Pegar` no necesita destino: ya está situado |
| `timeline/ClipItem.tsx:925` | `Acciones de portapapeles del clip` | = | KEEP | correcto |

### U3 — Bin (medios, papelera, almacenamiento)

| Fichero:línea | Actual | Propuesto | V | Motivo |
|---|---|---|---|---|
| `media/MediaBin.tsx:415-416` | `Panel de Medios` + `(N)` | `Medios (N)` | REWRITE | `panel` sobra |
| `media/MediaBin.tsx:425` | `Importar` | = | KEEP | verbo exacto |
| `media/MediaBin.tsx:451` | `Generar Clips de Prueba (1-Click)` | `Generar clips de prueba` | REWRITE | sin marketing ni inglés |
| `media/MediaBin.tsx:446` | `Generando clips de muestra en el navegador...` | `Generando clips…` | REWRITE | el dónde es irrelevante |
| `media/MediaBin.tsx:464` | `Descartar error` | `Cerrar aviso` | REWRITE | unificar con el banner |
| `media/MediaBin.tsx:485` | `Importando y extrayendo fotogramas...` | = | KEEP | factual |
| `media/MediaBin.tsx:495-497` | `Arrastra videos, audios o fotos aquí` + `o haz clic para importar` + `100% privado…` | `Sin medios` + `Arrastra archivos o impórtalos` + botón `Importar` + tenue `Se guarda solo en este navegador` | REWRITE | titular + acción (§1.6) |
| `media/MediaBin.tsx:519` | `Medios ausentes (N)` | = | KEEP | término preciso |
| `media/MediaBin.tsx:542` | `Revincular` (+ `Revincular X`) | = | KEEP | verbo exacto |
| `media/MediaBin.tsx:564` | `Papelera (N)` | = | KEEP | término estándar |
| `media/MediaBin.tsx:580` | `Vaciar` / `Confirmar` | = | KEEP | confirmación en dos pasos, bien |
| `media/MediaBin.tsx:595` | `N clip(s)` | `N clips` (ternario como galería) | REWRITE | paréntesis de programador |
| `media/MediaBin.tsx:605` | `Restaurar` | = | KEEP | verbo exacto |
| `media/MediaBin.tsx:611-612` | `Borrar X para siempre` | = | KEEP | irreversible, dicho claro |
| `media/MediaBin.tsx:641` | `Almacenamiento` | = | KEEP | correcto |
| `media/MediaBin.tsx:665-667` | `X de Y` / `Espacio usado: no disponible` | = | KEEP | honesto |
| `media/MediaBin.tsx:709-710` | `Este navegador no permite consultar el espacio disponible (puede estar en modo privado).` | = | KEEP | honestidad radical ejemplar |
| `media/MediaBin.tsx:717-737` | `Proyectos` / `Medios` / `Tamaño` / `Papelera` | = | KEEP | correcto |
| `media/MediaBin.tsx:760-762` | `Vaciar papelera (N)` / `Confirmar: vaciar papelera` | = | KEEP | correcto |
| `media/MediaBin.tsx:771,778` | `Crear una copia de seguridad…` / `Copia de seguridad (con medios)` | `Crear copia de seguridad` | REWRITE | corto |
| `media/MediaBin.tsx:276,295-304` | `Papelera vaciada: N medio(s) borrados del disco.` + mensajes de copia | `Papelera vaciada: N medios borrados.` (resto =) | REWRITE | sin paréntesis ni `disco` (es el navegador) |
| `media/MediaBin.tsx:388` | `No se pudo revincular el archivo: revisa que sea un archivo de vídeo, audio o imagen válido.` | `No se pudo revincular: usa un archivo de vídeo, audio o imagen válido.` | REWRITE | corto |
| `media/MediaItemCard.tsx:54` | `X: pulsa para añadir a la línea de tiempo` | `X: añadir a la línea de tiempo` | REWRITE | `pulsa` excluye teclado |
| `media/MediaItemCard.tsx:81` | `El archivo de este medio no está disponible` / `…no se puede decodificar` | `Este medio no está disponible` / `Este medio no se puede decodificar` | REWRITE | `medio`, no `archivo` |
| `media/MediaItemCard.tsx:109-110` | `Añadir a la línea de tiempo` / `Añadir X a la línea de tiempo` | = | KEEP | puerta canónica |
| `media/MediaItemCard.tsx:106-113` | botón `+` flotante (hover) | — | DELETE | puerta duplicada (§1.2) |
| `media/MediaItemCard.tsx:122-123` | `Mover a la papelera (se puede restaurar)` | = | KEEP | dice la recuperación |
| `media/MediaItemCard.tsx:152` | `Añadir` | = | KEEP | puerta canónica visible |
| `media/MediaItemCard.tsx:161` | `Espacio que ocupa este archivo en el almacenamiento del navegador` | `Espacio que ocupa en este navegador` | REWRITE | corto |
| `core/storage/projectStorage.ts:135-136` | `Almacenamiento lleno: no se pudo guardar…` / `No se pudo guardar el proyecto. Tu trabajo puede perderse…` | = | KEEP | problema + recuperación |
| `core/storage/projectStorage.ts:1642` | `Queda poco espacio (X %): vacía la papelera…` | = | KEEP | aviso accionable |

### U4 — Visor y transporte

| Fichero:línea | Actual | Propuesto | V | Motivo |
|---|---|---|---|---|
| `player/PreviewPlayer.tsx:236` | `Monitor vacío: importa medios para empezar` / `Monitor: N clips en el timeline` | = | KEEP | `monitor` es el término (§3) |
| `player/PreviewPlayer.tsx:247-250` | `Timeline vacío` + `Importa videos o genera clips de prueba para verlos aquí.` | `Sin clips` + `Añade un clip para empezar a editar.` | REWRITE | titular + imperativo (§1.6) |
| `player/PlayerControls.tsx:117-118` | `Ir al inicio (Home)` / `Ir al inicio de la línea de tiempo` | `Ir al inicio` (ambos) | REWRITE | title = aria; `Home` solo existe con teclado (iría en Atajos) |
| `player/PlayerControls.tsx:126-127` | `Retroceder 1 cuadro (←)` / `Retroceder 1 fotograma` | `Retroceder 1 fotograma` (ambos) | REWRITE | un término |
| `player/PlayerControls.tsx:139-140` | `Pausar (Espacio)` / `Reproducir (Espacio)` | = | KEEP | atajo explícito |
| `player/PlayerControls.tsx:149-150` | `Avanzar 1 cuadro (→)` / `Avanzar 1 fotograma` | `Avanzar 1 fotograma` (ambos) | REWRITE | un término |
| `player/PlayerControls.tsx:161-162` | `Activar sonido`/`Silenciar` + `…sonido maestro` | `Activar sonido`/`Silenciar` + `…sonido general` | REWRITE | fuera `maestro` |
| `player/PlayerControls.tsx:173,175` | `Volumen maestro` / `Volumen general` | `Volumen general` (ambos) | REWRITE | un término |

### U5 — Móvil

| Fichero:línea | Actual | Propuesto | V | Motivo |
|---|---|---|---|---|
| `mobile/MobileHeader.tsx:118-119` | `Ir a HydraApps Hub` / `Ir al hub de HydraApps` | `Volver al Hub` (ambos) | REWRITE | paridad con escritorio |
| `mobile/MobileHeader.tsx:126-127` | `Mis Proyectos` | `Proyectos` (aria `Abrir proyectos`) | REWRITE | paridad + caso |
| `mobile/MobileHeader.tsx:135,137` | `Nombre del proyecto` / `Renombrar proyecto` | = | KEEP | correcto |
| `mobile/MobileHeader.tsx:152,155` | `Relación de aspecto: X. Cambiar` / `Cambiar relación de aspecto` | = | KEEP | correcto |
| `mobile/MobileHeader.tsx:169-184` | `Deshacer` / `Rehacer` | = | KEEP | correcto (sin atajo: no hay teclado) |
| `mobile/MobileHeader.tsx:195-197` | `Atajos de teclado` / `Atajos` | `Atajos de teclado` (ambos) | REWRITE | unificar |
| `mobile/MobileHeader.tsx:205-207` | `Abrir guía de inicio` / `Guía de inicio` | = | KEEP | correcto |
| `mobile/MobileHeader.tsx:215,220` | `Abrir modal de exportación de vídeo` / `Exportar` (+ `Sparkles` pulsante) | `Exportar vídeo` / `Exportar` (+ `Download`, sin pulso) | REWRITE | aria = acción; sin movimiento |
| `mobile/MobileHeader.tsx:97-101` | `9:16 Shorts/Reels` / `16:9 Panorámico` / `1:1 Cuadrado` | `9:16 Vertical` / `16:9 Panorámico` / `1:1 Cuadrado` | REWRITE | `Shorts/Reels` son marcas de terceros |
| `mobile/MobileBottomBar.tsx:97-98,112-113` | `Dividir clip` / `Dividir en cabezal` (+ variantes no disponible) | `Dividir` visible; aria `Dividir en el cabezal` / `Sin clip bajo el cabezal` | REWRITE | un nombre (§1.2) |
| `mobile/MobileBottomBar.tsx:148-152` | `Deseleccionar` / `Deseleccionar clip…` / `Volver` | `Quitar la selección` (aria) / `Cerrar` (visible) | REWRITE | `Volver` promete navegación |
| `mobile/MobileBottomBar.tsx:159-164` | `Propiedades del clip` / `Ajustes` | `Abrir el inspector` / `Inspector` | REWRITE | un nombre (§1.2) |
| `mobile/MobileBottomBar.tsx:174-178` | `Velocidad` | = | KEEP | correcto |
| `mobile/MobileBottomBar.tsx:185-189` | `Volumen` | = | KEEP | correcto |
| `mobile/MobileBottomBar.tsx:196-200` | `Transiciones` / `Animaciones y transiciones` / `Animación` | `Fundidos` / `Fundidos del clip` / `Fundido` | REWRITE | no hay transiciones (§3) |
| `mobile/MobileBottomBar.tsx:207-211` | `Opacidad` | = | KEEP | correcto |
| `mobile/MobileBottomBar.tsx:218-222` | `Eliminar clip` / `Eliminar` | = | KEEP | verbo canónico |
| `mobile/MobileBottomBar.tsx:132` | `¿Eliminar el clip seleccionado? Puedes deshacer esta acción.` | `¿Eliminar este clip? Puedes deshacerlo.` | REWRITE | corto; sin `Ctrl+Z` (no hay teclado) |
| `mobile/MobileBottomBar.tsx:232-238` | `Añadir Medios` / `Abrir biblioteca de medios` / `Medios` | `Añadir medios` / `Abrir medios` / `Medios` | REWRITE | caso oración + corto |
| `mobile/MobileBottomBar.tsx:245-251` | `Texto` / `Añadir capa de texto` / `Texto` | aria → `Añadir texto` | REWRITE | fuera `capa` |
| `mobile/MobileBottomBar.tsx:259-266` | `Audio` / `Abrir panel de audio` / `Audio` | aria → `Abrir audio` | REWRITE | corto |
| `mobile/MobileBottomSheet.tsx:72-73` | `Cerrar` / `Cerrar panel` | `Cerrar` (ambos) | REWRITE | title = aria |
| `mobile/MobilePreviewPlayer.tsx:448-452` | `Timeline vacío` + `Importa videos o genera…` | `Sin clips` + `Añade un clip para empezar a editar.` | REWRITE | paridad con escritorio |
| `mobile/MobilePreviewPlayer.tsx:459-460` | `Pantalla Completa` | `Pantalla completa` | REWRITE | caso oración |
| `mobile/MobilePreviewPlayer.tsx:471-472,506,514` | `Pausar` / `Reproducir` | = | KEEP | correcto |
| `mobile/MobilePreviewPlayer.tsx:497-498` | `Ir al inicio` | = | KEEP | correcto |
| `mobile/MobilePreviewPlayer.tsx:525-533` | `Cortar clip aquí` / `Dividir clip en el cabezal` / `Dividir` | `Dividir en el cabezal` (title = aria) / `Dividir` | REWRITE | un nombre |
| `mobile/MobilePreviewPlayer.tsx:539` | `Precisión de fotograma y volumen maestro` | `Fotograma y volumen` | REWRITE | corto, sin `maestro` |
| `mobile/MobilePreviewPlayer.tsx:543-555` | `Retroceder/Avanzar 1 cuadro` vs `…1 fotograma` | `…1 fotograma` (los cuatro) | REWRITE | un término |
| `mobile/MobilePreviewPlayer.tsx:561-562,574-575` | `…sonido maestro` / `Volumen maestro` / `Volumen general` | `…sonido general` / `Volumen general` | REWRITE | fuera `maestro` |
| `mobile/MobileCapCutLayout.tsx:146-160` | títulos de hoja (7) | `Medios` / `Audio` / `Texto` / `Velocidad` / `Volumen` / `Fundidos` / `Inspector` | REWRITE | cortos, un término (§1.1) |
| `mobile/MobileCapCutLayout.tsx:229` | `Archivos de audio de tu biblioteca. Toca uno para insertarlo en el cabezal.` | `Archivos de audio. Selecciona uno para insertarlo en el cabezal.` | REWRITE | sin segunda persona ni `toca` |
| `mobile/MobileCapCutLayout.tsx:241` | `Crear pista de audio` / `Ir a la pista de audio` | = | KEEP | correcto |
| `mobile/MobileCapCutLayout.tsx:247-256` | `No hay audio importado` + `…desde la biblioteca de medios.` + `Abrir biblioteca de medios` | titular = · `Abrir medios` | REWRITE | corto |
| `mobile/MobileCapCutLayout.tsx:273` | `Selecciona un estilo de texto para insertar en la posición actual del cabezal:` | `Elige un estilo: se inserta en el cabezal.` | REWRITE | corto |
| `mobile/MobileCapCutLayout.tsx:288-289,304-305` | `Título Grande` / `Aperturas y destacados` / `Subtítulo / Rótulo` / `Explicaciones o créditos` | `Título` / `Aperturas y destacados` / `Subtítulo` / `Explicaciones o créditos` | REWRITE | paridad escritorio |
| `mobile/MobileCapCutLayout.tsx:332,382,545` | `Velocidad actual:` / `Nivel de Ganancia:` / `Opacidad:` | `Velocidad:` / `Volumen:` / `Opacidad:` | REWRITE | paridad inspector |
| `mobile/MobileCapCutLayout.tsx:359,401-403` | `1x (Normal)` / `0% (Silencio)` / `100% (Normal)` / `200% (Amplificado)` | = | KEEP | correcto |
| `mobile/MobileCapCutLayout.tsx:416,479` | `Efecto de Entrada (Fade In):` / `Efecto de Salida (Fade Out):` | `Fundido de entrada:` / `Fundido de salida:` | REWRITE | término canónico |
| `mobile/MobileCapCutLayout.tsx:448-449,511-512` | `Duración de entrada:` / `Duración de salida:` | = | KEEP | correcto |
| `mobile/MobileCapCutLayout.tsx:574-582` | `Ningún clip seleccionado` + `Toca un clip…` + `Cerrar panel` | titular = · `Selecciona un clip para ajustar sus propiedades.` · `Cerrar` | REWRITE | sin `toca`; botón corto |

### U6 — Diálogos (exportar, galería, bienvenida, atajos)

| Fichero:línea | Actual | Propuesto | V | Motivo |
|---|---|---|---|---|
| `export/ExportModal.tsx:759` | `Exportar video` (aria) | `Exportar vídeo` | REWRITE | acento |
| `export/ExportModal.tsx:775-786` | título triple + subtítulo de marketing | título `Exportar vídeo` + subtítulo según capacidad (§1.7) | REWRITE | el título no cambia con el estado |
| `export/ExportModal.tsx:811-818` | insignia de marketing | insignias factuales (§1.7) | REWRITE | informar, no vender |
| `export/ExportModal.tsx:826-828` | `Formato de exportación:` | `Formato:` | REWRITE | corto |
| `export/ExportModal.tsx:834,848` | `Exportar en formato MP4 (acelerado por GPU)` / `…WebM (respaldo en tiempo real)` | `Formato MP4 (H.264 por GPU)` / `Formato WebM (tiempo real)` | REWRITE | nombra el formato, no la acción |
| `export/ExportModal.tsx:859-870` | nota WebM (larga, correcta) | `WebM se graba en tiempo real: 10 s de proyecto tardan 10 s. Sin GPU.` | REWRITE | ejemplo concreto |
| `export/ExportModal.tsx:877` | `Preajustes de exportación:` | `Preajuste:` | REWRITE | corto |
| `export/ExportModal.tsx:888,896-898` | `Web` / `Social 1080p` / `Vertical 1080×1920` / `Alta calidad` + hints | = | KEEP | un clic = cuatro ajustes, bien explicado |
| `export/ExportModal.tsx:910,914-916` | `Resolución:` + `720p HD` / `1080p FHD` / `4K UHD` | = | KEEP | estándar |
| `export/ExportModal.tsx:949-950` | `Tasa de Cuadros (FPS):` + `30 FPS` / `60 FPS` | `Fotogramas por segundo:` + `30 FPS` / `60 FPS` | REWRITE | español |
| `export/ExportModal.tsx:972-973,981` | `Tasa de Bits (Calidad):` + `8 Mbps` | `Calidad:` + `8 Mbps` (aria `Calidad en megabits por segundo`) | REWRITE | `bitrate` es jerga en etiqueta |
| `export/ExportModal.tsx:990,1004,1017` | `Rango de exportación:` + `Todo el proyecto` + `Rango personalizado` | `Rango:` + = + = | REWRITE | etiqueta corta |
| `export/ExportModal.tsx:1030,1038` | `Marcar entrada` / `Marcar salida` | = | KEEP | imperativo mínimo |
| `export/ExportModal.tsx:1042` | `Cabezal de reproducción: …` | = | KEEP | término canónico completo |
| `export/ExportModal.tsx:1056` | `Exportando 00:00:05:00 → 00:00:12:00 (7 s)` / `Exportando el proyecto completo` | = | KEEP | timecode + duración, perfecto |
| `export/ExportModal.tsx:1063-1071` | `Duración de exportación:` / `Total de fotogramas:` / `Clips en el timeline:` | `Duración:` / `Fotogramas:` / `Clips:` | REWRITE | el contexto sobra |
| `export/ExportModal.tsx:1085` | `Añade al menos un clip al timeline antes de exportar.` | `No hay nada que exportar. Añade un clip a la línea de tiempo.` | REWRITE | titular + `línea de tiempo` |
| `export/ExportModal.tsx:1104-1107` | `Grabando en tiempo real con MediaRecorder...` / `Codificando fotogramas con GPU...` / `Generando archivo WebM/MP4 final...` / `¡Exportación exitosa!` / `Error al exportar` | `Grabando en tiempo real…` / `Codificando…` / `Generando el WebM…` / `Generando el MP4…` / `Exportación lista` / `Error al exportar` | REWRITE | corto; `¡…!` sobra; ellipsis `…` |
| `export/ExportModal.tsx:1130,1137,1162,1166` | `Cuadro actual:` / `Tiempo restante:` / `Tamaño del archivo:` / `Bitrate efectivo:` | `Fotograma:` / = / = / = | REWRITE | un término |
| `export/ExportModal.tsx:116-117,121` | `Tu video MP4 ha sido descargado automáticamente.` / `Has pedido MP4, pero este navegador no puede grabar MP4: se ha descargado un archivo WebM.` | `Vídeo MP4 descargado.` / `Pediste MP4, pero este navegador no graba MP4: se ha descargado un WebM.` | REWRITE | hecho consumado, sin `automáticamente` |
| `export/ExportModal.tsx:1192,1207,1216,1228` | `Cancelar` / `Comenzar Exportación` / `Cancelar Exportación` / `Cerrar` | `Cancelar` / `Exportar` / `Cancelar exportación` / `Cerrar` | REWRITE | el verbo del diálogo es `Exportar` |
| `export/ExportModal.tsx:794` | `Cerrar modal de exportación` | `Cerrar` | REWRITE | corto |
| `modals/ProjectsModal.tsx:363-364` | `Suelta tu archivo de proyecto` + `Admite archivos .hydra y .json de HydraCut` | `Suelta el archivo` + = (sin `tu`) | REWRITE | sin segunda persona |
| `modals/ProjectsModal.tsx:376-382` | `Mis Proyectos` + contador + subtítulo de privacidad | `Mis proyectos` + contador + `Se guarda solo en este navegador` | REWRITE | caso + hecho |
| `modals/ProjectsModal.tsx:390-391` | `Cerrar modal (Esc)` / `Cerrar ventana de proyectos` | `Cerrar (Esc)` / `Cerrar` | REWRITE | corto |
| `modals/ProjectsModal.tsx:408,417` | `Nuevo Proyecto` / `Importar (.hydra / .json)` | `Nuevo proyecto` / = | REWRITE | caso oración |
| `modals/ProjectsModal.tsx:436` | `Buscar proyecto por nombre...` | = | KEEP | correcto |
| `modals/ProjectsModal.tsx:448-454` | vacía con/sin búsqueda | `Sin proyectos` + `Crea uno o arrastra un .hydra / .json.` + `Crear proyecto` (con búsqueda =) | REWRITE | titular + acción |
| `modals/ProjectsModal.tsx:500,507,523` | `Guardar nombre` / `Cancelar` / `Renombrar proyecto` | `Guardar` / = / = | REWRITE | corto |
| `modals/ProjectsModal.tsx:560-561` | `Modificado:` | = | KEEP | correcto |
| `modals/ProjectsModal.tsx:569-571,578-581` | `Abierto` / `Cargar y abrir proyecto` / `Cargar` | `Abierto` / `Abrir proyecto` / `Abrir` | REWRITE | un verbo (`abrir`); badge `En Edición` DELETE |
| `modals/ProjectsModal.tsx:593-594,614,628-629` | `Duplicar proyecto X` / `Exportar X` / `Eliminar proyecto X` | = | KEEP | verbo + objeto con nombre |
| `modals/ProjectsModal.tsx:617` | `Exportar archivo de proyecto` | = | KEEP | correcto |
| `modals/ProjectsModal.tsx:651-653` | `¿Eliminar Proyecto?` + `Estás a punto de eliminar "X". Esta acción no se puede deshacer.` | `¿Eliminar proyecto?` + `«X» se borrará para siempre. No se puede deshacer.` | REWRITE | caso + comillas + directo |
| `modals/ProjectsModal.tsx:664,671` | `Cancelar` / `Eliminando...` / `Sí, Eliminar` | `Cancelar` / `Eliminando…` / `Eliminar` | REWRITE | ellipsis + verbo solo |
| `modals/ProjectsModal.tsx:717-726` | `Archivo .hydra` / `Nativo` / `Archivo .json` / `JSON` | = | KEEP | formato + rol, bien |
| `modals/WelcomeModal.tsx:109` | `Bienvenido a HydraCut` | = | KEEP | correcto |
| `modals/WelcomeModal.tsx:120-121` | `Continuar (Esc)` / `Cerrar y continuar` | = | KEEP | correcto |
| `modals/WelcomeModal.tsx:128-129` | `HydraCut Studio` + `¿Qué quieres hacer hoy?` | + subtítulo `Elige cómo empezar` y línea `Tus vídeos no salen de este navegador.` | REWRITE | de charla a herramienta + pilar |
| `modals/WelcomeModal.tsx:138` | `Último proyecto` | = | KEEP | correcto |
| `modals/WelcomeModal.tsx:166-167,179-180,192-193` | `Seguir editando` / `Continúa donde lo dejaste` / `Nuevo proyecto en blanco` / `El actual queda guardado` / `Abrir o importar…` / `Galería y archivos .hydra / .json` | = | KEEP | tres puertas claras |
| `modals/WelcomeModal.tsx:202` | `Recientes` | = | KEEP | correcto |
| `modals/ShortcutsModal.tsx:29-42` | 14 descripciones | `S` → `Dividir el clip en el cabezal (S)`; `Ctrl + Rueda` → `Acercar o alejar la línea de tiempo`; `Home` → `Ir al inicio de la línea de tiempo`; `Esc` → `Cerrar el diálogo o quitar la selección`; `Espacio` → `Reproducir o pausar` (resto =) | REWRITE | sin `timeline`, sin `modal`, sin `Zoom in/out` |
| `modals/ShortcutsModal.tsx:62,66,91` | `Atajos de Teclado` / `Cerrar modal de atajos` / `Entendido` | `Atajos de teclado` / `Cerrar` / `Cerrar` | REWRITE | caso + verbo único |

---

## 3. Glosario de vocabulario (Concept → Spanish → forbidden)

| Concepto | Término canónico | Prohibidos |
|---|---|---|
| clip | **clip** | fragmento, elemento, segmento, parte |
| pista | **pista** (`pista de vídeo`, `pista de audio`, `pista de texto`) | track, capa, canal |
| medio | **medio** (pieza de la biblioteca) | archivo (para piezas), elemento, asset, recurso |
| proyecto | **proyecto** | documento, sesión, trabajo |
| selección | **selección** (`N clips seleccionados`, `quitar la selección`) | marcado, resaltado |
| cabezal de reproducción | **cabezal de reproducción** (forma corta: **cabezal**) | playhead, cursor, aguja, cabezal lector |
| regla de tiempo | **regla de tiempo** | timeline superior, ruler |
| trimming | **recortar** (`recortar inicio/final`) | trim, recorte como sustantivo inglés, ajustar bordes |
| fundido | **fundido** (`fundido de entrada/salida/de cruce`) | fade, transición (para fundidos), fundido cruzado |
| transición | **transición** (reservado; hoy no existe ninguna en el producto: no usar) | — (no aplicar a fundidos) |
| exportar | **exportar** (UI) | renderizar, generar (como verbo de export), producir |
| renderizar | prohibido en UI (solo código) | render, renderizado |
| preajuste | **preajuste** | preset, plantilla, perfil, ajuste rápido |
| Inspector | **Inspector** | propiedades, ajustes (como nombre), inspector de clip |
| panel de medios | **Medios** | panel de medios, biblioteca (como título), bin |
| línea de tiempo | **línea de tiempo** | timeline (en español), pista principal, cronología |
| monitor | **monitor** (lienzo de vista previa) | preview, vista previa (como sustantivo), visor, pantalla |
| fundido de cruce | **fundido de cruce** | crossfade, mezcla, disolvencia |
| velocidad | **velocidad** | tempo, ritmo, factor (como etiqueta), speed |
| opacidad | **opacidad** | transparencia (como etiqueta), alpha |
| volumen | **volumen** (general para maestro) | gain, ganancia (como etiqueta), maestro, nivel |
| fotograma | **fotograma** | cuadro, frame, fps como sustantivo suelto |
| política de solapamiento | **política de solapamiento** | overlap, solapación |
| papelera | **papelera** | basura, eliminados, trash |
| revincular | **revincular** | reconectar, relink, reasociar |
| formato | **formato** (MP4/WebM; también relación de aspecto en su contexto) | container, contenedor, codec como formato |
| solicito→listo | **listo** (`Exportación lista`) | exitoso con `¡…!`, completado con júbilo |
| mezcla de audio | **paneo**, **ecualizador** (`graves, medias, agudos`), **ducking** | balance, EQ (como etiqueta), atenuación automática |

Sinónimos a migrar (una línea): `clip=clip; pista≠track/capa; medio≠archivo/elemento; proyecto≠documento;
cabezal≠playhead; recortar≠trim; fundido≠fade/transición; exportar≠renderizar; preajuste≠preset/plantilla;
Inspector≠propiedades/ajustes; Medios≠panel/biblioteca; línea de tiempo≠timeline; monitor≠preview/visor;
fotograma≠cuadro; volumen general≠maestro; tono≠pitch; desplazar≠ripple; medias≠medios (EQ).`

---

## 4. Reglas de tono (con antes/después reales)

1. **La herramienta informa; no vende.** Nada de promesas de landing dentro del producto.
   Antes: `100% acelerado en el cliente (GPU nativa)` (`ExportModal.tsx:785`).
   Después: `H.264 por GPU (WebCodecs)`. Si el navegador no puede, se dice:
   `Este navegador no codifica H.264: el archivo será WebM.`
2. **El verbo nombra la acción; un nombre por función.** Nada de metáforas de ferretería ni
   duplicados. Antes: `Cuchilla` + `Dividir (S)` (`TimelineToolbar.tsx:187,207`).
   Después: `Dividir` (un botón, en el cabezal, tecla `S`). Igual con `+` / `Añadir` / clic:
   la puerta visible se llama `Añadir`.
3. **Un concepto, una palabra, en toda la app.** Antes: `cuadro` (tooltip) vs `fotograma`
   (aria) en `PlayerControls.tsx:126-127`; `capa` vs `pista`; `preset` vs `plantilla`.
   Después: `fotograma`, `pista`, `preajuste` — siempre (§3).
4. **Caso oración, español completo, sin inglés de adorno.** Antes: `Atajos de Teclado`,
   `Ajustar a Pantalla (Fit to Screen)`, badge `FADE`, `Generar Clips de Prueba (1-Click)`.
   Después: `Atajos de teclado`, `Ajustar a la pantalla`, `Fundido`, `Generar clips de prueba`.
5. **El error nombra el problema y la recuperación.** Modelo a imitar (ya existe):
   `No se puede insertar «X» en «Y»: se solapa con… Muévelo a otro momento o cambia la política
   de solapamiento…` (`useProjectStore.ts:452-454`). Lo contrario: `alert('Error al crear
   proyecto: ' + msg)` — el texto vale, el `alert` bloqueante no (migrar a toast).
6. **El estado vacío es titular + una acción, sin segunda persona.** Antes: `Timeline vacío` /
   `Importa videos o genera clips de prueba para verlos aquí.` (`PreviewPlayer.tsx:247-250`).
   Después: `Sin clips` / `Añade un clip para empezar a editar.` Y `haz clic` / `toca` se
   sustituyen por `selecciona` (vale para ratón, dedo y teclado).
7. **Unidades y atajos, explícitos y con aire.** `48px` → `48 px`, `0.8s` → `0,8 s`
   (coma decimal), `Deshacer` → `Deshacer (Ctrl+Z)`. Lo que no existe no se cita: `(-)`/`(+)`
   en el zoom se eliminan porque no hay tales teclas.
8. **Sin marcas ajenas ni paréntesis de programador.** `Karaoke Progresivo (Apple Music)` →
   `Karaoke`; `9:16 Shorts/Reels` → `9:16 Vertical`; `N clip(s)` → `N clips`;
   `Comenzando…` con `...` de tres puntos → `…` de uno.
