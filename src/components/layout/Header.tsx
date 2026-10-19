import React, { useRef } from 'react';
import { 
  RotateCcw, 
  RotateCw, 
  HelpCircle, 
  Smartphone, 
  Tv, 
  Square,
  Download,
  FolderKanban,
  Github
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import { AspectRatio } from '../../types/project';

export const Header: React.FC = () => {
  const projectName = useProjectStore((s) => s.project.name);
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio);
  const project = useProjectStore((s) => s.project);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const setAspectRatio = useProjectStore((s) => s.setAspectRatio);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const canUndo = useProjectStore((s) => s.past.length > 0);
  const canRedo = useProjectStore((s) => s.future.length > 0);

  // UI-29: subscribe to the individual fields instead of the whole store.
  const setExportModalOpen = useUIStore((s) => s.setExportModalOpen);
  const setShortcutsModalOpen = useUIStore((s) => s.setShortcutsModalOpen);
  const setProjectsModalOpen = useUIStore((s) => s.setProjectsModalOpen);

  const aspectRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const aspectRatios: { id: AspectRatio; label: string; icon: React.ReactNode }[] = [
    { id: '16:9', label: '16:9 Panorámico', icon: <Tv size={14} /> },
    { id: '9:16', label: '9:16 Shorts/Reels', icon: <Smartphone size={14} /> },
    { id: '1:1', label: '1:1 Cuadrado', icon: <Square size={14} /> },
  ];

  /** UI-14: the radiogroup was not keyboard navigable at all. */
  const handleAspectKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = aspectRatios.length;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % count;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + count) % count;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    if (next < 0) return;

    e.preventDefault();
    setAspectRatio(aspectRatios[next].id);
    aspectRefs.current[next]?.focus();
  };

  return (
    <header className="h-14 bg-dark-900 border-b border-dark-800 px-3 sm:px-4 flex items-center justify-between z-30 select-none min-w-0 overflow-x-auto no-scrollbar">
      {/* Left: Brand & Project Manager */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        <button
          onClick={() => {
            const hasWork = project.clips.length > 0;
            if (
              !hasWork ||
              confirm('¿Volver al Hub de HydraApps? Tu proyecto está autoguardado en este navegador.')
            ) {
              window.location.href = '/';
            }
          }}
          className="flex items-center gap-2 px-2.5 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg text-white font-bold text-sm transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title="HydraCut — HydraApps Suite (volver al Hub)"
          aria-label="Volver al Hub de HydraApps"
        >
          <div className="w-5 h-5 rounded bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-[11px] font-black shadow-sm text-white">
            H
          </div>
          <span className="tracking-tight hidden sm:inline">Hydra<span className="text-cyan-400">Cut</span></span>
          <span className="text-[9px] uppercase font-mono px-1 py-0.5 rounded bg-cyan-950/80 text-cyan-400 border border-cyan-800/60 font-semibold tracking-wider hidden md:inline">
            Studio
          </span>
        </button>

        <div className="h-5 w-[1px] bg-dark-750 shrink-0" />

        <button
          onClick={() => setProjectsModalOpen(true)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-dark-800 hover:bg-dark-750 text-slate-200 hover:text-white rounded-lg border border-dark-700 hover:border-cyan-500/40 text-xs font-semibold transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none shrink-0"
          title="Gestor de Proyectos (Abrir, Nuevo, Guardar, Respaldos)"
          aria-label="Abrir gestor de proyectos"
        >
          <FolderKanban size={15} className="text-cyan-400" />
          <span className="hidden sm:inline">Proyectos</span>
        </button>

        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          aria-label="Nombre del proyecto"
          className="bg-transparent hover:bg-dark-800 focus:bg-dark-800 text-slate-200 focus:text-white px-2 py-1 rounded text-xs sm:text-sm font-medium border border-transparent focus:border-dark-700 outline-none transition w-32 sm:w-44 md:w-52 truncate focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title="Renombrar proyecto"
        />
      </div>

      {/* Middle: Aspect Ratio & Undo/Redo */}
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 mx-2">
        {/* Aspect Ratio Switcher — radiogroup with roving tabindex + arrow keys (UI-14) */}
        <div role="radiogroup" aria-label="Relación de aspecto del proyecto" className="flex bg-dark-950 p-1 rounded-lg border border-dark-800 gap-0.5 sm:gap-1">
          {aspectRatios.map((item, index) => {
            const isSelected = aspectRatio === item.id;
            return (
              <button
                key={item.id}
                ref={(el) => {
                  aspectRefs.current[index] = el;
                }}
                role="radio"
                aria-checked={isSelected}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => setAspectRatio(item.id)}
                onKeyDown={(e) => handleAspectKeyDown(e, index)}
                className={`flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 rounded text-xs font-medium transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none ${
                  isSelected
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-semibold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-dark-850 border border-transparent'
                }`}
                title={`Formato ${item.label}`}
                aria-label={`Formato ${item.label}`}
              >
                {item.icon}
                <span className="hidden md:inline">{item.id}</span>
              </button>
            );
          })}
        </div>

        <div className="hidden sm:block h-5 w-[1px] bg-dark-750 mx-0.5 shrink-0" />

        {/* Undo / Redo */}
        <div className="flex items-center gap-0.5 sm:gap-1 bg-dark-950 p-1 rounded-lg border border-dark-800">
          <button
            onClick={undo}
            disabled={!canUndo}
            className={`p-1.5 rounded transition flex items-center justify-center focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none ${
              canUndo ? 'text-slate-300 hover:bg-dark-800 hover:text-white' : 'text-slate-600 cursor-not-allowed opacity-40'
            }`}
            title="Deshacer (Ctrl+Z)"
            aria-label="Deshacer última acción (Ctrl+Z)"
          >
            <RotateCcw size={14} />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className={`p-1.5 rounded transition flex items-center justify-center focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none ${
              canRedo ? 'text-slate-300 hover:bg-dark-800 hover:text-white' : 'text-slate-600 cursor-not-allowed opacity-40'
            }`}
            title="Rehacer (Ctrl+Y)"
            aria-label="Rehacer última acción (Ctrl+Y)"
          >
            <RotateCw size={14} />
          </button>
        </div>
      </div>

      {/* Right: Shortcuts, Github & Primary Export */}
      <div className="flex items-center gap-1 sm:gap-2 shrink-0">
        {/* Shortcuts modal trigger */}
        <button
          onClick={() => setShortcutsModalOpen(true)}
          className="p-2 text-slate-400 hover:text-white hover:bg-dark-800 rounded-lg transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title="Atajos de Teclado"
          aria-label="Ver atajos de teclado"
        >
          <HelpCircle size={16} />
        </button>

        {/* GitHub link */}
        <a
          href="https://github.com/juanpimg/hydracut"
          target="_blank"
          rel="noopener noreferrer"
          className="p-2 text-slate-400 hover:text-white hover:bg-dark-800 rounded-lg transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title="Ver código en GitHub"
          aria-label="Ver HydraCut en GitHub (pestaña nueva)"
        >
          <Github size={16} />
        </a>

        {/* Primary Export Button */}
        <button
          onClick={() => setExportModalOpen(true)}
          className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-bold text-xs rounded-lg active:scale-95 transition shadow-sm focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:outline-none shrink-0"
          aria-label="Abrir modal de exportación de video MP4"
        >
          <Download size={14} className="stroke-[2.5]" />
          <span>Exportar</span>
          <span className="hidden md:inline">MP4</span>
        </button>
      </div>
    </header>
  );
};
