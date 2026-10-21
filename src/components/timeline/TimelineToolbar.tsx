import React, { useEffect, useRef, useState } from 'react';
import {
  Scissors,
  Trash2,
  Magnet,
  ZoomIn,
  ZoomOut,
  Plus,
  Film,
  Music,
  Type,
  Maximize2,
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { masterClock } from '../../core/engine/MasterClock';
import { announce } from '../layout/liveRegion';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Slider } from '../ui/Slider';
import { Menu, MenuItem } from '../ui/Menu';
import { Clip } from '../../types/project';

interface TimelineToolbarProps {
  onFitToScreen?: () => void;
  /**
   * F5 · La acción «Seleccionar todo» se define en `Timeline.tsx` (su test
   * la busca allí) pero se pinta aquí, en el grupo izquierdo de la barra.
   */
  selectAllSlot?: React.ReactNode;
}

/**
 * Pure helper: is there anything to split at `time`?
 *
 * `splitAtPlayhead()` silently does nothing when the playhead is outside every
 * clip, so the button has to know it (audit UI-27).
 */
export function canSplitAtTime(clips: Clip[], time: number): boolean {
  return clips.some((c) => time > c.start + 0.05 && time < c.start + c.duration - 0.05);
}

export const TimelineToolbar: React.FC<TimelineToolbarProps> = ({ onFitToScreen, selectAllSlot }) => {
  const zoom = useProjectStore((s) => s.zoom);
  const setZoom = useProjectStore((s) => s.setZoom);
  const snapEnabled = useProjectStore((s) => s.snapEnabled);
  const toggleSnap = useProjectStore((s) => s.toggleSnap);
  const splitAtPlayhead = useProjectStore((s) => s.splitAtPlayhead);
  const deleteSelectedClip = useProjectStore((s) => s.deleteSelectedClip);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const addTrack = useProjectStore((s) => s.addTrack);
  const clips = useProjectStore((s) => s.project.clips);

  const [showAddMenu, setShowAddMenu] = useState(false);
  const [canSplit, setCanSplit] = useState(false);

  const addTrackBtnRef = useRef<HTMLButtonElement>(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;

  // Keep the "Dividir" button in sync with the playhead: it must be disabled
  // when there is nothing to split (audit UI-27).
  useEffect(() => {
    const compute = () => {
      const can = canSplitAtTime(clipsRef.current, masterClock.getTime());
      setCanSplit((prev) => (prev === can ? prev : can));
    };

    compute();

    let lastCheck = 0;
    const unsubTime = masterClock.subscribeTime(() => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!masterClock.getIsPlaying() || now - lastCheck >= 150) {
        lastCheck = now;
        compute();
      }
    });
    const unsubState = masterClock.subscribeState(() => compute());

    return () => {
      unsubTime();
      unsubState();
    };
  }, [clips]);

  const handleAddTrack = (type: 'video' | 'audio' | 'text') => {
    addTrack(type);
    setShowAddMenu(false);
    addTrackBtnRef.current?.focus();
    announce(`Pista de ${type === 'video' ? 'vídeo' : type === 'audio' ? 'audio' : 'texto'} añadida`);
  };

  return (
    <div className="h-9 w-full max-w-full min-w-0 shrink-0 bg-raised border-b border-border-subtle px-2 flex items-center justify-between gap-1 select-none overflow-x-auto overflow-y-hidden no-scrollbar">
      {/* Izquierda: Dividir · Eliminar · Imán | + Pista · Seleccionar todo.
          Bajo 560 px las etiquetas se ocultan (quedan icono + `aria-label` +
          `title`): así la lectura compacta del zoom siempre cabe en 320 px
          sin recortes ni scroll. */}
      <div className="flex items-center gap-1 shrink-0" role="group" aria-label="Herramientas de la línea de tiempo">
        {/* F1 · Un solo nombre para dividir: «Dividir» (la «Cuchilla» duplicada se eliminó). */}
        <Button
          size="sm"
          icon={<Scissors size={14} aria-hidden="true" />}
          onClick={splitAtPlayhead}
          disabled={!canSplit}
          aria-label="Dividir en el cabezal (S)"
          title={canSplit ? 'Dividir en el cabezal (S)' : 'Sin clip bajo el cabezal'}
        >
          <span className="hidden min-[560px]:inline">Dividir</span>
        </Button>

        {/* F1 · Sin rojo aquí: el rojo destructivo vive en el menú donde se borra de verdad. */}
        <Button
          size="sm"
          variant="ghost"
          icon={<Trash2 size={14} aria-hidden="true" />}
          onClick={deleteSelectedClip}
          disabled={!selectedClipId}
          aria-label="Eliminar clip (Supr)"
          title="Eliminar clip (Supr)"
        >
          <span className="hidden min-[560px]:inline">Eliminar</span>
        </Button>

        {/* F1 · Imán latched: estado activo persistente (accent-soft + icono de acento). */}
        <Button
          size="sm"
          variant="ghost"
          icon={<Magnet size={14} aria-hidden="true" />}
          onClick={toggleSnap}
          aria-pressed={snapEnabled}
          aria-label="Ajuste magnético"
          title="Ajuste magnético"
          className={snapEnabled ? 'bg-accent-soft text-accent hover:text-accent' : ''}
        >
          <span className="hidden min-[560px]:inline">Imán</span>
        </Button>

        <div aria-hidden="true" className="h-4 w-px bg-border-subtle mx-1 shrink-0" />

        {/* + Pista */}
        <Button
          ref={addTrackBtnRef}
          size="sm"
          icon={<Plus size={14} aria-hidden="true" />}
          onClick={() => setShowAddMenu((open) => !open)}
          aria-expanded={showAddMenu}
          aria-haspopup="true"
          aria-label="Añadir pista"
          data-testid="add-track-button"
        >
          <span className="hidden min-[560px]:inline">Pista</span>
        </Button>

        {/* F5 · «Seleccionar todo» vive en la barra, no flotando sobre las pistas.
            Secundario por prioridad: oculto bajo 720 px para que la barra no
            recorte ninguna etiqueta en estrecho (sigue en Ctrl+A). */}
        {selectAllSlot && (
          <div className="hidden min-[720px]:contents">{selectAllSlot}</div>
        )}
      </div>

      {/* Derecha: zoom */}
      <div className="flex items-center gap-1 shrink-0" role="group" aria-label="Zoom de la línea de tiempo">
        {onFitToScreen && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Maximize2 size={14} aria-hidden="true" />}
            onClick={onFitToScreen}
            data-testid="fit-to-screen-btn"
            aria-label="Ajustar a la pantalla"
            title="Ajustar a la pantalla"
            className="hidden min-[640px]:inline-flex"
          >
            Ajustar
          </Button>
        )}

        <IconButton
          size="sm"
          aria-label="Alejar"
          title="Alejar la línea de tiempo"
          data-testid="zoom-out-btn"
          onClick={() => setZoom(Math.max(10, zoom / 1.25))}
        >
          <ZoomOut size={15} />
        </IconButton>

        {/* F1 · Deslizador con lectura numérica, no un range desnudo. La
            lectura es el factor de zoom en % (60 px/s = 100 %, el zoom por
            defecto): «60 px/s» no le dice nada al usuario. */}
        <div className="hidden min-[560px]:block w-44 shrink-0">
          <Slider
            label="Zoom"
            value={Math.round((zoom / 60) * 100)}
            min={20}
            max={400}
            step={5}
            unit="%"
            onChange={(value) => setZoom(Math.round((value / 100) * 60))}
          />
        </div>

        {/* Lectura compacta del zoom donde no cabe el deslizador: completa
            («100 %») y con ancho propio (`shrink-0` + `min-w` para «400 %»):
            nunca se comprime a un número recortado. */}
        <span
          aria-hidden="true"
          title={`Zoom ${Math.round((zoom / 60) * 100)} %`}
          className="min-[560px]:hidden font-mono text-timecode tabular text-text-2 whitespace-nowrap px-1 shrink-0 min-w-[3.25rem] text-center"
        >
          {Math.round((zoom / 60) * 100)} %
        </span>

        <IconButton
          size="sm"
          aria-label="Acercar"
          title="Acercar la línea de tiempo"
          data-testid="zoom-in-btn"
          onClick={() => setZoom(Math.min(250, zoom * 1.25))}
        >
          <ZoomIn size={15} />
        </IconButton>
      </div>

      {/* Menú de + Pista: una puerta por tipo, con su nombre en español. */}
      <Menu
        ancla={addTrackBtnRef}
        abierto={showAddMenu}
        onCerrar={() => setShowAddMenu(false)}
        ariaLabel="Añadir pista"
      >
        <MenuItem
          icon={<Film size={15} aria-hidden="true" />}
          data-testid="add-track-video"
          onClick={() => handleAddTrack('video')}
        >
          Pista de vídeo
        </MenuItem>
        <MenuItem
          icon={<Music size={15} aria-hidden="true" />}
          data-testid="add-track-audio"
          onClick={() => handleAddTrack('audio')}
        >
          Pista de audio
        </MenuItem>
        <MenuItem
          icon={<Type size={15} aria-hidden="true" />}
          data-testid="add-track-text"
          onClick={() => handleAddTrack('text')}
        >
          Pista de texto
        </MenuItem>
      </Menu>
    </div>
  );
};
