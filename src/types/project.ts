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
  duration: number;
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
