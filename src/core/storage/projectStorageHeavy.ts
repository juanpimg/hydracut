import { get } from 'idb-keyval';
import type { MediaItem, Project } from '../../types/project';
import * as opfsStorage from './opfsStorage';
import {
  MAX_EMBEDDED_MEDIA_BYTES,
  PROJECT_PREFIX,
  collectEmbeddableMedia,
  decodeBase64,
  encodeBase64,
  formatStorageBytes,
  getProjectById,
  guessMimeType,
  parseEmbeddedMedia,
  planMediaEmbedding,
  rehydrateProjectMediaWithReport,
  reportStorageError,
  reportStorageNotice,
  sanitizeImportedProject,
  sanitizeMediaFileName,
  saveProject,
  serializeProjectForExport,
  setLastImportReport,
  triggerProjectDownload,
} from './projectStorage';
import type {
  EmbeddedMediaCollection,
  EmbeddedMediaFile,
  ExportOptions,
  ExportOutcome,
  HydraProjectFile,
  ImportReport,
  MediaEmbedSkipReason,
  MediaEmbeddingPlan,
  RestoreEmbeddedMediaOptions,
  RestoreEmbeddedMediaResult,
} from './projectStorage';

/**
 * División del bundle inicial (`projectStorageHeavy`).
 *
 * Este módulo contiene la parte PESADA de `projectStorage.ts` que solo se
 * necesita bajo demanda:
 * - la exportación con medios incrustados (`.hydra` con bytes en base64),
 * - la importación con informe (lectura del archivo, restauración de bytes),
 * - la duplicación de proyectos (copia de bytes en OPFS).
 *
 * `projectStorage.ts` lo carga con `import()` dinámico dentro de envoltorios
 * con la MISMA firma asíncrona, así que el comportamiento no cambia: el
 * arranque (store, autosave, `WelcomeModal`, rehidratación) nunca descarga
 * este chunk. Los tipos e interfaces siguen declarados en `projectStorage.ts`
 * (coste cero en el bundle: se borran al compilar) y aquí solo se importan
 * con `import type`.
 */

/* ------------------------------------------------------------------ */
/* Exportación con medios incrustados (S-15)                           */
/* ------------------------------------------------------------------ */

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

  return exportProjectWithEmbeddedMedia(project, extension, plan);
}

/**
 * Reads the media bytes and writes the export file with them.
 *
 * Exportada para el envoltorio de `projectStorage.ts`: la vía sin medios se
 * resuelve allí de forma síncrona y solo esta vía con medios viaja al chunk.
 */
export async function exportProjectWithEmbeddedMedia(
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
/* Duplicación de proyectos (D02)                                      */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Importación con informe (S-16)                                      */
/* ------------------------------------------------------------------ */

/**
 * Imports project from a File (.hydra or .json). Validates schema, rehydrates media, and saves to IndexedDB.
 */
export async function importProjectFromFile(file: File): Promise<Project> {
  const report = await importProjectFromFileWithReport(file);
  return report.project;
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
  setLastImportReport(report);

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
