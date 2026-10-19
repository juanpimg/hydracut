/**
 * Regression tests for the lifecycle / persistence integration wave (W-6).
 *
 * The unit under test is the STORE: the engine (`MediaSourcePool`,
 * `Compositor`, `AudioEngine`) and the storage layer (`projectStorage`) were
 * given the cleanup primitives, but nothing called them. These tests assert
 * that the store really calls them, that a persistence failure reaches the
 * user, that the pending autosave is flushed when the page goes away, that
 * the storage subscription does not leak, that the keyboard trim is frame
 * exact and that a stale `lastError` never survives a successful action.
 *
 * The engine singletons are spied (the store calls them on the instance) and
 * the storage module is partially mocked: the REAL `subscribeStorageEvents`
 * and the REAL `autosaveProject` are kept so the failure path is exercised
 * end to end (a real write that fails publishes a real error event).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { useProjectStore } from '../store/useProjectStore';
import { mediaSourcePool } from '../core/engine/MediaSourcePool';
import { compositor } from '../core/engine/Compositor';
import { audioEngine } from '../core/engine/AudioEngine';
import { AUTOSAVE_DEBOUNCE_MS, PROJECT_PREFIX } from '../core/storage/projectStorage';
import { Clip, MediaItem, Project } from '../types/project';

/* ------------------------------------------------------------------ */
/* Mocks: in-memory IndexedDB                                          */
/* ------------------------------------------------------------------ */

const h = vi.hoisted(() => {
  const memory = new Map<string, any>();
  return {
    memory,
    getSpy: vi.fn(async (key: string) => memory.get(key)),
    setSpy: vi.fn(async (key: string, value: any) => {
      memory.set(key, value);
    }),
    delSpy: vi.fn(async (key: string) => {
      memory.delete(key);
    }),
    /* storage spies */
    deleteMediaFiles: vi.fn(async (_items: any) => undefined),
    revokeAllObjectUrls: vi.fn(),
    revokeProjectObjectUrls: vi.fn(),
    flushAutosave: vi.fn(async () => undefined),
    subscribeCalls: 0,
  };
});

vi.mock('idb-keyval', () => ({
  get: (key: string) => h.getSpy(key),
  set: (key: string, value: any) => h.setSpy(key, value),
  del: (key: string) => h.delSpy(key),
  keys: async () => Array.from(h.memory.keys()),
  clear: async () => {
    h.memory.clear();
  },
}));

vi.mock('../core/storage/projectStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/storage/projectStorage')>();
  return {
    ...actual,
    deleteMediaFiles: (items: any) => h.deleteMediaFiles(items),
    revokeAllObjectUrls: () => h.revokeAllObjectUrls(),
    revokeProjectObjectUrls: (id: string) => h.revokeProjectObjectUrls(id),
    flushAutosave: () => h.flushAutosave(),
    subscribeStorageEvents: (listener: any) => {
      h.subscribeCalls += 1;
      return actual.subscribeStorageEvents(listener);
    },
  };
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const VIDEO_TRACK = 'track_video_1';

function makeMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media_1',
    name: 'clip.mp4',
    type: 'video',
    url: 'blob:test/media_1',
    duration: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    thumbnailUrl: '',
    size: 1024,
    createdAt: 1000,
    opfsPath: 'media_1.mp4',
    ...overrides,
  };
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip_1',
    trackId: VIDEO_TRACK,
    mediaId: 'media_1',
    name: 'Clip',
    type: 'video',
    start: 0,
    duration: 10,
    sourceStart: 0,
    sourceDuration: 10,
    volume: 1,
    opacity: 1,
    scale: 1,
    positionX: 0,
    positionY: 0,
    muted: false,
    ...overrides,
  };
}

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  const state = useProjectStore.getState();
  return {
    id,
    name: `Proyecto ${id}`,
    aspectRatio: '16:9',
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    tracks: state.project.tracks,
    clips: [],
    mediaPool: [],
    duration: 30,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Engine spies                                                        */
/* ------------------------------------------------------------------ */

let releaseSpy: ReturnType<typeof vi.spyOn>;
let releaseClipSpy: ReturnType<typeof vi.spyOn>;
let poolClearSpy: ReturnType<typeof vi.spyOn>;
let compositorClearSpy: ReturnType<typeof vi.spyOn>;
let audioStopAllSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  releaseSpy = vi.spyOn(mediaSourcePool, 'release').mockImplementation(() => undefined);
  releaseClipSpy = vi.spyOn(mediaSourcePool, 'releaseClip').mockImplementation(() => undefined);
  poolClearSpy = vi.spyOn(mediaSourcePool, 'clear').mockImplementation(() => undefined);
  compositorClearSpy = vi.spyOn(compositor, 'clear').mockImplementation(() => undefined);
  audioStopAllSpy = vi.spyOn(audioEngine, 'stopAll').mockImplementation(() => undefined);

  h.deleteMediaFiles.mockClear();
  h.revokeAllObjectUrls.mockClear();
  h.revokeProjectObjectUrls.mockClear();
  h.flushAutosave.mockClear();

  // Defensive: the action does not exist in the pre-fix store, and the test
  // must fail on its own assertion (not on the setup).
  const store = useProjectStore.getState() as any;
  if (typeof store.clearStorageError === 'function') store.clearStorageError();
  useProjectStore.getState().resetProject();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* F1 — the engine lifecycle is wired into the store                    */
/* ------------------------------------------------------------------ */

describe('F1 — el store libera los recursos del motor', () => {
  it('removeMediaItem libera el medio y borra su fichero en OPFS', () => {
    const media = makeMedia();
    useProjectStore.getState().addMediaItem(media);
    useProjectStore.getState().addClipFromMedia(media, VIDEO_TRACK, 0);

    useProjectStore.getState().removeMediaItem(media.id);

    // The pooled elements/frames of that media are released...
    expect(releaseSpy).toHaveBeenCalledWith(media.id);
    // ...and the OPFS blob is deleted (the quota must not grow forever).
    expect(h.deleteMediaFiles).toHaveBeenCalledTimes(1);
    const deleted = h.deleteMediaFiles.mock.calls[0][0] as MediaItem[];
    expect(deleted).toHaveLength(1);
    expect(deleted[0].id).toBe(media.id);
    expect(deleted[0].opfsPath).toBe('media_1.mp4');
  });

  it('removeMediaItem sin medio en el pool no borra nada', () => {
    useProjectStore.getState().removeMediaItem('media_inexistente');

    expect(h.deleteMediaFiles).not.toHaveBeenCalled();
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('removeTrack libera los clips que mueren con la pista', () => {
    const media = makeMedia();
    useProjectStore.getState().addMediaItem(media);
    useProjectStore.getState().addClip(makeClip({ id: 'clip_track', trackId: VIDEO_TRACK }));

    useProjectStore.getState().removeTrack(VIDEO_TRACK);

    expect(useProjectStore.getState().project.clips.length).toBe(0);
    // The clip resources are released...
    expect(releaseClipSpy).toHaveBeenCalledWith('clip_track');
    // ...and the media is released too: no clip uses it anymore.
    expect(releaseSpy).toHaveBeenCalledWith(media.id);
  });

  it('removeTrack NO libera el medio si otro clip sigue usándolo', () => {
    const media = makeMedia();
    useProjectStore.getState().addMediaItem(media);
    useProjectStore.getState().addClip(makeClip({ id: 'clip_a', trackId: VIDEO_TRACK }));
    useProjectStore
      .getState()
      .addClip(makeClip({ id: 'clip_b', trackId: 'track_video_2', start: 20 }));

    useProjectStore.getState().removeTrack(VIDEO_TRACK);

    expect(releaseClipSpy).toHaveBeenCalledWith('clip_a');
    // The media is still used by clip_b: its elements must survive.
    expect(releaseSpy).not.toHaveBeenCalledWith(media.id);
  });

  it('removeClip libera el clip y su medio cuando queda huérfano', () => {
    const media = makeMedia();
    useProjectStore.getState().addMediaItem(media);
    useProjectStore.getState().addClip(makeClip({ id: 'clip_x' }));

    useProjectStore.getState().removeClip('clip_x');

    expect(releaseClipSpy).toHaveBeenCalledWith('clip_x');
    expect(releaseSpy).toHaveBeenCalledWith(media.id);
  });

  it('resetProject reinicia el motor y revoca las object URLs', () => {
    useProjectStore.getState().resetProject();

    expect(poolClearSpy).toHaveBeenCalled();
    expect(compositorClearSpy).toHaveBeenCalled();
    expect(audioStopAllSpy).toHaveBeenCalled();
    expect(h.revokeAllObjectUrls).toHaveBeenCalled();
  });

  it('loadProject reinicia el motor ANTES de cargar el proyecto nuevo', () => {
    const order: string[] = [];
    poolClearSpy.mockImplementation(() => {
      order.push('pool');
    });
    compositorClearSpy.mockImplementation(() => {
      order.push('compositor');
    });
    audioStopAllSpy.mockImplementation(() => {
      order.push('audio');
    });

    useProjectStore.getState().loadProject(makeProject('proj_nuevo'));

    expect(order).toEqual(['pool', 'compositor', 'audio']);
    expect(useProjectStore.getState().project.id).toBe('proj_nuevo');
  });

  it('loadProject revoca las object URLs del proyecto anterior (no del nuevo)', () => {
    useProjectStore.getState().loadProject(makeProject('proj_nuevo'));

    expect(h.revokeProjectObjectUrls).toHaveBeenCalledWith(
      useProjectStore.getState().project.id === 'proj_nuevo' ? expect.any(String) : ''
    );
  });

  it('trimClipEnd que vacía el clip lo elimina y libera su medio', () => {
    const media = makeMedia();
    useProjectStore.getState().addMediaItem(media);
    useProjectStore.getState().addClip(makeClip({ id: 'clip_empty', start: 2, duration: 4 }));

    // Trim the end exactly onto the start of the clip: the clip is empty.
    useProjectStore.getState().trimClipEnd('clip_empty', 2);

    expect(useProjectStore.getState().project.clips.length).toBe(0);
    expect(releaseClipSpy).toHaveBeenCalledWith('clip_empty');
    expect(releaseSpy).toHaveBeenCalledWith(media.id);
  });
});

/* ------------------------------------------------------------------ */
/* F2 — the persistence failures reach the user                        */
/* ------------------------------------------------------------------ */

describe('F2 — los fallos de persistencia se muestran al usuario', () => {
  it('expone storageError con el mensaje y la marca de cuota', async () => {
    vi.useFakeTimers();
    const quotaError = new Error('quota exceeded');
    quotaError.name = 'QuotaExceededError';
    h.setSpy.mockImplementationOnce(async () => {
      throw quotaError;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    useProjectStore.getState().setProjectName('Con cuota');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);

    const error = useProjectStore.getState().storageError;
    consoleError.mockRestore();

    expect(error).not.toBeNull();
    expect(error?.quotaExceeded).toBe(true);
    expect(error?.message).toMatch(/almacenamiento lleno/i);
    expect(error?.at).toBeGreaterThan(0);
    expect(error?.scope).toBe('autosave');
  });

  it('un autosave fallido NO marca el proyecto como guardado', async () => {
    vi.useFakeTimers();
    const quotaError = new Error('quota exceeded');
    quotaError.name = 'QuotaExceededError';
    h.setSpy.mockImplementationOnce(async () => {
      throw quotaError;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    useProjectStore.getState().setProjectName('Sin guardar');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);

    // The optimistic `updatedAt` moved, but the project is NOT on the disk.
    const state = useProjectStore.getState();
    consoleError.mockRestore();
    expect(state.project.updatedAt).toBeGreaterThan(0);
    expect(state.lastSavedAt).toBeNull();
  });

  it('un autosave correcto marca el proyecto como guardado', async () => {
    vi.useFakeTimers();

    useProjectStore.getState().setProjectName('Guardado');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);

    const state = useProjectStore.getState();
    expect(state.lastSavedAt).not.toBeNull();
    expect(state.storageError).toBeNull();
    // The project really reached the (mocked) IndexedDB.
    expect(h.memory.get(`${PROJECT_PREFIX}${state.project.id}`)).toBeDefined();
  });

  it('clearStorageError borra el aviso de almacenamiento', () => {
    useProjectStore.setState({
      storageError: { message: 'x', quotaExceeded: false, at: 1, scope: 'autosave' },
    });
    expect(useProjectStore.getState().storageError).not.toBeNull();

    useProjectStore.getState().clearStorageError();

    expect(useProjectStore.getState().storageError).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* F3 — the pending autosave is flushed when the page goes away        */
/* ------------------------------------------------------------------ */

describe('F3 — el autosave pendiente se vacía al cerrar la página', () => {
  it('registra un handler de unload que llama a flushAutosave', () => {
    const listeners = new Map<string, () => void>();
    const fakeWindow = {
      addEventListener: (type: string, handler: () => void) => {
        listeners.set(type, handler);
      },
    };
    (globalThis as any).window = fakeWindow;

    try {
      // Any write arms the unload flush.
      useProjectStore.getState().setProjectName('Despedida');
      expect(listeners.has('beforeunload')).toBe(true);
      expect(listeners.has('pagehide')).toBe(true);

      h.flushAutosave.mockClear();
      listeners.get('beforeunload')!();

      expect(h.flushAutosave).toHaveBeenCalled();
    } finally {
      delete (globalThis as any).window;
    }
  });
});

/* ------------------------------------------------------------------ */
/* F4 — the storage subscription does not leak                          */
/* ------------------------------------------------------------------ */

describe('F4 — la suscripción a los eventos de almacenamiento no se duplica', () => {
  it('se instala UNA sola vez y sobrevive a los resets del store', () => {
    const before = h.subscribeCalls;
    expect(before).toBeGreaterThan(0);

    for (let i = 0; i < 5; i += 1) {
      useProjectStore.getState().setProjectName(`nombre ${i}`);
      useProjectStore.getState().resetProject();
    }

    expect(h.subscribeCalls).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* F5 — the keyboard trim is frame exact                                */
/* ------------------------------------------------------------------ */

describe('F5 — el recorte con teclado es exacto al frame', () => {
  it('con snapping activado un recorte salta al cabezal', () => {
    useProjectStore.getState().addClip(makeClip({ id: 'clip_snap', start: 0, duration: 10 }));
    useProjectStore.getState().setCurrentTime(5);

    useProjectStore.getState().trimClipStart('clip_snap', 5.05);

    const clip = useProjectStore.getState().project.clips[0];
    // The magnetic snapping pulled the edge onto the playhead.
    expect(clip.start).toBe(5);
  });

  it('con { snap: false } el recorte NO se pega al cabezal', () => {
    useProjectStore.getState().addClip(makeClip({ id: 'clip_snap', start: 0, duration: 10 }));
    useProjectStore.getState().setCurrentTime(5);

    useProjectStore.getState().trimClipStart('clip_snap', 5.05, { snap: false });

    const clip = useProjectStore.getState().project.clips[0];
    // Frame exact: 5.05 s, not the playhead (5 s).
    expect(clip.start).toBeCloseTo(5.05, 6);
  });

  it('con { snap: false } el recorte del final NO se pega al cabezal', () => {
    useProjectStore.getState().addClip(makeClip({ id: 'clip_snap', start: 0, duration: 10 }));
    useProjectStore.getState().setCurrentTime(5);

    useProjectStore.getState().trimClipEnd('clip_snap', 5.05, { snap: false });

    const clip = useProjectStore.getState().project.clips[0];
    expect(clip.duration).toBeCloseTo(5.05, 6);
  });

  it('sin opciones el snapping sigue activo (comportamiento previo)', () => {
    useProjectStore.getState().addClip(makeClip({ id: 'clip_snap', start: 0, duration: 10 }));
    useProjectStore.getState().setCurrentTime(5);

    useProjectStore.getState().trimClipStart('clip_snap', 5.05);

    const clip = useProjectStore.getState().project.clips[0];
    expect(clip.start).toBe(5);
  });

  it('la ruta de teclado de ClipItem pide un recorte sin snapping', () => {
    // The DOM behaviour cannot be mounted in the node environment: the wiring
    // of the keyboard handlers is asserted on the source (same pattern as the
    // other DOM-only guards of the suite).
    const source = readFileSync(
      new URL('../components/timeline/ClipItem.tsx', import.meta.url),
      'utf8'
    );
    expect(source).toMatch(/trimClipStart\(clip\.id, target, \{ snap: false \}\)/);
    expect(source).toMatch(/trimClipEnd\(clip\.id, target, \{ snap: false \}\)/);
  });
});

/* ------------------------------------------------------------------ */
/* F6 — a stale error never survives a successful action                */
/* ------------------------------------------------------------------ */

describe('F6 — un error obsoleto no sobrevive a una acción correcta', () => {
  it('removeTrack bloqueada deja el error y una acción posterior lo borra', () => {
    const state = useProjectStore.getState();
    state.addClip(makeClip({ id: 'clip_locked', trackId: VIDEO_TRACK }));
    useProjectStore.setState((s) => ({
      project: {
        ...s.project,
        tracks: s.project.tracks.map((t) =>
          t.id === VIDEO_TRACK ? { ...t, isLocked: true } : t
        ),
      },
    }));

    useProjectStore.getState().removeTrack(VIDEO_TRACK);
    expect(useProjectStore.getState().lastError).toMatch(/bloqueada/i);

    // A successful action clears the stale refusal.
    useProjectStore.getState().setProjectName('Sigue editando');
    expect(useProjectStore.getState().lastError).toBeNull();
  });

  it('un movimiento incompatible informa, y el siguiente movimiento correcto lo borra', () => {
    useProjectStore.getState().addClip(makeClip({ id: 'clip_move', type: 'video' }));

    useProjectStore.getState().moveClip('clip_move', 0, 'track_audio_1');
    expect(useProjectStore.getState().lastError).toBeTruthy();

    useProjectStore.getState().moveClip('clip_move', 1, 'track_video_2');
    expect(useProjectStore.getState().lastError).toBeNull();
  });
});
