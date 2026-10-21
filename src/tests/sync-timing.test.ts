/**
 * sync-timing.test.ts — Regresión del fallo de CI "solo en CI" (F13/F4).
 *
 * Causa: `VideoSyncState.lastRateChangeTime` se inicializaba a `0` y cada
 * mutación de `playbackRate` está guardada por `now - last >= 300` con
 * `now = performance.now()` (reloj relativo al proceso). La PRIMERA
 * corrección solo se permitía cuando el proceso llevaba vivo 300 ms: en un
 * runner rápido el cuerpo del test se ejecuta dentro de esa ventana y la
 * corrección se saltaba; en local el fichero se cargaba más tarde y pasaba.
 * El test tenía razón; el código estaba mal.
 *
 * Todos los tests de este fichero llevan el reloj mockeado (`performance.now`
 * clavado), así que fallan con el código viejo y pasan con el nuevo SIN
 * importar cuándo se ejecuten. También cubren los "hermanos" auditados con
 * el mismo patrón ("0 significa nunca"): `lastPrewarmTime` y el throttle de
 * `storeVideoFrame`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MediaSourcePool } from '../core/engine/MediaSourcePool';
import { MAX_PLAYBACK_RATE } from '../core/utils/playbackRate';
import { Clip, MediaItem } from '../types/project';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Reloj mockeado: el proceso "acaba de arrancar" cuando corre el test. */
function mockClock(now: number): void {
  vi.spyOn(performance, 'now').mockReturnValue(now);
}

function makeVideo(overrides: Record<string, unknown> = {}): HTMLVideoElement {
  return {
    readyState: 4,
    paused: false,
    seeking: false,
    currentTime: 1.0,
    playbackRate: 1,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    ...overrides,
  } as unknown as HTMLVideoElement;
}

function makeMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media_1',
    name: 'Media 1',
    type: 'video',
    url: 'blob:media-1',
    duration: 10,
    width: 640,
    height: 360,
    fps: 30,
    thumbnailUrl: '',
    size: 100,
    createdAt: 0,
    ...overrides,
  };
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip_1',
    trackId: 'track_video_1',
    mediaId: 'media_1',
    name: 'Clip 1',
    type: 'video',
    start: 1,
    duration: 5,
    sourceStart: 0,
    sourceDuration: 5,
    volume: 1,
    opacity: 1,
    scale: 1,
    positionX: 0,
    positionY: 0,
    muted: false,
    ...overrides,
  };
}

describe('sync-timing · la primera corrección no depende de la edad del proceso', () => {
  it('corrige un clip a cámara lenta aunque el proceso acabe de arrancar', () => {
    mockClock(0);
    const pool = new MediaSourcePool();
    const video = makeVideo({ currentTime: 1.7, playbackRate: 0.1 });

    // Deriva de +700 ms en un clip de 0.1x: corrección proporcional (zona 3).
    pool.syncVideoTime(video, 1.0, true, 0.1);

    expect(video.playbackRate).toBeCloseTo(0.1 * 0.8, 4);
  });

  it('corrige un clip rápido aunque el proceso acabe de arrancar', () => {
    mockClock(0);
    const pool = new MediaSourcePool();
    const video = makeVideo({ currentTime: 1.25, playbackRate: 1 });

    pool.syncVideoTime(video, 1.0, true, 1);

    expect(video.playbackRate).toBeCloseTo(0.94, 3);
  });

  it('el controlador usa la velocidad resuelta desde el primer fotograma', () => {
    mockClock(0);
    const pool = new MediaSourcePool();

    // Velocidad fuera de rango: se acota igual que en el export.
    const fast = makeVideo({ currentTime: 1 });
    pool.syncVideoTime(fast, 1, true, 8);
    expect(fast.playbackRate).toBe(MAX_PLAYBACK_RATE);

    const normal = makeVideo({ currentTime: 1 });
    pool.syncVideoTime(normal, 1, true, 2);
    expect(normal.playbackRate).toBe(2);
  });

  it('el cooldown sigue limitando cambios consecutivos (comportamiento intacto)', () => {
    mockClock(0);
    const pool = new MediaSourcePool();
    const video = makeVideo({ currentTime: 1.7, playbackRate: 0.1 });

    pool.syncVideoTime(video, 1.0, true, 0.1);
    expect(video.playbackRate).toBeCloseTo(0.08, 4);

    // La deriva cambia de signo 100 ms después: pediría 0.12, pero el
    // cooldown de 300 ms lo bloquea y se mantiene el 0.08.
    mockClock(100);
    video.currentTime = 0.3;
    pool.syncVideoTime(video, 1.0, true, 0.1);
    expect(video.playbackRate).toBeCloseTo(0.08, 4);
  });

  it('el precalentamiento no se salta la primera llamada', () => {
    mockClock(0);
    const pool = new MediaSourcePool();
    const spy = vi.spyOn(pool, 'getVideoElement');

    // Hermano auditado: `lastPrewarmTime = 0` ("nunca") se comparaba con
    // `now - x < 250`, así que la primera llamada dentro de los 250 ms del
    // proceso no hacía nada.
    pool.prewarmUpcomingClips(0, [makeClip({ start: 1 })], [makeMedia()]);

    expect(spy).toHaveBeenCalled();
  });

  it('el primer fotograma se guarda aunque el reloj acabe de arrancar', () => {
    mockClock(50);
    const pool = new MediaSourcePool();
    const fakeVideo = {
      readyState: 4,
      videoWidth: 320,
      videoHeight: 180,
    } as unknown as HTMLVideoElement;

    // Hermano auditado: `lastStoredFrameTimeMap.get() || 0` trataba "sin
    // registro" como tiempo 0, así que el primer `storeVideoFrame` dentro de
    // los 300 ms del proceso se estrangulaba (throttle).
    pool.storeVideoFrame('clip_x', fakeVideo);

    expect(pool.getLastFrame('clip_x')).not.toBeNull();
  });
});
