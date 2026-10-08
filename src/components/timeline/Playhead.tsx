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

  const handleDragStart = (e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const startX = e.clientX;
    const initialTime = masterClock.getTime();

    const onMove = (moveEvent: MouseEvent | PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaTime = pixelsToTime(deltaX, zoomRef.current);
      const newTime = Math.max(0, initialTime + deltaTime);
      masterClock.seek(newTime);
      useProjectStore.getState().setCurrentTime(newTime);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      ref={playheadRef}
      style={{
        transform: `translateX(${masterClock.getTime() * zoom}px)`,
        height: `${timelineHeight}px`,
      }}
      className="absolute top-0 left-0 z-30 pointer-events-none will-change-transform"
    >
      {/* Triangular / Pill Head with Touch Hitbox */}
      <div
        onMouseDown={handleDragStart}
        onPointerDown={handleDragStart}
        className="relative -left-[7px] w-[15px] h-[18px] bg-red-500 rounded-b cursor-ew-resize pointer-events-auto flex items-center justify-center shadow-lg group hover:bg-red-400 touch-none transition select-none before:absolute before:-inset-2 before:z-30"
      >
        <div className="w-[1px] h-[8px] bg-white/70" />
      </div>

      {/* Vertical Needle Line */}
      <div className="w-[1.5px] h-full bg-red-500 shadow-sm pointer-events-none -left-[0.5px] relative" />
    </div>
  );
};
