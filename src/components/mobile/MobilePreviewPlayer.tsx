import React, { useEffect, useRef } from 'react';
import { 
  Play, 
  Pause, 
  SkipBack, 
  Scissors, 
  Maximize2 
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { compositor } from '../../core/engine/Compositor';
import { masterClock } from '../../core/engine/MasterClock';
import { audioEngine } from '../../core/engine/AudioEngine';
import { mediaSourcePool } from '../../core/engine/MediaSourcePool';
import { formatTimecode } from '../../core/utils/time';

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
    <div className="absolute top-2 left-2 bg-black/70 backdrop-blur-md px-2 py-0.5 rounded-full text-[10px] font-mono text-cyan-300 font-bold border border-cyan-500/20 shadow pointer-events-none flex items-center gap-1 z-10">
      <span ref={currentSpanRef}>{formatTimecode(masterClock.getTime(), fps)}</span>
      <span className="text-slate-500">/</span>
      <span className="text-slate-400">{formatTimecode(duration, fps)}</span>
    </div>
  );
};

export const MobilePreviewPlayer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const duration = useProjectStore((s) => s.project.duration);
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio);
  const resolution = useProjectStore((s) => s.project.resolution);
  const tracks = useProjectStore((s) => s.project.tracks);
  const clips = useProjectStore((s) => s.project.clips);
  const mediaPool = useProjectStore((s) => s.project.mediaPool);
  const isPlaying = useProjectStore((s) => s.isPlaying);
  const fps = useProjectStore((s) => s.project.fps);
  const splitAtPlayhead = useProjectStore((s) => s.splitAtPlayhead);

  useEffect(() => {
    masterClock.setDuration(duration);
  }, [duration]);

  useEffect(() => {
    for (const clip of clips) {
      if (clip.type === 'video') {
        const media = mediaPool.find((m) => m.id === clip.mediaId);
        if (media) {
          mediaSourcePool.getVideoElement(media, clip.id, clip.sourceStart);
        }
      }
    }
  }, [clips, mediaPool]);

  // Sync clock time and render
  useEffect(() => {
    let lastStoreSyncTime = 0;
    const unsubTime = masterClock.subscribeTime((t) => {
      const isCurrentlyPlaying = masterClock.getIsPlaying();

      // Throttle store sync during playback
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!isCurrentlyPlaying || now - lastStoreSyncTime >= 100) {
        lastStoreSyncTime = now;
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
        const currProject = useProjectStore.getState().project;
        const t = masterClock.getTime();
        compositor.renderFrame({
          time: t,
          canvas: canvasRef.current,
          tracks: currProject.tracks,
          clips: currProject.clips,
          mediaPool: currProject.mediaPool,
          isPlaying: false,
        });
      }
    });

    return () => {
      unsubTime();
      unsubState();
      unsubFrame();
    };
  }, []);

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
      className="relative flex-1 bg-dark-950 flex flex-col items-center justify-center p-2 overflow-hidden select-none min-h-[180px] max-h-[46vh]"
    >
      {/* Video Canvas Container */}
      <div className={`relative flex items-center justify-center shadow-2xl bg-black rounded-lg overflow-hidden border border-dark-800 ${getAspectClass()}`}>
        <canvas
          ref={canvasRef}
          width={resolution.width}
          height={resolution.height}
          className="w-full h-full object-contain"
        />

        {/* Floating Timecode Pill */}
        <MobileTimecodeDisplay fps={fps} duration={duration} />

        {/* Fullscreen Button */}
        <button
          onClick={handleFullscreen}
          className="absolute top-2 right-2 p-1.5 bg-black/60 backdrop-blur-md rounded-full text-slate-300 hover:text-white border border-white/10 active:scale-95 transition"
          title="Pantalla Completa"
        >
          <Maximize2 size={13} />
        </button>

        {/* Floating Quick Play Overlay (Center tap) */}
        <button
          onClick={handleTogglePlay}
          className="absolute inset-0 m-auto w-12 h-12 rounded-full bg-black/50 hover:bg-black/70 backdrop-blur-sm flex items-center justify-center text-white border border-white/20 shadow-lg active:scale-90 transition opacity-0 hover:opacity-100 focus:opacity-100 focus:outline-none"
          title={isPlaying ? "Pausar" : "Reproducir"}
        >
          {isPlaying ? <Pause size={20} /> : <Play size={20} className="ml-0.5" />}
        </button>
      </div>

      {/* Floating Bottom Minimal Controls Bar */}
      <div className="w-full max-w-sm flex items-center justify-between px-3 pt-2">
        <button
          onClick={handleToStart}
          className="p-1.5 text-slate-400 hover:text-white rounded-lg active:scale-90 transition"
          title="Ir al inicio"
        >
          <SkipBack size={16} />
        </button>

        {/* Play/Pause Button */}
        <button
          onClick={handleTogglePlay}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full font-bold text-xs shadow-md active:scale-95 transition ${
            isPlaying 
              ? 'bg-amber-500 text-dark-950 shadow-amber-500/20' 
              : 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-cyan-500/20'
          }`}
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} className="fill-white" />}
          <span>{isPlaying ? 'Pausar' : 'Reproducir'}</span>
        </button>

        {/* Quick Split Button */}
        <button
          onClick={splitAtPlayhead}
          className="flex items-center gap-1 px-2.5 py-1 text-slate-300 hover:text-white bg-dark-850 border border-dark-750 rounded-lg text-xs font-medium active:scale-90 transition"
          title="Cortar clip aquí"
        >
          <Scissors size={14} className="text-cyan-400" />
          <span>Dividir</span>
        </button>
      </div>
    </div>
  );
};
