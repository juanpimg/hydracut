import React, { useState, useRef, useEffect } from 'react';
import { 
  Play, 
  Pause, 
  SkipBack, 
  Volume2, 
  VolumeX 
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { masterClock } from '../../core/engine/MasterClock';
import { formatTimecode } from '../../core/utils/time';
import { audioEngine } from '../../core/engine/AudioEngine';
import { readMasterVolume, subscribeMasterVolume, writeMasterVolume } from '../../core/utils/masterVolume';

const TimecodeCurrentDisplay: React.FC<{ fps: number }> = ({ fps }) => {
  const spanRef = useRef<HTMLDivElement>(null);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;

  useEffect(() => {
    if (spanRef.current) {
      spanRef.current.textContent = formatTimecode(masterClock.getTime(), fps);
    }
    const unsub = masterClock.subscribeTime((t) => {
      if (spanRef.current) {
        spanRef.current.textContent = formatTimecode(t, fpsRef.current);
      }
    });
    return unsub;
  }, [fps]);

  return (
    <div
      ref={spanRef}
      className="font-mono text-sm font-semibold tracking-wider bg-dark-950 px-2.5 py-1 rounded border border-dark-800 text-cyan-400"
    >
      {formatTimecode(masterClock.getTime(), fps)}
    </div>
  );
};

export const PlayerControls: React.FC = () => {
  const isPlaying = useProjectStore((s) => s.isPlaying);
  const fps = useProjectStore((s) => s.project.fps);
  const duration = useProjectStore((s) => s.project.duration);

  const [volume, setVolume] = useState<number>(() => readMasterVolume());
  const [isMuted, setIsMuted] = useState<boolean>(false);

  /**
   * The master volume is a shared preview preference (localStorage + live
   * sync with the mobile control), not local state: it is read from the
   * single source on mount, pushed into the engine so a reload restores
   * what was heard, and kept in sync while the mobile control changes it.
   * Mute stays local and transient. The export is unaffected (per-clip
   * volumes only).
   */
  useEffect(() => {
    const persisted = readMasterVolume();
    setVolume(persisted);
    audioEngine.setMasterVolume(persisted);
    return subscribeMasterVolume((next) => {
      setVolume(next);
    });
  }, []);

  const handleTogglePlay = () => {
    masterClock.togglePlay();
  };

  const handleStepBack = () => {
    masterClock.stepFrame(-1, fps);
  };

  const handleStepForward = () => {
    masterClock.stepFrame(1, fps);
  };

  const handleToStart = () => {
    masterClock.seek(0);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = writeMasterVolume(parseFloat(e.target.value));
    setVolume(next);
    if (next === 0) setIsMuted(true);
    else setIsMuted(false);
    audioEngine.setMasterVolume(next);
  };

  const handleToggleMute = () => {
    if (isMuted) {
      setIsMuted(false);
      audioEngine.setMasterVolume(volume || 1);
    } else {
      setIsMuted(true);
      audioEngine.setMasterVolume(0);
    }
  };

  return (
    <div className="h-11 bg-dark-900 border-t border-b border-dark-800 px-4 flex items-center justify-between select-none">
      {/* Left: Timecode Display */}
      <div className="flex items-center gap-2">
        <TimecodeCurrentDisplay fps={fps} />
        <span className="text-slate-500 text-xs">/</span>
        <div className="font-mono text-xs text-slate-400">
          {formatTimecode(duration, fps)}
        </div>
      </div>

      {/* Center: Playback Buttons */}
      <div className="flex items-center gap-1 sm:gap-2">
        <button
          onClick={handleToStart}
          className="min-w-[32px] min-h-[32px] p-1.5 text-slate-300 hover:text-white hover:bg-dark-800 rounded transition flex items-center justify-center focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title="Ir al inicio (Home)"
          aria-label="Ir al inicio de la línea de tiempo"
        >
          <SkipBack size={15} />
        </button>

        <button
          onClick={handleStepBack}
          className="min-w-[32px] min-h-[32px] p-1.5 text-slate-300 hover:text-white hover:bg-dark-800 rounded transition flex items-center justify-center focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title="Retroceder 1 cuadro (←)"
          aria-label="Retroceder 1 fotograma"
        >
          <span className="text-xs font-mono font-bold">-1f</span>
        </button>

        <button
          onClick={handleTogglePlay}
          className={`w-9 h-9 sm:w-10 sm:h-10 rounded-full transition shadow-md active:scale-95 flex items-center justify-center focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none ${
            isPlaying
              ? 'bg-amber-500 hover:bg-amber-400 text-dark-950'
              : 'bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-bold'
          }`}
          title={isPlaying ? 'Pausar (Espacio)' : 'Reproducir (Espacio)'}
          aria-label={isPlaying ? 'Pausar reproducción' : 'Iniciar reproducción'}
          aria-pressed={isPlaying}
        >
          {isPlaying ? <Pause size={17} className="fill-current" /> : <Play size={17} className="fill-current translate-x-0.5" />}
        </button>

        <button
          onClick={handleStepForward}
          className="min-w-[32px] min-h-[32px] p-1.5 text-slate-300 hover:text-white hover:bg-dark-800 rounded transition flex items-center justify-center focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title="Avanzar 1 cuadro (→)"
          aria-label="Avanzar 1 fotograma"
        >
          <span className="text-xs font-mono font-bold">+1f</span>
        </button>
      </div>

      {/* Right: Master Volume */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleToggleMute}
          className="min-w-[32px] min-h-[32px] text-slate-300 hover:text-white p-1.5 rounded transition flex items-center justify-center focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title={isMuted ? 'Activar sonido' : 'Silenciar'}
          aria-label={isMuted ? 'Activar sonido maestro' : 'Silenciar sonido maestro'}
        >
          {isMuted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={isMuted ? 0 : volume}
          onChange={handleVolumeChange}
          aria-label="Volumen maestro"
          className="w-16 sm:w-20 h-1.5 bg-dark-750 accent-cyan-400 rounded cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title="Volumen general"
        />
      </div>
    </div>
  );
};
