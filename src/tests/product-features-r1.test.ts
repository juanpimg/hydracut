/**
 * Regression tests for the R1 product features wave (F1, F2, F3).
 *
 * F1  explicit overlap policy: `block` refuses with a reason, `overwrite`
 *     trims the existing clip, `ripple` moves the later clips aside.
 * F2  media trash: removing a media does NOT destroy it, it goes to
 *     `project.trash` (bytes included) until it is restored or purged.
 * F3  missing media indicator + relink: a media whose bytes are gone is
 *     flagged, the clip warns about it and the file can be relinked.
 *
 * Every test asserts the REAL production behaviour: no re-implementation of
 * the logic under test and no tautological asserts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  useProjectStore,
  DEFAULT_OVERLAP_POLICY,
  applyOverwriteInsert,
  applyRippleInsert,
  findOverlappingClips,
  intervalsOverlap,
} from '../store/useProjectStore';
import { mediaSourcePool } from '../core/engine/MediaSourcePool';
import {
  getProjectById,
  rehydrateProjectMediaWithReport,
  sanitizeImportedProject,
  saveProject,
} from '../core/storage/projectStorage';
import { Clip, MediaItem, Project } from '../types/project';

/* ------------------------------------------------------------------ */
/* Mocks: in-memory IndexedDB + a fake OPFS                            */
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
    /** Spy of the store -> storage channel (mode included). */
    deleteMediaFiles: vi.fn(async (_items: any, _mode: any) => undefined),
    saveMediaToOPFS: vi.fn(async (mediaId: string, file: File) => `${mediaId}_${file.name}`),
    getMediaFromOPFS: vi.fn(async (_path: string): Promise<File | null> => null),
    deleteMediaFilesFromOPFS: vi.fn(async (_paths: string[]) => undefined),
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

vi.mock('../core/storage/opfsStorage', () => ({
  saveMediaToOPFS: (mediaId: string, file: File) => h.saveMediaToOPFS(mediaId, file),
  getMediaFromOPFS: (path: string) => h.getMediaFromOPFS(path),
  deleteMediaFilesFromOPFS: (paths: string[]) => h.deleteMediaFilesFromOPFS(paths),
  deleteMediaFromOPFS: async () => undefined,
  isOPFSSupported: async () => false,
  isUsableMediaFile: (file: any) => !!file && typeof file.size === 'number' && file.size > 0,
}));

vi.mock('../core/storage/projectStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/storage/projectStorage')>();
  return {
    ...actual,
    deleteMediaFiles: (items: any, mode: any) => h.deleteMediaFiles(items, mode),
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

/** Adds a media to the pool and returns it. */
function addMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  const media = makeMedia(overrides);
  useProjectStore.getState().addMediaItem(media);
  return media;
}

beforeEach(() => {
  h.deleteMediaFiles.mockClear();
  h.deleteMediaFilesFromOPFS.mockClear();
  h.saveMediaToOPFS.mockClear();
  h.getMediaFromOPFS.mockReset();
  h.getMediaFromOPFS.mockResolvedValue(null);
  useProjectStore.getState().resetProject();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* F1 — explicit overlap policy                                        */
/* ------------------------------------------------------------------ */

describe('F1 — la política de solapamiento es explícita', () => {
  it('la política por defecto es "block" (la más segura)', () => {
    expect(DEFAULT_OVERLAP_POLICY).toBe('block');
    expect(useProjectStore.getState().project.overlapPolicy).toBe('block');
  });

  it('con "block" la inserción solapada se RECHAZA y explica el motivo', () => {
    const store = useProjectStore.getState();
    const first = addMedia({ id: 'media_a', name: 'intro.mp4', duration: 10 });
    store.addClipFromMedia(first, VIDEO_TRACK, 0);

    const second = makeMedia({ id: 'media_b', name: 'b-roll.mp4', duration: 5 });
    const result = useProjectStore.getState().addClipFromMedia(second, VIDEO_TRACK, 5);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // The reason is actionable: it names the conflict and the alternatives.
    expect(result.reason).toMatch(/solapa/i);
    expect(result.reason).toContain('intro.mp4');
    expect(result.reason).toMatch(/Sobrescribir|Ripple/);
    // No clip was created and the refusal is published for the UI.
    expect(useProjectStore.getState().project.clips.length).toBe(1);
    expect(useProjectStore.getState().lastError).toBe(result.reason);
  });

  it('con "block" una inserción que NO se solapa se acepta y devuelve el id del clip', () => {
    const store = useProjectStore.getState();
    const first = addMedia({ id: 'media_a', duration: 10 });
    store.addClipFromMedia(first, VIDEO_TRACK, 0);

    const second = makeMedia({ id: 'media_b', duration: 5 });
    const result = useProjectStore.getState().addClipFromMedia(second, VIDEO_TRACK, 10);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(useProjectStore.getState().project.clips.some((c) => c.id === result.clipId)).toBe(true);
    expect(useProjectStore.getState().project.clips.length).toBe(2);
  });

  it('con "overwrite" el clip existente se recorta y no queda solape', () => {
    const store = useProjectStore.getState();
    store.setOverlapPolicy('overwrite');

    const first = addMedia({ id: 'media_a', name: 'intro.mp4', duration: 10 });
    store.addClipFromMedia(first, VIDEO_TRACK, 0);

    const second = makeMedia({ id: 'media_b', duration: 5 });
    const result = store.addClipFromMedia(second, VIDEO_TRACK, 5);
    expect(result.ok).toBe(true);

    const clips = useProjectStore.getState().project.clips;
    const trimmed = clips.find((c) => c.mediaId === 'media_a')!;
    const inserted = clips.find((c) => c.mediaId === 'media_b')!;

    // The existing clip lost the overlapped part.
    expect(trimmed.start).toBe(0);
    expect(trimmed.duration).toBe(5);
    expect(inserted.start).toBe(5);
    expect(inserted.duration).toBe(5);

    // Nothing overlaps anymore.
    const overlaps = findOverlappingClips(
      clips,
      VIDEO_TRACK,
      inserted.start,
      inserted.duration,
      inserted.id
    );
    expect(overlaps).toHaveLength(0);
  });

  it('con "overwrite" un clip totalmente cubierto desaparece', () => {
    const store = useProjectStore.getState();
    store.setOverlapPolicy('overwrite');

    const first = addMedia({ id: 'media_a', duration: 10 });
    store.addClipFromMedia(first, VIDEO_TRACK, 0);

    const second = makeMedia({ id: 'media_b', duration: 20 });
    const result = store.addClipFromMedia(second, VIDEO_TRACK, 0);
    expect(result.ok).toBe(true);

    const clips = useProjectStore.getState().project.clips;
    expect(clips.filter((c) => c.mediaId === 'media_a')).toHaveLength(0);
    expect(clips.filter((c) => c.mediaId === 'media_b')).toHaveLength(1);
  });

  it('con "ripple" los clips posteriores se desplazan para hacer sitio', () => {
    const store = useProjectStore.getState();
    store.setOverlapPolicy('ripple');

    const first = addMedia({ id: 'media_a', duration: 10 });
    store.addClipFromMedia(first, VIDEO_TRACK, 0);
    const second = addMedia({ id: 'media_b', duration: 10 });
    store.addClipFromMedia(second, VIDEO_TRACK, 20);

    // The new clip overlaps the first one: the track has to make room.
    const third = makeMedia({ id: 'media_c', duration: 10 });
    const result = store.addClipFromMedia(third, VIDEO_TRACK, 5);
    expect(result.ok).toBe(true);

    const clips = useProjectStore.getState().project.clips;
    const moved = clips.find((c) => c.mediaId === 'media_b')!;
    const inserted = clips.find((c) => c.mediaId === 'media_c')!;

    // The clip that followed moved 10 s to the right.
    expect(moved.start).toBe(30);
    expect(moved.duration).toBe(10);
    expect(inserted.start).toBe(5);
    // And nothing overlaps anymore.
    expect(findOverlappingClips(clips, VIDEO_TRACK, moved.start, moved.duration, moved.id)).toHaveLength(0);
  });

  it('con "ripple" un clip cortado por la inserción se parte: la cabeza se queda', () => {
    const store = useProjectStore.getState();
    store.setOverlapPolicy('ripple');

    const first = addMedia({ id: 'media_a', duration: 10 });
    store.addClipFromMedia(first, VIDEO_TRACK, 0);

    const second = makeMedia({ id: 'media_b', duration: 10 });
    const result = store.addClipFromMedia(second, VIDEO_TRACK, 5);
    expect(result.ok).toBe(true);

    const clips = useProjectStore.getState().project.clips;
    const parts = clips.filter((c) => c.mediaId === 'media_a');
    // The clip was split in two: the head stays, the tail moves.
    expect(parts).toHaveLength(2);
    const head = parts.find((c) => c.start === 0)!;
    const tail = parts.find((c) => c.start !== 0)!;
    expect(head.duration).toBe(5);
    expect(tail.start).toBe(15);
    expect(tail.duration).toBe(5);
    // The source window of the tail follows the material.
    expect(tail.sourceStart).toBe(5);
  });

  it('la política se puede cambiar desde el store y se guarda en el proyecto', () => {
    useProjectStore.getState().setOverlapPolicy('ripple');
    expect(useProjectStore.getState().project.overlapPolicy).toBe('ripple');
    useProjectStore.getState().setOverlapPolicy('overwrite');
    expect(useProjectStore.getState().project.overlapPolicy).toBe('overwrite');
  });

  it('los helpers puros calculan el solape y las dos políticas', () => {
    const clips = [makeClip({ id: 'c1', start: 0, duration: 10 })];

    // Two clips that only touch do NOT overlap.
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false);
    expect(intervalsOverlap(0, 10, 5, 20)).toBe(true);
    expect(findOverlappingClips(clips, VIDEO_TRACK, 5, 10)).toHaveLength(1);
    expect(findOverlappingClips(clips, VIDEO_TRACK, 10, 5)).toHaveLength(0);
    // Another track never overlaps.
    expect(findOverlappingClips(clips, 'track_video_2', 0, 5)).toHaveLength(0);

    // overwrite: the head survives, the tail is moved next to the new clip.
    const overwritten = applyOverwriteInsert(clips, VIDEO_TRACK, 5, 5);
    expect(overwritten.clips).toHaveLength(1);
    expect(overwritten.clips[0].duration).toBe(5);
    expect(overwritten.clips[0].start).toBe(0);

    // ripple: the clip cut in half keeps its head and moves its tail.
    const rippled = applyRippleInsert(clips, VIDEO_TRACK, 5, 5);
    expect(rippled.clips).toHaveLength(2);
    expect(rippled.clips[0].start).toBe(0);
    expect(rippled.clips[0].duration).toBe(5);
    expect(rippled.clips[1].start).toBe(10);
    expect(rippled.shifted).toHaveLength(1);
  });

  it('la UI muestra el motivo del rechazo (nunca un no-op silencioso)', () => {
    // The DOM cannot be mounted in the node environment: the wiring of the
    // refusal message is asserted on the source (same pattern as the other
    // DOM-only guards of the suite).
    const mediaCard = readFileSync(
      new URL('../components/media/MediaItemCard.tsx', import.meta.url),
      'utf8'
    );
    const trackLane = readFileSync(
      new URL('../components/timeline/TrackLane.tsx', import.meta.url),
      'utf8'
    );

    expect(mediaCard).toMatch(/result\.ok \? null : result\.reason/);
    expect(mediaCard).toContain('media-card-refusal');
    expect(trackLane).toMatch(/result\.ok \? null : result\.reason/);
    expect(trackLane).toContain('track-lane-refusal');
  });

  it('el Inspector expone la política de solapamiento', () => {
    const inspector = readFileSync(
      new URL('../components/inspector/ClipInspector.tsx', import.meta.url),
      'utf8'
    );
    expect(inspector).toContain('overlap-policy-select');
    expect(inspector).toMatch(/setOverlapPolicy/);
  });
});

/* ------------------------------------------------------------------ */
/* F2 — media trash                                                    */
/* ------------------------------------------------------------------ */

describe('F2 — la papelera de medios', () => {
  it('removeMediaItem mueve el medio y sus clips a la papelera', () => {
    const store = useProjectStore.getState();
    const media = addMedia({ id: 'media_a', name: 'intro.mp4' });
    store.addClipFromMedia(media, VIDEO_TRACK, 0);
    expect(useProjectStore.getState().project.clips.length).toBe(1);

    useProjectStore.getState().removeMediaItem('media_a');

    const project = useProjectStore.getState().project;
    // The media is NOT in the pool any more...
    expect(project.mediaPool.find((m) => m.id === 'media_a')).toBeUndefined();
    // ...its clips are not rendered any more...
    expect(project.clips.find((c) => c.mediaId === 'media_a')).toBeUndefined();
    // ...but everything is waiting in the trash.
    expect(project.trash).toHaveLength(1);
    expect(project.trash![0].media.id).toBe('media_a');
    expect(project.trash![0].clips).toHaveLength(1);
    expect(project.trash![0].clips[0].mediaId).toBe('media_a');
  });

  it('los bytes NO se borran al mover a la papelera (se borran al purgar)', () => {
    const store = useProjectStore.getState();
    const media = addMedia({ id: 'media_a' });
    store.addClipFromMedia(media, VIDEO_TRACK, 0);

    useProjectStore.getState().removeMediaItem('media_a');

    // The storage layer is told to keep the file (mode "trash").
    expect(h.deleteMediaFiles).toHaveBeenCalledTimes(1);
    expect(h.deleteMediaFiles.mock.calls[0][1]).toBe('trash');
    // The OPFS blob is still there: it can be restored.
    expect(h.deleteMediaFilesFromOPFS).not.toHaveBeenCalled();
  });

  it('restoreFromTrash devuelve el medio y sus clips al proyecto', () => {
    const store = useProjectStore.getState();
    const media = addMedia({ id: 'media_a', name: 'intro.mp4' });
    store.addClipFromMedia(media, VIDEO_TRACK, 0);
    const clipId = useProjectStore.getState().project.clips[0].id;

    useProjectStore.getState().removeMediaItem('media_a');
    const restored = useProjectStore.getState().restoreFromTrash('media_a');

    expect(restored).toBe(true);
    const project = useProjectStore.getState().project;
    expect(project.trash).toHaveLength(0);
    expect(project.mediaPool.find((m) => m.id === 'media_a')).toBeDefined();
    expect(project.clips.find((c) => c.id === clipId)).toBeDefined();
    // The media is usable again (it kept its url).
    expect(project.mediaPool.find((m) => m.id === 'media_a')!.url).toBe(media.url);
  });

  it('purgeTrash borra los archivos para siempre', () => {
    const store = useProjectStore.getState();
    const media = addMedia({ id: 'media_a' });
    store.addClipFromMedia(media, VIDEO_TRACK, 0);
    useProjectStore.getState().removeMediaItem('media_a');

    const purged = useProjectStore.getState().purgeTrash();

    expect(purged).toBe(1);
    expect(useProjectStore.getState().project.trash).toHaveLength(0);
    // The physical deletion happened (mode "purge").
    const purgeCall = h.deleteMediaFiles.mock.calls.find((call) => call[1] === 'purge');
    expect(purgeCall).toBeDefined();
    expect((purgeCall![0] as MediaItem[])[0].id).toBe('media_a');
  });

  it('purgeTrashedMedia borra una sola entrada de la papelera', () => {
    const store = useProjectStore.getState();
    store.addClipFromMedia(addMedia({ id: 'media_a' }), VIDEO_TRACK, 0);
    store.addClipFromMedia(addMedia({ id: 'media_b' }), VIDEO_TRACK, 20);
    useProjectStore.getState().removeMediaItem('media_a');
    useProjectStore.getState().removeMediaItem('media_b');

    const purged = useProjectStore.getState().purgeTrashedMedia('media_a');

    expect(purged).toBe(true);
    const trash = useProjectStore.getState().project.trash ?? [];
    expect(trash).toHaveLength(1);
    expect(trash[0].media.id).toBe('media_b');
  });

  it('el undo de un borrado devuelve el medio Y sus clips (y vacía la papelera)', () => {
    const store = useProjectStore.getState();
    const media = addMedia({ id: 'media_a' });
    store.addClipFromMedia(media, VIDEO_TRACK, 0);

    useProjectStore.getState().removeMediaItem('media_a');
    expect(useProjectStore.getState().project.trash).toHaveLength(1);

    useProjectStore.getState().undo();

    const project = useProjectStore.getState().project;
    expect(project.mediaPool.find((m) => m.id === 'media_a')).toBeDefined();
    expect(project.clips.filter((c) => c.mediaId === 'media_a')).toHaveLength(1);
    expect(project.trash).toHaveLength(0);
  });

  it('el redo vuelve a llenar la papelera', () => {
    const store = useProjectStore.getState();
    const media = addMedia({ id: 'media_a' });
    store.addClipFromMedia(media, VIDEO_TRACK, 0);

    useProjectStore.getState().removeMediaItem('media_a');
    useProjectStore.getState().undo();
    useProjectStore.getState().redo();

    const project = useProjectStore.getState().project;
    expect(project.mediaPool.find((m) => m.id === 'media_a')).toBeUndefined();
    expect(project.trash).toHaveLength(1);
    expect(project.trash![0].media.id).toBe('media_a');
  });

  it('la papelera sobrevive a un guardado y una recarga', async () => {
    const media = makeMedia({ id: 'media_a', name: 'intro.mp4' });
    const project = makeProject('proj_trash', {
      mediaPool: [],
      trash: [{ media, clips: [makeClip({ mediaId: 'media_a' })], deletedAt: 1234 }],
    });

    await saveProject(project);
    const loaded = await getProjectById('proj_trash');

    expect(loaded).not.toBeNull();
    expect(loaded!.trash).toHaveLength(1);
    expect(loaded!.trash![0].media.id).toBe('media_a');
    expect(loaded!.trash![0].media.name).toBe('intro.mp4');
    expect(loaded!.trash![0].clips).toHaveLength(1);
  });

  it('sanitizeImportedProject sanea la papelera y la política', () => {
    const tracks = useProjectStore.getState().project.tracks;
    const sanitized = sanitizeImportedProject(
      {
        tracks,
        clips: [],
        mediaPool: [],
        overlapPolicy: 'inventada' as never,
        trash: [
          { media: makeMedia({ id: 'media_ok' }), clips: [makeClip({ mediaId: 'media_ok' })], deletedAt: 5 },
          // Malformed entries (they must be discarded, not crash the import).
          { media: null, clips: [], deletedAt: 6 } as never,
          { media: { id: '' }, clips: [], deletedAt: 7 } as never,
        ],
      },
      { projectId: 'proj_x', fallbackName: 'X' }
    );

    // Only the valid entry survives.
    expect(sanitized.project.trash).toHaveLength(1);
    expect(sanitized.project.trash![0].media.id).toBe('media_ok');
    expect(sanitized.project.trash![0].clips).toHaveLength(1);
    // An unknown policy falls back to the safest one.
    expect(sanitized.project.overlapPolicy).toBe('block');
  });

  it('el modo "trash" de deleteMediaFiles no borra ni el archivo ni la object URL', async () => {
    const actual = await vi.importActual<typeof import('../core/storage/projectStorage')>(
      '../core/storage/projectStorage'
    );
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const media = makeMedia({ id: 'media_a', url: 'blob:media_a', opfsPath: 'media_a.mp4' });

    await actual.deleteMediaFiles([media], 'trash');
    expect(h.deleteMediaFilesFromOPFS).not.toHaveBeenCalled();
    expect(revokeSpy).not.toHaveBeenCalled();

    await actual.deleteMediaFiles([media], 'purge');
    expect(h.deleteMediaFilesFromOPFS).toHaveBeenCalledWith(['media_a.mp4']);
    expect(revokeSpy).toHaveBeenCalledWith('blob:media_a');
  });
});

/* ------------------------------------------------------------------ */
/* F3 — missing media indicator + relink                               */
/* ------------------------------------------------------------------ */

describe('F3 — indicador de medio ausente y revinculado', () => {
  it('un medio cuyo archivo desapareció se marca como "missing"', async () => {
    h.getMediaFromOPFS.mockResolvedValue(null);
    const project = makeProject('proj_missing', {
      mediaPool: [makeMedia({ id: 'media_a', name: 'intro.mp4', opfsPath: 'media_a.mp4' })],
    });

    const report = await rehydrateProjectMediaWithReport(project);

    expect(report.project.mediaPool[0].status).toBe('missing');
    expect(report.project.mediaPool[0].url).toBe('');
    expect(report.missingMedia).toContain('intro.mp4');
  });

  it('un medio que sí se recupera vuelve a estar "ok"', async () => {
    h.getMediaFromOPFS.mockResolvedValue(new File(['data'], 'movie.mp4'));
    const project = makeProject('proj_ok', {
      mediaPool: [makeMedia({ id: 'media_a', opfsPath: 'media_a.mp4', status: 'missing' })],
    });

    const report = await rehydrateProjectMediaWithReport(project);

    expect(report.project.mediaPool[0].status).toBe('ok');
    expect(report.project.mediaPool[0].url).not.toBe('');
  });

  it('un fallo del motor marca el medio como "error" en el proyecto', () => {
    const store = useProjectStore.getState();
    store.addMediaItem(makeMedia({ id: 'media_a' }));

    mediaSourcePool.reportUnavailableMedia('media_a');

    const media = useProjectStore.getState().project.mediaPool.find((m) => m.id === 'media_a');
    expect(media?.status).toBe('error');
  });

  it('relinkMedia conserva el id del medio y no vuelve a añadir el clip', async () => {
    const store = useProjectStore.getState();
    const media = addMedia({ id: 'media_a', name: 'intro.mp4', status: 'missing' });
    store.addClipFromMedia(media, VIDEO_TRACK, 0);
    expect(useProjectStore.getState().project.clips).toHaveLength(1);

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'intro-nuevo.mp4', { type: 'video/mp4' });
    const ok = await useProjectStore.getState().relinkMedia('media_a', file);

    expect(ok).toBe(true);
    const project = useProjectStore.getState().project;
    const relinked = project.mediaPool.find((m) => m.id === 'media_a')!;
    // Same id, same clips, new bytes.
    expect(relinked.id).toBe('media_a');
    expect(relinked.status).toBe('ok');
    expect(relinked.url).not.toBe('');
    expect(relinked.size).toBe(4);
    // The clip was NOT re-added to the timeline.
    expect(project.clips).toHaveLength(1);
    expect(project.clips[0].mediaId).toBe('media_a');
    // The new file was stored.
    expect(h.saveMediaToOPFS).toHaveBeenCalledWith('media_a', file);
  });

  it('relinkMedia puede revincular un medio que está en la papelera', async () => {
    const store = useProjectStore.getState();
    store.addMediaItem(makeMedia({ id: 'media_a', status: 'missing' }));
    useProjectStore.getState().removeMediaItem('media_a');

    const file = new File([new Uint8Array([9, 9])], 'recuperado.mp4', { type: 'video/mp4' });
    const ok = await useProjectStore.getState().relinkMedia('media_a', file);

    expect(ok).toBe(true);
    const trash = useProjectStore.getState().project.trash ?? [];
    expect(trash).toHaveLength(1);
    expect(trash[0].media.status).toBe('ok');
  });

  it('setMediaStatus marca el medio (missing / error / ok)', () => {
    const store = useProjectStore.getState();
    store.addMediaItem(makeMedia({ id: 'media_a' }));

    store.setMediaStatus('media_a', 'missing');
    expect(useProjectStore.getState().project.mediaPool[0].status).toBe('missing');

    store.setMediaStatus('media_a', 'ok');
    expect(useProjectStore.getState().project.mediaPool[0].status).toBe('ok');
  });

  it('el clip muestra el aviso de "medio ausente" y el bin ofrece revincular', () => {
    // The DOM cannot be mounted in the node environment: the wiring of the
    // badge and of the relink action is asserted on the source (same pattern
    // as the other DOM-only guards of the suite).
    const clipItem = readFileSync(
      new URL('../components/timeline/ClipItem.tsx', import.meta.url),
      'utf8'
    );
    const mediaBin = readFileSync(
      new URL('../components/media/MediaBin.tsx', import.meta.url),
      'utf8'
    );

    expect(clipItem).toContain('clip-missing-badge');
    expect(clipItem).toContain('medio ausente');
    expect(clipItem).toMatch(/status === 'missing'/);

    expect(mediaBin).toContain('missing-media-panel');
    expect(mediaBin).toContain('relink-media-');
    expect(mediaBin).toMatch(/relinkMedia/);
  });

  it('el panel de medios lista la papelera con restaurar y purgar', () => {
    const mediaBin = readFileSync(
      new URL('../components/media/MediaBin.tsx', import.meta.url),
      'utf8'
    );
    expect(mediaBin).toContain('trash-panel');
    expect(mediaBin).toContain('restore-media-');
    expect(mediaBin).toContain('purge-media-');
    expect(mediaBin).toMatch(/restoreFromTrash/);
  });
});
