import React, { useState } from 'react';
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
  Maximize2 
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';

interface TimelineToolbarProps {
  onFitToScreen?: () => void;
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

  const [showAddMenu, setShowAddMenu] = useState(false);

  const handleZoomIn = () => setZoom(zoom * 1.25);
  const handleZoomOut = () => setZoom(zoom / 1.25);

  // Close "add track" menu on Escape
  React.useEffect(() => {
    if (!showAddMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAddMenu(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showAddMenu]);

  // Base touch target: accessible 36px on compact desktop, 40px on touch
  const iconBtn =
    'min-w-[36px] min-h-[36px] p-1.5 flex items-center justify-center rounded transition shrink-0 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none';

  return (
    <div className="w-full max-w-full min-w-0 min-h-[44px] sm:h-10 bg-dark-900 border-b border-dark-800 px-1.5 sm:px-3 py-1 flex items-center justify-between gap-1 select-none overflow-x-auto no-scrollbar">
      {/* Left: Primary Editing Tools */}
      <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
        {/* Split at Playhead */}
        <button
          onClick={splitAtPlayhead}
          aria-label="Dividir clip en el cabezal (S)"
          className={`${iconBtn} gap-1.5 px-2.5 py-1 text-xs text-slate-200 hover:text-white bg-dark-850 hover:bg-dark-800 border border-dark-750 rounded`}
          title="Dividir clip en el cabezal (S)"
        >
          <Scissors size={14} className="text-cyan-400" />
          <span className="hidden sm:inline font-medium">Dividir (S)</span>
        </button>

        {/* Delete Selected Clip */}
        <button
          onClick={deleteSelectedClip}
          disabled={!selectedClipId}
          aria-label="Eliminar clip seleccionado (Supr)"
          className={`${iconBtn} gap-1.5 px-2.5 py-1 text-xs rounded border ${
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
        {/* Add Track Dropdown */}
        <div className="relative shrink-0">
          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            aria-expanded={showAddMenu}
            aria-haspopup="true"
            aria-label="Añadir pista"
            className="min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center gap-1 px-2 sm:px-2.5 sm:py-1 text-xs bg-dark-850 hover:bg-dark-800 text-slate-300 hover:text-white border border-dark-750 rounded transition shrink-0"
          >
            <Plus size={15} />
            <span className="hidden min-[480px]:inline">Pista</span>
          </button>

          {showAddMenu && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setShowAddMenu(false)}
                aria-hidden="true"
              />
              <div
                role="menu"
                aria-label="Añadir pista"
                className="absolute right-0 top-full mt-1 w-44 bg-dark-900 border border-dark-750 rounded-lg shadow-xl p-1 z-50 animate-scaleUp"
              >
                <button
                  role="menuitem"
                  onClick={() => {
                    addTrack('video');
                    setShowAddMenu(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 min-h-[44px] text-xs text-slate-300 hover:text-white hover:bg-dark-750 rounded transition text-left"
                >
                  <Film size={15} className="text-blue-400" />
                  <span>+ Pista Video</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    addTrack('audio');
                    setShowAddMenu(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 min-h-[44px] text-xs text-slate-300 hover:text-white hover:bg-dark-750 rounded transition text-left"
                >
                  <Music size={15} className="text-emerald-400" />
                  <span>+ Pista Audio</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    addTrack('text');
                    setShowAddMenu(false);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 min-h-[44px] text-xs text-slate-300 hover:text-white hover:bg-dark-750 rounded transition text-left focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
                >
                  <Type size={15} className="text-amber-400" />
                  <span>+ Pista Texto</span>
                </button>
              </div>
            </>
          )}
        </div>

        <div className="h-4 w-[1px] bg-dark-750 shrink-0" />

        {/* Zoom Controls */}
        <div className="flex items-center gap-0.5 sm:gap-1.5 shrink-0">
          {onFitToScreen && (
            <button
              onClick={onFitToScreen}
              data-testid="fit-to-screen-btn"
              aria-label="Ajustar timeline a pantalla"
              className="min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center gap-1 p-1.5 sm:px-2 sm:py-1 text-xs bg-dark-850 hover:bg-dark-800 text-slate-300 hover:text-white border border-dark-750 rounded transition shrink-0"
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
            className="min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 p-1.5 sm:p-1 text-slate-400 hover:text-white hover:bg-dark-800 rounded transition flex items-center justify-center gap-0.5 text-xs font-mono shrink-0"
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
            className="hidden min-[480px]:block w-14 min-[560px]:w-20 h-8 bg-dark-750 accent-blue-500 rounded cursor-pointer shrink-0"
            title="Nivel de zoom"
          />

          <button
            onClick={handleZoomIn}
            data-testid="zoom-in-btn"
            aria-label="Acercar zoom"
            className="min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 p-1.5 sm:p-1 text-slate-400 hover:text-white hover:bg-dark-800 rounded transition flex items-center justify-center gap-0.5 text-xs font-mono shrink-0"
            title="Acercar Zoom (+)"
          >
            <ZoomIn size={16} />
            <span className="sr-only">+</span>
          </button>
        </div>
      </div>
    </div>
  );
};
