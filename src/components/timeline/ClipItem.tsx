import React, { useRef, useEffect } from 'react';
import { Film, Music, Type, VolumeX } from 'lucide-react';
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
  const zoom = useProjectStore((s) => s.zoom);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const selectClip = useProjectStore((s) => s.selectClip);
  const moveClip = useProjectStore((s) => s.moveClip);
  const commitClipChange = useProjectStore((s) => s.commitClipChange);
  const beginClipGesture = useProjectStore((s) => s.beginClipGesture);
  const trimClipStart = useProjectStore((s) => s.trimClipStart);
  const trimClipEnd = useProjectStore((s) => s.trimClipEnd);
  const splitClip = useProjectStore((s) => s.splitClip);
  const setSnappingGuideTime = useProjectStore((s) => s.setSnappingGuideTime);
  const mediaPool = useProjectStore((s) => s.project.mediaPool);

  const { activeTool, setActiveTab } = useUIStore();
  const clipRef = useRef<HTMLDivElement>(null);

  const isTrackLocked =
    useProjectStore((s) => s.project.tracks.find((t) => t.id === clip.trackId)?.isLocked) ??
    false;

  const isSelected = selectedClipId === clip.id;
  const leftPx = clip.start * zoom;
  // Minimum 28px so both trim handles (14px each) never overlap on tiny clips
  const widthPx = Math.max(28, clip.duration * zoom);
  const showHandles = isSelected || widthPx < 40 || zoom > 80;

  const media = mediaPool.find((m) => m.id === clip.mediaId);

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
  // Pointer-events only: pointermove/pointerup already cover mouse, touch and
  // pen. Registering mousemove+pointermove in parallel used to dispatch every
  // moveClip twice per frame.
  const handleBodyMouseDown = (e: React.PointerEvent) => {
    if (activeTool === 'split') return;
    if (e.button !== 0) return; // Only primary button / touch contact
    e.stopPropagation();
    e.preventDefault();
    selectClip(clip.id);
    // Locked track: select only, never start a drag gesture
    if (isTrackLocked) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const initialStart = clip.start;
    const initialTrackId = clip.trackId;
    let hasMoved = false;

    const onMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      // Small threshold to distinguish clicks from intentional drags
      if (!hasMoved && Math.hypot(deltaX, deltaY) < 4) {
        return;
      }

      if (!hasMoved) {
        hasMoved = true;
        beginClipGesture();
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

    const onUp = () => {
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);

      if (hasMoved) {
        commitClipChange();
      } else {
        setSnappingGuideTime(null);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // Trim Start (Trim In)
  const handleTrimStartMouseDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    selectClip(clip.id);
    if (isTrackLocked) return;

    const startX = e.clientX;
    const initialStart = clip.start;
    let hasMoved = false;

    const onMove = (moveEvent: PointerEvent) => {
      const deltaPx = moveEvent.clientX - startX;
      if (!hasMoved && Math.abs(deltaPx) < 3) return;
      if (!hasMoved) {
        hasMoved = true;
        beginClipGesture();
      }
      const deltaSec = pixelsToTime(deltaPx, zoom);
      trimClipStart(clip.id, initialStart + deltaSec);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (hasMoved) {
        commitClipChange();
      } else {
        setSnappingGuideTime(null);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // Trim End (Trim Out)
  const handleTrimEndMouseDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    selectClip(clip.id);
    if (isTrackLocked) return;

    const startX = e.clientX;
    const initialEnd = clip.start + clip.duration;
    let hasMoved = false;

    const onMove = (moveEvent: PointerEvent) => {
      const deltaPx = moveEvent.clientX - startX;
      if (!hasMoved && Math.abs(deltaPx) < 3) return;
      if (!hasMoved) {
        hasMoved = true;
        beginClipGesture();
      }
      const deltaSec = pixelsToTime(deltaPx, zoom);
      trimClipEnd(clip.id, initialEnd + deltaSec);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (hasMoved) {
        commitClipChange();
      } else {
        setSnappingGuideTime(null);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const getStyleTheme = () => {
    switch (clip.type) {
      case 'video':
        return {
          bg: 'bg-dark-900/95',
          border: isSelected ? 'border-cyan-400 ring-1 ring-cyan-400/60 z-20 shadow-md' : 'border-blue-500/40 hover:border-blue-400/80',
          accent: 'text-blue-300',
          badge: 'bg-blue-950/80 text-blue-300 border-blue-700/60',
          icon: <Film size={12} className="text-blue-400 shrink-0" />,
        };
      case 'audio':
        return {
          bg: 'bg-dark-900/95',
          border: isSelected ? 'border-cyan-400 ring-1 ring-cyan-400/60 z-20 shadow-md' : 'border-emerald-500/40 hover:border-emerald-400/80',
          accent: 'text-emerald-300',
          badge: 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60',
          icon: <Music size={12} className="text-emerald-400 shrink-0" />,
        };
      case 'text':
        return {
          bg: 'bg-dark-900/95',
          border: isSelected ? 'border-cyan-400 ring-1 ring-cyan-400/60 z-20 shadow-md' : 'border-amber-500/40 hover:border-amber-400/80',
          accent: 'text-amber-300',
          badge: 'bg-amber-950/80 text-amber-300 border-amber-700/60',
          icon: <Type size={12} className="text-amber-400 shrink-0" />,
        };
      default:
        return {
          bg: 'bg-dark-900/95',
          border: isSelected ? 'border-cyan-400 ring-1 ring-cyan-400/60 z-20 shadow-md' : 'border-dark-700 hover:border-dark-600',
          accent: 'text-slate-300',
          badge: 'bg-dark-800 text-slate-300 border-dark-700',
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
      role="button"
      tabIndex={0}
      aria-label={`Clip ${clip.name}, duración ${formatDuration(clip.duration)}`}
      aria-selected={isSelected}
      onClick={handleClick}
      onPointerDown={handleBodyMouseDown}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectClip(clip.id);
        }
      }}
      style={{
        left: `${leftPx}px`,
        width: `${widthPx}px`,
      }}
      className={`absolute top-1 bottom-1 rounded-md border ${theme.border} ${theme.bg} flex items-center justify-between overflow-hidden cursor-grab active:cursor-grabbing select-none transition-shadow z-10 touch-none group focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none`}
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

      {/* Left Trim Handle (CapCut Style Pill with Expanded Touch Hitbox) */}
      <div
        onPointerDown={handleTrimStartMouseDown}
        className={`w-3.5 h-full cursor-ew-resize flex items-center justify-center shrink-0 z-20 touch-none select-none relative before:absolute before:-inset-x-3.5 before:inset-y-0 before:z-30 transition-all ${
          showHandles
            ? 'opacity-100 bg-white text-dark-950 shadow-md'
            : 'opacity-0 group-hover:opacity-100 bg-black/40 hover:bg-blue-400/80 text-white'
        }`}
        title="Recortar inicio (Trim In)"
      >
        <div className={`w-[2px] h-3.5 rounded-full ${isSelected ? 'bg-dark-900' : 'bg-white/80'}`} />
      </div>

      {/* Clip Content Label & Badges */}
      <div className="flex-1 px-2 flex items-center gap-1.5 min-w-0 overflow-hidden pointer-events-none z-10">
        {theme.icon}
        <span className="text-xs font-semibold text-slate-100 truncate">
          {clip.name}
        </span>

        {/* Speed indicator */}
        {clip.speed && clip.speed !== 1 && (
          <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 font-bold shrink-0">
            {clip.speed}x
          </span>
        )}

        {/* Transition active indicator */}
        {(hasFadeIn || hasFadeOut) && (
          <span title="Transición activa" className="text-[9px] font-mono font-semibold px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 shrink-0">
            FADE
          </span>
        )}

        {clip.muted && <VolumeX size={11} className="text-rose-400 shrink-0 ml-1" />}
        <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-auto font-medium">
          {formatDuration(clip.duration)}
        </span>
      </div>

      {/* Right Trim Handle (CapCut Style Pill with Expanded Touch Hitbox) */}
      <div
        onPointerDown={handleTrimEndMouseDown}
        className={`w-3.5 h-full cursor-ew-resize flex items-center justify-center shrink-0 z-20 touch-none select-none relative before:absolute before:-inset-x-3.5 before:inset-y-0 before:z-30 transition-all ${
          showHandles
            ? 'opacity-100 bg-white text-dark-950 shadow-md'
            : 'opacity-0 group-hover:opacity-100 bg-black/40 hover:bg-blue-400/80 text-white'
        }`}
        title="Recortar final (Trim Out)"
      >
        <div className={`w-[2px] h-3.5 rounded-full ${isSelected ? 'bg-dark-900' : 'bg-white/80'}`} />
      </div>
    </div>
  );
};
