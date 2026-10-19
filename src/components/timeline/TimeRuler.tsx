import React, { useRef, useEffect, useMemo, useState } from 'react';
import { useProjectStore } from '../../store/useProjectStore';
import { masterClock } from '../../core/engine/MasterClock';
import { pixelsToTime } from '../../core/utils/time';

interface TimeRulerProps {
  scrollLeft: number;
}

export interface RulerTick {
  /** Absolute time of the tick, in seconds. */
  time: number;
  isMajor: boolean;
  label?: string;
  /** Stable identity of the tick inside the current step sequence. */
  index: number;
}

export interface RulerScale {
  /** Seconds between two labelled ticks. */
  majorInterval: number;
  /** Number of minor ticks per major interval. */
  minorTicks: number;
}

/**
 * Tick density of the ruler for a given zoom level (pixels per second).
 */
export function getRulerScale(zoom: number): RulerScale {
  if (zoom >= 100) return { majorInterval: 1, minorTicks: 4 };
  if (zoom >= 50) return { majorInterval: 2, minorTicks: 4 };
  if (zoom < 25) return { majorInterval: 10, minorTicks: 5 };
  return { majorInterval: 5, minorTicks: 5 };
}

/**
 * Generates the ticks of a step sequence in the [startIndex, endIndex] range.
 * `step` is always exactly representable in binary floating point
 * (1, 0.5, 0.25 or 2), so `index * step` matches the previous accumulation
 * bit for bit: the ruler stays visually identical.
 */
export function generateRulerTicks(
  startIndex: number,
  endIndex: number,
  step: number,
  majorInterval: number
): RulerTick[] {
  const ticks: RulerTick[] = [];
  for (let i = Math.max(0, startIndex); i <= endIndex; i++) {
    const time = i * step;
    const isMajor = Math.abs(time % majorInterval) < 0.001;
    let label: string | undefined;
    if (isMajor) {
      const m = Math.floor(time / 60);
      const sec = Math.floor(time % 60);
      label = `${m}:${sec.toString().padStart(2, '0')}`;
    }
    ticks.push({ time, isMajor, label, index: i });
  }
  return ticks;
}

/**
 * Computes the range of ticks that intersects the visible window of the
 * ruler (plus a small overscan so the edges do not pop).
 */
export function getRulerTickWindow(params: {
  zoom: number;
  scrollLeft: number;
  viewportWidth: number;
  totalWidth: number;
  step: number;
  overscanPx?: number;
}): { startIndex: number; endIndex: number } {
  const { zoom, scrollLeft, viewportWidth, totalWidth, step } = params;
  const overscan = params.overscanPx ?? 240;

  const startPx = Math.max(0, scrollLeft - overscan);
  const endPx = Math.min(totalWidth, scrollLeft + Math.max(0, viewportWidth) + overscan);

  const startTime = startPx / zoom;
  const endTime = endPx / zoom;

  const startIndex = Math.max(0, Math.floor(startTime / step) - 1);
  const endIndex = Math.ceil(endTime / step) + 2;
  return { startIndex, endIndex };
}

export const TimeRuler: React.FC<TimeRulerProps> = ({ scrollLeft }) => {
  const duration = useProjectStore((s) => s.project.duration);
  const zoom = useProjectStore((s) => s.zoom);
  const rulerRef = useRef<HTMLDivElement>(null);
  /** Abort controller of the scrub gesture in progress (if any). */
  const gestureRef = useRef<AbortController | null>(null);
  /** Scrollport that hosts the ruler (the timeline lanes container). */
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  /** `scrollLeft` prop kept as a fallback when no scrollport can be found. */
  const scrollLeftPropRef = useRef(scrollLeft);
  scrollLeftPropRef.current = scrollLeft;

  // Visible window of the ruler: [scrollLeft, scrollLeft + width].
  const [viewport, setViewport] = useState({ scrollLeft: 0, width: 1200 });

  useEffect(() => {
    const ruler = rulerRef.current;
    if (!ruler) return;

    // The ruler lives inside the scrollport of the timeline. Finding it makes
    // the component independent from the scroll plumbing of its parent.
    let container: HTMLElement | null = ruler.parentElement;
    while (container) {
      const overflowX = getComputedStyle(container).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') break;
      container = container.parentElement;
    }

    if (!container) {
      // No scrollport: fall back to the prop + the window width.
      const update = () =>
        setViewport({ scrollLeft: scrollLeftPropRef.current, width: window.innerWidth });
      update();
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }

    scrollContainerRef.current = container;

    let frame = 0;
    const update = () => {
      setViewport({ scrollLeft: container.scrollLeft, width: container.clientWidth });
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };

    update();
    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', update);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update);
      observer.observe(container);
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', update);
      observer?.disconnect();
      scrollContainerRef.current = null;
    };
  }, []);

  // Fallback path: the prop is the only source of the scroll offset.
  useEffect(() => {
    if (scrollContainerRef.current) return;
    setViewport((prev) => (prev.scrollLeft === scrollLeft ? prev : { ...prev, scrollLeft }));
  }, [scrollLeft]);

  const scale = useMemo(() => getRulerScale(zoom), [zoom]);
  const step = scale.majorInterval / scale.minorTicks;

  const totalWidth = Math.max(1200, duration * zoom + 300);

  // Only the visible window is rendered: the ruler used to build up to 1510
  // React elements on every zoom change.
  const { startIndex, endIndex } = useMemo(
    () =>
      getRulerTickWindow({
        zoom,
        scrollLeft: viewport.scrollLeft,
        viewportWidth: viewport.width,
        totalWidth,
        step,
      }),
    [zoom, viewport.scrollLeft, viewport.width, totalWidth, step]
  );

  const ticks = useMemo(
    () => generateRulerTicks(startIndex, endIndex, step, scale.majorInterval),
    [startIndex, endIndex, step, scale.majorInterval]
  );

  const handleSeekFromClientX = (clientX: number, rectLeft: number) => {
    const x = clientX - rectLeft;
    const newTime = pixelsToTime(x, zoom);
    masterClock.seek(newTime);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const ruler = rulerRef.current;
    if (!ruler) return;
    // The ruler does not move while scrubbing: cache its origin so the
    // pointermove handler does not force a layout on every event.
    const rectLeft = ruler.getBoundingClientRect().left;
    handleSeekFromClientX(e.clientX, rectLeft);

    // Capture so scrubbing keeps working even if the pointer leaves the ruler
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore (already released / unsupported)
    }

    // Every gesture owns an AbortController: the listeners are removed on
    // pointerup AND when the component unmounts mid-scrub.
    gestureRef.current?.abort();
    const controller = new AbortController();
    gestureRef.current = controller;
    const { signal } = controller;

    const onPointerMove = (moveEvent: PointerEvent) => {
      handleSeekFromClientX(moveEvent.clientX, rectLeft);
    };

    const onPointerUp = () => {
      controller.abort();
      if (gestureRef.current === controller) gestureRef.current = null;
    };

    window.addEventListener('pointermove', onPointerMove, { signal });
    window.addEventListener('pointerup', onPointerUp, { signal });
    window.addEventListener('pointercancel', onPointerUp, { signal });
  };

  // Unmount safety net: a scrub in progress must not leave window listeners
  // behind.
  useEffect(() => {
    return () => {
      gestureRef.current?.abort();
      gestureRef.current = null;
    };
  }, []);

  return (
    <div
      ref={rulerRef}
      data-testid="time-ruler"
      onPointerDown={handlePointerDown}
      style={{ width: `${totalWidth}px` }}
      className="relative h-7 bg-dark-900 border-b border-dark-800 cursor-pointer select-none text-[10px] font-mono text-slate-500 overflow-hidden touch-none"
    >
      {ticks.map((tick) => {
        const left = tick.time * zoom;
        return (
          <div
            key={tick.index}
            style={{ left: `${left}px` }}
            className="absolute top-0 bottom-0 pointer-events-none flex flex-col justify-end"
          >
            {tick.isMajor ? (
              <>
                <span className="absolute top-1 left-1 font-semibold text-slate-400">
                  {tick.label}
                </span>
                <div className="w-[1px] h-3 bg-dark-600" />
              </>
            ) : (
              <div className="w-[1px] h-1.5 bg-dark-750" />
            )}
          </div>
        );
      })}
    </div>
  );
};
