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
  AudioFade,
} from '../../types/project';
import * as opfsStorage from './opfsStorage';
import { normalizeKeyframesForWrite } from '../utils/keyframes';
import { clampClipAudioFades } from '../utils/audioFades';
import { normalizeAudioEffects, normalizeTrackRole } from '../utils/audioEffects';
import {
  sanitizeClipTextStyle,
  sanitizeClipTransition,
  sanitizeClipWords,
} from '../utils/clipSanitize';

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
  { id: 'track_video_2', name: 'Vídeo V2 (superposición)', type: 'video', isMuted: false, isLocked: false, isVisible: true },
  { id: 'track_video_1', name: 'Vídeo V1 (principal)', type: 'video', isMuted: false, isLocked: false, isVisible: true },
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
  // D09: las copias de seguridad del revinculado mueren con el proyecto.
  await discardRelinkBackup([...items, ...trashed].map((m) => m.id));
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
 * relink does not leave an orphan behind — unless `options.keepPrevious` is
 * set: the store keeps the previous file as a backup so that undoing the
 * relink really restores the previous bytes (D09). At most one backup file
 * per media is kept (see `discardRelinkBackup`).
 *
 * Returns `null` when the new file could not be stored.
 */
export async function relinkMediaBytes(
  item: MediaItem,
  file: File,
  projectId?: string,
  options?: { keepPrevious?: boolean }
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

  if (options?.keepPrevious) {
    // D09: el archivo previo se conserva como copia de seguridad para que el
    // undo recupere los bytes anteriores (una copia como máximo por medio: la
    // obsoleta se borra antes de registrar la nueva).
    rememberRelinkBackup(item.id, previousPath, opfsPath);
  } else if (previousPath && previousPath !== opfsPath) {
    // The old file is an orphan now: delete it (the quota must not grow).
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
 * D09 · Copias de seguridad del revinculado (una por medio como máximo).
 *
 * `relinkMediaBytes(..., { keepPrevious: true })` conserva el archivo previo
 * para que deshacer el revinculado recupere los bytes anteriores. La copia se
 * descarta cuando otro revinculado la deja obsoleta, cuando el medio sale del
 * proyecto (purga) o cuando el proyecto se borra: el coste en disco está
 * acotado a un archivo extra por medio revinculado.
 */
const relinkBackupPaths = new Map<string, string>();

/**
 * Registra `previousPath` como copia de seguridad de `mediaId`.
 * Una copia obsoleta (distinta de la ruta previa actual) se borra.
 */
function rememberRelinkBackup(mediaId: string, previousPath: string, nextPath: string | undefined): void {
  if (!mediaId || !previousPath || previousPath === nextPath) return;
  const stale = relinkBackupPaths.get(mediaId);
  if (stale && stale !== previousPath) {
    void deleteBackupFile(stale);
  }
  relinkBackupPaths.set(mediaId, previousPath);
}

async function deleteBackupFile(path: string): Promise<void> {
  const deleter = resolveOpfsDeleter();
  if (deleter) {
    await deleter([path]);
  }
}

/**
 * D09 · Descarta la copia de seguridad del revinculado de un medio (o de
 * varios) y borra su archivo. Llamar cuando el medio sale del proyecto para
 * siempre (purga, borrado del proyecto): la copia ya no puede recuperarse con
 * un undo.
 */
export async function discardRelinkBackup(mediaId: string | string[]): Promise<void> {
  const ids = Array.isArray(mediaId) ? mediaId : [mediaId];
  for (const id of ids) {
    const path = relinkBackupPaths.get(id);
    if (!path) continue;
    relinkBackupPaths.delete(id);
    await deleteBackupFile(path);
  }
}

/**
 * Duplicates an existing project with decoupled IDs and stores it.
 *
 * D02: the clone owns its media: every media item gains a NEW id and its OWN
 * bytes (the OPFS file is copied, never shared). Deleting the original can no
 * longer corrupt the clone. Coste: el duplicado ocupa en disco lo mismo que
 * el original (los bytes se copian, no se comparten). When the bytes cannot
 * be copied, the cloned media is flagged as `missing` (honest) instead of
 * pointing at the original file.
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

  // D02: cada medio del clon tiene su PROPIO id y sus PROPIOS bytes (copia en
  // OPFS, nunca la misma ruta). Así el clon y el original son independientes.
  const mediaIdMap = new Map<string, string>();
  const cloneMediaItem = async (item: MediaItem, idx: number): Promise<MediaItem> => {
    const newMediaId = `media_${now.toString(36)}_${idx}_${Math.random().toString(36).substring(2, 6)}`;
    mediaIdMap.set(item.id, newMediaId);
    const copy: MediaItem = { ...item, id: newMediaId };
    // La URL del original pertenece a su sesión/proyecto: el clon la renueva
    // al rehidratarse desde sus propios bytes.
    if (typeof copy.url === 'string' && copy.url.startsWith('blob:')) copy.url = '';
    if (typeof copy.thumbnailUrl === 'string' && copy.thumbnailUrl.startsWith('blob:')) {
      copy.thumbnailUrl = '';
    }
    const sourcePath = typeof item.opfsPath === 'string' ? item.opfsPath : '';
    if (!sourcePath) return copy;
    try {
      const file = await opfsStorage.getMediaFromOPFS(sourcePath);
      if (!file) throw new Error('Bytes no disponibles para copiar.');
      const newPath = await opfsStorage.saveMediaToOPFS(newMediaId, file);
      copy.opfsPath = newPath;
      copy.size = file.size;
    } catch (err) {
      // No se pudo copiar: el clon NO comparte la ruta del original (quedaría
      // corrupto al borrarlo), sino que declara el medio como ausente.
      console.warn(`Could not copy the media bytes for the duplicate ("${item.id}"):`, err);
      copy.opfsPath = undefined;
      copy.url = '';
      copy.thumbnailUrl = '';
      copy.status = 'missing';
    }
    return copy;
  };

  cloned.mediaPool = await Promise.all((cloned.mediaPool || []).map((m, idx) => cloneMediaItem(m, idx)));
  cloned.trash = await Promise.all(
    (cloned.trash || []).map(async (entry, idx) => ({
      ...entry,
      media: await cloneMediaItem(entry.media, 1000 + idx),
      clips: (entry.clips || []).map((c, cIdx) => ({
        ...c,
        id: `clip_${now}_${cIdx}_${Math.random().toString(36).substring(2, 6)}`,
        trackId: trackIdMap.get(c.trackId) || c.trackId,
        mediaId: mediaIdMap.get(c.mediaId) || c.mediaId,
      })),
    }))
  );

  cloned.clips = (cloned.clips || []).map((c, idx) => ({
    ...c,
    id: `clip_${now}_${idx}_${Math.random().toString(36).substring(2, 6)}`,
    trackId: trackIdMap.get(c.trackId) || c.trackId,
    mediaId: mediaIdMap.get(c.mediaId) || c.mediaId,
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

/**
 * A media file embedded inside a `.hydra` export.
 *
 * The bytes travel as base64 inside the JSON payload: the backup stays a
 * single self-contained text document (no companion folder, no binary
 * container) at the cost of a 33 % size overhead (4 base64 characters per
 * 3 bytes).
 */
export interface EmbeddedMediaFile {
  /** Id of the media item inside the project. */
  mediaId: string;
  /** Original file name (used to rebuild the file in OPFS). */
  fileName: string;
  /** Best effort MIME type. */
  mimeType: string;
  /** Size of the original file in bytes. */
  size: number;
  /** The bytes, base64 encoded (without the `data:` prefix). */
  data: string;
}

/**
 * Why the media bytes were NOT embedded in the exported file.
 *
 * - `no-media`     : the project has no media at all.
 * - `disabled`     : the caller asked for a media-less export.
 * - `too-large`    : the payload would exceed the size limit.
 * - `unavailable`  : the bytes could not be read from the local storage.
 */
export type MediaEmbedSkipReason = 'no-media' | 'disabled' | 'too-large' | 'unavailable';

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
  /** v2: the media bytes (base64). */
  embeddedMedia?: EmbeddedMediaFile[];
  /** v2: why the media was not embedded (absent when it was embedded). */
  mediaEmbedSkipped?: MediaEmbedSkipReason;
}

/**
 * Maximum size (in bytes, base64 encoded) of the media payload embedded in a
 * `.hydra` file. Beyond that the export falls back to the media-less format
 * (and says so in the file name).
 */
export const MAX_EMBEDDED_MEDIA_BYTES = 64 * 1024 * 1024;

/* ----------------------------- base64 ------------------------------- */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Lookup table: char code -> base64 value (-1 when it is not base64). */
const BASE64_LOOKUP = (() => {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Size (in bytes) of the base64 representation of a payload.
 *
 * Base64 encodes 3 bytes into 4 characters: the overhead is 33 %.
 */
export function base64EncodedSize(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / 3) * 4;
}

/**
 * Encodes bytes as base64 (pure, no DOM, no Buffer).
 */
export function encodeBase64(bytes: Uint8Array): string {
  const length = bytes.length;
  // The string is built in chunks: a single concatenation of millions of
  // characters would make the encoder crawl on big media files.
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < length ? bytes[i + 1] : 0;
    const b2 = i + 2 < length ? bytes[i + 2] : 0;
    chunk += BASE64_ALPHABET[b0 >> 2];
    chunk += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    chunk += i + 1 < length ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    chunk += i + 2 < length ? BASE64_ALPHABET[b2 & 0x3f] : '=';
    if (chunk.length >= 65536) {
      parts.push(chunk);
      chunk = '';
    }
  }
  if (chunk.length > 0) parts.push(chunk);
  return parts.join('');
}

/**
 * Decodes a base64 string (pure, no DOM, no Buffer).
 */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || text.length === 0) return new Uint8Array(new ArrayBuffer(0));
  const clean = text.replace(/[\r\n\t ]/g, '').replace(/=+$/, '');
  const out = new Uint8Array(new ArrayBuffer(Math.floor((clean.length * 3) / 4)));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_LOOKUP[clean.charCodeAt(i)];
    const c1 = BASE64_LOOKUP[clean.charCodeAt(i + 1)];
    if (c0 < 0 || c1 < 0) throw new Error('Datos base64 no válidos.');
    out[o++] = ((c0 << 2) | (c1 >> 4)) & 0xff;
    if (i + 2 < clean.length) {
      const c2 = BASE64_LOOKUP[clean.charCodeAt(i + 2)];
      if (c2 < 0) throw new Error('Datos base64 no válidos.');
      out[o++] = ((c1 << 4) | (c2 >> 2)) & 0xff;
      if (i + 3 < clean.length) {
        const c3 = BASE64_LOOKUP[clean.charCodeAt(i + 3)];
        if (c3 < 0) throw new Error('Datos base64 no válidos.');
        out[o++] = ((c2 << 6) | c3) & 0xff;
      }
    }
  }
  return out.subarray(0, o);
}

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

/**
 * Guesses the MIME type of a file from its extension (pure).
 */
export function guessMimeType(fileName: string): string {
  const name = typeof fileName === 'string' ? fileName : '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MIME_BY_EXTENSION[ext] ?? '';
}

/**
 * Keeps only the base name of a file (no folders, no weird characters).
 */
export function sanitizeMediaFileName(fileName: string): string {
  const base = (typeof fileName === 'string' ? fileName : '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[^\w.\- ]+/g, '_').trim();
  return clean || 'medio.bin';
}

/* --------------------------- export envelope -------------------------- */

export interface SerializeExportOptions {
  /** The media bytes to embed (base64). */
  embeddedMedia?: EmbeddedMediaFile[];
  /** Why the media was not embedded. */
  mediaEmbedSkipped?: MediaEmbedSkipReason;
}

/**
 * Builds the export envelope for a project.
 *
 * Without options the envelope is the legacy v1 one (project structure only,
 * `mediaEmbedded: false`). With `embeddedMedia` the envelope becomes v2 and
 * carries the media bytes: the exported file is then a REAL backup.
 */
export function serializeProjectForExport(
  project: Project,
  options: SerializeExportOptions = {}
): HydraProjectFile {
  const mediaCount = Array.isArray(project.mediaPool) ? project.mediaPool.length : 0;
  const embedded = options.embeddedMedia;

  if (!embedded && !options.mediaEmbedSkipped) {
    return {
      version: 1,
      app: 'HydraCut',
      exportedAt: Date.now(),
      project,
      mediaEmbedded: false,
      mediaCount,
    };
  }

  return {
    version: 2,
    app: 'HydraCut',
    exportedAt: Date.now(),
    project,
    mediaEmbedded: !!embedded && embedded.length > 0,
    mediaCount,
    ...(embedded ? { embeddedMedia: embedded } : {}),
    ...(options.mediaEmbedSkipped ? { mediaEmbedSkipped: options.mediaEmbedSkipped } : {}),
  };
}

/**
 * Name of the exported file. It says explicitly whether the media travelled
 * with the project (`-sin-medios` when it did not).
 */
export function buildExportFileName(
  projectName: string,
  extension: string,
  mediaEmbedded: boolean
): string {
  const raw = typeof projectName === 'string' ? projectName : '';
  const safeName = raw.toLowerCase().replace(/[^a-z0-9_-]/gi, '_') || 'proyecto';
  return mediaEmbedded ? `${safeName}.${extension}` : `${safeName}-sin-medios.${extension}`;
}

/* ------------------------- media embedding plan ----------------------- */

export interface ExportOptions {
  /**
   * Include the media bytes in the exported file.
   * Defaults to `true` (the media is embedded when it fits under the limit).
   */
  includeMedia?: boolean;
  /** Maximum size (bytes, base64 encoded) of the embedded payload. */
  maxEmbeddedBytes?: number;
}

export interface MediaEmbeddingPlan {
  /** True when the media bytes will be embedded. */
  embed: boolean;
  /** Why the media is not embedded (null when it is). */
  skipped: MediaEmbedSkipReason | null;
  /** Number of media items considered (pool + trash). */
  mediaCount: number;
  /** Estimated size of the base64 payload in bytes. */
  estimatedBytes: number;
  /** The limit that applies. */
  limitBytes: number;
}

/**
 * Media items that travel with the project: the pool plus the trash (the
 * bytes of a trashed media are still on disk and can be restored).
 */
function collectEmbeddableMedia(project: Project): MediaItem[] {
  const pool = Array.isArray(project?.mediaPool) ? project.mediaPool : [];
  const trash = Array.isArray(project?.trash)
    ? project.trash.map((entry) => entry?.media).filter(Boolean)
    : [];
  const seen = new Set<string>();
  const out: MediaItem[] = [];
  for (const item of [...pool, ...trash]) {
    if (!item || typeof item.id !== 'string' || item.id.length === 0) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * Decides whether the media bytes can travel with the exported file (pure).
 */
export function planMediaEmbedding(
  project: Project,
  options: ExportOptions = {}
): MediaEmbeddingPlan {
  const requestedLimit = Number(options.maxEmbeddedBytes);
  const limitBytes =
    Number.isFinite(requestedLimit) && requestedLimit >= 0
      ? requestedLimit
      : MAX_EMBEDDED_MEDIA_BYTES;

  const items = collectEmbeddableMedia(project);
  const mediaCount = items.length;
  const estimatedBytes = items.reduce(
    (sum, item) => sum + base64EncodedSize(Number(item?.size) || 0),
    0
  );
  const base = { mediaCount, estimatedBytes, limitBytes };

  if (options.includeMedia === false) return { ...base, embed: false, skipped: 'disabled' };
  if (mediaCount === 0) return { ...base, embed: false, skipped: 'no-media' };
  if (estimatedBytes > limitBytes) return { ...base, embed: false, skipped: 'too-large' };
  return { ...base, embed: true, skipped: null };
}

export interface EmbeddedMediaCollection {
  /** The media files that could be read (base64 encoded). */
  files: EmbeddedMediaFile[];
  /** Names of the media that could not be read. */
  missing: string[];
}

/**
 * Reads the bytes of every media of the project from the local storage and
 * encodes them as base64.
 */
export async function collectEmbeddedMedia(project: Project): Promise<EmbeddedMediaCollection> {
  const items = collectEmbeddableMedia(project);
  const files: EmbeddedMediaFile[] = [];
  const missing: string[] = [];

  for (const item of items) {
    const path = typeof item.opfsPath === 'string' ? item.opfsPath : '';
    const label = item.name || item.id;
    if (!path) {
      missing.push(label);
      continue;
    }

    let file: File | null = null;
    try {
      file = await opfsStorage.getMediaFromOPFS(path);
    } catch (err) {
      console.warn(`Could not read the media "${label}" for the export:`, err);
    }
    if (!file) {
      missing.push(label);
      continue;
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      files.push({
        mediaId: item.id,
        fileName: sanitizeMediaFileName(item.name || path),
        mimeType: file.type || guessMimeType(item.name),
        size: bytes.byteLength,
        data: encodeBase64(bytes),
      });
    } catch (err) {
      console.warn(`Could not encode the media "${label}" for the export:`, err);
      missing.push(label);
    }
  }

  return { files, missing };
}

/* ------------------------------ export ------------------------------- */

export interface ExportOutcome {
  /** The name of the downloaded file. */
  fileName: string;
  /** True when the file carries the media bytes. */
  mediaEmbedded: boolean;
  /** Number of media items referenced by the project. */
  mediaCount: number;
  /** Number of media files actually embedded. */
  embeddedCount: number;
  /** Why the media was not embedded (null when it was). */
  skipped: MediaEmbedSkipReason | null;
  /** Size (bytes, base64 encoded) of the embedded payload. */
  encodedBytes: number;
}

/**
 * Triggers the download of an export envelope and returns the file name.
 */
function triggerProjectDownload(
  envelope: HydraProjectFile,
  extension: 'hydra' | 'json',
  mediaEmbedded: boolean
): string {
  const jsonStr = JSON.stringify(envelope, null, 2);
  const mimeType = extension === 'hydra' ? 'application/x-hydracut+json' : 'application/json';
  const blob = new Blob([jsonStr], { type: mimeType });
  const fileName = buildExportFileName(envelope.project?.name ?? 'proyecto', extension, mediaEmbedded);

  if (typeof document !== 'undefined') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // The object URL is released a bit later: with a big backup (tens of
    // MB) some browsers cancel the download if the URL is revoked while it
    // is still being read.
    const revokeTimer = setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }, 30_000);
    // Do not keep a Node process alive just for the revoke timer.
    const maybeUnref = revokeTimer as unknown as { unref?: () => void };
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
  }

  return fileName;
}

/**
 * Exports a project as a downloadable .hydra or .json file.
 *
 * The media bytes are embedded by default (that is what makes the file a real
 * backup): the size is checked first and, when the payload would exceed the
 * limit, the export falls back to the media-less format, whose file name says
 * so explicitly (`<name>-sin-medios.hydra`).
 *
 * The download of a media-less export is triggered synchronously (there are
 * no bytes to read); when the media travels with the project the returned
 * promise resolves once the file has been written.
 */
export function exportProjectToFile(
  project: Project,
  extension: 'hydra' | 'json' = 'json',
  options: ExportOptions = {}
): Promise<ExportOutcome> {
  const plan = planMediaEmbedding(project, options);

  if (!plan.embed) {
    const skipped = plan.skipped ?? 'disabled';
    // A project without media keeps the exact legacy envelope.
    const envelope =
      skipped === 'no-media'
        ? serializeProjectForExport(project)
        : serializeProjectForExport(project, { mediaEmbedSkipped: skipped });
    const fileName = triggerProjectDownload(envelope, extension, false);

    if (skipped === 'too-large') {
      reportStorageNotice(
        'export',
        `Los medios del proyecto (${formatStorageBytes(plan.estimatedBytes)}) superan el límite de ${formatStorageBytes(plan.limitBytes)}: el archivo se ha exportado SIN los archivos multimedia.`,
        { mediaCount: plan.mediaCount, estimatedBytes: plan.estimatedBytes }
      );
    } else {
      reportStorageNotice(
        'export',
        'El archivo exportado no incluye los archivos multimedia: reimportarlo no recuperará los clips.',
        { mediaCount: envelope.mediaCount }
      );
    }

    return Promise.resolve({
      fileName,
      mediaEmbedded: false,
      mediaCount: plan.mediaCount,
      embeddedCount: 0,
      skipped,
      encodedBytes: 0,
    });
  }

  return exportWithEmbeddedMedia(project, extension, plan);
}

/**
 * Reads the media bytes and writes the export file with them.
 */
async function exportWithEmbeddedMedia(
  project: Project,
  extension: 'hydra' | 'json',
  plan: MediaEmbeddingPlan
): Promise<ExportOutcome> {
  let envelope: HydraProjectFile;
  let embeddedCount = 0;
  let encodedBytes = 0;
  let skipped: MediaEmbedSkipReason | null = null;

  try {
    const { files, missing } = await collectEmbeddedMedia(project);
    encodedBytes = files.reduce((sum, file) => sum + file.data.length, 0);

    if (files.length === 0 || encodedBytes > plan.limitBytes) {
      // Nothing could be read, or the real payload is bigger than expected.
      skipped = files.length === 0 ? 'unavailable' : 'too-large';
      envelope = serializeProjectForExport(project, { mediaEmbedSkipped: skipped });
    } else {
      embeddedCount = files.length;
      envelope = serializeProjectForExport(project, { embeddedMedia: files });
      if (missing.length > 0) {
        reportStorageNotice(
          'export',
          `${missing.length} medio(s) no se pudieron incluir en la copia de seguridad: ${missing.join(', ')}.`,
          { missing }
        );
      }
    }
  } catch (err) {
    reportStorageError('export', err, 'Failed to export the project with its media:');
    skipped = 'unavailable';
    envelope = serializeProjectForExport(project, { mediaEmbedSkipped: skipped });
  }

  const mediaEmbedded = envelope.mediaEmbedded === true;
  let fileName = '';
  try {
    fileName = triggerProjectDownload(envelope, extension, mediaEmbedded);
  } catch (err) {
    // The download could not be triggered: the caller must not see an
    // unhandled rejection (the export is fire-and-forget in the UI).
    reportStorageError('export', err, 'Failed to write the export file:');
  }

  if (mediaEmbedded) {
    reportStorageNotice(
      'export',
      `Copia de seguridad creada con ${embeddedCount} medio(s) (${formatStorageBytes(encodedBytes)}).`,
      { embeddedCount, encodedBytes }
    );
  } else {
    reportStorageNotice(
      'export',
      'El archivo exportado no incluye los archivos multimedia: reimportarlo no recuperará los clips.',
      { mediaCount: envelope.mediaCount }
    );
  }

  return {
    fileName,
    mediaEmbedded,
    mediaCount: envelope.mediaCount ?? plan.mediaCount,
    embeddedCount,
    skipped,
    encodedBytes,
  };
}

/**
 * Exports project as a downloadable .json file (backward-compatible alias).
 */
export function exportProjectToJson(project: Project): Promise<ExportOutcome> {
  return exportProjectToFile(project, 'json');
}

/* ------------------------------------------------------------------ */
/* Storage manager (F1 / S-08): quota, projects, media and trash        */
/* ------------------------------------------------------------------ */

/** Percentage of the quota above which the user must be warned. */
export const STORAGE_QUOTA_WARNING_PERCENT = 80;

export type StorageQuotaLevel = 'ok' | 'warning' | 'critical';

export interface StorageQuotaSnapshot {
  /** Bytes used by the origin. */
  usage: number;
  /** Bytes available to the origin. */
  quota: number;
  /** Percentage of the quota in use (0..100, one decimal). */
  percent: number;
  /** `warning` above 80 %, `critical` when the quota is exhausted. */
  level: StorageQuotaLevel;
  /** Actionable message (Spanish) or null when everything is fine. */
  message: string | null;
}

/**
 * Builds the snapshot of the storage quota (pure).
 *
 * `usage` / `quota` come from `navigator.storage.estimate()`; the snapshot
 * also carries the level of alert and an actionable message in Spanish.
 */
export function buildQuotaSnapshot(usage: number, quota: number): StorageQuotaSnapshot {
  const safeUsage = Number.isFinite(usage) && usage > 0 ? usage : 0;
  const safeQuota = Number.isFinite(quota) && quota > 0 ? quota : 0;
  const percent =
    safeQuota > 0 ? Math.min(100, Math.round((safeUsage / safeQuota) * 1000) / 10) : 0;

  let level: StorageQuotaLevel = 'ok';
  let message: string | null = null;

  if (safeQuota > 0 && percent >= 100) {
    level = 'critical';
    message =
      'Almacenamiento lleno: no se pueden guardar más cambios. Vacía la papelera o elimina proyectos para liberar espacio.';
  } else if (safeQuota > 0 && percent > STORAGE_QUOTA_WARNING_PERCENT) {
    level = 'warning';
    message = `Queda poco espacio (${percent} %): vacía la papelera o elimina proyectos para no perder tus cambios.`;
  }

  return { usage: safeUsage, quota: safeQuota, percent, level, message };
}

/**
 * Formats a size in bytes for the UI (Spanish, decimal comma).
 */
export function formatStorageBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  const rounded =
    scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace('.', ',');
  return `${rounded} ${units[unit]}`;
}

export interface StorageUsageSummary {
  /** Number of projects saved in this browser. */
  projects: number;
  /** Number of media items in the current project. */
  mediaItems: number;
  /** Size of the media items of the current project (bytes). */
  mediaBytes: number;
  /** Number of media items in the trash of the current project. */
  trashItems: number;
  /** Size of the trash (bytes). */
  trashBytes: number;
}

/**
 * Summarises what is stored in this browser (pure).
 *
 * `projects` accepts the number of saved projects or the index itself.
 */
export function summarizeStorageUsage(
  projects: number | ProjectMetadata[] | null | undefined,
  project: Partial<Project> | null | undefined
): StorageUsageSummary {
  const pool = Array.isArray(project?.mediaPool) ? project.mediaPool : [];
  const trash = Array.isArray(project?.trash) ? project.trash : [];

  const mediaBytes = pool.reduce(
    (sum, item) => sum + (Number.isFinite(item?.size) && item.size > 0 ? item.size : 0),
    0
  );
  const trashBytes = trash.reduce(
    (sum, entry) =>
      sum + (Number.isFinite(entry?.media?.size) && entry.media.size > 0 ? entry.media.size : 0),
    0
  );

  const projectCount =
    typeof projects === 'number'
      ? Number.isFinite(projects) && projects > 0
        ? projects
        : 0
      : Array.isArray(projects)
        ? projects.length
        : 0;

  return {
    projects: projectCount,
    mediaItems: pool.length,
    mediaBytes,
    trashItems: trash.length,
    trashBytes,
  };
}

/**
 * Reads the storage estimate of the origin.
 *
 * Returns `null` when the API is not available (private mode, old browser,
 * non browser environment): the caller must degrade gracefully instead of
 * breaking.
 */
export async function readStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    const storage = nav?.storage;
    if (!storage || typeof storage.estimate !== 'function') return null;
    const estimate = await storage.estimate();
    return {
      usage: Number(estimate?.usage) || 0,
      quota: Number(estimate?.quota) || 0,
    };
  } catch {
    return null;
  }
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

/**
 * Colour filters of a clip (F9).
 *
 * The shape mirrors `ClipColorFilters` of `src/types/project.ts` (it is
 * declared here so the sanitiser keeps working even if that type is moved).
 */
interface SanitizedClipFilters {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  grayscale?: number;
  sepia?: number;
}

/** Neutral value, minimum and maximum of every colour filter. */
const CLIP_FILTER_RANGES: Record<string, [number, number, number]> = {
  brightness: [0, 2, 1],
  contrast: [0, 2, 1],
  saturation: [0, 2, 1],
  temperature: [-1, 1, 0],
  grayscale: [0, 1, 0],
  sepia: [0, 1, 0],
};

/**
 * Sanitises the colour filters of a clip (F9).
 *
 * Returns `undefined` when the clip has no filters: an imported project must
 * keep the filters it was exported with (they change how the clip is drawn
 * in the preview AND in the export).
 */
function sanitizeClipFilters(raw: unknown): SanitizedClipFilters | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  let found = false;
  for (const key of Object.keys(CLIP_FILTER_RANGES)) {
    const value = Number(source[key]);
    if (!Number.isFinite(value)) continue;
    const [min, max] = CLIP_FILTER_RANGES[key];
    out[key] = Math.min(max, Math.max(min, value));
    found = true;
  }
  return found ? (out as SanitizedClipFilters) : undefined;
}

/**
 * Coerces an untrusted imported value to `AudioFade | undefined` for the
 * production normaliser (`clampClipAudioFades` expects an object or
 * `undefined`: non-object garbage from a hand-edited file means "no fade",
 * never a crash — the normaliser itself then drops invalid durations).
 */
function fadeOrUndefined(value: unknown): AudioFade | undefined {
  return value !== null && typeof value === 'object' ? (value as AudioFade) : undefined;
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
    // The ducking role travels with the track, normalised: an unknown role
    // from a hand-edited file means "no role", never a crash — and a track
    // without a role gains no key (optional carry, byte-identical shape).
    const role = normalizeTrackRole(t.role);
    tracks.push({
      id: t.id,
      name: typeof t.name === 'string' && t.name.length > 0 ? t.name : `Pista ${tracks.length + 1}`,
      type,
      isMuted: !!t.isMuted,
      isLocked: !!t.isLocked,
      isVisible: t.isVisible === undefined ? true : !!t.isVisible,
      ...(role ? { role } : {}),
    });
  }

  if (tracks.length === 0) {
    throw new Error('Archivo de proyecto no válido: no contiene ninguna pista válida.');
  }

  // The project fps is resolved before the clips: keyframes are quantised
  // to it (missing/invalid → 30, the same default as the project shell).
  const fps = clampNumber(candidate.fps, MIN_FPS, MAX_FPS, 30);

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
    // F9: the colour filters of the clip travel with it (they change how it
    // is drawn in the preview AND in the export).
    const filters = sanitizeClipFilters(c.filters);
    // F8: the keyframes of the clip travel with it (they animate position,
    // scale and opacity in the preview AND in the export). They go through
    // the production normaliser: sorted, de-duplicated, clamped and
    // quantised to the project fps.
    const keyframes = normalizeKeyframesForWrite(c.keyframes, fps, duration);
    // The audio fades of the clip travel with it too (they shape the clip
    // gain in the preview AND in the export). They go through the production
    // normaliser: quantised to the project fps and clamped to the clip.
    const audioFades = clampClipAudioFades(
      fadeOrUndefined(c.audioFadeIn),
      fadeOrUndefined(c.audioFadeOut),
      duration,
      fps
    );
    // The transition, the text style and the word timings travel with the
    // clip too, but NEVER raw: a hand-edited file could inject an invalid
    // transition type, a negative/NaN duration, a negative font size or
    // timings outside the clip, and those values flow straight into the
    // compositor and the audio engine. They go through the pure import
    // sanitisers (optional carry: no key when the field is absent).
    const transition = sanitizeClipTransition(c.transition, duration);
    const textStyle = sanitizeClipTextStyle(c.textStyle);
    const words = sanitizeClipWords(c.words, duration);
    // The per-clip audio effects (pan / 3-band EQ / ducking) travel with the
    // clip too, through the production normaliser: out-of-range values are
    // clamped, neutral garbage is dropped (no key when the field is absent,
    // so the common shape does not change).
    const audioEffects = normalizeAudioEffects(c.audioEffects);
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
      // F4: "conservar el tono" is a per-clip flag. It used to be dropped
      // here (the clip was rebuilt field by field), so an imported project
      // silently reverted to the default behaviour.
      preservePitch: typeof c.preservePitch === 'boolean' ? c.preservePitch : undefined,
      ...(filters ? { filters } : {}),
      ...(keyframes ? { keyframes } : {}),
      ...(audioFades.fadeIn ? { audioFadeIn: audioFades.fadeIn } : {}),
      ...(audioFades.fadeOut ? { audioFadeOut: audioFades.fadeOut } : {}),
      ...(audioEffects ? { audioEffects } : {}),
      text: typeof c.text === 'string' ? c.text : undefined,
      ...(textStyle ? { textStyle } : {}),
      ...(words ? { words } : {}),
      ...(transition ? { transition } : {}),
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
      // D08: el id de un clip no puede vivir a la vez en la línea de tiempo y
      // en la papelera (la vía principal ya controla duplicados con
      // `seenClipIds`; aquí se comparte el mismo conjunto). La colisión se
      // REPARA renombrando el clip de la papelera, con aviso: el contenido se
      // conserva y ningún `updateClip`/`removeClip` actúa sobre dos clips.
      let trashClipId = c.id;
      if (seenClipIds.has(trashClipId)) {
        let n = 2;
        let renamed = `${c.id}_importado_${n}`;
        while (seenClipIds.has(renamed)) {
          n += 1;
          renamed = `${c.id}_importado_${n}`;
        }
        warnings.push(`Clip duplicado "${c.id}" en la papelera: se ha renombrado a "${renamed}".`);
        trashClipId = renamed;
      }
      seenClipIds.add(trashClipId);
      // The trash is restored verbatim into the live project, so its clips
      // are normalised with the SAME production normalisers as the main
      // path: the `...c` spread below would otherwise carry keyframes,
      // filters, fades, transition, text style and word timings through raw
      // and unnormalised (corrupt values included).
      const trashFades = clampClipAudioFades(
        fadeOrUndefined(c.audioFadeIn),
        fadeOrUndefined(c.audioFadeOut),
        duration,
        fps
      );
      const trashKeyframes = normalizeKeyframesForWrite(c.keyframes, fps, duration);
      const trashFilters = sanitizeClipFilters(c.filters);
      const trashTransition = sanitizeClipTransition(c.transition, duration);
      const trashTextStyle = sanitizeClipTextStyle(c.textStyle);
      const trashWords = sanitizeClipWords(c.words, duration);
      const trashAudioEffects = normalizeAudioEffects(c.audioEffects);
      const rebuiltTrashClip = {
        id: trashClipId,
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
        preservePitch: typeof c.preservePitch === 'boolean' ? c.preservePitch : undefined,
        ...(trashFilters ? { filters: trashFilters } : {}),
        ...(trashKeyframes ? { keyframes: trashKeyframes } : {}),
        ...(trashTransition ? { transition: trashTransition } : {}),
        ...(trashAudioEffects ? { audioEffects: trashAudioEffects } : {}),
        text: typeof c.text === 'string' ? c.text : undefined,
        ...(trashTextStyle ? { textStyle: trashTextStyle } : {}),
        ...(trashWords ? { words: trashWords } : {}),
      } as Clip;
      if (trashFades.fadeIn !== undefined) rebuiltTrashClip.audioFadeIn = trashFades.fadeIn;
      else delete rebuiltTrashClip.audioFadeIn;
      if (trashFades.fadeOut !== undefined) rebuiltTrashClip.audioFadeOut = trashFades.fadeOut;
      else delete rebuiltTrashClip.audioFadeOut;
      entryClips.push(rebuiltTrashClip);
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
    // The opt-in tail of the timeline travels with the project: without it
    // the imported project would be shorter than the exported one.
    endPaddingSeconds: Number.isFinite(Number(candidate.endPaddingSeconds))
      ? Math.max(0, Number(candidate.endPaddingSeconds))
      : undefined,
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
  /** Media items that were written back to the local storage. */
  restoredMedia?: string[];
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
 * Parses the `embeddedMedia` section of an exported file (pure).
 *
 * Only the entries that can be restored are kept: a malformed entry is
 * ignored instead of breaking the whole import.
 */
export function parseEmbeddedMedia(value: unknown): EmbeddedMediaFile[] {
  if (!Array.isArray(value)) return [];
  const out: EmbeddedMediaFile[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Partial<EmbeddedMediaFile>;
    if (typeof entry.mediaId !== 'string' || entry.mediaId.length === 0) continue;
    if (typeof entry.data !== 'string' || entry.data.length === 0) continue;
    out.push({
      mediaId: entry.mediaId,
      fileName:
        typeof entry.fileName === 'string' && entry.fileName.length > 0
          ? sanitizeMediaFileName(entry.fileName)
          : `${sanitizeMediaFileName(entry.mediaId)}.bin`,
      mimeType: typeof entry.mimeType === 'string' ? entry.mimeType : '',
      size: Number.isFinite(Number(entry.size)) ? Number(entry.size) : 0,
      data: entry.data,
    });
  }
  return out;
}

export interface RestoreEmbeddedMediaResult {
  /** The project with the new local paths of the restored media. */
  project: Project;
  /** Ids of the media that were written back to the local storage. */
  restored: string[];
  /** Ids of the media that could not be restored. */
  failed: string[];
  /**
   * D07 · Ids whose bytes were REFUSED: restoring them would exceed the same
   * size limit the export applies (`MAX_EMBEDDED_MEDIA_BYTES`). They are NOT
   * written to the disk.
   */
  skipped: string[];
  /**
   * D07 · Ids ignored because no `mediaPool`/`trash` item references them
   * (orphan payload): they are NOT written to the disk.
   */
  ignored: string[];
}

export interface RestoreEmbeddedMediaOptions {
  /** Maximum total bytes (decoded) accepted. Defaults to `MAX_EMBEDDED_MEDIA_BYTES`. */
  maxBytes?: number;
}

/**
 * Writes the embedded media bytes back into the local storage (OPFS, with
 * the IndexedDB fallback) and points the media items to their new path.
 *
 * D07: the same size limit the export enforces applies here too — a hostile
 * or corrupt file cannot exhaust the disk. Entries that would push the total
 * over the limit are skipped (with their id in `skipped`), and entries whose
 * `mediaId` nobody references (pool + trash) are ignored outright (orphan
 * bytes are never written).
 *
 * The media keeps its id, so the clips that reference it keep working; the
 * dead `blob:` URL of the exported file is replaced later by the
 * rehydration.
 */
export async function restoreEmbeddedMedia(
  project: Project,
  files: EmbeddedMediaFile[],
  options?: RestoreEmbeddedMediaOptions
): Promise<RestoreEmbeddedMediaResult> {
  const empty: RestoreEmbeddedMediaResult = { project, restored: [], failed: [], skipped: [], ignored: [] };
  if (!Array.isArray(files) || files.length === 0) return empty;

  const requested = Number(options?.maxBytes);
  const limitBytes =
    Number.isFinite(requested) && requested >= 0 ? requested : MAX_EMBEDDED_MEDIA_BYTES;

  // D07: solo los medios que el proyecto referencia tienen dueño; el resto es
  // carga huérfana y no se toca (ni se decodifica).
  const owned = new Set<string>();
  for (const item of Array.isArray(project?.mediaPool) ? project.mediaPool : []) {
    if (item && typeof item.id === 'string') owned.add(item.id);
  }
  for (const entry of Array.isArray(project?.trash) ? project.trash : []) {
    if (entry?.media && typeof entry.media.id === 'string') owned.add(entry.media.id);
  }

  const restored: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const ignored: string[] = [];
  let acceptedBytes = 0;

  /** mediaId -> { path, size } */
  const written = new Map<string, { path: string; size: number }>();

  for (const entry of files) {
    if (!owned.has(entry.mediaId)) {
      ignored.push(entry.mediaId);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(entry.data);
      if (bytes.byteLength === 0) throw new Error('El archivo incrustado está vacío.');
    } catch (err) {
      console.warn(`Could not restore the embedded media "${entry.mediaId}":`, err);
      failed.push(entry.mediaId);
      continue;
    }
    // D07: el tope es ACUMULADO (como en la exportación): lo que lo supera se
    // rechaza con un mensaje claro en el informe de importación.
    if (acceptedBytes + bytes.byteLength > limitBytes) {
      console.warn(
        `Embedded media "${entry.mediaId}" exceeds the import limit ` +
          `(${formatStorageBytes(limitBytes)}): skipped.`
      );
      skipped.push(entry.mediaId);
      continue;
    }
    try {
      const file = new File([bytes as Uint8Array<ArrayBuffer>], entry.fileName, {
        type: entry.mimeType || guessMimeType(entry.fileName),
      });
      const path = await opfsStorage.saveMediaToOPFS(entry.mediaId, file);
      written.set(entry.mediaId, { path, size: bytes.byteLength });
      acceptedBytes += bytes.byteLength;
      restored.push(entry.mediaId);
    } catch (err) {
      console.warn(`Could not restore the embedded media "${entry.mediaId}":`, err);
      failed.push(entry.mediaId);
    }
  }

  const apply = (item: MediaItem): MediaItem => {
    const local = written.get(item.id);
    if (!local) return item;
    return { ...item, opfsPath: local.path, size: local.size };
  };

  const mediaPool = (Array.isArray(project.mediaPool) ? project.mediaPool : []).map(apply);
  const trash = (Array.isArray(project.trash) ? project.trash : []).map((entry) => ({
    ...entry,
    media: apply(entry.media),
  }));

  return { project: { ...project, mediaPool, trash }, restored, failed, skipped, ignored };
}

/**
 * Imports a project file and returns a detailed report (warnings, missing
 * media, dropped items).
 *
 * A v2 file may carry the media bytes: they are written back into the local
 * storage and the project is rehydrated with them, so the imported project
 * really plays. A v1 (media-less) file keeps working exactly as before and
 * the media that cannot be found in the local storage is reported explicitly
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
  let embeddedFiles: EmbeddedMediaFile[] = [];

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (obj.project && typeof obj.project === 'object') {
      candidate = obj.project as Partial<Project>;
      mediaEmbedded = obj.mediaEmbedded === true;
    } else if (Array.isArray(obj.tracks) || Array.isArray(obj.clips) || obj.id) {
      candidate = obj as Partial<Project>;
    }
    embeddedFiles = parseEmbeddedMedia(obj.embeddedMedia);
    if (embeddedFiles.length > 0) mediaEmbedded = true;
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

  // The file carries the media bytes: they are written back to the local
  // storage BEFORE the rehydration, so the media plays again.
  let projectToRehydrate = sanitized.project;
  const restoredMedia: string[] = [];
  if (embeddedFiles.length > 0) {
    const restore = await restoreEmbeddedMedia(sanitized.project, embeddedFiles);
    projectToRehydrate = restore.project;
    restoredMedia.push(...restore.restored);
    if (restore.failed.length > 0) {
      warnings.push(
        `No se pudieron restaurar ${restore.failed.length} medio(s) del archivo exportado: ${restore.failed.join(', ')}.`
      );
    }
    // D07: lo rechazado por el tope y lo ignorado por huérfano se avisan con
    // un mensaje claro (nada se escribe en el disco por estas vías).
    if (restore.skipped.length > 0) {
      warnings.push(
        `Los medios incrustados superan el límite de ${formatStorageBytes(MAX_EMBEDDED_MEDIA_BYTES)}: ` +
          `no se han restaurado ${restore.skipped.length} medio(s) (${restore.skipped.join(', ')}).`
      );
    }
    if (restore.ignored.length > 0) {
      warnings.push(
        `${restore.ignored.length} medio(s) del archivo no pertenecen al proyecto y se han ignorado: ${restore.ignored.join(', ')}.`
      );
    }
  }

  if (!mediaEmbedded && sanitized.project.mediaPool.length > 0) {
    warnings.push(
      'El archivo exportado no incluye los archivos multimedia: los medios sólo se recuperarán si ya están en este equipo.'
    );
  }

  const rehydrated = await rehydrateProjectMediaWithReport(projectToRehydrate);
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
    restoredMedia,
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
