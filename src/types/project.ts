export type MediaType = 'video' | 'audio' | 'image';
export type TrackType = 'video' | 'audio' | 'text';
export type AspectRatio = '16:9' | '9:16' | '1:1';

export type LyricAnimationPreset = 'none' | 'karaoke-fill' | 'word-bounce' | 'fade-phrase';

export interface WordTiming {
  word: string;
  start: number; // Tiempo de inicio en el timeline (segundos)
  end: number;   // Tiempo de fin en el timeline (segundos)
}

export interface TextStyle {
  fontSize: number;
  color: string;
  backgroundColor: string;
  fontFamily: string;
  textAlign: 'left' | 'center' | 'right';
  fontWeight: 'normal' | 'bold' | '600' | '800' | '900';
  padding?: number;
  borderRadius?: number;
  strokeColor?: string;
  strokeWidth?: number;
  highlightColor?: string;
  animationPreset?: LyricAnimationPreset;
}

export type TransitionType = 'none' | 'fade-black' | 'fade-white' | 'slide-left' | 'wipe-right';

/**
 * Curva de un fundido de audio por clip.
 *
 * - `linear`:     rampa simple (`g(p) = p`).
 * - `equalPower`: `g(p) = sin(p · π/2)` — la potencia se mantiene constante a
 *   lo largo de la rampa, sin el bache de sonoridad del fundido lineal.
 *   Es el valor por defecto (ver `DEFAULT_AUDIO_FADE_CURVE`).
 */
export type AudioFadeCurve = 'linear' | 'equalPower';

/**
 * Fundido de audio de un borde del clip (entrada o salida).
 */
export interface AudioFade {
  /** Duración del fundido en segundos (cuantizada a frames en el store). */
  duration: number;
  /**
   * Curva del fundido. `undefined` significa `equalPower` (el defecto):
   * compatibilidad con los fundidos guardados sin curva.
   */
  curve?: AudioFadeCurve;
}

export interface ClipTransition {
  fadeInType: TransitionType;
  fadeInDuration: number;  // segundos
  fadeOutType: TransitionType;
  fadeOutDuration: number; // segundos
  /**
   * F5 · Fundido de cruce (crossfade) con el clip vecino de la misma pista.
   *
   * - `crossfadeOutDuration` (en el clip ANTERIOR) y `crossfadeInDuration`
   *   (en el POSTERIOR) miden la región de solape DELIBERADO en segundos.
   * - Ambas deben coincidir con el solape real: el solape solo es deliberado
   *   cuando `isDeliberateCrossfadeOverlap()` lo confirma (ver
   *   `src/core/utils/crossfade.ts`). Un solape sin estos marcadores sigue
   *   siendo un solape ilegal según la política de solapamiento (F1).
   * - Opcionales por compatibilidad: un clip sin marcadores no participa en
   *   ningún fundido de cruce. La duración está cuantizada a frames del
   *   proyecto y recortada al material más corto de los dos clips.
   */
  crossfadeInDuration?: number;  // segundos
  crossfadeOutDuration?: number; // segundos
}

/**
 * Availability of a media item (F3).
 *
 * - `ok`      : the file is present and usable (the default).
 * - `missing` : the bytes are gone (the file disappeared from OPFS or the
 *               rehydration failed). The clip renders black and silent, so the
 *               UI MUST warn about it and offer a relink.
 * - `error`   : the file is there but it cannot be decoded / loaded.
 */
export type MediaStatus = 'ok' | 'missing' | 'error';

export interface MediaItem {
  id: string;
  name: string;
  type: MediaType;
  url: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  thumbnailUrl: string;
  thumbnails?: string[];       // Filmstrip secuencial de fotogramas
  waveformPeaks?: number[];    // Picos de audio normalizados [0, 1]
  size: number;
  createdAt: number;
  opfsPath?: string;
  /**
   * Availability of the media (F3). Optional for backwards compatibility:
   * a media without status is healthy (`ok`).
   */
  status?: MediaStatus;
}

/**
 * What happens when a clip is inserted where another clip already lives (F1).
 *
 * - `block`    : the insertion is refused and the reason is reported.
 * - `overwrite`: the new clip trims the overlapped part of the existing one.
 * - `ripple`   : the clips that follow shift to the right to make room.
 */
export type OverlapPolicy = 'block' | 'overwrite' | 'ripple';

/**
 * Entry of the media trash (F2): the media that left the project together
 * with the clips that used it (they are restored with it).
 */
export interface TrashEntry {
  /** The media item that was removed from the media pool. */
  media: MediaItem;
  /** The clips that referenced the media (kept aside, not rendered). */
  clips: Clip[];
  /** Timestamp (ms since the epoch) of the removal. */
  deletedAt: number;
}

/**
 * F8 · Un keyframe de transform de un clip.
 *
 * - `t` es el tiempo RELATIVO al inicio del clip (segundos), cuantizado a
 *   frames del proyecto. Los keyframes de un clip están ordenados por `t` y
 *   no hay dos con el mismo `t`.
 * - Cada propiedad es OPCIONAL: una propiedad ausente en un keyframe no vale
 *   cero — la pista de esa propiedad se interpola entre los keyframes que SÍ
 *   la definen (ver `evaluateSortedKeyframesInto`).
 * - `x` / `y` son el desplazamiento en px desde el centro (como `positionX` /
 *   `positionY`); `scale` y `opacity` siguen el mismo rango que el valor
 *   estático del clip.
 */
export interface ClipKeyframe {
  /** Tiempo relativo al inicio del clip (segundos, cuantizado a frames). */
  t: number;
  /** Desplazamiento horizontal en px (como `positionX`). */
  x?: number;
  /** Desplazamiento vertical en px (como `positionY`). */
  y?: number;
  /** Escala (como `scale`: 1 = 100 %). */
  scale?: number;
  /** Opacidad (como `opacity`: 0..1). */
  opacity?: number;
}

export interface Clip {
  id: string;
  trackId: string;
  mediaId: string;
  name: string;
  type: 'video' | 'audio' | 'text' | 'image';
  start: number;          // Posición en la línea de tiempo (segundos)
  duration: number;       // Duración del corte en el timeline (segundos)
  sourceStart: number;    // Offset de inicio en el archivo original (segundos)
  sourceDuration: number; // Duración completa del archivo original
  
  // Transform & Blend
  volume: number;         // 0 a 2 (1 = 100%)
  opacity: number;        // 0 a 1 (1 = 100%)
  scale: number;          // 0.1 a 3 (1 = 100%)
  positionX: number;      // Offset horizontal desde el centro en px
  positionY: number;      // Offset vertical desde el centro en px
  muted: boolean;

  /**
   * F8 · Keyframes de animación de la transformación.
   *
   * Opcional por compatibilidad: un clip sin keyframes se dibuja con su
   * transformación ESTÁTICA (`positionX/Y`, `scale`, `opacity`), exactamente
   * como hoy. Cuando hay keyframes, el `Compositor` interpola linealmente la
   * posición, la escala y la opacidad en función del tiempo dentro del clip
   * (ver `src/core/utils/keyframes.ts`).
   */
  keyframes?: ClipKeyframe[];

  /**
   * F9 · Colour filters. Optional: a clip without filters is drawn with the
   * neutral values (no filtering at all).
   */
  filters?: ClipColorFilters;

  // Transiciones y Velocidad
  transition?: ClipTransition;
  speed?: number;         // Factor de velocidad (ej. 0.5, 1, 1.5, 2). Default 1
  /**
   * F4 · Conservar el tono (pitch) al cambiar la velocidad.
   *
   * Por defecto es `true` (el tono NO se desplaza: una voz acelerada sigue
   * sonando como una voz). Con `false` el tono se desplaza con la velocidad
   * (efecto "chipmunk"), que es lo que hace un `AudioBufferSourceNode` con
   * `playbackRate` sin compensación.
   *
   * `undefined` significa "preservar" (compatibilidad con los proyectos ya
   * guardados). La semántica exacta la fija `resolvePlayback()`
   * (`src/core/utils/playbackRate.ts`), la única fuente de verdad.
   */
  preservePitch?: boolean;

  /**
   * Fundidos de audio por clip (fade in / fade out).
   *
   * A diferencia del `transition` (efecto de borde de vídeo que solo atenúa
   * el audio con `fade-black`/`fade-white`), estos fundidos son una
   * envolvente de ganancia 0..1 con curva propia (`linear` | `equalPower`,
   * por defecto `equalPower`) evaluada en el tiempo dentro del clip.
   *
   * Opcionales por compatibilidad: un clip sin fundidos suena a volumen
   * constante, como hoy. La duración está cuantizada a frames del proyecto y
   * recortada a la duración del clip (ver `clampClipAudioFades` en
   * `src/core/utils/audioFades.ts`); el motor y el export la reescalan si un
   * trim acorta el clip por debajo del fundido guardado, así que ambas
   * envolventes siempre acuerdan.
   */
  audioFadeIn?: AudioFade;
  audioFadeOut?: AudioFade;

  // Propiedades de Texto y Letras Sincronizadas
  text?: string;
  textStyle?: TextStyle;
  words?: WordTiming[];
}

/**
 * F9 · Colour filters of a clip.
 *
 * Every value is OPTIONAL and its absence means "neutral" (the clip is drawn
 * exactly as it comes out of the decoder):
 *
 * - `brightness`  1 = neutral (range 0..2)
 * - `contrast`    1 = neutral (range 0..2)
 * - `saturation`  1 = neutral (range 0..2)
 * - `temperature` 0 = neutral (range -1..1, cool -> warm)
 * - `grayscale`   0 = none   (range 0..1)
 * - `sepia`       0 = none   (range 0..1)
 *
 * The values are applied by the `Compositor`, which is the ONLY drawing path
 * of the app: the preview AND the export go through it, so the two can never
 * diverge (the same rule the playback speed follows).
 */
export interface ClipColorFilters {
  brightness?: number;  // 1 = neutral; range ~0..2
  contrast?: number;    // 1 = neutral; range ~0..2
  saturation?: number;  // 1 = neutral; range 0..2
  temperature?: number; // 0 = neutral; range -1..1 (cool -> warm)
  grayscale?: number;   // 0 = none;   range 0..1
  sepia?: number;       // 0 = none;   range 0..1
}

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  isMuted: boolean;
  isLocked: boolean;
  isVisible: boolean;
}

export interface Project {
  id: string;
  name: string;
  aspectRatio: AspectRatio;
  resolution: { width: number; height: number };
  fps: number;
  tracks: Track[];
  clips: Clip[];
  mediaPool: MediaItem[];
  /**
   * Duration of the timeline (seconds). It is DERIVED from the real extent of
   * the content: `max(clip.start + clip.duration)`. It must never be padded
   * with an arbitrary floor, because this is the value the exporter renders
   * and the value the export modal displays (KI-01 / S-06 / B-06).
   */
  duration: number;
  /**
   * Optional tail (seconds) added AFTER the last clip when computing
   * `duration`. Defaults to 0 (no padding): the exported video has to match
   * what the user sees in the timeline. Set it explicitly to opt in a tail.
   */
  endPaddingSeconds?: number;
  createdAt: number;
  updatedAt: number;
  /**
   * Policy applied when a clip is inserted over an existing clip (F1).
   * Optional for backwards compatibility: projects saved before F1 default
   * to `block` (the safest policy).
   */
  overlapPolicy?: OverlapPolicy;
  /**
   * Media trash (F2). Optional for backwards compatibility: projects saved
   * before F2 have no trash at all.
   */
  trash?: TrashEntry[];
}

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

export interface ExportConfig {
  aspectRatio: AspectRatio;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  format: 'mp4';
}

export interface ExportProgress {
  state: 'idle' | 'rendering' | 'muxing' | 'completed' | 'error';
  progress: number; // 0 a 100
  currentFrame: number;
  totalFrames: number;
  etaSeconds: number;
  error?: string;
  outputBlob?: Blob;
  downloadUrl?: string;
}
