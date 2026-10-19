import { get, set, del } from 'idb-keyval';
import {
  Project,
  ProjectMetadata,
  MediaItem,
  MediaStatus,
  Track,
  Clip,
  AspectRatio,
  TrackType,
  OverlapPolicy,
  TrashEntry,
} from '../../types/project';
import * as opfsStorage from './opfsStorage';

export const AUTOSAVE_KEY = 'web_video_editor_autosave_project';
export const PROJECTS_INDEX_KEY = 'hydra_projects_index';
export const PROJECT_PREFIX = 'hydra_project_';
export const ACTIVE_PROJECT_KEY = 'hydra_active_project_id';

/**
 * Coalescing window for autosave writes (ms).
 *
 * Every store mutation used to serialise and write the whole project (base64
 * filmstrips included) twice, with no debounce: dragging a slider produced
 * ~60 full writes per second. Writes are now coalesced inside this window.
 */
export const AUTOSAVE_DEBOUNCE_MS = 500;

/** idb-keyval's default database / object store names. */
const IDB_DB_NAME = 'keyval-store';
const IDB_STORE_NAME = 'keyval';

export const DEFAULT_PROJECT_TRACKS: Track[] = [
  { id: 'track_text_1', name: 'Texto T1', type: 'text', isMuted: false, isLocked: false, isVisible: true },
  { id: 'track_video_2', name: 'Video V2 (Superposición)', type: 'video', isMuted: false, isLocked: false, isVisible: true },
  { id: 'track_video_1', name: 'Video V1 (Principal)', type: 'video', isMuted: false, isLocked: false, isVisible: true },
  { id: 'track_audio_1', name: 'Audio A1', type: 'audio', isMuted: false, isLocked: false, isVisible: true },
];

/* ------------------------------------------------------------------ */
/* Storage events (S-08) — surface persistence failures to the UI     */
/* ------------------------------------------------------------------ */

export type StorageScope = 'autosave' | 'save' | 'delete' | 'import' | 'export' | 'media';

export interface StorageErrorEvent {
  type: 'error';
  scope: StorageScope;
  /** Human readable, ready to show in the UI. */
  message: string;
  error: unknown;
  quotaExceeded: boolean;
  at: number;
}

export interface StorageNoticeEvent {
  type: 'notice';
  scope: StorageScope;
  message: string;
  details?: unknown;
  at: number;
}

export type StorageEvent = StorageErrorEvent | StorageNoticeEvent;

const storageEventListeners = new Set<(event: StorageEvent) => void>();
let lastStorageEvent: StorageEvent | null = null;

/**
 * Subscribes to persistence failures and notices.
 * Returns the unsubscribe function.
 */
export function subscribeStorageEvents(listener: (event: StorageEvent) => void): () => void {
  storageEventListeners.add(listener);
  return () => {
    storageEventListeners.delete(listener);
  };
}

/** The last published storage event (or null). */
export function getLastStorageEvent(): StorageEvent | null {
  return lastStorageEvent;
}

function publishStorageEvent(event: StorageEvent): void {
  lastStorageEvent = event;
  storageEventListeners.forEach((listener) => {
    try {
      listener(event);
    } catch (err) {
      console.error('Storage event listener threw:', err);
    }
  });
}

function isQuotaExceededError(err: unknown): boolean {
  const e = err as { name?: string; code?: number } | null;
  if (!e) return false;
  return e.name === 'QuotaExceededError' || e.code === 22;
}

/**
 * True when the failure is caused by the environment not having IndexedDB at
 * all (SSR / unit tests). Those are not user facing problems.
 */
function isUnsupportedEnvironment(err: unknown): boolean {
  const e = err as Error | undefined;
  return e?.name === 'ReferenceError' || !!e?.message?.includes('indexedDB is not defined');
}

/**
 * Reports a persistence failure: keeps the console error (so it is still
 * debuggable) AND publishes it through the observable channel so the UI can
 * warn the user that their work is *not* being saved.
 */
function reportStorageError(scope: StorageScope, err: unknown, context: string): void {
  if (isUnsupportedEnvironment(err)) return;

  console.error(context, err);
  const quota = isQuotaExceededError(err);
  publishStorageEvent({
    type: 'error',
    scope,
    message: quota
      ? 'Almacenamiento lleno: no se pudo guardar el proyecto. Libera espacio y vuelve a intentarlo.'
      : 'No se pudo guardar el proyecto. Tu trabajo puede perderse si cierras la pestaña.',
    error: err,
    quotaExceeded: quota,
    at: Date.now(),
  });
}

function reportStorageNotice(scope: StorageScope, message: string, details?: unknown): void {
  publishStorageEvent({ type: 'notice', scope, message, details, at: Date.now() });
}

/* ------------------------------------------------------------------ */
/* Object URL registry (C2)                                            */
/* ------------------------------------------------------------------ */

interface ObjectUrlEntry {
  projectId: string;
  mediaId: string;
  url: string;
}

/** projectId -> object URLs created for its media. */
const objectUrlRegistry = new Map<string, ObjectUrlEntry>();
/** Project that currently owns the live object URLs. */
let activeUrlProjectId: string | null = null;

function registryKey(projectId: string, mediaId: string): string {
  return `${projectId}::${mediaId}`;
}

function revokeUrl(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn('Failed to revoke object URL:', err);
  }
}

function revokeEntry(entry: ObjectUrlEntry): void {
  revokeUrl(entry.url);
  objectUrlRegistry.delete(registryKey(entry.projectId, entry.mediaId));
}

/**
 * Revokes every object URL created for a project (and forgets them).
 */
export function revokeProjectObjectUrls(projectId: string): void {
  if (!projectId) return;
  for (const entry of Array.from(objectUrlRegistry.values())) {
    if (entry.projectId === projectId) revokeEntry(entry);
  }
  if (activeUrlProjectId === projectId) activeUrlProjectId = null;
}

/**
 * Revokes every object URL tracked by the registry (all projects).
 */
export function revokeAllObjectUrls(): void {
  for (const entry of Array.from(objectUrlRegistry.values())) revokeEntry(entry);
  objectUrlRegistry.clear();
  activeUrlProjectId = null;
}

/**
 * Revokes the object URLs owned by the given media items and removes them
 * from the registry. Call it when a media item leaves the project.
 */
export function revokeMediaObjectUrls(items: MediaItem | MediaItem[]): void {
  const list = Array.isArray(items) ? items : [items];
  const targets = new Set<string>();
  for (const item of list) {
    if (!item) continue;
    if (typeof item.url === 'string' && item.url.startsWith('blob:')) targets.add(item.url);
    if (typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.startsWith('blob:')) targets.add(item.thumbnailUrl);
  }
  if (targets.size === 0) return;

  for (const entry of Array.from(objectUrlRegistry.values())) {
    if (targets.has(entry.url)) objectUrlRegistry.delete(registryKey(entry.projectId, entry.mediaId));
  }
  targets.forEach(revokeUrl);
}

/* ------------------------------------------------------------------ */
/* Project index helpers (pure) + atomic index writes (S-07)          */
/* ------------------------------------------------------------------ */

/**
 * Pure merge: puts `meta` first and removes any previous entry with the same
 * id. Exported so it can be unit tested without IndexedDB.
 */
export function mergeProjectMetadata(
  index: ProjectMetadata[] | null | undefined,
  meta: ProjectMetadata
): ProjectMetadata[] {
  const base = Array.isArray(index) ? index.filter((p) => p && typeof p.id === 'string') : [];
  return [meta, ...base.filter((p) => p.id !== meta.id)];
}

/**
 * Pure removal of a project from the index.
 */
export function removeProjectMetadata(
  index: ProjectMetadata[] | null | undefined,
  id: string
): ProjectMetadata[] {
  const base = Array.isArray(index) ? index.filter((p) => p && typeof p.id === 'string') : [];
  return base.filter((p) => p.id !== id);
}

/**
 * Pure in-place update of a project entry (used by rename).
 */
export function updateProjectMetadata(
  index: ProjectMetadata[] | null | undefined,
  id: string,
  patch: Partial<ProjectMetadata>
): ProjectMetadata[] {
  const base = Array.isArray(index) ? index.filter((p) => p && typeof p.id === 'string') : [];
  return base.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

/** Serialises index read-modify-write operations inside this tab. */
let indexLock: Promise<unknown> = Promise.resolve();

function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = indexLock.then(fn, fn);
  indexLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

let rawDb: IDBDatabase | null = null;

/**
 * Opens a raw connection to idb-keyval's database so a single transaction can
 * read *and* write. Returns null when IndexedDB is unavailable.
 */
function openRawDatabase(): Promise<IDBDatabase | null> {
  const factory = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) return Promise.resolve(null);
  if (rawDb) return Promise.resolve(rawDb);

  return new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(IDB_DB_NAME);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      // Mirror idb-keyval's schema when the database is created from here.
      try {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
          db.createObjectStore(IDB_STORE_NAME);
        }
      } catch {
        /* ignore */
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        if (rawDb === db) rawDb = null;
      };
      rawDb = db;
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

interface AtomicWritePlan {
  /** Plain key/value pairs written in the same transaction. */
  puts: Array<[string, unknown]>;
  /** Optional read-modify-write of the project index. */
  indexMutator?: (index: ProjectMetadata[]) => ProjectMetadata[];
}

/**
 * Runs a single readwrite IndexedDB transaction that performs the planned
 * writes. Returns false when the atomic path is not available so the caller
 * can fall back to sequential writes.
 */
async function runAtomicWrite(plan: AtomicWritePlan): Promise<boolean> {
  const db = await openRawDatabase();
  if (!db) return false;

  try {
    await new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      } catch (err) {
        reject(err);
        return;
      }
      const store = tx.objectStore(IDB_STORE_NAME);

      try {
        for (const [key, value] of plan.puts) store.put(value, key);

        if (plan.indexMutator) {
          const request = store.get(PROJECTS_INDEX_KEY);
          request.onsuccess = () => {
            try {
              const current = request.result;
              const next = plan.indexMutator!(Array.isArray(current) ? current : []);
              store.put(next, PROJECTS_INDEX_KEY);
            } catch (err) {
              try {
                tx.abort();
              } catch {
                /* ignore */
              }
              reject(err);
            }
          };
          request.onerror = () => reject(request.error);
        }
      } catch (err) {
        try {
          tx.abort();
        } catch {
          /* ignore */
        }
        reject(err);
        return;
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
    return true;
  } catch (err) {
    // The cached connection may be stale (database deleted / upgraded):
    // drop it so the next call opens a fresh one.
    if (rawDb) {
      try {
        rawDb.close();
      } catch {
        /* ignore */
      }
      rawDb = null;
    }
    console.warn('Atomic IndexedDB write failed, falling back to sequential writes:', err);
    return false;
  }
}

async function writeEntriesSequentially(plan: AtomicWritePlan): Promise<void> {
  for (const [key, value] of plan.puts) {
    await set(key, value);
  }
  if (plan.indexMutator) {
    const current = await get<ProjectMetadata[]>(PROJECTS_INDEX_KEY);
    const next = plan.indexMutator(Array.isArray(current) ? current : []);
    await set(PROJECTS_INDEX_KEY, next);
  }
}

/**
 * Atomically updates the project index. The read and the write happen inside
 * a single IndexedDB transaction, so two concurrent saves can no longer drop
 * a project from the gallery.
 *
 * NOTE: this helper does NOT take the index lock (callers that need it use
 * {@link updateProjectIndex}); nesting the lock would deadlock.
 */
async function updateProjectIndexUnlocked(
  mutator: (index: ProjectMetadata[]) => ProjectMetadata[]
): Promise<ProjectMetadata[]> {
  let result: ProjectMetadata[] = [];
  const plan: AtomicWritePlan = {
    puts: [],
    indexMutator: (index) => {
      result = mutator(index);
      return result;
    },
  };

  const atomic = await runAtomicWrite(plan);
  if (!atomic) {
    await writeEntriesSequentially(plan);
  }
  return result;
}

/**
 * Serialised + atomic update of the project index.
 */
async function updateProjectIndex(
  mutator: (index: ProjectMetadata[]) => ProjectMetadata[]
): Promise<ProjectMetadata[]> {
  return withIndexLock(() => updateProjectIndexUnlocked(mutator));
}

/* ------------------------------------------------------------------ */
/* Metadata / project CRUD                                             */
/* ------------------------------------------------------------------ */

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
 * Legacy autosave key payload: a pointer instead of a second full copy of the
 * project. Reading still supports the old "full project" format.
 */
interface LegacyAutosavePointer {
  kind: 'pointer';
  id: string;
  projectId: string;
  savedAt: number;
}

function createLegacyPointer(project: Project): LegacyAutosavePointer {
  return { kind: 'pointer', id: project.id, projectId: project.id, savedAt: Date.now() };
}

function isLegacyPointer(value: unknown): value is LegacyAutosavePointer {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.kind === 'pointer' && typeof v.id === 'string';
}

/**
 * Resolves the legacy autosave slot, supporting both the pointer format and
 * the old "full project" format.
 */
async function resolveLegacyAutosave(): Promise<Project | null> {
  let raw: unknown;
  try {
    raw = await get<unknown>(AUTOSAVE_KEY);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;

  if (isLegacyPointer(raw)) {
    try {
      // Read the record directly: going through getProjectById() would
      // recurse into this resolver.
      const project = await get<Project>(`${PROJECT_PREFIX}${raw.id}`);
      return project ?? null;
    } catch {
      return null;
    }
  }
  const asProject = raw as Project;
  if (Array.isArray(asProject.tracks)) return asProject;
  return null;
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
      const autosaved = await resolveLegacyAutosave();
      if (autosaved && autosaved.id) {
        await saveProject(autosaved);
        return [extractMetadata(autosaved)];
      }
    }

    return [...index].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch (err) {
    reportStorageError('save', err, 'Failed to list projects:');
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
    const autosaved = await resolveLegacyAutosave();
    if (autosaved && autosaved.id === id) {
      return autosaved;
    }
    return null;
  } catch (err) {
    reportStorageError('save', err, `Failed to get project by id (${id}):`);
    return null;
  }
}

/**
 * Saves project state to IndexedDB, updating both individual record and metadata index.
 */
export async function saveProject(project: Project): Promise<void> {
  if (!project || !project.id) return;
  try {
    // The project document and the index entry are written in a single
    // transaction: a crash can no longer leave the gallery out of sync.
    await withIndexLock(async () => {
      const atomic = await runAtomicWrite({
        puts: [[`${PROJECT_PREFIX}${project.id}`, project]],
        indexMutator: (index) => mergeProjectMetadata(index, extractMetadata(project)),
      });
      if (!atomic) {
        await set(`${PROJECT_PREFIX}${project.id}`, project);
        await updateProjectIndexUnlocked((index) =>
          mergeProjectMetadata(index, extractMetadata(project))
        );
      }
    });

    // Set as active project
    await set(ACTIVE_PROJECT_KEY, project.id);
  } catch (err) {
    reportStorageError('save', err, 'Failed to save project:');
  }
}

/**
 * Deletes a project from IndexedDB by ID and removes it from metadata index.
 * The media files owned by the project (OPFS + IndexedDB fallback) are
 * removed as well, otherwise the storage quota grows without bound.
 */
export async function deleteProject(id: string): Promise<void> {
  try {
    // A pending autosave must not resurrect the project after the deletion.
    cancelPendingAutosave(id);

    // Collect the media files before the record disappears.
    const project = await getProjectById(id);
    if (project) {
      await deleteProjectMediaFiles(project);
    }

    await del(`${PROJECT_PREFIX}${id}`);

    const filtered = await updateProjectIndex((index) => removeProjectMetadata(index, id));

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
    reportStorageError('delete', err, `Failed to delete project (${id}):`);
  }
}

/**
 * Deletes the media files (OPFS + IndexedDB fallback) owned by a project and
 * revokes the object URLs created for them.
 *
 * The media of the trash is deleted too: the project is gone, so nothing can
 * be restored from it anymore.
 */
export async function deleteProjectMediaFiles(project: Project): Promise<void> {
  const items = Array.isArray(project?.mediaPool) ? project.mediaPool : [];
  const trashed = Array.isArray(project?.trash)
    ? project.trash.map((entry) => entry?.media).filter(Boolean)
    : [];
  await deleteMediaFiles([...items, ...trashed]);
}

/**
 * How a media item leaves the project.
 *
 * - `purge`: the media is destroyed for good. The OPFS blob is deleted and the
 *   object URL is revoked.
 * - `trash`: the media leaves the project but stays recoverable. The bytes
 *   stay in OPFS and the object URL stays alive, so the media can be restored
 *   (F2) without touching the disk again. The physical deletion happens later,
 *   when the trash is purged.
 */
export type MediaRemovalMode = 'purge' | 'trash';

/**
 * Deletes the media files (OPFS + IndexedDB fallback) of the given media
 * items and revokes their object URLs.
 *
 * The store must call this when a media item is removed from the project,
 * otherwise the media files stay in OPFS forever.
 *
 * @param mode `trash` keeps the bytes (the media can be restored), `purge`
 *             deletes them for good.
 */
export async function deleteMediaFiles(
  items: MediaItem | MediaItem[],
  mode: MediaRemovalMode = 'purge'
): Promise<void> {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (list.length === 0) return;

  // F2: the media is NOT destroyed: it waits in the trash. Neither the OPFS
  // blob nor the object URL are touched, so a restore is lossless.
  if (mode === 'trash') return;

  const paths = list
    .map((item) => (item && typeof item.opfsPath === 'string' ? item.opfsPath : ''))
    .filter((p) => p.length > 0);

  if (paths.length > 0) {
    const deleter = resolveOpfsDeleter();
    if (deleter) {
      await deleter(paths);
    } else {
      console.warn('OPFS media deletion is unavailable in this environment.');
    }
  }

  revokeMediaObjectUrls(list);
}

/**
 * Resolves the OPFS batch deleter defensively: some unit-test suites mock the
 * opfsStorage module with a partial surface, and a missing export must not
 * break the deletion flow.
 */
function resolveOpfsDeleter(): ((fileNames: string[]) => Promise<void>) | null {
  try {
    const mod = opfsStorage as unknown as Record<string, unknown>;
    const fn = mod['deleteMediaFilesFromOPFS'];
    return typeof fn === 'function' ? (fn as (fileNames: string[]) => Promise<void>) : null;
  } catch {
    return null;
  }
}

/**
 * Replaces the bytes of a media item with a new local file (F3).
 *
 * The media KEEPS ITS ID (so the clips that use it keep working) and its
 * object URL is renewed. The previous file is deleted from OPFS so the
 * relink does not leave an orphan behind.
 *
 * Returns `null` when the new file could not be stored.
 */
export async function relinkMediaBytes(
  item: MediaItem,
  file: File,
  projectId?: string
): Promise<MediaItem | null> {
  if (!item || !file) return null;

  const previousPath = typeof item.opfsPath === 'string' ? item.opfsPath : '';
  let opfsPath: string | undefined;
  try {
    opfsPath = await opfsStorage.saveMediaToOPFS(item.id, file);
  } catch (err) {
    console.warn('Could not store the relinked media file:', err);
    return null;
  }

  // The old file is an orphan now: delete it (the quota must not grow).
  if (previousPath && previousPath !== opfsPath) {
    const deleter = resolveOpfsDeleter();
    if (deleter) {
      await deleter([previousPath]);
    }
  }

  // Renew the object URL: the previous one pointed to the old bytes.
  let url = '';
  try {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      url = URL.createObjectURL(file);
      if (projectId) {
        const key = registryKey(projectId, item.id);
        // The registry is keyed by (project, media): the previous entry of
        // this media is replaced so the old URL is revoked exactly once.
        const previous = objectUrlRegistry.get(key);
        if (previous) revokeEntry(previous);
        objectUrlRegistry.set(key, { projectId, mediaId: item.id, url });
      }
    }
  } catch (err) {
    console.warn('Could not create the object URL of the relinked media:', err);
  }

  // The previous object URL is dead: revoke it (the new one replaces it).
  revokeMediaObjectUrls([{ ...item, url: item.url, thumbnailUrl: '' }]);

  return {
    ...item,
    url,
    opfsPath: opfsPath ?? item.opfsPath,
    size: file.size,
    status: 'ok',
    thumbnailUrl: item.type === 'image' ? url : item.thumbnailUrl,
  };
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
    await updateProjectIndex((index) =>
      updateProjectMetadata(index, id, { name: trimmed, updatedAt: Date.now() })
    );
  } catch (err) {
    reportStorageError('save', err, `Failed to update project name in index (${id}):`);
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
    // F1/F2: the overlap policy and the media trash of a new project.
    overlapPolicy: 'block',
    trash: [],
    createdAt: now,
    updatedAt: now,
  };

  await saveProject(newProject);
  return newProject;
}

/* ------------------------------------------------------------------ */
/* Autosave (C3)                                                       */
/* ------------------------------------------------------------------ */

interface PendingAutosave {
  project: Project;
  timer: ReturnType<typeof setTimeout> | null;
  resolvers: Array<() => void>;
}

let pendingAutosave: PendingAutosave | null = null;
let flushListenersInstalled = false;

function installFlushListeners(): void {
  if (flushListenersInstalled) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  flushListenersInstalled = true;

  const flush = () => {
    void flushAutosave();
  };
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

/**
 * Saves project state to IndexedDB for persistent autosave.
 *
 * The write is debounced (see {@link AUTOSAVE_DEBOUNCE_MS}): consecutive
 * mutations are coalesced into a single write, and the returned promise
 * resolves once the pending write has actually been persisted.
 *
 * The signature is backwards compatible: `await autosaveProject(p)` still
 * guarantees that `p` is on disk when it resolves.
 */
export function autosaveProject(project: Project): Promise<void> {
  if (!project || !project.id) return Promise.resolve();

  installFlushListeners();

  return new Promise<void>((resolve) => {
    if (pendingAutosave) {
      // Last write wins: only the newest snapshot is persisted.
      pendingAutosave.project = project;
      pendingAutosave.resolvers.push(resolve);
    } else {
      pendingAutosave = { project, timer: null, resolvers: [resolve] };
    }

    if (pendingAutosave.timer !== null) clearTimeout(pendingAutosave.timer);
    const timer = setTimeout(() => {
      void flushAutosave();
    }, AUTOSAVE_DEBOUNCE_MS);
    // Do not keep a Node process alive just for the debounce timer.
    const maybeUnref = timer as unknown as { unref?: () => void };
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
    pendingAutosave.timer = timer;
  });
}

/**
 * Writes the pending autosave immediately (if any).
 */
export async function flushAutosave(): Promise<void> {
  const pending = pendingAutosave;
  if (!pending) return;
  pendingAutosave = null;
  if (pending.timer !== null) clearTimeout(pending.timer);

  try {
    await persistProject(pending.project);
  } catch (err) {
    reportStorageError('autosave', err, 'Failed to autosave project:');
  } finally {
    pending.resolvers.forEach((resolve) => resolve());
  }
}

/**
 * Drops a pending autosave (e.g. because the project was deleted: a late
 * flush must not resurrect it).
 */
function cancelPendingAutosave(projectId: string): void {
  if (!pendingAutosave) return;
  if (pendingAutosave.project.id !== projectId) return;
  if (pendingAutosave.timer !== null) clearTimeout(pendingAutosave.timer);
  pendingAutosave.resolvers.forEach((resolve) => resolve());
  pendingAutosave = null;
}

/**
 * Persists a project: record + index (atomic) + legacy pointer.
 */
async function persistProject(project: Project): Promise<void> {
  await withIndexLock(async () => {
    const atomic = await runAtomicWrite({
      puts: [
        [`${PROJECT_PREFIX}${project.id}`, project],
        [AUTOSAVE_KEY, createLegacyPointer(project)],
      ],
      indexMutator: (index) => mergeProjectMetadata(index, extractMetadata(project)),
    });

    if (!atomic) {
      await set(`${PROJECT_PREFIX}${project.id}`, project);
      await set(AUTOSAVE_KEY, createLegacyPointer(project));
      await updateProjectIndexUnlocked((index) =>
        mergeProjectMetadata(index, extractMetadata(project))
      );
    }
  });

  // Only claim the "active project" slot when it is free or already ours:
  // a late flush must not steal the focus from a project opened meanwhile.
  const activeId = await get<string>(ACTIVE_PROJECT_KEY);
  if (!activeId || activeId === project.id) {
    await set(ACTIVE_PROJECT_KEY, project.id);
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
    const legacy = await resolveLegacyAutosave();
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
    reportStorageError('save', err, 'Failed to load autosaved project:');
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
    reportStorageError('save', err, 'Failed to set active project id:');
  }
}

/* ------------------------------------------------------------------ */
/* Export / import (S-15 / S-16)                                       */
/* ------------------------------------------------------------------ */

export interface HydraProjectFile {
  version: number;
  app: 'HydraCut';
  exportedAt: number;
  project: Project;
  /**
   * v1 project files never embedded the media bytes. The flag is explicit so
   * an importer can tell "media-less export" from "media was supposed to be
   * there but is missing".
   */
  mediaEmbedded?: boolean;
  /** Number of media items referenced by the project (not embedded). */
  mediaCount?: number;
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
    mediaEmbedded: false,
    mediaCount: Array.isArray(project.mediaPool) ? project.mediaPool.length : 0,
  };
}

/**
 * Exports project as a downloadable .hydra or .json file.
 *
 * The exported file does NOT contain the media bytes: it is a media-less
 * project file. The name says so explicitly (`<name>-sin-medios.hydra`) and a
 * notice is published so the UI can warn the user.
 */
export function exportProjectToFile(project: Project, extension: 'hydra' | 'json' = 'json'): void {
  const fileContent = serializeProjectForExport(project);
  const jsonStr = JSON.stringify(fileContent, null, 2);
  const mimeType = extension === 'hydra' ? 'application/x-hydracut+json' : 'application/json';
  const blob = new Blob([jsonStr], { type: mimeType });

  reportStorageNotice(
    'export',
    'El archivo exportado no incluye los archivos multimedia: reimportarlo no recuperará los clips.',
    { mediaCount: fileContent.mediaCount }
  );

  if (typeof document !== 'undefined') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = project.name.toLowerCase().replace(/[^a-z0-9_-]/gi, '_');
    a.download = `${safeName || 'proyecto'}-sin-medios.${extension}`;
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

/* ----------------------------- validation ---------------------------- */

const MIN_DIMENSION = 16;
const MAX_DIMENSION = 7680;
const MIN_FPS = 1;
const MAX_FPS = 120;
const MIN_CLIP_DURATION = 0.1;

/**
 * Normalises a width/height ratio to the closest supported aspect ratio.
 */
export function normalizeAspectRatio(width: number, height: number): AspectRatio {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '16:9';
  }
  const ratio = width / height;
  const candidates: Array<{ value: AspectRatio; target: number }> = [
    { value: '16:9', target: 16 / 9 },
    { value: '9:16', target: 9 / 16 },
    { value: '1:1', target: 1 },
  ];
  let best = candidates[0];
  for (const candidate of candidates) {
    if (Math.abs(ratio - candidate.target) < Math.abs(best.target - candidate.target)) {
      best = candidate;
    }
  }
  return best.value;
}

/**
 * Clamps a resolution to sane bounds.
 */
export function clampResolution(resolution: unknown): { width: number; height: number } {
  const raw = (resolution ?? {}) as { width?: unknown; height?: unknown };
  const parsedWidth = Math.round(Number(raw.width));
  const parsedHeight = Math.round(Number(raw.height));
  const width = Number.isFinite(parsedWidth)
    ? Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, parsedWidth))
    : 1920;
  const height = Number.isFinite(parsedHeight)
    ? Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, parsedHeight))
    : 1080;
  return { width, height };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export interface ProjectSanitizeResult {
  project: Project;
  warnings: string[];
  droppedClips: number;
  droppedTracks: number;
  droppedMedia: number;
}

/**
 * Validates and sanitises a project coming from an untrusted file:
 * clips pointing at non-existent tracks are dropped, the resolution is
 * clamped and the aspect ratio is normalised.
 */
export function sanitizeImportedProject(
  candidate: Partial<Project>,
  context: { projectId: string; fallbackName: string; now?: number }
): ProjectSanitizeResult {
  const warnings: string[] = [];
  const now = context.now ?? Date.now();

  /* ------------------------------ tracks ------------------------------ */
  const rawTracks = Array.isArray(candidate.tracks) ? candidate.tracks : [];
  const seenTrackIds = new Set<string>();
  const tracks: Track[] = [];
  let droppedTracks = 0;

  for (const raw of rawTracks) {
    if (!raw || typeof raw !== 'object') {
      droppedTracks++;
      continue;
    }
    const t = raw as Partial<Track>;
    if (typeof t.id !== 'string' || t.id.length === 0) {
      droppedTracks++;
      continue;
    }
    if (seenTrackIds.has(t.id)) {
      droppedTracks++;
      warnings.push(`Pista duplicada "${t.id}": se descartó.`);
      continue;
    }
    const type: TrackType = t.type === 'audio' || t.type === 'text' ? t.type : 'video';
    if (t.type !== type) {
      warnings.push(`Pista "${t.id}": tipo "${String(t.type)}" no válido, se usó "${type}".`);
    }
    seenTrackIds.add(t.id);
    tracks.push({
      id: t.id,
      name: typeof t.name === 'string' && t.name.length > 0 ? t.name : `Pista ${tracks.length + 1}`,
      type,
      isMuted: !!t.isMuted,
      isLocked: !!t.isLocked,
      isVisible: t.isVisible === undefined ? true : !!t.isVisible,
    });
  }

  if (tracks.length === 0) {
    throw new Error('Archivo de proyecto no válido: no contiene ninguna pista válida.');
  }

  /* ------------------------------- clips ------------------------------ */
  const rawClips = Array.isArray(candidate.clips) ? candidate.clips : [];
  const clips: Clip[] = [];
  const seenClipIds = new Set<string>();
  let droppedClips = 0;

  for (const raw of rawClips) {
    if (!raw || typeof raw !== 'object') {
      droppedClips++;
      continue;
    }
    const c = raw as Partial<Clip>;
    if (typeof c.id !== 'string' || c.id.length === 0) {
      droppedClips++;
      continue;
    }
    if (seenClipIds.has(c.id)) {
      droppedClips++;
      warnings.push(`Clip duplicado "${c.id}": se descartó.`);
      continue;
    }
    if (typeof c.trackId !== 'string' || !seenTrackIds.has(c.trackId)) {
      droppedClips++;
      warnings.push(
        `Clip "${typeof c.name === 'string' ? c.name : c.id}": apunta a una pista inexistente y se descartó.`
      );
      continue;
    }
    const start = Number(c.start);
    const duration = Number(c.duration);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration < MIN_CLIP_DURATION) {
      droppedClips++;
      warnings.push(
        `Clip "${typeof c.name === 'string' ? c.name : c.id}": datos de tiempo inválidos y se descartó.`
      );
      continue;
    }
    seenClipIds.add(c.id);
    const speed = clampNumber(c.speed, 0.1, 10, 1);
    clips.push({
      id: c.id,
      trackId: c.trackId,
      mediaId: typeof c.mediaId === 'string' ? c.mediaId : '',
      name: typeof c.name === 'string' && c.name.length > 0 ? c.name : 'Clip',
      type: c.type === 'audio' || c.type === 'text' || c.type === 'image' ? c.type : 'video',
      start: Math.max(0, start),
      duration,
      sourceStart: Math.max(0, Number.isFinite(Number(c.sourceStart)) ? Number(c.sourceStart) : 0),
      sourceDuration: Math.max(
        0,
        Number.isFinite(Number(c.sourceDuration)) ? Number(c.sourceDuration) : duration
      ),
      volume: clampNumber(c.volume, 0, 2, 1),
      opacity: clampNumber(c.opacity, 0, 1, 1),
      scale: clampNumber(c.scale, 0.1, 3, 1),
      positionX: Number.isFinite(Number(c.positionX)) ? Number(c.positionX) : 0,
      positionY: Number.isFinite(Number(c.positionY)) ? Number(c.positionY) : 0,
      muted: !!c.muted,
      speed,
      text: typeof c.text === 'string' ? c.text : undefined,
      textStyle: c.textStyle,
      words: Array.isArray(c.words) ? c.words : undefined,
      transition: c.transition,
    });
  }

  /* ------------------------------- media ------------------------------ */
  const rawMedia = Array.isArray(candidate.mediaPool) ? candidate.mediaPool : [];
  const mediaPool: MediaItem[] = [];
  let droppedMedia = 0;

  /**
   * Sanitises a media item coming from an untrusted file.
   * Returns null when the item is unusable.
   */
  const sanitizeMediaItem = (raw: unknown): MediaItem | null => {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Partial<MediaItem>;
    if (typeof m.id !== 'string' || m.id.length === 0) return null;
    const status: MediaStatus | undefined =
      m.status === 'missing' || m.status === 'error' ? m.status : undefined;
    return {
      id: m.id,
      name: typeof m.name === 'string' && m.name.length > 0 ? m.name : 'Medio',
      type: m.type === 'audio' || m.type === 'image' ? m.type : 'video',
      url: typeof m.url === 'string' ? m.url : '',
      duration: clampNumber(m.duration, 0, 24 * 3600, 0),
      width: clampNumber(m.width, 0, MAX_DIMENSION, 0),
      height: clampNumber(m.height, 0, MAX_DIMENSION, 0),
      fps: clampNumber(m.fps, 0, MAX_FPS, 30),
      thumbnailUrl: typeof m.thumbnailUrl === 'string' ? m.thumbnailUrl : '',
      thumbnails: Array.isArray(m.thumbnails)
        ? m.thumbnails.filter((t): t is string => typeof t === 'string')
        : undefined,
      waveformPeaks: Array.isArray(m.waveformPeaks)
        ? m.waveformPeaks.filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
        : undefined,
      size: clampNumber(m.size, 0, Number.MAX_SAFE_INTEGER, 0),
      createdAt: Number.isFinite(Number(m.createdAt)) ? Number(m.createdAt) : now,
      opfsPath: typeof m.opfsPath === 'string' && m.opfsPath.length > 0 ? m.opfsPath : undefined,
      status,
    };
  };

  for (const raw of rawMedia) {
    const item = sanitizeMediaItem(raw);
    if (!item) {
      droppedMedia++;
      continue;
    }
    mediaPool.push(item);
  }

  /* -------------------------------- trash ------------------------------ */
  // F2: the trash of an imported project is sanitised too (the media and the
  // clips that were removed with it).
  const rawTrash = Array.isArray(candidate.trash) ? candidate.trash : [];
  const trash: TrashEntry[] = [];
  for (const raw of rawTrash) {
    if (!raw || typeof raw !== 'object') {
      droppedMedia++;
      continue;
    }
    const entry = raw as Partial<TrashEntry>;
    const media = sanitizeMediaItem(entry.media);
    if (!media) {
      droppedMedia++;
      continue;
    }
    const entryClips: Clip[] = [];
    for (const rawClip of Array.isArray(entry.clips) ? entry.clips : []) {
      if (!rawClip || typeof rawClip !== 'object') continue;
      const c = rawClip as Partial<Clip>;
      if (typeof c.id !== 'string' || c.id.length === 0) continue;
      if (typeof c.trackId !== 'string' || !seenTrackIds.has(c.trackId)) continue;
      const start = Number(c.start);
      const duration = Number(c.duration);
      if (!Number.isFinite(start) || !Number.isFinite(duration) || duration < MIN_CLIP_DURATION) continue;
      entryClips.push({
        ...c,
        id: c.id,
        trackId: c.trackId,
        mediaId: media.id,
        name: typeof c.name === 'string' && c.name.length > 0 ? c.name : media.name,
        type: c.type === 'audio' || c.type === 'text' || c.type === 'image' ? c.type : media.type,
        start: Math.max(0, start),
        duration,
        sourceStart: Math.max(0, Number.isFinite(Number(c.sourceStart)) ? Number(c.sourceStart) : 0),
        sourceDuration: Math.max(
          0,
          Number.isFinite(Number(c.sourceDuration)) ? Number(c.sourceDuration) : duration
        ),
        volume: clampNumber(c.volume, 0, 2, 1),
        opacity: clampNumber(c.opacity, 0, 1, 1),
        scale: clampNumber(c.scale, 0.1, 3, 1),
        positionX: Number.isFinite(Number(c.positionX)) ? Number(c.positionX) : 0,
        positionY: Number.isFinite(Number(c.positionY)) ? Number(c.positionY) : 0,
        muted: !!c.muted,
        speed: clampNumber(c.speed, 0.1, 10, 1),
      } as Clip);
    }
    trash.push({
      media,
      clips: entryClips,
      deletedAt: Number.isFinite(Number(entry.deletedAt)) ? Number(entry.deletedAt) : now,
    });
  }

  /* --------------------------- project shell -------------------------- */
  const resolution = clampResolution(candidate.resolution);
  const aspectRatio = normalizeAspectRatio(resolution.width, resolution.height);
  if (candidate.aspectRatio && candidate.aspectRatio !== aspectRatio) {
    warnings.push(
      `Relación de aspecto "${candidate.aspectRatio}" no coincide con la resolución ${resolution.width}×${resolution.height}: se normalizó a "${aspectRatio}".`
    );
  }

  const fps = clampNumber(candidate.fps, MIN_FPS, MAX_FPS, 30);
  const maxClipEnd = clips.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0);
  const declaredDuration = Number(candidate.duration);
  const duration = Math.max(
    Number.isFinite(declaredDuration) ? declaredDuration : 0,
    maxClipEnd,
    1
  );

  if (droppedClips > 0) {
    warnings.push(`${droppedClips} clip(s) descartados por referencias inválidas.`);
  }
  if (droppedTracks > 0) {
    warnings.push(`${droppedTracks} pista(s) descartadas por datos inválidos.`);
  }
  if (droppedMedia > 0) {
    warnings.push(`${droppedMedia} medio(s) descartados por datos inválidos.`);
  }

  const overlapPolicy: OverlapPolicy =
    candidate.overlapPolicy === 'overwrite' || candidate.overlapPolicy === 'ripple'
      ? candidate.overlapPolicy
      : 'block';

  const project: Project = {
    id: context.projectId,
    name:
      typeof candidate.name === 'string' && candidate.name.trim().length > 0
        ? candidate.name
        : context.fallbackName,
    aspectRatio,
    resolution,
    fps,
    tracks,
    clips,
    mediaPool,
    duration,
    // F1: the policy is sanitised (an unknown value falls back to `block`).
    overlapPolicy,
    // F2: the trash travels with the project.
    trash,
    createdAt: Number.isFinite(Number(candidate.createdAt)) ? Number(candidate.createdAt) : now,
    updatedAt: now,
  };

  return { project, warnings, droppedClips, droppedTracks, droppedMedia };
}

export interface ImportReport {
  project: Project;
  warnings: string[];
  /** Media items that could not be restored from OPFS. */
  missingMedia: string[];
  /** True when the source file carried the media bytes (never for v1). */
  mediaEmbedded: boolean;
  droppedClips: number;
  droppedTracks: number;
  droppedMedia: number;
}

let lastImportReport: ImportReport | null = null;

/** The report of the last import (null when nothing was imported yet). */
export function getLastImportReport(): ImportReport | null {
  return lastImportReport;
}

/**
 * Imports project from a File (.hydra or .json). Validates schema, rehydrates media, and saves to IndexedDB.
 */
export async function importProjectFromFile(file: File): Promise<Project> {
  const report = await importProjectFromFileWithReport(file);
  return report.project;
}

/**
 * Imports a project file and returns a detailed report (warnings, missing
 * media, dropped items). The media bytes are never embedded in v1 exports,
 * so media that cannot be found in the local OPFS is reported explicitly
 * instead of producing a silently broken project.
 */
export async function importProjectFromFileWithReport(file: File): Promise<ImportReport> {
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
  let mediaEmbedded = false;

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (obj.project && typeof obj.project === 'object') {
      candidate = obj.project as Partial<Project>;
      mediaEmbedded = obj.mediaEmbedded === true;
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
      projectId = 'proj_' + Math.random().toString(36).substring(2, 9) + '_' + now.toString(36);
    }
  } catch {
    // read failure -> keep candidate id; saveProject will still persist it
  }

  const fallbackName =
    (typeof file.name === 'string' ? file.name.replace(/\.(hydra|json)$/i, '') : '') || 'Proyecto Importado';

  const sanitized = sanitizeImportedProject(candidate, { projectId, fallbackName, now });
  const warnings = [...sanitized.warnings];

  if (!mediaEmbedded && sanitized.project.mediaPool.length > 0) {
    warnings.push(
      'El archivo exportado no incluye los archivos multimedia: los medios sólo se recuperarán si ya están en este equipo.'
    );
  }

  const rehydrated = await rehydrateProjectMediaWithReport(sanitized.project);
  if (rehydrated.missingMedia.length > 0) {
    warnings.push(
      `No se pudieron recuperar ${rehydrated.missingMedia.length} medio(s) del almacenamiento local: ${rehydrated.missingMedia.join(', ')}.`
    );
  }

  await saveProject(rehydrated.project);

  const report: ImportReport = {
    project: rehydrated.project,
    warnings,
    missingMedia: rehydrated.missingMedia,
    mediaEmbedded,
    droppedClips: sanitized.droppedClips,
    droppedTracks: sanitized.droppedTracks,
    droppedMedia: sanitized.droppedMedia,
  };
  lastImportReport = report;

  if (warnings.length > 0) {
    reportStorageNotice('import', warnings.join(' '), report);
  }

  return report;
}

/**
 * Imports project from a JSON file (backward-compatible alias).
 */
export async function importProjectFromJson(file: File): Promise<Project> {
  return importProjectFromFile(file);
}

/* ------------------------------------------------------------------ */
/* Rehydration (C2 / S-14)                                             */
/* ------------------------------------------------------------------ */

export interface RehydrateReport {
  project: Project;
  /** Media items whose bytes could not be read back. */
  missingMedia: string[];
  createdObjectUrls: number;
  reusedObjectUrls: number;
}

/**
 * Rehydrates blob URLs for media items loaded from OPFS or autosave.
 */
export async function rehydrateProjectMedia(project: Project): Promise<Project> {
  const report = await rehydrateProjectMediaWithReport(project);
  return report.project;
}

/**
 * Rehydrates media and reports which items could not be restored.
 *
 * Object URLs are tracked per (project, media) pair: rehydrating the same
 * project twice reuses the same URLs (no duplication in RAM) and switching to
 * another project revokes the previous batch.
 *
 * F3: a media whose bytes cannot be read back is flagged as `missing`, so the
 * UI can warn the user instead of rendering a black and silent clip.
 * F2: the media of the trash is rehydrated too (a restore after a reload
 * must find its bytes).
 */
export async function rehydrateProjectMediaWithReport(project: Project): Promise<RehydrateReport> {
  const mediaPool = Array.isArray(project.mediaPool) ? project.mediaPool : [];
  const trash: TrashEntry[] = Array.isArray(project.trash) ? project.trash : [];

  // Switching project: the previous project's object URLs are dead weight.
  if (activeUrlProjectId !== null && activeUrlProjectId !== project.id) {
    revokeProjectObjectUrls(activeUrlProjectId);
  }
  activeUrlProjectId = project.id;

  const missingMedia: string[] = [];
  let createdObjectUrls = 0;
  let reusedObjectUrls = 0;

  /**
   * Renews the object URL of a media item from its OPFS copy.
   * Returns the updated item (flagged as `missing` when the bytes are gone).
   */
  const rehydrateItem = async (item: MediaItem): Promise<MediaItem> => {
    if (!item.opfsPath) return item;

    let file: File | null = null;
    try {
      file = await opfsStorage.getMediaFromOPFS(item.opfsPath);
    } catch (err) {
      console.warn(`Could not rehydrate media ${item.name} from OPFS:`, err);
    }

    if (!file) {
      missingMedia.push(item.name || item.id);
      // The stored URL is a dead blob: URL - drop it instead of showing a
      // broken thumbnail. The media is flagged: the user has to relink it.
      return { ...item, url: '', thumbnailUrl: '', status: 'missing' };
    }

    const key = registryKey(project.id, item.id);
    const cached = objectUrlRegistry.get(key);
    let freshUrl: string;
    if (cached) {
      freshUrl = cached.url;
      reusedObjectUrls++;
    } else {
      freshUrl = URL.createObjectURL(file);
      objectUrlRegistry.set(key, { projectId: project.id, mediaId: item.id, url: freshUrl });
      createdObjectUrls++;
    }

    const next: MediaItem = { ...item, url: freshUrl, status: 'ok' };
    const staleThumbnail =
      typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.startsWith('blob:');
    if (item.type === 'image') {
      // The thumbnail of an image IS the media itself: renew the URL.
      next.thumbnailUrl = freshUrl;
    } else if (staleThumbnail) {
      // A blob: thumbnail never survives a reload - better an empty
      // thumbnail (placeholder) than a broken image.
      next.thumbnailUrl = '';
    }
    return next;
  };

  const updatedMediaPool: MediaItem[] = await Promise.all(mediaPool.map(rehydrateItem));

  const updatedTrash: TrashEntry[] = await Promise.all(
    trash.map(async (entry) => ({
      ...entry,
      media: await rehydrateItem(entry.media),
    }))
  );

  // Drop the URLs of media that no longer belong to the project.
  const liveMediaIds = new Set([
    ...mediaPool.map((m) => m.id),
    ...trash.map((entry) => entry.media?.id).filter(Boolean),
  ]);
  for (const entry of Array.from(objectUrlRegistry.values())) {
    if (entry.projectId === project.id && !liveMediaIds.has(entry.mediaId)) {
      revokeEntry(entry);
    }
  }

  return {
    project: { ...project, mediaPool: updatedMediaPool, trash: updatedTrash },
    missingMedia,
    createdObjectUrls,
    reusedObjectUrls,
  };
}
