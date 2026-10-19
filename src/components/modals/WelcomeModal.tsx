import React, { useEffect, useState } from 'react';
import { Clapperboard, FilePlus2, FolderOpen, X, Clock, Layers, Film } from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import {
  listProjects,
  createNewProject,
  getProjectById,
  rehydrateProjectMedia,
} from '../../core/storage/projectStorage';
import { ProjectMetadata } from '../../types/project';
import { useFocusTrap } from '../../hooks/useFocusTrap';

function formatDate(timestamp: number): string {
  if (!timestamp) return 'Fecha desconocida';
  const date = new Date(timestamp);
  const now = new Date();
  if (now.toDateString() === date.toDateString()) {
    return `Hoy, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Startup screen: on every fresh app load the user chooses between
 * resuming the autosaved project, starting a blank one, or opening the
 * project gallery (existing projects + .hydra/.json import).
 * The previous project is never lost: it stays saved in IndexedDB.
 */
export const WelcomeModal: React.FC = () => {
  const { isWelcomeOpen, setWelcomeOpen, setProjectsModalOpen } = useUIStore();
  const project = useProjectStore((s) => s.project);
  const loadProject = useProjectStore((s) => s.loadProject);

  const [recent, setRecent] = useState<ProjectMetadata[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isWelcomeOpen) return;
    listProjects()
      .then((list) => setRecent(list.slice(0, 3)))
      .catch(() => setRecent([]));
  }, [isWelcomeOpen]);

  /**
   * UI-08: the welcome screen is a modal dialog: it must move the focus
   * inside, trap it and give it back when it closes.
   */
  const dialogRef = useFocusTrap<HTMLDivElement>(isWelcomeOpen, {
    onEscape: () => setWelcomeOpen(false),
  });

  // Close on Escape (= continue with current project) is handled by the focus
  // trap (`useFocusTrap`).

  if (!isWelcomeOpen) return null;

  const handleNewBlank = async () => {
    setBusy(true);
    try {
      const fresh = await createNewProject();
      loadProject(fresh);
      setWelcomeOpen(false);
    } catch (err) {
      alert('Error al crear proyecto: ' + (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenGallery = () => {
    setWelcomeOpen(false);
    setProjectsModalOpen(true);
  };

  const handleLoadRecent = async (id: string) => {
    setBusy(true);
    try {
      const proj = await getProjectById(id);
      if (!proj) {
        alert('No se pudo encontrar el proyecto seleccionado.');
        return;
      }
      loadProject(await rehydrateProjectMedia(proj));
      setWelcomeOpen(false);
    } catch (err) {
      alert('Error al cargar proyecto: ' + (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Bienvenido a HydraCut"
      data-testid="welcome-modal"
      tabIndex={-1}
      className="fixed inset-0 bg-black/80 backdrop-blur-md z-[70] flex items-center justify-center p-4 select-none animate-fadeIn focus:outline-none"
    >
      <div className="bg-dark-900 border border-dark-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-scaleUp">
        {/* Header */}
        <div className="px-5 pt-5 pb-3 text-center relative">
          <button
            onClick={() => setWelcomeOpen(false)}
            className="absolute top-3 right-3 text-slate-400 hover:text-white min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg hover:bg-dark-800 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Continuar (Esc)"
            aria-label="Cerrar y continuar"
          >
            <X size={17} />
          </button>
          <div className="w-12 h-12 mx-auto rounded-2xl bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white font-black text-xl shadow-lg shadow-cyan-500/20 mb-2">
            H
          </div>
          <h2 className="text-lg font-bold text-white">HydraCut Studio</h2>
          <p className="text-xs text-slate-400 mt-0.5">¿Qué quieres hacer hoy?</p>
        </div>

        {/* Current project summary */}
        <div className="mx-4 mb-3 p-3 rounded-xl bg-dark-950 border border-dark-800 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-cyan-500/15 text-cyan-400 flex items-center justify-center shrink-0">
            <Clapperboard size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-slate-500 font-medium">Último proyecto</p>
            <p className="text-sm font-bold text-white truncate" title={project.name}>
              {project.name}
            </p>
            <p className="text-[11px] text-slate-400 font-mono flex items-center gap-2">
              <span className="inline-flex items-center gap-1">
                <Layers size={10} /> {project.tracks.length}
              </span>
              <span className="inline-flex items-center gap-1">
                <Film size={10} /> {project.clips.length}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock size={10} /> {formatDate(project.updatedAt)}
              </span>
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="px-4 pb-2 space-y-2">
          <button
            onClick={() => setWelcomeOpen(false)}
            disabled={busy}
            data-testid="welcome-continue"
            className="w-full flex items-center gap-3 px-4 min-h-[52px] rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold text-sm shadow-md shadow-cyan-500/20 active:scale-[0.99] transition text-left focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:outline-none"
          >
            <FolderOpen size={18} className="shrink-0" />
            <span>
              <span className="block">Seguir editando</span>
              <span className="block text-[11px] font-medium opacity-80">Continúa donde lo dejaste</span>
            </span>
          </button>

          <button
            onClick={handleNewBlank}
            disabled={busy}
            data-testid="welcome-new"
            className="w-full flex items-center gap-3 px-4 min-h-[52px] rounded-xl bg-dark-850 hover:bg-dark-800 border border-dark-750 hover:border-cyan-500/40 text-slate-200 hover:text-white font-semibold text-sm active:scale-[0.99] transition text-left focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          >
            <FilePlus2 size={18} className="text-cyan-400 shrink-0" />
            <span>
              <span className="block">Nuevo proyecto en blanco</span>
              <span className="block text-[11px] font-medium text-slate-400">El actual queda guardado</span>
            </span>
          </button>

          <button
            onClick={handleOpenGallery}
            disabled={busy}
            data-testid="welcome-open"
            className="w-full flex items-center gap-3 px-4 min-h-[52px] rounded-xl bg-dark-850 hover:bg-dark-800 border border-dark-750 hover:border-cyan-500/40 text-slate-200 hover:text-white font-semibold text-sm active:scale-[0.99] transition text-left focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          >
            <FolderOpen size={18} className="text-emerald-400 shrink-0" />
            <span>
              <span className="block">Abrir o importar…</span>
              <span className="block text-[11px] font-medium text-slate-400">Galería y archivos .hydra / .json</span>
            </span>
          </button>
        </div>

        {/* Recent projects quick-load */}
        {recent.length > 1 && (
          <div className="px-4 pb-4 pt-1">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
              Recientes
            </p>
            <div className="space-y-1">
              {recent
                .filter((p) => p.id !== project.id)
                .slice(0, 2)
                .map((p) => (
                  <button
                    key={p.id}
                    onClick={() => handleLoadRecent(p.id)}
                    disabled={busy}
                    data-testid={`welcome-recent-${p.id}`}
                    className="w-full flex items-center justify-between gap-2 px-3 min-h-[44px] rounded-lg hover:bg-dark-850 text-left transition group focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
                  >
                    <span className="text-xs font-medium text-slate-300 group-hover:text-white truncate">
                      {p.name}
                    </span>
                    <span className="text-[10px] font-mono text-slate-500 shrink-0">
                      {formatDate(p.updatedAt)}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        )}
        {recent.length <= 1 && <div className="pb-3" />}
      </div>
    </div>
  );
};
