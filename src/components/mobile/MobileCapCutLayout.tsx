import React, { Suspense, lazy, useState } from 'react';
import { MobileHeader } from './MobileHeader';
import { Timeline } from '../timeline/Timeline';
import { MobileBottomBar, MobileSheetType } from './MobileBottomBar';
import { MobileBottomSheet } from './MobileBottomSheet';
import { MediaBin } from '../media/MediaBin';
import { MediaItemCard } from '../media/MediaItemCard';
import { ClipInspector } from '../inspector/ClipInspector';
import { ShortcutsModal } from '../modals/ShortcutsModal';
import { ProjectsModal } from '../modals/ProjectsModal';
import { WelcomeModal } from '../modals/WelcomeModal';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import { useIsCompactHeight } from '../../hooks/useIsMobile';
import { TransitionType } from '../../types/project';
import { useLiveAnnouncement } from '../layout/liveRegion';
import { Sparkles, Gauge, Volume2, Eye, Music, FolderPlus } from 'lucide-react';

/**
 * F3 / B-10: the export modal is loaded ON DEMAND (it brings the exporter and
 * `mp4-muxer` with it, ~22 KB gzip that is useless until the user exports).
 */
const ExportModal = lazy(() => import('../export/ExportModal'));

/**
 * F3: the mobile preview player lives in its own chunk.
 */
const MobilePreviewPlayer = lazy(() => import('./MobilePreviewPlayer'));

export const MobileCapCutLayout: React.FC = () => {
  const [activeSheet, setActiveSheet] = useState<MobileSheetType>(null);
  const isCompact = useIsCompactHeight(500);
  const announcement = useLiveAnnouncement();

  const selectedClip = useProjectStore((s) => s.project.clips.find((c) => c.id === s.selectedClipId));
  const mediaPool = useProjectStore((s) => s.project.mediaPool);
  const addTextClip = useProjectStore((s) => s.addTextClip);
  const updateClip = useProjectStore((s) => s.updateClip);
  const addTrack = useProjectStore((s) => s.addTrack);
  const tracks = useProjectStore((s) => s.project.tracks);
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio);
  const resolution = useProjectStore((s) => s.project.resolution);

  /** F3: the export modal chunk is only fetched when the modal is opened. */
  const isExportModalOpen = useUIStore((s) => s.isExportModalOpen);

  /**
   * F3: the box of the preview while its chunk is being fetched.
   * It MUST mirror `MobilePreviewPlayer.getAspectClass()` exactly, otherwise
   * loading the chunk would move the preview on the screen.
   */
  const previewAspectClass = (() => {
    switch (aspectRatio) {
      case '9:16':
        return 'aspect-[9/16] max-h-full';
      case '1:1':
        return 'aspect-square max-h-full';
      default:
        return 'aspect-video max-h-full max-w-full';
    }
  })();

  const audioMedia = mediaPool.filter((m) => m.type === 'audio');
  const hasAudioTrack = tracks.some((t) => t.type === 'audio');

  const getSheetTitle = (): string => {
    switch (activeSheet) {
      case 'media':
        return 'Biblioteca de Medios';
      case 'audio':
        return 'Audio';
      case 'text':
        return 'Capas de Texto';
      case 'speed':
        return 'Velocidad de Reproducción';
      case 'volume':
        return 'Volumen de Audio';
      case 'transition':
        return 'Animaciones y Transiciones';
      case 'opacity':
        return 'Opacidad y Transparencia';
      case 'inspector':
        return 'Propiedades del Clip';
      default:
        return '';
    }
  };

  return (
    <div className="flex flex-col h-[100dvh] w-screen overflow-hidden bg-dark-950 text-slate-100 select-none">
      {/* 1. TOP HEADER (compact ~32px in landscape / height <= 500px, 48px in portrait) */}
      <div className={isCompact ? "h-8 shrink-0 overflow-hidden [&>header]:!h-8 [&>header]:!min-h-0 [&>header]:!py-0 [&>header]:!pt-0 [&_button]:!min-h-0 [&_button]:!h-6 [&_a]:!h-6 [&_input]:!h-6" : "shrink-0"}>
        <MobileHeader />
      </div>

      {/* 2. VIDEO PREVIEW MONITOR (Canvas + Floating Controls, ensuring canvas >= 150px and > 120px) */}
      <div className={isCompact 
        ? "flex-1 min-h-[140px] flex flex-col overflow-hidden [&>div]:!min-h-0 [&>div]:!max-h-none [&>div]:!p-1 [&_.max-w-sm]:!pt-0.5 [&_.max-w-sm]:!gap-1 [&_.max-w-sm_button]:!min-h-0 [&_.max-w-sm_button]:!h-7 [&_.max-w-sm_button]:!py-0.5" 
        : "flex-1 min-h-[180px] max-h-[46dvh] flex flex-col overflow-hidden"
      }>
        {/*
          F3: the preview player is loaded on demand. The fallback keeps the
          exact box of the preview (same width rule + same aspect ratio), so
          the chunk loading NEVER moves anything on the screen.
        */}
        <Suspense
          fallback={
            <div
              style={{ width: `min(100%, ${resolution.width}px)` }}
              className={`relative flex items-center justify-center shadow-2xl bg-black rounded-lg overflow-hidden border border-dark-800 ${previewAspectClass}`}
            />
          }
        >
          <MobilePreviewPlayer />
        </Suspense>
      </div>

      {/* 3. MULTITRACK TOUCH TIMELINE (compact ~80px in landscape / height <= 500px) */}
      <div className={isCompact 
        ? "h-20 min-h-[76px] max-h-[84px] shrink-0 flex flex-col bg-dark-950 border-t border-dark-850 overflow-hidden" 
        : "flex-1 min-h-[170px] max-h-[38dvh] flex flex-col bg-dark-950 border-t border-dark-850 overflow-hidden"
      }>
        <Timeline />
      </div>

      {/* 4. CAPCUT BOTTOM ACTION TOOLBAR (compact ~40px in landscape / height <= 500px) */}
      <div className={isCompact ? "h-10 shrink-0 overflow-hidden [&>nav]:!h-10 [&>nav]:!min-h-0 [&>nav]:!py-0 [&>nav]:!pb-0 [&_button]:!h-8 [&_button]:!py-0" : "shrink-0"}>
        <MobileBottomBar onOpenSheet={(sheet) => setActiveSheet(sheet)} />
      </div>

      {/* 5. MODULAR BOTTOM SHEETS (Slide-up Drawers) */}
      <MobileBottomSheet
        isOpen={!!activeSheet}
        onClose={() => setActiveSheet(null)}
        title={getSheetTitle()}
      >
        {/* Media Sheet */}
        {activeSheet === 'media' && (
          <div className="h-full">
            <MediaBin />
          </div>
        )}

        {/* Audio Sheet — audit UI-19: the "Audio" button used to open the very
            same sheet as "Medios". This one is specific to audio. */}
        {activeSheet === 'audio' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-slate-400">
                Archivos de audio de tu biblioteca. Toca uno para insertarlo en el cabezal.
              </p>
            </div>

            <button
              onClick={() => {
                if (!hasAudioTrack) addTrack('audio');
                setActiveSheet(null);
              }}
              className="w-full min-h-[44px] flex items-center justify-center gap-2 px-4 rounded-xl bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 font-semibold text-sm active:scale-[0.99] transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            >
              <Music size={16} />
              <span>{hasAudioTrack ? 'Ir a la pista de audio' : 'Crear pista de audio'}</span>
            </button>

            {audioMedia.length === 0 ? (
              <div className="py-8 px-4 flex flex-col items-center justify-center text-center gap-2">
                <Music size={32} className="text-slate-600" />
                <p className="text-sm font-semibold text-slate-200">No hay audio importado</p>
                <p className="text-xs text-slate-400 max-w-[30ch]">
                  Importa un archivo de audio (mp3, wav…) desde la biblioteca de medios.
                </p>
                <button
                  onClick={() => setActiveSheet('media')}
                  className="mt-2 px-4 min-h-[44px] rounded-lg bg-dark-850 hover:bg-dark-800 border border-dark-750 text-slate-200 text-xs font-semibold flex items-center gap-2 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
                >
                  <FolderPlus size={14} />
                  <span>Abrir biblioteca de medios</span>
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {audioMedia.map((item) => (
                  <MediaItemCard key={item.id} item={item} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Text Sheet */}
        {activeSheet === 'text' && (
          <div className="space-y-4">
            <p className="text-xs text-slate-400">
              Selecciona un estilo de texto para insertar en la posición actual del cabezal:
            </p>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => {
                  addTextClip('Título Principal');
                  setActiveSheet(null);
                }}
                className="p-3 bg-dark-850 hover:bg-dark-800 border border-dark-750 hover:border-cyan-500/50 rounded-xl flex flex-col items-center gap-2 text-center transition group active:scale-95 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
              >
                <div className="w-10 h-10 rounded-lg bg-cyan-500/20 text-cyan-400 flex items-center justify-center font-black text-lg">
                  T
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white group-hover:text-cyan-400">Título Grande</h4>
                  <p className="text-[10px] text-slate-400">Aperturas y destacados</p>
                </div>
              </button>

              <button
                onClick={() => {
                  addTextClip('Subtítulo o descripción');
                  setActiveSheet(null);
                }}
                className="p-3 bg-dark-850 hover:bg-dark-800 border border-dark-750 hover:border-cyan-500/50 rounded-xl flex flex-col items-center gap-2 text-center transition group active:scale-95 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
              >
                <div className="w-10 h-10 rounded-lg bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold text-base">
                  Aa
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white group-hover:text-purple-400">Subtítulo / Rótulo</h4>
                  <p className="text-[10px] text-slate-400">Explicaciones o créditos</p>
                </div>
              </button>
            </div>

            {selectedClip && selectedClip.type === 'text' && (
              <div className="mt-4 pt-4 border-t border-dark-800">
                <ClipInspector />
              </div>
            )}
          </div>
        )}

        {/* Clip properties sheet — audit UI-17: the inspector (transform,
            per-clip mute, text properties…) was unreachable on mobile. */}
        {activeSheet === 'inspector' && (
          <div className="-mx-4 -my-4 h-full">
            <ClipInspector />
          </div>
        )}

        {/* Speed Sheet */}
        {activeSheet === 'speed' && selectedClip && (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between text-xs font-medium text-slate-300">
              <span className="flex items-center gap-1.5">
                <Gauge size={14} className="text-amber-400" />
                <span>Velocidad actual:</span>
              </span>
              <span className="font-mono text-amber-400 font-bold text-sm">
                {(selectedClip.speed || 1).toFixed(1)}x
              </span>
            </div>

            {/* Quick preset buttons */}
            <div className="grid grid-cols-4 gap-2">
              {[0.5, 1.0, 1.5, 2.0].map((preset) => (
                <button
                  key={preset}
                  onClick={() => updateClip(selectedClip.id, { speed: preset })}
                  className={`min-h-[44px] px-2 rounded-lg text-xs font-bold transition active:scale-95 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none ${
                    (selectedClip.speed || 1) === preset
                      ? 'bg-amber-500 text-dark-950 shadow-md shadow-amber-500/20'
                      : 'bg-dark-850 text-slate-300 hover:bg-dark-800 border border-dark-750'
                  }`}
                >
                  {preset}x
                </button>
              ))}
            </div>

            <input
              type="range"
              min="0.25"
              max="3"
              step="0.05"
              value={selectedClip.speed || 1}
              onChange={(e) => updateClip(selectedClip.id, { speed: parseFloat(e.target.value) })}
              className="w-full h-8 bg-dark-750 accent-amber-500 rounded-lg cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-400"
              aria-label="Velocidad del clip"
            />
          </div>
        )}

        {/* Volume Sheet */}
        {activeSheet === 'volume' && selectedClip && (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between text-xs font-medium text-slate-300">
              <span className="flex items-center gap-1.5">
                <Volume2 size={14} className="text-emerald-400" />
                <span>Nivel de Ganancia:</span>
              </span>
              <span className="font-mono text-emerald-400 font-bold text-sm">
                {Math.round((selectedClip.volume ?? 1) * 100)}%
              </span>
            </div>

            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={selectedClip.volume ?? 1}
              onChange={(e) => updateClip(selectedClip.id, { volume: parseFloat(e.target.value) })}
              className="w-full h-8 bg-dark-750 accent-emerald-500 rounded-lg cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-400"
              aria-label="Volumen del clip"
            />

            <div className="flex justify-between text-[11px] text-slate-500 font-mono">
              <span>0% (Silencio)</span>
              <span>100% (Normal)</span>
              <span>200% (Amplificado)</span>
            </div>
          </div>
        )}

        {/* Transition Sheet */}
        {activeSheet === 'transition' && selectedClip && (
          <div className="space-y-4 py-2">
            {/* Fade In */}
            <div>
              <label className="text-xs font-bold text-slate-200 block mb-2 flex items-center gap-1.5">
                <Sparkles size={13} className="text-blue-400" />
                <span>Efecto de Entrada (Fade In):</span>
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'none', label: 'Ninguno' },
                  { id: 'fade-black', label: 'Fundido Negro' },
                  { id: 'slide-left', label: 'Deslizar' },
                ].map((t) => (
                  <button
                    key={t.id}
                    onClick={() =>
                      updateClip(selectedClip.id, {
                        transition: {
                          fadeInType: t.id as TransitionType,
                          fadeInDuration: selectedClip.transition?.fadeInDuration || 0.8,
                          fadeOutType: selectedClip.transition?.fadeOutType || 'none',
                          fadeOutDuration: selectedClip.transition?.fadeOutDuration || 0.8,
                        },
                      })
                    }
                    className={`py-2 px-1 min-h-[44px] text-center rounded-lg text-xs font-medium border transition active:scale-95 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none ${
                      (selectedClip.transition?.fadeInType || 'none') === t.id
                        ? 'bg-blue-600/30 border-blue-400 text-blue-200 font-bold'
                        : 'bg-dark-850 border-dark-750 text-slate-400 hover:text-white'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Fade Out */}
            <div>
              <label className="text-xs font-bold text-slate-200 block mb-2 flex items-center gap-1.5">
                <Sparkles size={13} className="text-amber-400" />
                <span>Efecto de Salida (Fade Out):</span>
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'none', label: 'Ninguno' },
                  { id: 'fade-black', label: 'Fundido Negro' },
                  { id: 'wipe-right', label: 'Cortinilla' },
                ].map((t) => (
                  <button
                    key={t.id}
                    onClick={() =>
                      updateClip(selectedClip.id, {
                        transition: {
                          fadeInType: selectedClip.transition?.fadeInType || 'none',
                          fadeInDuration: selectedClip.transition?.fadeInDuration || 0.8,
                          fadeOutType: t.id as TransitionType,
                          fadeOutDuration: selectedClip.transition?.fadeOutDuration || 0.8,
                        },
                      })
                    }
                    className={`py-2 px-1 min-h-[44px] text-center rounded-lg text-xs font-medium border transition active:scale-95 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none ${
                      (selectedClip.transition?.fadeOutType || 'none') === t.id
                        ? 'bg-amber-600/30 border-amber-400 text-amber-200 font-bold'
                        : 'bg-dark-850 border-dark-750 text-slate-400 hover:text-white'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Opacity Sheet */}
        {activeSheet === 'opacity' && selectedClip && (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between text-xs font-medium text-slate-300">
              <span className="flex items-center gap-1.5">
                <Eye size={14} className="text-purple-400" />
                <span>Opacidad:</span>
              </span>
              <span className="font-mono text-purple-400 font-bold text-sm">
                {Math.round((selectedClip.opacity ?? 1) * 100)}%
              </span>
            </div>

            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={selectedClip.opacity ?? 1}
              onChange={(e) => updateClip(selectedClip.id, { opacity: parseFloat(e.target.value) })}
              className="w-full h-8 bg-dark-750 accent-purple-500 rounded-lg cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-400"
              aria-label="Opacidad del clip"
            />
          </div>
        )}

        {/* Empty guard: clip-dependent sheets opened without a selection */}
        {activeSheet &&
          (activeSheet === 'speed' ||
            activeSheet === 'volume' ||
            activeSheet === 'transition' ||
            activeSheet === 'opacity' ||
            activeSheet === 'inspector') &&
          !selectedClip && (
            <div className="py-8 px-4 flex flex-col items-center justify-center text-center gap-2">
              <p className="text-sm font-semibold text-slate-200">Ningún clip seleccionado</p>
              <p className="text-xs text-slate-400 max-w-[26ch]">
                Toca un clip del timeline para ajustar sus propiedades, o cierra este panel.
              </p>
              <button
                onClick={() => setActiveSheet(null)}
                className="mt-2 px-4 min-h-[44px] rounded-lg bg-dark-850 hover:bg-dark-800 border border-dark-750 text-slate-200 text-xs font-semibold active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
              >
                Cerrar panel
              </button>
            </div>
          )}
      </MobileBottomSheet>

      {/* Global Modals */}
      {isExportModalOpen && (
        <Suspense fallback={null}>
          <ExportModal />
        </Suspense>
      )}
      <ShortcutsModal />
      <ProjectsModal />
      <WelcomeModal />

      {/* UI-16: single polite live region for the whole app */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="live-region"
        className="sr-only"
      >
        {announcement.text}
      </div>
    </div>
  );
};
