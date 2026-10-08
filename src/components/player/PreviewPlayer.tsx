import React, { useEffect, useRef } from 'react';
import { useProjectStore } from '../../store/useProjectStore';
import { compositor } from '../../core/engine/Compositor';
import { masterClock } from '../../core/engine/MasterClock';
import { audioEngine } from '../../core/engine/AudioEngine';
import { mediaSourcePool } from '../../core/engine/MediaSourcePool';

export const PreviewPlayer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // Pre-warm video elements for active timeline clips so decoders are ready in advance
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

  // Sync MasterClock time with store & render frame
  useEffect(() => {
    let lastStoreSyncTime = 0;
    const unsubTime = masterClock.subscribeTime((t) => {
      const isCurrentlyPlaying = masterClock.getIsPlaying();

      // Throttle store state sync during continuous playback to avoid choking the main thread
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

  return (
    <div
      ref={containerRef}
      className="relative flex-1 bg-dark-950 flex items-center justify-center p-4 overflow-hidden select-none"
    >
      {/* Canvas wrapper */}
      <div className={`relative flex items-center justify-center shadow-2xl bg-black rounded-lg overflow-hidden border border-dark-800 ${getAspectClass()}`}>
        <canvas
          ref={canvasRef}
          width={resolution.width}
          height={resolution.height}
          className="w-full h-full object-contain"
        />

        {/* Resolution Badge */}
        <div className="absolute top-2 left-2 bg-black/60 backdrop-blur-xs px-2 py-0.5 rounded text-[11px] font-mono text-slate-400 pointer-events-none border border-white/5">
          {resolution.width}x{resolution.height} ({aspectRatio})
        </div>
      </div>
    </div>
  );
};
