import React, { useRef } from 'react';
import { useProjectStore } from '../../store/useProjectStore';
import { masterClock } from '../../core/engine/MasterClock';
import { pixelsToTime } from '../../core/utils/time';

interface TimeRulerProps {
  scrollLeft: number;
}

export const TimeRuler: React.FC<TimeRulerProps> = () => {
  const duration = useProjectStore((s) => s.project.duration);
  const zoom = useProjectStore((s) => s.zoom);
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

  const totalWidth = Math.max(1200, duration * zoom + 300);
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

  const handleSeekFromClientX = (clientX: number) => {
    if (!rulerRef.current) return;
    const rect = rulerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const newTime = pixelsToTime(x, zoom);
    masterClock.seek(newTime);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handleSeekFromClientX(e.clientX);
    // Capture so scrubbing keeps working even if the pointer leaves the ruler
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore (already released / unsupported)
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      handleSeekFromClientX(moveEvent.clientX);
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  return (
    <div
      ref={rulerRef}
      data-testid="time-ruler"
      onPointerDown={handlePointerDown}
      style={{ width: `${totalWidth}px` }}
      className="relative h-7 bg-dark-900 border-b border-dark-800 cursor-pointer select-none text-[10px] font-mono text-slate-500 overflow-hidden touch-none"
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
