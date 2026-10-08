import React, { useState } from 'react';
import { 
  RotateCcw, 
  RotateCw, 
  Sparkles, 
  Smartphone, 
  Tv, 
  Square,
  HelpCircle
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import { AspectRatio } from '../../types/project';

export const MobileHeader: React.FC = () => {
  const projectName = useProjectStore((s) => s.project.name);
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const setAspectRatio = useProjectStore((s) => s.setAspectRatio);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const canUndo = useProjectStore((s) => s.past.length > 0);
  const canRedo = useProjectStore((s) => s.future.length > 0);

  const { setExportModalOpen, setShortcutsModalOpen } = useUIStore();
  const [showAspectMenu, setShowAspectMenu] = useState(false);

  const aspectRatios: { id: AspectRatio; label: string; icon: React.ReactNode }[] = [
    { id: '9:16', label: '9:16 Shorts/Reels', icon: <Smartphone size={14} /> },
    { id: '16:9', label: '16:9 Panorámico', icon: <Tv size={14} /> },
    { id: '1:1', label: '1:1 Cuadrado', icon: <Square size={14} /> },
  ];

  return (
    <header className="h-12 bg-dark-950/95 border-b border-dark-800/80 px-2 sm:px-3 flex items-center justify-between z-30 select-none shrink-0 pt-[env(safe-area-inset-top)]">
      {/* Left: Brand logo & Editable Name */}
      <div className="flex items-center gap-1.5 min-w-0">
        <a 
          href="/" 
          className="w-7 h-7 rounded-lg bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white font-black text-xs shadow-md shrink-0 active:scale-95 transition"
          title="Ir a HydraApps Hub"
        >
          H
        </a>
        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          className="bg-transparent text-white font-semibold text-xs px-1 py-0.5 rounded outline-none focus:bg-dark-850 w-24 sm:w-32 truncate"
          title="Renombrar proyecto"
        />
      </div>

      {/* Middle: Aspect Ratio Switcher & Undo/Redo */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Aspect Ratio Button & Dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowAspectMenu(!showAspectMenu)}
            className="flex items-center gap-1 px-2 py-1 bg-dark-850 hover:bg-dark-800 text-slate-300 rounded-md text-[11px] font-mono border border-dark-750 active:scale-95 transition"
            title="Cambiar relación de aspecto"
          >
            {aspectRatio === '9:16' && <Smartphone size={12} className="text-cyan-400" />}
            {aspectRatio === '16:9' && <Tv size={12} className="text-cyan-400" />}
            {aspectRatio === '1:1' && <Square size={12} className="text-cyan-400" />}
            <span>{aspectRatio}</span>
          </button>

          {showAspectMenu && (
            <div 
              className="absolute top-full mt-1 left-1/2 -translate-x-1/2 bg-dark-900 border border-dark-750 shadow-xl rounded-lg p-1 flex flex-col gap-1 z-50 min-w-[130px]"
              onClick={() => setShowAspectMenu(false)}
            >
              {aspectRatios.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setAspectRatio(item.id)}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded text-xs font-medium transition text-left ${
                    aspectRatio === item.id 
                      ? 'bg-cyan-500/20 text-cyan-300 font-bold' 
                      : 'text-slate-300 hover:bg-dark-800'
                  }`}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Undo / Redo */}
        <div className="flex items-center bg-dark-850 rounded-md border border-dark-750 p-0.5">
          <button
            onClick={undo}
            disabled={!canUndo}
            className={`p-1.5 rounded active:scale-90 transition ${
              canUndo ? 'text-slate-200' : 'text-slate-600'
            }`}
            title="Deshacer"
          >
            <RotateCcw size={13} />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className={`p-1.5 rounded active:scale-90 transition ${
              canRedo ? 'text-slate-200' : 'text-slate-600'
            }`}
            title="Rehacer"
          >
            <RotateCw size={13} />
          </button>
        </div>
      </div>

      {/* Right: Export Button */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={() => setShortcutsModalOpen(true)}
          className="p-1.5 text-slate-400 hover:text-slate-200 active:scale-90 transition hidden xs:flex"
          title="Atajos"
        >
          <HelpCircle size={15} />
        </button>

        <button
          onClick={() => setExportModalOpen(true)}
          className="flex items-center gap-1 px-2.5 py-1 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold text-xs rounded-lg shadow-md shadow-cyan-500/20 active:scale-95 transition"
        >
          <Sparkles size={12} className="animate-pulse" />
          <span>Exportar</span>
        </button>
      </div>
    </header>
  );
};
