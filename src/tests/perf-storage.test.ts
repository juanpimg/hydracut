/**
 * Regression tests for the O4 performance / storage wave (W-4a).
 *
 * Every test here fails on the pre-fix code and passes after the fix.
 * The suites run in the node environment (no jsdom), so the DOM-only
 * behaviours are asserted through the pure helpers extracted from the
 * production modules, plus source level guards for the listener/gesture
 * wiring that cannot be mounted without a DOM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_KEY,
  PROJECT_PREFIX,
  PROJECTS_INDEX_KEY,
  autosaveProject,
  deleteProject,
  exportProjectToFile,
  flushAutosave,
  getLastImportReport,
  importProjectFromFileWithReport,
  mergeProjectMetadata,
  rehydrateProjectMedia,
  removeProjectMetadata,
  revokeMediaObjectUrls,
  sanitizeImportedProject,
  saveProject,
  serializeProjectForExport,
  subscribeStorageEvents,
  updateProjectMetadata,
  type StorageErrorEvent,
  type StorageEvent,
} from '../core/storage/projectStorage';
import { generateRulerTicks, getRulerTickWindow } from '../components/timeline/TimeRuler';
import { Project, MediaItem, Track } from '../types/project';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

const memoryStore = new Map<string, any>();

const getSpy = vi.fn(async (key: string) => memoryStore.get(key));
const setSpy = vi.fn(async (key: string, value: any) => {
  memoryStore.set(key, value);
});
const delSpy = vi.fn(async (key: string) => {
  memoryStore.delete(key);
});

vi.mock('idb-keyval', () => ({
  get: (key: string) => getSpy(key),
  set: (key: string, value: any) => setSpy(key, value),
  del: (key: string) => delSpy(key),
  keys: async () => Array.from(memoryStore.keys()),
  clear: async () => {
    memoryStore.clear();
  },
}));

const opfsGetMedia = vi.fn(async (_path: string): Promise<File | null> => null);
const opfsDeleteFiles = vi.fn(async (_paths: string[]): Promise<void> => undefined);

vi.mock('../core/storage/opfsStorage', () => ({
  getMediaFromOPFS: (path: string) => opfsGetMedia(path),
  deleteMediaFilesFromOPFS: (paths: string[]) => opfsDeleteFiles(paths),
  deleteMediaFromOPFS: async () => undefined,
  saveMediaToOPFS: async () => 'saved_file',
  isUsableMediaFile: (file: any) => !!file && typeof file.size === 'number' && file.size > 0,
}));

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeTrack(id: string, type: Track['type'] = 'video'): Track {
  return { id, name: id, type, isMuted: false, isLocked: false, isVisible: true };
}

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: `Proyecto ${id}`,
    aspectRatio: '16:9',
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    tracks: [makeTrack('t1')],
    clips: [],
    mediaPool: [],
    duration: 30,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeMedia(id: string, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    name: `${id}.mp4`,
    type: 'video',
    url: `blob:${id}`,
    duration: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    thumbnailUrl: 'data:image/jpeg;base64,AAA',
    size: 1024,
    createdAt: 1000,
    opfsPath: `${id}_${id}.mp4`,
    ...overrides,
  };
}

const sourceOf = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

const clipItemSource = sourceOf('../components/timeline/ClipItem.tsx');
const playheadSource = sourceOf('../components/timeline/Playhead.tsx');
const timeRulerSource = sourceOf('../components/timeline/TimeRuler.tsx');

let createObjectURLSpy: ReturnType<typeof vi.fn>;
let revokeObjectURLSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  memoryStore.clear();
  getSpy.mockClear();
  setSpy.mockClear();
  delSpy.mockClear();
  opfsGetMedia.mockClear();
  opfsGetMedia.mockResolvedValue(null);
  opfsDeleteFiles.mockClear();
  // Contador determinista en vez de `Math.random()`: ante un fallo, el mensaje
  // muestra la misma URL en cada ejecución y el run es reproducible.
  let contadorUrls = 0;
  createObjectURLSpy = vi.fn(() => `blob:mock-${++contadorUrls}`);
  revokeObjectURLSpy = vi.fn();
  (globalThis as any).URL.createObjectURL = createObjectURLSpy;
  (globalThis as any).URL.revokeObjectURL = revokeObjectURLSpy;
});

afterEach(() => {
  vi.useRealTimers();
  // Sin esto, los stubs globales (`URL.createObjectURL`, `navigator`) viven
  // hasta el siguiente `beforeEach` y reordenar los `describe` filtraría
  // estado entre tests.
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* F1 / C2 — object URLs are not duplicated nor leaked                 */
/* ------------------------------------------------------------------ */

describe('F1 (C2) — object URL lifecycle', () => {
  it('reuses the object URL when the same project is rehydrated twice', async () => {
    opfsGetMedia.mockResolvedValue(new File(['data'], 'movie.mp4'));
    const project = makeProject('p1', { mediaPool: [makeMedia('m1')] });

    const first = await rehydrateProjectMedia(project);
    const second = await rehydrateProjectMedia(project);

    expect(first.mediaPool[0].url).toBe(second.mediaPool[0].url);
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
  });

  it('revokes the object URLs of the previous project when another project is loaded', async () => {
    opfsGetMedia.mockResolvedValue(new File(['data'], 'movie.mp4'));

    const first = await rehydrateProjectMedia(makeProject('p1', { mediaPool: [makeMedia('m1')] }));
    const firstUrl = first.mediaPool[0].url;

    await rehydrateProjectMedia(makeProject('p2', { mediaPool: [makeMedia('m2')] }));

    expect(revokeObjectURLSpy).toHaveBeenCalledWith(firstUrl);
  });

  it('revokes the object URLs of a media item that leaves the project', async () => {
    const item = makeMedia('m1', { url: 'blob:m1', thumbnailUrl: 'blob:m1-thumb' });
    revokeMediaObjectUrls([item]);

    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:m1');
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:m1-thumb');
  });
});

/* ------------------------------------------------------------------ */
/* F6 / S-14 — image thumbnails survive a reload                       */
/* ------------------------------------------------------------------ */

describe('F6 (S-14) — thumbnail renewal', () => {
  it('renews the thumbnail URL of an image (it used to stay a dead blob: URL)', async () => {
    opfsGetMedia.mockResolvedValue(new File(['data'], 'photo.png'));
    const project = makeProject('p1', {
      mediaPool: [
        makeMedia('m1', { type: 'image', url: 'blob:dead', thumbnailUrl: 'blob:dead' }),
      ],
    });

    const rehydrated = await rehydrateProjectMedia(project);
    const media = rehydrated.mediaPool[0];

    expect(media.thumbnailUrl).toBe(media.url);
    expect(media.thumbnailUrl).not.toBe('blob:dead');
    expect(media.thumbnailUrl.startsWith('blob:')).toBe(true);
  });

  it('drops the dead blob: thumbnail of a video instead of showing a broken image', async () => {
    opfsGetMedia.mockResolvedValue(new File(['data'], 'movie.mp4'));
    const project = makeProject('p1', {
      mediaPool: [makeMedia('m1', { type: 'video', thumbnailUrl: 'blob:dead-thumb' })],
    });

    const rehydrated = await rehydrateProjectMedia(project);
    expect(rehydrated.mediaPool[0].thumbnailUrl).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* F3 / C3 — the autosave storm and the duplicated write                */
/* ------------------------------------------------------------------ */

describe('F3 (C3) — debounced autosave', () => {
  it('coalesces a burst of mutations into a single write', async () => {
    vi.useFakeTimers();
    const project = makeProject('p1');

    const writes = [autosaveProject(project), autosaveProject({ ...project, name: 'B' }), autosaveProject({ ...project, name: 'C' })];

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 20);
    await Promise.all(writes);

    const recordWrites = setSpy.mock.calls.filter(([key]) => key === `${PROJECT_PREFIX}p1`);
    expect(recordWrites.length).toBe(1);
    expect(memoryStore.get(`${PROJECT_PREFIX}p1`).name).toBe('C');
  });

  it('keeps the legacy autosave key as a pointer instead of a second copy of the project', async () => {
    vi.useFakeTimers();
    const project = makeProject('p1', { mediaPool: [makeMedia('m1')] });

    const pending = autosaveProject(project);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 20);
    await pending;

    const legacy = memoryStore.get(AUTOSAVE_KEY);
    expect(legacy).toBeDefined();
    expect(legacy.id).toBe('p1');
    // The whole project (with its base64 filmstrips) must not be duplicated.
    expect(Array.isArray(legacy.tracks)).toBe(false);
    expect(legacy.mediaPool).toBeUndefined();
  });

  it('resolves only after the project is really on disk', async () => {
    vi.useFakeTimers();
    const project = makeProject('p1');

    const pending = autosaveProject(project);
    expect(memoryStore.get(`${PROJECT_PREFIX}p1`)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 20);
    await pending;

    expect(memoryStore.get(`${PROJECT_PREFIX}p1`)).toBeDefined();
  });

  it('writes the pending project immediately when flushed', async () => {
    vi.useFakeTimers();
    const project = makeProject('p1');

    void autosaveProject(project);
    await flushAutosave();

    expect(memoryStore.get(`${PROJECT_PREFIX}p1`)).toBeDefined();
  });

  it('does not resurrect a deleted project with a late autosave', async () => {
    vi.useFakeTimers();
    const project = makeProject('p1');
    await saveProject(project);

    void autosaveProject(project);
    await deleteProject('p1');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 20);

    expect(memoryStore.get(`${PROJECT_PREFIX}p1`)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* F4 / S-07 — the project index write is atomic                        */
/* ------------------------------------------------------------------ */

describe('F4 (S-07) — atomic project index', () => {
  it('does not drop a project when two saves run concurrently', async () => {
    const a = makeProject('A');
    const b = makeProject('B');

    await Promise.all([saveProject(a), saveProject(b)]);

    const index = memoryStore.get(PROJECTS_INDEX_KEY) as Array<{ id: string }>;
    expect(index.map((p) => p.id).sort()).toEqual(['A', 'B']);
  });

  it('merges, removes and updates entries with pure helpers', () => {
    const index = [
      { id: 'a', name: 'A', aspectRatio: '16:9' as const, duration: 1, tracksCount: 0, clipsCount: 0, createdAt: 1, updatedAt: 1 },
      { id: 'b', name: 'B', aspectRatio: '16:9' as const, duration: 1, tracksCount: 0, clipsCount: 0, createdAt: 2, updatedAt: 2 },
    ];

    const merged = mergeProjectMetadata(index, { ...index[0], name: 'A2', updatedAt: 5 });
    expect(merged[0].name).toBe('A2');
    expect(merged.length).toBe(2);

    expect(removeProjectMetadata(index, 'a').map((p) => p.id)).toEqual(['b']);
    expect(updateProjectMetadata(index, 'b', { name: 'B2' })[1].name).toBe('B2');
  });
});

/* ------------------------------------------------------------------ */
/* F5 / S-08 — persistence failures are surfaced                        */
/* ------------------------------------------------------------------ */

describe('F5 (S-08) — storage failures are observable', () => {
  it('publishes an error event (and keeps the console error) when the write fails', async () => {
    vi.useFakeTimers();
    const events: StorageEvent[] = [];
    const unsubscribe = subscribeStorageEvents((event) => events.push(event));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const quotaError = new DOMException('quota', 'QuotaExceededError');
    setSpy.mockImplementationOnce(async () => {
      throw quotaError;
    });

    const pending = autosaveProject(makeProject('p1'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 20);
    await pending;

    const consoleCalls = consoleError.mock.calls.length;
    unsubscribe();
    consoleError.mockRestore();

    expect(events.length).toBe(1);
    const failure = events[0] as StorageErrorEvent;
    expect(failure.type).toBe('error');
    expect(failure.quotaExceeded).toBe(true);
    expect(failure.message).toMatch(/almacenamiento lleno/i);
    expect(consoleCalls).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* F2 / C4 — the media files are deleted with the project              */
/* ------------------------------------------------------------------ */

describe('F2 (C4) — OPFS media files are deleted', () => {
  it('deletes the OPFS media files when a project is deleted', async () => {
    const project = makeProject('p1', { mediaPool: [makeMedia('m1'), makeMedia('m2')] });
    await saveProject(project);

    await deleteProject('p1');

    expect(opfsDeleteFiles).toHaveBeenCalledTimes(1);
    const deleted = opfsDeleteFiles.mock.calls[0][0];
    expect(deleted.sort()).toEqual(['m1_m1.mp4', 'm2_m2.mp4']);
  });
});

/* ------------------------------------------------------------------ */
/* F7 / S-15 — imported projects are validated                          */
/* ------------------------------------------------------------------ */

describe('F7 (S-15) — import validation', () => {
  const candidate = {
    id: 'imported',
    name: 'Importado',
    aspectRatio: '9:16' as const,
    resolution: { width: 999999, height: 1 },
    fps: 900,
    tracks: [makeTrack('t1'), makeTrack('t2', 'audio')],
    clips: [
      {
        id: 'c1',
        trackId: 't1',
        mediaId: 'm1',
        name: 'OK',
        type: 'video' as const,
        start: 1,
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
      {
        id: 'c2',
        trackId: 'ghost-track',
        mediaId: 'm2',
        name: 'Huérfano',
        type: 'video' as const,
        start: 2,
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
    duration: 10,
    createdAt: 1,
    updatedAt: 1,
  };

  it('drops the clips that point to a non-existent track', () => {
    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });

    expect(result.project.clips.map((c) => c.id)).toEqual(['c1']);
    expect(result.droppedClips).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/pista inexistente/i);
  });

  it('clamps the resolution and normalises the aspect ratio', () => {
    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });

    expect(result.project.resolution.width).toBeLessThanOrEqual(7680);
    expect(result.project.resolution.height).toBeGreaterThanOrEqual(16);
    expect(result.project.aspectRatio).toBe('16:9');
    expect(result.project.fps).toBeLessThanOrEqual(120);
  });

  it('rejects a file without a single valid track', () => {
    expect(() =>
      sanitizeImportedProject({ tracks: [], clips: [] }, { projectId: 'p', fallbackName: 'x' })
    ).toThrow(/pista/i);
  });
});

/* ------------------------------------------------------------------ */
/* F8 / S-16 — the export is explicitly media-less                      */
/* ------------------------------------------------------------------ */

describe('F8 (S-16) — media-less export', () => {
  it('marks the export envelope as media-less', () => {
    const project = makeProject('p1', { mediaPool: [makeMedia('m1')] });
    const envelope = serializeProjectForExport(project);

    expect(envelope.mediaEmbedded).toBe(false);
    expect(envelope.mediaCount).toBe(1);
  });

  it('says in the file name that the media is not included', () => {
    const project = makeProject('p1');
    let downloadName = '';

    const originalDocument = globalThis.document;
    (globalThis as any).document = {
      createElement: () => ({
        set href(_v: string) {},
        set download(v: string) {
          downloadName = v;
        },
        click: () => undefined,
      }),
      body: { appendChild: () => undefined, removeChild: () => undefined },
    };

    try {
      exportProjectToFile(project, 'hydra');
    } finally {
      (globalThis as any).document = originalDocument;
    }

    expect(downloadName).toMatch(/sin-medios\.hydra$/);
  });

  it('reports the media that could not be recovered instead of importing a broken project', async () => {
    opfsGetMedia.mockResolvedValue(null);
    const project = makeProject('p1', { mediaPool: [makeMedia('m1')] });
    const file = new File([JSON.stringify(serializeProjectForExport(project))], 'p1.hydra', {
      type: 'application/json',
    });

    const report = await importProjectFromFileWithReport(file);

    expect(report.missingMedia).toEqual(['m1.mp4']);
    expect(report.warnings.join(' ')).toMatch(/multimedia|medios/i);
    expect(getLastImportReport()?.missingMedia).toEqual(['m1.mp4']);
  });
});

/* ------------------------------------------------------------------ */
/* F9 / S-21 — a half-written OPFS file never wins                       */
/* ------------------------------------------------------------------ */

describe('F9 (S-21) — OPFS file validity', () => {
  const opfsFiles = new Map<string, File>();

  const fakeDir = {
    getFileHandle: async (name: string) => {
      const file = opfsFiles.get(name);
      if (!file) {
        const err: any = new Error('not found');
        err.name = 'NotFoundError';
        throw err;
      }
      return { getFile: async () => file };
    },
    removeEntry: async (name: string) => {
      opfsFiles.delete(name);
    },
  };
  const fakeRoot = {
    getDirectoryHandle: async (name: string) => {
      if (name !== 'media') throw new Error('unknown dir');
      return fakeDir;
    },
  };

  let previousNavigator: PropertyDescriptor | undefined;

  beforeEach(() => {
    opfsFiles.clear();
    previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { storage: { getDirectory: async () => fakeRoot } },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (previousNavigator) {
      Object.defineProperty(globalThis, 'navigator', previousNavigator);
    } else {
      delete (globalThis as any).navigator;
    }
  });

  it('rejects an empty (half-written) file', async () => {
    const actual = await vi.importActual<typeof import('../core/storage/opfsStorage')>(
      '../core/storage/opfsStorage'
    );

    expect(actual.isUsableMediaFile(new File([], 'empty.mp4'))).toBe(false);
    expect(actual.isUsableMediaFile(new File(['x'], 'ok.mp4'))).toBe(true);
    expect(actual.isUsableMediaFile(null)).toBe(false);
  });

  it('prefers the healthy IndexedDB copy over the truncated OPFS file', async () => {
    const actual = await vi.importActual<typeof import('../core/storage/opfsStorage')>(
      '../core/storage/opfsStorage'
    );

    opfsFiles.set('m1_movie.mp4', new File([], 'movie.mp4')); // half-written
    memoryStore.set('media_m1_movie.mp4', new File(['healthy'], 'movie.mp4'));

    const result = await actual.getMediaFromOPFS('m1_movie.mp4');

    expect(result).not.toBeNull();
    expect(result!.size).toBe('healthy'.length);
  });
});

/* ------------------------------------------------------------------ */
/* F10 / H6 — the ruler only renders the visible window                 */
/* ------------------------------------------------------------------ */

describe('F10 (H6) — virtualised time ruler', () => {
  it('renders only the ticks inside the visible window', () => {
    const zoom = 60;
    const duration = 300;
    const totalWidth = Math.max(1200, duration * zoom + 300);
    const step = 0.5; // zoom 60 -> major 2s, 4 minor ticks
    const totalTicks = Math.ceil(totalWidth / zoom / step);

    const { startIndex, endIndex } = getRulerTickWindow({
      zoom,
      scrollLeft: 0,
      viewportWidth: 1200,
      totalWidth,
      step,
    });

    expect(totalTicks).toBeGreaterThan(500);
    expect(endIndex - startIndex).toBeLessThan(totalTicks / 5);
  });

  it('follows the scroll offset', () => {
    const zoom = 60;
    const step = 0.5;
    const atStart = getRulerTickWindow({
      zoom,
      scrollLeft: 0,
      viewportWidth: 1200,
      totalWidth: 20000,
      step,
    });
    const atScroll = getRulerTickWindow({
      zoom,
      scrollLeft: 6000,
      viewportWidth: 1200,
      totalWidth: 20000,
      step,
    });

    expect(atScroll.startIndex).toBeGreaterThan(atStart.startIndex);
  });

  it('keeps the tick positions and labels identical to the previous algorithm', () => {
    const ticks = generateRulerTicks(0, 20, 0.5, 2);

    expect(ticks[0]).toMatchObject({ time: 0, isMajor: true, label: '0:00' });
    expect(ticks[2]).toMatchObject({ time: 1, isMajor: false });
    expect(ticks[4]).toMatchObject({ time: 2, isMajor: true, label: '0:02' });
    expect(ticks[20]).toMatchObject({ time: 10, isMajor: true, label: '0:10' });
  });
});

/* ------------------------------------------------------------------ */
/* F11 / H7 — the waveform canvas is DPR aware                          */
/* ------------------------------------------------------------------ */

describe('F11 (H7) — HiDPI waveform canvas', () => {
  it('scales the backing store by the device pixel ratio', async () => {
    const { getCanvasBackingSize } = await import('../components/timeline/ClipItem');

    expect(getCanvasBackingSize(300, 48, 1)).toEqual({ width: 300, height: 48 });
    expect(getCanvasBackingSize(300, 48, 2)).toEqual({ width: 600, height: 96 });
  });

  it('caps the device pixel ratio at 2', async () => {
    const { getDevicePixelRatio } = await import('../components/timeline/ClipItem');
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = { devicePixelRatio: 3 };

    try {
      expect(getDevicePixelRatio()).toBe(2);
    } finally {
      (globalThis as any).window = previousWindow;
    }
  });
});

/* ------------------------------------------------------------------ */
/* F12 / H8 — no forced layout on every pointer move                    */
/* ------------------------------------------------------------------ */

describe('F12 (H8) — layout free drag hit test', () => {
  it('does not call document.elementsFromPoint() while dragging', () => {
    expect(clipItemSource).not.toContain('elementsFromPoint');
  });

  it('finds the track lane under the pointer using cached rectangles', async () => {
    const { findTrackAtPoint, isTrackCompatible } = await import('../components/timeline/ClipItem');

    const lanes = [
      { id: 'v1', type: 'video', top: 100, bottom: 156, left: 0, right: 2000 },
      { id: 'a1', type: 'audio', top: 156, bottom: 212, left: 0, right: 2000 },
    ];

    expect(findTrackAtPoint(lanes, 300, 120)?.id).toBe('v1');
    expect(findTrackAtPoint(lanes, 300, 180)?.id).toBe('a1');
    expect(findTrackAtPoint(lanes, 300, 900)).toBeNull();
    expect(isTrackCompatible('video', 'video')).toBe(true);
    expect(isTrackCompatible('video', 'audio')).toBe(false);
    expect(isTrackCompatible('image', 'video')).toBe(true);
    expect(isTrackCompatible('audio', 'audio')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* F13 / UI-07 — trimming with the keyboard                             */
/* ------------------------------------------------------------------ */

describe('F13 (UI-07) — keyboard trimming', () => {
  it('exposes the trim handles as ARIA sliders', () => {
    expect(clipItemSource).toContain('role="slider"');
    expect(clipItemSource).toContain('aria-valuenow');
    expect(clipItemSource).toContain('aria-valuemin');
    expect(clipItemSource).toContain('aria-valuemax');
    expect(clipItemSource).toContain('aria-label');
    expect(clipItemSource).toContain('onKeyDown={handleTrimStartKeyDown}');
    expect(clipItemSource).toContain('onKeyDown={handleTrimEndKeyDown}');
  });

  it('computes the reachable trim range of a clip', async () => {
    const { getTrimStartBounds, getTrimEndBounds } = await import('../components/timeline/ClipItem');

    const clip = {
      id: 'c1',
      trackId: 't1',
      mediaId: 'm1',
      name: 'Clip',
      type: 'video' as const,
      start: 4,
      duration: 6,
      sourceStart: 2,
      sourceDuration: 20,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };

    expect(getTrimStartBounds(clip)).toEqual({ min: 2, max: 9.9 });
    expect(getTrimEndBounds(clip)).toEqual({ min: 4.1, max: 22 });
  });
});

/* ------------------------------------------------------------------ */
/* F14 / M1 — the playhead seeks once per tick                           */
/* ------------------------------------------------------------------ */

describe('F14 (M1) — playhead drag', () => {
  it('does not register a mousemove listener next to pointermove', () => {
    expect(playheadSource).not.toContain("'mousemove'");
    expect(playheadSource).not.toContain('"mousemove"');
    expect(playheadSource).toContain("'pointermove'");
  });
});

/* ------------------------------------------------------------------ */
/* F15 / M2 — the drag listeners are removed on unmount                  */
/* ------------------------------------------------------------------ */

describe('F15 (M2) — drag listener cleanup', () => {
  it('aborts the window listeners when the component unmounts', () => {
    for (const source of [clipItemSource, playheadSource, timeRulerSource]) {
      expect(source).toContain('AbortController');
      expect(source).toContain('abort()');
    }
  });

  it('registers the window listeners with the abort signal', () => {
    for (const source of [clipItemSource, playheadSource, timeRulerSource]) {
      expect(source).toMatch(/addEventListener\('pointermove',[^)]*\{ signal \}/);
    }
  });
});
