# 🎬 HydraCut Studio — Technical Architecture & Developer Guide

> **HydraCut Studio** es un editor de video multitrack profesional, acelerado por hardware y ejecutado **100% en el cliente** mediante WebCodecs API, Web Audio API y Canvas rendering a 60 FPS. Ofrece una experiencia de escritorio avanzada (*Desktop Studio*) y una interfaz móvil táctil adaptativa inspirada en **CapCut**, con persistencia local multi-proyecto y exportación directa a contenedor MP4 sin servidores.

[![App](https://img.shields.io/badge/HydraCut-Studio-blue)](#)
[![Client-Side](https://img.shields.io/badge/Architecture-100%25%20Client--Side-emerald)](#)
[![WebCodecs](https://img.shields.io/badge/Pipeline-WebCodecs%20GPU-cyan)](#)
[![Storage](https://img.shields.io/badge/Persistence-IndexedDB%20%2B%20OPFS-purple)](#)
[![Testing](https://img.shields.io/badge/Tests-Vitest%20%2B%20Puppeteer-success)](#)

---

## 📑 Tabla de Contenidos

1. [Arquitectura del Motor Multimedia](#1-arquitectura-del-motor-multimedia)
2. [Gestión de Estado con Zustand](#2-gestión-de-estado-con-zustand)
3. [Motor de Timeline Multitrack](#3-motor-de-timeline-multitrack)
4. [Persistencia Multi-Proyecto e IndexedDB](#4-persistencia-multi-proyecto-e-indexeddb)
5. [Especificaciones de Diseño Móvil CapCut](#5-especificaciones-de-diseño-móvil-capcut)
6. [Atajos de Teclado](#6-atajos-de-teclado)
7. [Guía de Pruebas y Verificación](#7-guía-de-pruebas-y-verificación)
8. [Estructura del Código Fuente](#8-estructura-del-código-fuente)

---

## 1. Arquitectura del Motor Multimedia

El núcleo de HydraCut reside en `src/core/` y opera de forma desacoplada de la jerarquía de renderizado de React para alcanzar 60 FPS consistentes sin caídas de cuadros.

```
                          +------------------------------------+
                          |       MasterClock.ts               |
                          |  - AudioContext.currentTime (Sync) |
                          +------------------------------------+
                                      |              |
                      Playback Sync   |              |  Audio Scheduling
                                      v              v
+-------------------------------+          +-------------------------------+
|       Compositor.ts           |          |        AudioEngine.ts         |
|  - Canvas 60 FPS Rendering    |          |  - Web Audio Graph            |
|  - Painter's Algorithm        |          |  - GainNodes & Mute           |
|  - Video, PiP & Text Layers   |          |  - Multi-track mixing         |
+-------------------------------+          +-------------------------------+
                |                                          |
                +--------------------+---------------------+
                                     |
                                     v
+--------------------------------------------------------------------------+
|                       webcodecsExporter.ts                               |
|  - OffscreenCanvas frame rendering                                       |
|  - VideoEncoder (AVC1 / H.264 Hardware Acceleration)                     |
|  - AudioEncoder (AAC u Opus según plataforma)                          |
|  - Backpressure flow control (encodeQueueSize <= 3)                      |
|  - Zero-leak memory safety: frame.close() & audioData.close()            |
|  - Direct container muxing via mp4-muxer                                 |
+--------------------------------------------------------------------------+
```

### 1.1. Compositor en Canvas (`src/core/engine/Compositor.ts`)
* **Jerarquía de Capas (Painter's Algorithm):** Dibuja primero las pistas de video base en orden ascendente, seguidas de pistas Picture-in-Picture (PiP), y finalmente las capas de texto estilizado, subtítulos y animaciones tipográficas.
* **Procesamiento de Cuadros en Tiempo Real:** Realiza muestreo de frames sincronizados desde `MediaSourcePool.ts`, aplicando transformaciones geométricas (escala, posición `X/Y`, opacidad `0-1`) y efectos de transición (`fade-black`, `fade-white`, `slide-left`, `wipe-right`).
* **Dimensiones Normalizadas:** Garantiza que las dimensiones enviadas a la GPU sean pares (múltiplos de 2), requisito técnico estricto de codificadores de hardware H.264/AVC.
* **Rasterizado a la resolución de pantalla (`computeRenderScale`):** el lienzo de previsualización ya **no** está cableado a la resolución del proyecto. `computeRenderScale()` calcula el *backing store* a partir del tamaño real del lienzo en pantalla y del `devicePixelRatio`; el compositor dibuja el espacio lógico del proyecto escalado a esa matriz. Antes, un preview de 200×110 px rasterizaba 1920×1080 (hasta 100× más píxeles de los que la pantalla puede mostrar) a 60 FPS. Un `ResizeObserver` recalcula la escala al cambiar el tamaño de la ventana, la rotación o el `devicePixelRatio`.
* **Fundido de cruce real (`src/core/utils/crossfade.ts`):** mezcla lineal entre clips contiguos de la misma pista (`crossfadeMix`, `crossfadeOutGain`/`crossfadeInGain`). El solape solo es deliberado cuando ambos clips llevan los marcadores (`crossfadeOutDuration` en el anterior, `crossfadeInDuration` en el posterior) y `isDeliberateCrossfadeOverlap()` lo confirma; cualquier otro solape sigue siendo ilegal según la política de solapamiento (§2.1). Duración por defecto `CROSSFADE_DEFAULT_DURATION = 0.5 s`, cuantizada a frames.
* **Filtros de color por clip (`src/core/utils/colorFilters.ts`):** brillo, contraste, saturación, temperatura, B/N (`grayscale`) y sepia, con 7 preajustes (`COLOR_FILTER_PRESETS`: Original, Cálido, Frío, B/N, Sepia, Cine, Vívido). Los aplica el `Compositor`, el único camino de dibujo: preview y exportación comparten el código y no pueden divergir.
* **Keyframes de transform (`src/core/utils/keyframes.ts`):** animación de `x`, `y`, `scale` y `opacity` con interpolación lineal (`evaluateKeyframes`); el tiempo `t` es relativo al inicio del clip y está cuantizado a frames. Un clip sin keyframes usa su transformación estática, como siempre.

### 1.2. Reloj Maestro y Motor de Audio (`src/core/engine/MasterClock.ts` & `AudioEngine.ts`)
* **Sincronización dual-reloj:** el tiempo global del editor está anclado a `AudioContext.currentTime`. Esto previene desincronizaciones entre el audio y el video (*lip-sync drift*), comunes cuando se depende de temporizadores de JavaScript como `setInterval` o `requestAnimationFrame`. Si el contexto de audio falta, está suspendido, se congela o se desvía más de 250 ms, el reloj conmuta de forma **irreversible** a `performance.now()` y la línea de tiempo continúa a 1.0× exacta sin congelarse ni saltar.
* **Mezcla Multicanal:** Cada clip y pista posee su propio `GainNode`, permitiendo muteo individual, curvas de fundido de volumen y control de ganancia de 0% a 200%.
* **Volumen maestro (`src/core/utils/masterVolume.ts`, `AudioEngine.setMasterVolume`):** ganancia global 0..1 persistida en `localStorage` (`hydracut.masterVolume`), con slider propio en escritorio (`PlayerControls`, "Volumen maestro") y en móvil (`MobilePreviewPlayer`) sobre la misma llamada al motor.
* **Fundidos de audio por clip (`src/core/utils/audioFades.ts`):** envolvente de ganancia con curvas `linear` y `equalPower` (defecto). El preview evalúa `previewClipFadeGain()` y la exportación programa la misma envolvente (`buildAudioFadeAutomation`); las duraciones se cuantizan a frames (`quantizeAudioFadeDuration`) y se recortan a la duración del clip.
* **Velocidad y pitch coherentes (`src/core/utils/playbackRate.ts`):** `resolvePlayback()` es la única fuente de verdad. Con `preservePitch` (defecto) el desplazamiento de tono se cancela con `detuneCents = -1200·log2(rate)`; con `false`, el tono se desplaza con la velocidad (efecto "chipmunk"). Preview y export resuelven con la misma función, así que suenan igual.
* **Anti-thrashing:** `AudioEngine` cachea el volumen, el mute y la ganancia por elemento y solo escribe en el DOM cuando el delta supera `0.01` o cambia un booleano, evitando el layout thrashing a 60 FPS.

### 1.3. Pipeline de Exportación (`src/core/export/webcodecsExporter.ts`)
* **Cero Carga en el Servidor:** La exportación a MP4 se realiza íntegramente en la máquina del usuario utilizando `VideoEncoder` y `AudioEncoder`.
* **Sonda profunda de encoder (`findWorkingVideoEncoderConfig`):** `isConfigSupported()` no basta — con `hardwareAcceleration: 'prefer-hardware'`, `configure()` puede tener éxito síncrono y el encoder de plataforma morir **asíncronamente** (`OperationError: Encoder creation error` / `NotSupportedError: Operation is not supported`, reproducido en Chrome real). Antes de exportar se crea un encoder real y se verifica que sobrevive una ventana de gracia, probando hardware → default → software × High/Main/Baseline. Si ninguna combinación sobrevive, se cae a MediaRecorder en vez de romper a mitad de exportación.
* **Degradación a MediaRecorder:** si el codificador **falla durante** la exportación (no solo en la sonda), `exportVideo()` degrada a la ruta `MediaRecorder` (`canvas.captureStream()`) en lugar de abortar y perder el trabajo. Una cancelación del usuario nunca se silencia.
* **Audio AAC → Opus:** Chrome/Linux no tiene encoder AAC (`NotSupportedError: Unsupported codec type`); el selector de audio prueba AAC y cae a Opus (mp4-muxer lo muxa en MP4). Sin este fallback el audio se perdía en silencio.
* **Errores siempre accionables (`toActionableExportError`):** los fallos de plataforma (configure/encode/flush/callback) se traducen a español con resolución/fps y guía (1080p/720p@30). Lo no relacionado con el encoder pasa intacto.
* **Control de Contrapresión (*Backpressure*):** Monitorea `videoEncoder.encodeQueueSize`. Si la cola de cuadros pendientes supera el umbral (típicamente 3 fotogramas), suspende el bucle de renderizado mediante eventos `dequeue` para evitar colapsar la memoria del navegador.
* **Gestión Estricta de Memoria GPU:** Cada instancia de `VideoFrame` y `AudioData` generada es cerrada inmediatamente (`frame.close()`, `data.close()`), garantizando cero fugas de memoria VRAM durante renders de alta resolución o duraciones extensas.
* **Audio planar real:** el audio se entrega al `AudioEncoder` como `AudioData` en formato `f32-planar` (plano izquierdo seguido del derecho) en bloques de 2048 muestras, con `timestamp` en microsegundos derivados del desplazamiento real.
* **Preajustes y rango (`src/components/export/ExportModal.tsx`):** 4 preajustes de un clic (`EXPORT_PRESETS`: Web 720p, Social 1080p, Vertical 9:16, Alta calidad 1080p60; dimensiones siempre pares vía `computeExportDimensions`). El rango (`full` | `custom`) se marca con entrada/salida sobre el timeline (`export-range-mark-in/out`), se muestra como `HH:MM:SS:FF` (`formatExportRange`) y se exporta rebasando los clips al rango (`buildRangeExportClips`).

---

## 2. Gestión de Estado con Zustand

HydraCut divide el estado global en dos almacenes reactivos diseñados para desacoplar operaciones de alto coste de las actualizaciones frecuentes del cursor.

### 2.1. `useProjectStore` (`src/store/useProjectStore.ts`)
Almacena el estado íntegro del proyecto audiovisual y su historial de operaciones (*undo/redo*):

* **Modelo del Proyecto:**
  * `project.id`: Identificador único UUID v4.
  * `project.name`: Nombre editable del proyecto.
  * `project.aspectRatio`: Formato de aspecto (`16:9`, `9:16`, `1:1`).
  * `project.resolution`: Dimensiones calculadas (`{ width, height }`).
  * `project.tracks`: Colección ordenada de pistas (`Track[]`).
  * `project.clips`: Lista de clips ubicados en el timeline (`Clip[]`).
  * `project.mediaPool`: Banco de recursos multimedia importados (`MediaItem[]`). Cada medio tiene `status`: `ok` (defecto) | `missing` (bytes perdidos) | `error` (no decodificable).
* `project.overlapPolicy`: Qué ocurre al insertar un clip sobre otro (`block` por defecto, `overwrite`, `ripple`).
* `project.trash`: Papelera de medios (`TrashEntry[]`, ausente en proyectos guardados antes de esta función).
  * `project.duration`: **Extensión real del contenido**: `ceil(max(clip.start + clip.duration) + project.endPaddingSeconds)`, con un mínimo de 1 s. Un proyecto sin clips usa `DEFAULT_EMPTY_PROJECT_DURATION` (30 s) para que el reproductor siga siendo usable. **No hay suelo de 15 s ni relleno incondicional de 5 s**: un proyecto con un clip de 5 s se exporta como un vídeo de 5 s, no de 20 s con 15 s de cola negra. El relleno es opt-in (`project.endPaddingSeconds`, por defecto 0).
* **Operaciones de Pistas:**
  * `addTrack(type)`: Inserta una nueva pista de video, audio o texto.
  * `removeTrack(trackId)`: Elimina la pista y todos los clips asociados.
  * `duplicateTrack(trackId)`: Clona la pista y duplica todos sus clips preservando offsets de tiempo y estilos.
  * `reorderTrack(trackId, direction)`: Desplaza la pista hacia arriba o hacia abajo en la jerarquía visual de capas.
  * `toggleTrackMute/trackLock/trackVisibility(trackId)`: Muteo, bloqueo y visibilidad. Los tres actualizan `updatedAt` (orden de la lista de proyectos). Una pista bloqueada congela `move/trim/split/remove` (origen y destino); `updateClip` sigue permitido.
* **Operaciones de Clips:**
  * `addClipFromMedia(mediaItem, trackId, startTime)`: Añade un clip asignándole su duración nativa y generando sus parámetros de transformación.
  * `removeClip(clipId)`: Elimina el clip seleccionado (respeta lock; deshacible con Ctrl+Z).
  * `moveClip(clipId, newStart, newTrackId)`: Traslada un clip en el tiempo o entre pistas compatibles. Nunca mueve hacia/a partir de pista bloqueada.
  * `splitClip(clipId, splitTime)`: Divide el clip en dos partes contiguas calculando el offset fuente con compensación de velocidad. No-op cerca de bordes (<0.05s).
  * `trimClipStart(clipId, newStart)` & `trimClipEnd(clipId, newEnd)`: Recorta los extremos del clip sin desbordar el archivo fuente.
  * `updateClip(clipId, updates)`: Actualización parcial (velocidad, volumen, transiciones, texto, transformaciones, filtros).
* **Portapapeles interno (`copyClips` / `pasteClips` / `duplicateClips`):** el grupo copiado conserva su disposición relativa (el primer clip es el ancla); pegar respeta el tipo de pista compatible, el bloqueo y la política de solapamiento. Atajos `Ctrl+C` / `Ctrl+V` / `Ctrl+D` (ver §6).
* **Política de solapamiento (`setOverlapPolicy`):** `Bloquear` / `Sobrescribir` / `Ripple` (selector en el Inspector). Todo rechazo deja el motivo en `lastError`, visible en el banner `StoreErrorBanner` en ambos layouts.
* **Papelera (`removeMediaItem` / `restoreFromTrash` / `purgeTrash` / `purgeTrashedMedia`):** borrar un medio lo mueve a la papelera junto con los clips que lo usan (reversible con un clic); purgar borra los blobs de OPFS de verdad.
* **Medios ausentes (`setMediaStatus` / `relinkMedia`):** el clip sin bytes avisa y ofrece revincularlo con un archivo local (panel "Medios ausentes" en `MediaBin`).
* **Fundido de cruce (`createCrossfade` / `setCrossfadeDuration` / `removeCrossfade`)** y **fundidos de audio (`setAudioFade` / `clearAudioFades`)**, editables desde el Inspector.
* **Keyframes (`addKeyframe` / `updateKeyframe` / `removeKeyframe` / `clearKeyframes`)**, editables desde el Inspector.
* **Multi-selección:** `selectClip(id, { additive, range })` (`Ctrl+clic` suma, `Mayús+clic` selecciona el rango sin cruzar de pista), `selectClips`, `selectAllClips` (`Ctrl+A`), rectángulo de arrastre en `Timeline` (con `Ctrl` añade en vez de reemplazar). Acciones en lote con un solo undo: `setSelectedClipsVolume/Opacity/Speed/Muted` y `deleteSelectedClips`.
* **Historial y Reproducción:**
  * Pilas inmutables `past` y `future` para `undo()` y `redo()`.
  * **El historial incluye el banco de medios:** cada snapshot guarda `tracks`, `clips` **y `mediaPool`**. Deshacer un borrado de medios restaura el archivo *y* los clips que lo usaban; ningún clip puede quedar apuntando a un recurso ausente. Importar un medio también es deshacible.
  * **Historial por gesto:** `beginClipGesture()` toma un snapshot al iniciar un drag/trim; `commitClipChange()` cierra el gesto sin pushear (`move/trim` nunca pushean). Un gesto completo se deshace con un único undo. `historyGesturePending` se resetea en undo/redo/load/reset.
  * `currentTime`: Posición del cabezal en segundos (número de coma flotante de alta precisión).
  * `isPlaying`: Estado booleano de reproducción.

### 2.2. `useUIStore` (`src/store/useUIStore.ts`)
Gestiona el estado efímero de la interfaz de usuario:
* `activeTab`: Pestaña activa del panel lateral (`'media' | 'text' | 'inspector' | 'export'`).
* `isExportModalOpen`: Visibilidad del modal de configuración y progreso de exportación MP4.
* `isShortcutsModalOpen`: Visibilidad del diálogo de atajos de teclado.
* `isProjectsModalOpen`: Visibilidad de la galería de gestión multi-proyecto.
* `isWelcomeOpen`: Visibilidad de la pantalla de bienvenida (abierta por defecto en el primer arranque).
* `activeTool`: Herramienta activa del timeline (`'select' | 'split'`).
* `isGeneratingSamples`: Indicador de generación sintética de clips de prueba.

---

## 3. Motor de Timeline Multitrack

El timeline multitrack (`src/components/timeline/`) combina renderizado reactivo con matemáticas precisas de conversión tiempo-espacio.

### 3.1. Conversión Tiempo / Píxeles
Las posiciones visuales se calculan con funciones puras (`zoom` = píxeles por segundo):
* `timeToPixels(time, zoom)`: `time * zoom`.
* `pixelsToTime(pixels, zoom)`: `pixels / zoom` (0 si `zoom <= 0`).

### 3.2. Snapping Magnético Bidireccional (`calculateSnapping`, `src/core/utils/math.ts`)
Al arrastrar o recortar un clip, el motor evalúa las diferencias contra puntos clave magnéticos dentro de un umbral de proximidad visual (10 píxeles por defecto, convertidos a segundos con el zoom actual):
* El inicio del timeline (`0 s`).
* Puntos iniciales (`clip.start`) y finales (`clip.start + clip.duration`) de clips vecinos en todas las pistas.
* Posición actual del cabezal de reproducción (`currentTime`).
* Si la distancia es menor al umbral, el valor se magnetiza automáticamente y se activa la línea guía visual de snapping.

### 3.3. Algoritmo de Corte (*Split*) con Factor de Velocidad
Cuando se corta un clip con velocidad modificada ($v \neq 1.0$):
$$\text{sourceDelta} = (\text{splitTime} - \text{clip.start}) \times \text{clip.speed}$$
$$\text{secondClip.sourceStart} = \text{clip.sourceStart} + \text{sourceDelta}$$
$$\text{firstClip.duration} = \text{splitTime} - \text{clip.start}$$
$$\text{secondClip.duration} = \text{clip.duration} - \text{firstClip.duration}$$

El algoritmo preserva la coherencia de transiciones: el primer clip conserva la transición `fadeIn`, mientras que el segundo clip conserva la transición `fadeOut`, evitando la duplicación no deseada de efectos en el punto de corte.

---

## 4. Persistencia Multi-Proyecto e IndexedDB

HydraCut implementa un ciclo de vida completo de almacenamiento local en `src/core/storage/projectStorage.ts`:

```
+---------------------------------------------------------------------------------+
|                       INDEXEDDB (idb-keyval)                                    |
|                                                                                 |
|  [hydra_projects_index]       --> ProjectMetadata[] (id, name, tracks, etc.)    |
|  [hydra_active_project_id]    --> string (UUID activo)                          |
|  [hydra_project_${id_A}]      --> Project A (Estado completo)                   |
|  [hydra_project_${id_B}]      --> Project B (Estado completo)                   |
+---------------------------------------------------------------------------------+
          |                                                    |
          v                                                    v
+-----------------------------+              +------------------------------------+
|     ProjectsModal.tsx       |              |        OPFS (Local Media)          |
|  - Galería de tarjetas      |              |  - navigator.storage.getDirectory  |
|  - Renombrar / Duplicar     |              |  - Videos y audios en disco local  |
|  - Exportar/Importar .json  |              |  - Rehidratación automática        |
+-----------------------------+              +------------------------------------+
```

### 4.1. Esquema del Registro
* **`ProjectMetadata`:** Metadatos ligeros para listar proyectos sin cargar el árbol completo de clips:
  ```typescript
  export interface ProjectMetadata {
    id: string;
    name: string;
    aspectRatio: AspectRatio;
    duration: number;
    tracksCount: number;
    clipsCount: number;
    createdAt: number;
    updatedAt: number;
  }
  ```
* **Operaciones CRUD:**
  * `listProjects()`: Retorna el catálogo completo ordenado por fecha de modificación reciente.
  * `getProjectById(id)`: Recupera un proyecto específico.
  * `saveProject(project)`: Guarda el estado del proyecto y actualiza el índice de metadatos.
  * `duplicateProject(id, newName)`: Crea una copia independiente con nuevo UUID.
  * `renameProject(id, newName)`: Actualiza el nombre en el índice y en el estado del proyecto.
  * `deleteProject(id)`: Elimina el proyecto y su clave de almacenamiento.
  * `createNewProject(name, aspectRatio)`: Inicializa un nuevo proyecto con pistas por defecto (Video 1, Audio 1, Texto 1).
* **Escrituras atómicas (`runAtomicWrite`):** el índice de proyectos y la clave del proyecto se escriben en una **única transacción** de IndexedDB (`readwrite` sobre ambas claves). Si la transacción atómica no está disponible, se recurre a la escritura secuencial. Un fallo a mitad de la actualización no deja el índice desincronizado con el estado del proyecto.
* **Autosave con debounce (`AUTOSAVE_DEBOUNCE_MS = 500 ms`):** cada cambio del proyecto reprograma un temporizador de guardado; el arrastre de un slider ya no escribe el proyecto (con sus filmstrips) en cada frame. `flushAutosave()` fuerza el volcado pendiente y `installAutosaveFlushOnUnload()` lo ejecuta al cerrar la pestaña, de modo que no se pierden los últimos cambios.
* **Errores de persistencia visibles:** los fallos de cuota o de escritura se publican como eventos (`subscribeStorageEvents`) y el store guarda el último error para que la UI pueda avisar al usuario de que su trabajo **no** se está guardando (antes solo llegaba a `console.error`).

### 4.2. Exportación e Importación de Archivos `.hydra` / `.json`
* **Exportación (`exportProjectToFile`):** Serializa la estructura del proyecto en un archivo JSON descargable con sangría legible.
* **Copia con medios embebidos:** el `.hydra` embebe los bytes de los medios hasta `MAX_EMBEDDED_MEDIA_BYTES` (**64 MB**); si el proyecto los supera, avisa y exporta sin ellos. Botón en `MediaBin`.
* **Importación (`importProjectFromFile` / `importProjectFromFileWithReport`):** Valida la presencia de las propiedades obligatorias (`id`, `tracks`, `clips`), previene inyecciones o datos corruptos, rehidrata los medios embebidos o de OPFS (`rehydrateProjectMedia()`) y reporta el resultado.

### 4.3. Gestor de almacenamiento (`MediaBin`, `src/core/storage/projectStorage.ts`)
* Panel con la cuota real del navegador (`readStorageEstimate` + `buildQuotaSnapshot`), resumen de uso (`summarizeStorageUsage`: proyectos, medios, papelera con su tamaño) y purga de la papelera con confirmación en dos pasos (`purgeTrash`). Cubierto por el harness de navegador (`STORAGE-QUOTA-PANEL`, `STORAGE-PURGE-TRASH`).

---

## 5. Especificaciones de Diseño Móvil CapCut

En pantallas con ancho menor a 768px, HydraCut activa la vista `MobileCapCutLayout.tsx`:

```
+---------------------------------------------+
| Header Móvil (min-h-12 = 48px)              |
| [H] [Proyectos] [Nombre] [Aspecto]         |
| [Deshacer] [Rehacer] [Atajos] [EXPORT]      |
+---------------------------------------------+
|                                             |
| Monitor de Video Canvas                     |
| Timecode flotante + botón Play/Pausa        |
|                                             |
+---------------------------------------------+
| Timeline Táctil Multitrack                  |
| +-----------------------------------------+ |
| | Cabecera (w-28 / w-36): [V1] [👁] [🔊] [🔒]| |
| | Clips con filmstrips y mangos táctiles  | |
| +-----------------------------------------+ |
+---------------------------------------------+
| Barra de herramientas timeline              |
| [sel] [cuchilla] [dividir] [borrar] [imán]  |
| [+pista] [ajustar] [zoom-] [slider] [zoom+]  |
+---------------------------------------------+
| Barra de Acciones Inferior Contextual       |
| [Medios] [Texto] [Audio] [Dividir]         |
+---------------------------------------------+
| Safe Area Inferior (iOS home bar)           |
+---------------------------------------------+
```

### 5.1. Cabecera de Pistas en Móvil (`TrackHeader.tsx`)

* **Badges distintivos:** `V1`, `A1`, `T1` con color por tipo de pista (azul video, esmeralda audio, púrpura texto). La columna de cabecera mide `w-28` (112 px) y crece a `w-36` (144 px) a partir de 400 px de ancho; el icono del badge se oculta por debajo de 420 px para evitar desborde.
* **Botones directos 28×44px + expansión táctil:** visibilidad, silencio y bloqueo (`w-7 min-w-[28px] h-11 min-h-[44px]`, con `after:-inset-1` como zona táctil ampliada). La altura sí es de 44 px reales; el ancho visible es de 28 px.
* **Menú rápido (`⋮`, `z-[60]`):** duplicar, subir/bajar (con `disabled` en bordes) y eliminar pista, con posicionamiento anti-desborde.
* **Pista de texto (`T1`):** sin botón de silencio por diseño (espaciador invisible para alinear la cuadrícula).

> La geometría real de la interfaz (solapes, desbordes, alturas) se mide en el
> harness de navegador: `npm run test:browser layout` (6 viewports × 2
> `devicePixelRatio`). No existen scripts `scripts/test-browser*.mjs`: el único
> punto de entrada es `npm run test:browser`.

### 5.2. Barra Inferior Contextual y Bottom Sheets
* **Estado Global (sin clip seleccionado):** "Medios", "Texto", "Audio" y "Dividir" (corte en el cabezal). La relación de aspecto, los proyectos, el deshacer/rehacer, los atajos y la exportación viven en la cabecera móvil (`MobileHeader`).
* **Estado de Clip Seleccionado:** Conmuta automáticamente a las herramientas de edición de clip: Volver, Ajustes (propiedades), Dividir (corte en cabezal), Velocidad, Volumen, Animación y Eliminar.
* **Bottom Sheets (`MobileBottomSheet.tsx`):** Paneles deslizables desde la parte inferior con altura adaptativa (máximo 50-60% de pantalla) para no obstaculizar la visión del monitor de video. Gestionan el foco con `useFocusTrap` y se cierran con `Escape`.

### 5.3. Paridad móvil–escritorio
El móvil usa las mismas llamadas que el escritorio: `masterClock.stepFrame(±1)` (±1 fotograma), `audioEngine.setMasterVolume` (volumen maestro persistente), velocidad hasta 4× y transiciones con `fade-white` y sliders de duración. La suite `src/tests/mobile-parity.test.ts` (19 tests) lo fija con guardas de regresión sobre el fuente real de `MobilePreviewPlayer` y `MobileCapCutLayout`.

---

## 6. Atajos de Teclado

| Atajo | Función |
| :--- | :--- |
| <kbd>Espacio</kbd> | Reproducir o pausar el timeline |
| <kbd>S</kbd> | Dividir el clip activo en la posición del cabezal de tiempo |
| <kbd>Supr</kbd> / <kbd>Backspace</kbd> | Eliminar el clip seleccionado |
| <kbd>←</kbd> / <kbd>→</kbd> | Avanzar o retroceder 1 fotograma |
| <kbd>Ctrl</kbd> + <kbd>C</kbd> / <kbd>V</kbd> / <kbd>D</kbd> | Copiar / pegar / duplicar los clips seleccionados |
| <kbd>Ctrl</kbd> + <kbd>A</kbd> | Seleccionar todos los clips del proyecto |
| <kbd>Ctrl</kbd> + <kbd>Z</kbd> | Deshacer la última acción |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd> | Rehacer la última acción deshecha |
| <kbd>Ctrl</kbd> + <kbd>Y</kbd> | Rehacer la última acción deshecha |
| <kbd>Ctrl</kbd> + <kbd>Rueda</kbd> | Zoom in / Zoom out en el timeline centrado en el cursor |
| <kbd>Home</kbd> | Trasladar el cabezal al inicio del proyecto (`00:00:00:00`) |
| <kbd>Esc</kbd> | Cerrar modal/sheet/menú, salir de cuchilla, deseleccionar clip |

> Los atajos de edición no disparan con modales abiertos ni escribiendo en campos.

---

## 7. Guía de Pruebas y Verificación

HydraCut tiene **dos capas de verificación**, ambas ejecutables desde la raíz del paquete (`apps/hydra-cut`):

| Capa | Qué cubre | Comando |
|------|-----------|---------|
| **Unitarias e integración** (Vitest, entorno Node) | Algoritmos, stores, motor de medios, compositor, pipeline de exportación, persistencia, accesibilidad | `npm test` |
| **E2E en navegador real** (Chrome + `puppeteer-core`) | Layout responsive, reproducción, deshacer/rehacer, persistencia y exportación MP4 real | `npm run test:browser` |

### 7.1. Pruebas Unitarias y de Integración con Vitest

Cubre conversiones temporales, snapping magnético, operaciones del store (incluido el historial que restaura los medios borrados), gestos drag/trim/undo, waveforms, transiciones, compositor de canvas, corrección de duración, persistencia multi-proyecto, escritura atómica, accesibilidad y el contrato real del exportador (dimensiones pares y audio planar `f32-planar`).

```bash
# Suite completa
npm test

# Un fichero concreto
npx vitest run src/tests/engine.test.ts

# Comprobación de tipos (sin emitir)
npm run typecheck        # == tsc --noEmit

# Compilación de producción
npm run build            # == tsc && vite build
```

> **Cifra de tests:** ejecuta `npx vitest run` para obtener el número vigente. La
> cifra de este README es una foto del 2026-10-20 (795 tests en 35 ficheros) y
> cambia con cada suite nueva. La tabla completa por fichero está en
> [`TEST_INFRA.md`](./TEST_INFRA.md).

### 7.2. Pruebas E2E en Navegador Real

El harness (`src/tests/browser/`) arranca el servidor de Vite, abre un Chrome real y ejecuta cinco suites: **layout** (92 checks: 6 viewports × 2 `devicePixelRatio`), **playback** (4), **export** (8), **known-issues** (14, informativa; con `--strict` también hace fallar la ejecución) y **features** (22: portapapeles, color, velocidad, presets/rango de export, almacenamiento y multi-selección). Total: **140 checks**.

```bash
# Todas las suites
npm run test:browser

# Una suite concreta
npm run test:browser layout
npm run test:browser playback
npm run test:browser export
npm run test:browser known-issues
npm run test:browser features

# Con el navegador visible / en modo estricto
npm run test:browser -- --headed
npm run test:browser -- --strict
```

Variables de entorno: `HYDRA_CHROME_PATH` (ruta del binario de Chrome), `HYDRA_DEV_HOST`, `HYDRA_DEV_PORT` (por defecto `5199`), `HYDRA_BASE_URL`.

> **No existen** los scripts `scripts/test-browser.mjs`, `test-browser-e2e.mjs`,
> `test-browser-mobile.mjs`, `test-browser-interactive.mjs`,
> `test-browser-playback-smoothness.mjs`, `test-browser-projects.mjs` ni
> `test-browser-export.mjs`: el único punto de entrada es
> `npm run test:browser` (`scripts/browser-test.mjs`).

### 7.3. Integración Continua

`.github/workflows/ci.yml` ejecuta en cada `push` y `pull_request`:

```bash
npm ci → npm run typecheck → npm test → npm run build
```

El E2E de navegador **queda fuera de CI** porque necesita un binario de Chrome: se ejecuta a mano antes de cada entrega. Véase [`TEST_INFRA.md`](./TEST_INFRA.md) para el detalle completo, la matriz de trazabilidad de requisitos y los huecos conocidos (no hay ESLint instalado y el proveedor de cobertura no está instalado).

> **Tamaños del bundle** (foto del `npm run build` del 2026-10-20): chunk principal `index-*.js` 464 kB (gzip 128 kB), CSS 53 kB, `webcodecsExporter` 56 kB, `MediaBin` 28 kB, `ExportModal` 19 kB, `ProjectsModal` 19 kB, `MobilePreviewPlayer` 10 kB, `ShortcutsModal` 3 kB (los modales y `MediaBin`/`MobilePreviewPlayer` viajan en chunks separados por `React.lazy`).

---

## 8. Estructura del Código Fuente

```text
apps/hydra-cut/
├── scripts/
│   └── browser-test.mjs      # CLI del harness E2E (npm run test:browser)
├── .github/workflows/ci.yml  # typecheck + tests + build en cada push/PR
└── src/
    ├── components/
    │   ├── export/               # ExportModal: 4 preajustes, rango (marcas entrada/salida) y progreso MP4
    │   ├── inspector/            # ClipInspector: velocidad/pitch, volumen, fundidos audio, crossfade,
    │   │                         #   filtros (7 preajustes), keyframes, política de solapamiento, lote
    │   ├── layout/               # Header de escritorio, panel lateral y layout principal (MainLayout:
    │   │                         #   atajos Ctrl+C/V/D, StoreErrorBanner), liveRegion.ts y overlayGeometry.ts
    │   ├── media/                # MediaBin: papelera, medios ausentes/revinculado, backup con medios,
    │   │                         #   gestor de almacenamiento; MediaItemCard e importador
    │   ├── mobile/               # Layout CapCut móvil, MobileHeader, MobileBottomBar, MobileBottomSheet,
    │   │                         #   MobilePreviewPlayer (±1 fotograma, volumen maestro: mismas llamadas que escritorio)
    │   ├── modals/               # ShortcutsModal, ProjectsModal y WelcomeModal
    │   ├── player/               # Monitor de previsualización en Canvas y controles de transporte
    │   └── timeline/             # Timeline (rectángulo de arrastre, Ctrl+A), TimeRuler, Playhead,
    │                             #   TrackHeader, TrackLane, ClipItem (Ctrl/Mayús+clic), TimelineToolbar
    ├── core/
    │   ├── engine/               # Compositor.ts, AudioEngine.ts, MasterClock.ts, MediaSourcePool.ts
    │   ├── export/               # webcodecsExporter.ts (VideoEncoder, AudioEncoder, mp4-muxer, fallback MediaRecorder)
    │   ├── storage/              # projectStorage.ts (IndexedDB, autosave con debounce, escritura atómica,
    │   │                         #   backup con medios hasta 64 MB, cuota/papelera) y opfsStorage.ts (OPFS)
    │   └── utils/                # audioFades.ts, colorFilters.ts, crossfade.ts, keyframes.ts,
    │                             #   masterVolume.ts, playbackRate.ts (resolvePlayback), math.ts (snapping),
    │                             #   time.ts (timecode HH:MM:SS:FF/zoom), waveform.ts, sampleMedia.ts
    │                             #   y thumbnails.ts (miniaturas/filmstrips)
    ├── hooks/
    │   ├── useIsMobile.ts         # Detección de viewport móvil / compacto (altura <= 500 px)
    │   ├── useAnchoredMenu.ts     # Menús anclados con posición anti-desborde
    │   └── useFocusTrap.ts        # Focus trap y cierre con Escape (modales y bottom sheets)
    ├── store/
    │   ├── useProjectStore.ts    # Proyecto, pistas, clips, portapapeles, solapamiento, papelera,
    │   │                         #   multi-selección y lote, crossfade, fundidos, keyframes, historial, lock
    │   └── useUIStore.ts         # Estado efímero de pestañas, modales y herramientas activas
    ├── tests/                    # 35 suites de Vitest (ver TEST_INFRA.md) + quality-guard.test.ts
    │   └── browser/              # Harness E2E en Chrome real: run-all + suites layout, playback,
    │                             #   export, known-issues y features (npm run test:browser)
    └── types/                    # Definiciones TypeScript (project.ts)
```

---

## 🔒 Seguridad

100% client-side: tus medios nunca salen del dispositivo. Sin backend ni credenciales
en el repo (`.env*` ignorado en `.gitignore`).

---

## ⚖️ Aviso legal

Edita únicamente material del que poseas los derechos o que la ley te permita usar, respetando la normativa de propiedad intelectual de tu jurisdicción. Software "tal cual" (licencia MIT), sin garantías: el autor no responde de daños directos o indirectos ni del uso que hagas de él.

---

## 📜 Licencia

MIT © 2026 [HydraApps](https://github.com/juanpimg). Edición audiovisual de alto rendimiento para la web moderna.
