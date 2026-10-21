import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  Volume2,
  VolumeX,
  Activity
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { masterClock } from '../../core/engine/MasterClock';
import { formatTimecode } from '../../core/utils/time';
import { audioEngine } from '../../core/engine/AudioEngine';
import { readMasterVolume, subscribeMasterVolume, writeMasterVolume } from '../../core/utils/masterVolume';
import {
  escribirMedidorVisible,
  leerMedidorVisible,
  useMedidorNivel,
} from '../../core/utils/levelMeter';
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

/**
 * Medidor de pico del master junto al transporte.
 *
 * Lee el `AnalyserNode` del motor y pinta el nivel de forma imperativa
 * (`useMedidorNivel`: `requestAnimationFrame` + escrituras en `ref`). No hay
 * ningún `setState` por fotograma: el único estado del transporte es el
 * interruptor (clic), nunca el nivel.
 *
 * Sin analizador (contexto cerrado, autoplay bloqueado) pinta silencio.
 * El testigo rojo marca el recorte (0 dBFS) y aguanta 1,5 s tras el pico.
 */
const MedidorNivel: React.FC = () => {
  const barraRef = useRef<HTMLDivElement>(null);
  const recorteRef = useRef<HTMLDivElement>(null);
  useMedidorNivel(barraRef, recorteRef, () => audioEngine.getAnalyserNode());

  return (
    <div
      data-testid="medidor-nivel"
      role="img"
      aria-label="Medidor de nivel del master"
      title="Nivel de salida (el testigo rojo marca recorte)"
      className="hidden min-[560px]:flex items-center gap-1 shrink-0"
    >
      <div className="h-3 w-14 overflow-hidden rounded-sm border border-border-subtle bg-app">
        <div
          ref={barraRef}
          aria-hidden="true"
          className="h-full w-full origin-left bg-accent"
          style={{ transform: 'scaleX(0)' }}
        />
      </div>
      <div
        ref={recorteRef}
        aria-hidden="true"
        title="Recorte"
        className="h-1.5 w-1.5 rounded-full bg-danger"
        style={{ opacity: 0 }}
      />
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
   * Medidor de nivel (opcional): vive en el transporte, nunca sobre el
   * monitor, así que no roba sitio a la vista previa. Es un `useState` de
   * clic (no por fotograma): el nivel se pinta por `ref` en `MedidorNivel`.
   */
  const [medidorVisible, setMedidorVisible] = useState<boolean>(() => leerMedidorVisible());

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

  /**
   * El motor solo enruta toda la mezcla cuando el medidor está visible (con
   * el medidor oculto el camino de audio es el histórico). Se publica al
   * montar (la preferencia persiste) y en cada conmutación.
   */
  useEffect(() => {
    audioEngine.setMeterEnabled(leerMedidorVisible());
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

  const etiquetaMedidor = medidorVisible ? 'Ocultar medidor de nivel' : 'Mostrar medidor de nivel';
  const alternarMedidor = () => {
    setMedidorVisible((visible) => {
      const siguiente = escribirMedidorVisible(!visible);
      audioEngine.setMeterEnabled(siguiente);
      return siguiente;
    });
  };

  return (
    // Rejilla de 3 columnas (timecode · transporte · volumen): las columnas
    // laterales ceden (`minmax(0,1fr)`) y la central es automática, así que el
    // transporte nunca se monta sobre el timecode ni siquiera a 1024 px (el
    // ancho mínimo de escritorio). El reparto flexible anterior se solapaba ahí.
    <div className="h-9 shrink-0 bg-panel border-t border-border-subtle px-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 select-none">
      {/* Izquierda: timecode actual / duración total (mono, tabular, text-1). */}
      <div className="flex items-center gap-1.5 min-w-0 justify-self-start">
        <TimecodeActual fps={fps} />
        <span aria-hidden="true" className="text-body-sm text-text-3">/</span>
        <span className="font-mono text-timecode tabular text-text-2 whitespace-nowrap">
          {formatTimecode(duration, fps)}
        </span>
        {/* Medidor de pico del master (opcional): interruptor + barra. La barra
            se oculta en estrecho para no comprimir el timecode. */}
        <IconButton
          aria-label={etiquetaMedidor}
          title={etiquetaMedidor}
          aria-pressed={medidorVisible}
          active={medidorVisible}
          onClick={alternarMedidor}
          className="shrink-0"
        >
          <Activity size={15} />
        </IconButton>
        {medidorVisible && <MedidorNivel />}
      </div>

      {/* Centro: inicio · −1 fotograma · reproducir/pausar · +1 fotograma. */}
      <div className="flex items-center gap-0.5 shrink-0 justify-self-center" role="group" aria-label="Transporte">
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

      {/* Derecha: silencio + volumen general (compartido con el móvil). La
          etiqueta textual se oculta bajo `lg`: a 1024 px colapsaba a «V..»;
          el control, su valor y su aria (`Volumen general`) se conservan. */}
      <div className="flex items-center gap-1 min-w-0 w-40 lg:w-[336px] justify-self-end">
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
            labelHiddenBelowLg
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
