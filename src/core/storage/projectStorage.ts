import { get, set, del } from 'idb-keyval';
import { Project, ProjectMetadata, MediaItem, Track, AspectRatio } from '../../types/project';
import { getMediaFromOPFS } from './opfsStorage';

export const AUTOSAVE_KEY = 'web_video_editor_autosave_project';
export const PROJECTS_INDEX_KEY = 'hydra_projects_index';
export const PROJECT_PREFIX = 'hydra_project_';
export const ACTIVE_PROJECT_KEY = 'hydra_active_project_id';

export const DEFAULT_PROJECT_TRACKS: Track[] = [
  { id: 'track_text_1', name: 'Texto T1', type: 'text', isMuted: false, isLocked: false, isVisible: true },
  { id: 'track_video_2', name: 'Video V2 (Superposición)', type: 'video', isMuted: false, isLocked: false, isVisible: true },
  { id: 'track_video_1', name: 'Video V1 (Principal)', type: 'video', isMuted: false, isLocked: false, isVisible: true },
  { id: 'track_audio_1', name: 'Audio A1', type: 'audio', isMuted: false, isLocked: false, isVisible: true },
];

function logStorageError(msg: string, err: unknown): void {
  const e = err as Error | undefined;
  if (e?.name === 'ReferenceError' || e?.message?.includes('indexedDB is not defined')) {
    return;
  }
  console.error(msg, err);
}

export interface HydraProjectFile {
  version: number;
  app: 'HydraCut';
  exportedAt: number;
  project: Project;
}

/**
 * Extracts a lightweight ProjectMetadata record from a full Project.
 */
export function extractMetadata(project: Project): ProjectMetadata {
  return {
    id: project.id,
    name: project.name,
    aspectRatio: project.aspectRatio || '16:9',
    duration: project.duration || 30,
    tracksCount: Array.isArray(project.tracks) ? project.tracks.length : 0,
    clipsCount: Array.isArray(project.clips) ? project.clips.length : 0,
    createdAt: project.createdAt || Date.now(),
    updatedAt: project.updatedAt || Date.now(),
  };
}

/**
 * Lists metadata for all saved projects, sorted by updatedAt descending.
 */
export async function listProjects(): Promise<ProjectMetadata[]> {
  try {
    let index = await get<ProjectMetadata[]>(PROJECTS_INDEX_KEY);
    if (!Array.isArray(index)) {
      index = [];
    }

    // Migration / recovery: If index is empty, check legacy autosaved project
    if (index.length === 0) {
      const autosaved = await get<Project>(AUTOSAVE_KEY);
      if (autosaved && autosaved.id) {
        await saveProject(autosaved);
        return [extractMetadata(autosaved)];
      }
    }

    return [...index].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch (err) {
    logStorageError('Failed to list projects:', err);
    return [];
  }
}

/**
 * Retrieves a full project by its ID from IndexedDB.
 */
export async function getProjectById(id: string): Promise<Project | null> {
  try {
    const project = await get<Project>(`${PROJECT_PREFIX}${id}`);
    if (project) return project;

    // Fallback: check legacy autosaved project if IDs match
    const autosaved = await get<Project>(AUTOSAVE_KEY);
    if (autosaved && autosaved.id === id) {
      return autosaved;
    }
    return null;
  } catch (err) {
    logStorageError(`Failed to get project by id (${id}):`, err);
    return null;
  }
}

/**
 * Saves project state to IndexedDB, updating both individual record and metadata index.
 */
export async function saveProject(project: Project): Promise<void> {
  if (!project || !project.id) return;
  try {
    const projectKey = `${PROJECT_PREFIX}${project.id}`;
    await set(projectKey, project);

    // Update metadata index
    const meta = extractMetadata(project);
    let index: ProjectMetadata[] = [];
    try {
      const existing = await get<ProjectMetadata[]>(PROJECTS_INDEX_KEY);
      if (Array.isArray(existing)) {
        index = existing;
      }
    } catch {
      index = [];
    }

    const filtered = index.filter((p) => p.id !== project.id);
    filtered.unshift(meta);
    await set(PROJECTS_INDEX_KEY, filtered);

    // Set as active project
    await set(ACTIVE_PROJECT_KEY, project.id);
  } catch (err) {
    logStorageError('Failed to save project:', err);
  }
}

/**
 * Deletes a project from IndexedDB by ID and removes it from metadata index.
 */
export async function deleteProject(id: string): Promise<void> {
  try {
    await del(`${PROJECT_PREFIX}${id}`);

    let index: ProjectMetadata[] = [];
    try {
      const existing = await get<ProjectMetadata[]>(PROJECTS_INDEX_KEY);
      if (Array.isArray(existing)) {
        index = existing;
      }
    } catch {
      index = [];
    }

    const filtered = index.filter((p) => p.id !== id);
    await set(PROJECTS_INDEX_KEY, filtered);

    const activeId = await get<string>(ACTIVE_PROJECT_KEY);
    if (activeId === id) {
      if (filtered.length > 0) {
        const sorted = [...filtered].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        await set(ACTIVE_PROJECT_KEY, sorted[0].id);
      } else {
        await del(ACTIVE_PROJECT_KEY);
      }
    }
  } catch (err) {
    logStorageError(`Failed to delete project (${id}):`, err);
  }
}

/**
 * Duplicates an existing project with decoupled IDs and stores it.
 */
export async function duplicateProject(id: string, newName?: string): Promise<Project> {
  const source = await getProjectById(id);
  if (!source) {
    throw new Error(`Proyecto no encontrado para duplicar: ${id}`);
  }

  const now = Date.now();
  const cloned: Project = JSON.parse(JSON.stringify(source));
  const newProjectId = 'proj_' + Math.random().toString(36).substring(2, 9) + '_' + now.toString(36);
  cloned.id = newProjectId;
  cloned.name = newName && newName.trim() ? newName.trim() : `${source.name} (Copia)`;
  cloned.createdAt = now;
  cloned.updatedAt = now;

  // Remap track IDs and clip trackIds so clips point to the duplicated tracks
  const trackIdMap = new Map<string, string>();
  cloned.tracks = (cloned.tracks || []).map((t, idx) => {
    const newTrackId = `track_${t.type}_${now}_${idx}`;
    trackIdMap.set(t.id, newTrackId);
    return { ...t, id: newTrackId };
  });

  cloned.clips = (cloned.clips || []).map((c, idx) => ({
    ...c,
    id: `clip_${now}_${idx}_${Math.random().toString(36).substring(2, 6)}`,
    trackId: trackIdMap.get(c.trackId) || c.trackId,
  }));

  await saveProject(cloned);
  return cloned;
}

/**
 * Renames an existing project and updates its metadata index.
 */
export async function renameProject(id: string, newName: string): Promise<void> {
  const trimmed = newName.trim();
  if (!trimmed) return;

  const project = await getProjectById(id);
  if (project) {
    project.name = trimmed;
    project.updatedAt = Date.now();
    await saveProject(project);
    return;
  }

  // If full project was not loaded, update index entry directly
  try {
    const index = await get<ProjectMetadata[]>(PROJECTS_INDEX_KEY);
    if (Array.isArray(index)) {
      const updated = index.map((p) =>
        p.id === id ? { ...p, name: trimmed, updatedAt: Date.now() } : p
      );
      await set(PROJECTS_INDEX_KEY, updated);
    }
  } catch (err) {
    logStorageError(`Failed to update project name in index (${id}):`, err);
  }
}

/**
 * Creates a new blank project with default tracks and saves it to IndexedDB.
 */
export async function createNewProject(
  name?: string,
  aspectRatio: AspectRatio = '16:9'
): Promise<Project> {
  let width = 1920;
  let height = 1080;
  if (aspectRatio === '9:16') {
    width = 1080;
    height = 1920;
  } else if (aspectRatio === '1:1') {
    width = 1080;
    height = 1080;
  }

  const now = Date.now();
  const newProject: Project = {
    id: 'proj_' + Math.random().toString(36).substring(2, 9) + '_' + now.toString(36),
    name: name && name.trim() ? name.trim() : 'Nuevo Proyecto',
    aspectRatio,
    resolution: { width, height },
    fps: 30,
    tracks: JSON.parse(JSON.stringify(DEFAULT_PROJECT_TRACKS)).map((t: Track, idx: number) => ({
      ...t,
      id: `track_${t.type}_${now.toString(36)}_${idx}_${Math.random().toString(36).substring(2, 6)}`,
    })),
    clips: [],
    mediaPool: [],
    duration: 30,
    createdAt: now,
    updatedAt: now,
  };

  await saveProject(newProject);
  return newProject;
}

/**
 * Saves project state to IndexedDB for persistent autosave (updates current project and legacy key).
 */
export async function autosaveProject(project: Project): Promise<void> {
  if (!project || !project.id) return;
  try {
    await set(AUTOSAVE_KEY, project);
    await saveProject(project);
  } catch (err) {
    logStorageError('Failed to autosave project:', err);
  }
}

/**
 * Loads autosaved / active project from IndexedDB.
 */
export async function loadAutosavedProject(): Promise<Project | null> {
  try {
    // 1. Try active project ID
    const activeId = await get<string>(ACTIVE_PROJECT_KEY);
    if (activeId) {
      const activeProject = await getProjectById(activeId);
      if (activeProject && Array.isArray(activeProject.tracks)) {
        return activeProject;
      }
    }

    // 2. Try legacy AUTOSAVE_KEY
    const legacy = await get<Project>(AUTOSAVE_KEY);
    if (legacy && Array.isArray(legacy.tracks)) {
      return legacy;
    }

    // 3. Fallback to latest project in index
    const index = await listProjects();
    if (index.length > 0) {
      const first = await getProjectById(index[0].id);
      if (first) return first;
    }

    return null;
  } catch (err) {
    logStorageError('Failed to load autosaved project:', err);
    return null;
  }
}

/**
 * Retrieves the currently active project ID.
 */
export async function getActiveProjectId(): Promise<string | null> {
  try {
    const id = await get<string>(ACTIVE_PROJECT_KEY);
    return id || null;
  } catch {
    return null;
  }
}

/**
 * Sets the active project ID.
 */
export async function setActiveProjectId(id: string): Promise<void> {
  try {
    await set(ACTIVE_PROJECT_KEY, id);
  } catch (err) {
    logStorageError('Failed to set active project id:', err);
  }
}

/**
 * Builds the export envelope for a project.
 */
export function serializeProjectForExport(project: Project): HydraProjectFile {
  return {
    version: 1,
    app: 'HydraCut',
    exportedAt: Date.now(),
    project,
  };
}

/**
 * Exports project as a downloadable .hydra or .json file.
 */
export function exportProjectToFile(project: Project, extension: 'hydra' | 'json' = 'json'): void {
  const fileContent = serializeProjectForExport(project);
  const jsonStr = JSON.stringify(fileContent, null, 2);
  const mimeType = extension === 'hydra' ? 'application/x-hydracut+json' : 'application/json';
  const blob = new Blob([jsonStr], { type: mimeType });

  if (typeof document !== 'undefined') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = project.name.toLowerCase().replace(/[^a-z0-9_-]/gi, '_');
    a.download = `${safeName || 'proyecto'}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

/**
 * Exports project as a downloadable .json file (backward-compatible alias).
 */
export function exportProjectToJson(project: Project): void {
  exportProjectToFile(project, 'json');
}

/**
 * Imports project from a File (.hydra or .json). Validates schema, rehydrates media, and saves to IndexedDB.
 */
export async function importProjectFromFile(file: File): Promise<Project> {
  let text = '';
  if (typeof file.text === 'function') {
    text = await file.text();
  } else {
    text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('El archivo no contiene un formato JSON válido.');
  }

  let candidate: Partial<Project> | null = null;

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (obj.project && typeof obj.project === 'object') {
      candidate = obj.project as Partial<Project>;
    } else if (Array.isArray(obj.tracks) || Array.isArray(obj.clips) || obj.id) {
      candidate = obj as Partial<Project>;
    }
  }

  if (!candidate || !Array.isArray(candidate.tracks) || !Array.isArray(candidate.clips)) {
    throw new Error('Archivo de proyecto no válido: faltan las pistas o clips requeridos.');
  }

  const now = Date.now();
  // Avoid silently overwriting an existing project with the same id:
  // if the id already exists in storage, mint a fresh one for the import.
  let projectId =
    candidate.id || 'proj_' + Math.random().toString(36).substring(2, 9) + '_' + now.toString(36);
  try {
    const existing = await get<Project>(`${PROJECT_PREFIX}${projectId}`);
    if (existing) {
      projectId =
        'proj_' + Math.random().toString(36).substring(2, 9) + '_' + now.toString(36);
    }
  } catch {
    // read failure -> keep candidate id; saveProject will still persist it
  }
  const validProject: Project = {
    id: projectId,
    name: candidate.name || file.name.replace(/\.(hydra|json)$/i, '') || 'Proyecto Importado',
    aspectRatio: candidate.aspectRatio || '16:9',
    resolution: candidate.resolution || { width: 1920, height: 1080 },
    fps: candidate.fps || 30,
    tracks: candidate.tracks,
    clips: candidate.clips,
    mediaPool: Array.isArray(candidate.mediaPool) ? candidate.mediaPool : [],
    duration: typeof candidate.duration === 'number' && candidate.duration > 0 ? candidate.duration : 30,
    createdAt: candidate.createdAt || now,
    updatedAt: now,
  };

  const rehydrated = await rehydrateProjectMedia(validProject);
  await saveProject(rehydrated);
  return rehydrated;
}

/**
 * Imports project from a JSON file (backward-compatible alias).
 */
export async function importProjectFromJson(file: File): Promise<Project> {
  return importProjectFromFile(file);
}

/**
 * Rehydrates blob URLs for media items loaded from OPFS or autosave.
 */
export async function rehydrateProjectMedia(project: Project): Promise<Project> {
  const updatedMediaPool: MediaItem[] = await Promise.all(
    (project.mediaPool || []).map(async (item) => {
      if (item.opfsPath) {
        try {
          const file = await getMediaFromOPFS(item.opfsPath);
          if (file) {
            const freshUrl = URL.createObjectURL(file);
            return { ...item, url: freshUrl };
          }
        } catch (err) {
          console.warn(`Could not rehydrate media ${item.name} from OPFS:`, err);
        }
      }
      return item;
    })
  );

  return {
    ...project,
    mediaPool: updatedMediaPool,
  };
}
