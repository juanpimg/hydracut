import React, { useState } from 'react';
import { 
  Play, 
  Pause, 
  SkipBack, 
  Volume2, 
  VolumeX, 
  Magnet, 
  Scissors 
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { masterClock } from '../../core/engine/MasterClock';
import { formatTimecode } from '../../core/utils/time';
import { audioEngine } from '../../core/engine/AudioEngine';

export const PlayerControls: React.FC = () => {
  const { 
    project, 
    currentTime, 
    isPlaying, 
    snapEnabled, 
    toggleSnap, 
    splitAtPlayhead 
  } = useProjectStore();

  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);

  const handleTogglePlay = () => {
    masterClock.togglePlay();
  };

  const handleStepBack = () => {
    masterClock.stepFrame(-1, project.fps);
  };

  const handleStepForward = () => {
    masterClock.stepFrame(1, project.fps);
  };

  const handleToStart = () => {
    masterClock.seek(0);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (val === 0) setIsMuted(true);
    else setIsMuted(false);
    audioEngine.setMasterVolume(val);
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
        <div className="font-mono text-sm font-semibold tracking-wider bg-dark-950 px-2.5 py-1 rounded border border-dark-800 text-blue-400">
          {formatTimecode(currentTime, project.fps)}
        </div>
        <span className="text-slate-500 text-xs">/</span>
        <div className="font-mono text-xs text-slate-400">
          {formatTimecode(project.duration, project.fps)}
        </div>
      </div>

      {/* Center: Playback Buttons */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={handleToStart}
          className="p-1.5 text-slate-400 hover:text-white hover:bg-dark-800 rounded transition"
          title="Ir al inicio (Home)"
        >
          <SkipBack size={15} />
        </button>

        <button
          onClick={handleStepBack}
          className="p-1.5 text-slate-400 hover:text-white hover:bg-dark-800 rounded transition"
          title="Retroceder 1 cuadro (←)"
        >
          <span className="text-xs font-mono font-bold">-1f</span>
        </button>

        <button
          onClick={handleTogglePlay}
          className={`p-2.5 rounded-full transition shadow-md active:scale-95 ${
            isPlaying
              ? 'bg-amber-500 hover:bg-amber-400 text-dark-950'
              : 'bg-blue-600 hover:bg-blue-500 text-white'
          }`}
          title={isPlaying ? 'Pausar (Espacio)' : 'Reproducir (Espacio)'}
        >
          {isPlaying ? <Pause size={17} className="fill-current" /> : <Play size={17} className="fill-current translate-x-0.5" />}
        </button>

        <button
          onClick={handleStepForward}
          className="p-1.5 text-slate-400 hover:text-white hover:bg-dark-800 rounded transition"
          title="Avanzar 1 cuadro (→)"
        >
          <span className="text-xs font-mono font-bold">+1f</span>
        </button>

        <button
          onClick={splitAtPlayhead}
          className="p-1.5 ml-2 text-slate-400 hover:text-blue-400 hover:bg-dark-800 rounded transition"
          title="Cortar clip en el cabezal (S)"
        >
          <Scissors size={15} />
        </button>
      </div>

      {/* Right: Snapping & Volume */}
      <div className="flex items-center gap-3">
        {/* Snapping Toggle */}
        <button
          onClick={toggleSnap}
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition border ${
            snapEnabled
              ? 'bg-blue-600/20 border-blue-500/40 text-blue-400'
              : 'bg-dark-950 border-dark-800 text-slate-500 hover:text-slate-300'
          }`}
          title="Imán / Snapping magnético"
        >
          <Magnet size={13} />
          <span className="hidden sm:inline">Imán</span>
        </button>

        {/* Master Volume */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleToggleMute}
            className="text-slate-400 hover:text-white p-1 rounded transition"
            title={isMuted ? 'Activar sonido' : 'Silenciar'}
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
            className="w-16 h-1 bg-dark-750 accent-blue-500 rounded cursor-pointer"
            title="Volumen general"
          />
        </div>
      </div>
    </div>
  );
};
