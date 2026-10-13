import React, { useRef, useState, useEffect } from 'react';
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
  const [scrollLeft, setScrollLeft] = useState(0);

  const lanesContainerRef = useRef<HTMLDivElement>(null);

  const totalWidth = Math.max(1400, project.duration * zoom + 400);
  const timelineTracksHeight = project.tracks.length * 56; // 56px per track
  const totalTimelineHeight = timelineTracksHeight + 28; // plus ruler height

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollLeft(e.currentTarget.scrollLeft);
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
        setScrollLeft(newScrollLeft);
      } else if (e.deltaX === 0 && e.deltaY !== 0) {
        container.scrollLeft += e.deltaY;
        setScrollLeft(container.scrollLeft);
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
    setScrollLeft(0);
  };

  return (
    <div className="flex flex-col h-full w-full max-w-full min-w-0 bg-dark-950 border-t border-dark-800 select-none z-10 overflow-hidden">
      {/* Top Toolbar */}
      <TimelineToolbar onFitToScreen={handleFitToScreen} />

      {/* Main Timeline Workspace */}
      <div className="flex-1 flex w-full max-w-full min-w-0 overflow-hidden">
        {/* Left Column: Track Headers */}
        <div className="w-28 min-[400px]:w-36 sm:w-40 md:w-48 lg:w-56 bg-dark-900 border-r border-dark-800 flex flex-col shrink-0 z-20">
          {/* Header spacer aligned with ruler */}
          <div className="h-7 bg-dark-900 border-b border-dark-800 px-2 sm:px-3 flex items-center justify-between text-[10px] uppercase font-bold tracking-wider text-slate-500">
            <span>Pistas</span>
            <span className="text-[9px] font-mono font-medium text-slate-400 bg-dark-800 px-1.5 py-0.5 rounded">
              {project.tracks.length}
            </span>
          </div>

          {/* Track Headers List */}
          <div className="flex-1 overflow-hidden">
            {project.tracks.map((track, idx) => (
              <TrackHeader key={track.id} track={track} index={idx} />
            ))}
          </div>
        </div>

        {/* Right Area: Scrollable Tracks & Ruler */}
        <div
          ref={lanesContainerRef}
          onScroll={handleScroll}
          onClick={() => selectClip(null)}
          className="flex-1 overflow-x-auto overflow-y-hidden relative bg-dark-950/80 min-w-0"
        >
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

          {/* Time Ruler */}
          <TimeRuler scrollLeft={scrollLeft} />

          {/* Track Lanes */}
          <div style={{ width: `${totalWidth}px` }} className="relative">
            {project.tracks.map((track) => (
              <TrackLane key={track.id} track={track} width={totalWidth} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
