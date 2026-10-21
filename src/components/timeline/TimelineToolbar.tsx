import React, { useEffect, useRef, useState } from 'react';
import {
  Scissors,
  Trash2,
  FoldHorizontal,
  Flag,
  Magnet,
  ZoomIn,
  ZoomOut,
  Plus,
  Film,
  Music,
  Type,
  Maximize2,
  X,
  Crosshair,
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { masterClock } from '../../core/engine/MasterClock';
import { formatTimecode } from '../../core/utils/time';
import { parseTimecodeInput } from '../../core/utils/markers';
import { announce } from '../layout/liveRegion';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Slider } from '../ui/Slider';
import { Menu, MenuItem, MenuSeparador } from '../ui/Menu';
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
  const rippleDeleteClip = useProjectStore((s) => s.rippleDeleteClip);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const addTrack = useProjectStore((s) => s.addTrack);
  const clips = useProjectStore((s) => s.project.clips);
  const projectFps = useProjectStore((s) => s.project.fps);
  // P0-6 · Marcadores: la lista para la regla y el menú, y el puente hacia
  // el rango de exportación.
  const markers = useProjectStore((s) => s.project.markers);
  const addMarker = useProjectStore((s) => s.addMarker);
  const removeMarker = useProjectStore((s) => s.removeMarker);
  const renameMarker = useProjectStore((s) => s.renameMarker);
  const jumpToMarker = useProjectStore((s) => s.jumpToMarker);
  const pendingExportRange = useProjectStore((s) => s.pendingExportRange);
  const setExportRangeEndpoint = useProjectStore((s) => s.setExportRangeEndpoint);
  const clearPendingExportRange = useProjectStore((s) => s.clearPendingExportRange);
  const goToTimecode = useProjectStore((s) => s.goToTimecode);

  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showMarkersMenu, setShowMarkersMenu] = useState(false);
  const [canSplit, setCanSplit] = useState(false);
  // P0-11 · El campo numérico de timecode (controlado: Enter salta).
  const [timecodeValue, setTimecodeValue] = useState('');

  const addTrackBtnRef = useRef<HTMLButtonElement>(null);
  const markersBtnRef = useRef<HTMLButtonElement>(null);
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

  // P0-1 · Ripple delete sobre la selección primaria (mismo sitio que el
  // borrado simple: el hueco se cierra en vez de quedarse abierto).
  const handleRippleDelete = () => {
    if (!selectedClipId) return;
    const target = clipsRef.current.find((c) => c.id === selectedClipId);
    const result = rippleDeleteClip(selectedClipId);
    if (result.ok) {
      announce(`«${target?.name ?? 'Clip'}» eliminado y hueco cerrado`);
    }
  };

  // P0-11 · El campo numérico salta al tiempo tecleado (HH:MM:SS:FF o
  // segundos). Lo no válido se rechaza con motivo en el banner (nunca NaN).
  const handleGoToTimecode = () => {
    const parsed = parseTimecodeInput(timecodeValue, projectFps ?? 30);
    if (parsed === null) {
      goToTimecode(Number.NaN);
      return;
    }
    if (goToTimecode(parsed)) setTimecodeValue('');
  };

  const markerList = markers ?? [];
  const pendingLabel =
    pendingExportRange.start !== null && pendingExportRange.end !== null
      ? `Rango pendiente: ${formatTimecode(pendingExportRange.start, projectFps ?? 30)} → ${formatTimecode(pendingExportRange.end, projectFps ?? 30)}`
      : pendingExportRange.start !== null || pendingExportRange.end !== null
        ? 'Rango pendiente incompleto: marca la entrada y la salida'
        : 'Sin rango pendiente';

  return (
    <div className="h-9 w-full max-w-full min-w-0 shrink-0 bg-raised border-b border-border-subtle px-2 flex items-center justify-between gap-1 select-none overflow-x-auto overflow-y-hidden no-scrollbar">
      {/* Izquierda: Dividir · Eliminar · Imán | + Pista · Seleccionar todo.
          Bajo 560 px las etiquetas se ocultan (quedan icono + `aria-label` +
          `title`): así la lectura compacta del zoom siempre cabe en 320 px
          sin recortes ni scroll. */}
      <div className="flex items-center gap-1 shrink-0" role="group" aria-label="Herramientas de la línea de tiempo">
        {/* F1 · Un solo nombre para dividir: «Dividir» (la «Cuchilla» duplicada se eliminó).
            H1: en táctil la única puerta es la tira móvil, así que estas
            tijeras se ocultan con puntero grueso (el escritorio las conserva). */}
        <Button
          size="sm"
          icon={<Scissors size={14} aria-hidden="true" />}
          onClick={splitAtPlayhead}
          disabled={!canSplit}
          aria-label="Dividir en el cabezal (S)"
          title={canSplit ? 'Dividir en el cabezal (S)' : 'Sin clip bajo el cabezal'}
          className="[@media(pointer:coarse)]:hidden"
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

        {/* P0-1 · Ripple delete donde ya vive el borrado: borra el clip
            seleccionado Y cierra el hueco (Mayús+Supr). */}
        <Button
          size="sm"
          variant="ghost"
          icon={<FoldHorizontal size={14} aria-hidden="true" />}
          onClick={handleRippleDelete}
          disabled={!selectedClipId}
          data-testid="ripple-delete-button"
          aria-label="Eliminar y cerrar hueco (Mayús+Supr)"
          title="Eliminar y cerrar hueco (Mayús+Supr)"
        >
          <span className="hidden min-[560px]:inline">Cerrar hueco</span>
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

        {/* P0-6 · Marcadores: añadir con M, saltar, renombrar, borrar y fijar
            el rango de exportación. El conteo va en el aria (la regla los
            pinta; este menú los enumera). */}
        <Button
          ref={markersBtnRef}
          size="sm"
          variant="ghost"
          icon={<Flag size={14} aria-hidden="true" />}
          onClick={() => setShowMarkersMenu((open) => !open)}
          aria-expanded={showMarkersMenu}
          aria-haspopup="true"
          aria-label={markerList.length === 0 ? 'Marcadores (M)' : `Marcadores (${markerList.length})`}
          title="Marcadores (M)"
          data-testid="markers-button"
        >
          <span className="hidden min-[560px]:inline">Marcadores</span>
          {markerList.length > 0 && (
            <span aria-hidden="true" className="font-mono text-timecode tabular">
              {markerList.length}
            </span>
          )}
        </Button>

        {/* P0-11 · Ir al timecode: campo numérico (Ctrl+G lo enfoca, Enter
            salta). Oculto bajo 720 px: la lectura compacta del zoom ya ocupa
            ese ancho en 320 px. */}
        <form
          className="hidden min-[720px]:flex items-center gap-1 shrink-0"
          role="search"
          aria-label="Ir al timecode"
          onSubmit={(e) => {
            e.preventDefault();
            handleGoToTimecode();
          }}
        >
          <input
            data-testid="goto-timecode"
            value={timecodeValue}
            onChange={(e) => setTimecodeValue(e.target.value)}
            placeholder="00:00:00:00"
            aria-label="Ir al timecode (Ctrl+G)"
            title="Ir al timecode (Ctrl+G): HH:MM:SS:FF o segundos"
            spellCheck={false}
            autoComplete="off"
            className="h-7 w-28 rounded border border-border-subtle bg-panel px-1.5 font-mono text-timecode tabular text-text-1 placeholder:text-text-3 focus-visible:outline-2 focus-visible:outline-accent"
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<Crosshair size={14} aria-hidden="true" />}
            type="submit"
            aria-label="Saltar al timecode"
            title="Saltar al timecode (Enter)"
          >
            <span className="hidden min-[560px]:inline">Ir</span>
          </Button>
        </form>

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

      {/* P0-6 · Menú de marcadores: la lista salta al marcador, lo renombra,
          lo borra y lo convierte en entrada/salida del rango pendiente que el
          diálogo de exportación lee al abrirse. Las filas propias no son
          `menuitem` (el menú no se cierra al marcar entrada+salida seguidas);
          solo "Añadir" y "Limpiar" cierran. */}
      <Menu
        ancla={markersBtnRef}
        abierto={showMarkersMenu}
        onCerrar={() => setShowMarkersMenu(false)}
        ariaLabel="Marcadores"
        anchoMinimo={300}
      >
        <MenuItem
          icon={<Flag size={15} aria-hidden="true" />}
          atajo="M"
          data-testid="marker-add"
          onClick={() => {
            const created = addMarker();
            if (created) announce(`Marcador «${created.name}» añadido en el cabezal`);
          }}
        >
          Añadir marcador en el cabezal
        </MenuItem>
        <MenuSeparador />
        {markerList.length === 0 ? (
          <p role="status" className="px-2.5 py-1.5 text-body-sm text-text-3">
            Sin marcadores: pulsa M para marcar el cabezal.
          </p>
        ) : (
          markerList.map((marker) => (
            <div
              key={marker.id}
              className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-raised"
            >
              <button
                type="button"
                data-testid={`marker-jump-${marker.id}`}
                aria-label={`Saltar al marcador «${marker.name}»`}
                title={`Saltar a ${formatTimecode(marker.time, projectFps ?? 30)}`}
                onClick={() => {
                  if (jumpToMarker(marker.id)) announce(`Cabezal en «${marker.name}»`);
                }}
                className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-body-sm text-text-1 transition hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span className="mr-1.5 inline-block h-2 w-2 rotate-45 rounded-[1px] align-baseline"
                  style={{ backgroundColor: marker.color ?? '#f59e0b' }}
                  aria-hidden="true"
                />
                {marker.name}
                <span className="ml-1.5 font-mono text-timecode tabular text-text-3">
                  {formatTimecode(marker.time, projectFps ?? 30)}
                </span>
              </button>
              <input
                key={`${marker.id}-${marker.name}`}
                defaultValue={marker.name}
                aria-label={`Renombrar marcador «${marker.name}»`}
                title="Enter para renombrar"
                spellCheck={false}
                autoComplete="off"
                maxLength={60}
                onBlur={(e) => {
                  if (e.target.value.trim() !== marker.name) renameMarker(marker.id, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                className="h-7 w-24 shrink-0 rounded border border-border-subtle bg-panel px-1.5 text-body-sm text-text-1 focus-visible:outline-2 focus-visible:outline-accent"
              />
              <button
                type="button"
                aria-label={`Usar «${marker.name}» como entrada de exportación`}
                title="Marcar entrada"
                onClick={() => setExportRangeEndpoint('start', marker.time)}
                className={`h-7 shrink-0 rounded border px-1.5 font-mono text-timecode tabular transition focus-visible:outline-2 focus-visible:outline-accent ${pendingExportRange.start === marker.time ? 'border-accent bg-accent-soft text-accent' : 'border-border-subtle text-text-2 hover:text-text-1'}`}
              >
                E
              </button>
              <button
                type="button"
                aria-label={`Usar «${marker.name}» como salida de exportación`}
                title="Marcar salida"
                onClick={() => setExportRangeEndpoint('end', marker.time)}
                className={`h-7 shrink-0 rounded border px-1.5 font-mono text-timecode tabular transition focus-visible:outline-2 focus-visible:outline-accent ${pendingExportRange.end === marker.time ? 'border-accent bg-accent-soft text-accent' : 'border-border-subtle text-text-2 hover:text-text-1'}`}
              >
                S
              </button>
              <IconButton
                size="sm"
                aria-label={`Eliminar marcador «${marker.name}»`}
                title={`Eliminar marcador «${marker.name}»`}
                onClick={() => removeMarker(marker.id)}
              >
                <X size={14} />
              </IconButton>
            </div>
          ))
        )}
        <MenuSeparador />
        <p role="status" data-testid="pending-export-range" className="px-2.5 py-1 font-mono text-timecode tabular text-text-3">
          {pendingLabel}
        </p>
        {(pendingExportRange.start !== null || pendingExportRange.end !== null) && (
          <MenuItem onClick={clearPendingExportRange}>
            Limpiar rango pendiente
          </MenuItem>
        )}
      </Menu>
    </div>
  );
};
