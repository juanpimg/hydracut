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
  Clock,
  Layers,
  Film,
  Copy,
  Pencil,
  Trash2,
  Download,
  Check,
  AlertTriangle,
  FolderOpen,
  Sparkles,
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

  // Export menu state
  const [exportMenuId, setExportMenuId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

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
      setExportMenuId(null);
    }
  }, [isProjectsModalOpen, refreshList]);

  // Handle ESC key to close modal
  useEffect(() => {
    if (!isProjectsModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (deleteTarget) {
          setDeleteTarget(null);
        } else if (editingId) {
          setEditingId(null);
        } else {
          setProjectsModalOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isProjectsModalOpen, deleteTarget, editingId, setProjectsModalOpen]);

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
      setExportMenuId(null);
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

  const renderAspectBadge = (ratio: AspectRatio) => {
    if (ratio === '9:16') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-pink-500/10 text-pink-400 border border-pink-500/20 text-[10px] font-mono">
          <Smartphone size={10} /> 9:16
        </span>
      );
    }
    if (ratio === '1:1') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-mono">
          <Square size={10} /> 1:1
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 text-[10px] font-mono">
        <Tv size={10} /> 16:9
      </span>
    );
  };

  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.trim().toLowerCase())
  );

  return (
    <div
      data-testid="projects-modal"
      className="fixed inset-0 bg-black/75 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-6 select-none animate-fadeIn"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="bg-dark-900 border border-dark-800 rounded-2xl w-full max-w-4xl max-h-[90vh] shadow-2xl flex flex-col overflow-hidden relative">
        {/* Drag Overlay visual cue */}
        {isDragging && (
          <div className="absolute inset-0 bg-cyan-950/80 border-2 border-dashed border-cyan-400 z-50 rounded-2xl flex flex-col items-center justify-center pointer-events-none p-6 text-center backdrop-blur-sm">
            <Upload size={48} className="text-cyan-400 animate-bounce mb-3" />
            <h3 className="text-lg font-bold text-white mb-1">Suelta tu archivo de proyecto</h3>
            <p className="text-xs text-cyan-200">Admite archivos .hydra y .json de HydraCut</p>
          </div>
        )}

        {/* Modal Header */}
        <div className="px-5 py-4 border-b border-dark-800 flex items-center justify-between bg-dark-950/80 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-400 flex items-center justify-center">
              <FolderKanban size={18} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white">Mis Proyectos</h2>
                <span className="px-2 py-0.5 rounded-full bg-dark-800 text-slate-300 text-xs font-semibold">
                  {projects.length}
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                Almacenamiento 100% privado en tu navegador (IndexedDB)
              </p>
            </div>
          </div>

          <button
            onClick={() => setProjectsModalOpen(false)}
            className="text-slate-400 hover:text-white p-2 rounded-lg hover:bg-dark-800 active:scale-95 transition"
            title="Cerrar modal (Esc)"
          >
            <X size={18} />
          </button>
        </div>

        {/* Action Bar & Search */}
        <div className="p-4 border-b border-dark-800 bg-dark-900/90 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between shrink-0">
          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleCreateNew}
              disabled={loading}
              data-testid="projects-new-btn"
              className="flex items-center gap-1.5 px-3.5 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold text-xs rounded-lg shadow-md shadow-cyan-500/20 active:scale-95 transition min-h-[36px]"
            >
              <Plus size={15} />
              <span>Nuevo Proyecto</span>
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-2 bg-dark-800 hover:bg-dark-750 text-slate-200 hover:text-white font-medium text-xs rounded-lg border border-dark-700 active:scale-95 transition min-h-[36px]"
            >
              <Upload size={14} className="text-cyan-400" />
              <span>Importar (.hydra / .json)</span>
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".hydra,.json"
              onChange={handleFileInputChange}
              className="hidden"
            />
          </div>

          {/* Search box */}
          <div className="relative flex-1 sm:max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar proyecto por nombre..."
              data-testid="projects-search"
              className="w-full bg-dark-950 border border-dark-800 focus:border-cyan-500/50 text-slate-200 placeholder-slate-500 pl-8 pr-3 py-1.5 rounded-lg text-xs outline-none transition"
            />
          </div>
        </div>

        {/* Gallery / Project List Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {filteredProjects.length === 0 ? (
            <div className="h-64 flex flex-col items-center justify-center text-center p-6 border-2 border-dashed border-dark-800 rounded-xl bg-dark-950/40">
              <FolderKanban size={36} className="text-slate-600 mb-2.5" />
              <p className="text-sm font-semibold text-slate-300">
                {searchQuery ? 'No se encontraron proyectos con ese nombre' : 'No tienes proyectos guardados aún'}
              </p>
              <p className="text-xs text-slate-500 max-w-sm mt-1 mb-4">
                {searchQuery
                  ? 'Intenta con otro término de búsqueda o limpia el filtro.'
                  : 'Crea tu primer proyecto o arrastra un archivo .hydra / .json para comenzar.'}
              </p>
              {!searchQuery && (
                <button
                  onClick={handleCreateNew}
                  className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold transition"
                >
                  Crear Proyecto Ahora
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {filteredProjects.map((p) => {
                const isActive = p.id === currentProjectId;
                const isEditing = editingId === p.id;

                return (
                  <div
                    key={p.id}
                    data-testid={`project-card-${p.id}`}
                    className={`bg-dark-950 rounded-xl border transition-all duration-200 flex flex-col justify-between overflow-hidden relative group ${
                      isActive
                        ? 'border-cyan-500/60 shadow-lg shadow-cyan-500/10 ring-1 ring-cyan-500/30'
                        : 'border-dark-800 hover:border-dark-700'
                    }`}
                  >
                    {/* Card Header & Title */}
                    <div className="p-3.5 pb-2">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        {isEditing ? (
                          <div className="flex items-center gap-1 w-full">
                            <input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRename(p.id);
                                if (e.key === 'Escape') setEditingId(null);
                              }}
                              autoFocus
                              className="w-full bg-dark-850 border border-cyan-500 px-2 py-1 rounded text-xs text-white outline-none"
                            />
                            <button
                              onClick={() => commitRename(p.id)}
                              className="p-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded transition"
                              title="Guardar nombre"
                            >
                              <Check size={13} />
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="p-1 bg-dark-800 hover:bg-dark-700 text-slate-300 rounded transition"
                              title="Cancelar"
                            >
                              <X size={13} />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 flex-1 min-w-0">
                            <h3
                              className="font-bold text-xs sm:text-sm text-white truncate group-hover:text-cyan-300 transition"
                              title={p.name}
                            >
                              {p.name}
                            </h3>
                            <button
                              onClick={() => startRenaming(p)}
                              className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-white p-1 rounded transition"
                              title="Renombrar proyecto"
                            >
                              <Pencil size={11} />
                            </button>
                          </div>
                        )}

                        {isActive && (
                          <span className="shrink-0 px-2 py-0.5 bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 rounded-full text-[10px] font-bold flex items-center gap-1">
                            <Sparkles size={9} />
                            En Edición
                          </span>
                        )}
                      </div>

                      {/* Badges bar */}
                      <div className="flex flex-wrap items-center gap-1.5 text-slate-400 text-[11px] mb-2.5">
                        {renderAspectBadge(p.aspectRatio)}

                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-dark-850 border border-dark-800 text-slate-300 font-mono text-[10px]">
                          <Clock size={10} />
                          {formatDuration(p.duration)}
                        </span>

                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-dark-850 border border-dark-800 text-slate-300 text-[10px]">
                          <Layers size={10} />
                          {p.tracksCount} {p.tracksCount === 1 ? 'pista' : 'pistas'}
                        </span>

                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-dark-850 border border-dark-800 text-slate-300 text-[10px]">
                          <Film size={10} />
                          {p.clipsCount} {p.clipsCount === 1 ? 'clip' : 'clips'}
                        </span>
                      </div>

                      {/* Last Modified Date */}
                      <p className="text-[10px] text-slate-500 flex items-center gap-1">
                        <span>Modificado:</span>
                        <span className="text-slate-400 font-medium">{formatDate(p.updatedAt)}</span>
                      </p>
                    </div>

                    {/* Card Actions Bottom Bar */}
                    <div className="px-3.5 py-2.5 bg-dark-900 border-t border-dark-800/80 flex items-center justify-between gap-1">
                      {/* Left: Load / Switch button */}
                      {isActive ? (
                        <div className="flex items-center gap-1.5 text-[11px] font-medium text-cyan-400 px-2 py-1">
                          <Check size={13} />
                          <span>Abierto</span>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleLoadProject(p.id)}
                          disabled={loading}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold shadow-sm active:scale-95 transition"
                          title="Cargar y abrir proyecto"
                        >
                          <FolderOpen size={13} />
                          <span>Cargar</span>
                        </button>
                      )}

                      {/* Right icons: Duplicate, Export, Delete */}
                      <div className="flex items-center gap-1">
                        {/* Duplicate button */}
                        <button
                          onClick={() => handleDuplicate(p.id)}
                          disabled={loading}
                          className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-dark-800 rounded-md transition"
                          title="Duplicar proyecto"
                        >
                          <Copy size={13} />
                        </button>

                        {/* Export Menu trigger */}
                        <div className="relative">
                          <button
                            onClick={() =>
                              setExportMenuId(exportMenuId === p.id ? null : p.id)
                            }
                            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-dark-800 rounded-md transition"
                            title="Exportar archivo de proyecto"
                          >
                            <Download size={13} />
                          </button>

                          {exportMenuId === p.id && (
                            <div className="absolute right-0 bottom-full mb-1 bg-dark-850 border border-dark-750 rounded-lg shadow-xl py-1 z-30 min-w-[125px]">
                              <button
                                onClick={() => handleExport(p.id, 'hydra')}
                                className="w-full px-3 py-1.5 text-left text-[11px] text-slate-200 hover:bg-dark-750 hover:text-white flex items-center justify-between"
                              >
                                <span>Archivo .hydra</span>
                                <span className="text-[9px] font-mono text-cyan-400">Nativo</span>
                              </button>
                              <button
                                onClick={() => handleExport(p.id, 'json')}
                                className="w-full px-3 py-1.5 text-left text-[11px] text-slate-200 hover:bg-dark-750 hover:text-white flex items-center justify-between"
                              >
                                <span>Archivo .json</span>
                                <span className="text-[9px] font-mono text-slate-400">JSON</span>
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Delete button */}
                        <button
                          onClick={() => setDeleteTarget(p)}
                          disabled={loading}
                          className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-md transition"
                          title="Eliminar proyecto"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Delete Confirmation Modal / Backdrop */}
        {deleteTarget && (
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-dark-900 border border-red-500/40 rounded-xl p-5 max-w-sm w-full shadow-2xl space-y-4 animate-scaleUp">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center shrink-0">
                  <AlertTriangle size={20} />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-white">¿Eliminar Proyecto?</h4>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Estás a punto de eliminar <span className="text-white font-semibold">"{deleteTarget.name}"</span>. Esta acción no se puede deshacer.
                  </p>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setDeleteTarget(null)}
                  disabled={loading}
                  className="px-3.5 py-1.5 bg-dark-800 hover:bg-dark-750 text-slate-300 rounded-lg text-xs font-medium transition"
                >
                  Cancelar
                </button>
                <button
                  onClick={confirmDelete}
                  disabled={loading}
                  className="px-3.5 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-bold transition shadow-md shadow-red-500/20"
                >
                  {loading ? 'Eliminando...' : 'Sí, Eliminar'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
