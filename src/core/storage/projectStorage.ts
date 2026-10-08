import { get, set } from 'idb-keyval';
import { Project, MediaItem } from '../../types/project';
import { getMediaFromOPFS } from './opfsStorage';

const AUTOSAVE_KEY = 'web_video_editor_autosave_project';

/**
 * Saves project state to IndexedDB for persistent autosave.
 */
export async function autosaveProject(project: Project): Promise<void> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    return;
  }
  try {
    await set(AUTOSAVE_KEY, project);
  } catch (err) {
    console.error('Failed to autosave project:', err);
  }
}

/**
 * Loads autosaved project from IndexedDB.
 */
export async function loadAutosavedProject(): Promise<Project | null> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    return null;
  }
  try {
    const data = await get<Project>(AUTOSAVE_KEY);
    return data || null;
  } catch (err) {
    console.error('Failed to load autosaved project:', err);
    return null;
  }
}

/**
 * Exports project as a downloadable .json file.
 */
export function exportProjectToJson(project: Project): void {
  const jsonStr = JSON.stringify(project, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name.toLowerCase().replace(/\s+/g, '_')}_project.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Imports project from a JSON file.
 */
export async function importProjectFromJson(file: File): Promise<Project> {
  const text = await file.text();
  const parsed = JSON.parse(text) as Project;
  
  if (!parsed.id || !Array.isArray(parsed.tracks) || !Array.isArray(parsed.clips)) {
    throw new Error('Archivo de proyecto no válido: faltan propiedades requeridas.');
  }
  
  return parsed;
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
