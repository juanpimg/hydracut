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

  return (
    <div className="h-10 bg-dark-900 border-b border-dark-800 px-3 flex items-center justify-between select-none">
      {/* Left: Tools */}
      <div className="flex items-center gap-1.5">
        {/* Select Tool */}
        <button
          onClick={() => setActiveTool('select')}
          className={`p-1.5 rounded transition ${
            activeTool === 'select'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-dark-800'
          }`}
          title="Herramienta Selección (V)"
        >
          <MousePointer size={15} />
        </button>

        {/* Razor / Split Tool */}
        <button
          onClick={() => setActiveTool('split')}
          className={`p-1.5 rounded transition ${
            activeTool === 'split'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-dark-800'
          }`}
          title="Herramienta Cortar / Cuchilla (C)"
        >
          <Scissors size={15} />
        </button>

        <div className="h-4 w-[1px] bg-dark-750 mx-1" />

        {/* Quick Split at Playhead */}
        <button
          onClick={splitAtPlayhead}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-slate-300 hover:text-white bg-dark-850 hover:bg-dark-800 border border-dark-750 rounded transition"
          title="Dividir clip en el cabezal (S)"
        >
          <Scissors size={13} className="text-blue-400" />
          <span>Dividir (S)</span>
        </button>

        {/* Delete Selected Clip */}
        <button
          onClick={deleteSelectedClip}
          disabled={!selectedClipId}
          className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded transition border ${
            selectedClipId
              ? 'text-red-300 hover:text-red-200 bg-red-950/40 border-red-800/60 hover:bg-red-900/50'
              : 'text-slate-600 border-transparent cursor-not-allowed'
          }`}
          title="Eliminar clip seleccionado (Supr)"
        >
          <Trash2 size={13} />
          <span>Borrar</span>
        </button>

        {/* Snapping Toggle */}
        <button
          onClick={toggleSnap}
          className={`p-1.5 rounded transition border ${
            snapEnabled
              ? 'bg-blue-600/20 text-blue-400 border-blue-500/30'
              : 'text-slate-500 border-transparent hover:bg-dark-800'
          }`}
          title="Imán / Snapping magnético"
        >
          <Magnet size={15} />
        </button>
      </div>

      {/* Right: Add Track & Zoom Controls */}
      <div className="flex items-center gap-3">
        {/* Add Track Dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-dark-850 hover:bg-dark-800 text-slate-300 hover:text-white border border-dark-750 rounded transition"
          >
            <Plus size={13} />
            <span>Pista</span>
          </button>

          {showAddMenu && (
            <div className="absolute right-0 bottom-full mb-1 w-36 bg-dark-850 border border-dark-750 rounded-lg shadow-xl p-1 z-50">
              <button
                onClick={() => {
                  addTrack('video');
                  setShowAddMenu(false);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-slate-300 hover:text-white hover:bg-dark-750 rounded transition text-left"
              >
                <Film size={14} className="text-blue-400" />
                <span>+ Pista Video</span>
              </button>
              <button
                onClick={() => {
                  addTrack('audio');
                  setShowAddMenu(false);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-slate-300 hover:text-white hover:bg-dark-750 rounded transition text-left"
              >
                <Music size={14} className="text-emerald-400" />
                <span>+ Pista Audio</span>
              </button>
              <button
                onClick={() => {
                  addTrack('text');
                  setShowAddMenu(false);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-slate-300 hover:text-white hover:bg-dark-750 rounded transition text-left"
              >
                <Type size={14} className="text-purple-400" />
                <span>+ Pista Texto</span>
              </button>
            </div>
          )}
        </div>

        <div className="h-4 w-[1px] bg-dark-750" />

        {/* Zoom Controls */}
        <div className="flex items-center gap-1.5">
          {onFitToScreen && (
            <button
              onClick={onFitToScreen}
              data-testid="fit-to-screen-btn"
              className="flex items-center gap-1 px-2 py-1 text-xs bg-dark-850 hover:bg-dark-800 text-slate-300 hover:text-white border border-dark-750 rounded transition"
              title="Ajustar a Pantalla (Fit to Screen)"
            >
              <Maximize2 size={13} className="text-blue-400" />
              <span>Ajustar</span>
            </button>
          )}

          <button
            onClick={handleZoomOut}
            data-testid="zoom-out-btn"
            className="p-1 text-slate-400 hover:text-white hover:bg-dark-800 rounded transition flex items-center justify-center gap-0.5 text-xs font-mono"
            title="Alejar Zoom (-)"
          >
            <ZoomOut size={15} />
            <span className="sr-only">-</span>
          </button>

          <input
            type="range"
            min="10"
            max="250"
            value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
            className="w-20 h-1 bg-dark-750 accent-blue-500 rounded cursor-pointer"
            title="Nivel de zoom"
          />

          <button
            onClick={handleZoomIn}
            data-testid="zoom-in-btn"
            className="p-1 text-slate-400 hover:text-white hover:bg-dark-800 rounded transition flex items-center justify-center gap-0.5 text-xs font-mono"
            title="Acercar Zoom (+)"
          >
            <ZoomIn size={15} />
            <span className="sr-only">+</span>
          </button>
        </div>
      </div>
    </div>
  );
};
