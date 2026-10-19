import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  MousePointer2
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import { masterClock } from '../../core/engine/MasterClock';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import { moveFocusWithin } from '../../hooks/useFocusTrap';
import { announce } from '../layout/liveRegion';
import { Clip } from '../../types/project';

interface TimelineToolbarProps {
  onFitToScreen?: () => void;
}

/** Width of the "+ Pista" menu, in px (kept in sync with the `w-44` class). */
const ADD_TRACK_MENU_WIDTH = 176;
/** Height of the "+ Pista" menu, in px (3 items × 44 px + padding). */
const ADD_TRACK_MENU_HEIGHT = 142;

/**
 * Pure helper: is there anything to split at `time`?
 *
 * `splitAtPlayhead()` silently does nothing when the playhead is outside every
 * clip, so the button has to know it (audit UI-27).
 */
export function canSplitAtTime(clips: Clip[], time: number): boolean {
  return clips.some((c) => time > c.start + 0.05 && time < c.start + c.duration - 0.05);
}

export const TimelineToolbar: React.FC<TimelineToolbarProps> = ({ onFitToScreen }) => {
  const zoom = useProjectStore((s) => s.zoom);
  const setZoom = useProjectStore((s) => s.setZoom);
  const snapEnabled = useProjectStore((s) => s.snapEnabled);
  const toggleSnap = useProjectStore((s) => s.toggleSnap);
  const splitAtPlayhead = useProjectStore((s) => s.splitAtPlayhead);
  const deleteSelectedClip = useProjectStore((s) => s.deleteSelectedClip);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const addTrack = useProjectStore((s) => s.addTrack);
  const clips = useProjectStore((s) => s.project.clips);
  const activeTool = useUIStore((s) => s.activeTool);
  const setActiveTool = useUIStore((s) => s.setActiveTool);

  const [showAddMenu, setShowAddMenu] = useState(false);
  const [canSplit, setCanSplit] = useState(false);

  const addTrackBtnRef = useRef<HTMLButtonElement>(null);
  const addTrackMenuRef = useRef<HTMLDivElement>(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;

  const { position: addMenuPosition, update: updateAddMenuPosition } = useAnchoredMenu(
    showAddMenu,
    addTrackBtnRef,
    {
      menuWidth: ADD_TRACK_MENU_WIDTH,
      menuHeight: ADD_TRACK_MENU_HEIGHT,
      align: 'end',
      preferredPlacement: 'bottom',
      gap: 6,
      padding: 8,
    }
  );

  const handleZoomIn = () => setZoom(zoom * 1.25);
  const handleZoomOut = () => setZoom(zoom / 1.25);

  const closeAddMenu = useCallback((restoreFocus = true) => {
    setShowAddMenu(false);
    if (restoreFocus) addTrackBtnRef.current?.focus();
  }, []);

  const toggleAddMenu = useCallback(() => {
    // Compute the position *before* opening so the menu never flashes in the
    // top-left corner on the first frame.
    updateAddMenuPosition();
    setShowAddMenu((open) => !open);
  }, [updateAddMenuPosition]);

  // Close "add track" menu on Escape and move the focus into the menu when it opens
  useEffect(() => {
    if (!showAddMenu) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeAddMenu(true);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocusWithin(addTrackMenuRef.current, '[role="menuitem"]', e.key === 'ArrowDown' ? 'next' : 'prev');
        return;
      }
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        moveFocusWithin(addTrackMenuRef.current, '[role="menuitem"]', e.key === 'Home' ? 'first' : 'last');
      }
    };
    window.addEventListener('keydown', onKey);

    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => {
            moveFocusWithin(addTrackMenuRef.current, '[role="menuitem"]', 'first');
          })
        : null;
    if (raf === null) moveFocusWithin(addTrackMenuRef.current, '[role="menuitem"]', 'first');

    return () => {
      window.removeEventListener('keydown', onKey);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [showAddMenu, closeAddMenu]);

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
    closeAddMenu(true);
    announce(`Pista de ${type === 'video' ? 'vídeo' : type === 'audio' ? 'audio' : 'texto'} añadida`);
  };

  // Base touch target: 44px on touch devices, 32px on pointer devices.
  const iconBtn =
    'min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-[32px] p-1.5 flex items-center justify-center rounded transition shrink-0 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none';

  return (
    <div className="w-full max-w-full min-w-0 h-11 sm:h-10 bg-dark-900 border-b border-dark-800 px-1.5 sm:px-3 py-0 sm:py-1 flex items-center justify-between gap-1 select-none overflow-x-auto overflow-y-hidden no-scrollbar">
      {/* Left: Primary Editing Tools */}
      <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
        {/* Selection / blade tool toggle (audit UI-24: `activeTool` was dead code).
            Hidden below 480 px: the toolbar has to fit in a 320 px phone. */}
        <button
          onClick={() => setActiveTool(activeTool === 'select' ? 'split' : 'select')}
          aria-pressed={activeTool === 'split'}
          aria-label={
            activeTool === 'split'
              ? 'Herramienta de corte activada: pulsa un clip para cortarlo'
              : 'Herramienta de corte: pulsa un clip para cortarlo'
          }
          className={`${iconBtn} hidden min-[480px]:flex border gap-1.5 px-2 sm:px-2.5 text-xs ${
            activeTool === 'split'
              ? 'bg-amber-500/15 text-amber-400 border-amber-500/40'
              : 'text-slate-400 border-dark-800 hover:text-slate-200 hover:bg-dark-800'
          }`}
          title="Cortar clip con un clic (herramienta de cuchilla)"
        >
          <MousePointer2 size={14} />
          <span className="hidden sm:inline font-medium">Cuchilla</span>
        </button>

        {/* Split at Playhead */}
        <button
          onClick={splitAtPlayhead}
          disabled={!canSplit}
          aria-label="Dividir clip en el cabezal (S)"
          className={`${iconBtn} gap-1.5 px-2.5 py-1 text-xs rounded border ${
            canSplit
              ? 'text-slate-200 hover:text-white bg-dark-850 hover:bg-dark-800 border-dark-750'
              : 'text-slate-600 border-transparent cursor-not-allowed opacity-40'
          }`}
          title={
            canSplit
              ? 'Dividir clip en el cabezal (S)'
              : 'Dividir clip en el cabezal (no disponible: coloca el cabezal dentro de un clip)'
          }
        >
          <Scissors size={14} className={canSplit ? 'text-cyan-400' : ''} />
          <span className="hidden sm:inline font-medium">Dividir (S)</span>
        </button>

        {/* Delete Selected Clip — below 480 px the mobile bottom bar already
            offers "Eliminar" (and the toolbar would overflow a 320 px phone). */}
        <button
          onClick={deleteSelectedClip}
          disabled={!selectedClipId}
          aria-label="Eliminar clip seleccionado (Supr)"
          className={`${iconBtn} hidden min-[480px]:flex gap-1.5 px-2.5 py-1 text-xs rounded border ${
            selectedClipId
              ? 'text-rose-200 hover:text-white bg-rose-950/40 border-rose-800/60 hover:bg-rose-900/50'
              : 'text-slate-600 border-transparent cursor-not-allowed opacity-40'
          }`}
          title="Eliminar clip seleccionado (Supr)"
        >
          <Trash2 size={14} />
          <span className="hidden sm:inline font-medium">Borrar</span>
        </button>

        <div className="h-4 w-[1px] bg-dark-750 mx-1 shrink-0" />

        {/* Snapping Magnet */}
        <button
          onClick={toggleSnap}
          aria-pressed={snapEnabled}
          aria-label="Imán: snapping magnético"
          className={`${iconBtn} border gap-1.5 px-2 sm:px-2.5 text-xs ${
            snapEnabled
              ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30'
              : 'text-slate-400 border-dark-800 hover:text-slate-200 hover:bg-dark-800'
          }`}
          title="Imán / Snapping magnético"
        >
          <Magnet size={14} />
          <span className="hidden sm:inline font-medium">Imán</span>
        </button>
      </div>

      {/* Right: Add Track & Zoom Controls */}
      <div className="flex items-center gap-1 sm:gap-2.5 shrink-0">
        {/* Add Track Dropdown — rendered in a portal so that the `overflow-x-auto`
            toolbar can never clip it (audit UI-01: the menu was 0–1 px tall). */}
        <div className="relative shrink-0">
          <button
            ref={addTrackBtnRef}
            onClick={toggleAddMenu}
            aria-expanded={showAddMenu}
            aria-haspopup="true"
            aria-controls="timeline-add-track-menu"
            aria-label="Añadir pista"
            data-testid="add-track-button"
            className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-[32px] flex items-center justify-center gap-1 px-2 sm:px-2.5 sm:py-1 text-xs bg-dark-850 hover:bg-dark-800 text-slate-300 hover:text-white border border-dark-750 rounded transition shrink-0 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          >
            <Plus size={15} />
            <span className="hidden min-[480px]:inline">Pista</span>
          </button>
        </div>

        <div className="h-4 w-[1px] bg-dark-750 shrink-0" />

        {/* Zoom Controls */}
        <div className="flex items-center gap-0.5 sm:gap-1.5 shrink-0">
          {onFitToScreen && (
            <button
              onClick={onFitToScreen}
              data-testid="fit-to-screen-btn"
              aria-label="Ajustar timeline a pantalla"
              className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-[32px] hidden min-[480px]:flex items-center justify-center gap-1 p-1.5 sm:px-2 sm:py-1 text-xs bg-dark-850 hover:bg-dark-800 text-slate-300 hover:text-white border border-dark-750 rounded transition shrink-0 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
              title="Ajustar a Pantalla (Fit to Screen)"
            >
              <Maximize2 size={14} className="text-blue-400" />
              <span className="hidden min-[480px]:inline">Ajustar</span>
            </button>
          )}

          <button
            onClick={handleZoomOut}
            data-testid="zoom-out-btn"
            aria-label="Alejar zoom"
            className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-[32px] p-1.5 sm:p-1 text-slate-400 hover:text-white hover:bg-dark-800 rounded transition flex items-center justify-center gap-0.5 text-xs font-mono shrink-0 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Alejar Zoom (-)"
          >
            <ZoomOut size={16} />
            <span className="sr-only">-</span>
          </button>

          <input
            type="range"
            min="10"
            max="250"
            value={zoom}
            aria-label="Nivel de zoom del timeline"
            onChange={(e) => setZoom(parseFloat(e.target.value))}
            className="hidden min-[480px]:block w-14 min-[560px]:w-20 h-8 bg-dark-750 accent-blue-500 rounded cursor-pointer shrink-0 focus-visible:ring-2 focus-visible:ring-cyan-400"
            title="Nivel de zoom"
          />

          <button
            onClick={handleZoomIn}
            data-testid="zoom-in-btn"
            aria-label="Acercar zoom"
            className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-[32px] p-1.5 sm:p-1 text-slate-400 hover:text-white hover:bg-dark-800 rounded transition flex items-center justify-center gap-0.5 text-xs font-mono shrink-0 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Acercar Zoom (+)"
          >
            <ZoomIn size={16} />
            <span className="sr-only">+</span>
          </button>
        </div>
      </div>

      {/* The menu lives in a portal on <body>: no ancestor can clip it. */}
      {showAddMenu &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[80]"
              onClick={() => closeAddMenu(false)}
              aria-hidden="true"
              data-testid="add-track-backdrop"
            />
            <div
              ref={addTrackMenuRef}
              id="timeline-add-track-menu"
              role="menu"
              aria-label="Añadir pista"
              data-testid="add-track-menu"
              style={{
                top: `${addMenuPosition?.top ?? 0}px`,
                left: `${addMenuPosition?.left ?? 0}px`,
                maxHeight: addMenuPosition ? `${addMenuPosition.maxHeight}px` : undefined,
              }}
              className="fixed z-[90] w-44 overflow-y-auto bg-dark-900 border border-dark-750 rounded-lg shadow-xl p-1 animate-scaleUp"
            >
              <button
                role="menuitem"
                data-testid="add-track-video"
                onClick={() => handleAddTrack('video')}
                className="w-full flex items-center gap-2 px-2.5 min-h-[44px] text-xs text-slate-300 hover:text-white hover:bg-dark-750 rounded transition text-left focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
              >
                <Film size={15} className="text-blue-400" />
                <span>+ Pista Video</span>
              </button>
              <button
                role="menuitem"
                data-testid="add-track-audio"
                onClick={() => handleAddTrack('audio')}
                className="w-full flex items-center gap-2 px-2.5 min-h-[44px] text-xs text-slate-300 hover:text-white hover:bg-dark-750 rounded transition text-left focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
              >
                <Music size={15} className="text-emerald-400" />
                <span>+ Pista Audio</span>
              </button>
              <button
                role="menuitem"
                data-testid="add-track-text"
                onClick={() => handleAddTrack('text')}
                className="w-full flex items-center gap-2 px-2.5 min-h-[44px] text-xs text-slate-300 hover:text-white hover:bg-dark-750 rounded transition text-left focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
              >
                <Type size={15} className="text-amber-400" />
                <span>+ Pista Texto</span>
              </button>
            </div>
          </>,
          document.body
        )}
    </div>
  );
};
