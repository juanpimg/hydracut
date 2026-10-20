/**
 * Regression tests for the portability / storage wave (W-13).
 *
 * F1 — the storage manager (quota, projects, media, trash) is surfaced.
 * F2 — the `.hydra` export carries the media bytes (a real backup) and the
 *      import restores them into the local storage.
 * F3 — the sanitiser no longer drops `Clip.preservePitch` (nor any other
 *      field of `src/types/project.ts`).
 *
 * The suite runs in the node environment (no jsdom, no fake-indexeddb): the
 * pure logic (payload building/parsing, size estimation, the sanitiser) is
 * unit tested directly and the browser-only parts (OPFS, the storage
 * estimate) are exercised through their seams (the mocked OPFS module and
 * the mocked `navigator.storage`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  MAX_EMBEDDED_MEDIA_BYTES,
  base64EncodedSize,
  buildExportFileName,
  buildQuotaSnapshot,
  collectEmbeddedMedia,
  decodeBase64,
  encodeBase64,
  exportProjectToFile,
  formatStorageBytes,
  guessMimeType,
  importProjectFromFileWithReport,
  parseEmbeddedMedia,
  planMediaEmbedding,
  readStorageEstimate,
  restoreEmbeddedMedia,
  sanitizeImportedProject,
  serializeProjectForExport,
  summarizeStorageUsage,
  type EmbeddedMediaFile,
} from '../core/storage/projectStorage';
import { MediaItem, Project } from '../types/project';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

const memoryStore = new Map<string, any>();

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => memoryStore.get(key)),
  set: vi.fn(async (key: string, value: any) => {
    memoryStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    memoryStore.delete(key);
  }),
  keys: vi.fn(async () => Array.from(memoryStore.keys())),
  clear: vi.fn(async () => {
    memoryStore.clear();
  }),
}));

/** The "disk" of the fake OPFS: path -> File. */
const opfsDisk = new Map<string, File>();
const opfsSave = vi.fn(async (mediaId: string, file: File): Promise<string> => {
  const path = `${mediaId}_${file.name}`;
  opfsDisk.set(path, file);
  return path;
});

vi.mock('../core/storage/opfsStorage', () => ({
  getMediaFromOPFS: vi.fn(async (path: string) => opfsDisk.get(path) ?? null),
  saveMediaToOPFS: (...args: [string, File]) => opfsSave(...args),
  deleteMediaFilesFromOPFS: vi.fn(async () => undefined),
  deleteMediaFromOPFS: vi.fn(async () => undefined),
  isUsableMediaFile: (file: any) => !!file && typeof file.size === 'number' && file.size > 0,
}));

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const MEDIA_BYTES = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 10, 13, 0]);

function makeMedia(id: string, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    name: `${id}.mp4`,
    type: 'video',
    url: `blob:${id}`,
    duration: 12.5,
    width: 1920,
    height: 1080,
    fps: 30,
    thumbnailUrl: 'data:image/jpeg;base64,AAA',
    size: MEDIA_BYTES.byteLength,
    createdAt: 1000,
    opfsPath: `${id}_${id}.mp4`,
    ...overrides,
  };
}

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: 'Proyecto portable',
    aspectRatio: '16:9',
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    tracks: [{ id: 't1', name: 'V1', type: 'video', isMuted: false, isLocked: false, isVisible: true }],
    clips: [
      {
        id: 'c1',
        trackId: 't1',
        mediaId: 'm1',
        name: 'Clip',
        type: 'video',
        start: 0,
        duration: 12.5,
        sourceStart: 0,
        sourceDuration: 12.5,
        volume: 1,
        opacity: 1,
        scale: 1,
        positionX: 0,
        positionY: 0,
        muted: false,
      },
    ],
    mediaPool: [],
    duration: 12.5,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/**
 * Installs a fake `document` that captures the downloaded file (name + body).
 */
function installDownloadCapture(): {
  captured: { name: string; body: string };
  restore: () => void;
} {
  const captured = { name: '', body: '' };
  const blobsByUrl = new Map<string, Blob>();
  const originalDocument = globalThis.document;
  const originalCreate = globalThis.URL.createObjectURL;
  const originalRevoke = globalThis.URL.revokeObjectURL;

  (globalThis.URL as any).createObjectURL = (blob: Blob) => {
    const url = `blob:mock-${blobsByUrl.size}`;
    blobsByUrl.set(url, blob);
    return url;
  };
  (globalThis.URL as any).revokeObjectURL = () => undefined;

  (globalThis as any).document = {
    createElement: () => ({
      set href(value: string) {
        const blob = blobsByUrl.get(value);
        if (blob) {
          void blob.text().then((text) => {
            captured.body = text;
          });
        }
      },
      set download(value: string) {
        captured.name = value;
      },
      click: () => undefined,
    }),
    body: { appendChild: () => undefined, removeChild: () => undefined },
  };

  return {
    captured,
    restore: () => {
      (globalThis as any).document = originalDocument;
      (globalThis.URL as any).createObjectURL = originalCreate;
      (globalThis.URL as any).revokeObjectURL = originalRevoke;
    },
  };
}

beforeEach(() => {
  memoryStore.clear();
  opfsDisk.clear();
  vi.clearAllMocks();
  if (typeof globalThis.URL.createObjectURL === 'undefined') {
    (globalThis.URL as any).createObjectURL = vi.fn(() => 'blob:mock-url');
  }
  if (typeof globalThis.URL.revokeObjectURL === 'undefined') {
    (globalThis.URL as any).revokeObjectURL = vi.fn();
  }
});

/* ------------------------------------------------------------------ */
/* F3 — the sanitiser must not drop any field of the project model      */
/* ------------------------------------------------------------------ */

describe('F3 — el saneador no descarta campos del modelo', () => {
  const candidate = {
    id: 'p1',
    name: 'Con pitch',
    aspectRatio: '16:9' as const,
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    tracks: [{ id: 't1', name: 'V1', type: 'video' as const, isMuted: false, isLocked: false, isVisible: true }],
    clips: [
      {
        id: 'c1',
        trackId: 't1',
        mediaId: 'm1',
        name: 'Sin conservar tono',
        type: 'video' as const,
        start: 0,
        duration: 4,
        sourceStart: 0,
        sourceDuration: 10,
        volume: 1,
        opacity: 1,
        scale: 1,
        positionX: 0,
        positionY: 0,
        muted: false,
        speed: 2,
        preservePitch: false,
      },
      {
        id: 'c2',
        trackId: 't1',
        mediaId: 'm2',
        name: 'Conservando tono',
        type: 'video' as const,
        start: 4,
        duration: 4,
        sourceStart: 0,
        sourceDuration: 10,
        volume: 1,
        opacity: 1,
        scale: 1,
        positionX: 0,
        positionY: 0,
        muted: false,
        preservePitch: true,
      },
      {
        id: 'c3',
        trackId: 't1',
        mediaId: 'm3',
        name: 'Sin definir',
        type: 'video' as const,
        start: 8,
        duration: 4,
        sourceStart: 0,
        sourceDuration: 10,
        volume: 1,
        opacity: 1,
        scale: 1,
        positionX: 0,
        positionY: 0,
        muted: false,
      },
    ],
    mediaPool: [],
    duration: 12,
    endPaddingSeconds: 2.5,
    createdAt: 1,
    updatedAt: 1,
  };

  it('conserva `preservePitch: false` (no se puede perder con un `|| true`)', () => {
    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });

    const clip = result.project.clips.find((c) => c.id === 'c1');
    expect(clip).toBeDefined();
    expect(clip?.preservePitch).toBe(false);
  });

  it('conserva `preservePitch: true`', () => {
    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });
    expect(result.project.clips.find((c) => c.id === 'c2')?.preservePitch).toBe(true);
  });

  it('deja `preservePitch` sin definir cuando el proyecto no lo tenía', () => {
    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });
    expect(result.project.clips.find((c) => c.id === 'c3')?.preservePitch).toBeUndefined();
  });

  it('conserva `endPaddingSeconds` (la cola opt-in de la línea de tiempo)', () => {
    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });
    expect(result.project.endPaddingSeconds).toBe(2.5);
  });

  it('no inventa un `endPaddingSeconds` cuando el proyecto no lo tenía', () => {
    const { endPaddingSeconds, ...withoutPadding } = candidate;
    const result = sanitizeImportedProject(withoutPadding, { projectId: 'p', fallbackName: 'x' });
    expect(result.project.endPaddingSeconds).toBeUndefined();
  });

  it('conserva el resto de campos del clip (velocidad, texto, transiciones y letras)', () => {
    const rich = {
      ...candidate,
      clips: [
        {
          ...candidate.clips[0],
          preservePitch: false,
          text: 'hola',
          words: [{ word: 'hola', start: 0, end: 1 }],
          transition: {
            fadeInType: 'fade-black' as const,
            fadeInDuration: 0.5,
            fadeOutType: 'none' as const,
            fadeOutDuration: 0,
          },
        },
      ],
    };
    const result = sanitizeImportedProject(rich, { projectId: 'p', fallbackName: 'x' });
    const clip = result.project.clips[0];

    expect(clip.speed).toBe(2);
    expect(clip.text).toBe('hola');
    expect(clip.words).toHaveLength(1);
    expect(clip.transition?.fadeInType).toBe('fade-black');
    expect(clip.preservePitch).toBe(false);
  });

  it('conserva los filtros de color del clip (F9) y acota sus valores', () => {
    // `filters` is a newer field of the clip model: the sanitiser must not
    // drop it either (it changes how the clip is drawn and exported).
    const withFilters = {
      ...candidate,
      clips: [
        {
          ...candidate.clips[0],
          filters: { brightness: 1.4, contrast: 0.8, sepia: 5, temperature: -3 },
        } as any,
      ],
    };

    const result = sanitizeImportedProject(withFilters, { projectId: 'p', fallbackName: 'x' });
    const filters = (result.project.clips[0] as any)?.filters;

    expect(filters).toBeDefined();
    expect(filters.brightness).toBe(1.4);
    expect(filters.contrast).toBe(0.8);
    expect(filters.sepia).toBe(1); // clamped to its maximum
    expect(filters.temperature).toBe(-1); // clamped to its minimum
  });

  it('no inventa filtros de color cuando el clip no los tenía', () => {
    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });
    expect((result.project.clips[0] as any)?.filters).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* F2 — the export carries the media (a real backup)                   */
/* ------------------------------------------------------------------ */

describe('F2 — el export incluye los medios (copia de seguridad real)', () => {
  it('codifica y decodifica base64 sin perder un solo byte', () => {
    const encoded = encodeBase64(MEDIA_BYTES);
    expect(encoded).toBe(Buffer.from(MEDIA_BYTES).toString('base64'));
    expect(Array.from(decodeBase64(encoded))).toEqual(Array.from(MEDIA_BYTES));
  });

  it('codifica en base64 los tamaños múltiplos de 3 y los que no', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 100]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 7) % 256);
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
      expect(Array.from(decodeBase64(encodeBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('estima el tamaño base64 (33 % de sobrecarga)', () => {
    expect(base64EncodedSize(0)).toBe(0);
    expect(base64EncodedSize(3)).toBe(4);
    expect(base64EncodedSize(4)).toBe(8);
    expect(base64EncodedSize(12)).toBe(16);
    expect(base64EncodedSize(1_000_000)).toBe(1_333_336);
  });

  it('codifica un payload grande sin volverse cuadrático', () => {
    const big = new Uint8Array(512 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 256;

    const started = Date.now();
    const encoded = encodeBase64(big);
    const decoded = decodeBase64(encoded);
    const elapsed = Date.now() - started;

    expect(decoded.length).toBe(big.length);
    expect(decoded[12345]).toBe(big[12345]);
    expect(decoded[big.length - 1]).toBe(big[big.length - 1]);
    expect(elapsed).toBeLessThan(5000);
  });

  it('el plan de incrustación dice "no hay medios" en un proyecto vacío', () => {
    const plan = planMediaEmbedding(makeProject('p1'));
    expect(plan.embed).toBe(false);
    expect(plan.skipped).toBe('no-media');
    expect(plan.mediaCount).toBe(0);
  });

  it('el plan de incrustación respeta la opción "sin medios"', () => {
    const plan = planMediaEmbedding(makeProject('p1', { mediaPool: [makeMedia('m1')] }), {
      includeMedia: false,
    });
    expect(plan.embed).toBe(false);
    expect(plan.skipped).toBe('disabled');
  });

  it('el plan de incrustación rechaza los payloads que superan el límite', () => {
    const plan = planMediaEmbedding(
      makeProject('p1', { mediaPool: [makeMedia('m1', { size: 5_000_000 })] }),
      { maxEmbeddedBytes: 1024 }
    );
    expect(plan.embed).toBe(false);
    expect(plan.skipped).toBe('too-large');
    expect(plan.estimatedBytes).toBeGreaterThan(1024);
  });

  it('el plan de incrustación acepta un payload razonable', () => {
    const plan = planMediaEmbedding(makeProject('p1', { mediaPool: [makeMedia('m1')] }));
    expect(plan.embed).toBe(true);
    expect(plan.skipped).toBeNull();
    expect(plan.mediaCount).toBe(1);
    expect(plan.limitBytes).toBe(MAX_EMBEDDED_MEDIA_BYTES);
  });

  it('cuenta también los medios de la papelera', () => {
    const project = makeProject('p1', {
      mediaPool: [makeMedia('m1')],
      trash: [
        {
          media: makeMedia('m2'),
          clips: [],
          deletedAt: 1,
        },
      ],
    });
    expect(planMediaEmbedding(project).mediaCount).toBe(2);
  });

  it('el sobre sin opciones sigue siendo el v1 sin medios (compatibilidad)', () => {
    const envelope = serializeProjectForExport(makeProject('p1', { mediaPool: [makeMedia('m1')] }));
    expect(envelope.version).toBe(1);
    expect(envelope.mediaEmbedded).toBe(false);
    expect(envelope.mediaCount).toBe(1);
    expect(envelope.embeddedMedia).toBeUndefined();
  });

  it('el sobre con medios es v2 y los declara incrustados', () => {
    const files: EmbeddedMediaFile[] = [
      { mediaId: 'm1', fileName: 'm1.mp4', mimeType: 'video/mp4', size: 12, data: 'AAAA' },
    ];
    const envelope = serializeProjectForExport(makeProject('p1'), { embeddedMedia: files });
    expect(envelope.version).toBe(2);
    expect(envelope.mediaEmbedded).toBe(true);
    expect(envelope.embeddedMedia).toHaveLength(1);
  });

  it('el nombre del fichero dice si los medios viajan con el proyecto', () => {
    expect(buildExportFileName('Mi proyecto', 'hydra', true)).toBe('mi_proyecto.hydra');
    expect(buildExportFileName('Mi proyecto', 'hydra', false)).toBe('mi_proyecto-sin-medios.hydra');
  });

  it('lee los bytes de los medios y los codifica en base64', async () => {
    opfsDisk.set('m1_m1.mp4', new File([MEDIA_BYTES], 'm1.mp4', { type: 'video/mp4' }));
    const project = makeProject('p1', { mediaPool: [makeMedia('m1')] });

    const { files, missing } = await collectEmbeddedMedia(project);

    expect(missing).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0].mediaId).toBe('m1');
    expect(files[0].data).toBe(Buffer.from(MEDIA_BYTES).toString('base64'));
    expect(files[0].size).toBe(MEDIA_BYTES.byteLength);
  });

  it('informa de los medios que no se pudieron leer', async () => {
    const project = makeProject('p1', { mediaPool: [makeMedia('m1')] });
    const { files, missing } = await collectEmbeddedMedia(project);
    expect(files).toEqual([]);
    expect(missing).toEqual(['m1.mp4']);
  });

  it('exporta con medios por defecto y el fichero los contiene', async () => {
    opfsDisk.set('m1_m1.mp4', new File([MEDIA_BYTES], 'm1.mp4', { type: 'video/mp4' }));
    const project = makeProject('p1', { mediaPool: [makeMedia('m1')] });
    const capture = installDownloadCapture();

    try {
      const outcome = await exportProjectToFile(project, 'hydra');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(outcome.mediaEmbedded).toBe(true);
      expect(outcome.embeddedCount).toBe(1);
      expect(capture.captured.name).toBe('proyecto_portable.hydra');
      expect(capture.captured.name).not.toMatch(/sin-medios/);

      const envelope = JSON.parse(capture.captured.body);
      expect(envelope.mediaEmbedded).toBe(true);
      expect(envelope.embeddedMedia).toHaveLength(1);
      expect(envelope.embeddedMedia[0].mediaId).toBe('m1');
      expect(envelope.embeddedMedia[0].data).toBe(Buffer.from(MEDIA_BYTES).toString('base64'));
    } finally {
      capture.restore();
    }
  });

  it('cae en el formato sin medios (y lo dice en el nombre) cuando el payload no cabe', async () => {
    opfsDisk.set('m1_m1.mp4', new File([MEDIA_BYTES], 'm1.mp4', { type: 'video/mp4' }));
    const project = makeProject('p1', { mediaPool: [makeMedia('m1', { size: 5_000_000 })] });
    const capture = installDownloadCapture();

    try {
      const outcome = await exportProjectToFile(project, 'hydra', { maxEmbeddedBytes: 1024 });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(outcome.mediaEmbedded).toBe(false);
      expect(outcome.skipped).toBe('too-large');
      expect(capture.captured.name).toMatch(/sin-medios\.hydra$/);

      const envelope = JSON.parse(capture.captured.body);
      expect(envelope.mediaEmbedded).toBe(false);
      expect(envelope.embeddedMedia).toBeUndefined();
      expect(envelope.mediaEmbedSkipped).toBe('too-large');
    } finally {
      capture.restore();
    }
  });

  it('un proyecto sin medios conserva el sobre v1 y el nombre "-sin-medios"', async () => {
    const capture = installDownloadCapture();

    try {
      const outcome = await exportProjectToFile(makeProject('p1'), 'hydra');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(outcome.mediaEmbedded).toBe(false);
      expect(outcome.skipped).toBe('no-media');
      expect(capture.captured.name).toMatch(/sin-medios\.hydra$/);
      expect(JSON.parse(capture.captured.body).version).toBe(1);
    } finally {
      capture.restore();
    }
  });
});

/* ------------------------------------------------------------------ */
/* F2 — the import restores the embedded media                          */
/* ------------------------------------------------------------------ */

describe('F2 — la importación restaura los medios incrustados', () => {
  it('ignora las entradas mal formadas del payload', () => {
    const parsed = parseEmbeddedMedia([
      { mediaId: 'm1', fileName: 'm1.mp4', mimeType: 'video/mp4', size: 10, data: 'AAAA' },
      { mediaId: '', data: 'AAAA' },
      { mediaId: 'm2' },
      null,
      'nope',
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].mediaId).toBe('m1');
    expect(parseEmbeddedMedia(undefined)).toEqual([]);
    expect(parseEmbeddedMedia('nope')).toEqual([]);
  });

  it('escribe los bytes incrustados en el almacenamiento local y apunta allí', async () => {
    const project = makeProject('p1', { mediaPool: [makeMedia('m1')] });
    const files: EmbeddedMediaFile[] = [
      {
        mediaId: 'm1',
        fileName: 'm1.mp4',
        mimeType: 'video/mp4',
        size: MEDIA_BYTES.byteLength,
        data: Buffer.from(MEDIA_BYTES).toString('base64'),
      },
    ];

    const result = await restoreEmbeddedMedia(project, files);

    expect(result.restored).toEqual(['m1']);
    expect(result.failed).toEqual([]);
    expect(opfsSave).toHaveBeenCalledTimes(1);
    const [mediaId, file] = opfsSave.mock.calls[0] as unknown as [string, File];
    expect(mediaId).toBe('m1');
    expect(file.name).toBe('m1.mp4');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(MEDIA_BYTES);

    // The media points to the NEW local path (not the dead one of the export).
    expect(result.project.mediaPool[0].opfsPath).toBe('m1_m1.mp4');
    expect(result.project.mediaPool[0].size).toBe(MEDIA_BYTES.byteLength);
  });

  it('restaura también los medios de la papelera', async () => {
    const project = makeProject('p1', {
      mediaPool: [],
      trash: [{ media: makeMedia('m2'), clips: [], deletedAt: 1 }],
    });
    const files: EmbeddedMediaFile[] = [
      {
        mediaId: 'm2',
        fileName: 'm2.mp4',
        mimeType: 'video/mp4',
        size: MEDIA_BYTES.byteLength,
        data: Buffer.from(MEDIA_BYTES).toString('base64'),
      },
    ];

    const result = await restoreEmbeddedMedia(project, files);

    expect(result.restored).toEqual(['m2']);
    expect(result.project.trash?.[0].media.opfsPath).toBe('m2_m2.mp4');
  });

  it('ida y vuelta: exportar con medios e importar deja el proyecto reproducible', async () => {
    // 1. The project lives in this browser with its bytes in the "disk".
    opfsDisk.set('m1_m1.mp4', new File([MEDIA_BYTES], 'm1.mp4', { type: 'video/mp4' }));
    const project = makeProject('p1', { mediaPool: [makeMedia('m1')] });
    const capture = installDownloadCapture();
    let exported = '';

    try {
      await exportProjectToFile(project, 'hydra');
      await new Promise((resolve) => setTimeout(resolve, 0));
      exported = capture.captured.body;
    } finally {
      capture.restore();
    }

    expect(exported.length).toBeGreaterThan(0);

    // 2. Another browser: the disk is empty, only the file travels.
    opfsDisk.clear();
    const file = new File([exported], 'copia.hydra', { type: 'application/json' });
    const report = await importProjectFromFileWithReport(file);

    expect(report.mediaEmbedded).toBe(true);
    expect(report.missingMedia).toEqual([]);
    expect(report.restoredMedia).toEqual(['m1']);

    // The media is back on the disk, with the same bytes...
    const restored = opfsDisk.get('m1_m1.mp4');
    expect(restored).toBeDefined();
    expect(new Uint8Array(await restored!.arrayBuffer())).toEqual(MEDIA_BYTES);

    // ...with the same duration, and the clips still reference it.
    const media = report.project.mediaPool[0];
    expect(media.id).toBe('m1');
    expect(media.duration).toBe(12.5);
    expect(media.opfsPath).toBe('m1_m1.mp4');
    expect(media.url.startsWith('blob:')).toBe(true);
    expect(media.status).toBe('ok');
    expect(report.project.clips[0].mediaId).toBe('m1');
    expect(report.warnings.join(' ')).not.toMatch(/no incluye los archivos multimedia/i);
  });

  it('un fichero sin medios sigue importándose y avisa de los medios que faltan', async () => {
    const envelope = serializeProjectForExport(makeProject('p1', { mediaPool: [makeMedia('m1')] }));
    const file = new File([JSON.stringify(envelope)], 'p1.hydra', { type: 'application/json' });

    const report = await importProjectFromFileWithReport(file);

    expect(report.mediaEmbedded).toBe(false);
    expect(report.missingMedia).toEqual(['m1.mp4']);
    expect(report.warnings.join(' ')).toMatch(/no incluye los archivos multimedia/i);
  });

  it('un medio incrustado corrupto se reporta en vez de romper la importación', async () => {
    const envelope = serializeProjectForExport(makeProject('p1', { mediaPool: [makeMedia('m1')] }));
    const payload = {
      ...envelope,
      version: 2,
      mediaEmbedded: true,
      embeddedMedia: [
        { mediaId: 'm1', fileName: 'm1.mp4', mimeType: 'video/mp4', size: 3, data: '!!!no-base64!!!' },
      ],
    };
    const file = new File([JSON.stringify(payload)], 'p1.hydra', { type: 'application/json' });

    const report = await importProjectFromFileWithReport(file);

    expect(report.project.mediaPool).toHaveLength(1);
    expect(report.restoredMedia ?? []).toEqual([]);
    expect(report.warnings.join(' ')).toMatch(/no se pudieron restaurar/i);
  });
});

/* ------------------------------------------------------------------ */
/* F1 — the storage manager                                             */
/* ------------------------------------------------------------------ */

describe('F1 — gestor de almacenamiento', () => {
  it('calcula el porcentaje de cuota y no avisa cuando todo va bien', () => {
    const snapshot = buildQuotaSnapshot(50, 100);
    expect(snapshot.percent).toBe(50);
    expect(snapshot.level).toBe('ok');
    expect(snapshot.message).toBeNull();
  });

  it('avisa cuando la cuota está casi agotada (más del 80 %)', () => {
    const snapshot = buildQuotaSnapshot(85, 100);
    expect(snapshot.percent).toBe(85);
    expect(snapshot.level).toBe('warning');
    expect(snapshot.message).toMatch(/queda poco espacio/i);
    expect(snapshot.message).toMatch(/papelera/i);
  });

  it('avisa con un mensaje accionable cuando la cuota está agotada', () => {
    const snapshot = buildQuotaSnapshot(100, 100);
    expect(snapshot.level).toBe('critical');
    expect(snapshot.message).toMatch(/almacenamiento lleno/i);
    expect(snapshot.message).toMatch(/vacía la papelera|elimina proyectos/i);
  });

  it('no rompe cuando la cuota es 0 o desconocida', () => {
    const snapshot = buildQuotaSnapshot(10, 0);
    expect(snapshot.percent).toBe(0);
    expect(snapshot.level).toBe('ok');
    expect(snapshot.message).toBeNull();
  });

  it('formatea los tamaños en español', () => {
    expect(formatStorageBytes(0)).toBe('0 B');
    expect(formatStorageBytes(512)).toBe('512 B');
    expect(formatStorageBytes(1536)).toBe('1,5 KB');
    expect(formatStorageBytes(5 * 1024 * 1024)).toBe('5,0 MB');
    expect(formatStorageBytes(2 * 1024 * 1024 * 1024)).toBe('2,0 GB');
  });

  it('resume proyectos, medios y papelera', () => {
    const project = makeProject('p1', {
      mediaPool: [makeMedia('m1', { size: 1000 }), makeMedia('m2', { size: 500 })],
      trash: [{ media: makeMedia('m3', { size: 250 }), clips: [], deletedAt: 1 }],
    });

    const summary = summarizeStorageUsage(4, project);

    expect(summary.projects).toBe(4);
    expect(summary.mediaItems).toBe(2);
    expect(summary.mediaBytes).toBe(1500);
    expect(summary.trashItems).toBe(1);
    expect(summary.trashBytes).toBe(250);
  });

  it('acepta el índice de proyectos o su número', () => {
    const index = [
      { id: 'a', name: 'A', aspectRatio: '16:9' as const, duration: 1, tracksCount: 0, clipsCount: 0, createdAt: 1, updatedAt: 1 },
      { id: 'b', name: 'B', aspectRatio: '16:9' as const, duration: 1, tracksCount: 0, clipsCount: 0, createdAt: 1, updatedAt: 1 },
    ];
    expect(summarizeStorageUsage(index, null).projects).toBe(2);
    expect(summarizeStorageUsage(2, null).projects).toBe(2);
    expect(summarizeStorageUsage(null, null).projects).toBe(0);
  });

  it('devuelve null cuando la API de cuota no está disponible', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });

    try {
      await expect(readStorageEstimate()).resolves.toBeNull();
    } finally {
      if (previous) Object.defineProperty(globalThis, 'navigator', previous);
      else delete (globalThis as any).navigator;
    }
  });

  it('lee la cuota cuando la API está disponible', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { storage: { estimate: async () => ({ usage: 250, quota: 1000 }) } },
      configurable: true,
      writable: true,
    });

    try {
      await expect(readStorageEstimate()).resolves.toEqual({ usage: 250, quota: 1000 });
    } finally {
      if (previous) Object.defineProperty(globalThis, 'navigator', previous);
      else delete (globalThis as any).navigator;
    }
  });

  it('el panel de medios ofrece la cuota, la papelera y la copia de seguridad', () => {
    const mediaBin = readFileSync(new URL('../components/media/MediaBin.tsx', import.meta.url), 'utf8');

    expect(mediaBin).toContain('storage-panel');
    expect(mediaBin).toContain('Almacenamiento');
    expect(mediaBin).toContain('Vaciar papelera');
    expect(mediaBin).toContain('Copia de seguridad');
    expect(mediaBin).toContain('storage-purge-trash');
    expect(mediaBin).toContain('storage-backup');
    expect(mediaBin).toContain('role="progressbar"');
    // The purge is the physical deletion (the store's purgeTrash).
    expect(mediaBin).toMatch(/purgeTrash\(\)/);
    // The quota comes from the Storage API.
    expect(mediaBin).toContain('readStorageEstimate');
    // No hover-only affordance in the media bin (it is used on mobile too).
    expect(mediaBin).not.toContain('opacity-0');
    // Touch friendly actions.
    expect(mediaBin).toMatch(/storage-purge-trash[\s\S]{0,600}min-h-\[36px\]/);
  });

  it('la tarjeta de medios enseña el espacio que ocupa en el disco', () => {
    const card = readFileSync(new URL('../components/media/MediaItemCard.tsx', import.meta.url), 'utf8');

    expect(card).toContain('media-size-');
    expect(card).toContain('formatStorageBytes');
  });
});

/* ------------------------------------------------------------------ */
/* Helpers (mime type)                                                  */
/* ------------------------------------------------------------------ */

describe('F2 — tipos MIME', () => {
  it('adivina el tipo MIME a partir de la extensión', () => {
    expect(guessMimeType('clip.mp4')).toBe('video/mp4');
    expect(guessMimeType('cancion.MP3')).toBe('audio/mpeg');
    expect(guessMimeType('foto.jpeg')).toBe('image/jpeg');
    expect(guessMimeType('desconocido.xyz')).toBe('');
    expect(guessMimeType('')).toBe('');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
