import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { 
  X, 
  Download, 
  Film, 
  Cpu, 
  CheckCircle, 
  AlertCircle, 
  Settings2,
  StopCircle
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import { formatTimecode } from '../../core/utils/time';
import { AspectRatio, Clip, ExportConfig, ExportProgress } from '../../types/project';
import { announce } from '../layout/liveRegion';

/**
 * Formats the "Tiempo restante" label of the export modal.
 *
 * Returns `null` when the label must be hidden (the export already finished,
 * so an ETA of "0 s" or "Calculando..." is just noise — it used to stay
 * showing "Calculando..." forever at 100 %).
 */
export function formatExportEta(
  state: ExportProgress['state'],
  etaSeconds: number
): string | null {
  if (state === 'completed' || state === 'error') return null;
  if (!Number.isFinite(etaSeconds) || etaSeconds <= 0) return 'Calculando...';
  return `~${Math.round(etaSeconds)}s`;
}

/**
 * Coarse milestones used to announce the export progress.
 *
 * The progress is reported on every rendered frame; announcing it frame by
 * frame would flood the screen reader queue, so only the state transitions
 * and the 25 % steps are announced (UI-16).
 */
export const EXPORT_PROGRESS_MILESTONE = 25;

/**
 * Builds the message that is announced for the given export state.
 *
 * Returns `null` when the state must NOT be announced (idle) and an empty
 * string for the terminal states, which are announced through the app-wide
 * live region instead (so they are not read twice).
 *
 * `format` only changes the container named in the muxing message (MP4 por
 * defecto: las llamadas existentes sin formato siguen diciendo MP4).
 */
export function describeExportProgress(
  progress: ExportProgress,
  format: 'mp4' | 'webm' = 'mp4'
): string | null {
  switch (progress.state) {
    case 'idle':
      return null;
    case 'rendering': {
      const milestone = Math.floor(progress.progress / EXPORT_PROGRESS_MILESTONE) * EXPORT_PROGRESS_MILESTONE;
      if (milestone <= 0) return 'Exportando vídeo…';
      return `Exportando vídeo: ${milestone} %`;
    }
    case 'muxing':
      return format === 'webm' ? 'Generando el archivo WebM final…' : 'Generando el archivo MP4 final…';
    case 'completed':
    case 'error':
      // Announced once through the app-wide live region.
      return '';
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* F10 — Export presets and export range                               */
/* ------------------------------------------------------------------ */

/** Resolutions offered by the export modal. */
export type ExportResolution = '720p' | '1080p' | '4k';

/**
 * A ready-made export configuration (F10).
 *
 * A preset is just a shortcut for the three controls of the modal
 * (resolution, fps and bitrate) plus the aspect ratio of the file.
 */
export interface ExportPreset {
  id: string;
  /** Spanish label of the button. */
  label: string;
  /** Spanish hint shown under the label. */
  hint: string;
  /** Resolution of the exported file. */
  resolution: ExportResolution;
  /** Frames per second. */
  fps: number;
  /** Bitrate in Mbps. */
  bitrateMbps: number;
  /** Aspect ratio of the exported file. */
  aspectRatio: AspectRatio;
}

/**
 * The export presets (F10).
 *
 * They replace the "raw sliders" experience: one click sets the resolution,
 * the frame rate, the bitrate AND the aspect ratio of the exported file.
 */
export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'web-720p',
    label: 'Web',
    hint: '720p · 30 fps · 6 Mbps',
    resolution: '720p',
    fps: 30,
    bitrateMbps: 6,
    aspectRatio: '16:9',
  },
  {
    id: 'social-1080p',
    label: 'Social 1080p',
    hint: '1920×1080 · 30 fps · 8 Mbps',
    resolution: '1080p',
    fps: 30,
    bitrateMbps: 8,
    aspectRatio: '16:9',
  },
  {
    id: 'vertical-9x16',
    label: 'Vertical 1080×1920',
    hint: '9:16 · 30 fps · 8 Mbps',
    resolution: '1080p',
    fps: 30,
    bitrateMbps: 8,
    aspectRatio: '9:16',
  },
  {
    id: 'high-quality-1080p60',
    label: 'Alta calidad',
    hint: '1080p · 60 fps · 12 Mbps',
    resolution: '1080p',
    fps: 60,
    bitrateMbps: 12,
    aspectRatio: '16:9',
  },
];

/** Height (pixels) of the exported frame for each resolution. */
const RESOLUTION_BASE_HEIGHT: Record<ExportResolution, number> = {
  '720p': 720,
  '1080p': 1080,
  '4k': 2160,
};

/**
 * Dimensions of the exported file for a resolution + aspect ratio.
 *
 * The dimensions are always EVEN: the hardware H.264 encoders reject odd
 * sizes.
 */
export function computeExportDimensions(
  resolution: ExportResolution,
  aspectRatio: AspectRatio
): { width: number; height: number } {
  const base = RESOLUTION_BASE_HEIGHT[resolution] ?? 1080;
  let width = base;
  let height = base;
  if (aspectRatio === '16:9') {
    width = Math.round((base * 16) / 9);
    height = base;
  } else if (aspectRatio === '9:16') {
    width = base;
    height = Math.round((base * 16) / 9);
  }
  width = width - (width % 2);
  height = height - (height % 2);
  return { width, height };
}

/**
 * The preset that matches the current settings of the modal (or `null`).
 *
 * The active preset is DERIVED from the settings: moving a slider makes the
 * preset stop matching, and it is deselected automatically.
 */
export function findActivePreset(settings: {
  resolution: ExportResolution;
  fps: number;
  bitrateMbps: number;
  aspectRatio: AspectRatio;
}): ExportPreset | null {
  return (
    EXPORT_PRESETS.find(
      (preset) =>
        preset.resolution === settings.resolution &&
        preset.fps === settings.fps &&
        preset.bitrateMbps === settings.bitrateMbps &&
        preset.aspectRatio === settings.aspectRatio
    ) ?? null
  );
}

/** How the range of the export is chosen. */
export type ExportRangeMode = 'full' | 'custom';

/** State of the export range owned by the modal (F10). */
export interface ExportRangeState {
  mode: ExportRangeMode;
  /** In point (timeline seconds). `null` = not marked yet. */
  start: number | null;
  /** Out point (timeline seconds). `null` = not marked yet. */
  end: number | null;
}

/** A resolved export range. */
export interface ExportRange {
  /** First exported second (timeline time). */
  start: number;
  /** Last exported second (timeline time, exclusive). */
  end: number;
  /** Duration of the range (seconds). */
  duration: number;
}

/**
 * True when the custom range can be exported (both markers are set and the
 * out point is AFTER the in point).
 */
export function isExportRangeValid(state: ExportRangeState): boolean {
  if (state.mode === 'full') return true;
  if (state.start === null || state.end === null) return false;
  if (!Number.isFinite(state.start) || !Number.isFinite(state.end)) return false;
  return state.end > state.start;
}

/**
 * Resolves the range that will be exported.
 *
 * Returns `null` when the WHOLE project is exported (the default: the
 * behaviour is unchanged when the user does not choose a range).
 */
export function resolveExportRange(
  state: ExportRangeState,
  projectDuration: number
): ExportRange | null {
  if (state.mode === 'full') return null;
  if (!isExportRangeValid(state)) return null;
  const limit = Number.isFinite(projectDuration) && projectDuration > 0 ? projectDuration : 0;
  const start = Math.max(0, Math.min(state.start as number, limit));
  const end = Math.max(0, Math.min(state.end as number, limit));
  if (end <= start) return null;
  return { start, end, duration: end - start };
}

/**
 * Re-bases the clips into the exported range.
 *
 * The exporter renders the timeline from 0 to `duration`, so a range export
 * is expressed by moving every clip `rangeStart` seconds to the left and
 * advancing its source window accordingly. The clips that do not intersect
 * the range are dropped and the ones that cross a border are trimmed.
 */
export function buildRangeExportClips(
  clips: Clip[],
  rangeStart: number,
  rangeEnd: number
): Clip[] {
  const out: Clip[] = [];
  for (const clip of clips) {
    const clipStart = clip.start;
    const clipStop = clip.start + clip.duration;
    const start = Math.max(clipStart, rangeStart);
    const stop = Math.min(clipStop, rangeEnd);
    if (stop - start <= 0) continue;
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    out.push({
      ...clip,
      start: start - rangeStart,
      duration: stop - start,
      sourceStart: clip.sourceStart + (start - clipStart) * speed,
    });
  }
  return out;
}

/**
 * Formats a time as `HH:MM:SS:FF` (the timecode shown next to the range).
 *
 * It delegates to the shared `formatTimecode` helper used by the player
 * controls (`PlayerControls.tsx`), so the modal shows exactly the same
 * frame-accurate format as the rest of the app. `fps` must be the PROJECT
 * frame rate: the range markers are timeline times, and the timeline is
 * frame-based (30 fps → frames of 1/30 s). The previous `Math.floor`
 * version truncated the fraction, so a 0,9 s → 1,1 s range displayed
 * «00:00:00 → 00:00:01 (0.2 s)»: times contradicting the duration.
 */
export function formatExportTimecode(seconds: number, fps: number = 30): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return formatTimecode(safe, safeFps);
}

/**
 * Formats a number of seconds without the noise of the floating point
 * (`7` instead of `7.000000000000001`).
 */
export function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

/**
 * Label of the exported range: "Exportando 00:00:05:00 → 00:00:12:00 (7 s)".
 *
 * `fps` must be the PROJECT frame rate (see `formatExportTimecode`).
 */
export function formatExportRange(range: ExportRange, fps: number = 30): string {
  return (
    `Exportando ${formatExportTimecode(range.start, fps)} → ${formatExportTimecode(range.end, fps)} ` +
    `(${formatSeconds(range.duration)} s)`
  );
}

/**
 * Tamaño en bytes en formato legible (español, coma decimal).
 *
 * Puro y compartido: el mismo formato lo puede reutilizar el panel de
 * almacenamiento. `0 B` para valores no finitos o no positivos.
 */
export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  const rounded =
    scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace('.', ',');
  return `${rounded} ${units[unit]}`;
}

/**
 * Bitrate EFECTIVO de un archivo ya producido: bytes reales × 8 / duración.
 *
 * No es una estimación del ajuste de calidad del modal: se calcula con el
 * tamaño real del blob exportado, así que es lo que el vídeo ocupa de
 * verdad (decide si se puede subir a una plataforma).
 */
export function formatBitrate(bytes: number, durationSeconds: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'no disponible';
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 'no disponible';
  const bps = (bytes * 8) / durationSeconds;
  if (bps < 1000) return `${Math.round(bps)} bps`;
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(1).replace('.', ',')} kbps`;
  return `${(bps / 1_000_000).toFixed(2).replace('.', ',')} Mbps`;
}

export const ExportModal: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  const currentTime = useProjectStore((s) => s.currentTime);
  const { isExportModalOpen, setExportModalOpen } = useUIStore();

  const [hasWebCodecs, setHasWebCodecs] = useState<boolean>(true);
  const [resolutionPreset, setResolutionPreset] = useState<ExportResolution>('1080p');
  const [fps, setFps] = useState<number>(30);
  const [bitrateMbps, setBitrateMbps] = useState<number>(8);
  /**
   * Formato del archivo exportado (MP4 por defecto: el comportamiento
   * histórico no cambia).
   *
   * - `mp4`: camino acelerado WebCodecs (H.264) con respaldo MediaRecorder.
   * - `webm`: SIEMPRE el grabador de respaldo (MediaRecorder, VP9/VP8), en
   *   tiempo real y sin aceleración GPU (ver el aviso bajo el selector).
   */
  const [exportFormat, setExportFormat] = useState<'mp4' | 'webm'>('mp4');
  /**
   * F10: the aspect ratio of the EXPORTED FILE.
   *
   * It belongs to the modal, NOT to the project: clicking the "Vertical"
   * preset must not reformat (and persist!) the project the user is
   * editing. The exported frame is vertical, the timeline keeps its shape.
   */
  const [exportAspectRatio, setExportAspectRatio] = useState<AspectRatio>(project.aspectRatio);
  /**
   * F10: the export range owned by the modal. The default (`full`) keeps the
   * previous behaviour: the WHOLE project is exported.
   */
  const [rangeState, setRangeState] = useState<ExportRangeState>({
    mode: 'full',
    start: null,
    end: null,
  });
  const [progressState, setProgressState] = useState<ExportProgress>({
    state: 'idle',
    progress: 0,
    currentFrame: 0,
    totalFrames: 0,
    etaSeconds: 0,
  });
  /**
   * Tamaño REAL del último archivo producido (bytes del blob + duración
   * exportada). Se fija al completar: el "100 %" solo dice que terminó, el
   * tamaño dice si el vídeo se puede subir.
   */
  const [exportResult, setExportResult] = useState<{ bytes: number; durationSeconds: number } | null>(
    null
  );

  const abortControllerRef = useRef<AbortController | null>(null);
  const downloadUrlRef = useRef<string | null>(null);

  const isEmptyProject = project.clips.length === 0;

  /**
   * Releases the object URL of the previous export. Without this the whole
   * exported video stayed in RAM for the whole session (EX-08).
   */
  const revokeDownloadUrl = useCallback(() => {
    if (downloadUrlRef.current) {
      try {
        URL.revokeObjectURL(downloadUrlRef.current);
      } catch {
        // ignore
      }
      downloadUrlRef.current = null;
    }
  }, []);

  /**
   * The exporter (and `mp4-muxer` with it) is loaded ON DEMAND.
   *
   * The export pipeline is ~22 KB gzip of code that is useless until the user
   * actually exports something, so it is kept out of the initial bundle
   * (B-10 / F6). The capability probe is only run when the modal is opened.
   */
  useEffect(() => {
    if (!isExportModalOpen) return;
    let cancelled = false;
    import('../../core/export/webcodecsExporter')
      .then((mod) => mod.isWebCodecsSupported())
      .then((supported) => {
        if (!cancelled) setHasWebCodecs(supported);
      })
      .catch(() => {
        if (!cancelled) setHasWebCodecs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isExportModalOpen]);

  // Revoke the object URL when the modal unmounts.
  useEffect(() => revokeDownloadUrl, [revokeDownloadUrl]);

  // Close on Escape (unless an export is actively rendering)
  useEffect(() => {
    if (!isExportModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && progressState.state !== 'rendering') {
        setExportModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isExportModalOpen, progressState.state, setExportModalOpen]);

  /**
   * UI-16: the export progress is announced to the screen readers on the
   * state transitions and on the coarse milestones (never on every frame).
   *
   * The milestones are announced by the live region of the modal itself
   * (see the `role="status"` block below); the terminal states are announced
   * through the app-wide live region, so they are heard even after the modal
   * is closed.
   */
  const liveMessage = useMemo(
    () => describeExportProgress(progressState, exportFormat) ?? '',
    [progressState, exportFormat]
  );

  useEffect(() => {
    if (progressState.state === 'completed') {
      announce(
        exportFormat === 'webm'
          ? 'Exportación completada: el vídeo WebM se ha descargado'
          : 'Exportación completada: el vídeo MP4 se ha descargado'
      );
    } else if (progressState.state === 'error') {
      announce(`Error al exportar: ${progressState.error ?? 'error desconocido'}`);
    }
  }, [progressState.state, progressState.error, exportFormat]);

  if (!isExportModalOpen) return null;

  /**
   * F10: the dimensions of the exported file. They follow the resolution AND
   * the aspect ratio of the export (the vertical preset exports a really
   * 1080×1920 file).
   */
  const dims = computeExportDimensions(resolutionPreset, exportAspectRatio);

  /**
   * F10: the preset that matches the current settings. It is derived, so
   * moving a slider deselects the preset automatically.
   */
  const activePreset = findActivePreset({
    resolution: resolutionPreset,
    fps,
    bitrateMbps,
    aspectRatio: exportAspectRatio,
  });

  /** F10: the range that will be exported (`null` = the whole project). */
  const range = resolveExportRange(rangeState, project.duration);
  /** The custom range is incomplete: the export must be blocked. */
  const rangeIncomplete = rangeState.mode === 'custom' && !isExportRangeValid(rangeState);
  /** Duration (seconds) that is really rendered. */
  const exportDuration = range ? range.duration : project.duration;
  /** Clips handed to the exporter (re-based when a range is used). */
  const exportClips = range
    ? buildRangeExportClips(project.clips, range.start, range.end)
    : project.clips;

  /**
   * Bytes y duración REALES del último archivo completado: del blob
   * producido (no estimados del ajuste de calidad).
   */
  const resultBytes = exportResult?.bytes ?? progressState.outputBlob?.size ?? 0;
  const resultDurationSeconds =
    exportResult && exportResult.durationSeconds > 0
      ? exportResult.durationSeconds
      : exportDuration;

  /**
   * F10: applies a preset (one click sets resolution, fps, bitrate and the
   * aspect ratio of the exported file).
   *
   * The aspect ratio belongs to the EXPORT: the project is NOT modified (a
   * dialog that reformats the timeline behind the user's back would be a
   * nasty surprise, and the change would be persisted).
   */
  const applyPreset = (preset: ExportPreset) => {
    setResolutionPreset(preset.resolution);
    setFps(preset.fps);
    setBitrateMbps(preset.bitrateMbps);
    setExportAspectRatio(preset.aspectRatio);
  };

  /** F10: marks the in point of the export at the current playhead. */
  const markRangeStart = () => {
    const time = Math.max(0, Math.min(currentTime, project.duration));
    setRangeState((prev) => ({ ...prev, mode: 'custom', start: time }));
  };

  /** F10: marks the out point of the export at the current playhead. */
  const markRangeEnd = () => {
    const time = Math.max(0, Math.min(currentTime, project.duration));
    setRangeState((prev) => ({ ...prev, mode: 'custom', end: time }));
  };

  const handleStartExport = async () => {
    const config: ExportConfig = {
      aspectRatio: exportAspectRatio,
      width: dims.width,
      height: dims.height,
      fps,
      bitrate: bitrateMbps * 1_000_000,
      format: exportFormat,
    };

    abortControllerRef.current = new AbortController();

    // EX-08: a new export releases the object URL of the previous one, so the
    // previous video does not stay in RAM.
    revokeDownloadUrl();
    setExportResult(null);

    // The duration shown in the summary and the duration that is exported come
    // from the SAME source (the range when there is one, `project.duration`
    // otherwise).
    setProgressState({
      state: 'rendering',
      progress: 0,
      currentFrame: 0,
      totalFrames: Math.round(exportDuration * fps),
      etaSeconds: 0,
    });

    // The exporter (and `mp4-muxer`) is loaded on demand: it is ~22 KB gzip
    // of code that is useless until the user exports something (F6).
    let exporter: typeof import('../../core/export/webcodecsExporter') | null = null;
    try {
      exporter = await import('../../core/export/webcodecsExporter');
      const blob = await exporter.exportVideo({
        config,
        duration: exportDuration,
        tracks: project.tracks,
        clips: exportClips,
        mediaPool: project.mediaPool,
        onProgress: (p) => setProgressState(p),
        signal: abortControllerRef.current.signal,
      });

      // Auto download
      const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
      const url = URL.createObjectURL(blob);
      downloadUrlRef.current = url;
      const a = document.createElement('a');
      a.href = url;
      const rangeSuffix = range ? `_${formatSeconds(range.start)}-${formatSeconds(range.end)}` : '';
      a.download = `${project.name.toLowerCase().replace(/\s+/g, '_')}_${resolutionPreset}${rangeSuffix}.${extension}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setProgressState((prev) => ({
        ...prev,
        state: 'completed',
        progress: 100,
        // The export is over: no ETA left (the label used to stay at
        // "Calculando..." forever).
        etaSeconds: 0,
        outputBlob: blob,
        downloadUrl: url,
      }));
      // Tamaño REAL del archivo producido (no estimado): bytes del blob y
      // duración exportada para el bitrate efectivo.
      setExportResult({ bytes: blob.size, durationSeconds: exportDuration });
    } catch (err) {
      // EX-23: the error may not be an `Error` (a string, a DOMException or
      // even `undefined`); reading `.message` off it used to throw *inside*
      // this catch and left the modal stuck in "rendering" forever.
      const rawMessage = err instanceof Error ? err.message : String(err ?? '');
      const errorName = (err as { name?: string } | null | undefined)?.name;
      const isAbort =
        (exporter ? exporter.isAbortLikeError(err) : false) ||
        errorName === 'AbortError' ||
        errorName === 'TimeoutError' ||
        /cancelad|canceled|cancelled|abort/i.test(rawMessage);
      if (isAbort) {
        setProgressState({
          state: 'idle',
          progress: 0,
          currentFrame: 0,
          totalFrames: 0,
          etaSeconds: 0,
        });
      } else {
        const message = exporter
          ? exporter.toErrorMessage(err, 'Error durante la exportación')
          : rawMessage || 'Error durante la exportación';
        setProgressState((prev) => ({
          ...prev,
          state: 'error',
          error: message,
        }));
      }
    }
  };

  const handleCancelExport = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setProgressState({
      state: 'idle',
      progress: 0,
      currentFrame: 0,
      totalFrames: 0,
      etaSeconds: 0,
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Exportar video"
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none animate-fadeIn"
      onClick={(e) => {
        if (e.target === e.currentTarget && progressState.state !== 'rendering') {
          setExportModalOpen(false);
        }
      }}
    >
      <div className="bg-dark-900 border border-dark-800 rounded-xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
        {/* Modal Header */}
        <div className="px-5 py-4 border-b border-dark-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-cyan-500/10 text-cyan-400 rounded-lg border border-cyan-500/30">
              <Film size={18} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">
                {exportFormat === 'webm' ? 'Exportar Video WebM' : 'Exportar Video MP4'}
              </h3>
              <p className="text-xs text-slate-400">
                {exportFormat === 'webm'
                  ? 'Grabación en tiempo real (respaldo MediaRecorder)'
                  : '100% acelerado en el cliente (GPU nativa)'}
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              if (progressState.state === 'rendering') handleCancelExport();
              setExportModalOpen(false);
            }}
            aria-label="Cerrar modal de exportación"
            className="text-slate-400 hover:text-white p-1 rounded-lg transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Content */}
        <div className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
          {/* Hardware acceleration badge */}
          <div className={`p-2.5 rounded-lg border flex items-center gap-2.5 text-xs ${
            hasWebCodecs 
              ? 'bg-blue-950/40 border-blue-800/60 text-blue-300' 
              : 'bg-amber-950/40 border-amber-800/60 text-amber-300'
          }`}>
            <Cpu size={16} className="shrink-0" />
            <div>
              <span className="font-semibold">
                {hasWebCodecs ? 'Aceleración WebCodecs Activa' : 'Exportación MediaRecorder'}
              </span>
              <p className="text-[11px] opacity-80">
                {hasWebCodecs
                  ? 'Codificación H.264 acelerada por GPU mediante WebCodecs y mp4-muxer.'
                  : 'Navegador sin WebCodecs completo; utilizando renderizador de respaldo.'}
              </p>
            </div>
          </div>

          {progressState.state === 'idle' ? (
            <>
              {/* Formato del archivo: MP4 (acelerado) o WebM (respaldo en tiempo real) */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                  Formato de exportación:
                </label>
                <div className="grid grid-cols-2 gap-2" data-testid="export-format-picker">
                  <button
                    type="button"
                    data-testid="export-format-mp4"
                    aria-pressed={exportFormat === 'mp4'}
                    aria-label="Exportar en formato MP4 (acelerado por GPU)"
                    onClick={() => setExportFormat('mp4')}
                    className={`py-2 px-3 rounded-lg text-xs font-medium border transition ${
                      exportFormat === 'mp4'
                        ? 'bg-blue-600 text-white border-blue-500 shadow-sm'
                        : 'bg-dark-950 text-slate-400 border-dark-800 hover:text-white hover:bg-dark-850'
                    }`}
                  >
                    MP4
                  </button>
                  <button
                    type="button"
                    data-testid="export-format-webm"
                    aria-pressed={exportFormat === 'webm'}
                    aria-label="Exportar en formato WebM (respaldo en tiempo real)"
                    onClick={() => setExportFormat('webm')}
                    className={`py-2 px-3 rounded-lg text-xs font-medium border transition ${
                      exportFormat === 'webm'
                        ? 'bg-blue-600 text-white border-blue-500 shadow-sm'
                        : 'bg-dark-950 text-slate-400 border-dark-800 hover:text-white hover:bg-dark-850'
                    }`}
                  >
                    WebM
                  </button>
                </div>
                {exportFormat === 'webm' && (
                  <div
                    role="note"
                    data-testid="export-webm-realtime-note"
                    className="mt-2 p-2 bg-amber-950/40 border border-amber-800/60 rounded-lg text-amber-300 text-[11px] leading-snug"
                  >
                    WebM usa el grabador de respaldo (MediaRecorder, VP9/VP8): graba en
                    tiempo real — un proyecto de 10 s tarda 10 s en exportarse — y no
                    usa la aceleración por GPU del camino MP4. El resultado es válido
                    y reproducible, con vídeo y audio.
                  </div>
                )}
              </div>

              {/* F10: one-click export presets */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1.5 flex items-center gap-1.5">
                  <Settings2 size={13} />
                  <span>Preajustes de exportación:</span>
                </label>
                <div className="grid grid-cols-2 gap-2" data-testid="export-presets">
                  {EXPORT_PRESETS.map((preset) => {
                    const isActive = activePreset?.id === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        data-testid={`export-preset-${preset.id}`}
                        aria-pressed={isActive}
                        title={`${preset.label} — ${preset.hint}`}
                        onClick={() => applyPreset(preset)}
                        className={`py-2 px-2 rounded-lg text-[11px] font-medium border transition text-left ${
                          isActive
                            ? 'bg-blue-600 text-white border-blue-500 shadow-sm'
                            : 'bg-dark-950 text-slate-300 border-dark-800 hover:text-white hover:bg-dark-850'
                        }`}
                      >
                        <span className="block truncate">{preset.label}</span>
                        <span className={`block text-[9px] font-mono ${isActive ? 'text-blue-100' : 'text-slate-500'}`}>
                          {preset.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Resolution Presets */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1.5 flex items-center gap-1.5">
                  <Settings2 size={13} />
                  <span>Resolución:</span>
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: '720p', label: '720p HD' },
                    { id: '1080p', label: '1080p FHD' },
                    { id: '4k', label: '4K UHD' },
                  ].map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => setResolutionPreset(preset.id as ExportResolution)}
                      className={`py-2 px-3 rounded-lg text-xs font-medium border transition ${
                        resolutionPreset === preset.id
                          ? 'bg-blue-600 text-white border-blue-500 shadow-sm'
                          : 'bg-dark-950 text-slate-400 border-dark-800 hover:text-white hover:bg-dark-850'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <div className="mt-1 text-[11px] text-slate-500 font-mono">
                  Dimensiones finales: {dims.width} x {dims.height} ({exportAspectRatio})
                </div>
                {exportAspectRatio !== project.aspectRatio && (
                  <div className="mt-0.5 text-[10px] text-amber-300/90">
                    El archivo exportado es{' '}
                    {exportAspectRatio === '9:16'
                      ? 'vertical'
                      : exportAspectRatio === '1:1'
                        ? 'cuadrado'
                        : 'panorámico'}
                    ; el proyecto sigue en {project.aspectRatio}.
                  </div>
                )}
              </div>

              {/* Framerate Selection */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                  Tasa de Cuadros (FPS):
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[30, 60].map((f) => (
                    <button
                      key={f}
                      onClick={() => setFps(f)}
                      className={`py-2 rounded-lg text-xs font-medium border transition ${
                        fps === f
                          ? 'bg-blue-600 text-white border-blue-500 shadow-sm'
                          : 'bg-dark-950 text-slate-400 border-dark-800 hover:text-white hover:bg-dark-850'
                      }`}
                    >
                      {f} FPS
                    </button>
                  ))}
                </div>
              </div>

              {/* Bitrate Control */}
              <div>
                <div className="flex justify-between text-xs font-semibold text-slate-300 mb-1.5">
                  <span>Tasa de Bits (Calidad):</span>
                  <span className="font-mono text-cyan-400">{bitrateMbps} Mbps</span>
                </div>
                <input
                  type="range"
                  min="2"
                  max="20"
                  step="1"
                  value={bitrateMbps}
                  aria-label="Tasa de bits en megabits por segundo"
                  onChange={(e) => setBitrateMbps(parseInt(e.target.value))}
                  className="w-full h-1.5 bg-dark-750 accent-cyan-400 rounded cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
                />
              </div>

              {/* F10: export range (in / out markers) */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                  Rango de exportación:
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    data-testid="export-range-full"
                    aria-pressed={rangeState.mode === 'full'}
                    onClick={() => setRangeState((prev) => ({ ...prev, mode: 'full' }))}
                    className={`py-2 rounded-lg text-xs font-medium border transition ${
                      rangeState.mode === 'full'
                        ? 'bg-blue-600 text-white border-blue-500 shadow-sm'
                        : 'bg-dark-950 text-slate-400 border-dark-800 hover:text-white hover:bg-dark-850'
                    }`}
                  >
                    Todo el proyecto
                  </button>
                  <button
                    type="button"
                    data-testid="export-range-custom"
                    aria-pressed={rangeState.mode === 'custom'}
                    onClick={() => setRangeState((prev) => ({ ...prev, mode: 'custom' }))}
                    className={`py-2 rounded-lg text-xs font-medium border transition ${
                      rangeState.mode === 'custom'
                        ? 'bg-blue-600 text-white border-blue-500 shadow-sm'
                        : 'bg-dark-950 text-slate-400 border-dark-800 hover:text-white hover:bg-dark-850'
                    }`}
                  >
                    Rango personalizado
                  </button>
                </div>

                {rangeState.mode === 'custom' && (
                  <div className="mt-2 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        data-testid="export-range-mark-in"
                        onClick={markRangeStart}
                        className="py-1.5 px-2 rounded-lg text-[11px] font-medium border border-dark-800 bg-dark-950 text-slate-300 hover:text-white hover:bg-dark-850 transition"
                      >
                        Marcar entrada
                      </button>
                      <button
                        type="button"
                        data-testid="export-range-mark-out"
                        onClick={markRangeEnd}
                        className="py-1.5 px-2 rounded-lg text-[11px] font-medium border border-dark-800 bg-dark-950 text-slate-300 hover:text-white hover:bg-dark-850 transition"
                      >
                        Marcar salida
                      </button>
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      Cabezal de reproducción: {formatExportTimecode(currentTime, project.fps)}
                    </div>
                    {rangeIncomplete && (
                      <div role="alert" className="p-2 bg-amber-950/40 border border-amber-800/60 rounded-lg text-amber-300 text-[11px]">
                        Marca la entrada y la salida del rango (la salida debe ser posterior a la entrada).
                      </div>
                    )}
                  </div>
                )}

                <div
                  data-testid="export-range-summary"
                  className="mt-2 text-[11px] font-mono text-cyan-300"
                >
                  {range ? formatExportRange(range, project.fps) : 'Exportando el proyecto completo'}
                </div>
              </div>

              {/* Project summary */}
              <div className="bg-dark-950 p-2.5 rounded-lg border border-dark-800 text-[11px] text-slate-400 space-y-1">
                <div className="flex justify-between">
                  <span>Duración de exportación:</span>
                  <span className="font-mono text-slate-200">{formatSeconds(exportDuration)} segundos</span>
                </div>
                <div className="flex justify-between">
                  <span>Total de fotogramas:</span>
                  <span className="font-mono text-slate-200">{Math.round(exportDuration * fps)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Clips en el timeline:</span>
                  <span className="font-mono text-slate-200">{project.clips.length}</span>
                </div>
                {range && (
                  <div className="flex justify-between">
                    <span>Rango de exportación:</span>
                    <span className="font-mono text-slate-200">
                      {formatExportTimecode(range.start, project.fps)} → {formatExportTimecode(range.end, project.fps)}
                    </span>
                  </div>
                )}
              </div>
              {isEmptyProject && (
                <div role="alert" className="p-2.5 bg-amber-950/40 border border-amber-800/60 rounded-lg text-amber-300 text-xs">
                  Añade al menos un clip al timeline antes de exportar.
                </div>
              )}
            </>
          ) : (
            /* Progress view */
            <div className="py-4 space-y-4">
              {/*
                UI-16: the progress is exposed to the screen readers through a
                polite live region. It only carries the COARSE milestones (the
                state transitions and the 25 % steps): announcing every frame
                would flood the announcement queue.
              */}
              <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                {liveMessage}
              </div>

              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-300 font-medium">
                  {progressState.state === 'rendering' && (exportFormat === 'webm' ? 'Grabando en tiempo real con MediaRecorder...' : 'Codificando fotogramas con GPU...')}
                  {progressState.state === 'muxing' && (exportFormat === 'webm' ? 'Generando archivo WebM final...' : 'Generando archivo MP4 final...')}
                  {progressState.state === 'completed' && '¡Exportación exitosa!'}
                  {progressState.state === 'error' && 'Error al exportar'}
                </span>
                <span className="font-mono font-bold text-cyan-400">{progressState.progress}%</span>
              </div>

              {/* Progress bar */}
              <div
                role="progressbar"
                aria-label="Progreso de exportación de video"
                aria-valuenow={progressState.progress}
                aria-valuemin={0}
                aria-valuemax={100}
                className="w-full h-2.5 bg-dark-950 rounded-full overflow-hidden border border-dark-800 p-0.5"
              >
                <div
                  style={{ width: `${progressState.progress}%` }}
                  className="h-full bg-cyan-400 rounded-full transition-all duration-200"
                />
              </div>

              {/* Stats */}
              <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400 bg-dark-950 p-2.5 rounded-lg border border-dark-800">
                <div>
                  <span>Cuadro actual:</span>{' '}
                  <span className="font-mono text-slate-200">
                    {progressState.currentFrame} / {progressState.totalFrames}
                  </span>
                </div>
                {formatExportEta(progressState.state, progressState.etaSeconds) !== null && (
                  <div>
                    <span>Tiempo restante:</span>{' '}
                    <span className="font-mono text-slate-200">
                      {formatExportEta(progressState.state, progressState.etaSeconds)}
                    </span>
                  </div>
                )}
              </div>

              {progressState.state === 'completed' && (
                <div className="p-3 bg-emerald-950/40 border border-emerald-800/60 rounded-lg text-emerald-300 text-xs flex items-center gap-2">
                  <CheckCircle size={16} />
                  <span>
                    {exportFormat === 'webm'
                      ? 'Tu video WebM ha sido descargado automáticamente.'
                      : 'Tu video MP4 ha sido descargado automáticamente.'}
                  </span>
                </div>
              )}

              {/* Tamaño REAL del archivo producido + bitrate efectivo
                  (bytes × 8 / duración): es lo que decide si el vídeo se
                  puede subir a una plataforma. */}
              {progressState.state === 'completed' && (
                <div
                  data-testid="export-result-size"
                  role="status"
                  className="p-3 bg-dark-950 border border-dark-800 rounded-lg text-xs text-slate-300 space-y-1"
                >
                  <div className="flex justify-between">
                    <span>Tamaño del archivo:</span>
                    <span className="font-mono text-white">{formatBytes(resultBytes)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Bitrate efectivo:</span>
                    <span className="font-mono text-white" data-testid="export-result-bitrate">
                      {formatBitrate(resultBytes, resultDurationSeconds)}
                    </span>
                  </div>
                </div>
              )}

              {progressState.state === 'error' && (
                <div className="p-3 bg-red-950/40 border border-red-800/60 rounded-lg text-red-300 text-xs flex items-center gap-2">
                  <AlertCircle size={16} />
                  <span>{progressState.error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 border-t border-dark-800 flex items-center justify-end gap-2 bg-dark-950">
          {progressState.state === 'idle' ? (
            <>
              <button
                onClick={() => setExportModalOpen(false)}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-white rounded-lg transition"
              >
                Cancelar
              </button>
              <button
                onClick={handleStartExport}
                disabled={isEmptyProject || rangeIncomplete}
                title={
                  isEmptyProject
                    ? 'Añade clips al timeline primero'
                    : rangeIncomplete
                      ? 'Marca la entrada y la salida del rango antes de exportar'
                      : 'Comenzar exportación'
                }
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs rounded-lg shadow-lg shadow-blue-500/20 active:scale-95 transition disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              >
                <Download size={14} />
                <span>Comenzar Exportación</span>
              </button>
            </>
          ) : progressState.state === 'rendering' ? (
            <button
              onClick={handleCancelExport}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-950/40 hover:bg-red-900/60 text-red-300 border border-red-800/60 text-xs rounded-lg transition"
            >
              <StopCircle size={14} />
              <span>Cancelar Exportación</span>
            </button>
          ) : (
            <button
              onClick={() => {
                revokeDownloadUrl();
                setExportResult(null);
                setProgressState({ state: 'idle', progress: 0, currentFrame: 0, totalFrames: 0, etaSeconds: 0 });
                setExportModalOpen(false);
              }}
              className="px-4 py-1.5 bg-dark-800 hover:bg-dark-750 text-white text-xs rounded-lg transition"
            >
              Cerrar
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Default export: the modal is loaded with `React.lazy()` so the exporter and
 * `mp4-muxer` never reach the initial bundle (F3/B-10).
 */
export default ExportModal;
