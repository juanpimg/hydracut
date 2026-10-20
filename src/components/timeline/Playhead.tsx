import React, { useRef, useEffect } from 'react';
import { useProjectStore } from '../../store/useProjectStore';
import { masterClock } from '../../core/engine/MasterClock';
import { pixelsToTime } from '../../core/utils/time';

interface PlayheadProps {
  timelineHeight: number;
}

export const Playhead: React.FC<PlayheadProps> = ({ timelineHeight }) => {
  const zoom = useProjectStore((s) => s.zoom);
  const playheadRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** Abort controller of the drag gesture in progress (if any). */
  const gestureRef = useRef<AbortController | null>(null);

  // Direct 60 FPS update via MasterClock subscription: ZERO React re-renders
  useEffect(() => {
    // Initial sync
    const initialTime = masterClock.getTime();
    if (playheadRef.current) {
      playheadRef.current.style.transform = `translateX(${initialTime * zoom}px)`;
    }

    const unsub = masterClock.subscribeTime((t) => {
      if (playheadRef.current) {
        playheadRef.current.style.transform = `translateX(${t * zoomRef.current}px)`;
      }
    });

    return unsub;
  }, [zoom]);

  // Unmount safety net: a drag in progress must not leave window listeners
  // behind (they would keep seeking on a dead playhead).
  useEffect(() => {
    return () => {
      gestureRef.current?.abort();
      gestureRef.current = null;
    };
  }, []);

  const handleDragStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const startX = e.clientX;
    const initialTime = masterClock.getTime();

    // Pointer events only: pointermove/pointerup already cover mouse, touch
    // and pen. Registering mousemove *and* pointermove used to seek twice per
    // event.
    gestureRef.current?.abort();
    const controller = new AbortController();
    gestureRef.current = controller;
    const { signal } = controller;

    const onMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaTime = pixelsToTime(deltaX, zoomRef.current);
      const newTime = Math.max(0, initialTime + deltaTime);
      masterClock.seek(newTime);
      useProjectStore.getState().setCurrentTime(newTime);
    };

    const onUp = () => {
      controller.abort();
      if (gestureRef.current === controller) gestureRef.current = null;
    };

    window.addEventListener('pointermove', onMove, { signal });
    window.addEventListener('pointerup', onUp, { signal });
    window.addEventListener('pointercancel', onUp, { signal });
  };

  return (
    <div
      ref={playheadRef}
      data-testid="playhead"
      title="Cabezal de reproducción"
      style={{
        transform: `translateX(${masterClock.getTime() * zoom}px)`,
        height: `${timelineHeight}px`,
      }}
      className="absolute top-0 left-0 z-30 pointer-events-none will-change-transform"
    >
      {/* F4 · Cabezal de 1 px en el acento con un mango pequeño (sin segundo acento ni brillos). */}
      <div
        onPointerDown={handleDragStart}
        className="relative -left-[5px] w-[11px] h-[14px] bg-accent rounded-b-sm cursor-ew-resize pointer-events-auto flex items-start justify-center touch-none select-none before:absolute before:-inset-2 before:z-30"
      >
        <div className="mt-[3px] w-px h-[8px] bg-panel" />
      </div>

      {/* Vertical Needle Line */}
      <div className="w-px h-full bg-accent pointer-events-none relative" />
    </div>
  );
};
