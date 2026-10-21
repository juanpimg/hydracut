import React, { Suspense, lazy, useState } from 'react';
import { MobileHeader } from './MobileHeader';
import { Timeline } from '../timeline/Timeline';
import { MobileBottomBar, MobileSheetType } from './MobileBottomBar';
import { MobileBottomSheet } from './MobileBottomSheet';
import { MediaItemCard } from '../media/MediaItemCard';
import { ClipInspector } from '../inspector/ClipInspector';
import { WelcomeModal } from '../modals/WelcomeModal';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import { useIsCompactHeight } from '../../hooks/useIsMobile';
import { TransitionType } from '../../types/project';
import {
  assertTransitionOptionsParity,
} from '../../core/utils/transitionOptions';
import { useLiveAnnouncement } from '../layout/liveRegion';
import { Gauge, Volume2, Eye, Music, FolderPlus, Sparkles } from 'lucide-react';

/**
 * F3 / B-10: the export modal is loaded ON DEMAND (it brings the exporter and
 * `mp4-muxer` with it, ~22 KB gzip that is useless until the user exports).
 */
const ExportModal = lazy(() => import('../export/ExportModal'));

/**
 * F3: the mobile preview player lives in its own chunk.
 */
const MobilePreviewPlayer = lazy(() => import('./MobilePreviewPlayer'));

/**
 * Bundle audit: the modals and the media bin are only needed on demand
 * (the sheets mount them when opened), so they live in their own chunks
 * shared with the desktop shell. The modal fallbacks are `null` (fixed
 * overlays, no layout impact); the media-bin fallback keeps a stable
 * placeholder so the sheet body never jumps while the chunk loads.
 */
const ProjectsModal = lazy(() => import('../modals/ProjectsModal'));
const ShortcutsModal = lazy(() => import('../modals/ShortcutsModal'));
const MediaBin = lazy(() => import('../media/MediaBin'));

const MediaBinSheetFallback: React.FC = () => (
  <div aria-hidden="true" className="h-full min-h-[240px]">
    <div className="h-9 w-full rounded-md bg-raised mb-3" />
    <div className="grid grid-cols-2 gap-3">
      <div className="aspect-video rounded-md bg-raised" />
      <div className="aspect-video rounded-md bg-raised" />
      <div className="aspect-video rounded-md bg-raised" />
      <div className="aspect-video rounded-md bg-raised" />
    </div>
  </div>
);

/**
 * Mobile/desktop parity data (pure logic, unit-tested in
 * `src/tests/mobile-parity.test.ts`). The sheets below render FROM these
 * constants so the list a test asserts is the list the user taps.
 */

/** Clip-speed presets offered by the mobile speed sheet (desktop reaches 4x via its slider; mobile now does too). */
export const MOBILE_SPEED_PRESETS: readonly number[] = [0.5, 1, 1.5, 2, 4];
/** Bounds of the mobile speed slider (same upper bound as the desktop inspector). */
export const MOBILE_SPEED_MIN = 0.25;
export const MOBILE_SPEED_MAX = 4;

export interface MobileTransitionOption {
  id: TransitionType;
  label: string;
}

/** Fade-in options: the full canonical set (parity with the desktop inspector). */
export const MOBILE_FADE_IN_OPTIONS: readonly MobileTransitionOption[] = [
  { id: 'none', label: 'Ninguno' },
  { id: 'fade-black', label: 'Fundido a Negro' },
  { id: 'fade-white', label: 'Fundido a Blanco' },
  { id: 'slide-left', label: 'Deslizar (Slide)' },
  { id: 'wipe-right', label: 'Cortina (Wipe)' },
];

/** Fade-out options: the full canonical set (parity with the desktop inspector). */
export const MOBILE_FADE_OUT_OPTIONS: readonly MobileTransitionOption[] = [
  { id: 'none', label: 'Ninguno' },
  { id: 'fade-black', label: 'Fundido a Negro' },
  { id: 'fade-white', label: 'Fundido a Blanco' },
  { id: 'slide-left', label: 'Deslizar (Slide)' },
  { id: 'wipe-right', label: 'Cortina (Wipe)' },
];

/**
 * The canonical list in `src/core/utils/transitionOptions.ts` is the single
 * source of truth (the desktop inspector migrates to it next): fail fast at
 * startup if these copies drift instead of shipping a silent capability gap.
 */
assertTransitionOptionsParity('MOBILE_FADE_IN_OPTIONS', MOBILE_FADE_IN_OPTIONS);
assertTransitionOptionsParity('MOBILE_FADE_OUT_OPTIONS', MOBILE_FADE_OUT_OPTIONS);

/**
 * Maximum of the transition-duration sliders.
 * Same formula as the desktop inspector
 * (`Math.min(5, Math.max(0.2, clip.duration / 2))`).
 */
export function transitionDurationMax(clipDuration: number): number {
  return Math.min(5, Math.max(0.2, clipDuration / 2));
}

/**
 * Estructura móvil (DESIGN.md): barra de la app de 48 px · VISOR 38 % ·
 * LÍNEA DE TIEMPO 30 % · tira de herramientas contextual. Nunca paneles
 * laterales: el inspector es una hoja inferior. Superficies planas con
 * hairlines de 1 px; el acento solo donde significa algo (opción activa).
 */
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
  const isProjectsModalOpen = useUIStore((s) => s.isProjectsModalOpen);
  const isShortcutsModalOpen = useUIStore((s) => s.isShortcutsModalOpen);

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
        return 'Medios';
      case 'audio':
        return 'Audio';
      case 'text':
        return 'Texto';
      case 'speed':
        return 'Velocidad';
      case 'volume':
        return 'Volumen';
      case 'transition':
        return 'Fundidos';
      case 'opacity':
        return 'Opacidad';
      case 'inspector':
        return 'Inspector';
      default:
        return '';
    }
  };

  return (
    <div className="flex flex-col h-[100dvh] w-screen overflow-hidden bg-app text-text-1 select-none">
      {/* 1. BARRA DE LA APP (48 px; 32 px en apaisado, la cabecera se compacta sola) */}
      <div className="shrink-0">
        <MobileHeader />
      </div>

      {/* 2. VISOR (38 % en vertical; flexible con mínimo en apaisado) */}
      <div className={isCompact
        ? "flex-1 min-h-[140px] flex flex-col overflow-hidden"
        : "min-h-0 flex-[38] flex flex-col overflow-hidden"
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
              className={`relative flex items-center justify-center shadow-2xl bg-black rounded-lg overflow-hidden border border-border-subtle ${previewAspectClass}`}
            />
          }
        >
          <MobilePreviewPlayer />
        </Suspense>
      </div>

      {/* 3. LÍNEA DE TIEMPO TÁCTIL (30 % en vertical; 76 px en apaisado) */}
      <div className={isCompact
        ? "h-[76px] shrink-0 flex flex-col overflow-hidden"
        : "min-h-0 flex-[30] flex flex-col overflow-hidden"
      }>
        <Timeline />
      </div>

      {/* 4. TIRA DE HERRAMIENTAS CONTEXTUAL (la tira se dimensiona sola) */}
      <div className="shrink-0">
        <MobileBottomBar onOpenSheet={(sheet) => setActiveSheet(sheet)} />
      </div>

      {/* 5. HOJAS INFERIORES MODULARES */}
      <MobileBottomSheet
        isOpen={!!activeSheet}
        onClose={() => setActiveSheet(null)}
        title={getSheetTitle()}
      >
        {/* Media Sheet */}
        {activeSheet === 'media' && (
          <div className="h-full">
            <Suspense fallback={<MediaBinSheetFallback />}>
              <MediaBin />
            </Suspense>
          </div>
        )}

        {/* Audio Sheet — audit UI-19: the "Audio" button used to open the very
            same sheet as "Medios". This one is specific to audio. */}
        {activeSheet === 'audio' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-body-sm text-text-2">
                Archivos de audio. Selecciona uno para insertarlo en el cabezal.
              </p>
            </div>

            <button
              onClick={() => {
                if (!hasAudioTrack) addTrack('audio');
                setActiveSheet(null);
              }}
              className="w-full min-h-[44px] flex items-center justify-center gap-2 px-4 rounded bg-raised border border-border text-text-1 font-semibold text-body active:scale-[0.99] transition focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              <Music size={16} aria-hidden="true" />
              <span>{hasAudioTrack ? 'Ir a la pista de audio' : 'Crear pista de audio'}</span>
            </button>

            {audioMedia.length === 0 ? (
              <div className="py-8 px-4 flex flex-col items-center justify-center text-center gap-2">
                <Music size={32} aria-hidden="true" className="text-text-3" />
                <p className="text-body font-semibold text-text-1">No hay audio importado</p>
                <p className="text-body-sm text-text-2 max-w-[30ch]">
                  Importa un archivo de audio (mp3, wav…) desde Medios.
                </p>
                <button
                  onClick={() => setActiveSheet('media')}
                  className="mt-2 px-4 min-h-[44px] rounded bg-raised hover:bg-overlay border border-border text-text-1 text-body-sm font-semibold flex items-center gap-2 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <FolderPlus size={14} aria-hidden="true" />
                  <span>Abrir medios</span>
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
            <p className="text-body-sm text-text-2">
              Elige un estilo: se inserta en el cabezal.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => {
                  addTextClip('Título');
                  setActiveSheet(null);
                }}
                className="p-3 bg-raised hover:bg-overlay border border-border rounded-lg flex flex-col items-center gap-2 text-center transition group active:scale-95 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              >
                <div className="w-10 h-10 rounded bg-panel border border-border-subtle text-text-1 flex items-center justify-center font-black text-lg">
                  T
                </div>
                <div>
                  <h4 className="text-body-sm font-bold text-text-1">Título</h4>
                  <p className="text-caption text-text-2">Aperturas y destacados</p>
                </div>
              </button>

              <button
                onClick={() => {
                  addTextClip('Subtítulo');
                  setActiveSheet(null);
                }}
                className="p-3 bg-raised hover:bg-overlay border border-border rounded-lg flex flex-col items-center gap-2 text-center transition group active:scale-95 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              >
                <div className="w-10 h-10 rounded bg-panel border border-border-subtle text-text-1 flex items-center justify-center font-bold text-base">
                  Aa
                </div>
                <div>
                  <h4 className="text-body-sm font-bold text-text-1">Subtítulo</h4>
                  <p className="text-caption text-text-2">Explicaciones o créditos</p>
                </div>
              </button>
            </div>

            {selectedClip && selectedClip.type === 'text' && (
              <div className="mt-4 pt-4 border-t border-border-subtle">
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
            <div className="flex items-center justify-between text-body-sm font-medium text-text-2">
              <span className="flex items-center gap-1.5">
                <Gauge size={14} aria-hidden="true" />
                <span>Velocidad:</span>
              </span>
              <span className="font-mono text-text-1 font-bold text-body">
                {(selectedClip.speed || 1).toFixed(1)}x
              </span>
            </div>

            {/* Quick preset buttons (parity with desktop: up to 4x) */}
            <div className="grid grid-cols-5 gap-1.5">
              {MOBILE_SPEED_PRESETS.map((preset) => (
                <button
                  key={preset}
                  onClick={() => updateClip(selectedClip.id, { speed: preset })}
                  aria-pressed={(selectedClip.speed || 1) === preset}
                  className={`min-h-[44px] px-1 rounded text-body-sm font-bold transition active:scale-95 border focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                    (selectedClip.speed || 1) === preset
                      ? 'bg-accent-soft border-accent text-accent'
                      : 'bg-raised text-text-2 hover:bg-overlay border-border'
                  }`}
                >
                  {preset}x
                </button>
              ))}
            </div>

            <div className="flex justify-between text-caption text-text-3 font-mono">
              <span>{MOBILE_SPEED_MIN}x</span>
              <span>1x (Normal)</span>
              <span>{MOBILE_SPEED_MAX.toFixed(1)}x</span>
            </div>

            <input
              type="range"
              min={MOBILE_SPEED_MIN}
              max={MOBILE_SPEED_MAX}
              step="0.05"
              value={selectedClip.speed || 1}
              onChange={(e) => updateClip(selectedClip.id, { speed: parseFloat(e.target.value) })}
              className="w-full min-h-[44px] accent-accent rounded-lg cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              aria-label="Velocidad del clip"
            />
          </div>
        )}

        {/* Volume Sheet */}
        {activeSheet === 'volume' && selectedClip && (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between text-body-sm font-medium text-text-2">
              <span className="flex items-center gap-1.5">
                <Volume2 size={14} aria-hidden="true" />
                <span>Volumen:</span>
              </span>
              <span className="font-mono text-text-1 font-bold text-body">
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
              className="w-full min-h-[44px] accent-accent rounded-lg cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              aria-label="Volumen del clip"
            />

            <div className="flex justify-between text-caption text-text-3 font-mono">
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
              <div className="flex items-center justify-between mb-2">
                <label className="text-body-sm font-bold text-text-1 flex items-center gap-1.5">
                  <Sparkles size={13} aria-hidden="true" />
                  <span>Fundido de entrada:</span>
                </label>
                <span className="text-caption font-mono text-text-2">
                  {(selectedClip.transition?.fadeInDuration ?? 0).toFixed(1)} s
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {MOBILE_FADE_IN_OPTIONS.map((t) => (
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
                    aria-pressed={(selectedClip.transition?.fadeInType || 'none') === t.id}
                    className={`py-2 px-1 min-h-[44px] text-center rounded text-body-sm font-medium border transition active:scale-95 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                      (selectedClip.transition?.fadeInType || 'none') === t.id
                        ? 'bg-accent-soft border-accent text-accent font-bold'
                        : 'bg-raised border-border text-text-2 hover:text-text-1'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {/* Transition duration (parity with the desktop inspector) */}
              <label className="text-caption text-text-2 block mt-2 mb-1" htmlFor="mobile-fade-in-duration">
                Duración de entrada:
              </label>
              <input
                id="mobile-fade-in-duration"
                type="range"
                min="0.1"
                max={transitionDurationMax(selectedClip.duration)}
                step="0.1"
                aria-label="Duración del fundido de entrada"
                disabled={!selectedClip.transition?.fadeInType || selectedClip.transition.fadeInType === 'none'}
                value={selectedClip.transition?.fadeInDuration || 0.8}
                onChange={(e) =>
                  updateClip(selectedClip.id, {
                    transition: {
                      fadeInType: selectedClip.transition?.fadeInType || 'fade-black',
                      fadeInDuration: parseFloat(e.target.value),
                      fadeOutType: selectedClip.transition?.fadeOutType || 'none',
                      fadeOutDuration: selectedClip.transition?.fadeOutDuration || 0,
                    },
                  })
                }
                className="w-full min-h-[44px] accent-accent rounded cursor-pointer disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              />
            </div>

            {/* Fade Out */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-body-sm font-bold text-text-1 flex items-center gap-1.5">
                  <Sparkles size={13} aria-hidden="true" />
                  <span>Fundido de salida:</span>
                </label>
                <span className="text-caption font-mono text-text-2">
                  {(selectedClip.transition?.fadeOutDuration ?? 0).toFixed(1)} s
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {MOBILE_FADE_OUT_OPTIONS.map((t) => (
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
                    aria-pressed={(selectedClip.transition?.fadeOutType || 'none') === t.id}
                    className={`py-2 px-1 min-h-[44px] text-center rounded text-body-sm font-medium border transition active:scale-95 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                      (selectedClip.transition?.fadeOutType || 'none') === t.id
                        ? 'bg-accent-soft border-accent text-accent font-bold'
                        : 'bg-raised border-border text-text-2 hover:text-text-1'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {/* Transition duration (parity with the desktop inspector) */}
              <label className="text-caption text-text-2 block mt-2 mb-1" htmlFor="mobile-fade-out-duration">
                Duración de salida:
              </label>
              <input
                id="mobile-fade-out-duration"
                type="range"
                min="0.1"
                max={transitionDurationMax(selectedClip.duration)}
                step="0.1"
                aria-label="Duración del fundido de salida"
                disabled={!selectedClip.transition?.fadeOutType || selectedClip.transition.fadeOutType === 'none'}
                value={selectedClip.transition?.fadeOutDuration || 0.8}
                onChange={(e) =>
                  updateClip(selectedClip.id, {
                    transition: {
                      fadeInType: selectedClip.transition?.fadeInType || 'none',
                      fadeInDuration: selectedClip.transition?.fadeInDuration || 0,
                      fadeOutType: selectedClip.transition?.fadeOutType || 'fade-black',
                      fadeOutDuration: parseFloat(e.target.value),
                    },
                  })
                }
                className="w-full min-h-[44px] accent-accent rounded cursor-pointer disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              />
            </div>
          </div>
        )}

        {/* Opacity Sheet */}
        {activeSheet === 'opacity' && selectedClip && (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between text-body-sm font-medium text-text-2">
              <span className="flex items-center gap-1.5">
                <Eye size={14} aria-hidden="true" />
                <span>Opacidad:</span>
              </span>
              <span className="font-mono text-text-1 font-bold text-body">
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
              className="w-full min-h-[44px] accent-accent rounded-lg cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
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
              <p className="text-body font-semibold text-text-1">Ningún clip seleccionado</p>
              <p className="text-body-sm text-text-2 max-w-[26ch]">
                Selecciona un clip para ajustar sus propiedades.
              </p>
              <button
                onClick={() => setActiveSheet(null)}
                className="mt-2 px-4 min-h-[44px] rounded bg-raised hover:bg-overlay border border-border text-text-1 text-body-sm font-semibold active:scale-95 transition focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              >
                Cerrar
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
      {isShortcutsModalOpen && (
        <Suspense fallback={null}>
          <ShortcutsModal />
        </Suspense>
      )}
      {isProjectsModalOpen && (
        <Suspense fallback={null}>
          <ProjectsModal />
        </Suspense>
      )}
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
