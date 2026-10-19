import { get, set, del } from 'idb-keyval';

const MEDIA_DIRECTORY = 'media';

/**
 * Cached handle of the OPFS directory that stores the media files.
 *
 * Resolving a directory handle costs two asynchronous filesystem calls, and
 * `rehydrateProjectMedia` resolves one handle per media item on every project
 * load. The handle stays valid for the lifetime of the origin, so it is cached
 * and only invalidated when an operation proves it stale.
 */
let cachedMediaDir: FileSystemDirectoryHandle | null = null;

/**
 * Checks if Origin Private File System (OPFS) is available in the browser.
 */
export async function isOPFSSupported(): Promise<boolean> {
  try {
    return typeof navigator !== 'undefined' && 'storage' in navigator && typeof navigator.storage.getDirectory === 'function';
  } catch {
    return false;
  }
}

/**
 * Pure validity check for a media file read back from storage.
 *
 * A file that was half-written (interrupted upload / interrupted flush) can be
 * present in OPFS with a truncated body. Such a file must never be preferred
 * over a healthy copy, so it is rejected here.
 */
export function isUsableMediaFile(file: File | Blob | null | undefined): file is File {
  if (!file || typeof file !== 'object') return false;
  const size = (file as Blob).size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return false;
  return true;
}

/**
 * Resolves (and caches) the OPFS directory holding the media files.
 * Returns null when OPFS is unavailable or the directory does not exist.
 */
async function getMediaDirectory(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (cachedMediaDir) return cachedMediaDir;
  if (!(await isOPFSSupported())) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(MEDIA_DIRECTORY, { create });
    cachedMediaDir = dir;
    return dir;
  } catch {
    return null;
  }
}

function invalidateMediaDirectory(): void {
  cachedMediaDir = null;
}

/**
 * Reads the raw file from OPFS (no validity filtering).
 */
async function readOpfsFile(fileName: string): Promise<File | null> {
  const mediaDir = await getMediaDirectory(false);
  if (!mediaDir) return null;
  try {
    const fileHandle = await mediaDir.getFileHandle(fileName, { create: false });
    return await fileHandle.getFile();
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name !== 'NotFoundError') invalidateMediaDirectory();
    return null;
  }
}

/**
 * Reads the IndexedDB fallback copy of a media file.
 */
async function readIdbMedia(fileName: string): Promise<File | null> {
  try {
    const idbFile = await get<File>(`media_${fileName}`);
    return idbFile ?? null;
  } catch {
    return null;
  }
}

/**
 * Saves a file to OPFS with an IndexedDB fallback if OPFS is unavailable.
 */
export async function saveMediaToOPFS(mediaId: string, file: File): Promise<string> {
  const fileName = `${mediaId}_${file.name}`;

  const mediaDir = await getMediaDirectory(true);
  if (mediaDir) {
    try {
      const fileHandle = await mediaDir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await file.stream().pipeTo(writable);
      return fileName;
    } catch (err) {
      invalidateMediaDirectory();
      console.warn('OPFS write failed, falling back to IndexedDB:', err);
    }
  }

  // Fallback to IndexedDB
  await set(`media_${fileName}`, file);
  return fileName;
}

/**
 * Retrieves a File from OPFS or IndexedDB fallback.
 *
 * The OPFS copy is only preferred when it is actually usable (readable and
 * non-empty). A truncated/half-written OPFS file loses against a healthy
 * IndexedDB copy instead of silently shadowing it.
 */
export async function getMediaFromOPFS(fileName: string): Promise<File | null> {
  const opfsFile = await readOpfsFile(fileName);
  const idbFile = await readIdbMedia(fileName);

  const opfsUsable = isUsableMediaFile(opfsFile);
  const idbUsable = isUsableMediaFile(idbFile);

  if (opfsUsable && idbUsable) {
    // Both copies exist: the bigger one is the intact one.
    return idbFile.size > opfsFile.size ? idbFile : opfsFile;
  }
  if (opfsUsable) return opfsFile;
  if (idbUsable) return idbFile;
  return null;
}

/**
 * Deletes a media file from OPFS and IndexedDB.
 */
export async function deleteMediaFromOPFS(fileName: string): Promise<void> {
  if (!fileName) return;

  const mediaDir = await getMediaDirectory(false);
  if (mediaDir) {
    try {
      await mediaDir.removeEntry(fileName);
    } catch (err) {
      const e = err as { name?: string };
      if (e?.name !== 'NotFoundError') invalidateMediaDirectory();
      // Ignore if not found
    }
  }

  await del(`media_${fileName}`);
}

/**
 * Deletes a batch of media files (OPFS + IndexedDB fallback).
 * Never throws: a failure to delete one file must not abort the cleanup of
 * the rest, otherwise the storage quota keeps growing forever.
 */
export async function deleteMediaFilesFromOPFS(fileNames: string[]): Promise<void> {
  const unique = Array.from(
    new Set((Array.isArray(fileNames) ? fileNames : []).filter((f) => typeof f === 'string' && f.length > 0))
  );
  for (const name of unique) {
    try {
      await deleteMediaFromOPFS(name);
    } catch (err) {
      console.warn(`Failed to delete media file "${name}":`, err);
    }
  }
}
