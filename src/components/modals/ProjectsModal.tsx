import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  FolderKanban,
  Plus,
  Upload,
  Search,
  Tv,
  Smartphone,
  Square,
  Copy,
  Pencil,
  Trash2,
  Download,
  Check,
  AlertTriangle,
  FolderOpen,
  MoreVertical,
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import {
  listProjects,
  getProjectById,
  deleteProject,
  duplicateProject,
  renameProject,
  createNewProject,
  exportProjectToFile,
  importProjectFromFile,
  rehydrateProjectMedia,
} from '../../core/storage/projectStorage';
import { ProjectMetadata, AspectRatio } from '../../types/project';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { announce } from '../layout/liveRegion';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Input } from '../ui/Input';
import { Menu, MenuItem, MenuSeparador } from '../ui/Menu';

export const ProjectsModal: React.FC = () => {
  const { isProjectsModalOpen, setProjectsModalOpen } = useUIStore();
  const currentProjectId = useProjectStore((s) => s.project.id);
  const loadProject = useProjectStore((s) => s.loadProject);
  const resetProject = useProjectStore((s) => s.resetProject);

  const [projects, setProjects] = useState<ProjectMetadata[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Renaming state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<ProjectMetadata | null>(null);

  // Fila con el menú de acciones abierto (abrir, duplicar, exportar, eliminar).
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Disparadores del menú por proyecto + ancla del menú abierto.
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const menuAncla = useRef<HTMLButtonElement | null>(null);

  /**
   * UI-08: the modal declared `role="dialog" aria-modal="true"` but never
   * moved the focus inside, never trapped it and never restored it.
   */
  const handleEscape = useCallback(() => {
    if (rowMenuId) {
      // El menú de la fila es un overlay anidado: se cierra primero.
      setRowMenuId(null);
      return;
    }
    if (deleteTarget) {
      setDeleteTarget(null);
    } else if (editingId) {
      setEditingId(null);
    } else {
      setProjectsModalOpen(false);
    }
  }, [rowMenuId, deleteTarget, editingId, setProjectsModalOpen]);

  const dialogRef = useFocusTrap<HTMLDivElement>(isProjectsModalOpen, { onEscape: handleEscape });

  const refreshList = useCallback(async () => {
    try {
      const list = await listProjects();
      setProjects(list);
    } catch (err) {
      console.error('Error al listar proyectos:', err);
    }
  }, []);

  useEffect(() => {
    if (isProjectsModalOpen) {
      refreshList();
      setSearchQuery('');
      setEditingId(null);
      setDeleteTarget(null);
      setRowMenuId(null);
    }
  }, [isProjectsModalOpen, refreshList]);

  // The staged dismissal of the ESC key is handled by the focus trap
  // (`useFocusTrap`), which also moves/traps/restores the focus (UI-08).

  if (!isProjectsModalOpen) return null;

  const handleCreateNew = async () => {
    setLoading(true);
    try {
      const fresh = await createNewProject();
      loadProject(fresh);
      await refreshList();
      setProjectsModalOpen(false);
    } catch (err) {
      alert('Error al crear proyecto: ' + (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadProject = async (id: string) => {
    setLoading(true);
    try {
      const proj = await getProjectById(id);
      if (!proj) {
        alert('No se pudo encontrar el proyecto seleccionado.');
        return;
      }
      const rehydrated = await rehydrateProjectMedia(proj);
      loadProject(rehydrated);
      setProjectsModalOpen(false);
    } catch (err) {
      alert('Error al cargar proyecto: ' + (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleDuplicate = async (id: string) => {
    setLoading(true);
    try {
      await duplicateProject(id);
      await refreshList();
    } catch (err) {
      alert('Error al duplicar el proyecto: ' + (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const startRenaming = (project: ProjectMetadata) => {
    setEditingId(project.id);
    setEditName(project.name);
  };

  const commitRename = async (id: string) => {
    if (!editName.trim()) {
      setEditingId(null);
      return;
    }
    setLoading(true);
    try {
      await renameProject(id, editName.trim());
      // If currently active project, update its title in memory too
      if (id === currentProjectId) {
        useProjectStore.getState().setProjectName(editName.trim());
      }
      await refreshList();
    } catch (err) {
      alert('Error al renombrar proyecto: ' + (err as Error).message);
    } finally {
      setEditingId(null);
      setLoading(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    setLoading(true);
    try {
      await deleteProject(targetId);
      // If we deleted the currently open project, open another or reset
      if (targetId === currentProjectId) {
        const remaining = projects.filter((p) => p.id !== targetId);
        if (remaining.length > 0) {
          const nextProj = await getProjectById(remaining[0].id);
          if (nextProj) {
            const rehydrated = await rehydrateProjectMedia(nextProj);
            loadProject(rehydrated);
          } else {
            resetProject();
          }
        } else {
          resetProject();
        }
      }
      await refreshList();
    } catch (err) {
      alert('Error al eliminar proyecto: ' + (err as Error).message);
    } finally {
      setDeleteTarget(null);
      setLoading(false);
    }
  };

  const handleExport = async (id: string, ext: 'hydra' | 'json') => {
    try {
      const proj = await getProjectById(id);
      if (!proj) {
        alert('No se pudo encontrar el proyecto para exportar.');
        return;
      }
      exportProjectToFile(proj, ext);
      setRowMenuId(null);
      announce(`Proyecto exportado como .${ext}`);
    } catch (err) {
      alert('Error al exportar el proyecto: ' + (err as Error).message);
    }
  };

  const processFile = async (file: File) => {
    setLoading(true);
    try {
      const imported = await importProjectFromFile(file);
      loadProject(imported);
      await refreshList();
      setProjectsModalOpen(false);
    } catch (err) {
      alert('Error al importar el archivo: ' + (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      const name = file.name.toLowerCase();
      if (name.endsWith('.hydra') || name.endsWith('.json')) {
        processFile(file);
      } else {
        alert('Formato no compatible. Por favor arrastra un archivo .hydra o .json.');
      }
    }
  };

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const formatDate = (timestamp: number): string => {
    if (!timestamp) return 'Fecha desconocida';
    const date = new Date(timestamp);
    const now = new Date();
    const diffHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

    if (diffHours < 24 && now.getDate() === date.getDate()) {
      return `Hoy, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    return date.toLocaleDateString([], {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  /** Icono 16:9 de la fila según la relación de aspecto del proyecto. */
  const renderAspectIcon = (ratio: AspectRatio) => {
    if (ratio === '9:16') return <Smartphone size={16} aria-hidden="true" />;
    if (ratio === '1:1') return <Square size={16} aria-hidden="true" />;
    return <Tv size={16} aria-hidden="true" />;
  };

  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.trim().toLowerCase())
  );

  // Proyecto con el menú de acciones abierto.
  const menuProject = rowMenuId ? (projects.find((p) => p.id === rowMenuId) ?? null) : null;

  const openRowMenu = (p: ProjectMetadata) => {
    if (rowMenuId === p.id) {
      setRowMenuId(null);
      return;
    }
    menuAncla.current = triggerRefs.current.get(p.id) ?? null;
    setRowMenuId(p.id);
  };

  return (
    <div
      ref={dialogRef}
      data-testid="projects-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="projects-modal-title"
      tabIndex={-1}
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-3 sm:p-6 select-none focus:outline-none"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="bg-raised border border-border rounded-lg w-full max-w-2xl max-h-[90dvh] shadow-overlay flex flex-col overflow-hidden relative">
        {/* Drag Overlay visual cue */}
        {isDragging && (
          <div className="absolute inset-0 bg-panel border-2 border-dashed border-accent z-50 rounded-lg flex flex-col items-center justify-center pointer-events-none p-6 text-center">
            <Upload size={32} className="text-accent mb-2" aria-hidden="true" />
            <h3 className="text-title text-text-1 mb-1">Suelta el archivo</h3>
            <p className="text-body-sm text-text-2">Admite archivos .hydra y .json de HydraCut</p>
          </div>
        )}

        {/* Cabecera */}
        <div className="px-3 py-2 border-b border-border-subtle flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded bg-panel border border-border-subtle text-text-2 flex items-center justify-center shrink-0">
              <FolderKanban size={16} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 id="projects-modal-title" className="text-title text-text-1">Mis proyectos</h2>
                <Badge variant="neutral">{projects.length}</Badge>
              </div>
              <p className="text-body-sm text-text-2">
                Se guarda solo en este navegador
              </p>
            </div>
          </div>

          <IconButton
            aria-label="Cerrar"
            title="Cerrar (Esc)"
            onClick={() => setProjectsModalOpen(false)}
          >
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>

        {/* Acciones y búsqueda */}
        <div className="p-3 border-b border-border-subtle flex flex-col sm:flex-row gap-2 items-stretch sm:items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              onClick={handleCreateNew}
              disabled={loading}
              data-testid="projects-new-btn"
              icon={<Plus size={15} aria-hidden="true" />}
              className="min-h-[44px] sm:min-h-0"
            >
              Nuevo proyecto
            </Button>

            <Button
              variant="secondary"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              icon={<Upload size={14} aria-hidden="true" />}
              className="min-h-[44px] sm:min-h-0"
            >
              Importar (.hydra / .json)
            </Button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".hydra,.json"
              onChange={handleFileInputChange}
              className="hidden"
            />
          </div>

          {/* Búsqueda */}
          <div className="relative flex-1 sm:max-w-[220px]">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3 pointer-events-none" aria-hidden="true" />
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar proyecto por nombre..."
              data-testid="projects-search"
              aria-label="Buscar proyecto por nombre"
              className="pl-8"
            />
          </div>
        </div>

        {/* Lista de proyectos: un proyecto = una fila */}
        <div className="flex-1 overflow-y-auto p-3">
          {filteredProjects.length === 0 ? (
            <div className="py-10 flex flex-col items-center justify-center text-center px-6 rounded-md border border-dashed border-border bg-panel">
              <FolderKanban size={28} className="text-text-3 mb-2" aria-hidden="true" />
              <p className="text-body font-medium text-text-1">
                {searchQuery ? 'No se encontraron proyectos con ese nombre' : 'Sin proyectos'}
              </p>
              <p className="text-body-sm text-text-2 mt-0.5 mb-3">
                {searchQuery
                  ? 'Intenta con otro término de búsqueda o limpia el filtro.'
                  : 'Crea uno o arrastra un .hydra / .json.'}
              </p>
              {!searchQuery && (
                <Button variant="primary" onClick={handleCreateNew} className="min-h-[44px] sm:min-h-0">
                  Crear proyecto
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5" role="list" aria-label="Proyectos">
              {filteredProjects.map((p) => {
                const isActive = p.id === currentProjectId;
                const isEditing = editingId === p.id;

                return (
                  <div
                    key={p.id}
                    role="listitem"
                    data-testid={`project-card-${p.id}`}
                    className={`flex items-center gap-3 rounded-md border px-2 py-2 transition ${
                      isActive
                        ? 'border-accent bg-panel'
                        : 'border-border-subtle bg-panel hover:border-border'
                    }`}
                  >
                    {/* Miniatura 16:9 */}
                    <div
                      className="flex aspect-video w-[72px] shrink-0 items-center justify-center rounded border border-border-subtle bg-raised text-text-3"
                      title={`Relación de aspecto ${p.aspectRatio}`}
                      aria-hidden="true"
                    >
                      {renderAspectIcon(p.aspectRatio)}
                    </div>

                    {/* Nombre + metadatos */}
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <div className="flex items-center gap-1">
                          <Input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename(p.id);
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                            autoFocus
                            aria-label="Nombre del proyecto"
                          />
                          <IconButton
                            size="sm"
                            aria-label="Guardar"
                            title="Guardar"
                            onClick={() => commitRename(p.id)}
                          >
                            <Check size={14} aria-hidden="true" />
                          </IconButton>
                          <IconButton
                            size="sm"
                            aria-label="Cancelar"
                            title="Cancelar"
                            onClick={() => setEditingId(null)}
                          >
                            <X size={14} aria-hidden="true" />
                          </IconButton>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 min-w-0">
                          <h3
                            className="truncate text-body font-medium text-text-1"
                            title={p.name}
                          >
                            {p.name}
                          </h3>
                          {isActive && (
                            <Badge variant="accent">Abierto</Badge>
                          )}
                        </div>
                      )}
                      <p className="tabular mt-0.5 truncate font-mono text-timecode text-text-2">
                        {p.tracksCount} {p.tracksCount === 1 ? 'pista' : 'pistas'}
                        {' · '}
                        {p.clipsCount} {p.clipsCount === 1 ? 'clip' : 'clips'}
                        {' · '}
                        {formatDuration(p.duration)}
                        {' · '}
                        {formatDate(p.updatedAt)}
                      </p>
                    </div>

                    {/* Acciones en menú */}
                    <IconButton
                      ref={(el) => {
                        if (el) triggerRefs.current.set(p.id, el);
                        else triggerRefs.current.delete(p.id);
                      }}
                      size="sm"
                      aria-label={`Acciones de ${p.name}`}
                      title={`Acciones de ${p.name}`}
                      aria-haspopup="menu"
                      aria-expanded={rowMenuId === p.id}
                      active={rowMenuId === p.id}
                      onClick={() => openRowMenu(p)}
                    >
                      <MoreVertical size={16} aria-hidden="true" />
                    </IconButton>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Confirmación de borrado */}
        {deleteTarget && (
          <div className="absolute inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
            <div className="bg-raised border border-border rounded-lg p-4 max-w-sm w-full shadow-overlay">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded bg-danger/15 text-danger flex items-center justify-center shrink-0">
                  <AlertTriangle size={18} aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h4 className="text-body font-medium text-text-1">¿Eliminar proyecto?</h4>
                  <p className="text-body-sm text-text-2 mt-0.5">
                    «{deleteTarget.name}» se borrará para siempre. No se puede deshacer.
                  </p>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setDeleteTarget(null)}
                  disabled={loading}
                  className="min-h-[44px] sm:min-h-0"
                >
                  Cancelar
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={confirmDelete}
                  disabled={loading}
                  className="min-h-[44px] sm:min-h-0"
                >
                  {loading ? 'Eliminando…' : 'Eliminar'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/*
        Acciones de la fila en un Menu del sistema (portal, sin recortes):
        abrir, renombrar, duplicar, exportar y eliminar.
      */}
      <Menu
        ancla={menuAncla}
        abierto={menuProject !== null}
        onCerrar={() => setRowMenuId(null)}
        ariaLabel={menuProject ? `Acciones de ${menuProject.name}` : 'Acciones del proyecto'}
      >
        {menuProject && (
          <>
            {menuProject.id !== currentProjectId && (
              <MenuItem
                icon={<FolderOpen size={14} aria-hidden="true" />}
                onClick={() => handleLoadProject(menuProject.id)}
              >
                Abrir proyecto
              </MenuItem>
            )}
            <MenuItem
              icon={<Pencil size={14} aria-hidden="true" />}
              onClick={() => startRenaming(menuProject)}
            >
              Renombrar
            </MenuItem>
            <MenuItem
              icon={<Copy size={14} aria-hidden="true" />}
              data-testid={`project-duplicate-button-${menuProject.id}`}
              onClick={() => handleDuplicate(menuProject.id)}
            >
              Duplicar proyecto
            </MenuItem>
            <MenuItem
              icon={<Download size={14} aria-hidden="true" />}
              data-testid={`project-export-button-${menuProject.id}`}
              onClick={() => handleExport(menuProject.id, 'hydra')}
            >
              Exportar (.hydra)
            </MenuItem>
            <MenuItem
              icon={<Download size={14} aria-hidden="true" />}
              onClick={() => handleExport(menuProject.id, 'json')}
            >
              Exportar (.json)
            </MenuItem>
            <MenuSeparador />
            <MenuItem
              danger
              icon={<Trash2 size={14} aria-hidden="true" />}
              onClick={() => setDeleteTarget(menuProject)}
            >
              Eliminar proyecto
            </MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
};

/**
 * Default export for `React.lazy` (bundle splitting): the modal is loaded
 * on demand instead of being part of the initial chunk. The named export
 * stays for direct imports.
 */
export default ProjectsModal;
