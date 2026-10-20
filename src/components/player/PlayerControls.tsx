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
import { IconButton } from '../ui/IconButton';
import { Slider } from '../ui/Slider';

/**
 * Timecode actual sin re-render por fotograma: escribe el texto en el DOM
 * directamente desde el `masterClock` (el transporte nunca bloquea el hilo).
 */
const TimecodeActual: React.FC<{ fps: number }> = ({ fps }) => {
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
      className="font-mono text-timecode tabular text-text-1 whitespace-nowrap"
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

  /** El deslizador muestra porcentaje (0–100 %); el motor usa 0–1. */
  const volumenPorcentaje = Math.round((isMuted ? 0 : volume) * 100);
  const handleVolumeChange = (porcentaje: number) => {
    const next = writeMasterVolume(porcentaje / 100);
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
    <div className="h-9 shrink-0 bg-panel border-t border-border-subtle px-3 flex items-center gap-2 justify-between select-none">
      {/* Izquierda: timecode actual / duración total (mono, tabular, text-1). */}
      <div className="flex items-center gap-1.5 min-w-0">
        <TimecodeActual fps={fps} />
        <span aria-hidden="true" className="text-body-sm text-text-3">/</span>
        <span className="font-mono text-timecode tabular text-text-2 whitespace-nowrap">
          {formatTimecode(duration, fps)}
        </span>
      </div>

      {/* Centro: inicio · −1 fotograma · reproducir/pausar · +1 fotograma. */}
      <div className="flex items-center gap-0.5 shrink-0" role="group" aria-label="Transporte">
        <IconButton
          aria-label="Ir al inicio"
          title="Ir al inicio"
          onClick={handleToStart}
        >
          <SkipBack size={15} />
        </IconButton>

        <IconButton
          aria-label="Retroceder 1 fotograma"
          title="Retroceder 1 fotograma"
          onClick={handleStepBack}
        >
          <span className="font-mono text-[11px] font-bold">-1f</span>
        </IconButton>

        <IconButton
          aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
          title={isPlaying ? 'Pausar (Espacio)' : 'Reproducir (Espacio)'}
          aria-pressed={isPlaying}
          onClick={handleTogglePlay}
        >
          {/* El acento vive solo en el icono, nunca en un relleno. */}
          <span className="text-accent flex items-center justify-center">
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
          </span>
        </IconButton>

        <IconButton
          aria-label="Avanzar 1 fotograma"
          title="Avanzar 1 fotograma"
          onClick={handleStepForward}
        >
          <span className="font-mono text-[11px] font-bold">+1f</span>
        </IconButton>
      </div>

      {/* Derecha: silencio + volumen general (compartido con el móvil). */}
      <div className="flex items-center gap-1 min-w-0 w-40 lg:w-[336px]">
        <IconButton
          aria-label={isMuted ? 'Activar sonido general' : 'Silenciar sonido general'}
          title={isMuted ? 'Activar sonido' : 'Silenciar'}
          onClick={handleToggleMute}
          className="shrink-0"
        >
          {isMuted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </IconButton>
        <div className="min-w-0 flex-1">
          <Slider
            label="Volumen general"
            value={volumenPorcentaje}
            min={0}
            max={100}
            step={1}
            unit="%"
            onChange={handleVolumeChange}
          />
        </div>
      </div>
    </div>
  );
};
