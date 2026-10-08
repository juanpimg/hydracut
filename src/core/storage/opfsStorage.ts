import { get, set, del } from 'idb-keyval';

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
 * Saves a file to OPFS with an IndexedDB fallback if OPFS is unavailable.
 */
export async function saveMediaToOPFS(mediaId: string, file: File): Promise<string> {
  const fileName = `${mediaId}_${file.name}`;

  if (await isOPFSSupported()) {
    try {
      const root = await navigator.storage.getDirectory();
      const mediaDir = await root.getDirectoryHandle('media', { create: true });
      const fileHandle = await mediaDir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await file.stream().pipeTo(writable);
      return fileName;
    } catch (err) {
      console.warn('OPFS write failed, falling back to IndexedDB:', err);
    }
  }

  // Fallback to IndexedDB
  await set(`media_${fileName}`, file);
  return fileName;
}

/**
 * Retrieves a File from OPFS or IndexedDB fallback.
 */
export async function getMediaFromOPFS(fileName: string): Promise<File | null> {
  if (await isOPFSSupported()) {
    try {
      const root = await navigator.storage.getDirectory();
      const mediaDir = await root.getDirectoryHandle('media', { create: false });
      const fileHandle = await mediaDir.getFileHandle(fileName, { create: false });
      return await fileHandle.getFile();
    } catch (err) {
      // Fall through to IDB fallback
    }
  }

  // Check IDB fallback
  const idbFile = await get<File>(`media_${fileName}`);
  return idbFile || null;
}

/**
 * Deletes a media file from OPFS and IndexedDB.
 */
export async function deleteMediaFromOPFS(fileName: string): Promise<void> {
  if (await isOPFSSupported()) {
    try {
      const root = await navigator.storage.getDirectory();
      const mediaDir = await root.getDirectoryHandle('media', { create: false });
      await mediaDir.removeEntry(fileName);
    } catch (err) {
      // Ignore if not found
    }
  }

  await del(`media_${fileName}`);
}
