import React, { useState } from 'react';
import { 
  Scissors, 
  Trash2, 
  Magnet, 
  ZoomIn, 
  ZoomOut, 
  Plus, 
  MousePointer, 
  Film, 
  Music, 
  Type,
  Maximize2 
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';

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

  const { activeTool, setActiveTool } = useUIStore();
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

  // Base touch target: 36px on narrow mobile (<480px), compact on sm+ (toolbar is icon-dense)
  const iconBtn =
    'min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 sm:p-1.5 flex items-center justify-center rounded transition shrink-0';

  return (
    <div className="w-full max-w-full min-w-0 min-h-[44px] sm:h-10 bg-dark-900 border-b border-dark-800 px-1.5 sm:px-3 py-1 flex items-center justify-between gap-1 select-none overflow-x-auto no-scrollbar">
      {/* Left: Tools */}
      <div className="flex items-center gap-0.5 sm:gap-1.5 shrink-0">
        {/* Select Tool (Mouse/desktop tool: hidden on narrow mobile < 480px) */}
        <button
          onClick={() => setActiveTool('select')}
          aria-pressed={activeTool === 'select'}
          aria-label="Herramienta selección"
          className={`hidden min-[480px]:flex ${iconBtn} ${
            activeTool === 'select'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-dark-800'
          }`}
          title="Herramienta Selección"
        >
          <MousePointer size={16} />
        </button>

        {/* Razor / Split Tool (Desktop tool: hidden on narrow mobile < 480px) */}
        <button
          onClick={() => setActiveTool(activeTool === 'split' ? 'select' : 'split')}
          aria-pressed={activeTool === 'split'}
          aria-label="Herramienta cuchilla"
          className={`hidden min-[480px]:flex ${iconBtn} ${
            activeTool === 'split'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-dark-800'
          }`}
          title="Herramienta Cortar / Cuchilla"
        >
          <Scissors size={16} />
        </button>

        <div className="hidden min-[480px]:block h-4 w-[1px] bg-dark-750 mx-0.5 sm:mx-1 shrink-0" />

        {/* Quick Split at Playhead (Duplicated by mobile bottom bar on narrow mobile) */}
        <button
          onClick={splitAtPlayhead}
          aria-label="Dividir clip en el cabezal"
          className={`hidden min-[480px]:flex ${iconBtn} gap-1.5 sm:px-2.5 sm:py-1 text-xs text-slate-300 hover:text-white bg-dark-850 hover:bg-dark-800 border border-dark-750 sm:rounded transition`}
          title="Dividir clip en el cabezal (S)"
        >
          <Scissors size={14} className="text-blue-400" />
          <span className="hidden sm:inline">Dividir (S)</span>
        </button>

        {/* Delete Selected Clip (Duplicated by mobile bottom bar on narrow mobile) */}
        <button
          onClick={deleteSelectedClip}
          disabled={!selectedClipId}
          aria-label="Eliminar clip seleccionado"
          className={`hidden min-[480px]:flex min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 sm:p-1.5 items-center justify-center gap-1.5 sm:px-2.5 sm:py-1 text-xs rounded transition border shrink-0 ${
            selectedClipId
              ? 'text-red-300 hover:text-red-200 bg-red-950/40 border-red-800/60 hover:bg-red-900/50'
              : 'text-slate-600 border-transparent cursor-not-allowed'
          }`}
          title="Eliminar clip seleccionado (Supr)"
        >
          <Trash2 size={14} />
          <span className="hidden sm:inline">Borrar</span>
        </button>

        {/* Snapping Toggle */}
        <button
          onClick={toggleSnap}
          aria-pressed={snapEnabled}
          aria-label="Imán: snapping magnético"
          className={`${iconBtn} border ${
            snapEnabled
              ? 'bg-blue-600/20 text-blue-400 border-blue-500/30'
              : 'text-slate-500 border-transparent hover:bg-dark-800'
          }`}
          title="Imán / Snapping magnético"
        >
          <Magnet size={16} />
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
                  className="w-full flex items-center gap-2 px-2.5 min-h-[44px] text-xs text-slate-300 hover:text-white hover:bg-dark-750 rounded transition text-left"
                >
                  <Type size={15} className="text-purple-400" />
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
