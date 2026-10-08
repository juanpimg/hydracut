import React, { useRef, useEffect } from 'react';
import { Film, Music, Type, VolumeX, Sparkles } from 'lucide-react';
import { Clip } from '../../types/project';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import { formatDuration, pixelsToTime } from '../../core/utils/time';

interface ClipItemProps {
  clip: Clip;
}

const AudioWaveform: React.FC<{
  peaks?: number[];
  width: number;
  sourceStart: number;
  sourceDuration: number;
  duration: number;
  speed?: number;
}> = ({ peaks, width, sourceStart, sourceDuration, duration, speed = 1 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!peaks || peaks.length === 0) return;

    const spd = speed > 0 ? speed : 1;
    const totalSrcDuration = Math.max(0.1, sourceDuration || duration);
    const startFrac = Math.max(0, Math.min(1, sourceStart / totalSrcDuration));
    const endFrac = Math.max(startFrac, Math.min(1, (sourceStart + duration * spd) / totalSrcDuration));

    const startIdx = Math.floor(startFrac * peaks.length);
    const endIdx = Math.min(peaks.length, Math.ceil(endFrac * peaks.length));
    const sliced = peaks.slice(startIdx, Math.max(startIdx + 1, endIdx));
    const data = sliced.length > 0 ? sliced : peaks;

    const barWidth = 3;
    const gap = 1.5;
    const totalBars = Math.floor(w / (barWidth + gap));
    if (totalBars <= 0) return;

    ctx.fillStyle = '#34d399'; // Emerald-400

    for (let i = 0; i < totalBars; i++) {
      const dataIndex = Math.floor((i / totalBars) * data.length);
      const peak = data[dataIndex] ?? 0.2;
      const barHeight = Math.max(3, peak * (h - 8));
      const x = i * (barWidth + gap);
      const y = (h - barHeight) / 2;

      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x, y, barWidth, barHeight, 1.5);
      } else {
        ctx.rect(x, y, barWidth, barHeight);
      }
      ctx.fill();
    }
  }, [peaks, width, sourceStart, sourceDuration, duration, speed]);

  return (
    <canvas
      ref={canvasRef}
      width={Math.max(30, Math.floor(width))}
      height={48}
      className="absolute inset-0 w-full h-full pointer-events-none opacity-50 z-0"
    />
  );
};

export const ClipItem: React.FC<ClipItemProps> = ({ clip }) => {
  const { 
    zoom, 
    selectedClipId, 
    selectClip, 
    moveClip, 
    commitClipChange,
    trimClipStart, 
    trimClipEnd, 
    splitClip,
    setSnappingGuideTime,
    project 
  } = useProjectStore();

  const { activeTool, setActiveTab } = useUIStore();
  const clipRef = useRef<HTMLDivElement>(null);

  const isSelected = selectedClipId === clip.id;
  const leftPx = clip.start * zoom;
  const widthPx = Math.max(12, clip.duration * zoom);

  const media = project.mediaPool.find((m) => m.id === clip.mediaId);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    // If split tool is active, split here
    if (activeTool === 'split') {
      if (!clipRef.current) return;
      const rect = clipRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const offsetSeconds = Math.max(0, pixelsToTime(clickX, zoom));
      splitClip(clip.id, clip.start + offsetSeconds);
      return;
    }

    // Otherwise select clip and open inspector
    selectClip(clip.id);
    setActiveTab('inspector');
  };

  // Body Dragging (Move clip in time AND vertically between compatible tracks)
  const handleBodyMouseDown = (e: React.MouseEvent) => {
    if (activeTool === 'split') return;
    if (e.button !== 0) return; // Only primary mouse button
    e.stopPropagation();
    e.preventDefault();
    selectClip(clip.id);

    const startX = e.clientX;
    const startY = e.clientY;
    const initialStart = clip.start;
    const initialTrackId = clip.trackId;
    let hasMoved = false;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      // Small threshold to distinguish clicks from intentional drags
      if (!hasMoved && Math.hypot(deltaX, deltaY) < 4) {
        return;
      }

      if (!hasMoved) {
        hasMoved = true;
        document.body.style.cursor = 'grabbing';
      }

      const deltaSec = pixelsToTime(deltaX, zoom);
      const newStart = Math.max(0, initialStart + deltaSec);

      // Detect which track lane the cursor is over for vertical track moving
      let targetTrackId = initialTrackId;
      const elementsUnder = document.elementsFromPoint(moveEvent.clientX, moveEvent.clientY);
      for (const el of elementsUnder) {
        const lane = el.closest('[data-track-id]');
        if (lane) {
          const tId = lane.getAttribute('data-track-id');
          const tType = lane.getAttribute('data-track-type');
          // Check track type compatibility:
          const isCompatible =
            ((clip.type === 'video' || clip.type === 'image') && tType === 'video') ||
            (clip.type === 'audio' && tType === 'audio') ||
            (clip.type === 'text' && tType === 'text');

          if (isCompatible && tId) {
            targetTrackId = tId;
            break;
          }
        }
      }

      moveClip(clip.id, newStart, targetTrackId);
    };

    const onMouseUp = () => {
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);

      if (hasMoved) {
        commitClipChange();
      } else {
        setSnappingGuideTime(null);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Trim Start (Trim In)
  const handleTrimStartMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    selectClip(clip.id);

    const startX = e.clientX;
    const initialStart = clip.start;
    let hasMoved = false;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaPx = moveEvent.clientX - startX;
      if (!hasMoved && Math.abs(deltaPx) < 3) return;
      hasMoved = true;
      const deltaSec = pixelsToTime(deltaPx, zoom);
      trimClipStart(clip.id, initialStart + deltaSec);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (hasMoved) {
        commitClipChange();
      } else {
        setSnappingGuideTime(null);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Trim End (Trim Out)
  const handleTrimEndMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    selectClip(clip.id);

    const startX = e.clientX;
    const initialEnd = clip.start + clip.duration;
    let hasMoved = false;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaPx = moveEvent.clientX - startX;
      if (!hasMoved && Math.abs(deltaPx) < 3) return;
      hasMoved = true;
      const deltaSec = pixelsToTime(deltaPx, zoom);
      trimClipEnd(clip.id, initialEnd + deltaSec);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (hasMoved) {
        commitClipChange();
      } else {
        setSnappingGuideTime(null);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const getStyleTheme = () => {
    switch (clip.type) {
      case 'video':
        return {
          bg: 'bg-gradient-to-r from-blue-950/90 to-blue-900/70',
          border: isSelected ? 'border-blue-400 ring-2 ring-blue-500/50' : 'border-blue-600/50 hover:border-blue-400',
          accent: 'text-blue-400',
          icon: <Film size={12} className="text-blue-400 shrink-0" />,
        };
      case 'audio':
        return {
          bg: 'bg-gradient-to-r from-emerald-950/90 to-emerald-900/70',
          border: isSelected ? 'border-emerald-400 ring-2 ring-emerald-500/50' : 'border-emerald-600/50 hover:border-emerald-400',
          accent: 'text-emerald-400',
          icon: <Music size={12} className="text-emerald-400 shrink-0" />,
        };
      case 'text':
        return {
          bg: 'bg-gradient-to-r from-purple-950/90 to-purple-900/70',
          border: isSelected ? 'border-purple-400 ring-2 ring-purple-500/50' : 'border-purple-600/50 hover:border-purple-400',
          accent: 'text-purple-400',
          icon: <Type size={12} className="text-purple-400 shrink-0" />,
        };
      default:
        return {
          bg: 'bg-dark-800',
          border: isSelected ? 'border-blue-400 ring-2 ring-blue-500/50' : 'border-dark-700 hover:border-dark-600',
          accent: 'text-slate-400',
          icon: <Film size={12} className="shrink-0" />,
        };
    }
  };

  const theme = getStyleTheme();

  // Transitions visual metrics
  const fadeInDuration = clip.transition?.fadeInDuration || 0;
  const fadeInType = clip.transition?.fadeInType;
  const hasFadeIn = fadeInDuration > 0 && fadeInType && fadeInType !== 'none';
  const fadeInWidthPx = hasFadeIn ? Math.min(widthPx, fadeInDuration * zoom) : 0;

  const fadeOutDuration = clip.transition?.fadeOutDuration || 0;
  const fadeOutType = clip.transition?.fadeOutType;
  const hasFadeOut = fadeOutDuration > 0 && fadeOutType && fadeOutType !== 'none';
  const fadeOutWidthPx = hasFadeOut ? Math.min(widthPx, fadeOutDuration * zoom) : 0;

  return (
    <div
      ref={clipRef}
      onClick={handleClick}
      onMouseDown={handleBodyMouseDown}
      style={{
        left: `${leftPx}px`,
        width: `${widthPx}px`,
      }}
      className={`absolute top-1 bottom-1 rounded-md border ${theme.border} ${theme.bg} backdrop-blur-xs flex items-center justify-between overflow-hidden cursor-grab active:cursor-grabbing select-none transition-shadow z-10 group`}
    >
      {/* Background Filmstrip for Video clips */}
      {clip.type === 'video' && media?.thumbnails && media.thumbnails.length > 0 && (() => {
        const spd = clip.speed && clip.speed > 0 ? clip.speed : 1;
        const totalSrcDuration = Math.max(0.1, clip.sourceDuration || media.duration || clip.duration);
        const startFrac = Math.max(0, Math.min(1, clip.sourceStart / totalSrcDuration));
        const endFrac = Math.max(startFrac, Math.min(1, (clip.sourceStart + clip.duration * spd) / totalSrcDuration));
        const allThumbs = media.thumbnails;
        const startIdx = Math.floor(startFrac * allThumbs.length);
        const endIdx = Math.min(allThumbs.length, Math.ceil(endFrac * allThumbs.length));
        const visibleThumbs = allThumbs.slice(startIdx, Math.max(startIdx + 1, endIdx));
        const thumbsToRender = visibleThumbs.length > 0 ? visibleThumbs : allThumbs;

        return (
          <div className="absolute inset-0 flex overflow-hidden opacity-30 pointer-events-none z-0">
            {thumbsToRender.map((thumbUrl, idx) => (
              <img
                key={idx}
                src={thumbUrl}
                alt=""
                className="h-full object-cover shrink-0 border-r border-black/40"
                style={{ width: `${Math.max(48, widthPx / thumbsToRender.length)}px` }}
              />
            ))}
          </div>
        );
      })()}

      {/* Fallback thumbnail for video when filmstrip array is not populated */}
      {clip.type === 'video' && (!media?.thumbnails || media.thumbnails.length === 0) && media?.thumbnailUrl && (
        <div className="absolute inset-0 flex overflow-hidden opacity-25 pointer-events-none z-0">
          <img src={media.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        </div>
      )}

      {/* Background Audio Waveform Canvas for Audio clips */}
      {clip.type === 'audio' && (
        <AudioWaveform
          peaks={media?.waveformPeaks}
          width={widthPx}
          sourceStart={clip.sourceStart}
          sourceDuration={clip.sourceDuration || media?.duration || clip.duration}
          duration={clip.duration}
          speed={clip.speed}
        />
      )}

      {/* Transition Fade In Overlay & Indicator */}
      {hasFadeIn && (
        <div
          data-testid="fade-in-indicator"
          style={{ width: `${fadeInWidthPx}px` }}
          className={`absolute top-0 bottom-0 left-0 pointer-events-none border-r border-dashed border-blue-400/60 z-10 flex items-start p-1 ${
            fadeInType === 'fade-white'
              ? 'bg-gradient-to-r from-white/70 to-transparent'
              : 'bg-gradient-to-r from-black/80 to-transparent'
          }`}
          title={`Fade In: ${fadeInType} (${fadeInDuration}s)`}
        >
          <span
            className={`text-[8px] font-mono px-0.5 rounded leading-tight ${
              fadeInType === 'fade-white'
                ? 'text-slate-900 bg-white/80 font-bold'
                : 'text-blue-300 bg-black/60'
            }`}
          >
            ▲ In
          </span>
        </div>
      )}

      {/* Transition Fade Out Overlay & Indicator */}
      {hasFadeOut && (
        <div
          data-testid="fade-out-indicator"
          style={{ width: `${fadeOutWidthPx}px` }}
          className={`absolute top-0 bottom-0 right-0 pointer-events-none border-l border-dashed border-blue-400/60 z-10 flex items-start justify-end p-1 ${
            fadeOutType === 'fade-white'
              ? 'bg-gradient-to-l from-white/70 to-transparent'
              : 'bg-gradient-to-l from-black/80 to-transparent'
          }`}
          title={`Fade Out: ${fadeOutType} (${fadeOutDuration}s)`}
        >
          <span
            className={`text-[8px] font-mono px-0.5 rounded leading-tight ${
              fadeOutType === 'fade-white'
                ? 'text-slate-900 bg-white/80 font-bold'
                : 'text-blue-300 bg-black/60'
            }`}
          >
            ▼ Out
          </span>
        </div>
      )}

      {/* Left Trim Handle */}
      <div
        onMouseDown={handleTrimStartMouseDown}
        className="w-2.5 h-full bg-black/40 hover:bg-blue-400/80 cursor-ew-resize flex items-center justify-center opacity-0 group-hover:opacity-100 transition shrink-0 z-20"
        title="Recortar inicio (Trim In)"
      >
        <div className="w-[1.5px] h-3 bg-white/80 rounded" />
      </div>

      {/* Clip Content Label & Badges */}
      <div className="flex-1 px-2 flex items-center gap-1.5 min-w-0 overflow-hidden pointer-events-none z-10">
        {theme.icon}
        <span className="text-xs font-medium text-slate-200 truncate drop-shadow-sm">
          {clip.name}
        </span>

        {/* Speed indicator */}
        {clip.speed && clip.speed !== 1 && (
          <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-blue-500/30 text-blue-300 border border-blue-500/40 font-bold shrink-0">
            {clip.speed}x
          </span>
        )}

        {/* Transition active icon */}
        {(hasFadeIn || hasFadeOut) && (
          <span title="Transición activa" className="flex items-center">
            <Sparkles size={11} className="text-amber-400 shrink-0" />
          </span>
        )}

        {clip.muted && <VolumeX size={11} className="text-red-400 shrink-0 ml-1" />}
        <span className="text-[10px] font-mono text-slate-300 drop-shadow-sm shrink-0 ml-auto">
          {formatDuration(clip.duration)}
        </span>
      </div>

      {/* Right Trim Handle */}
      <div
        onMouseDown={handleTrimEndMouseDown}
        className="w-2.5 h-full bg-black/40 hover:bg-blue-400/80 cursor-ew-resize flex items-center justify-center opacity-0 group-hover:opacity-100 transition shrink-0 z-20"
        title="Recortar final (Trim Out)"
      >
        <div className="w-[1.5px] h-3 bg-white/80 rounded" />
      </div>
    </div>
  );
};
