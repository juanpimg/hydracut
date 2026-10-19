import React, { useRef, useEffect, useMemo } from 'react';
import { Film, Music, Type, VolumeX, AlertTriangle } from 'lucide-react';
import { Clip } from '../../types/project';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import { formatDuration, pixelsToTime } from '../../core/utils/time';

interface ClipItemProps {
  clip: Clip;
}

/**
 * Device pixel ratio used for the canvas backing store, capped at 2 so a
 * 3x phone does not quadruple the waveform rasterisation cost.
 */
export function getDevicePixelRatio(): number {
  if (typeof window === 'undefined') return 1;
  const raw = window.devicePixelRatio;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(raw, 2);
}

/**
 * Backing store size of a canvas that displays `cssWidth` x `cssHeight` CSS
 * pixels on a screen with the given device pixel ratio.
 */
export function getCanvasBackingSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number
): { width: number; height: number } {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return {
    width: Math.max(1, Math.round(cssWidth * ratio)),
    height: Math.max(1, Math.round(cssHeight * ratio)),
  };
}

/** Geometry of a track lane, captured once per drag gesture. */
export interface TrackLaneRect {
  id: string;
  type: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Captures the geometry of every track lane.
 * Reading the rects once per gesture replaces the per-move DOM hit test,
 * which forced a synchronous layout on every pointer move.
 */
export function collectTrackLanes(root?: ParentNode | null): TrackLaneRect[] {
  const scope = root ?? (typeof document !== 'undefined' ? document : null);
  if (!scope) return [];
  const nodes = scope.querySelectorAll<HTMLElement>('[data-track-id]');
  const lanes: TrackLaneRect[] = [];
  nodes.forEach((node) => {
    const id = node.getAttribute('data-track-id');
    if (!id) return;
    const rect = node.getBoundingClientRect();
    lanes.push({
      id,
      type: node.getAttribute('data-track-type') || '',
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    });
  });
  return lanes;
}

/**
 * Finds the track lane under a viewport point using cached rectangles.
 * The innermost (smallest) lane wins when several overlap.
 */
export function findTrackAtPoint(
  lanes: TrackLaneRect[],
  x: number,
  y: number
): TrackLaneRect | null {
  if (!lanes || lanes.length === 0) return null;
  const vertical = lanes.filter((lane) => y >= lane.top && y <= lane.bottom);
  if (vertical.length === 0) return null;
  const horizontal = vertical.filter((lane) => x >= lane.left && x <= lane.right);
  const candidates = horizontal.length > 0 ? horizontal : vertical;
  return candidates.reduce((best, lane) => {
    const area = (lane.right - lane.left) * (lane.bottom - lane.top);
    const bestArea = (best.right - best.left) * (best.bottom - best.top);
    return area < bestArea ? lane : best;
  });
}

/**
 * True when a clip of the given type can live on a track of the given type.
 */
export function isTrackCompatible(clipType: string, trackType: string): boolean {
  if ((clipType === 'video' || clipType === 'image') && trackType === 'video') return true;
  if (clipType === 'audio' && trackType === 'audio') return true;
  if (clipType === 'text' && trackType === 'text') return true;
  return false;
}

export interface TrimBounds {
  min: number;
  max: number;
}

/**
 * Range of absolute times the clip start can be moved to.
 */
export function getTrimStartBounds(clip: Clip): TrimBounds {
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const min = Math.max(0, clip.start - clip.sourceStart / speed);
  const max = Math.max(min, clip.start + clip.duration - 0.1);
  return { min, max };
}

/**
 * Range of absolute times the clip end can be moved to.
 */
export function getTrimEndBounds(clip: Clip): TrimBounds {
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const min = Math.min(clip.start + 0.1, clip.start + clip.duration);
  const max = Math.max(min, clip.start + Math.max(0, (clip.sourceDuration - clip.sourceStart) / speed));
  return { min, max };
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
  const dpr = getDevicePixelRatio();

  // The slice of peaks that is visible does not depend on the zoom: it is
  // memoised so a zoom only re-rasterises, it does not re-slice the data.
  const sliced = useMemo(() => {
    if (!peaks || peaks.length === 0) return null;
    const spd = speed > 0 ? speed : 1;
    const totalSrcDuration = Math.max(0.1, sourceDuration || duration);
    const startFrac = Math.max(0, Math.min(1, sourceStart / totalSrcDuration));
    const endFrac = Math.max(startFrac, Math.min(1, (sourceStart + duration * spd) / totalSrcDuration));

    const startIdx = Math.floor(startFrac * peaks.length);
    const endIdx = Math.min(peaks.length, Math.ceil(endFrac * peaks.length));
    const slice = peaks.slice(startIdx, Math.max(startIdx + 1, endIdx));
    return slice.length > 0 ? slice : peaks;
  }, [peaks, sourceStart, sourceDuration, duration, speed]);

  const cssWidth = Math.max(30, Math.floor(width));
  const cssHeight = 48;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // The backing store is scaled by the device pixel ratio, so the waveform
    // is crisp on HiDPI screens instead of being upscaled by the browser.
    const backing = getCanvasBackingSize(cssWidth, cssHeight, dpr);
    if (canvas.width !== backing.width) canvas.width = backing.width;
    if (canvas.height !== backing.height) canvas.height = backing.height;

    // Draw in CSS pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (!sliced) return;

    const barWidth = 3;
    const gap = 1.5;
    const totalBars = Math.floor(cssWidth / (barWidth + gap));
    if (totalBars <= 0) return;

    ctx.fillStyle = '#34d399'; // Emerald-400

    for (let i = 0; i < totalBars; i++) {
      const dataIndex = Math.floor((i / totalBars) * sliced.length);
      const peak = sliced[dataIndex] ?? 0.2;
      const barHeight = Math.max(3, peak * (cssHeight - 8));
      const x = i * (barWidth + gap);
      const y = (cssHeight - barHeight) / 2;

      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x, y, barWidth, barHeight, 1.5);
      } else {
        ctx.rect(x, y, barWidth, barHeight);
      }
      ctx.fill();
    }
  }, [sliced, cssWidth, dpr]);

  return (
    <canvas
      ref={canvasRef}
      width={getCanvasBackingSize(cssWidth, cssHeight, dpr).width}
      height={getCanvasBackingSize(cssWidth, cssHeight, dpr).height}
      className="absolute inset-0 w-full h-full pointer-events-none opacity-50 z-0"
    />
  );
};

export const ClipItem: React.FC<ClipItemProps> = ({ clip }) => {
  const zoom = useProjectStore((s) => s.zoom);
  const fps = useProjectStore((s) => s.project.fps);
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
  /** Abort controller of the pointer gesture in progress (if any). */
  const gestureRef = useRef<AbortController | null>(null);
  /** True while a gesture is in progress (used by the unmount cleanup). */
  const gestureActiveRef = useRef(false);
  /** Track lane geometry captured at the beginning of a drag. */
  const laneRectsRef = useRef<TrackLaneRect[]>([]);

  const isTrackLocked =
    useProjectStore((s) => s.project.tracks.find((t) => t.id === clip.trackId)?.isLocked) ??
    false;

  const isSelected = selectedClipId === clip.id;
  const leftPx = clip.start * zoom;
  // Minimum 28px so both trim handles (14px each) never overlap on tiny clips
  const widthPx = Math.max(28, clip.duration * zoom);
  const showHandles = isSelected || widthPx < 40 || zoom > 80;

  const media = mediaPool.find((m) => m.id === clip.mediaId);

  /**
   * F3: a clip whose media is not usable (the bytes are gone, the media
   * cannot be decoded or it is not in the pool at all) must NOT look like a
   * normal clip: it renders black and silent, so it shows a visible badge.
   */
  const isTextClip = clip.type === 'text';
  const mediaMissing = !isTextClip && (!media || media.status === 'missing');
  const mediaError = !isTextClip && !mediaMissing && media?.status === 'error';
  const mediaUnavailable = mediaMissing || mediaError;

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

  // Unmount safety net: the window listeners of a gesture in progress are
  // removed and the gesture is closed (otherwise the store would keep the
  // "gesture pending" flag and the next gesture would not push history).
  useEffect(() => {
    return () => {
      gestureRef.current?.abort();
      gestureRef.current = null;
      if (gestureActiveRef.current) {
        gestureActiveRef.current = false;
        commitClipChange();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginGesture = (): AbortController => {
    gestureRef.current?.abort();
    const controller = new AbortController();
    gestureRef.current = controller;
    gestureActiveRef.current = true;
    return controller;
  };

  const endGesture = (controller: AbortController) => {
    controller.abort();
    if (gestureRef.current === controller) gestureRef.current = null;
    gestureActiveRef.current = false;
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

    // Capture the track geometry once: the hit test then runs against
    // cached rectangles instead of forcing a layout on every pointermove.
    laneRectsRef.current = collectTrackLanes();

    const controller = beginGesture();
    const { signal } = controller;

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
      let lane = findTrackAtPoint(laneRectsRef.current, moveEvent.clientX, moveEvent.clientY);
      if (!lane) {
        // The cached geometry may be stale (scroll / resize): refresh once.
        laneRectsRef.current = collectTrackLanes();
        lane = findTrackAtPoint(laneRectsRef.current, moveEvent.clientX, moveEvent.clientY);
      }
      if (lane && isTrackCompatible(clip.type, lane.type)) {
        targetTrackId = lane.id;
      }

      moveClip(clip.id, newStart, targetTrackId);
    };

    const onUp = () => {
      document.body.style.cursor = '';
      endGesture(controller);

      if (hasMoved) {
        commitClipChange();
      } else {
        setSnappingGuideTime(null);
      }
    };

    window.addEventListener('pointermove', onMove, { signal });
    window.addEventListener('pointerup', onUp, { signal });
    window.addEventListener('pointercancel', onUp, { signal });
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

    const controller = beginGesture();
    const { signal } = controller;

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
      endGesture(controller);
      if (hasMoved) {
        commitClipChange();
      } else {
        setSnappingGuideTime(null);
      }
    };

    window.addEventListener('pointermove', onMove, { signal });
    window.addEventListener('pointerup', onUp, { signal });
    window.addEventListener('pointercancel', onUp, { signal });
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

    const controller = beginGesture();
    const { signal } = controller;

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
      endGesture(controller);
      if (hasMoved) {
        commitClipChange();
      } else {
        setSnappingGuideTime(null);
      }
    };

    window.addEventListener('pointermove', onMove, { signal });
    window.addEventListener('pointerup', onUp, { signal });
    window.addEventListener('pointercancel', onUp, { signal });
  };

  /* ------------------------------------------------------------------ */
  /* Keyboard trimming (WCAG 2.1.1)                                     */
  /* ------------------------------------------------------------------ */

  const trimStartBounds = getTrimStartBounds(clip);
  const trimEndBounds = getTrimEndBounds(clip);
  const frameStep = 1 / Math.max(1, fps || 30);

  const resolveKeyTarget = (
    e: React.KeyboardEvent,
    current: number,
    bounds: TrimBounds
  ): number | null => {
    // Shift = 1 second, plain arrow = 1 frame.
    const step = e.shiftKey ? 1 : frameStep;
    switch (e.key) {
      case 'ArrowLeft':
        return Math.max(bounds.min, current - step);
      case 'ArrowRight':
        return Math.min(bounds.max, current + step);
      case 'Home':
        return bounds.min;
      case 'End':
        return bounds.max;
      default:
        return null;
    }
  };

  const handleTrimStartKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = resolveKeyTarget(e, clip.start, trimStartBounds);
    if (target === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (isTrackLocked) return;
    beginClipGesture();
    // F5: the keyboard trim is FRAME EXACT: the magnetic snapping is disabled,
    // otherwise a single arrow press can jump the edge to the playhead or to
    // the nearest edge of another clip.
    trimClipStart(clip.id, target, { snap: false });
    commitClipChange();
  };

  const handleTrimEndKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = resolveKeyTarget(e, clip.start + clip.duration, trimEndBounds);
    if (target === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (isTrackLocked) return;
    beginClipGesture();
    // F5: frame exact, no magnetic snapping.
    trimClipEnd(clip.id, target, { snap: false });
    commitClipChange();
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

  // F3: a clip without a usable media gets a warning border: it must not
  // look like a normal clip when it renders black and silent.
  const themeBorder = mediaUnavailable
    ? 'border-rose-500/70 bg-rose-950/30'
    : theme.border;

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
      className={`absolute top-1 bottom-1 rounded-md border ${themeBorder} ${theme.bg} flex items-center justify-between overflow-hidden cursor-grab active:cursor-grabbing select-none transition-shadow z-10 touch-none group focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none`}
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
        onKeyDown={handleTrimStartKeyDown}
        role="slider"
        tabIndex={0}
        aria-label={`Recortar inicio de ${clip.name}`}
        aria-orientation="horizontal"
        aria-valuemin={Number(trimStartBounds.min.toFixed(3))}
        aria-valuemax={Number(trimStartBounds.max.toFixed(3))}
        aria-valuenow={Number(clip.start.toFixed(3))}
        aria-valuetext={formatDuration(clip.start)}
        className={`w-3.5 h-full cursor-ew-resize flex items-center justify-center shrink-0 z-20 touch-none select-none relative before:absolute before:-inset-x-3.5 before:inset-y-0 before:z-30 transition-all focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none ${
          showHandles
            ? 'opacity-100 bg-white text-dark-950 shadow-md'
            : 'opacity-0 group-hover:opacity-100 bg-black/40 hover:bg-blue-400/80 text-white'
        }`}
        title="Recortar inicio (Trim In) — usa las flechas del teclado para ajustar"
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
          <span title="Transición activa" className="text-[9px] font-mono font-semibold px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 shrink-0">
            FADE
          </span>
        )}

        {clip.muted && <VolumeX size={11} className="text-rose-400 shrink-0 ml-1" />}

        {/* F3: the media of this clip is not available (B-14). */}
        {mediaUnavailable && (
          <span
            data-testid="clip-missing-badge"
            role="status"
            title={
              mediaMissing
                ? 'El archivo de este medio no está disponible: revínculalo en el panel de medios'
                : 'El archivo de este medio no se puede decodificar: revínculalo en el panel de medios'
            }
            className={`text-[9px] font-mono font-semibold px-1 py-0.5 rounded shrink-0 flex items-center gap-0.5 border ${
              mediaMissing
                ? 'bg-rose-950/90 text-rose-200 border-rose-600/70'
                : 'bg-amber-950/90 text-amber-200 border-amber-600/70'
            }`}
          >
            <AlertTriangle size={9} />
            {mediaMissing ? 'medio ausente' : 'error de medio'}
          </span>
        )}

        <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-auto font-medium">
          {formatDuration(clip.duration)}
        </span>
      </div>

      {/* Right Trim Handle (CapCut Style Pill with Expanded Touch Hitbox) */}
      <div
        onPointerDown={handleTrimEndMouseDown}
        onKeyDown={handleTrimEndKeyDown}
        role="slider"
        tabIndex={0}
        aria-label={`Recortar final de ${clip.name}`}
        aria-orientation="horizontal"
        aria-valuemin={Number(trimEndBounds.min.toFixed(3))}
        aria-valuemax={Number(trimEndBounds.max.toFixed(3))}
        aria-valuenow={Number((clip.start + clip.duration).toFixed(3))}
        aria-valuetext={formatDuration(clip.start + clip.duration)}
        className={`w-3.5 h-full cursor-ew-resize flex items-center justify-center shrink-0 z-20 touch-none select-none relative before:absolute before:-inset-x-3.5 before:inset-y-0 before:z-30 transition-all focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none ${
          showHandles
            ? 'opacity-100 bg-white text-dark-950 shadow-md'
            : 'opacity-0 group-hover:opacity-100 bg-black/40 hover:bg-blue-400/80 text-white'
        }`}
        title="Recortar final (Trim Out) — usa las flechas del teclado para ajustar"
      >
        <div className={`w-[2px] h-3.5 rounded-full ${isSelected ? 'bg-dark-900' : 'bg-white/80'}`} />
      </div>
    </div>
  );
};
