import React, { useRef, useEffect, useMemo } from 'react';
import { Film, Music, Type, VolumeX, AlertTriangle, Copy, ClipboardPaste, CopyPlus } from 'lucide-react';
import { Clip } from '../../types/project';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import { formatDuration, pixelsToTime } from '../../core/utils/time';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';

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
 * F6 · Duration of the long press that toggles a clip on touch (the
 * equivalent of Ctrl + clic, which does not exist on a phone).
 */
export const LONG_PRESS_MS = 500;

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

/**
 * Resolves which clip ids a per-clip action (copy / duplicate) applies to.
 * Contract: when the clicked clip is part of the current multi-selection,
 * the action covers the WHOLE selection (same as the Ctrl+C / Ctrl+D
 * keyboard shortcuts); otherwise it covers only the clicked clip. Always
 * returns a fresh array so callers cannot mutate the store state.
 */
export function resolveActionScopeIds(clipId: string, selectedClipIds: string[]): string[] {
  if (selectedClipIds.includes(clipId)) return [...selectedClipIds];
  return [clipId];
}

export const ClipItem: React.FC<ClipItemProps> = ({ clip }) => {
  const zoom = useProjectStore((s) => s.zoom);
  const fps = useProjectStore((s) => s.project.fps);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const selectedClipIds = useProjectStore((s) => s.selectedClipIds);
  const selectClip = useProjectStore((s) => s.selectClip);
  const moveClip = useProjectStore((s) => s.moveClip);
  const commitClipChange = useProjectStore((s) => s.commitClipChange);
  const beginClipGesture = useProjectStore((s) => s.beginClipGesture);
  const trimClipStart = useProjectStore((s) => s.trimClipStart);
  const trimClipEnd = useProjectStore((s) => s.trimClipEnd);
  const splitClip = useProjectStore((s) => s.splitClip);
  const setSnappingGuideTime = useProjectStore((s) => s.setSnappingGuideTime);
  const mediaPool = useProjectStore((s) => s.project.mediaPool);
  // F7: the internal clipboard (copy / paste / duplicate).
  const copyClips = useProjectStore((s) => s.copyClips);
  const pasteClips = useProjectStore((s) => s.pasteClips);
  const duplicateClips = useProjectStore((s) => s.duplicateClips);
  const hasClipboard = useProjectStore((s) => s.clipboard.length > 0);

  const { activeTool } = useUIStore();
  const clipRef = useRef<HTMLDivElement>(null);
  /** Abort controller of the pointer gesture in progress (if any). */
  const gestureRef = useRef<AbortController | null>(null);
  /** True while a gesture is in progress (used by the unmount cleanup). */
  const gestureActiveRef = useRef(false);
  /** Track lane geometry captured at the beginning of a drag. */
  const laneRectsRef = useRef<TrackLaneRect[]>([]);
  /**
   * F6 · True when the last gesture was a DRAG: the `click` event that comes
   * after it must not collapse a multi-selection.
   */
  const dragMovedRef = useRef(false);
  /** F6 · Timer of the long press (the touch equivalent of Ctrl + clic). */
  const longPressTimerRef = useRef<number | null>(null);
  /** F6 · True when the long press already fired (the drag is cancelled). */
  const longPressFiredRef = useRef(false);
  /** F6 · Pointer type of the last gesture (touch must not open the menu). */
  const lastPointerTypeRef = useRef<string>('mouse');

  const isTrackLocked =
    useProjectStore((s) => s.project.tracks.find((t) => t.id === clip.trackId)?.isLocked) ??
    false;

  /**
   * F6 · The PRIMARY selection (the first clip of the selection).
   */
  const isSelected = selectedClipId === clip.id;
  /**
   * F6 · The clip belongs to the selection (it may not be the primary one).
   */
  const isInSelection = selectedClipIds.includes(clip.id);
  const leftPx = clip.start * zoom;
  // Minimum 28px so both trim handles (14px each) never overlap on tiny clips
  const widthPx = Math.max(28, clip.duration * zoom);
  const showHandles = isInSelection || widthPx < 40 || zoom > 80;
  /**
   * F7: la fila de portapapeles necesita ~240 px para las tres etiquetas en
   * español (botones de 28 px + texto). En un clip más estrecho solo se
   * muestran los iconos (el `title` / `aria-label` conserva el nombre en
   * español en todos los casos); la pastilla recorta lo que no quepa.
   */
  const showClipboardLabels = widthPx >= 250;

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

    // F6: the gesture ended with a DRAG: the click must not collapse the
    // selection (the user was moving the clip, not selecting it).
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      return;
    }

    // F6: the LONG PRESS already toggled the clip: the click that follows it
    // must not collapse the selection.
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }

    // If split tool is active, split here
    if (activeTool === 'split') {
      if (!clipRef.current) return;
      const rect = clipRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const offsetSeconds = Math.max(0, pixelsToTime(clickX, zoom));
      splitClip(clip.id, clip.start + offsetSeconds);
      return;
    }

    // Otherwise select the clip (the Inspector is a permanent right
    // panel: no tab needs opening).
    // F6: Ctrl/Cmd + clic toggles the clip inside the selection and
    // Shift + clic selects the range between the primary selection and it.
    const additive = e.ctrlKey || e.metaKey;
    const range = e.shiftKey;
    selectClip(clip.id, { additive, range });
  };

  // Unmount safety net: the window listeners of a gesture in progress are
  // removed and the gesture is closed (otherwise the store would keep the
  // "gesture pending" flag and the next gesture would not push history).
  useEffect(() => {
    return () => {
      gestureRef.current?.abort();
      gestureRef.current = null;
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
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

    // F6: a modifier click (Ctrl/Cmd/Shift) must NOT change the selection
    // here: the `click` event is the one that knows the intent (additive /
    // range). The pointerdown would destroy the multi-selection.
    const hasModifier = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!hasModifier) {
      // The clip is already selected: the selection is kept as it is (a drag
      // must never collapse a multi-selection).
      const state = useProjectStore.getState();
      if (!state.selectedClipIds.includes(clip.id)) {
        selectClip(clip.id);
      }
    }
    dragMovedRef.current = false;
    longPressFiredRef.current = false;
    lastPointerTypeRef.current = e.pointerType;

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

    // F6: on touch there is no Ctrl key: a LONG PRESS is the equivalent of
    // Ctrl + clic (it toggles the clip in/out of the selection).
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        longPressFiredRef.current = true;
        // The long press TOGGLES the clip and cancels the drag gesture.
        endGesture(controller);
        selectClip(clip.id, { additive: true });
      }, LONG_PRESS_MS);
    }

    const onMove = (moveEvent: PointerEvent) => {
      // The long press already took the gesture: the clip must not move.
      if (longPressFiredRef.current) return;

      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      // Small threshold to distinguish clicks from intentional drags
      if (!hasMoved && Math.hypot(deltaX, deltaY) < 4) {
        return;
      }

      if (!hasMoved) {
        hasMoved = true;
        dragMovedRef.current = true;
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
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
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
    // F6: a trim must never collapse a multi-selection: the clip is only
    // selected when it is not part of the selection yet.
    if (!useProjectStore.getState().selectedClipIds.includes(clip.id)) {
      selectClip(clip.id);
    }
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
    // F6: a trim must never collapse a multi-selection.
    if (!useProjectStore.getState().selectedClipIds.includes(clip.id)) {
      selectClip(clip.id);
    }
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

  /**
   * F6 · The border of the clip depends on the selection state.
   *
   * F3 · La selección es un contorno claro (precedente FCP/Resolve), no un
   * resplandor de color: el primario lleva contorno blanco y el resto de la
   * selección un contorno tenue.
   *
   * - PRIMARY selection → a strong outline + the highest z-index;
   * - selected (not primary) → a thinner outline: the clip is part of the
   *   selection but it is not the clip the Inspector is editing;
   * - not selected → the normal border of the clip type.
   */
  const getSelectionBorder = (idleBorder: string): string => {
    if (isSelected) return 'border-white ring-1 ring-white z-20';
    if (isInSelection) return 'border-white/60 z-20';
    return idleBorder;
  };

  const getStyleTheme = () => {
    switch (clip.type) {
      case 'video':
        return {
          bg: 'bg-panel/95',
          border: getSelectionBorder('border-clip-video/50 hover:border-clip-video'),
          icon: <Film size={12} className="text-text-2 shrink-0" />,
        };
      case 'audio':
        return {
          bg: 'bg-panel/95',
          border: getSelectionBorder('border-clip-audio/50 hover:border-clip-audio'),
          icon: <Music size={12} className="text-text-2 shrink-0" />,
        };
      case 'text':
        return {
          bg: 'bg-panel/95',
          border: getSelectionBorder('border-clip-text/50 hover:border-clip-text'),
          icon: <Type size={12} className="text-text-2 shrink-0" />,
        };
      default:
        return {
          bg: 'bg-panel/95',
          border: getSelectionBorder('border-border hover:border-text-3'),
          icon: <Film size={12} className="text-text-2 shrink-0" />,
        };
    }
  };

  const theme = getStyleTheme();

  // F3: a clip without a usable media gets a warning border: it must not
  // look like a normal clip when it renders black and silent.
  // (danger/warning are real semantics here: missing vs undecodable media.)
  const themeBorder = mediaUnavailable
    ? 'border-danger/70 bg-danger/15'
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
      // F6 · ARIA: the clip is a TOGGLE BUTTON (`aria-pressed`), not a
      // `role="button"` with `aria-selected` (which is only valid for the
      // `option` / `row` / `tab` roles). The clips do not live in a single
      // listbox (they belong to independent track lanes), so the listbox /
      // option pattern would be a lie.
      aria-pressed={isInSelection}
      aria-label={`Clip ${clip.name}, duración ${formatDuration(clip.duration)}${
        isInSelection ? ', seleccionado' : ''
      }`}
      data-clip-id={clip.id}
      data-selected={isInSelection ? 'true' : 'false'}
      data-primary={isSelected ? 'true' : 'false'}
      onClick={handleClick}
      onPointerDown={handleBodyMouseDown}
      onContextMenu={(e) => {
        // F6: on touch the long press is the multi-selection gesture, NOT the
        // context menu of the browser.
        if (lastPointerTypeRef.current === 'touch') e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          // F6: the keyboard honours the same modifiers as the mouse.
          selectClip(clip.id, {
            additive: e.ctrlKey || e.metaKey,
            range: e.shiftKey,
          });
        }
      }}
      style={{
        left: `${leftPx}px`,
        width: `${widthPx}px`,
      }}
      className={`absolute top-1 bottom-1 rounded-md border ${themeBorder} ${theme.bg} flex items-center justify-between ${isInSelection ? 'overflow-visible' : 'overflow-hidden'} cursor-grab active:cursor-grabbing select-none transition-shadow z-10 touch-none group focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none`}
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
          className={`absolute top-0 bottom-0 left-0 pointer-events-none border-r border-white/25 z-10 flex items-start p-1 ${
            fadeInType === 'fade-white'
              ? 'bg-white/40'
              : 'bg-black/70'
          }`}
          title={`Fundido de entrada: ${fadeInType} (${fadeInDuration.toFixed(1).replace('.', ',')} s)`}
        >
          <span
            className="text-[8px] font-mono px-0.5 rounded leading-tight text-text-1 bg-panel/80"
          >
            ▲ Entrada
          </span>
        </div>
      )}

      {/* Transition Fade Out Overlay & Indicator */}
      {hasFadeOut && (
        <div
          data-testid="fade-out-indicator"
          style={{ width: `${fadeOutWidthPx}px` }}
          className={`absolute top-0 bottom-0 right-0 pointer-events-none border-l border-white/25 z-10 flex items-start justify-end p-1 ${
            fadeOutType === 'fade-white'
              ? 'bg-white/40'
              : 'bg-black/70'
          }`}
          title={`Fundido de salida: ${fadeOutType} (${fadeOutDuration.toFixed(1).replace('.', ',')} s)`}
        >
          <span
            className="text-[8px] font-mono px-0.5 rounded leading-tight text-text-1 bg-panel/80"
          >
            ▼ Salida
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
        className={`w-3.5 h-full cursor-ew-resize flex items-center justify-center shrink-0 z-20 touch-none select-none relative before:absolute before:-inset-x-3.5 before:inset-y-0 before:z-30 transition-all focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
          showHandles
            ? 'opacity-100 bg-white text-app shadow-md'
            : 'opacity-0 group-hover:opacity-100 bg-black/40 hover:bg-white/70 text-white'
        }`}
        title="Recortar inicio: usa las flechas del teclado para ajustar"
      >
        <div className={`w-[2px] h-3.5 rounded-sm ${isInSelection ? 'bg-app' : 'bg-white/80'}`} />
      </div>

      {/* Clip Content Label & Badges */}
      <div className="flex-1 px-2 flex items-center gap-1.5 min-w-0 overflow-hidden pointer-events-none z-10">
        {theme.icon}
        <span className="text-xs font-semibold text-text-1 truncate">
          {clip.name}
        </span>

        {/* Speed indicator */}
        {clip.speed && clip.speed !== 1 && (
          <Badge variant="neutral">
            <span className="font-mono font-bold">{clip.speed}x</span>
          </Badge>
        )}

        {/* Transition active indicator */}
        {(hasFadeIn || hasFadeOut) && (
          <span title="Fundido activo" className="shrink-0">
            <Badge variant="neutral">Fundido</Badge>
          </span>
        )}

        {clip.muted && <VolumeX size={11} className="text-text-2 shrink-0 ml-1" />}

        {/* F3: the media of this clip is not available (B-14). */}
        {mediaUnavailable && (
          <span
            data-testid="clip-missing-badge"
            role="status"
            title={
              mediaMissing
                ? 'Este medio no está disponible: revínculalo desde Medios'
                : 'Este medio no se puede decodificar: revínculalo desde Medios'
            }
            className={`text-[9px] font-mono font-semibold px-1 py-0.5 rounded shrink-0 flex items-center gap-0.5 border ${
              mediaMissing
                ? 'bg-danger/15 text-danger border-danger/60'
                : 'bg-warning/15 text-warning border-warning/60'
            }`}
          >
            <AlertTriangle size={9} />
            {mediaMissing ? 'medio ausente' : 'error de medio'}
          </span>
        )}

        <span className="text-[10px] font-mono text-text-2 shrink-0 ml-auto font-medium">
          {formatDuration(clip.duration)}
        </span>
      </div>

      {/* F7: acciones de portapapeles del clip (copiar / pegar / duplicar).
          Fila de 28 px DENTRO del clip (`inset-x-1`, nunca centrada flotando
          fuera): la pastilla recorta (`max-w-full` + `overflow-hidden`) lo que
          no quepa en un clip corto en vez de derramarse por los bordes. Con
          sitio (≥ 250 px) muestra las etiquetas en español que exige la
          suite («Copiar»/«Pegar»/«Duplicar» exactos); sin sitio, solo iconos.
          Se revela al seleccionar, al hover o al entrar por teclado
          (`focus-within`); oculta queda fuera del orden de tabulación. */}
      {(() => {
        // La fila cubre TODA la selección cuando el clip forma parte de
        // ella (igual que Ctrl+C / Ctrl+D); si no, solo este clip.
        const scopeIds = resolveActionScopeIds(clip.id, selectedClipIds);
        const scopeCount = scopeIds.length;
        const copyScopeLabel =
          scopeCount > 1 ? `Copiar ${scopeCount} clips` : `Copiar ${clip.name}`;
        const duplicateScopeLabel =
          scopeCount > 1 ? `Duplicar ${scopeCount} clips` : `Duplicar ${clip.name}`;
        return (
        <div
          data-testid="clip-clipboard-actions"
          role="group"
          aria-label="Acciones de portapapeles del clip"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className={`absolute inset-x-1 bottom-0.5 z-30 ${
            isSelected ? 'flex' : 'hidden group-focus-within:flex group-hover:flex'
          } ${showClipboardLabels ? 'justify-center' : 'justify-start'}`}
        >
          <div className="flex max-w-full items-center gap-0.5 overflow-hidden rounded border border-border bg-app/95 px-0.5 py-0.5">
            {showClipboardLabels ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  title={copyScopeLabel}
                  aria-label={copyScopeLabel}
                  data-testid="clip-copy-button"
                  onClick={() => copyClips(resolveActionScopeIds(clip.id, selectedClipIds))}
                  >
                  <Copy size={12} className="shrink-0" aria-hidden="true" />
                  Copiar
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  title="Pegar"
                  aria-label="Pegar"
                  data-testid="clip-paste-button"
                  disabled={!hasClipboard}
                  onClick={() => pasteClips(clip.trackId)}
                  >
                  <ClipboardPaste size={12} className="shrink-0" aria-hidden="true" />
                  Pegar
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  title={duplicateScopeLabel}
                  aria-label={duplicateScopeLabel}
                  data-testid="clip-duplicate-button"
                  onClick={() => duplicateClips(resolveActionScopeIds(clip.id, selectedClipIds))}
                  >
                  <CopyPlus size={12} className="shrink-0" aria-hidden="true" />
                  Duplicar
                </Button>
              </>
            ) : (
              <>
                <IconButton
                  size="sm"
                  title={copyScopeLabel}
                  aria-label={copyScopeLabel}
                  data-testid="clip-copy-button"
                  onClick={() => copyClips(resolveActionScopeIds(clip.id, selectedClipIds))}
                >
                  <Copy size={12} aria-hidden="true" />
                </IconButton>
                <IconButton
                  size="sm"
                  title="Pegar"
                  aria-label="Pegar"
                  data-testid="clip-paste-button"
                  disabled={!hasClipboard}
                  onClick={() => pasteClips(clip.trackId)}
                >
                  <ClipboardPaste size={12} aria-hidden="true" />
                </IconButton>
                <IconButton
                  size="sm"
                  title={duplicateScopeLabel}
                  aria-label={duplicateScopeLabel}
                  data-testid="clip-duplicate-button"
                  onClick={() => duplicateClips(resolveActionScopeIds(clip.id, selectedClipIds))}
                >
                  <CopyPlus size={12} aria-hidden="true" />
                </IconButton>
              </>
            )}
          </div>
        </div>
        );
      })()}

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
        className={`w-3.5 h-full cursor-ew-resize flex items-center justify-center shrink-0 z-20 touch-none select-none relative before:absolute before:-inset-x-3.5 before:inset-y-0 before:z-30 transition-all focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
          showHandles
            ? 'opacity-100 bg-white text-app shadow-md'
            : 'opacity-0 group-hover:opacity-100 bg-black/40 hover:bg-white/70 text-white'
        }`}
        title="Recortar final: usa las flechas del teclado para ajustar"
      >
        <div className={`w-[2px] h-3.5 rounded-sm ${isInSelection ? 'bg-app' : 'bg-white/80'}`} />
      </div>
    </div>
  );
};
