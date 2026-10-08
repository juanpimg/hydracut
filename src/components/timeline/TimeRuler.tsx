import React, { useRef } from 'react';
import { useProjectStore } from '../../store/useProjectStore';
import { masterClock } from '../../core/engine/MasterClock';
import { pixelsToTime } from '../../core/utils/time';

interface TimeRulerProps {
  scrollLeft: number;
}

export const TimeRuler: React.FC<TimeRulerProps> = () => {
  const { project, zoom } = useProjectStore();
  const rulerRef = useRef<HTMLDivElement>(null);

  // Determine tick interval in seconds based on zoom level
  let majorInterval = 5; // seconds
  let minorTicks = 5;

  if (zoom >= 100) {
    majorInterval = 1;
    minorTicks = 4;
  } else if (zoom >= 50) {
    majorInterval = 2;
    minorTicks = 4;
  } else if (zoom < 25) {
    majorInterval = 10;
    minorTicks = 5;
  }

  const totalWidth = Math.max(1200, project.duration * zoom + 300);
  const totalSeconds = Math.ceil(totalWidth / zoom);

  const ticks: { time: number; isMajor: boolean; label?: string }[] = [];
  for (let s = 0; s <= totalSeconds; s += majorInterval / minorTicks) {
    const isMajor = Math.abs(s % majorInterval) < 0.001;
    let label = '';
    if (isMajor) {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      label = `${m}:${sec.toString().padStart(2, '0')}`;
    }
    ticks.push({ time: s, isMajor, label: isMajor ? label : undefined });
  }

  const handleSeek = (e: React.MouseEvent) => {
    if (!rulerRef.current) return;
    const rect = rulerRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const newTime = pixelsToTime(clickX, zoom);
    masterClock.seek(newTime);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    handleSeek(e);

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!rulerRef.current) return;
      const rect = rulerRef.current.getBoundingClientRect();
      const moveX = moveEvent.clientX - rect.left;
      const newTime = pixelsToTime(moveX, zoom);
      masterClock.seek(newTime);
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
      ref={rulerRef}
      data-testid="time-ruler"
      onMouseDown={handleMouseDown}
      style={{ width: `${totalWidth}px` }}
      className="relative h-7 bg-dark-900 border-b border-dark-800 cursor-pointer select-none text-[10px] font-mono text-slate-500 overflow-hidden"
    >
      {ticks.map((tick, idx) => {
        const left = tick.time * zoom;
        return (
          <div
            key={idx}
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
