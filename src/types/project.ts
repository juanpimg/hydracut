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

export interface ClipTransition {
  fadeInType: TransitionType;
  fadeInDuration: number;  // segundos
  fadeOutType: TransitionType;
  fadeOutDuration: number; // segundos
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

  // Propiedades de Texto y Letras Sincronizadas
  text?: string;
  textStyle?: TextStyle;
  words?: WordTiming[];
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
