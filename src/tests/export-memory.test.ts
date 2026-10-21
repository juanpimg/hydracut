/**
 * W-B · Memoria y rendimiento del export (B1–B5).
 *
 * Cada test ejercita el CÓDIGO DE PRODUCCIÓN (webcodecsExporter,
 * MediaSourcePool, Compositor, resolvePlayback), nunca una copia.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Compositor, computeRenderScale } from '../core/engine/Compositor';
import { MediaSourcePool, mediaSourcePool } from '../core/engine/MediaSourcePool';
import {
  assertExportAudioBudget,
  createRecorderChunkSink,
  estimateOfflineAudioBytes,
  MAX_EXPORT_DURATION_SECONDS,
  renderOfflineAudio,
  exportVideo,
} from '../core/export/webcodecsExporter';
import { resolvePlayback } from '../core/utils/playbackRate';
import type { Clip, MediaItem, Track } from '../types/project';

afterEach(() => {
  delete (globalThis as Record<string, unknown>).OfflineAudioContext;
  delete (globalThis as Record<string, unknown>).fetch;
  delete (globalThis as Record<string, unknown>).navigator;
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* B1 · guarda de duración/memoria ANTES de asignar                     */
/* ------------------------------------------------------------------ */

describe('B1 · la exportación larga se rechaza antes de asignar memoria', () => {
  it('estima el búfer PCM: 10 min estéreo a 48 kHz ≈ 230 MB', () => {
    expect(estimateOfflineAudioBytes(600)).toBe(600 * 48000 * 2 * 4);
    expect(estimateOfflineAudioBytes(3600)).toBe(3600 * 48000 * 2 * 4);
  });

  it('acepta duraciones normales y rechaza las que agotarían la memoria', () => {
    expect(() => assertExportAudioBudget(600)).not.toThrow();
    expect(() => assertExportAudioBudget(MAX_EXPORT_DURATION_SECONDS)).not.toThrow();
    expect(() => assertExportAudioBudget(MAX_EXPORT_DURATION_SECONDS + 1)).toThrow(
      /rango personalizado/i
    );
  });

  it('el mensaje es accionable y en español', () => {
    try {
      assertExportAudioBudget(3600);
      expect.unreachable('debería lanzar');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/demasiado larga|memoria/i);
      expect(msg).toMatch(/rango personalizado/i);
    }
  });

  it('renderOfflineAudio falla ANTES de construir el OfflineAudioContext', async () => {
    let constructions = 0;
    (globalThis as Record<string, unknown>).OfflineAudioContext = class {
      constructor() {
        constructions++;
        throw new Error('no debería construirse');
      }
    };
    const track: Track = {
      id: 't',
      name: 'A',
      type: 'audio',
      isMuted: false,
      isLocked: false,
      isVisible: true,
    };
    const clip: Clip = {
      id: 'c',
      trackId: 't',
      mediaId: 'm',
      name: 'C',
      type: 'audio',
      start: 0,
      duration: 3600,
      sourceStart: 0,
      sourceDuration: 3600,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };
    const media: MediaItem = {
      id: 'm',
      name: 'M',
      type: 'audio',
      url: 'blob:m',
      duration: 3600,
      width: 0,
      height: 0,
      fps: 30,
      thumbnailUrl: '',
      size: 1,
      createdAt: 0,
    };
    await expect(renderOfflineAudio(3600, [track], [clip], [media])).rejects.toThrow(
      /rango personalizado/i
    );
    expect(constructions).toBe(0);
  });

  it('exportVideo rechaza una duración enorme sin tocar el DOM', async () => {
    await expect(
      exportVideo({
        config: {
          aspectRatio: '16:9',
          width: 320,
          height: 180,
          fps: 30,
          bitrate: 500_000,
          format: 'mp4',
        },
        duration: 3600,
        tracks: [],
        clips: [],
        mediaPool: [],
        onProgress: () => {},
      })
    ).rejects.toThrow(/rango personalizado/i);
  });
});

/* ------------------------------------------------------------------ */
/* B2 · el respaldo MediaRecorder no duplica el pico de memoria         */
/* ------------------------------------------------------------------ */

describe('B2 · el sumidero de fragmentos graba sin duplicar el pico', () => {
  it('en RAM acumula Blobs por referencia y ensambla una sola copia al final', async () => {
    const sink = await createRecorderChunkSink();
    const a = new Blob([new Uint8Array(10)]);
    const b = new Blob([new Uint8Array(20)]);
    sink.push(a);
    sink.push(b);
    // Nada vacío ni nulo entra al sumidero.
    sink.push(new Blob([]));
    expect(sink.bytes).toBe(30);
    const out = await sink.finalize('video/webm;codecs=vp9,opus', 'video/webm');
    expect(out.size).toBe(30);
    expect(out.type).toBe('video/webm;codecs=vp9,opus');
    await sink.discard();
  });

  it('usa OPFS cuando está disponible y limpia el temporal', async () => {
    const written: Blob[] = [];
    let removed = '';
    const fakeWritable = {
      write: vi.fn(async (chunk: Blob) => {
        written.push(chunk);
      }),
      close: vi.fn(async () => {}),
    };
    const fakeHandle = {
      createWritable: vi.fn(async () => fakeWritable),
      getFile: vi.fn(async () => new Blob(written)),
    };
    const fakeDir = {
      getFileHandle: vi.fn(async () => fakeHandle),
      removeEntry: vi.fn(async (name: string) => {
        removed = name;
      }),
    };
    (globalThis as Record<string, unknown>).navigator = {
      storage: { getDirectory: vi.fn(async () => fakeDir) },
    };

    const sink = await createRecorderChunkSink();
    sink.push(new Blob([new Uint8Array([1, 2, 3])]));
    sink.push(new Blob([new Uint8Array([4, 5])]));
    const out = await sink.finalize('video/webm', 'video/webm');
    expect(out.size).toBe(5);
    // Las escrituras se encadenan en orden y el temporal se borra.
    expect(fakeWritable.write).toHaveBeenCalledTimes(2);
    expect(removed.length).toBeGreaterThan(0);
    await sink.discard();
  });

  it('degrada a RAM cuando OPFS no está disponible', async () => {
    (globalThis as Record<string, unknown>).navigator = {
      storage: {
        getDirectory: vi.fn(async () => {
          throw new Error('OPFS bloqueado');
        }),
      },
    };
    const sink = await createRecorderChunkSink();
    sink.push(new Blob([new Uint8Array(7)]));
    const out = await sink.finalize('video/webm', 'video/webm');
    expect(out.size).toBe(7);
    await sink.discard();
  });

  it('si la escritura a disco falla, el archivo se ensambla con lo caído en RAM (sin corromper)', async () => {
    const written: Blob[] = [];
    const fakeWritable = {
      // El disco rechaza la SEGUNDA escritura (cuota, motor capado…).
      write: vi.fn(async (chunk: Blob) => {
        if (written.length >= 1) throw new Error('cuota de disco');
        written.push(chunk);
      }),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const fakeHandle = {
      createWritable: vi.fn(async () => fakeWritable),
      getFile: vi.fn(async () => new Blob(written)),
    };
    const fakeDir = {
      getFileHandle: vi.fn(async () => fakeHandle),
      removeEntry: vi.fn(async () => {}),
    };
    (globalThis as Record<string, unknown>).navigator = {
      storage: { getDirectory: vi.fn(async () => fakeDir) },
    };

    const sink = await createRecorderChunkSink();
    sink.push(new Blob([new Uint8Array([1, 2, 3])]));
    sink.push(new Blob([new Uint8Array([4, 5])]));
    sink.push(new Blob([new Uint8Array([6])]));
    const out = await sink.finalize('video/webm', 'video/webm');
    // Prefijo de disco (3 B) + sufijo de RAM (3 B), en orden y verificado.
    expect(out.size).toBe(6);
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    await sink.discard();
  });
});

/* ------------------------------------------------------------------ */
/* B3 · la caché de lastFrame está acotada por píxeles (LRU)            */
/* ------------------------------------------------------------------ */

describe('B3 · los fotogramas cacheados no crecen sin cota', () => {
  function fakeVideo(w = 1920, h = 1080) {
    return { readyState: 4, videoWidth: w, videoHeight: h } as unknown as HTMLVideoElement;
  }

  it('20 clips distintos a 1080p no retienen ~330 MB', () => {
    const pool = new MediaSourcePool();
    for (let i = 0; i < 20; i++) {
      pool.storeVideoFrame(`clip_${i}`, fakeVideo(), `media_${i}`, true);
    }
    const cap = 6 * 1920 * 1080;
    expect(pool.getLastFrameCachePixels()).toBeLessThanOrEqual(cap);
    // Solo sobreviven los más recientes: los primeros se desalojaron.
    expect(pool.getLastFrame('clip_0')).toBeNull();
    expect(pool.getLastFrame('clip_19')).not.toBeNull();
  });

  it('el acceso reciente protege del desalojo (LRU)', () => {
    const pool = new MediaSourcePool();
    for (let i = 0; i < 6; i++) {
      pool.storeVideoFrame(`clip_${i}`, fakeVideo(), undefined, true);
    }
    // Toca el más antiguo: pasa a ser el más reciente.
    expect(pool.getLastFrame('clip_0')).not.toBeNull();
    pool.storeVideoFrame('clip_new', fakeVideo(), undefined, true);
    expect(pool.getLastFrame('clip_0')).not.toBeNull();
    expect(pool.getLastFrame('clip_1')).toBeNull();
    expect(pool.getLastFrameCachePixels()).toBeLessThanOrEqual(6 * 1920 * 1080);
  });

  it('liberar un clip descuenta sus píxeles', () => {
    const pool = new MediaSourcePool();
    pool.storeVideoFrame('clip_a', fakeVideo(), 'media_a', true);
    const before = pool.getLastFrameCachePixels();
    expect(before).toBeGreaterThan(0);
    pool.releaseClip('clip_a');
    expect(pool.getLastFrameCachePixels()).toBeLessThan(before);
  });
});

/* ------------------------------------------------------------------ */
/* B4 · el techo de píxeles del preview limita de verdad                */
/* ------------------------------------------------------------------ */

describe('B4 · MAX_PREVIEW_PIXELS acota el backing store', () => {
  it('un proyecto 4K a pantalla completa ya no rasteriza 8,3 M px', () => {
    const r = computeRenderScale({
      logicalWidth: 3840,
      logicalHeight: 2160,
      cssWidth: 3840,
      cssHeight: 2160,
      devicePixelRatio: 1,
    });
    expect(r.pixels).toBeLessThanOrEqual(2_100_000);
    expect(r.pixels).toBeLessThan(3840 * 2160);
    expect(r.width % 2).toBe(0);
    expect(r.height % 2).toBe(0);
  });

  it('mantiene la nitidez donde importa (1080p HiDPI intacto)', () => {
    const r = computeRenderScale({
      logicalWidth: 1920,
      logicalHeight: 1080,
      cssWidth: 851,
      cssHeight: 478,
      devicePixelRatio: 2,
    });
    expect(r.width).toBe(1700);
    expect(r.height).toBe(956);
  });

  it('conserva cobertura nítida y proporción en todos los casos normales', () => {
    const viewports = [
      [851, 478],
      [414, 232],
      [372, 208],
      [302, 169],
      [249, 139],
      [192, 107],
    ];
    for (const [cssWidth, cssHeight] of viewports) {
      for (const dpr of [1, 2, 3]) {
        const r = computeRenderScale({
          logicalWidth: 1920,
          logicalHeight: 1080,
          cssWidth,
          cssHeight,
          devicePixelRatio: dpr,
        });
        const s = Math.min(cssWidth / r.width, cssHeight / r.height);
        const painted = r.width * s * (r.height * s) * dpr;
        expect(r.pixels).toBeGreaterThanOrEqual(painted * 0.98);
        const aspectError = Math.abs(r.width / r.height - 1920 / 1080) / (1920 / 1080);
        expect(aspectError).toBeLessThan(0.01);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* B5 · victorias baratas del camino caliente                           */
/* ------------------------------------------------------------------ */

describe('B5 · el caso común no asigna', () => {
  it('resolvePlayback devuelve una constante congelada para speed 1', () => {
    const a = resolvePlayback(undefined);
    const b = resolvePlayback({ speed: 1 });
    const c = resolvePlayback({});
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).toEqual({ rate: 1, preservesPitch: true, detuneCents: 0 });
    // Fuera del defecto sí hay valores propios.
    expect(resolvePlayback({ speed: 2 }).rate).toBe(2);
    expect(resolvePlayback({ speed: 2 })).not.toBe(a);
  });

  it('el Compositor reutiliza la clave del elemento de vídeo entre pasadas', () => {
    const compositor = new Compositor();
    const track: Track = {
      id: 't1',
      name: 'V',
      type: 'video',
      isMuted: false,
      isLocked: false,
      isVisible: true,
    };
    const clip: Clip = {
      id: 'c1',
      trackId: 't1',
      mediaId: 'm1',
      name: 'C',
      type: 'video',
      start: 0,
      duration: 5,
      sourceStart: 0,
      sourceDuration: 5,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };
    const media: MediaItem = {
      id: 'm1',
      name: 'M',
      type: 'video',
      url: 'blob:m',
      duration: 5,
      width: 640,
      height: 360,
      fps: 30,
      thumbnailUrl: '',
      size: 1,
      createdAt: 0,
    };
    const ctx = {
      fillStyle: '',
      globalAlpha: 1,
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      setTransform: vi.fn(),
    };
    const canvas = {
      width: 640,
      height: 360,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;

    vi.spyOn(mediaSourcePool, 'getVideoElement').mockReturnValue({
      readyState: 4,
      currentTime: 0,
      paused: false,
    } as unknown as HTMLVideoElement);
    vi.spyOn(mediaSourcePool, 'getLastFrame').mockReturnValue(null);
    vi.spyOn(mediaSourcePool, 'getLastFrameForSource').mockReturnValue(null);
    vi.spyOn(mediaSourcePool, 'syncVideoTime').mockImplementation(() => {});
    (compositor as unknown as { drawMediaToCanvas: unknown }).drawMediaToCanvas = vi
      .fn()
      .mockReturnValue(true);

    const options = {
      time: 1,
      canvas,
      tracks: [track],
      clips: [clip],
      mediaPool: [media],
      isPlaying: true,
    };
    compositor.renderFrame(options);
    const internals = compositor as unknown as {
      videoKeyCache: Map<string, { mediaId: string; key: string }>;
    };
    expect(internals.videoKeyCache.size).toBe(1);
    const first = internals.videoKeyCache.get('c1')?.key;
    expect(first).toBe('m1_c1');
    compositor.renderFrame({ ...options });
    // La misma cadena, sin reconstruir: la caché no crece ni reasigna.
    expect(internals.videoKeyCache.size).toBe(1);
    expect(internals.videoKeyCache.get('c1')?.key).toBe(first);
  });
});
