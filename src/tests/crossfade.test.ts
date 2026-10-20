/**
 * Regression suite for F5 — real crossfade between consecutive clips (W-18).
 *
 * A crossfade is the DELIBERATE overlap of two consecutive clips of the same
 * track over a shared region: both sources play simultaneously and are mixed
 * by the LINEAR curve (`out = 1 - p`, `in = p`) defined in
 * `src/core/utils/crossfade.ts` — the single source of truth shared by the
 * preview (`Compositor`, `AudioEngine`), the export (`webcodecsExporter`),
 * the store and the Inspector, so the paths cannot diverge.
 *
 * Every suite below exercises PRODUCTION code (helpers, store actions,
 * engine classes, offline audio render, export call sites). The suites marked
 * [FAILS-WITHOUT-FIX] assert behaviour that only exists after the change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  CROSSFADE_DEFAULT_DURATION,
  buildCrossfadeAudioSchedule,
  buildCrossfadeIndex,
  clampCrossfadeDuration,
  createCrossfadeIndexCache,
  crossfadeFrameDuration,
  crossfadeInGain,
  crossfadeMix,
  crossfadeOutGain,
  crossfadeOverlapDuration,
  describeCrossfadeForClip,
  getCrossfadeInMarker,
  getCrossfadeOutMarker,
  isDeliberateCrossfadeOverlap,
  planCrossfade,
  refreshCrossfadeIndex,
  type CrossfadeSpan,
} from '../core/utils/crossfade';
import {
  useProjectStore,
  DEFAULT_OVERLAP_POLICY,
  applyOverwriteInsert,
  applyRippleInsert,
  findIllegalOverlappingClips,
  findOverlappingClips,
  intervalsOverlap,
} from '../store/useProjectStore';
import { Compositor } from '../core/engine/Compositor';
import { AudioEngine } from '../core/engine/AudioEngine';
import { mediaSourcePool } from '../core/engine/MediaSourcePool';
import { exportVideo, renderOfflineAudio } from '../core/export/webcodecsExporter';
import type { Clip, MediaItem, Track } from '../types/project';

/* ------------------------------------------------------------------ */
/* Mocks: in-memory IndexedDB + fake OPFS (same hermetic pattern as the  */
/* R1 suite, so the store persistence never touches a real backend)      */
/* ------------------------------------------------------------------ */

const h = vi.hoisted(() => {
  const memory = new Map<string, unknown>();
  return {
    memory,
    getSpy: vi.fn(async (key: string) => memory.get(key)),
    setSpy: vi.fn(async (key: string, value: unknown) => {
      memory.set(key, value);
    }),
    delSpy: vi.fn(async (key: string) => {
      memory.delete(key);
    }),
    deleteMediaFiles: vi.fn(async (_items: unknown, _mode: unknown) => undefined),
    saveMediaToOPFS: vi.fn(async (mediaId: string, file: File) => `${mediaId}_${file.name}`),
    getMediaFromOPFS: vi.fn(async (_path: string): Promise<File | null> => null),
    deleteMediaFilesFromOPFS: vi.fn(async (_paths: string[]) => undefined),
  };
});

vi.mock('idb-keyval', () => ({
  get: (key: string) => h.getSpy(key),
  set: (key: string, value: unknown) => h.setSpy(key, value),
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
  isUsableMediaFile: (file: unknown) =>
    !!file && typeof (file as File).size === 'number' && (file as File).size > 0,
}));

vi.mock('../core/storage/projectStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/storage/projectStorage')>();
  return {
    ...actual,
    deleteMediaFiles: (items: unknown, mode: unknown) => h.deleteMediaFiles(items, mode),
  };
});

vi.mock('mp4-muxer', () => {
  const recorded = {
    options: null as Record<string, unknown> | null,
    videoChunks: [] as Array<{ type: string; timestamp: number; duration: number }>,
    audioChunks: [] as Array<{ type: string; timestamp: number; duration: number }>,
    finalized: false,
  };
  class MockMuxer {
    constructor(options: Record<string, unknown>) {
      recorded.options = options;
    }
    addVideoChunkRaw(
      _data: Uint8Array,
      type: string,
      timestamp: number,
      duration: number
    ) {
      recorded.videoChunks.push({ type, timestamp, duration });
    }
    addAudioChunkRaw(
      _data: Uint8Array,
      type: string,
      timestamp: number,
      duration: number
    ) {
      recorded.audioChunks.push({ type, timestamp, duration });
    }
    finalize() {
      recorded.finalized = true;
    }
  }
  class MockArrayBufferTarget {
    buffer = new ArrayBuffer(2048);
  }
  return { Muxer: MockMuxer, ArrayBufferTarget: MockArrayBufferTarget, __recorded: recorded };
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const VIDEO_TRACK = 'track_video_1';
const AUDIO_TRACK = 'track_audio_1';

function makeMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media_1',
    name: 'clip.mp4',
    type: 'video',
    url: 'blob:test/media_1',
    duration: 10,
    width: 640,
    height: 360,
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
    duration: 4,
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

const videoTrack: Track = {
  id: VIDEO_TRACK,
  name: 'Video V1',
  type: 'video',
  isMuted: false,
  isLocked: false,
  isVisible: true,
};

const audioTrack: Track = {
  id: AUDIO_TRACK,
  name: 'Audio A1',
  type: 'audio',
  isMuted: false,
  isLocked: false,
  isVisible: true,
};

/** Two touching clips on the default video track: A [0,4), B [4,7.2). */
function setupTouchingPair() {
  const store = useProjectStore.getState();
  store.addClip(makeClip({ id: 'xf_a', name: 'A', start: 0, duration: 4 }));
  store.addClip(makeClip({ id: 'xf_b', name: 'B', start: 4, duration: 3.2 }));
}

function getClip(id: string): Clip {
  const clip = useProjectStore.getState().project.clips.find((c) => c.id === id);
  if (!clip) throw new Error(`clip ${id} missing`);
  return clip;
}

/* ------------------------------------------------------------------ */
/* Global save / restore (node env: every DOM-ish global is installed   */
/* per suite and removed afterwards)                                    */
/* ------------------------------------------------------------------ */

const REAL_GLOBALS: Record<string, unknown> = {};
const GLOBAL_KEYS = [
  'document',
  'fetch',
  'AudioContext',
  'webkitAudioContext',
  'HTMLVideoElement',
  'VideoEncoder',
  'VideoFrame',
  'AudioEncoder',
  'AudioData',
  'OfflineAudioContext',
];

function saveGlobals(): void {
  for (const key of GLOBAL_KEYS) REAL_GLOBALS[key] = (globalThis as Record<string, unknown>)[key];
}

function restoreGlobals(): void {
  for (const key of GLOBAL_KEYS) {
    const value = REAL_GLOBALS[key];
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
}

beforeEach(() => {
  saveGlobals();
  h.deleteMediaFiles.mockClear();
  useProjectStore.getState().resetProject();
});

afterEach(() => {
  restoreGlobals();
  vi.restoreAllMocks();
});

/* ================================================================== */
/* A · The linear curve (shared by video, audio, preview and export)   */
/* ================================================================== */
describe('A · la curva del fundido es lineal y suma exactamente 1', () => {
  it('[FAILS-WITHOUT-FIX] crossfadeMix ramps 1→0 / 0→1', () => {
    expect(crossfadeMix(0)).toEqual({ out: 1, in: 0 });
    expect(crossfadeMix(0.5)).toEqual({ out: 0.5, in: 0.5 });
    expect(crossfadeMix(1)).toEqual({ out: 0, in: 1 });
  });

  it('out + in === 1 en todo punto (el audio nunca recorta por el fundido)', () => {
    for (let i = 0; i <= 20; i++) {
      const mix = crossfadeMix(i / 20);
      expect(mix.out + mix.in).toBeCloseTo(1, 12);
      expect(mix.out).toBeLessThanOrEqual(1);
      expect(mix.in).toBeLessThanOrEqual(1);
      expect(mix.out).toBeGreaterThanOrEqual(0);
      expect(mix.in).toBeGreaterThanOrEqual(0);
    }
  });

  it('las versiones escalares coinciden con la versión objeto y recortan fuera de rango', () => {
    expect(crossfadeOutGain(0.25)).toBeCloseTo(0.75, 12);
    expect(crossfadeInGain(0.25)).toBeCloseTo(0.25, 12);
    expect(crossfadeOutGain(-1)).toBe(1);
    expect(crossfadeInGain(-1)).toBe(0);
    expect(crossfadeOutGain(2)).toBe(0);
    expect(crossfadeInGain(2)).toBe(1);
    expect(crossfadeOutGain(Number.NaN)).toBe(1);
  });
});

/* ================================================================== */
/* B · Frame-based duration: quantize + clamp to the available media   */
/* ================================================================== */
describe('B · la duración está cuantizada a frames y recortada al material', () => {
  it('[FAILS-WITHOUT-FIX] cuantiza al frame del proyecto (0.55 s @30fps → 17/30)', () => {
    expect(clampCrossfadeDuration(0.55, 4, 30)).toBeCloseTo(17 / 30, 12);
    expect(clampCrossfadeDuration(0.5, 4, 30)).toBeCloseTo(0.5, 12);
  });

  it('[FAILS-WITHOUT-FIX] no supera el más corto de los dos clips', () => {
    expect(clampCrossfadeDuration(5, 2, 30)).toBeLessThanOrEqual(2);
    expect(clampCrossfadeDuration(5, 2, 30)).toBeCloseTo(2, 12);
  });

  it('devuelve 0 cuando ni un frame cabe (el store debe rechazar)', () => {
    expect(clampCrossfadeDuration(0.001, 4, 30)).toBe(0);
    expect(clampCrossfadeDuration(0.5, 0.001, 30)).toBe(0);
    expect(clampCrossfadeDuration(Number.NaN, 4, 30)).toBe(0);
  });

  it('el frame del proyecto sale del fps (30 → 1/30)', () => {
    expect(crossfadeFrameDuration(30)).toBeCloseTo(1 / 30, 12);
    expect(CROSSFADE_DEFAULT_DURATION).toBe(0.5);
  });
});

/* ================================================================== */
/* C · Deliberate overlap vs illegal overlap (the policy distinction)  */
/* ================================================================== */
describe('C · el solape deliberado se distingue del solape ilegal', () => {
  const outClip = makeClip({
    id: 'a',
    start: 0,
    duration: 4,
    transition: { fadeInType: 'none', fadeInDuration: 0, fadeOutType: 'none', fadeOutDuration: 0, crossfadeOutDuration: 0.5 },
  });
  const inClip = makeClip({
    id: 'b',
    start: 3.5,
    duration: 4,
    transition: { fadeInType: 'none', fadeInDuration: 0, fadeOutType: 'none', fadeOutDuration: 0, crossfadeInDuration: 0.5 },
  });

  it('mide el solape físico (0 al tocarse, >0 al solaparse)', () => {
    expect(crossfadeOverlapDuration(makeClip({ start: 0, duration: 4 }), makeClip({ start: 4, duration: 4 }))).toBe(0);
    expect(crossfadeOverlapDuration(outClip, inClip)).toBeCloseTo(0.5, 12);
  });

  it('[FAILS-WITHOUT-FIX] el par marcado con solape coincidente es deliberado', () => {
    expect(isDeliberateCrossfadeOverlap(outClip, inClip)).toBe(true);
    expect(isDeliberateCrossfadeOverlap(inClip, outClip)).toBe(true);
  });

  it('un solape SIN marcadores sigue siendo ilegal', () => {
    const illegal = makeClip({ id: 'c', start: 3.5, duration: 4 });
    expect(isDeliberateCrossfadeOverlap(outClip, illegal)).toBe(false);
    expect(isDeliberateCrossfadeOverlap(makeClip({ id: 'x', start: 0, duration: 4 }), illegal)).toBe(false);
  });

  it('los marcadores que no coinciden con el solape no blanquean nada', () => {
    const mismatch = makeClip({
      id: 'd',
      start: 3,
      duration: 4,
      transition: { fadeInType: 'none', fadeInDuration: 0, fadeOutType: 'none', fadeOutDuration: 0, crossfadeInDuration: 0.5 },
    });
    // Solape real de 1 s, marcadores de 0.5 s: no es un par válido.
    expect(crossfadeOverlapDuration(outClip, mismatch)).toBeCloseTo(1, 12);
    expect(isDeliberateCrossfadeOverlap(outClip, mismatch)).toBe(false);
  });

  it('clips de pistas distintas nunca forman un par', () => {
    const other = makeClip({ ...inClip, id: 'e', trackId: 'track_video_2' });
    expect(isDeliberateCrossfadeOverlap(outClip, other)).toBe(false);
  });

  it('[FAILS-WITHOUT-FIX] buildCrossfadeIndex resuelve el par una vez (roles y región)', () => {
    const spans = new Map<string, CrossfadeSpan>();
    buildCrossfadeIndex([outClip, inClip], spans);
    expect(spans.size).toBe(2);
    const spanA = spans.get('a')!;
    const spanB = spans.get('b')!;
    expect(spanA.role).toBe('out');
    expect(spanB.role).toBe('in');
    expect(spanA.partnerId).toBe('b');
    expect(spanB.partnerId).toBe('a');
    expect(spanA.regionStart).toBeCloseTo(3.5, 12);
    expect(spanA.regionEnd).toBeCloseTo(4, 12);
    expect(spanA.duration).toBeCloseTo(0.5, 12);
  });

  it('buildCrossfadeIndex ignora pares ilegales y clips que solo se tocan', () => {
    const spans = new Map<string, CrossfadeSpan>();
    const touching = makeClip({ id: 't', start: 4, duration: 4 });
    const illegal = makeClip({ id: 'i', start: 1, duration: 4 });
    buildCrossfadeIndex([makeClip({ id: 'x', start: 0, duration: 4 }), touching, illegal], spans);
    expect(spans.size).toBe(0);
  });

  it('los marcadores leen 0 sin transición', () => {
    const plain = makeClip({ id: 'p' });
    expect(getCrossfadeOutMarker(plain)).toBe(0);
    expect(getCrossfadeInMarker(plain)).toBe(0);
  });
});

/* ================================================================== */
/* C+ · Index cache: rebuilt on change, zero allocations per frame      */
/* ================================================================== */
describe('C+ · la caché del índice no asigna por frame', () => {
  const base = {
    fadeInType: 'none',
    fadeInDuration: 0,
    fadeOutType: 'none',
    fadeOutDuration: 0,
  } as const;
  const pairA = () =>
    makeClip({ id: 'c_a', start: 0, duration: 4, transition: { ...base, crossfadeOutDuration: 0.5 } });
  const pairB = () =>
    makeClip({ id: 'c_b', start: 3.5, duration: 4, transition: { ...base, crossfadeInDuration: 0.5 } });

  it('[FAILS-WITHOUT-FIX] reconstruye al cambiar y reutiliza con contenido idéntico', () => {
    const cache = createCrossfadeIndexCache();
    expect(refreshCrossfadeIndex(cache, [pairA(), pairB()])).toBe(true);
    expect(cache.spans.size).toBe(2);

    // Mismo contenido en OTRO array (como un frame nuevo del motor): sin
    // reconstrucción.
    expect(refreshCrossfadeIndex(cache, [pairA(), pairB()])).toBe(false);
    expect(cache.spans.size).toBe(2);

    // Cambio real (el entrante se mueve y rompe el par): reconstruye.
    expect(refreshCrossfadeIndex(cache, [pairA(), { ...pairB(), start: 4 }])).toBe(true);
    expect(cache.spans.size).toBe(0);
  });

  it('cero "new Map" en 60 frames con arrays nuevos idénticos', () => {
    const cache = createCrossfadeIndexCache();
    refreshCrossfadeIndex(cache, [pairA(), pairB()]);

    let maps = 0;
    const OriginalMap = globalThis.Map;
    (globalThis as Record<string, unknown>).Map = new Proxy(OriginalMap, {
      construct(target, args) {
        maps++;
        return new target(...(args as []));
      },
    });
    try {
      for (let frame = 0; frame < 60; frame++) {
        refreshCrossfadeIndex(cache, [{ ...pairA() }, { ...pairB() }]);
      }
    } finally {
      (globalThis as Record<string, unknown>).Map = OriginalMap;
    }
    expect(maps).toBe(0);
  });
});

/* ================================================================== */
/* D · Store: create / remove / setCrossfadeDuration                   */
/* ================================================================== */
describe('D · el store crea, elimina y ajusta el fundido (deshacible)', () => {
  it('[FAILS-WITHOUT-FIX] crear mueve el entrante y marca ambos clips', () => {
    setupTouchingPair();
    const result = useProjectStore.getState().createCrossfade('xf_a', 'xf_b', 0.5);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.duration).toBeCloseTo(0.5, 12);

    const a = getClip('xf_a');
    const b = getClip('xf_b');
    expect(a.start).toBe(0);
    expect(a.duration).toBe(4);
    expect(b.start).toBeCloseTo(3.5, 12);
    expect(b.duration).toBe(3.2);
    expect(a.transition?.crossfadeOutDuration).toBeCloseTo(0.5, 12);
    expect(b.transition?.crossfadeInDuration).toBeCloseTo(0.5, 12);
    // Los fundidos de borde existentes sobreviven (el fundido NO los borra).
    expect(a.transition?.fadeInType).toBe('none');
  });

  it('[FAILS-WITHOUT-FIX] el solape acorta la duración del proyecto', () => {
    setupTouchingPair();
    expect(useProjectStore.getState().project.duration).toBe(8); // ceil(7.2)
    useProjectStore.getState().createCrossfade('xf_a', 'xf_b', 0.5);
    // max end = 3.5 + 3.2 = 6.7 → ceil = 7
    expect(useProjectStore.getState().project.duration).toBe(7);
  });

  it('[FAILS-WITHOUT-FIX] crear y eliminar son deshacibles (undo/redo)', () => {
    setupTouchingPair();
    useProjectStore.getState().createCrossfade('xf_a', 'xf_b', 0.5);
    expect(getClip('xf_b').start).toBeCloseTo(3.5, 12);

    useProjectStore.getState().undo();
    expect(getClip('xf_b').start).toBe(4);
    expect(getClip('xf_b').transition?.crossfadeInDuration ?? 0).toBe(0);
    expect(getClip('xf_a').transition?.crossfadeOutDuration ?? 0).toBe(0);
    expect(useProjectStore.getState().project.duration).toBe(8);

    useProjectStore.getState().redo();
    expect(getClip('xf_b').start).toBeCloseTo(3.5, 12);
    expect(getClip('xf_b').transition?.crossfadeInDuration).toBeCloseTo(0.5, 12);
  });

  it('respeta la pista bloqueada y publica el motivo', () => {
    setupTouchingPair();
    useProjectStore.getState().toggleTrackLock(VIDEO_TRACK);
    const result = useProjectStore.getState().createCrossfade('xf_a', 'xf_b', 0.5);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/bloqueada/i);
    expect(useProjectStore.getState().lastError).toBe(result.reason);
    // Nada se movió.
    expect(getClip('xf_b').start).toBe(4);
  });

  it('rechaza clips no adyacentes (hueco) y no consecutivos', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ id: 'xf_a', start: 0, duration: 4 }));
    store.addClip(makeClip({ id: 'xf_b', start: 5, duration: 4 }));
    const gap = useProjectStore.getState().createCrossfade('xf_a', 'xf_b', 0.5);
    expect(gap.ok).toBe(false);
    if (gap.ok) throw new Error('unreachable');
    expect(gap.reason).toMatch(/adyacente/i);
  });

  it('rechaza clips de pistas distintas y el autofundido', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ id: 'xf_a', start: 0, duration: 4 }));
    store.addClip(makeClip({ id: 'other', trackId: 'track_video_2', start: 4, duration: 4 }));
    const otherTrack = useProjectStore.getState().project.tracks.find((t) => t.id === 'track_video_2');
    expect(otherTrack).toBeTruthy();
    const cross = useProjectStore.getState().createCrossfade('xf_a', 'other', 0.5);
    expect(cross.ok).toBe(false);
    if (cross.ok) throw new Error('unreachable');
    expect(cross.reason).toMatch(/misma pista/i);

    const self = useProjectStore.getState().createCrossfade('xf_a', 'xf_a', 0.5);
    expect(self.ok).toBe(false);
  });

  it('rechaza material demasiado corto (ni un frame cabe)', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ id: 'tiny_a', start: 0, duration: 0.02 }));
    store.addClip(makeClip({ id: 'tiny_b', start: 0.02, duration: 0.02 }));
    const result = useProjectStore.getState().createCrossfade('tiny_a', 'tiny_b', 0.5);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/corto/i);
  });

  it('[FAILS-WITHOUT-FIX] recorta al material más corto y cuantiza a frame', () => {
    setupTouchingPair();
    // Pedir 5 s con B de 3.2 s → 3.2 s.
    const clamped = useProjectStore.getState().createCrossfade('xf_a', 'xf_b', 5);
    expect(clamped.ok).toBe(true);
    if (!clamped.ok) throw new Error('unreachable');
    expect(clamped.duration).toBeCloseTo(3.2, 12);
    expect(getClip('xf_b').start).toBeCloseTo(4 - 3.2, 12);
  });

  it('[FAILS-WITHOUT-FIX] 0.55 s @30fps se cuantiza a 17/30', () => {
    setupTouchingPair();
    const result = useProjectStore.getState().createCrossfade('xf_a', 'xf_b', 0.55);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.duration).toBeCloseTo(17 / 30, 12);
  });

  it('sin duración usa la de por defecto (0.5 s)', () => {
    setupTouchingPair();
    const result = useProjectStore.getState().createCrossfade('xf_a', 'xf_b');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.duration).toBeCloseTo(CROSSFADE_DEFAULT_DURATION, 12);
  });

  it('[FAILS-WITHOUT-FIX] eliminar restaura la adyacencia y limpia marcadores', () => {
    setupTouchingPair();
    useProjectStore.getState().createCrossfade('xf_a', 'xf_b', 0.5);
    const removed = useProjectStore.getState().removeCrossfade('xf_b');
    expect(removed.ok).toBe(true);

    const b = getClip('xf_b');
    expect(b.start).toBeCloseTo(4, 12);
    expect(b.transition?.crossfadeInDuration ?? 0).toBe(0);
    expect(getClip('xf_a').transition?.crossfadeOutDuration ?? 0).toBe(0);
    expect(useProjectStore.getState().project.duration).toBe(8);

    // Sin fundido activo, eliminar de nuevo se rechaza con motivo.
    const again = useProjectStore.getState().removeCrossfade('xf_b');
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.reason).toMatch(/ningún fundido/i);
  });

  it('[FAILS-WITHOUT-FIX] ajustar la duración mueve el entrante (un par, un undo por gesto)', () => {
    setupTouchingPair();
    const store = useProjectStore.getState();
    store.createCrossfade('xf_a', 'xf_b', 0.5);

    const pastBefore = useProjectStore.getState().past.length;
    const first = useProjectStore.getState().setCrossfadeDuration('xf_a', 1.0);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    expect(first.duration).toBeCloseTo(1, 12);
    expect(getClip('xf_b').start).toBeCloseTo(3, 12);
    expect(useProjectStore.getState().past.length).toBe(pastBefore + 1);

    // Segunda llamada inmediata sobre el mismo par: coalesce, sin entrada nueva.
    const second = useProjectStore.getState().setCrossfadeDuration('xf_b', 1.2);
    expect(second.ok).toBe(true);
    expect(useProjectStore.getState().past.length).toBe(pastBefore + 1);
    expect(getClip('xf_b').start).toBeCloseTo(2.8, 12);
  });

  it('ajustar sin fundido activo se rechaza con motivo accionable', () => {
    setupTouchingPair();
    const result = useProjectStore.getState().setCrossfadeDuration('xf_a', 1.0);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/créalo primero/i);
  });

  it('[FAILS-WITHOUT-FIX] planCrossfade valida lo mismo que el store (contrato puro)', () => {
    setupTouchingPair();
    const { project } = useProjectStore.getState();
    const plan = planCrossfade({
      clips: project.clips,
      tracks: project.tracks,
      outgoingId: 'xf_a',
      incomingId: 'xf_b',
      requestedDuration: 0.5,
      fps: 30,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('unreachable');
    expect(plan.newIncomingStart).toBeCloseTo(3.5, 12);
    expect(plan.duration).toBeCloseTo(0.5, 12);
  });
});

/* ================================================================== */
/* E · The overlap policy still works; the deliberate pair is          */
/*     whitelisted, everything else is still a conflict                */
/* ================================================================== */
describe('E · la política de solapamiento convive con el fundido deliberado', () => {
  it('[FAILS-WITHOUT-FIX] el par deliberado se blanquea; el solape ilegal no', () => {
    setupTouchingPair();
    useProjectStore.getState().createCrossfade('xf_a', 'xf_b', 0.5);
    const { clips } = useProjectStore.getState().project;

    // Físicamente se solapan: el contrato de findOverlappingClips NO cambia.
    const physical = findOverlappingClips(clips, VIDEO_TRACK, 3.5, 3.2, 'xf_b');
    expect(physical.map((c) => c.id)).toContain('xf_a');

    // A nivel de política el par deliberado NO es un conflicto…
    const illegal = findIllegalOverlappingClips(clips, VIDEO_TRACK, 3.5, 3.2, 'xf_b');
    expect(illegal).toHaveLength(0);

    // …pero un tercer clip sobre la misma región SÍ lo es.
    useProjectStore.getState().addClip(makeClip({ id: 'xf_c', start: 3.6, duration: 1 }));
    const clips2 = useProjectStore.getState().project.clips;
    const conflict = findIllegalOverlappingClips(clips2, VIDEO_TRACK, 3.6, 1, 'xf_c');
    expect(conflict.map((c) => c.id).sort()).toEqual(['xf_a', 'xf_b']);
  });

  it('los helpers de política existentes siguen intactos', () => {
    expect(DEFAULT_OVERLAP_POLICY).toBe('block');
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false);
    expect(intervalsOverlap(0, 10, 5, 20)).toBe(true);

    const base: Clip[] = [makeClip({ id: 'base', start: 0, duration: 10 })];
    const overwrite = applyOverwriteInsert(base, VIDEO_TRACK, 5, 5);
    expect(overwrite.clips.find((c) => c.id === 'base')?.duration).toBe(5);

    const ripple = applyRippleInsert(base, VIDEO_TRACK, 5, 5);
    expect(ripple.shifted.length).toBeGreaterThan(0);

    // Con "block", una inserción ilegal se sigue rechazando (el fundido no
    // abre la puerta a solapes accidentales).
    setupTouchingPair();
    useProjectStore.getState().createCrossfade('xf_a', 'xf_b', 0.5);
    const media = makeMedia({ id: 'media_new', name: 'nuevo.mp4', duration: 2 });
    const refused = useProjectStore.getState().addClipFromMedia(media, VIDEO_TRACK, 0);
    expect(refused.ok).toBe(false);
  });
});

/* ================================================================== */
/* F · Compositor: both clips draw over the overlap, 1→0 and 0→1       */
/* ================================================================== */

class FakeHTMLVideoElement {
  readyState = 4;
  paused = true;
  seeking = false;
  currentTime = 0;
  playbackRate = 1;
  videoWidth = 640;
  videoHeight = 360;
  src = '';
  preload = '';
  muted = true;
  preservesPitch = true;
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

function makeCaptureCtx() {
  const draws: Array<{ alpha: number }> = [];
  let currentAlpha = 1;
  const ctx = {
    draws,
    save: () => {},
    restore: () => {},
    setTransform: () => {},
    fillRect: () => {},
    beginPath: () => {},
    rect: () => {},
    clip: () => {},
    drawImage: () => {
      draws.push({ alpha: currentAlpha });
    },
    measureText: () => ({ width: 10 }),
    filter: 'none',
    globalCompositeOperation: 'source-over',
    fillStyle: '',
  };
  Object.defineProperty(ctx, 'globalAlpha', {
    get: () => currentAlpha,
    set: (v: number) => {
      currentAlpha = v;
    },
    configurable: true,
  });
  return ctx;
}

type CaptureCtx = ReturnType<typeof makeCaptureCtx>;

function makeCaptureCanvas(ctx: CaptureCtx) {
  return {
    width: 640,
    height: 360,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

function installCompositorFakes(videoElements: Map<string, FakeHTMLVideoElement>) {
  (globalThis as Record<string, unknown>).HTMLVideoElement = FakeHTMLVideoElement;
  delete (globalThis as Record<string, unknown>).AudioContext;
  delete (globalThis as Record<string, unknown>).webkitAudioContext;
  vi.spyOn(mediaSourcePool, 'getVideoElement').mockImplementation(
    ((_media: unknown, clipId?: string) => {
      const el = videoElements.get(clipId ?? '');
      if (!el) throw new Error(`no fake video for ${clipId}`);
      return el;
    }) as typeof mediaSourcePool.getVideoElement
  );
  vi.spyOn(mediaSourcePool, 'storeVideoFrame').mockImplementation(() => {});
  vi.spyOn(mediaSourcePool, 'getLastFrame').mockReturnValue(null);
  vi.spyOn(mediaSourcePool, 'getLastFrameForSource').mockReturnValue(null);
}

function crossfadeVideoClips() {
  const base = {
    fadeInType: 'none',
    fadeInDuration: 0,
    fadeOutType: 'none',
    fadeOutDuration: 0,
  } as const;
  const a = makeClip({
    id: 'v_a',
    start: 0,
    duration: 4,
    transition: { ...base, crossfadeOutDuration: 0.5 },
  });
  const b = makeClip({
    id: 'v_b',
    start: 3.5,
    duration: 3.2,
    transition: { ...base, crossfadeInDuration: 0.5 },
  });
  return [a, b];
}

describe('F · el Compositor mezcla ambos clips en el solape (preview)', () => {
  it('[FAILS-WITHOUT-FIX] en el punto medio ambos se dibujan con alfa 0.5', () => {
    const videos = new Map([
      ['v_a', new FakeHTMLVideoElement()],
      ['v_b', new FakeHTMLVideoElement()],
    ]);
    installCompositorFakes(videos);

    const [a, b] = crossfadeVideoClips();
    const media = [makeMedia({ id: 'media_1' })];
    const ctx = makeCaptureCtx();
    const compositor = new Compositor();
    compositor.renderFrame({
      time: 3.75,
      canvas: makeCaptureCanvas(ctx),
      tracks: [videoTrack],
      clips: [a, b],
      mediaPool: media,
      isPlaying: false,
    });

    // Los DOS clips se dibujan (el entrante ya no queda tapado) con la curva
    // lineal: saliente 1→0, entrante 0→1. Sin el cambio ambos pintan con 1.0.
    expect(ctx.draws.length).toBe(2);
    expect(ctx.draws[0].alpha).toBeCloseTo(0.5, 6);
    expect(ctx.draws[1].alpha).toBeCloseTo(0.5, 6);
  });

  it('[FAILS-WITHOUT-FIX] fuera de la región el alfa vuelve a 1', () => {
    const videos = new Map([
      ['v_a', new FakeHTMLVideoElement()],
      ['v_b', new FakeHTMLVideoElement()],
    ]);
    installCompositorFakes(videos);

    const [a, b] = crossfadeVideoClips();
    const media = [makeMedia({ id: 'media_1' })];
    const compositor = new Compositor();

    const ctxBefore = makeCaptureCtx();
    compositor.renderFrame({
      time: 1,
      canvas: makeCaptureCanvas(ctxBefore),
      tracks: [{ ...videoTrack }],
      clips: [{ ...a }, { ...b }],
      mediaPool: media,
      isPlaying: false,
    });
    expect(ctxBefore.draws.length).toBe(1);
    expect(ctxBefore.draws[0].alpha).toBeCloseTo(1, 6);

    const ctxAfter = makeCaptureCtx();
    compositor.renderFrame({
      time: 5,
      canvas: makeCaptureCanvas(ctxAfter),
      tracks: [{ ...videoTrack }],
      clips: [{ ...a }, { ...b }],
      mediaPool: media,
      isPlaying: false,
    });
    expect(ctxAfter.draws.length).toBe(1);
    expect(ctxAfter.draws[0].alpha).toBeCloseTo(1, 6);
  });

  it('el índice se reconstruye al cambiar los clips (sin estado rancio)', () => {
    const videos = new Map([
      ['v_a', new FakeHTMLVideoElement()],
      ['v_b', new FakeHTMLVideoElement()],
    ]);
    installCompositorFakes(videos);

    const [a, b] = crossfadeVideoClips();
    const media = [makeMedia({ id: 'media_1' })];
    const compositor = new Compositor();

    const ctx1 = makeCaptureCtx();
    compositor.renderFrame({
      time: 3.75,
      canvas: makeCaptureCanvas(ctx1),
      tracks: [{ ...videoTrack }],
      clips: [a, b],
      mediaPool: media,
      isPlaying: false,
    });
    expect(ctx1.draws[0].alpha).toBeCloseTo(0.5, 6);

    // Mismos tiempos, pero el fundido ya no existe (solape ilegal sin
    // marcadores): el compositor debe enterarse en el siguiente frame.
    const plainA = makeClip({ id: 'v_a', start: 0, duration: 4 });
    const plainB = makeClip({ id: 'v_b', start: 3.5, duration: 3.2 });
    const ctx2 = makeCaptureCtx();
    compositor.renderFrame({
      time: 3.75,
      canvas: makeCaptureCanvas(ctx2),
      tracks: [{ ...videoTrack }],
      clips: [plainA, plainB],
      mediaPool: media,
      isPlaying: false,
    });
    expect(ctx2.draws.length).toBe(2);
    expect(ctx2.draws[0].alpha).toBeCloseTo(1, 6);
    expect(ctx2.draws[1].alpha).toBeCloseTo(1, 6);
  });

  it('preview y export pintan EXACTAMENTE lo mismo (mismo Compositor, mismas entradas)', () => {
    const videosA = new Map([
      ['v_a', new FakeHTMLVideoElement()],
      ['v_b', new FakeHTMLVideoElement()],
    ]);
    installCompositorFakes(videosA);

    const [a, b] = crossfadeVideoClips();
    const media = [makeMedia({ id: 'media_1' })];
    const tracks = [{ ...videoTrack }];

    // Preview…
    const previewCtx = makeCaptureCtx();
    new Compositor().renderFrame({
      time: 3.75,
      canvas: makeCaptureCanvas(previewCtx),
      tracks,
      clips: [a, b],
      mediaPool: media,
      isPlaying: false,
    });

    // …y export (el exportador renderiza con la MISMA clase Compositor).
    vi.restoreAllMocks();
    const videosB = new Map([
      ['v_a', new FakeHTMLVideoElement()],
      ['v_b', new FakeHTMLVideoElement()],
    ]);
    installCompositorFakes(videosB);
    const exportCtx = makeCaptureCtx();
    new Compositor().renderFrame({
      time: 3.75,
      canvas: makeCaptureCanvas(exportCtx),
      tracks: [{ ...videoTrack }],
      clips: [
        { ...a, transition: { ...a.transition! } },
        { ...b, transition: { ...b.transition! } },
      ],
      mediaPool: media,
      isPlaying: false,
    });

    expect(exportCtx.draws).toEqual(previewCtx.draws);
    expect(exportCtx.draws.map((d) => d.alpha)).toEqual([
      expect.closeTo(0.5, 6),
      expect.closeTo(0.5, 6),
    ]);
  });
});

/* ================================================================== */
/* G · AudioEngine: both clips are audible over the overlap, mixed     */
/* ================================================================== */

class FakeAudioElement {
  src = '';
  muted = false;
  paused = true;
  volume = 1;
  playbackRate = 1;
  currentTime = 0;
  preservesPitch = true;
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

function crossfadeAudioClips() {
  const base = {
    fadeInType: 'none',
    fadeInDuration: 0,
    fadeOutType: 'none',
    fadeOutDuration: 0,
  } as const;
  const a = makeClip({
    id: 'a_a',
    trackId: AUDIO_TRACK,
    mediaId: 'media_a',
    type: 'audio',
    start: 0,
    duration: 4,
    transition: { ...base, crossfadeOutDuration: 0.5 },
  });
  const b = makeClip({
    id: 'a_b',
    trackId: AUDIO_TRACK,
    mediaId: 'media_b',
    type: 'audio',
    start: 3.5,
    duration: 3.2,
    transition: { ...base, crossfadeInDuration: 0.5 },
  });
  return [a, b];
}

describe('G · el AudioEngine mezcla ambos clips en el solape', () => {
  it('[FAILS-WITHOUT-FIX] en el punto medio ambos suenan al 50%', () => {
    delete (globalThis as Record<string, unknown>).AudioContext;
    delete (globalThis as Record<string, unknown>).webkitAudioContext;
    const elements = new Map([
      ['a_a', new FakeAudioElement()],
      ['a_b', new FakeAudioElement()],
    ]);
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockImplementation(
      ((_media: unknown, clipId?: string) => {
        const el = elements.get(clipId ?? '');
        if (!el) throw new Error(`no fake audio for ${clipId}`);
        if (el.currentTime === 0) el.currentTime = 0;
        return el;
      }) as typeof mediaSourcePool.getAudioElement
    );

    const [a, b] = crossfadeAudioClips();
    const media = [
      makeMedia({ id: 'media_a', type: 'audio', duration: 30 }),
      makeMedia({ id: 'media_b', type: 'audio', duration: 30 }),
    ];
    new AudioEngine().updateAudio(3.75, true, [audioTrack], [a, b], media);

    // Sin el cambio ambos elementos quedan a 1.0 (doble audio a tope).
    expect(elements.get('a_a')!.volume).toBeCloseTo(0.5, 2);
    expect(elements.get('a_b')!.volume).toBeCloseTo(0.5, 2);
  });

  it('la suma de ganancias nunca supera 1 (no recorta)', () => {
    delete (globalThis as Record<string, unknown>).AudioContext;
    delete (globalThis as Record<string, unknown>).webkitAudioContext;
    const elements = new Map([
      ['a_a', new FakeAudioElement()],
      ['a_b', new FakeAudioElement()],
    ]);
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockImplementation(
      ((_media: unknown, clipId?: string) => {
        const el = elements.get(clipId ?? '');
        if (!el) throw new Error(`no fake audio for ${clipId}`);
        return el;
      }) as typeof mediaSourcePool.getAudioElement
    );

    const [a, b] = crossfadeAudioClips();
    const media = [
      makeMedia({ id: 'media_a', type: 'audio', duration: 30 }),
      makeMedia({ id: 'media_b', type: 'audio', duration: 30 }),
    ];
    const engine = new AudioEngine();
    for (let i = 0; i <= 10; i++) {
      engine.updateAudio(3.5 + (i / 10) * 0.5, true, [audioTrack], [a, b], media);
      // Only AUDIBLE elements count: a clip that just ended keeps its last
      // retained volume but its element is paused (E-09), so it makes no
      // sound and must not enter the sum.
      const audible = [...elements.values()].filter((el) => !el.paused);
      expect(audible.length).toBeGreaterThan(0);
      const sum = audible.reduce((acc, el) => acc + el.volume, 0);
      expect(sum).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});

/* ================================================================== */
/* H · Export audio: the offline mix follows the same curve            */
/* ================================================================== */

interface RecordedGain {
  events: Array<{ type: 'set' | 'linearRamp'; time: number; value: number }>;
}

function installOfflineAudioFakes(state: {
  starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
  gains: RecordedGain[];
}) {
  (globalThis as Record<string, unknown>).fetch = vi.fn(async (_url: string) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(1024),
  }));

  class FakeOfflineAudioContext {
    length: number;
    sampleRate: number;
    destination = {};
    constructor(_channels: number, length: number, sampleRate: number) {
      this.length = length;
      this.sampleRate = sampleRate;
    }
    createBufferSource() {
      const node = {
        buffer: null as unknown,
        playbackRate: { value: 1 },
        detune: {
          value: 0,
          setValueAtTime: (_v: number, _t: number) => {},
        },
        connect: () => {},
        start: (when: number, offset: number, duration: number) => {
          state.starts.push({ when, offset, duration, rate: node.playbackRate.value });
        },
      };
      return node;
    }
    createGain() {
      const recorded: RecordedGain = { events: [] };
      state.gains.push(recorded);
      return {
        gain: {
          value: 1,
          setValueAtTime: (value: number, time: number) => {
            recorded.events.push({ type: 'set', time, value });
          },
          linearRampToValueAtTime: (value: number, time: number) => {
            recorded.events.push({ type: 'linearRamp', time, value });
          },
        },
        connect: () => {},
      };
    }
    async decodeAudioData() {
      return { duration: 30, length: 30 * 48000, sampleRate: 48000, numberOfChannels: 2 };
    }
    async startRendering() {
      return {
        duration: this.length / this.sampleRate,
        length: this.length,
        sampleRate: this.sampleRate,
        numberOfChannels: 2,
        getChannelData: () => new Float32Array(this.length),
      };
    }
  }

  (globalThis as Record<string, unknown>).OfflineAudioContext = FakeOfflineAudioContext;
}

describe('H · el audio exportado mezcla ambos clips con la misma curva', () => {
  it('[FAILS-WITHOUT-FIX] la envolvente programa rampas de cruce (no solo fundidos de borde)', () => {
    const outSpan: CrossfadeSpan = {
      partnerId: 'b',
      regionStart: 3.5,
      regionEnd: 4,
      duration: 0.5,
      role: 'out',
    };
    const inSpan: CrossfadeSpan = {
      partnerId: 'a',
      regionStart: 3.5,
      regionEnd: 4,
      duration: 0.5,
      role: 'in',
    };
    const [a, b] = crossfadeAudioClips();

    // Saliente: a 0 al final de la región; entrante: de 0 al inicio.
    expect(buildCrossfadeAudioSchedule(a, outSpan)).toEqual([
      { type: 'set', time: 0, value: 1 },
      { type: 'linearRamp', time: 3.5, value: 1 },
      { type: 'linearRamp', time: 4, value: 0 },
    ]);
    expect(buildCrossfadeAudioSchedule(b, inSpan)).toEqual([
      { type: 'set', time: 3.5, value: 0 },
      { type: 'linearRamp', time: 4, value: 1 },
      { type: 'linearRamp', time: 6.7, value: 1 },
    ]);
  });

  it('respeta el volumen del clip y conserva el fundido del lado libre', () => {
    const [a] = crossfadeAudioClips();
    const quiet = { ...a, volume: 0.5 };
    const outSpan: CrossfadeSpan = {
      partnerId: 'b',
      regionStart: 3.5,
      regionEnd: 4,
      duration: 0.5,
      role: 'out',
    };
    const events = buildCrossfadeAudioSchedule(quiet, outSpan);
    expect(events[events.length - 1]).toEqual({ type: 'linearRamp', time: 4, value: 0 });
    expect(events[0]).toEqual({ type: 'set', time: 0, value: 0.5 });

    // Fundido de entrada en el lado libre (cabeza) + cruce en la cola.
    const withEdge: Clip = {
      ...a,
      transition: {
        fadeInType: 'fade-black',
        fadeInDuration: 1,
        fadeOutType: 'none',
        fadeOutDuration: 0,
        crossfadeOutDuration: 0.5,
      },
    };
    const edgeEvents = buildCrossfadeAudioSchedule(withEdge, outSpan);
    expect(edgeEvents).toEqual([
      { type: 'set', time: 0, value: 0 },
      { type: 'linearRamp', time: 1, value: 1 },
      { type: 'linearRamp', time: 3.5, value: 1 },
      { type: 'linearRamp', time: 4, value: 0 },
    ]);
  });

  it('[FAILS-WITHOUT-FIX] renderOfflineAudio suena ambos clips solapados con rampas de cruce', async () => {
    const state: {
      starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
      gains: RecordedGain[];
    } = { starts: [], gains: [] };
    installOfflineAudioFakes(state);

    const [a, b] = crossfadeAudioClips();
    const media = [
      makeMedia({ id: 'media_a', type: 'audio', duration: 30 }),
      makeMedia({ id: 'media_b', type: 'audio', duration: 30 }),
    ];
    const rendered = await renderOfflineAudio(8, [audioTrack], [a, b], media);
    expect(rendered).not.toBeNull();

    // Ambos clips arrancan y sus intervalos sonoros se solapan [3.5, 4].
    expect(state.starts.length).toBe(2);
    const sounded = state.starts.map((s) => ({ from: s.when, to: s.when + s.duration / s.rate }));
    const overlapStart = Math.max(sounded[0].from, sounded[1].from);
    const overlapEnd = Math.min(sounded[0].to, sounded[1].to);
    expect(overlapEnd - overlapStart).toBeGreaterThan(0.4);

    // Y sus ganancias siguen la curva lineal (rampa a 0 / rampa de 0).
    expect(state.gains.length).toBe(2);
    const outEvents = state.gains[0].events;
    const inEvents = state.gains[1].events;
    expect(outEvents[outEvents.length - 1]).toEqual({ type: 'linearRamp', time: 4, value: 0 });
    expect(inEvents[0]).toEqual({ type: 'set', time: 3.5, value: 0 });
    const inRamp = inEvents.find((e) => e.type === 'linearRamp' && e.time === 4);
    expect(inRamp?.value).toBeCloseTo(1, 12);
  });
});

/* ================================================================== */
/* I · Export video call site: the pair reaches the shared renderer    */
/* ================================================================== */

class FakeExportVideo {
  readyState = 4;
  paused = true;
  seeking = false;
  playbackRate = 1;
  videoWidth = 640;
  videoHeight = 360;
  src = '';
  preload = '';
  muted = true;
  private time = 0;
  private listeners: Record<string, Array<() => void>> = {};
  get currentTime(): number {
    return this.time;
  }
  set currentTime(value: number) {
    this.time = value;
    setTimeout(() => this.emit('seeked'), 0);
  }
  addEventListener(type: string, cb: () => void): void {
    (this.listeners[type] ||= []).push(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    this.listeners[type] = (this.listeners[type] || []).filter((l) => l !== cb);
  }
  emit(type: string): void {
    for (const cb of [...(this.listeners[type] || [])]) cb();
  }
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {}
}

class FakeExportCanvas {
  width = 0;
  height = 0;
}

function installExportVideoFakes() {
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') return new FakeExportCanvas();
      if (tag === 'video') return new FakeExportVideo();
      return {};
    },
  };
  (globalThis as Record<string, unknown>).fetch = vi.fn(async (_url: string) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(1024),
  }));

  class FakeVideoEncoder {
    state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
    encodeQueueSize = 0;
    private init: { output: (chunk: unknown, meta?: unknown) => void; error: (e: unknown) => void };
    constructor(init: { output: (chunk: unknown, meta?: unknown) => void; error: (e: unknown) => void }) {
      this.init = init;
    }
    static isConfigSupported = async (cfg: Record<string, unknown>) => ({ supported: true, config: cfg });
    configure(_cfg: Record<string, unknown>) {
      this.state = 'configured';
    }
    encode(frame: { timestamp: number; duration?: number }, encodeOptions?: { keyFrame?: boolean }) {
      this.init.output(
        {
          byteLength: 4,
          copyTo: (dest: Uint8Array) => dest.set([0, 0, 0, 1]),
          type: encodeOptions?.keyFrame ? 'key' : 'delta',
          timestamp: frame.timestamp,
          duration: frame.duration ?? null,
        },
        {
          decoderConfig: {
            codec: 'avc1.640028',
            codedWidth: 640,
            codedHeight: 360,
            colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' },
          },
        }
      );
    }
    async flush() {}
    close() {
      this.state = 'closed';
    }
  }
  (globalThis as Record<string, unknown>).VideoEncoder = FakeVideoEncoder;
  (globalThis as Record<string, unknown>).VideoFrame = class {
    timestamp: number;
    duration?: number;
    constructor(_source: unknown, init: { timestamp: number; duration?: number }) {
      this.timestamp = init.timestamp;
      this.duration = init.duration;
    }
    close() {}
  };

  class FakeAudioEncoder {
    state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
    encodeQueueSize = 0;
    private init: { output: (chunk: unknown, meta?: unknown) => void; error: (e: unknown) => void };
    constructor(init: { output: (chunk: unknown, meta?: unknown) => void; error: (e: unknown) => void }) {
      this.init = init;
    }
    static isConfigSupported = async (cfg: Record<string, unknown>) => ({ supported: true, config: cfg });
    configure(_cfg: Record<string, unknown>) {
      this.state = 'configured';
    }
    encode(data: { timestamp: number }) {
      this.init.output(
        {
          byteLength: 8,
          copyTo: (dest: Uint8Array) => dest.set([1, 2, 3, 4, 5, 6, 7, 8]),
          type: 'key',
          timestamp: data.timestamp,
          duration: null,
        },
        undefined
      );
    }
    async flush() {}
    close() {
      this.state = 'closed';
    }
  }
  (globalThis as Record<string, unknown>).AudioEncoder = FakeAudioEncoder;
  (globalThis as Record<string, unknown>).AudioData = class {
    constructor(public init: Record<string, unknown>) {}
    close() {}
  };

  installOfflineAudioFakes({ starts: [], gains: [] });
}

describe('I · el exportador alimenta el par al renderizador compartido', () => {
  it('cada frame del solape llega al Compositor con ambos clips marcados', async () => {
    installExportVideoFakes();
    const renders: Array<{ time: number; clips: Clip[] }> = [];
    const spy = vi
      .spyOn(Compositor.prototype, 'renderFrame')
      .mockImplementation((options: Parameters<Compositor['renderFrame']>[0]) => {
        renders.push({ time: options.time, clips: options.clips });
      });

    try {
      const base = {
        fadeInType: 'none',
        fadeInDuration: 0,
        fadeOutType: 'none',
        fadeOutDuration: 0,
      } as const;
      const a = makeClip({
        id: 'x_a',
        start: 0,
        duration: 1.5,
        transition: { ...base, crossfadeOutDuration: 0.5 },
      });
      const b = makeClip({
        id: 'x_b',
        start: 1.0,
        duration: 1.5,
        transition: { ...base, crossfadeInDuration: 0.5 },
      });
      const blob = await exportVideo({
        config: { aspectRatio: '16:9', width: 640, height: 360, fps: 30, bitrate: 2_000_000, format: 'mp4' },
        duration: 2.5,
        tracks: [videoTrack],
        clips: [a, b],
        mediaPool: [makeMedia({ id: 'media_1' })],
        onProgress: () => {},
      });

      expect(blob.size).toBeGreaterThan(0);
      // 2.5 s @30fps = 75 frames, a 1/30 exactos.
      expect(renders.length).toBe(75);
      expect(renders[0].time).toBeCloseTo(0, 12);
      expect(renders[74].time).toBeCloseTo(74 / 30, 9);

      // En cada frame del solape [1.0, 1.5) el exportador entrega el par
      // con sus marcadores al MISMO Compositor del preview (vía auto-correcta).
      const overlapRenders = renders.filter((r) => r.time >= 1.0 && r.time < 1.5);
      expect(overlapRenders.length).toBeGreaterThan(5);
      for (const render of overlapRenders) {
        const out = render.clips.find((c) => c.id === 'x_a');
        const inn = render.clips.find((c) => c.id === 'x_b');
        expect(out?.transition?.crossfadeOutDuration).toBeCloseTo(0.5, 12);
        expect(inn?.transition?.crossfadeInDuration).toBeCloseTo(0.5, 12);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

/* ================================================================== */
/* J · splitClip drops the crossfade markers (the pair is broken)      */
/* ================================================================== */
describe('J · partir un clip rompe su fundido (sin marcadores rancios)', () => {
  it('[FAILS-WITHOUT-FIX] las dos mitades pierden los marcadores de cruce', () => {
    setupTouchingPair();
    useProjectStore.getState().createCrossfade('xf_a', 'xf_b', 0.5);
    expect(getClip('xf_a').transition?.crossfadeOutDuration).toBeCloseTo(0.5, 12);

    useProjectStore.getState().splitClip('xf_a', 2);
    const halves = useProjectStore
      .getState()
      .project.clips.filter((c) => c.id === 'xf_a' || c.name.includes('parte 2'));
    expect(halves.length).toBe(2);
    for (const half of halves) {
      expect(half.transition?.crossfadeOutDuration ?? 0).toBe(0);
      expect(half.transition?.crossfadeInDuration ?? 0).toBe(0);
    }
  });
});

/* ================================================================== */
/* K · Inspector availability: the same pure logic the store enforces  */
/* ================================================================== */
describe('K · el Inspector explica cuándo el fundido no es posible', () => {
  it('sin clip: motivo para seleccionar', () => {
    const info = describeCrossfadeForClip([], [], 'missing', 30);
    expect(info.clipFound).toBe(false);
    expect(info.canCreate).toBe(false);
    expect(info.createReason).toMatch(/selecciona/i);
  });

  it('clip sin vecino: motivo claro', () => {
    setupTouchingPair();
    useProjectStore.getState().removeClip('xf_b');
    const { project } = useProjectStore.getState();
    const info = describeCrossfadeForClip(project.clips, project.tracks, 'xf_a', 30);
    expect(info.neighbour).toBeNull();
    expect(info.canCreate).toBe(false);
    expect(info.createReason).toMatch(/vecino/i);
  });

  it('vecinos que se tocan: se puede crear (roles y máximo correctos)', () => {
    setupTouchingPair();
    const { project } = useProjectStore.getState();
    const infoA = describeCrossfadeForClip(project.clips, project.tracks, 'xf_a', 30);
    expect(infoA.canCreate).toBe(true);
    expect(infoA.createReason).toBeNull();
    expect(infoA.neighbour?.id).toBe('xf_b');
    expect(infoA.neighbour?.selectedRole).toBe('out');
    expect(infoA.maxDuration).toBeCloseTo(3.2, 12);

    const infoB = describeCrossfadeForClip(project.clips, project.tracks, 'xf_b', 30);
    expect(infoB.canCreate).toBe(true);
    expect(infoB.neighbour?.id).toBe('xf_a');
    expect(infoB.neighbour?.selectedRole).toBe('in');
  });

  it('vecino con hueco: motivo de adyacencia', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ id: 'xf_a', start: 0, duration: 4 }));
    store.addClip(makeClip({ id: 'xf_b', start: 6, duration: 4 }));
    const { project } = useProjectStore.getState();
    const info = describeCrossfadeForClip(project.clips, project.tracks, 'xf_a', 30);
    expect(info.canCreate).toBe(false);
    expect(info.createReason).toMatch(/adyacente/i);
  });

  it('pista bloqueada: motivo de bloqueo', () => {
    setupTouchingPair();
    useProjectStore.getState().toggleTrackLock(VIDEO_TRACK);
    const { project } = useProjectStore.getState();
    const info = describeCrossfadeForClip(project.clips, project.tracks, 'xf_a', 30);
    expect(info.trackLocked).toBe(true);
    expect(info.canCreate).toBe(false);
    expect(info.createReason).toMatch(/bloqueada/i);
  });

  it('material demasiado corto: motivo de duración', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ id: 'tiny_a', start: 0, duration: 0.02 }));
    store.addClip(makeClip({ id: 'tiny_b', start: 0.02, duration: 0.02 }));
    const { project } = useProjectStore.getState();
    const info = describeCrossfadeForClip(project.clips, project.tracks, 'tiny_a', 30);
    expect(info.canCreate).toBe(false);
    expect(info.createReason).toMatch(/corto/i);
  });

  it('[FAILS-WITHOUT-FIX] con fundido activo: par, duración y borrado', () => {
    setupTouchingPair();
    useProjectStore.getState().createCrossfade('xf_a', 'xf_b', 0.5);
    const { project } = useProjectStore.getState();
    const info = describeCrossfadeForClip(project.clips, project.tracks, 'xf_b', 30);
    expect(info.activePair).toEqual({ outId: 'xf_a', inId: 'xf_b', duration: expect.closeTo(0.5, 12) });
    expect(info.currentDuration).toBeCloseTo(0.5, 12);
    expect(info.canRemove).toBe(true);
  });
});

/* ================================================================== */
/* L · Inspector wiring: Spanish labels, aria-labels, keyboard access  */
/* ================================================================== */
describe('L · el Inspector expone la sección en español y accesible', () => {
  it('la sección existe con etiquetas, testids y controles de teclado', () => {
    const source = readFileSync(
      new URL('../components/inspector/ClipInspector.tsx', import.meta.url),
      'utf-8'
    );
    // Título y controles en español.
    expect(source).toContain('Fundido de cruce');
    expect(source).toContain('Crear fundido');
    expect(source).toContain('Eliminar fundido');
    // Accesibilidad: controles nativos (teclado) con aria-labels.
    expect(source).toContain('aria-label="Crear fundido de cruce"');
    expect(source).toContain('aria-label="Eliminar fundido de cruce"');
    expect(source).toContain('aria-label="Duración del fundido de cruce"');
    expect(source).toContain('data-testid="crossfade-section"');
    expect(source).toContain('data-testid="crossfade-create"');
    expect(source).toContain('data-testid="crossfade-remove"');
    expect(source).toContain('data-testid="crossfade-duration"');
    expect(source).toContain('data-testid="crossfade-disabled-reason"');
    // El motivo de deshabilitado se anuncia (role="status").
    expect(source).toContain('role="status"');
    // La sección usa la misma lógica pura que el store (sin duplicar reglas).
    expect(source).toContain('describeCrossfadeForClip');
  });
});
