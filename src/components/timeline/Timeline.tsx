import React, { useRef, useEffect } from 'react';
import { useProjectStore } from '../../store/useProjectStore';
import { TimelineToolbar } from './TimelineToolbar';
import { TimeRuler } from './TimeRuler';
import { TrackHeader } from './TrackHeader';
import { TrackLane } from './TrackLane';
import { Playhead } from './Playhead';

export const Timeline: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  const zoom = useProjectStore((s) => s.zoom);
  const setZoom = useProjectStore((s) => s.setZoom);
  const selectClip = useProjectStore((s) => s.selectClip);
  const snappingGuideTime = useProjectStore((s) => s.snappingGuideTime);

  const lanesContainerRef = useRef<HTMLDivElement>(null);
  const headersContainerRef = useRef<HTMLDivElement>(null);

  /**
   * UI-11: the ruler and the lanes must share **exactly** the same width.
   * The previous formulas differed (`max(1400, d*z+400)` vs `max(1200, d*z+300)`),
   * so the ruler always stopped 100–200 px before the tracks did.
   * This value matches the one used by `TimeRuler`.
   */
  const totalWidth = Math.max(1200, project.duration * zoom + 300);
  const timelineTracksHeight = project.tracks.length * 56; // 56px per track
  const totalTimelineHeight = timelineTracksHeight + 28; // plus ruler height

  /**
   * UI-09/UI-10: the track list scrolls vertically and the track headers stay
   * in sync with it. The scroll offset is applied imperatively (no React state)
   * so that scrolling does not re-render the whole timeline.
   */
  const handleLanesScroll = () => {
    const lanes = lanesContainerRef.current;
    const headers = headersContainerRef.current;
    if (!lanes || !headers) return;
    if (Math.abs(headers.scrollTop - lanes.scrollTop) > 0.5) {
      headers.scrollTop = lanes.scrollTop;
    }
  };

  const handleHeadersScroll = () => {
    const lanes = lanesContainerRef.current;
    const headers = headersContainerRef.current;
    if (!lanes || !headers) return;
    if (Math.abs(lanes.scrollTop - headers.scrollTop) > 0.5) {
      lanes.scrollTop = headers.scrollTop;
    }
  };

  // Cursor-Anchored Wheel Zoom (Ctrl + Wheel) with non-passive event listener
  useEffect(() => {
    const container = lanesContainerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const mouseXInContainer = e.clientX - rect.left;
        const currentScrollLeft = container.scrollLeft;
        const currentZoom = useProjectStore.getState().zoom;
        const mouseTime = (mouseXInContainer + currentScrollLeft) / currentZoom;

        const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
        const newZoom = Math.max(10, Math.min(250, currentZoom * zoomFactor));
        setZoom(newZoom);

        const newScrollLeft = Math.max(0, mouseTime * newZoom - mouseXInContainer);
        container.scrollLeft = newScrollLeft;
      } else if (e.deltaX === 0 && e.deltaY !== 0) {
        // UI-20: a plain wheel must NOT be hijacked. The vertical wheel scrolls
        // the track list; only a wheel over the ruler is turned into a
        // horizontal scroll (that is where the user expects to scrub in time).
        const target = e.target as HTMLElement | null;
        const overRuler = typeof target?.closest === 'function'
          ? target.closest('[data-testid="time-ruler"]')
          : null;
        if (overRuler) {
          e.preventDefault();
          container.scrollLeft += e.deltaY;
        }
      }
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', onWheel);
    };
  }, [setZoom]);

  // Two-finger pinch-to-zoom on touch screens
  useEffect(() => {
    const container = lanesContainerRef.current;
    if (!container) return;

    const activePointers = new Map<number, { x: number; y: number }>();
    let initialDistance = 0;
    let initialZoom = 1;

    const onPointerDown = (e: PointerEvent) => {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size === 2) {
        const [p1, p2] = Array.from(activePointers.values());
        initialDistance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        initialZoom = useProjectStore.getState().zoom;
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 2 && initialDistance > 0) {
        const [p1, p2] = Array.from(activePointers.values());
        const currentDistance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const scale = currentDistance / initialDistance;
        const newZoom = Math.max(10, Math.min(250, initialZoom * scale));
        setZoom(newZoom);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) {
        initialDistance = 0;
      }
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerUp);

    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerUp);
    };
  }, [setZoom]);

  const handleFitToScreen = () => {
    const container = lanesContainerRef.current;
    if (!container) return;
    const availableWidth = container.clientWidth - 80;
    const maxClipTime = project.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);
    const targetDuration = Math.max(5, maxClipTime || project.duration);
    const targetZoom = Math.max(10, Math.min(200, availableWidth / targetDuration));
    setZoom(targetZoom);
    container.scrollLeft = 0;
  };

  return (
    <div className="flex flex-col h-full w-full max-w-full min-w-0 bg-dark-950 border-t border-dark-800 select-none z-10 overflow-hidden">
      {/* Top Toolbar */}
      <TimelineToolbar onFitToScreen={handleFitToScreen} />

      {/* Main Timeline Workspace */}
      <div className="flex-1 flex w-full max-w-full min-w-0 overflow-hidden">
        {/* Left Column: Track Headers */}
        <div className="w-28 min-[400px]:w-36 sm:w-40 md:w-48 lg:w-56 bg-dark-900 border-r border-dark-800 flex flex-col shrink-0 z-20 overflow-hidden">
          {/* Header spacer aligned with ruler */}
          <div className="h-7 shrink-0 bg-dark-900 border-b border-dark-800 px-2 sm:px-3 flex items-center justify-between text-[10px] uppercase font-bold tracking-wider text-slate-500">
            <span>Pistas</span>
            <span className="text-[9px] font-mono font-medium text-slate-400 bg-dark-800 px-1.5 py-0.5 rounded">
              {project.tracks.length}
            </span>
          </div>

          {/* Track Headers List — scrolls vertically in sync with the lanes */}
          <div
            ref={headersContainerRef}
            onScroll={handleHeadersScroll}
            className="flex-1 overflow-y-auto overflow-x-hidden no-scrollbar"
          >
            {project.tracks.map((track, idx) => (
              <TrackHeader key={track.id} track={track} index={idx} />
            ))}
          </div>
        </div>

        {/* Right Area: Scrollable Tracks & Ruler */}
        <div
          ref={lanesContainerRef}
          onScroll={handleLanesScroll}
          onClick={() => selectClip(null)}
          className="flex-1 overflow-auto relative bg-dark-950/80 min-w-0"
        >
          {/*
            Time Ruler — `sticky top-0` keeps it pinned to the top of the
            scrollport while the tracks scroll vertically, and it scrolls
            horizontally with the lanes (one single scroll source, no JS).
            `scrollLeft` stays 0 on purpose: the ruler is already translated by
            the native scroll of the container.
          */}
          <div
            className="sticky top-0 z-20 h-7 bg-dark-900 border-b border-dark-800 [&>div]:!w-full"
            style={{ width: `${totalWidth}px` }}
          >
            <TimeRuler scrollLeft={0} />
          </div>

          {/* Track Lanes */}
          <div style={{ width: `${totalWidth}px` }} className="relative">
            {project.tracks.map((track) => (
              <TrackLane key={track.id} track={track} width={totalWidth} />
            ))}
          </div>

          {/* Draggable Playhead */}
          <Playhead timelineHeight={totalTimelineHeight} />

          {/* Vertical Snapping Guide Line */}
          {snappingGuideTime !== null && (
            <div
              data-testid="snapping-guide-line"
              style={{
                left: `${snappingGuideTime * zoom}px`,
                height: `${totalTimelineHeight}px`,
              }}
              className="absolute top-0 w-[2px] bg-yellow-400 shadow-[0_0_8px_#facc15] z-30 pointer-events-none"
            >
              <div className="absolute top-6 -left-1 w-2.5 h-2.5 bg-yellow-400 rotate-45 shadow" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
