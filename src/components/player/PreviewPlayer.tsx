import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { compositor, computeRenderScale } from '../../core/engine/Compositor';
import { masterClock } from '../../core/engine/MasterClock';
import { audioEngine } from '../../core/engine/AudioEngine';
import { mediaSourcePool } from '../../core/engine/MediaSourcePool';
import { IconButton } from '../ui/IconButton';

export const PreviewPlayer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** Scale applied to the project space to fill the backing store (KI-02). */
  const renderScaleRef = useRef<number>(1);

  const duration = useProjectStore((s) => s.project.duration);
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio);
  const resolution = useProjectStore((s) => s.project.resolution);
  const tracks = useProjectStore((s) => s.project.tracks);
  const clips = useProjectStore((s) => s.project.clips);
  const mediaPool = useProjectStore((s) => s.project.mediaPool);

  // Update masterClock duration whenever project duration changes
  useEffect(() => {
    masterClock.setDuration(duration);
  }, [duration]);

  // Pre-warm video elements for clips in initial playback window so decoders are ready without hitting browser decoder limits
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
  const renderCurrentFrame = useCallback((isPlaying: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const currProject = useProjectStore.getState().project;
    compositor.renderFrame({
      time: masterClock.getTime(),
      canvas,
      tracks: currProject.tracks,
      clips: currProject.clips,
      mediaPool: currProject.mediaPool,
      isPlaying,
      logicalWidth: currProject.resolution.width,
      logicalHeight: currProject.resolution.height,
      renderScale: renderScaleRef.current,
    });
  }, []);

  // Sync MasterClock time with store & render frame
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

  // Re-render frame when tracks/clips/mediaPool change while paused (e.g. clip edited, added, moved)
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
   * The fit is recomputed whenever the canvas box changes (window resize,
   * rotation, sidebar toggle…) through a `ResizeObserver`.
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

  // Determine CSS aspect ratio class
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

  /** Pantalla completa del visor (solo escritorio; el móvil tiene la suya). */
  const [aPantallaCompleta, setAPantallaCompleta] = useState(false);
  useEffect(() => {
    const alCambiarPantalla = () => setAPantallaCompleta(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', alCambiarPantalla);
    return () => document.removeEventListener('fullscreenchange', alCambiarPantalla);
  }, []);
  const alternarPantallaCompleta = () => {
    const contenedor = containerRef.current;
    if (!contenedor) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      contenedor.requestFullscreen().catch(() => {});
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative flex-1 bg-app flex items-center justify-center p-4 overflow-hidden select-none"
    >
      {/* Canvas wrapper.
          The width is `min(100%, <project width>)` instead of the intrinsic
          size of the canvas: the layout must not change when the backing
          store is re-fitted for the display (KI-02). */}
      <div
        style={{ width: `min(100%, ${resolution.width}px)` }}
        className={`relative flex items-center justify-center shadow-2xl bg-black rounded-lg overflow-hidden border border-border-subtle ${getAspectClass()}`}
      >
        <canvas
          ref={canvasRef}
          width={resolution.width}
          height={resolution.height}
          className="w-full h-full object-contain"
          role="img"
          aria-label={clips.length === 0 ? 'Monitor vacío: importa medios para empezar' : `Monitor: ${clips.length} clips en el timeline`}
        />

        {/* Insignia de resolución: etiqueta discreta, sin pastilla ni borde. */}
        <span className="absolute bottom-2 left-2 pointer-events-none text-caption text-text-2">
          {resolution.width}x{resolution.height} ({aspectRatio})
        </span>

        {/* F5 · Sin mensaje de vacío aquí: la línea de tiempo es la que posee
            el estado vacío (ahí está la acción «Añade un medio»). El visor
            queda en silencio para no duplicar el mensaje. */}

        {/* Pantalla completa: botón discreto en la esquina del visor. */}
        <IconButton
          aria-label="Pantalla completa"
          title="Pantalla completa"
          size="sm"
          onClick={alternarPantallaCompleta}
          className="absolute right-2 top-2 bg-black/60 text-text-2 hover:text-text-1"
        >
          {aPantallaCompleta ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
      </div>
    </div>
  );
};
