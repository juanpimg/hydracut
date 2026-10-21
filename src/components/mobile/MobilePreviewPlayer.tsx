import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  Scissors,
  Maximize2,
  Minimize2,
  Volume2,
  VolumeX
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { compositor, computeRenderScale } from '../../core/engine/Compositor';
import { masterClock } from '../../core/engine/MasterClock';
import { audioEngine } from '../../core/engine/AudioEngine';
import { readMasterVolume, subscribeMasterVolume, writeMasterVolume } from '../../core/utils/masterVolume';
import { mediaSourcePool } from '../../core/engine/MediaSourcePool';
import { formatTimecode } from '../../core/utils/time';
import { useIsCompactHeight } from '../../hooks/useIsMobile';
import { canSplitAtTime } from '../timeline/TimelineToolbar';
import { IconButton } from '../ui/IconButton';
import { Button } from '../ui/Button';

/**
 * Mobile/desktop parity helpers (pure logic, unit-tested in
 * `src/tests/mobile-parity.test.ts`).
 *
 * The production path NEVER reimplements the desktop behaviour:
 * - frame stepping goes through `masterClock.stepFrame(delta, fps)`, the exact
 *   same call `PlayerControls` (desktop) makes;
 * - the master volume goes through `audioEngine.setMasterVolume`, the exact
 *   same audio path the desktop uses (`AudioEngine.masterVolume` scales every
 *   clip in `updateAudio`).
 * These helpers only expose the pure pieces (frame math, label strings,
 * clamping) so they can be asserted without a DOM.
 */

/** Seconds advanced by `deltaFrames` at `fps` (same math as `MasterClock.stepFrame`). */
export function frameStepSeconds(deltaFrames: number, fps: number): number {
  const safeFps = fps > 0 ? fps : 30;
  return deltaFrames / safeFps;
}

/**
 * Accessible label of the preview `<canvas>`.
 * Must stay identical to the desktop `PreviewPlayer` label.
 */
export function buildPreviewAriaLabel(clipCount: number): string {
  return clipCount === 0
    ? 'Monitor vacío: importa medios para empezar'
    : `Monitor: ${clipCount} clips en el timeline`;
}

/**
 * Text of the resolution badge.
 * Must stay identical to the desktop `PreviewPlayer` badge.
 */
export function formatResolutionBadge(width: number, height: number, aspectRatio: string): string {
  return `${width}x${height} (${aspectRatio})`;
}

/** Clamp for the master-volume slider (same clamp as `AudioEngine.setMasterVolume`). */
export function clampMasterVolume(vol: number): number {
  if (Number.isNaN(vol)) return 0;
  return Math.max(0, Math.min(vol, 1));
}

/**
 * Timecode discreto: etiqueta monoespaciada sin pastilla ni brillo (paridad
 * con el transporte del escritorio). Escribe el texto en el DOM directamente
 * desde el `masterClock`: el transporte nunca provoca un re-render por
 * fotograma.
 */
const MobileTimecodeDisplay: React.FC<{ fps: number; duration: number }> = ({ fps, duration }) => {
  const currentSpanRef = useRef<HTMLSpanElement>(null);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;

  useEffect(() => {
    if (currentSpanRef.current) {
      currentSpanRef.current.textContent = formatTimecode(masterClock.getTime(), fps);
    }
    const unsub = masterClock.subscribeTime((t) => {
      if (currentSpanRef.current) {
        currentSpanRef.current.textContent = formatTimecode(t, fpsRef.current);
      }
    });
    return unsub;
  }, [fps]);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-timecode tabular">
      <span ref={currentSpanRef} className="whitespace-nowrap text-text-1">
        {formatTimecode(masterClock.getTime(), fps)}
      </span>
      <span aria-hidden="true" className="hidden text-text-3 min-[400px]:inline">
        /
      </span>
      <span className="hidden whitespace-nowrap text-text-2 min-[400px]:inline">
        {formatTimecode(duration, fps)}
      </span>
    </div>
  );
};

export const MobilePreviewPlayer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** Scale applied to the project space to fill the backing store (KI-02). */
  const renderScaleRef = useRef<number>(1);
  const clipsRef = useRef(useProjectStore.getState().project.clips);

  const duration = useProjectStore((s) => s.project.duration);
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio);
  const resolution = useProjectStore((s) => s.project.resolution);
  const tracks = useProjectStore((s) => s.project.tracks);
  const clips = useProjectStore((s) => s.project.clips);
  const mediaPool = useProjectStore((s) => s.project.mediaPool);
  const isPlaying = useProjectStore((s) => s.isPlaying);
  const fps = useProjectStore((s) => s.project.fps);
  const splitAtPlayhead = useProjectStore((s) => s.splitAtPlayhead);
  const [canSplit, setCanSplit] = useState(false);
  const [aPantallaCompleta, setAPantallaCompleta] = useState(false);

  /**
   * Master volume: the SAME shared preview preference the desktop
   * `PlayerControls` reads and writes (localStorage + live sync), not a
   * second local copy. The persisted value is pushed into the engine on
   * mount so a reload restores what was heard; `subscribeMasterVolume`
   * keeps this control in sync while the desktop one changes it.
   * Same audio path: `audioEngine.setMasterVolume`.
   */
  const [masterVolume, setMasterVolume] = useState<number>(() => readMasterVolume());
  const [isMasterMuted, setIsMasterMuted] = useState<boolean>(false);

  /**
   * Applies the persisted volume on mount and follows live changes from the
   * desktop control (and vice versa: writes below notify its subscriber).
   */
  useEffect(() => {
    const persisted = readMasterVolume();
    setMasterVolume(persisted);
    audioEngine.setMasterVolume(persisted);
    return subscribeMasterVolume((next) => {
      setMasterVolume(next);
    });
  }, []);

  // Landscape / short viewports (the compact CapCut shell).
  const isCompact = useIsCompactHeight();

  clipsRef.current = clips;

  useEffect(() => {
    masterClock.setDuration(duration);
  }, [duration]);

  useEffect(() => {
    for (const clip of clips) {
      if (clip.type === 'video' && clip.start <= 5) {
        const media = mediaPool.find((m) => m.id === clip.mediaId);
        if (media) {
          mediaSourcePool.getVideoElement(media, clip.id, clip.sourceStart);
        }
      }
    }
  }, [clips, mediaPool]);

  /**
   * Paints the current frame of the project into the preview canvas.
   *
   * The composition always happens in the PROJECT space (`logicalWidth` /
   * `logicalHeight`); `renderScale` maps it onto the backing store of the
   * canvas, which is sized for the display (KI-02).
   */
  const renderCurrentFrame = useCallback((isCurrentlyPlaying: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const currProject = useProjectStore.getState().project;
    compositor.renderFrame({
      time: masterClock.getTime(),
      canvas,
      tracks: currProject.tracks,
      clips: currProject.clips,
      mediaPool: currProject.mediaPool,
      isPlaying: isCurrentlyPlaying,
      logicalWidth: currProject.resolution.width,
      logicalHeight: currProject.resolution.height,
      renderScale: renderScaleRef.current,
    });
  }, []);

  // Sync clock time and render
  useEffect(() => {
    const unsubTime = masterClock.subscribeTime((t) => {
      const isCurrentlyPlaying = masterClock.getIsPlaying();

      // Only sync store time when paused or seeking, never during continuous playback
      if (!isCurrentlyPlaying) {
        useProjectStore.getState().setCurrentTime(t);
      }

      const currProject = useProjectStore.getState().project;

      if (canvasRef.current) {
        compositor.renderFrame({
          time: t,
          canvas: canvasRef.current,
          tracks: currProject.tracks,
          clips: currProject.clips,
          mediaPool: currProject.mediaPool,
          isPlaying: isCurrentlyPlaying,
          logicalWidth: currProject.resolution.width,
          logicalHeight: currProject.resolution.height,
          renderScale: renderScaleRef.current,
        });
      }
      audioEngine.updateAudio(
        t,
        isCurrentlyPlaying,
        currProject.tracks,
        currProject.clips,
        currProject.mediaPool
      );
      if (isCurrentlyPlaying) {
        mediaSourcePool.prewarmUpcomingClips(t, currProject.clips, currProject.mediaPool);
      }
    });

    const unsubState = masterClock.subscribeState((playing) => {
      useProjectStore.getState().setIsPlaying(playing);
      if (!playing) {
        useProjectStore.getState().setCurrentTime(masterClock.getTime());
        audioEngine.stopAll();
      }
    });

    const unsubFrame = mediaSourcePool.onFrameReady(() => {
      if (!masterClock.getIsPlaying() && canvasRef.current) {
        renderCurrentFrame(false);
      }
    });

    return () => {
      unsubTime();
      unsubState();
      unsubFrame();
      if (masterClock.getIsPlaying()) {
        masterClock.pause();
      }
      useProjectStore.getState().setCurrentTime(masterClock.getTime());
      audioEngine.stopAll();
    };
  }, [renderCurrentFrame]);

  // Update canvas on store changes when paused
  useEffect(() => {
    if (!masterClock.getIsPlaying() && canvasRef.current) {
      const t = masterClock.getTime();
      compositor.renderFrame({
        time: t,
        canvas: canvasRef.current,
        tracks,
        clips,
        mediaPool,
        isPlaying: false,
        logicalWidth: resolution.width,
        logicalHeight: resolution.height,
        renderScale: renderScaleRef.current,
      });
      audioEngine.updateAudio(
        t,
        false,
        tracks,
        clips,
        mediaPool
      );
    }
  }, [tracks, clips, mediaPool, resolution]);

  /**
   * KI-02: the backing store of the preview canvas is sized for the DISPLAY,
   * not for the project.
   *
   * The canvas used to be hard-wired to the project resolution (1920x1080 =
   * 2 073 600 px) even when it was displayed inside a 200x110 box: up to 100x
   * more rasterised pixels than the screen could show, at 60 fps.
   *
   * The fit is recomputed whenever the canvas box changes (rotation, window
   * resize, keyboard opening…) through a `ResizeObserver`.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
      const result = computeRenderScale({
        logicalWidth: resolution.width,
        logicalHeight: resolution.height,
        cssWidth: rect.width,
        cssHeight: rect.height,
        devicePixelRatio: dpr,
      });
      renderScaleRef.current = result.scale;
      if (canvas.width === result.width && canvas.height === result.height) return;
      // Resizing the canvas clears it: paint the current frame again.
      canvas.width = result.width;
      canvas.height = result.height;
      renderCurrentFrame(masterClock.getIsPlaying());
    };

    fit();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', fit);
      return () => window.removeEventListener('resize', fit);
    }

    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    // `devicePixelRatio` can change without a resize of the box (moving the
    // window to another monitor): the window resize event covers that too.
    window.addEventListener('resize', fit);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [resolution.width, resolution.height, renderCurrentFrame]);

  /**
   * UI-27: "Dividir" must not be a silent no-op.
   *
   * `splitAtPlayhead()` does nothing when the playhead is outside every
   * clip, so the button is disabled while there is nothing to split.
   */
  useEffect(() => {
    const compute = () => {
      const can = canSplitAtTime(clipsRef.current, masterClock.getTime());
      setCanSplit((prev) => (prev === can ? prev : can));
    };

    compute();

    let lastCheck = 0;
    const unsubTime = masterClock.subscribeTime(() => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!masterClock.getIsPlaying() || now - lastCheck >= 150) {
        lastCheck = now;
        compute();
      }
    });
    const unsubState = masterClock.subscribeState(() => compute());

    return () => {
      unsubTime();
      unsubState();
    };
  }, [clips]);

  // Estado de la pantalla completa (para alternar el icono).
  useEffect(() => {
    const alCambiar = () => setAPantallaCompleta(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', alCambiar);
    return () => document.removeEventListener('fullscreenchange', alCambiar);
  }, []);

  const getAspectClass = () => {
    switch (aspectRatio) {
      case '16:9':
        return 'aspect-video max-h-full max-w-full';
      case '9:16':
        return 'aspect-[9/16] max-h-full';
      case '1:1':
        return 'aspect-square max-h-full';
      default:
        return 'aspect-video';
    }
  };

  const handleTogglePlay = () => {
    masterClock.togglePlay();
  };

  const handleToStart = () => {
    masterClock.seek(0);
  };

  /**
   * Step ±1 frame (mobile parity with the desktop `PlayerControls`).
   * Same shared logic: `masterClock.stepFrame(delta, fps)` pauses when playing
   * and seeks exactly `delta / fps` seconds.
   */
  const handleStepBack = () => {
    masterClock.stepFrame(-1, fps);
  };

  const handleStepForward = () => {
    masterClock.stepFrame(1, fps);
  };

  /** Master volume (mobile parity with the desktop `PlayerControls`). */
  const handleMasterVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = clampMasterVolume(parseFloat(e.target.value));
    const next = writeMasterVolume(val);
    setMasterVolume(next);
    setIsMasterMuted(next === 0);
    audioEngine.setMasterVolume(next);
  };

  const handleToggleMasterMute = () => {
    if (isMasterMuted) {
      setIsMasterMuted(false);
      audioEngine.setMasterVolume(masterVolume || 1);
    } else {
      setIsMasterMuted(true);
      audioEngine.setMasterVolume(0);
    }
  };

  const handleFullscreen = () => {
    if (containerRef.current) {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        containerRef.current.requestFullscreen().catch(() => {});
      }
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative flex-1 bg-app flex flex-col items-center justify-center px-2 py-1 overflow-hidden select-none min-h-0"
    >
      {/* Video Canvas Container.
          The width is `min(100%, <project width>)` instead of the intrinsic
          size of the canvas: the layout must not change when the backing
          store is re-fitted for the display (KI-02). */}
      <div
        style={{ width: `min(100%, ${resolution.width}px)` }}
        className={`relative flex items-center justify-center shadow-2xl bg-black rounded-lg overflow-hidden border border-border-subtle ${getAspectClass()} ${
          // Landscape / short viewports: the preview must keep >= 150px of
          // visible height (PROJECT.md #12, ORIGINAL_REQUEST R4).
          isCompact ? 'min-h-[150px]' : 'min-h-0'
        }`}
      >
        <canvas
          ref={canvasRef}
          width={resolution.width}
          height={resolution.height}
          className="w-full h-full object-contain"
          role="img"
          aria-label={buildPreviewAriaLabel(clips.length)}
        />

        {/* Insignia de resolución: etiqueta discreta, sin pastilla ni borde
            (paridad con el visor del escritorio). */}
        <span className="absolute bottom-2 left-2 pointer-events-none text-caption text-text-2 z-10">
          {formatResolutionBadge(resolution.width, resolution.height, aspectRatio)}
        </span>

        {/* F5 · Sin mensaje de vacío aquí: la línea de tiempo es la que posee
            el estado vacío. El visor queda en silencio (paridad con el
            escritorio) para no duplicar el mensaje. */}

        {/* Pantalla completa: botón discreto en la esquina del visor
            (paridad con el escritorio), con objetivo táctil de 44 px. */}
        <IconButton
          size="sm"
          onClick={handleFullscreen}
          aria-label="Pantalla completa"
          title="Pantalla completa"
          className="absolute right-2 top-2 z-10 min-h-[44px] min-w-[44px] bg-black/60 text-text-2 hover:text-text-1"
        >
          {aPantallaCompleta ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>

        {/* Atajo central de reproducir/pausar (un toque en el lienzo). */}
        <button
          onClick={handleTogglePlay}
          className={`absolute inset-0 m-auto w-14 h-14 rounded-md bg-black/50 flex items-center justify-center text-white border border-white/20 active:scale-90 transition focus:outline-none ${
            isPlaying ? 'opacity-0 hover:opacity-100 focus:opacity-100' : 'opacity-100'
          }`}
          title={isPlaying ? "Pausar" : "Reproducir"}
          aria-label={isPlaying ? "Pausar" : "Reproducir"}
        >
          {isPlaying ? <Pause size={22} /> : <Play size={22} className="ml-0.5" />}
        </button>
      </div>

      {/*
        Transporte compacto: UNA fila de transporte (timecode discreto +
        inicio · −1f · reproducir · +1f) y UNA fila de volumen general.
        Todo el transporte cabe en ≤ 120 px. En apaisado la columna se
        superpone al borde inferior del visor para no robarle altura al
        lienzo (el requisito son 150 px visibles).
      */}
      <div
        className={`w-full max-w-sm flex flex-col px-1 pt-1 gap-0.5 ${
          isCompact
            ? 'absolute bottom-0 left-0 right-0 mx-auto bg-black/70 z-20'
            : ''
        }`}
      >
        {/* Fila 1: timecode + transporte (44 px). */}
        <div className="w-full min-h-[44px] flex items-center gap-1">
          <MobileTimecodeDisplay fps={fps} duration={duration} />

          <div className="flex items-center gap-0.5 shrink-0" role="group" aria-label="Transporte">
            <IconButton
              size="sm"
              onClick={handleToStart}
              aria-label="Ir al inicio"
              title="Ir al inicio"
              className="min-h-[44px] min-w-[44px]"
            >
              <SkipBack size={16} />
            </IconButton>

            <IconButton
              size="sm"
              onClick={handleStepBack}
              aria-label="Retroceder 1 fotograma"
              title="Retroceder 1 fotograma"
              className="min-h-[44px] min-w-[44px]"
            >
              <span className="font-mono text-[11px] font-bold">-1f</span>
            </IconButton>

            <IconButton
              size="sm"
              onClick={handleTogglePlay}
              aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
              title={isPlaying ? 'Pausar' : 'Reproducir'}
              aria-pressed={isPlaying}
              className="min-h-[44px] min-w-[44px]"
            >
              {/* El acento vive solo en el icono, nunca en un relleno. */}
              <span className="text-accent flex items-center justify-center">
                {isPlaying ? <Pause size={18} /> : <Play size={18} />}
              </span>
            </IconButton>

            <IconButton
              size="sm"
              onClick={handleStepForward}
              aria-label="Avanzar 1 fotograma"
              title="Avanzar 1 fotograma"
              className="min-h-[44px] min-w-[44px]"
            >
              <span className="font-mono text-[11px] font-bold">+1f</span>
            </IconButton>
          </div>
        </div>

        {/* Fila 2: dividir + volumen general (44 px). */}
        <div className="w-full min-h-[44px] flex items-center gap-2">
          {/* UI-27: deshabilitado cuando no hay nada que dividir, con motivo. */}
          <Button
            size="sm"
            variant="secondary"
            icon={<Scissors size={14} aria-hidden="true" />}
            onClick={splitAtPlayhead}
            disabled={!canSplit}
            aria-label="Dividir clip en el cabezal"
            title={canSplit ? 'Dividir en el cabezal' : 'Sin clip bajo el cabezal'}
            className="min-h-[44px] shrink-0"
          >
            Dividir
          </Button>

          <div className="flex min-w-0 flex-1 items-center gap-1.5" role="group" aria-label="Volumen general">
            <IconButton
              size="sm"
              onClick={handleToggleMasterMute}
              aria-label={isMasterMuted ? 'Activar sonido general' : 'Silenciar sonido general'}
              title={isMasterMuted ? 'Activar sonido' : 'Silenciar'}
              className="min-h-[44px] min-w-[44px] shrink-0"
            >
              {isMasterMuted || masterVolume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </IconButton>

            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={isMasterMuted ? 0 : masterVolume}
              onChange={handleMasterVolumeChange}
              aria-label="Volumen general"
              className="flex-1 min-w-0 min-h-[44px] accent-accent cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            />
            <span aria-hidden="true" className="shrink-0 w-10 text-right font-mono text-[11px] text-text-2">
              {Math.round((isMasterMuted ? 0 : masterVolume) * 100)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Default export: the component is loaded with `React.lazy()` from
 * `MobileCapCutLayout` (F3).
 */
export default MobilePreviewPlayer;
