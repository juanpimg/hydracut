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
import { ExportConfig, ExportProgress } from '../../types/project';
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
 */
export function describeExportProgress(progress: ExportProgress): string | null {
  switch (progress.state) {
    case 'idle':
      return null;
    case 'rendering': {
      const milestone = Math.floor(progress.progress / EXPORT_PROGRESS_MILESTONE) * EXPORT_PROGRESS_MILESTONE;
      if (milestone <= 0) return 'Exportando vídeo…';
      return `Exportando vídeo: ${milestone} %`;
    }
    case 'muxing':
      return 'Generando el archivo MP4 final…';
    case 'completed':
    case 'error':
      // Announced once through the app-wide live region.
      return '';
    default:
      return null;
  }
}

export const ExportModal: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  const { isExportModalOpen, setExportModalOpen } = useUIStore();

  const [hasWebCodecs, setHasWebCodecs] = useState<boolean>(true);
  const [resolutionPreset, setResolutionPreset] = useState<'1080p' | '720p' | '4k'>('1080p');
  const [fps, setFps] = useState<number>(30);
  const [bitrateMbps, setBitrateMbps] = useState<number>(8);
  const [progressState, setProgressState] = useState<ExportProgress>({
    state: 'idle',
    progress: 0,
    currentFrame: 0,
    totalFrames: 0,
    etaSeconds: 0,
  });

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
  const liveMessage = useMemo(() => describeExportProgress(progressState) ?? '', [progressState]);

  useEffect(() => {
    if (progressState.state === 'completed') {
      announce('Exportación completada: el vídeo MP4 se ha descargado');
    } else if (progressState.state === 'error') {
      announce(`Error al exportar: ${progressState.error ?? 'error desconocido'}`);
    }
  }, [progressState.state, progressState.error]);

  if (!isExportModalOpen) return null;

  const getDimensions = () => {
    const ratio = project.aspectRatio;
    let base = 1080;
    if (resolutionPreset === '720p') base = 720;
    if (resolutionPreset === '4k') base = 2160;

    let width = base;
    let height = base;
    if (ratio === '16:9') {
      width = Math.round((base * 16) / 9);
      height = base;
    } else if (ratio === '9:16') {
      width = base;
      height = Math.round((base * 16) / 9);
    }

    // Guarantee even numbers for hardware encoders
    width = width - (width % 2);
    height = height - (height % 2);
    return { width, height };
  };

  const handleStartExport = async () => {
    const dims = getDimensions();
    const config: ExportConfig = {
      aspectRatio: project.aspectRatio,
      width: dims.width,
      height: dims.height,
      fps,
      bitrate: bitrateMbps * 1_000_000,
      format: 'mp4',
    };

    abortControllerRef.current = new AbortController();

    // EX-08: a new export releases the object URL of the previous one, so the
    // previous video does not stay in RAM.
    revokeDownloadUrl();

    // The duration shown in the summary and the duration that is exported come
    // from the SAME source (`project.duration`).
    const exportDuration = project.duration;

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
        clips: project.clips,
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
      a.download = `${project.name.toLowerCase().replace(/\s+/g, '_')}_${resolutionPreset}.${extension}`;
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

  const dims = getDimensions();

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
              <h3 className="text-sm font-bold text-white">Exportar Video MP4</h3>
              <p className="text-xs text-slate-400">100% acelerado en el cliente (GPU nativa)</p>
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
        <div className="p-5 space-y-4">
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
                      onClick={() => setResolutionPreset(preset.id as '1080p' | '720p' | '4k')}
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
                  Dimensiones finales: {dims.width} x {dims.height} ({project.aspectRatio})
                </div>
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

              {/* Project summary */}
              <div className="bg-dark-950 p-2.5 rounded-lg border border-dark-800 text-[11px] text-slate-400 space-y-1">
                <div className="flex justify-between">
                  <span>Duración de exportación:</span>
                  <span className="font-mono text-slate-200">{project.duration} segundos</span>
                </div>
                <div className="flex justify-between">
                  <span>Total de fotogramas:</span>
                  <span className="font-mono text-slate-200">{Math.round(project.duration * fps)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Clips en el timeline:</span>
                  <span className="font-mono text-slate-200">{project.clips.length}</span>
                </div>
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
                  {progressState.state === 'rendering' && 'Codificando fotogramas con GPU...'}
                  {progressState.state === 'muxing' && 'Generando archivo MP4 final...'}
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
                  <span>Tu video MP4 ha sido descargado automáticamente.</span>
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
                disabled={isEmptyProject}
                title={isEmptyProject ? 'Añade clips al timeline primero' : 'Comenzar exportación'}
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
