import React, { useRef } from 'react';
import { 
  RotateCcw, 
  RotateCw, 
  FilePlus, 
  Upload, 
  Save, 
  HelpCircle, 
  Smartphone, 
  Tv, 
  Square,
  Sparkles,
  FolderKanban
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import { exportProjectToJson, importProjectFromJson, rehydrateProjectMedia } from '../../core/storage/projectStorage';
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
  const resetProject = useProjectStore((s) => s.resetProject);
  const loadProject = useProjectStore((s) => s.loadProject);

  const { 
    setExportModalOpen, 
    setShortcutsModalOpen,
    setProjectsModalOpen,
  } = useUIStore();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExportJson = () => {
    exportProjectToJson(project);
  };

  const handleImportJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imported = await importProjectFromJson(file);
      const rehydrated = await rehydrateProjectMedia(imported);
      loadProject(rehydrated);
    } catch (err) {
      alert('Error al importar el proyecto: ' + (err as Error).message);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const aspectRatios: { id: AspectRatio; label: string; icon: React.ReactNode }[] = [
    { id: '16:9', label: '16:9 Panorámico', icon: <Tv size={14} /> },
    { id: '9:16', label: '9:16 Shorts/Reels', icon: <Smartphone size={14} /> },
    { id: '1:1', label: '1:1 Cuadrado', icon: <Square size={14} /> },
  ];

  return (
    <header className="h-14 bg-dark-900 border-b border-dark-800 px-4 flex items-center justify-between z-30 select-none">
      {/* Brand & Project Name */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => {
            const hasWork = project.clips.length > 0;
            if (
              !hasWork ||
              confirm('Volver al Hub de HydraApps? Tu proyecto está autoguardado en este navegador.')
            ) {
              window.location.href = '/';
            }
          }}
          className="flex items-center gap-2 px-2.5 py-1 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg text-white font-bold text-sm transition group"
          title="HydraCut — HydraApps Suite (volver al Hub)"
        >
          <div className="w-5 h-5 rounded bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-[11px] font-black shadow-sm text-white">
            H
          </div>
          <span className="tracking-tight">Hydra<span className="text-cyan-400">Cut</span></span>
          <span className="text-[9px] uppercase font-mono px-1 py-0.5 rounded bg-cyan-950/80 text-cyan-400 border border-cyan-800/60 font-semibold tracking-wider hidden sm:inline">
            Studio
          </span>
        </button>

        <div className="h-5 w-[1px] bg-dark-750" />

        <button
          onClick={() => setProjectsModalOpen(true)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-dark-800 hover:bg-dark-750 text-slate-200 hover:text-white rounded-lg border border-dark-700 hover:border-cyan-500/40 text-xs font-semibold transition"
          title="Gestor de Proyectos"
        >
          <FolderKanban size={15} className="text-cyan-400" />
          <span className="hidden sm:inline">Proyectos</span>
        </button>

        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          className="bg-transparent hover:bg-dark-800 focus:bg-dark-800 text-slate-200 focus:text-white px-2 py-1 rounded text-sm font-medium border border-transparent focus:border-dark-700 outline-none transition w-40 sm:w-52 truncate"
          title="Renombrar proyecto"
        />
      </div>

      {/* Middle: Aspect Ratio & Undo/Redo */}
      <div className="flex items-center gap-2">
        {/* Aspect Ratio Switcher */}
        <div className="flex bg-dark-950 p-1 rounded-lg border border-dark-800 gap-1">
          {aspectRatios.map((item) => (
            <button
              key={item.id}
              onClick={() => setAspectRatio(item.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition ${
                aspectRatio === item.id
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-dark-850'
              }`}
              title={`Formato ${item.label}`}
            >
              {item.icon}
              <span className="hidden sm:inline">{item.id}</span>
            </button>
          ))}
        </div>

        <div className="h-5 w-[1px] bg-dark-750 mx-1" />

        {/* Undo / Redo */}
        <div className="flex items-center gap-1 bg-dark-950 p-1 rounded-lg border border-dark-800">
          <button
            onClick={undo}
            disabled={!canUndo}
            className={`p-1.5 rounded transition ${
              canUndo ? 'text-slate-300 hover:bg-dark-800 hover:text-white' : 'text-slate-600 cursor-not-allowed'
            }`}
            title="Deshacer (Ctrl+Z)"
          >
            <RotateCcw size={14} />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className={`p-1.5 rounded transition ${
              canRedo ? 'text-slate-300 hover:bg-dark-800 hover:text-white' : 'text-slate-600 cursor-not-allowed'
            }`}
            title="Rehacer (Ctrl+Y)"
          >
            <RotateCw size={14} />
          </button>
        </div>
      </div>

      {/* Right: Actions & Export */}
      <div className="flex items-center gap-2">
        {/* New / Save / Load Project */}
        <div className="flex items-center gap-1 bg-dark-950 p-1 rounded-lg border border-dark-800">
          <button
            onClick={() => {
              if (confirm('¿Estás seguro de crear un nuevo proyecto? Los cambios no guardados se perderán.')) {
                resetProject();
              }
            }}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-dark-800 rounded transition"
            title="Nuevo Proyecto"
          >
            <FilePlus size={15} />
          </button>

          <button
            onClick={handleExportJson}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-dark-800 rounded transition"
            title="Guardar archivo .json"
          >
            <Save size={15} />
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-dark-800 rounded transition"
            title="Cargar archivo .json"
          >
            <Upload size={15} />
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImportJson}
            className="hidden"
          />
        </div>

        {/* Shortcuts button */}
        <button
          onClick={() => setShortcutsModalOpen(true)}
          className="p-2 text-slate-400 hover:text-white hover:bg-dark-800 rounded-lg transition"
          title="Atajos de Teclado"
        >
          <HelpCircle size={17} />
        </button>

        {/* Export Button */}
        <button
          onClick={() => setExportModalOpen(true)}
          className="flex items-center gap-2 px-4 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-semibold text-xs rounded-lg shadow-lg shadow-blue-500/20 active:scale-95 transition"
        >
          <Sparkles size={14} className="animate-pulse" />
          <span>Exportar Video MP4</span>
        </button>
      </div>
    </header>
  );
};
