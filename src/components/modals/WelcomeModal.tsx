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
import { markWelcomeSeen } from '../../core/utils/appFlags';
import { Button } from '../ui/Button';

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
   * La bienvenida es de primer arranque: al cerrarse (por cualquier vía:
   * botón, Escape, continuar) queda registrada como vista para que la
   * próxima carga entre directa al editor. Reabrirla desde la "Guía de
   * inicio" del header sigue funcionando.
   */
  useEffect(() => {
    if (!isWelcomeOpen) markWelcomeSeen();
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
      className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center p-4 select-none focus:outline-none"
    >
      <div className="bg-raised border border-border rounded-lg w-full max-w-md shadow-overlay overflow-hidden">
        {/* Cabecera: qué es la app + promesa de privacidad como hecho */}
        <div className="px-4 pt-4 pb-2 relative">
          <button
            onClick={() => setWelcomeOpen(false)}
            className="absolute top-2 right-2 inline-flex min-w-[44px] min-h-[44px] items-center justify-center rounded text-text-2 transition hover:bg-overlay hover:text-text-1"
            title="Continuar (Esc)"
            aria-label="Cerrar y continuar"
          >
            <X size={16} aria-hidden="true" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-panel border border-border-subtle text-accent flex items-center justify-center shrink-0">
              <Clapperboard size={16} aria-hidden="true" />
            </div>
            <h2 className="text-title text-text-1">HydraCut Studio</h2>
          </div>
          <p className="mt-1 text-body-sm text-text-2">Edita y exporta vídeo en el navegador.</p>
          <p className="text-body-sm text-text-2">Elige cómo empezar.</p>
          <p className="mt-0.5 text-body-sm text-text-3">Tus vídeos no salen de este navegador.</p>
        </div>

        {/* Proyecto actual */}
        <div className="mx-4 mb-2 p-2 rounded-md bg-panel border border-border-subtle flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-caption uppercase tracking-wider text-text-3">Último proyecto</p>
            <p className="truncate text-body font-medium text-text-1" title={project.name}>
              {project.name}
            </p>
            <p className="tabular flex items-center gap-2 font-mono text-timecode text-text-2">
              <span className="inline-flex items-center gap-1">
                <Layers size={10} aria-hidden="true" /> {project.tracks.length}
              </span>
              <span className="inline-flex items-center gap-1">
                <Film size={10} aria-hidden="true" /> {project.clips.length}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock size={10} aria-hidden="true" /> {formatDate(project.updatedAt)}
              </span>
            </p>
          </div>
        </div>

        {/* Acciones */}
        <div className="px-4 pb-2 flex flex-col gap-1.5">
          <Button
            variant="primary"
            onClick={() => setWelcomeOpen(false)}
            disabled={busy}
            data-testid="welcome-continue"
            icon={<FolderOpen size={16} className="shrink-0" aria-hidden="true" />}
            className="w-full justify-start min-h-[52px] !px-4 text-left"
          >
            <span>
              <span className="block">Seguir editando</span>
              <span className="block text-body-sm font-normal opacity-80">Continúa donde lo dejaste</span>
            </span>
          </Button>

          <Button
            variant="secondary"
            onClick={handleNewBlank}
            disabled={busy}
            data-testid="welcome-new"
            icon={<FilePlus2 size={16} className="shrink-0" aria-hidden="true" />}
            className="w-full justify-start min-h-[52px] !px-4 text-left"
          >
            <span>
              <span className="block">Nuevo proyecto en blanco</span>
              <span className="block text-body-sm font-normal text-text-2">El actual queda guardado</span>
            </span>
          </Button>

          <Button
            variant="secondary"
            onClick={handleOpenGallery}
            disabled={busy}
            data-testid="welcome-open"
            icon={<FolderOpen size={16} className="shrink-0" aria-hidden="true" />}
            className="w-full justify-start min-h-[52px] !px-4 text-left"
          >
            <span>
              <span className="block">Abrir o importar…</span>
              <span className="block text-body-sm font-normal text-text-2">Galería y archivos .hydra / .json</span>
            </span>
          </Button>
        </div>

        {/* Recientes */}
        {recent.length > 1 && (
          <div className="px-4 pb-3 pt-1">
            <p className="text-caption uppercase tracking-wider text-text-3 mb-1">
              Recientes
            </p>
            <div className="flex flex-col gap-0.5">
              {recent
                .filter((p) => p.id !== project.id)
                .slice(0, 2)
                .map((p) => (
                  <button
                    key={p.id}
                    onClick={() => handleLoadRecent(p.id)}
                    disabled={busy}
                    data-testid={`welcome-recent-${p.id}`}
                    className="w-full flex items-center justify-between gap-2 px-2 min-h-[44px] rounded text-left transition text-text-2 hover:bg-panel hover:text-text-1"
                  >
                    <span className="truncate text-body-sm">
                      {p.name}
                    </span>
                    <span className="tabular shrink-0 font-mono text-timecode text-text-3">
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
