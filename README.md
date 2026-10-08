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
|  - AudioEncoder (AAC Stereo @ 48kHz)                                     |
|  - Backpressure flow control (encodeQueueSize <= 3)                      |
|  - Zero-leak memory safety: frame.close() & audioData.close()            |
|  - Direct container muxing via mp4-muxer                                 |
+--------------------------------------------------------------------------+
```

### 1.1. Compositor en Canvas (`src/core/engine/Compositor.ts`)
* **Jerarquía de Capas (Painter's Algorithm):** Dibuja primero las pistas de video base en orden ascendente, seguidas de pistas Picture-in-Picture (PiP), y finalmente las capas de texto estilizado, subtítulos y animaciones tipográficas.
* **Procesamiento de Cuadros en Tiempo Real:** Realiza muestreo de frames sincronizados desde `MediaSourcePool.ts`, aplicando transformaciones geométricas (escala, posición `X/Y`, opacidad `0-1`) y efectos de transición (`fade-black`, `fade-white`, `slide-left`, `wipe-right`).
* **Dimensiones Normalizadas:** Garantiza que las dimensiones enviadas a la GPU sean pares (múltiplos de 2), requisito técnico estricto de codificadores de hardware H.264/AVC.

### 1.2. Reloj Maestro y Motor de Audio (`src/core/engine/MasterClock.ts` & `AudioEngine.ts`)
* **Sincronización:** El tiempo global del editor está anclado a `AudioContext.currentTime`. Esto previene desincronizaciones entre el audio y el video (*lip-sync drift*), comunes cuando se depende de temporizadores de JavaScript como `setInterval` o `requestAnimationFrame`.
* **Mezcla Multicanal:** Cada clip y pista posee su propio `GainNode`, permitiendo muteo individual, curvas de fundido de volumen y control de ganancia de 0% a 200%.

### 1.3. Pipeline de Exportación Acelerado por Hardware (`src/core/export/webcodecsExporter.ts`)
* **Cero Carga en el Servidor:** La exportación a MP4 se realiza íntegramente en la máquina del usuario utilizando `VideoEncoder` y `AudioEncoder`.
* **Control de Contrapresión (*Backpressure*):** Monitorea `videoEncoder.encodeQueueSize`. Si la cola de cuadros pendientes supera el umbral (típicamente 3 fotogramas), suspende el bucle de renderizado mediante eventos `dequeue` para evitar colapsar la memoria del navegador.
* **Gestión Estricta de Memoria GPU:** Cada instancia de `VideoFrame` y `AudioData` generada es cerrada inmediatamente (`frame.close()`, `data.close()`), garantizando cero fugas de memoria VRAM durante renders de alta resolución o duraciones extensas.

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
  * `project.mediaPool`: Banco de recursos multimedia importados (`MediaItem[]`).
  * `project.duration`: Duración calculada total del timeline.
* **Operaciones de Pistas:**
  * `addTrack(type)`: Inserta una nueva pista de video, audio o texto.
  * `removeTrack(trackId)`: Elimina la pista y todos los clips asociados.
  * `duplicateTrack(trackId)`: Clona la pista y duplica todos sus clips preservando offsets de tiempo y estilos.
  * `reorderTrack(trackId, direction)`: Desplaza la pista hacia arriba o hacia abajo en la jerarquía visual de capas.
  * `toggleTrackMute(trackId)`: Activa o desactiva el sonido de la pista.
  * `toggleTrackLock(trackId)`: Bloquea la pista para prevenir modificaciones accidentales.
  * `toggleTrackVisibility(trackId)`: Oculta o muestra la pista en el lienzo del compositor.
* **Operaciones de Clips:**
  * `addClipFromMedia(mediaItem, trackId, startTime)`: Añade un clip asignándole su duración nativa y generando sus parámetros de transformación.
  * `removeClip(clipId)`: Elimina el clip seleccionado.
  * `moveClip(clipId, newTrackId, newStart)`: Traslada un clip en el tiempo o entre pistas compatibles.
  * `splitClip(clipId, splitTime)`: Divide el clip en dos partes contiguas calculando el offset fuente con compensación de velocidad.
  * `trimClipStart(clipId, delta)` & `trimClipEnd(clipId, delta)`: Recorta los extremos del clip sin desbordar el archivo fuente.
  * `setClipVolume(clipId, volume)`, `setClipSpeed(clipId, speed)`, `setClipTransition(clipId, transition)`, `setClipText(clipId, text, style)`.
* **Historial y Reproducción:**
  * Pilas inmutables `past` y `future` para `undo()` y `redo()`.
  * `currentTime`: Posición del cabezal en segundos (número de coma flotante de alta precisión).
  * `isPlaying`: Estado booleano de reproducción.

### 2.2. `useUIStore` (`src/store/useUIStore.ts`)
Gestiona el estado efímero de la interfaz de usuario:
* `activeTab`: Pestaña activa del panel lateral (`'media' | 'text' | 'inspector' | 'export'`).
* `isExportModalOpen`: Visibilidad del modal de configuración y progreso de exportación MP4.
* `isShortcutsModalOpen`: Visibilidad del diálogo de atajos de teclado.
* `isProjectsModalOpen`: Visibilidad de la galería de gestión multi-proyecto.
* `activeTool`: Herramienta activa del timeline (`'select' | 'split'`).
* `isGeneratingSamples`: Indicador de generación sintética de clips de prueba.

---

## 3. Motor de Timeline Multitrack

El timeline multitrack (`src/components/timeline/`) combina renderizado reactivo con matemáticas precisas de conversión tiempo-espacio.

### 3.1. Conversión Tiempo / Píxeles
Las posiciones visuales se calculan con funciones puras:
* `timeToPixels(time, zoom, fps)`: `time * zoom * 50` (donde zoom escala la densidad visual).
* `pixelsToTime(pixels, zoom, fps)`: `pixels / (zoom * 50)`.

### 3.2. Snapping Magnético Bidireccional (`calculateSnapping`)
Al arrastrar o recortar un clip, el motor evalúa las diferencias contra puntos clave magnéticos dentro de un umbral de proximidad visual (por defecto 10 píxeles):
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

### 4.2. Exportación e Importación de Archivos `.hydra` / `.json`
* **Exportación (`exportProjectToFile`):** Serializa la estructura del proyecto en un archivo JSON descargable con sangría legible.
* **Importación (`importProjectFromFile`):** Valida la presencia de las propiedades obligatorias (`id`, `tracks`, `clips`), previene inyecciones o datos corruptos y ejecuta `rehydrateProjectMedia()` para reconectar los recursos almacenados en OPFS.

---

## 5. Especificaciones de Diseño Móvil CapCut

En pantallas con ancho menor a 768px, HydraCut activa la vista `MobileCapCutLayout.tsx`:

```
+---------------------------------------------+
| Header Móvil (48px)                         |
| [H] [Nombre]  [Aspecto]  [Deshacer]  [EXPORT]
+---------------------------------------------+
|                                             |
| Monitor de Video Canvas                     |
| Timecode flotante + botón Play/Pausa        |
|                                             |
+---------------------------------------------+
| Timeline Táctil Multitrack                  |
| +-----------------------------------------+ |
| | Cabecera (w-36): [V1] [👁] [🔊] [🔒] [...]| |
| +-----------------------------------------+ |
| | Clips con filmstrips y mangos táctiles  | |
+---------------------------------------------+
| Barra de Acciones Inferior Contextual (60px)|
| [Dividir]  [Velocidad]  [Volumen]  [Eliminar]
+---------------------------------------------+
| Safe Area Inferior (iOS home bar)           |
+---------------------------------------------+
```

### 5.1. Cabecera de Pistas en Móvil (`TrackHeader.tsx`)

> [!WARNING]
> **Estado: implementada pero NO terminada.** Los tests pasan, pero la comprobación visual en emulación iPhone 14 (390×844) muestra un defecto abierto: el icono del ojo (visibilidad) **se solapa con el texto del badge** (`T1`, `V2`, `V1`, `A1`). Ver `HANDOFF.md` en la raíz del repositorio para el siguiente paso.

Implementado (verificado por código y por captura):
* **Badges distintivos:** `V1`, `A1`, `T1` con color por tipo de pista (azul video, esmeralda audio, púrpura texto).
* **Acciones de pista en el store:** `duplicateTrack` y `reorderTrack(trackId, 'up' | 'down')` en `useProjectStore`, junto con `toggleTrackVisibility`.
* **Menú rápido (`⋮`):** botón `MoreVertical` con duplicar y subir/bajar pista.
* **Botones directos:** visibilidad, silencio y bloqueo en la propia cabecera.

Pendiente / sin verificar:
* **Solape ojo–badge** (defecto visual descrito arriba).
* **Hitbox ≥ 44px:** el código usa `min-h-[44px]` en vertical, pero el ancho de cada botón es de solo ~25–28px (se amplía con un pseudo-elemento `after:-inset-x-2`). No está medido en un dispositivo real, así que **no se puede afirmar** que cumpla 44×44px.
* **Pista de texto (`T1`):** no muestra botón de silencio (se deja un espaciador), lo cual es intencionado pero conviene revisarlo.

### 5.2. Barra Inferior Contextual y Bottom Sheets
* **Estado Global:** Proporciona acceso rápido a "+ Medios", "Texto", "Audio", "Formato" y la galería de proyectos.
* **Estado de Clip Seleccionado:** Conmuta automáticamente a herramientas de edición de clip: Dividir (corte en cabezal), Velocidad, Volumen, Animación y Eliminar.
* **Bottom Sheets (`MobileBottomSheet.tsx`):** Paneles deslizables desde la parte inferior con altura adaptativa (máximo 50-60% de pantalla) para no obstaculizar la visión del monitor de video.

---

## 6. Atajos de Teclado

| Atajo | Función |
| :--- | :--- |
| <kbd>Espacio</kbd> | Reproducir o pausar el timeline |
| <kbd>S</kbd> | Dividir el clip activo en la posición del cabezal de tiempo |
| <kbd>Supr</kbd> / <kbd>Backspace</kbd> | Eliminar el clip seleccionado |
| <kbd>←</kbd> / <kbd>→</kbd> | Avanzar o retroceder 1 fotograma |
| <kbd>Ctrl</kbd> + <kbd>Z</kbd> | Deshacer la última acción |
| <kbd>Ctrl</kbd> + <kbd>Y</kbd> | Rehacer la última acción deshecha |
| <kbd>Ctrl</kbd> + <kbd>Rueda</kbd> | Zoom in / Zoom out en el timeline centrado en el cursor |
| <kbd>Home</kbd> | Trasladar el cabezal al inicio del proyecto (`00:00:00:00`) |

---

## 7. Guía de Pruebas y Verificación

HydraCut dispone de una sólida cobertura de pruebas automatizadas:

### 7.1. Pruebas Unitarias con Vitest
Ejecuta las pruebas unitarias que cubren conversiones temporales, algoritmos de snapping, operaciones del store, waveforms de audio, compositor de canvas y persistencia:

```bash
# Desde la raíz del monorepo:
npm test

# O dentro de apps/hydra-cut:
npm run test
```

### 7.2. Pruebas de Navegador con Puppeteer Core
Valida la aplicación en una instancia real de Google Chrome sin interfaz gráfica:

```bash
# Iniciar servidor de desarrollo en puerto 5173
npm run dev --workspace=apps/hydra-cut &

# Smoke test básico
node scripts/test-browser.mjs

# Validación E2E de escritorio completa
node scripts/test-browser-e2e.mjs

# Validación responsive móvil CapCut (iPhone 14)
node scripts/test-browser-mobile.mjs

# Validación de interacción de timeline y arrastre
node scripts/test-browser-interactive.mjs

# Validación de continuidad y ausencia de cuadros negros
node scripts/test-browser-playback-smoothness.mjs
```

---

## 8. Estructura del Código Fuente

```text
apps/hydra-cut/src/
├── components/
│   ├── export/               # Modal de configuración de exportación MP4 y barra de progreso
│   ├── inspector/            # Panel de propiedades de clip (velocidad, volumen, transiciones)
│   ├── layout/               # Header de escritorio, panel lateral y layout principal (MainLayout)
│   ├── media/                # MediaBin, importador de archivos y generador de clips sintéticos
│   ├── mobile/               # Layout CapCut móvil, MobileHeader, MobileBottomBar, MobileBottomSheet
│   ├── modals/               # ShortcutsModal y ProjectsModal
│   ├── player/               # Monitor de previsualización en Canvas y controles de transporte
│   └── timeline/             # TimeRuler, Playhead, TrackHeader, TrackLane, ClipItem, TimelineToolbar
├── core/
│   ├── engine/               # Compositor.ts, AudioEngine.ts, MasterClock.ts, MediaSourcePool.ts
│   ├── export/               # webcodecsExporter.ts (VideoEncoder, AudioEncoder, mp4-muxer)
│   ├── storage/              # projectStorage.ts (IndexedDB) y opfsStorage.ts (OPFS streaming)
│   └── utils/                # timecode.ts, snapping.ts, transitions.ts, waveforms.ts
├── store/
│   ├── useProjectStore.ts    # Estado maestro del proyecto, pistas, clips e historial
│   └── useUIStore.ts         # Estado efímero de pestañas, modales y herramientas activas
├── tests/                    # Suites de test unitario (timeline.test.ts, features.test.ts, engine.test.ts)
└── types/                    # Definiciones TypeScript (project.ts)
```

---

## 📜 Licencia

MIT © 2026 [HydraApps](https://github.com/juanpimg). Edición audiovisual de alto rendimiento para la web moderna.
