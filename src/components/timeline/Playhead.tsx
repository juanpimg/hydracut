import React, { useRef } from 'react';
import { useProjectStore } from '../../store/useProjectStore';
import { masterClock } from '../../core/engine/MasterClock';
import { pixelsToTime } from '../../core/utils/time';

interface PlayheadProps {
  timelineHeight: number;
}

export const Playhead: React.FC<PlayheadProps> = ({ timelineHeight }) => {
  const { currentTime, zoom } = useProjectStore();
  const playheadRef = useRef<HTMLDivElement>(null);

  const leftPosition = currentTime * zoom;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const startX = e.clientX;
    const initialTime = currentTime;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaTime = pixelsToTime(deltaX, zoom);
      masterClock.seek(initialTime + deltaTime);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  return (
    <div
      ref={playheadRef}
      style={{
        transform: `translateX(${leftPosition}px)`,
        height: `${timelineHeight}px`,
      }}
      className="absolute top-0 left-0 z-30 pointer-events-none will-change-transform"
    >
      {/* Triangular / Pill Head */}
      <div
        onMouseDown={handleMouseDown}
        className="relative -left-[7px] w-[15px] h-[18px] bg-red-500 rounded-b cursor-ew-resize pointer-events-auto flex items-center justify-center shadow-lg group hover:bg-red-400 transition"
      >
        <div className="w-[1px] h-[8px] bg-white/70" />
      </div>

      {/* Vertical Needle Line */}
      <div className="w-[1.5px] h-full bg-red-500 shadow-sm pointer-events-none -left-[0.5px] relative" />
    </div>
  );
};
