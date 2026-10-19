/**
 * Regression tests for the P0 data-integrity wave (F1..F8).
 *
 * Every test asserts the REAL production behaviour of the store / media bin:
 * no re-implementation of the logic under test and no tautological asserts.
 *
 * F1  S-01/KI-05  undo must restore the media pool together with the clips
 * F2  S-02       updateClip must be undoable (and coalesced), never delete a clip
 * F3  S-03       a locked track must not be removable
 * F4  S-04       changing the speed must rescale the clip duration
 * F5  S-12/B-04  a clip must never be created on an incompatible track
 * F6  B-03       imported images must keep their intrinsic size
 * F7  S-13       splitClip must partition the synchronised words
 * F8  S-05       trims must bump project.updatedAt
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useProjectStore } from '../store/useProjectStore';
import { buildMediaItemFromFile, FALLBACK_MEDIA_HEIGHT, FALLBACK_MEDIA_WIDTH } from '../components/media/MediaBin';
import { Clip, MediaItem } from '../types/project';

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
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip_1',
    trackId: 'track_video_1',
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

/** Locks a track by id (the store has no dedicated "lock" action for tests). */
function lockTrack(trackId: string): void {
  const state = useProjectStore.getState();
  useProjectStore.setState({
    project: {
      ...state.project,
      tracks: state.project.tracks.map((t) => (t.id === trackId ? { ...t, isLocked: true } : t)),
    },
  });
}

describe('F1 (S-01) — el historial incluye el mediaPool', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('undo tras borrar un medio restaura el medio Y su clip', () => {
    const store = useProjectStore.getState();
    const media = makeMedia({ url: URL.createObjectURL(new Blob(['x'])) });

    store.addMediaItem(media);
    store.addClipFromMedia(media, 'track_video_1', 0);

    expect(useProjectStore.getState().project.clips.length).toBe(1);
    expect(useProjectStore.getState().project.mediaPool.length).toBe(1);

    useProjectStore.getState().removeMediaItem(media.id);

    // The media AND its clips are gone...
    expect(useProjectStore.getState().project.mediaPool.length).toBe(0);
    expect(useProjectStore.getState().project.clips.length).toBe(0);

    useProjectStore.getState().undo();

    const project = useProjectStore.getState().project;
    // ...and the undo brings BOTH back (no orphaned clip).
    expect(project.clips.length).toBe(1);
    expect(project.mediaPool.length).toBe(1);
    expect(project.clips[0].mediaId).toBe(media.id);
    expect(project.mediaPool[0].id).toBe(media.id);
    // The restored asset still points at a usable url.
    expect(project.mediaPool[0].url).toBe(media.url);
    expect(project.mediaPool[0].url.length).toBeGreaterThan(0);
  });

  it('redo vuelve a eliminar el medio (el snapshot del pool es simétrico)', () => {
    const store = useProjectStore.getState();
    const media = makeMedia();

    store.addMediaItem(media);
    store.addClipFromMedia(media, 'track_video_1', 0);
    useProjectStore.getState().removeMediaItem(media.id);

    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.mediaPool.length).toBe(1);

    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.mediaPool.length).toBe(0);
    expect(useProjectStore.getState().project.clips.length).toBe(0);
  });
});

describe('F2 (S-02) — updateClip es deshacible y coalescente', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('deshacer una edición del inspector NO borra el clip', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ volume: 1 }));

    useProjectStore.getState().updateClip('clip_1', { volume: 0.5 });
    expect(useProjectStore.getState().project.clips[0].volume).toBe(0.5);

    // 1st undo: reverts the property, the clip survives.
    useProjectStore.getState().undo();
    const afterFirstUndo = useProjectStore.getState().project.clips;
    expect(afterFirstUndo.length).toBe(1);
    expect(afterFirstUndo[0].volume).toBe(1);

    // 2nd undo: now the clip itself is removed (the addClip snapshot).
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.clips.length).toBe(0);
  });

  it('una ráfaga de 30 updateClip genera UNA sola entrada de historial', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ volume: 1 }));

    const pastBefore = useProjectStore.getState().past.length;
    // Freeze the clock so the burst cannot be split by the coalescing window.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    for (let i = 0; i < 30; i++) {
      useProjectStore.getState().updateClip('clip_1', { volume: 0.9 - i * 0.01 });
    }
    nowSpy.mockRestore();

    const pastAfter = useProjectStore.getState().past.length;
    expect(pastAfter - pastBefore).toBe(1);
    expect(useProjectStore.getState().project.clips[0].volume).toBeCloseTo(0.61, 5);

    // One undo reverts the whole burst.
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.clips[0].volume).toBe(1);
    expect(useProjectStore.getState().past.length).toBe(pastBefore);
  });

  it('una acción distinta cierra el grupo de coalescencia', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ volume: 1 }));

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    useProjectStore.getState().updateClip('clip_1', { volume: 0.5 });
    // A different action (addTrack pushes history) closes the group.
    useProjectStore.getState().addTrack('audio', 'Audio extra');
    useProjectStore.getState().updateClip('clip_1', { volume: 0.25 });
    nowSpy.mockRestore();

    const pastAfter = useProjectStore.getState().past.length;
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.clips[0].volume).toBe(0.5);
    expect(useProjectStore.getState().past.length).toBe(pastAfter - 1);
  });
});

describe('F3 (S-03) — una pista bloqueada no se puede eliminar', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('removeTrack no borra la pista bloqueada ni sus clips', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ trackId: 'track_video_1' }));
    lockTrack('track_video_1');

    const tracksBefore = useProjectStore.getState().project.tracks.length;
    useProjectStore.getState().removeTrack('track_video_1');

    const project = useProjectStore.getState().project;
    expect(project.tracks.length).toBe(tracksBefore);
    expect(project.tracks.some((t) => t.id === 'track_video_1')).toBe(true);
    expect(project.clips.length).toBe(1);
    // The refusal is surfaced with a reason.
    expect(useProjectStore.getState().lastError).toMatch(/bloqueada/i);
  });

  it('deleteTrack (alias) tampoco borra una pista bloqueada', () => {
    lockTrack('track_audio_1');

    const tracksBefore = useProjectStore.getState().project.tracks.length;
    useProjectStore.getState().deleteTrack('track_audio_1');

    expect(useProjectStore.getState().project.tracks.length).toBe(tracksBefore);
    expect(useProjectStore.getState().project.tracks.some((t) => t.id === 'track_audio_1')).toBe(true);
  });

  it('una pista desbloqueada se puede eliminar como antes', () => {
    const store = useProjectStore.getState();
    const tracksBefore = useProjectStore.getState().project.tracks.length;

    store.removeTrack('track_audio_1');

    expect(useProjectStore.getState().project.tracks.length).toBe(tracksBefore - 1);
  });
});

describe('F4 (S-04) — cambiar la velocidad reescala el clip', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('acelerar reduce la duración manteniendo la ventana de origen', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ duration: 10, sourceStart: 0, sourceDuration: 10 }));

    useProjectStore.getState().updateClip('clip_1', { speed: 2 });

    const clip = useProjectStore.getState().project.clips[0];
    expect(clip.speed).toBe(2);
    expect(clip.duration).toBe(5);
    // The source window still fits inside the media.
    expect(clip.sourceStart + clip.duration * (clip.speed as number)).toBeLessThanOrEqual(clip.sourceDuration);
  });

  it('ralentizar aumenta la duración sin salirse del medio', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ duration: 4, sourceStart: 2, sourceDuration: 10 }));

    useProjectStore.getState().updateClip('clip_1', { speed: 0.5 });

    const clip = useProjectStore.getState().project.clips[0];
    expect(clip.speed).toBe(0.5);
    expect(clip.duration).toBe(8);
    expect(clip.sourceStart + clip.duration * (clip.speed as number)).toBeLessThanOrEqual(clip.sourceDuration);
  });

  it('la ventana de origen consumida se conserva al cambiar de velocidad', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ duration: 4, sourceStart: 1, sourceDuration: 10 }));

    useProjectStore.getState().updateClip('clip_1', { speed: 2 });

    const clip = useProjectStore.getState().project.clips[0];
    // 4s of media at 1x is still 4s of media at 2x (just played in 2s).
    expect(clip.sourceStart + clip.duration * (clip.speed as number)).toBeCloseTo(5, 5);
  });
});

describe('F5 (S-12/B-04) — el tipo del medio se valida contra el tipo de pista', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('un vídeo directed a la pista de audio acaba en una pista de vídeo', () => {
    const store = useProjectStore.getState();
    const media = makeMedia({ id: 'media_video', type: 'video' });

    store.addClipFromMedia(media, 'track_audio_1', 0);

    const clips = useProjectStore.getState().project.clips;
    expect(clips.length).toBe(1);
    expect(clips[0].trackId).not.toBe('track_audio_1');
    const track = useProjectStore.getState().project.tracks.find((t) => t.id === clips[0].trackId);
    expect(track?.type).toBe('video');
  });

  it('un audio dirigido a una pista de vídeo acaba en la pista de audio', () => {
    const store = useProjectStore.getState();
    const media = makeMedia({ id: 'media_audio', type: 'audio', name: 'music.mp3' });

    store.addClipFromMedia(media, 'track_video_1', 0);

    const clips = useProjectStore.getState().project.clips;
    expect(clips.length).toBe(1);
    expect(clips[0].trackId).toBe('track_audio_1');
  });

  it('sin ninguna pista compatible no se crea ningún clip', () => {
    const store = useProjectStore.getState();
    // Remove every video track.
    for (const track of useProjectStore.getState().project.tracks.filter((t) => t.type === 'video')) {
      store.removeTrack(track.id);
    }

    const media = makeMedia({ id: 'media_video', type: 'video' });
    store.addClipFromMedia(media, undefined, 0);

    expect(useProjectStore.getState().project.clips.length).toBe(0);
    expect(useProjectStore.getState().lastError).toBeTruthy();
  });
});

describe('F6 (B-03) — las imágenes conservan su tamaño real', () => {
  const originalCreateImageBitmap = (globalThis as unknown as { createImageBitmap?: unknown }).createImageBitmap;

  afterEach(() => {
    if (originalCreateImageBitmap) {
      (globalThis as unknown as { createImageBitmap?: unknown }).createImageBitmap = originalCreateImageBitmap;
    } else {
      delete (globalThis as unknown as { createImageBitmap?: unknown }).createImageBitmap;
    }
  });

  it('importar una imagen de 800x600 guarda width 800 y height 600', async () => {
    (globalThis as unknown as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
      width: 800,
      height: 600,
      close: () => {},
    });

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'photo.png', { type: 'image/png' });
    const item = await buildMediaItemFromFile(file, 'media_img');

    expect(item).not.toBeNull();
    expect(item!.type).toBe('image');
    expect(item!.width).toBe(800);
    expect(item!.height).toBe(600);
    // The aspect ratio of the source is preserved.
    expect(item!.width / item!.height).toBeCloseTo(800 / 600, 5);
  });

  it('si la sonda de tamaño falla se usa el tamaño por defecto', async () => {
    (globalThis as unknown as { createImageBitmap?: unknown }).createImageBitmap = async () => {
      throw new Error('unsupported');
    };

    const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
    const item = await buildMediaItemFromFile(file, 'media_img');

    expect(item!.width).toBe(FALLBACK_MEDIA_WIDTH);
    expect(item!.height).toBe(FALLBACK_MEDIA_HEIGHT);
  });
});

describe('F7 (S-13) — splitClip reparte las palabras sincronizadas', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('cada mitad se queda solo con las palabras de su rango temporal', () => {
    const store = useProjectStore.getState();
    store.addClip(
      makeClip({
        duration: 10,
        words: [
          { word: 'Hola', start: 1, end: 2 },
          { word: 'mundo', start: 3, end: 4 },
          { word: 'final', start: 7, end: 9 },
        ],
      })
    );

    useProjectStore.getState().splitClip('clip_1', 5);

    const clips = useProjectStore.getState().project.clips;
    const part1 = clips.find((c) => c.id === 'clip_1')!;
    const part2 = clips.find((c) => c.id !== 'clip_1')!;

    expect(part1.words?.map((w) => w.word)).toEqual(['Hola', 'mundo']);
    expect(part2.words?.map((w) => w.word)).toEqual(['final']);
  });

  it('una palabra que cruza el punto de corte va a la primera mitad', () => {
    const store = useProjectStore.getState();
    store.addClip(
      makeClip({
        duration: 10,
        words: [
          { word: 'antes', start: 1, end: 2 },
          { word: 'cruzada', start: 4, end: 6 },
          { word: 'despues', start: 8, end: 9 },
        ],
      })
    );

    useProjectStore.getState().splitClip('clip_1', 5);

    const clips = useProjectStore.getState().project.clips;
    const part1 = clips.find((c) => c.id === 'clip_1')!;
    const part2 = clips.find((c) => c.id !== 'clip_1')!;

    expect(part1.words?.map((w) => w.word)).toEqual(['antes', 'cruzada']);
    expect(part2.words?.map((w) => w.word)).toEqual(['despues']);
  });

  it('un clip sin palabras se parte igual', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ duration: 10 }));

    useProjectStore.getState().splitClip('clip_1', 5);

    const clips = useProjectStore.getState().project.clips;
    expect(clips.length).toBe(2);
    expect(clips.find((c) => c.id === 'clip_1')!.duration).toBe(5);
    expect(clips.find((c) => c.id !== 'clip_1')!.duration).toBe(5);
  });
});

describe('F8 (S-05) — los recortes actualizan project.updatedAt', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('trimClipStart actualiza updatedAt', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 4, duration: 10, sourceStart: 0, sourceDuration: 20 }));

    const before = useProjectStore.getState().project.updatedAt;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(before + 5000);
    useProjectStore.getState().trimClipStart('clip_1', 6.5);
    nowSpy.mockRestore();

    expect(useProjectStore.getState().project.updatedAt).toBe(before + 5000);
  });

  it('trimClipEnd actualiza updatedAt', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 4, duration: 10, sourceStart: 0, sourceDuration: 20 }));

    const before = useProjectStore.getState().project.updatedAt;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(before + 9000);
    useProjectStore.getState().trimClipEnd('clip_1', 12.5);
    nowSpy.mockRestore();

    expect(useProjectStore.getState().project.updatedAt).toBe(before + 9000);
  });

  it('splitClip también actualiza updatedAt', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ duration: 10 }));

    const before = useProjectStore.getState().project.updatedAt;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(before + 7000);
    useProjectStore.getState().splitClip('clip_1', 5);
    nowSpy.mockRestore();

    expect(useProjectStore.getState().project.updatedAt).toBe(before + 7000);
  });
});
