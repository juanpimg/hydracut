/**
 * Regression suite for per-clip audio effects (pan / 3-band EQ / ducking).
 *
 * The pipeline could only set a VOLUME per clip. A real editor also needs:
 * - panning (where the clip sits in the stereo field),
 * - a simple 3-band EQ (low / mid / high),
 * - ducking (the music lowers automatically while a voice plays).
 *
 * The single source of truth is `src/core/utils/audioEffects.ts`:
 * - `resolveClipAudioChain` (hot path, zero allocations) derives the
 *   pan/EQ/duck parameters the preview (`AudioEngine`) and the export
 *   (`renderOfflineAudio`) apply,
 * - `duckEnvelopeGain` (hot path) is sampled per frame by the preview and
 *   `buildDuckAutomation` (cold path) programs the SAME function into the
 *   dedicated offline `GainNode`,
 * - `normalizeAudioEffects` (cold path) is enforced on every write by the
 *   store,
 * - the Inspector edits through `updateClip` / `setClipAudioEffects` and
 *   marks tracks with `setTrackRole`.
 *
 * Ducking rule (deterministic, see `audioEffects.ts`): a clip C with
 * `audioEffects.duck === true` is attenuated by `amountDb` dB (default 8 dB,
 * configurable) while an AUDIBLE voice clip plays on ANOTHER track, where
 * "voice" = a clip on a track with `role === 'dialogue'` (audible =
 * audio/video, not muted, volume > 0, track not muted). Linear ramps of
 * `attackSec` (default 0.15 s) before the voice and `releaseSec` (default
 * 0.4 s) after it.
 *
 * Every suite below exercises PRODUCTION code. Suites marked
 * [FAILS-WITHOUT-FIX] assert behaviour that only exists after the change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  BIQUAD_FILTER_UNSUPPORTED_MESSAGE,
  DEFAULT_DUCK_CONFIG,
  EQ_DB_MAX,
  EQ_DB_MIN,
  EQ_HIGH_FREQUENCY,
  EQ_LOW_FREQUENCY,
  EQ_MID_FREQUENCY,
  EQ_MID_Q,
  STEREO_PANNER_UNSUPPORTED_MESSAGE,
  TRACK_ROLE_LABELS,
  buildDuckAutomation,
  clampEqDb,
  clampPan,
  computeDialogueIntervals,
  createDuckIndexCache,
  dbToGain,
  detectBiquadFilterSupport,
  detectStereoPannerSupport,
  duckEnvelopeGain,
  duckFullGain,
  evaluateDuckAutomation,
  hasActiveEq,
  isNeutralAudioEffects,
  normalizeAudioEffects,
  normalizeDuckConfig,
  normalizeTrackRole,
  refreshDuckIndex,
  resetBiquadFilterSupportCache,
  resetStereoPannerSupportCache,
  resolveClipAudioChain,
  resolveEq,
  resolveEqFilterConfig,
  resolvePan,
} from '../core/utils/audioEffects';
import { useProjectStore } from '../store/useProjectStore';
import { AudioEngine, resolvePreviewAudioChain } from '../core/engine/AudioEngine';
import { mediaSourcePool } from '../core/engine/MediaSourcePool';
import { masterClock } from '../core/engine/MasterClock';
import { renderOfflineAudio, resolveExportAudioChain } from '../core/export/webcodecsExporter';
import type { Clip, ClipAudioEffects, MediaItem, Track } from '../types/project';

/* ------------------------------------------------------------------ */
/* Mocks: in-memory IndexedDB + fake OPFS (same hermetic pattern as the  */
/* audio-fades suite, so the store persistence never touches a backend)  */
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

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const MUSIC_TRACK = 'track_music';
const VOICE_TRACK = 'track_voice';

function makeMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media_1',
    name: 'music.mp3',
    type: 'audio',
    url: 'blob:test/media_1',
    duration: 30,
    width: 0,
    height: 0,
    fps: 30,
    thumbnailUrl: '',
    size: 1024,
    createdAt: 1000,
    opfsPath: 'media_1.mp3',
    ...overrides,
  };
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip_1',
    trackId: MUSIC_TRACK,
    mediaId: 'media_1',
    name: 'Música',
    type: 'audio',
    start: 0,
    duration: 4,
    sourceStart: 0,
    sourceDuration: 30,
    volume: 1,
    opacity: 1,
    scale: 1,
    positionX: 0,
    positionY: 0,
    muted: false,
    ...overrides,
  };
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: MUSIC_TRACK,
    name: 'Música',
    type: 'audio',
    isMuted: false,
    isLocked: false,
    isVisible: true,
    ...overrides,
  };
}

const musicTrack = (): Track => makeTrack({ id: MUSIC_TRACK, name: 'Música', role: 'music' });
const voiceTrack = (): Track => makeTrack({ id: VOICE_TRACK, name: 'Voz', role: 'dialogue' });

function voiceClip(overrides: Partial<Clip> = {}): Clip {
  return makeClip({
    id: 'clip_voice',
    trackId: VOICE_TRACK,
    name: 'Voz',
    start: 2,
    duration: 4,
    ...overrides,
  });
}

function duckedMusicClip(overrides: Partial<Clip> = {}): Clip {
  return makeClip({
    id: 'clip_music',
    trackId: MUSIC_TRACK,
    name: 'Música',
    start: 0,
    duration: 10,
    audioEffects: { duck: true },
    ...overrides,
  });
}

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

beforeEach(() => {
  useProjectStore.getState().resetProject();
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreAudioEffectsSupportGlobals();
});

/* ------------------------------------------------------------------ */
/* Soporte simulado: en node no hay OfflineAudioContext/AudioContext,   */
/* así que las sondas en caché dirían "sin soporte" y el preview        */
/* degradaría mientras el export (con su contexto falso con soporte)    */
/* no lo haría. Estos helpers simulan un navegador CON soporte (como   */
/* un Chrome real, donde ambos contextos acuerdan) y lo restauran       */
/* después.                                                             */
/* ------------------------------------------------------------------ */

const REAL_OFFLINE_AUDIO_CONTEXT = (globalThis as Record<string, unknown>)
  .OfflineAudioContext;

/** Instala un navegador falso CON paneo y EQ, y rearma las sondas. */
function simulateBrowserWithAudioEffectsSupport(): void {
  class ProbeOfflineAudioContext {
    createStereoPanner(): unknown {
      return {};
    }
    createBiquadFilter(): unknown {
      return {};
    }
  }
  (globalThis as Record<string, unknown>).OfflineAudioContext = ProbeOfflineAudioContext;
  resetStereoPannerSupportCache();
  resetBiquadFilterSupportCache();
}

/** Restaura el entorno previo y rearma las sondas. */
function restoreAudioEffectsSupportGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  if (REAL_OFFLINE_AUDIO_CONTEXT === undefined) delete g.OfflineAudioContext;
  else g.OfflineAudioContext = REAL_OFFLINE_AUDIO_CONTEXT;
  resetStereoPannerSupportCache();
  resetBiquadFilterSupportCache();
}

/* ================================================================== */
/* A · Normalisation: clamp + neutral cleanup                          */
/* ================================================================== */

describe('A · normalización de los efectos', () => {
  it('[FAILS-WITHOUT-FIX] el paneo se recorta a [-1, 1] y lo no finito es el centro', () => {
    expect(clampPan(-2)).toBe(-1);
    expect(clampPan(2)).toBe(1);
    expect(clampPan(0.5)).toBe(0.5);
    expect(clampPan(Number.NaN)).toBe(0);
    expect(clampPan(undefined)).toBe(0);
  });

  it('[FAILS-WITHOUT-FIX] la EQ se recorta a [-12, +12] dB', () => {
    expect(clampEqDb(-20)).toBe(EQ_DB_MIN);
    expect(clampEqDb(20)).toBe(EQ_DB_MAX);
    expect(clampEqDb(6)).toBe(6);
    expect(clampEqDb(Number.NaN)).toBe(0);
    expect(EQ_DB_MIN).toBe(-12);
    expect(EQ_DB_MAX).toBe(12);
  });

  it('[FAILS-WITHOUT-FIX] lo neutral desaparece (el campo ni se escribe)', () => {
    expect(normalizeAudioEffects(undefined)).toBeUndefined();
    expect(normalizeAudioEffects(null)).toBeUndefined();
    expect(normalizeAudioEffects({})).toBeUndefined();
    expect(normalizeAudioEffects({ pan: 0, eq: { low: 0, mid: 0, high: 0 } })).toBeUndefined();
    expect(normalizeAudioEffects({ duck: false })).toBeUndefined();
    expect(isNeutralAudioEffects(undefined)).toBe(true);
    expect(isNeutralAudioEffects({ pan: 0 })).toBe(true);
  });

  it('[FAILS-WITHOUT-FIX] lo activo sobrevive recortado', () => {
    const fx = normalizeAudioEffects({ pan: 2, eq: { low: -20, mid: 3, high: 0 }, duck: true });
    expect(fx).toEqual({ pan: 1, eq: { low: -12, mid: 3 }, duck: true });
    expect(isNeutralAudioEffects(fx)).toBe(false);
    expect(isNeutralAudioEffects({ pan: 0.5 })).toBe(false);
    expect(isNeutralAudioEffects({ eq: { high: -1 } })).toBe(false);
    expect(isNeutralAudioEffects({ duck: true })).toBe(false);
  });

  it('la basura de un proyecto importado a mano no rompe', () => {
    expect(normalizeAudioEffects('pan' as unknown as ClipAudioEffects)).toBeUndefined();
    expect(normalizeAudioEffects({ pan: 'izq', eq: 'grave', duck: 'sí' })).toBeUndefined();
    expect(normalizeAudioEffects({ eq: { low: Number.NaN } })).toBeUndefined();
  });

  it('[FAILS-WITHOUT-FIX] hasActiveEq distingue la EQ neutra de la activa', () => {
    expect(hasActiveEq(undefined)).toBe(false);
    expect(hasActiveEq({ eq: { low: 0 } })).toBe(false);
    expect(hasActiveEq({ eq: { mid: 2 } })).toBe(true);
    expect(hasActiveEq({ pan: 1 })).toBe(false);
  });
});

/* ================================================================== */
/* B · Support detection (same pattern as ctx.filter)                  */
/* ================================================================== */

describe('B · detección de soporte del navegador', () => {
  it('[FAILS-WITHOUT-FIX] sin createStereoPanner no hay paneo (Safari antiguo)', () => {
    expect(detectStereoPannerSupport({} as unknown as AudioContext)).toBe(false);
    expect(detectStereoPannerSupport(null)).toBe(false);
    expect(detectBiquadFilterSupport({} as unknown as AudioContext)).toBe(false);
    expect(detectBiquadFilterSupport(null)).toBe(false);
  });

  it('[FAILS-WITHOUT-FIX] con los métodos de fábrica hay soporte', () => {
    const ctx = {
      createStereoPanner: () => ({}),
      createBiquadFilter: () => ({}),
    } as unknown as AudioContext;
    expect(detectStereoPannerSupport(ctx)).toBe(true);
    expect(detectBiquadFilterSupport(ctx)).toBe(true);
  });

  it('[FAILS-WITHOUT-FIX] sin soporte el paneo degrada al centro en AMBOS caminos', () => {
    const clip = makeClip({ audioEffects: { pan: -0.8 } });
    expect(resolvePan(clip.audioEffects, false)).toBe(0);
    expect(resolvePan(clip.audioEffects, true)).toBe(-0.8);
    const chain = resolveClipAudioChain(clip, { panner: false });
    expect(chain.pan).toBe(0);
    expect(chain.needsGraph).toBe(false);
  });

  it('los mensajes explican el motivo en español', () => {
    expect(STEREO_PANNER_UNSUPPORTED_MESSAGE).toMatch(/paneo/i);
    expect(STEREO_PANNER_UNSUPPORTED_MESSAGE.length).toBeGreaterThan(20);
    expect(BIQUAD_FILTER_UNSUPPORTED_MESSAGE).toMatch(/ecualizaci/i);
  });
});

/* ================================================================== */
/* C · EQ mapping: fixed bands, preview and export share the config    */
/* ================================================================== */

describe('C · la EQ son tres bandas fijas', () => {
  it('[FAILS-WITHOUT-FIX] lowshelf 320 Hz / peaking 1000 Hz Q1 / highshelf 3200 Hz', () => {
    const config = resolveEqFilterConfig({ eq: { low: -3, mid: 2, high: 4 } });
    expect(config).toEqual([
      { band: 'low', type: 'lowshelf', frequency: EQ_LOW_FREQUENCY, gain: -3 },
      { band: 'mid', type: 'peaking', frequency: EQ_MID_FREQUENCY, Q: EQ_MID_Q, gain: 2 },
      { band: 'high', type: 'highshelf', frequency: EQ_HIGH_FREQUENCY, gain: 4 },
    ]);
    expect(EQ_LOW_FREQUENCY).toBe(320);
    expect(EQ_MID_FREQUENCY).toBe(1000);
    expect(EQ_MID_Q).toBe(1);
    expect(EQ_HIGH_FREQUENCY).toBe(3200);
  });

  it('[FAILS-WITHOUT-FIX] la EQ ausente es 0 dB en las tres bandas', () => {
    expect(resolveEq(undefined)).toEqual({ low: 0, mid: 0, high: 0 });
    expect(resolveEq({})).toEqual({ low: 0, mid: 0, high: 0 });
    expect(resolveEq({ eq: { mid: 5 } })).toEqual({ low: 0, mid: 5, high: 0 });
  });
});

/* ================================================================== */
/* D · Ducking rule                                                    */
/* ================================================================== */

describe('D · la regla del ducking', () => {
  it('[FAILS-WITHOUT-FIX] la música con duck baja 8 dB mientras hay voz en otra pista', () => {
    const intervals = computeDialogueIntervals(
      [duckedMusicClip(), voiceClip()],
      [musicTrack(), voiceTrack()]
    );
    expect(intervals).toEqual([{ start: 2, end: 6, trackId: VOICE_TRACK }]);
    const full = duckFullGain();
    expect(full).toBeCloseTo(dbToGain(-8), 12);
    // Dentro de la voz: atenuación plena.
    expect(duckEnvelopeGain(3, true, MUSIC_TRACK, intervals)).toBeCloseTo(full, 9);
    // Fuera de la voz: ganancia exacta 1.
    expect(duckEnvelopeGain(0, true, MUSIC_TRACK, intervals)).toBe(1);
    expect(duckEnvelopeGain(10, true, MUSIC_TRACK, intervals)).toBe(1);
  });

  it('[FAILS-WITHOUT-FIX] el ataque y la salida son rampas lineales explícitas', () => {
    const intervals = computeDialogueIntervals(
      [duckedMusicClip(), voiceClip()],
      [musicTrack(), voiceTrack()]
    );
    const full = duckFullGain();
    const { attackSec, releaseSec } = DEFAULT_DUCK_CONFIG;
    // Mitad del ataque: punto medio entre 1 y la atenuación plena.
    expect(duckEnvelopeGain(2 - attackSec / 2, true, MUSIC_TRACK, intervals)).toBeCloseTo(
      (1 + full) / 2,
      9
    );
    // Mitad de la salida: el espejo.
    expect(duckEnvelopeGain(6 + releaseSec / 2, true, MUSIC_TRACK, intervals)).toBeCloseTo(
      (1 + full) / 2,
      9
    );
    // En los bordes exactos la rampa toca sus extremos.
    expect(duckEnvelopeGain(2, true, MUSIC_TRACK, intervals)).toBeCloseTo(full, 9);
    expect(duckEnvelopeGain(6, true, MUSIC_TRACK, intervals)).toBeCloseTo(full, 9);
  });

  it('[FAILS-WITHOUT-FIX] sin duck:true no hay atenuación aunque haya voz', () => {
    const intervals = computeDialogueIntervals(
      [makeClip({ start: 0, duration: 10 }), voiceClip()],
      [musicTrack(), voiceTrack()]
    );
    expect(duckEnvelopeGain(3, false, MUSIC_TRACK, intervals)).toBe(1);
  });

  it('[FAILS-WITHOUT-FIX] la voz de la PROPIA pista no atenúa', () => {
    // El clip con duck vive en la pista de diálogo: la voz de su misma pista
    // no lo atenúa (la música no se atenúa a sí misma).
    const ownDuck = makeClip({
      id: 'own',
      trackId: VOICE_TRACK,
      start: 0,
      duration: 10,
      audioEffects: { duck: true },
    });
    const intervals = computeDialogueIntervals([ownDuck, voiceClip()], [voiceTrack()]);
    expect(intervals.length).toBeGreaterThan(0);
    expect(duckEnvelopeGain(3, true, VOICE_TRACK, intervals)).toBe(1);
    // …pero la voz de OTRA pista de diálogo sí.
    const otherVoice = voiceClip({ id: 'v2', trackId: 'track_voice_2', start: 2, duration: 4 });
    const otherTrack = makeTrack({ id: 'track_voice_2', name: 'Voz 2', role: 'dialogue' });
    const intervals2 = computeDialogueIntervals(
      [ownDuck, otherVoice],
      [voiceTrack(), otherTrack]
    );
    expect(duckEnvelopeGain(3, true, VOICE_TRACK, intervals2)).toBeCloseTo(duckFullGain(), 9);
  });

  it('[FAILS-WITHOUT-FIX] la voz muda, silenciada o sin rol no dispara el ducking', () => {
    const base = [duckedMusicClip()];
    const tracks = [musicTrack(), voiceTrack()];
    // Voz muteada en el clip.
    expect(
      computeDialogueIntervals([...base, voiceClip({ muted: true })], tracks)
    ).toEqual([]);
    // Pista de voz muteada.
    expect(
      computeDialogueIntervals([...base, voiceClip()], [
        musicTrack(),
        { ...voiceTrack(), isMuted: true },
      ])
    ).toEqual([]);
    // Pista sin rol de diálogo (música sobre música no atenúa).
    expect(
      computeDialogueIntervals([...base, voiceClip()], [
        musicTrack(),
        { ...voiceTrack(), role: 'music' },
      ])
    ).toEqual([]);
    // Voz con volumen 0.
    expect(
      computeDialogueIntervals([...base, voiceClip({ volume: 0 })], tracks)
    ).toEqual([]);
  });

  it('[FAILS-WITHOUT-FIX] la cantidad y las rampas son configurables', () => {
    const intervals = computeDialogueIntervals(
      [duckedMusicClip(), voiceClip()],
      [musicTrack(), voiceTrack()]
    );
    const custom = { amountDb: 6, attackSec: 0.5, releaseSec: 0.5 };
    expect(normalizeDuckConfig(custom)).toEqual(custom);
    expect(normalizeDuckConfig({ amountDb: -3 })).toEqual(DEFAULT_DUCK_CONFIG);
    expect(duckEnvelopeGain(3, true, MUSIC_TRACK, intervals, custom)).toBeCloseTo(
      dbToGain(-6),
      9
    );
    // Con ataque 0.5, en 1.75 (mitad del ataque) la ganancia es el punto medio.
    expect(duckEnvelopeGain(1.75, true, MUSIC_TRACK, intervals, custom)).toBeCloseTo(
      (1 + dbToGain(-6)) / 2,
      9
    );
  });

  it('[FAILS-WITHOUT-FIX] los intervalos solapados se fusionan una sola vez', () => {
    const v1 = voiceClip({ id: 'v1', start: 2, duration: 4 });
    const v2 = voiceClip({ id: 'v2', start: 4, duration: 4, trackId: 'track_voice_2' });
    const t2 = makeTrack({ id: 'track_voice_2', name: 'Voz 2', role: 'dialogue' });
    const intervals = computeDialogueIntervals([v1, v2], [voiceTrack(), t2]);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].start).toBe(2);
    expect(intervals[0].end).toBe(8);
    // Voces de pistas distintas fusionadas: el intervalo atenúa a todas.
    expect(duckEnvelopeGain(5, true, MUSIC_TRACK, intervals)).toBeCloseTo(duckFullGain(), 9);
  });

  it('el índice en caché solo se reconstruye al cambiar el contenido', () => {
    const cache = createDuckIndexCache();
    const clips = [duckedMusicClip(), voiceClip()];
    const tracks = [musicTrack(), voiceTrack()];
    expect(refreshDuckIndex(cache, clips, tracks)).toBe(true);
    const intervalsRef = cache.intervals;
    expect(intervalsRef.length).toBe(1);
    // Misma referencia: sin reconstruir.
    expect(refreshDuckIndex(cache, clips, tracks)).toBe(false);
    expect(cache.intervals).toBe(intervalsRef);
    // Distinto array con el MISMO contenido: sin reconstruir ni asignar.
    expect(
      refreshDuckIndex(cache, [...clips], [...tracks])
    ).toBe(false);
    expect(cache.intervals).toBe(intervalsRef);
    // Cambia el rol de la pista: se reconstruye y la voz desaparece.
    const noRole = [{ ...voiceTrack(), role: undefined as never }];
    expect(refreshDuckIndex(cache, clips, [musicTrack(), ...noRole])).toBe(true);
    expect(cache.intervals).toEqual([]);
  });

  it('los roles de pista se normalizan (lo desconocido es sin rol)', () => {
    expect(normalizeTrackRole('dialogue')).toBe('dialogue');
    expect(normalizeTrackRole('music')).toBe('music');
    expect(normalizeTrackRole('sfx')).toBe('sfx');
    expect(normalizeTrackRole('voz')).toBeUndefined();
    expect(normalizeTrackRole(undefined)).toBeUndefined();
    expect(TRACK_ROLE_LABELS.dialogue).toMatch(/logo/i);
  });
});

/* ================================================================== */
/* E · Preview == export (la prueba de paridad)                        */
/* ================================================================== */

describe('E · el preview y el export derivan los mismos parámetros', () => {
  const matrix: ClipAudioEffects[] = [
    {},
    { pan: -0.6 },
    { pan: 1 },
    { eq: { low: -4, mid: 2, high: 6 } },
    { duck: true },
    { pan: 0.3, eq: { low: 3, mid: -2, high: 0 }, duck: true },
  ];

  it('[FAILS-WITHOUT-FIX] resolvePreviewAudioChain y resolveExportAudioChain acuerdan', () => {
    // Navegador con soporte (ambos contextos acuerdan, como en un Chrome real).
    simulateBrowserWithAudioEffectsSupport();
    for (const audioEffects of matrix) {
      const clip = makeClip({ audioEffects });
      for (const support of [
        { panner: true, biquad: true },
        { panner: false, biquad: true },
        { panner: true, biquad: false },
        { panner: false, biquad: false },
      ]) {
        const preview = resolvePreviewAudioChain({ ...clip });
        const exported = resolveExportAudioChain({ ...clip });
        // Ambas pasan por `resolveClipAudioChain` sin soporte forzado: el
        // resultado por defecto es idéntico…
        expect(exported).toEqual(preview);
        // …y con el mismo soporte explícito también.
        expect(resolveExportAudioChain(clip, support)).toEqual(
          resolveClipAudioChain(clip, support)
        );
      }
    }
  });

  it('[FAILS-WITHOUT-FIX] la automatización del export acuerda con el preview en todo instante', () => {
    const music = duckedMusicClip();
    const voice = voiceClip();
    const intervals = computeDialogueIntervals([music, voice], [musicTrack(), voiceTrack()]);
    const events = buildDuckAutomation(music, intervals);
    expect(events.length).toBeGreaterThan(4);
    expect(events[0].type).toBe('set');
    // Barrido fino del clip (dentro y fuera de la voz, bordes incluidos).
    for (let i = 0; i <= 120; i++) {
      const t = (10 * i) / 120;
      const preview = duckEnvelopeGain(t, true, MUSIC_TRACK, intervals);
      const exported = evaluateDuckAutomation(events, t);
      expect(exported).toBeCloseTo(preview, 3);
    }
  });

  it('[FAILS-WITHOUT-FIX] sin voz que toque el clip no hay eventos (camino intacto)', () => {
    const music = duckedMusicClip({ start: 20, duration: 4 });
    const intervals = computeDialogueIntervals([music, voiceClip()], [musicTrack(), voiceTrack()]);
    expect(buildDuckAutomation(music, intervals)).toEqual([]);
    expect(buildDuckAutomation(makeClip(), intervals)).toEqual([]);
    expect(buildDuckAutomation(music, [])).toEqual([]);
    expect(evaluateDuckAutomation([], 3)).toBe(1);
  });
});

/* ================================================================== */
/* F · Preview: AudioEngine aplica pan / EQ / ducking por frame        */
/* ================================================================== */

interface FakeAudioParam {
  value: number;
}
interface FakeGainNode {
  gain: FakeAudioParam;
  connect: () => void;
}
interface FakeBiquadNode {
  type: string;
  frequency: FakeAudioParam;
  Q: FakeAudioParam;
  gain: FakeAudioParam;
  connect: () => void;
}
interface FakePannerNode {
  pan: FakeAudioParam;
  connect: () => void;
}
interface FakeOfflineGraph {
  biquads: FakeBiquadNode[];
  panners: FakePannerNode[];
  gains: FakeGainNode[];
}

function installFakeAudioContext(graph: FakeOfflineGraph) {
  const ctx = {
    state: 'running' as const,
    destination: {},
    createMediaElementSource: (_el: unknown) => ({ connect: () => {} }),
    createGain: () => {
      const node: FakeGainNode = { gain: { value: 1 }, connect: () => {} };
      graph.gains.push(node);
      return node;
    },
    createBiquadFilter: () => {
      const node: FakeBiquadNode = {
        type: '',
        frequency: { value: 0 },
        Q: { value: 0 },
        gain: { value: 0 },
        connect: () => {},
      };
      graph.biquads.push(node);
      return node;
    },
    createStereoPanner: () => {
      const node: FakePannerNode = { pan: { value: 0 }, connect: () => {} };
      graph.panners.push(node);
      return node;
    },
    resume: () => Promise.resolve(),
  };
  return ctx;
}

function pannedPreview(pan: number) {
  const graph: FakeOfflineGraph = { biquads: [], panners: [], gains: [] };
  const ctx = installFakeAudioContext(graph);
  vi.spyOn(masterClock, 'getAudioContext').mockReturnValue(ctx as unknown as AudioContext);
  const element = new FakeAudioElement();
  vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(
    element as unknown as HTMLAudioElement
  );
  const engine = new AudioEngine();
  const clip = makeClip({ audioEffects: { pan } });
  const media = [makeMedia({ type: 'audio', duration: 30 })];
  return { element, engine, clip, media, graph, ctx };
}

describe('F · el preview aplica los efectos por frame', () => {
  it('[FAILS-WITHOUT-FIX] el paneo llega al StereoPannerNode', () => {
    simulateBrowserWithAudioEffectsSupport();
    const { engine, clip, media, graph } = pannedPreview(-0.5);
    engine.updateAudio(1, true, [musicTrack()], [clip], media);
    expect(graph.panners.length).toBe(1);
    expect(graph.panners[0].pan.value).toBeCloseTo(-0.5, 6);
    // El volumen del elemento sigue siendo la vía de ≤100 %.
    engine.updateAudio(2, true, [musicTrack()], [clip], media);
    expect(graph.panners[0].pan.value).toBeCloseTo(-0.5, 6);
  });

  it('[FAILS-WITHOUT-FIX] la EQ programa los tres biquads con las bandas fijas', () => {
    simulateBrowserWithAudioEffectsSupport();
    const graph: FakeOfflineGraph = { biquads: [], panners: [], gains: [] };
    const ctx = installFakeAudioContext(graph);
    vi.spyOn(masterClock, 'getAudioContext').mockReturnValue(ctx as unknown as AudioContext);
    const element = new FakeAudioElement();
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(
      element as unknown as HTMLAudioElement
    );
    const engine = new AudioEngine();
    const clip = makeClip({ audioEffects: { eq: { low: -3, mid: 2, high: 4 } } });
    const media = [makeMedia({ type: 'audio', duration: 30 })];
    engine.updateAudio(1, true, [musicTrack()], [clip], media);
    expect(graph.biquads.length).toBe(3);
    expect(graph.biquads[0].type).toBe('lowshelf');
    expect(graph.biquads[0].frequency.value).toBe(320);
    expect(graph.biquads[0].gain.value).toBeCloseTo(-3, 6);
    expect(graph.biquads[1].type).toBe('peaking');
    expect(graph.biquads[1].Q.value).toBe(1);
    expect(graph.biquads[1].gain.value).toBeCloseTo(2, 6);
    expect(graph.biquads[2].type).toBe('highshelf');
    expect(graph.biquads[2].frequency.value).toBe(3200);
    expect(graph.biquads[2].gain.value).toBeCloseTo(4, 6);
  });

  it('[FAILS-WITHOUT-FIX] el ducking multiplica el volumen del elemento', () => {
    simulateBrowserWithAudioEffectsSupport();
    const graph: FakeOfflineGraph = { biquads: [], panners: [], gains: [] };
    const ctx = installFakeAudioContext(graph);
    vi.spyOn(masterClock, 'getAudioContext').mockReturnValue(ctx as unknown as AudioContext);
    // Un elemento POR CLIP: los dos clips suenan a la vez y cada uno escribe
    // su propio volumen (con un solo elemento el último en procesarse ganaría).
    const musicElement = new FakeAudioElement();
    const voiceElement = new FakeAudioElement();
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockImplementation(
      (_media: MediaItem, clipId?: string) =>
        (clipId === 'clip_music' ? musicElement : voiceElement) as unknown as HTMLAudioElement
    );
    const engine = new AudioEngine();
    const music = duckedMusicClip({ volume: 0.8 });
    const voice = voiceClip();
    const media = [makeMedia({ type: 'audio', duration: 30 })];
    const tracks = [musicTrack(), voiceTrack()];
    // Dentro de la voz: 0.8 × duck(−8 dB).
    engine.updateAudio(3, true, tracks, [music, voice], media);
    expect(musicElement.volume).toBeCloseTo(0.8 * duckFullGain(), 3);
    // La voz no se atenúa a sí misma.
    expect(voiceElement.volume).toBeCloseTo(1, 6);
    // Fuera de la voz: el volumen intacto.
    engine.updateAudio(0.5, true, tracks, [music, voice], media);
    expect(musicElement.volume).toBeCloseTo(0.8, 3);
  });

  it('[FAILS-WITHOUT-FIX] sin soporte de paneo el clip suena en el centro', () => {
    simulateBrowserWithAudioEffectsSupport();
    const graph: FakeOfflineGraph = { biquads: [], panners: [], gains: [] };
    const ctx = installFakeAudioContext(graph);
    // Safari antiguo: sin createStereoPanner.
    delete (ctx as unknown as Record<string, unknown>).createStereoPanner;
    vi.spyOn(masterClock, 'getAudioContext').mockReturnValue(ctx as unknown as AudioContext);
    const element = new FakeAudioElement();
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(
      element as unknown as HTMLAudioElement
    );
    const engine = new AudioEngine();
    const clip = makeClip({ audioEffects: { pan: 1 } });
    const media = [makeMedia({ type: 'audio', duration: 30 })];
    engine.updateAudio(1, true, [musicTrack()], [clip], media);
    // Degrada a "sin paneo": ni siquiera se crea el nodo…
    expect(graph.panners.length).toBe(0);
    // …pero el clip sigue sonando.
    expect(element.volume).toBeCloseTo(1, 6);
  });
});

/* ================================================================== */
/* G · Export: renderOfflineAudio cablea pan / EQ / ducking            */
/* ================================================================== */

interface RecordedGain {
  events: Array<{ type: 'set' | 'linearRamp'; time: number; value: number }>;
}
interface RecordedFilter {
  type: string;
  frequency: number;
  Q: number;
  gain: number;
}
interface RecordedPanner {
  pan: number;
}

function installOfflineAudioFakes(state: {
  starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
  gains: RecordedGain[];
  filters: RecordedFilter[];
  panners: RecordedPanner[];
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
        detune: { value: 0, setValueAtTime: (_v: number, _t: number) => {} },
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

  // Los nodos falsos exponen `type`/`frequency`/`gain`/`pan` como propiedades
  // planas: el código de producción escribe `.value`, así que se intercepta
  // con un Proxy que registra cada escritura en el objeto grabado.
  const OriginalFake = FakeOfflineAudioContext;
  class RecordingFake extends OriginalFake {
    createBiquadFilter() {
      const recorded: RecordedFilter = { type: '', frequency: 0, Q: 0, gain: 0 };
      state.filters.push(recorded);
      const param = (set: (v: number) => void, get: () => number) => ({
        get value() {
          return get();
        },
        set value(v: number) {
          set(v);
        },
        setValueAtTime: () => {},
      });
      let type = '';
      const node = {
        get type() {
          return type;
        },
        set type(v: string) {
          type = v;
          recorded.type = v;
        },
        frequency: param(
          (v) => (recorded.frequency = v),
          () => recorded.frequency
        ),
        Q: param(
          (v) => (recorded.Q = v),
          () => recorded.Q
        ),
        gain: param(
          (v) => (recorded.gain = v),
          () => recorded.gain
        ),
        connect: () => {},
      };
      return node;
    }
    createStereoPanner() {
      const recorded: RecordedPanner = { pan: 0 };
      state.panners.push(recorded);
      return {
        pan: {
          get value() {
            return recorded.pan;
          },
          set value(v: number) {
            recorded.pan = v;
          },
          setValueAtTime: () => {},
        },
        connect: () => {},
      };
    }
  }

  (globalThis as Record<string, unknown>).OfflineAudioContext = RecordingFake;
  // La sonda en caché debe ver el contexto falso (que SÍ soporta paneo y EQ,
  // como un navegador real): si quedó un "sin soporte" de otro test, el
  // preview degradaría mientras el export no lo haría.
  resetStereoPannerSupportCache();
  resetBiquadFilterSupportCache();
}

describe('G · renderOfflineAudio aplica los mismos efectos que el preview', () => {
  it('[FAILS-WITHOUT-FIX] el paneo del export es el del preview', async () => {
    const state: {
      starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
      gains: RecordedGain[];
      filters: RecordedFilter[];
      panners: RecordedPanner[];
    } = { starts: [], gains: [], filters: [], panners: [] };
    installOfflineAudioFakes(state);

    const clip = makeClip({ id: 'pan', start: 1, duration: 4, audioEffects: { pan: -0.5 } });
    const rendered = await renderOfflineAudio(8, [musicTrack()], [clip], [makeMedia()]);
    expect(rendered).not.toBeNull();
    expect(state.starts.length).toBe(1);
    // Un solo nodo de paneo con EL MISMO valor que deriva el preview.
    expect(state.panners.length).toBe(1);
    const preview = resolvePreviewAudioChain(clip);
    expect(state.panners[0].pan).toBeCloseTo(preview.pan, 9);
    expect(state.panners[0].pan).toBeCloseTo(-0.5, 9);
  });

  it('[FAILS-WITHOUT-FIX] la EQ del export son los tres biquads del preview', async () => {
    const state: {
      starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
      gains: RecordedGain[];
      filters: RecordedFilter[];
      panners: RecordedPanner[];
    } = { starts: [], gains: [], filters: [], panners: [] };
    installOfflineAudioFakes(state);

    const clip = makeClip({
      id: 'eq',
      start: 1,
      duration: 4,
      audioEffects: { eq: { low: -3, mid: 2, high: 4 } },
    });
    const rendered = await renderOfflineAudio(8, [musicTrack()], [clip], [makeMedia()]);
    expect(rendered).not.toBeNull();
    expect(state.filters.length).toBe(3);
    const preview = resolvePreviewAudioChain(clip);
    expect(state.filters[0]).toMatchObject({ type: 'lowshelf', frequency: 320, gain: -3 });
    expect(state.filters[1]).toMatchObject({ type: 'peaking', frequency: 1000, gain: 2 });
    expect(state.filters[2]).toMatchObject({ type: 'highshelf', frequency: 3200, gain: 4 });
    expect(state.filters[0].gain).toBe(preview.eq.low);
    expect(state.filters[1].gain).toBe(preview.eq.mid);
    expect(state.filters[2].gain).toBe(preview.eq.high);
  });

  it('[FAILS-WITHOUT-FIX] el ducking del export acuerda con el preview en el punto medio', async () => {
    const state: {
      starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
      gains: RecordedGain[];
      filters: RecordedFilter[];
      panners: RecordedPanner[];
    } = { starts: [], gains: [], filters: [], panners: [] };
    installOfflineAudioFakes(state);

    const music = duckedMusicClip({ start: 0, duration: 10 });
    const voice = voiceClip();
    const rendered = await renderOfflineAudio(
      12,
      [musicTrack(), voiceTrack()],
      [music, voice],
      [makeMedia()]
    );
    expect(rendered).not.toBeNull();
    // La música se procesa primero: volumen + ducking. La voz va después con
    // un solo nodo, así que el nodo de ducking es el segundo.
    expect(state.gains.length).toBe(3);
    const duckNode = state.gains[1];
    expect(duckNode.events.length).toBeGreaterThan(2);
    const intervals = computeDialogueIntervals([music, voice], [musicTrack(), voiceTrack()]);
    // Dentro de la voz la envolvente programada es la del preview…
    expect(evaluateDuckAutomation(duckNode.events, 3)).toBeCloseTo(
      duckEnvelopeGain(3, true, MUSIC_TRACK, intervals),
      3
    );
    // …y fuera de la voz es exactamente 1.
    expect(evaluateDuckAutomation(duckNode.events, 0.5)).toBe(1);
  });

  it('[FAILS-WITHOUT-FIX] un clip SIN efectos mantiene el camino histórico intacto', async () => {
    const state: {
      starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
      gains: RecordedGain[];
      filters: RecordedFilter[];
      panners: RecordedPanner[];
    } = { starts: [], gains: [], filters: [], panners: [] };
    installOfflineAudioFakes(state);

    const clip = makeClip({ id: 'plain', start: 1, duration: 4 });
    const rendered = await renderOfflineAudio(8, [musicTrack()], [clip], [makeMedia()]);
    expect(rendered).not.toBeNull();
    expect(state.starts.length).toBe(1);
    // Ni paneo, ni EQ, ni ducking: los nodos de siempre y nada más.
    expect(state.gains.length).toBe(1);
    expect(state.gains[0].events).toEqual([{ type: 'set', time: 1, value: 1 }]);
    expect(state.filters.length).toBe(0);
    expect(state.panners.length).toBe(0);
  });
});

/* ================================================================== */
/* H · Store: settable, undoable, normalised                           */
/* ================================================================== */

describe('H · el store guarda, deshace y normaliza los efectos', () => {
  function addMusicClip() {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ id: 'clip_music', name: 'Música' }));
    return 'clip_music';
  }

  it('[FAILS-WITHOUT-FIX] setClipAudioEffects guarda y es deshacible y rehacible', () => {
    const id = addMusicClip();
    const store = useProjectStore.getState();
    const result = store.setClipAudioEffects(id, {
      pan: -0.5,
      eq: { low: 3 },
      duck: true,
    });
    expect(result.ok).toBe(true);

    const saved = useProjectStore.getState().project.clips.find((c) => c.id === id);
    expect(saved?.audioEffects).toEqual({ pan: -0.5, eq: { low: 3 }, duck: true });

    useProjectStore.getState().undo();
    const undone = useProjectStore.getState().project.clips.find((c) => c.id === id);
    expect(undone?.audioEffects).toBeUndefined();

    useProjectStore.getState().redo();
    const redone = useProjectStore.getState().project.clips.find((c) => c.id === id);
    expect(redone?.audioEffects).toEqual({ pan: -0.5, eq: { low: 3 }, duck: true });
  });

  it('[FAILS-WITHOUT-FIX] updateClip directo recorta y limpia lo neutral', () => {
    const id = addMusicClip();
    useProjectStore.getState().updateClip(id, {
      audioEffects: { pan: 5, eq: { low: -30, mid: 0 }, duck: false },
    });
    const saved = useProjectStore.getState().project.clips.find((c) => c.id === id);
    expect(saved?.audioEffects).toEqual({ pan: 1, eq: { low: -12 } });

    // Todo neutral: el campo desaparece en vez de guardar peso muerto.
    useProjectStore.getState().updateClip(id, {
      audioEffects: { pan: 0, eq: { low: 0 }, duck: false },
    });
    const cleaned = useProjectStore.getState().project.clips.find((c) => c.id === id);
    expect(cleaned?.audioEffects).toBeUndefined();
  });

  it('setClipAudioEffects rechaza con motivo: clip inexistente o sin audio', () => {
    const store = useProjectStore.getState();
    const missing = store.setClipAudioEffects('no_existe', { pan: 0.5 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/clip/i);

    store.addClip(
      makeClip({ id: 'clip_text', name: 'Título', type: 'text', trackId: 'track_text_1', mediaId: '' })
    );
    const textResult = store.setClipAudioEffects('clip_text', { pan: 0.5 });
    expect(textResult.ok).toBe(false);
    if (!textResult.ok) expect(textResult.reason).toMatch(/audio/);
  });

  it('[FAILS-WITHOUT-FIX] setTrackRole marca la pista y es deshacible', () => {
    const store = useProjectStore.getState();
    const trackId = store.project.tracks.find((t) => t.type === 'audio')?.id;
    expect(trackId).toBeDefined();
    expect(store.setTrackRole(trackId!, 'dialogue')).toBe(true);
    expect(
      useProjectStore.getState().project.tracks.find((t) => t.id === trackId)?.role
    ).toBe('dialogue');

    useProjectStore.getState().undo();
    expect(
      useProjectStore.getState().project.tracks.find((t) => t.id === trackId)?.role
    ).toBeUndefined();

    useProjectStore.getState().redo();
    expect(
      useProjectStore.getState().project.tracks.find((t) => t.id === trackId)?.role
    ).toBe('dialogue');

    // Limpiar el rol quita el campo.
    expect(store.setTrackRole(trackId!, undefined)).toBe(true);
    expect(
      useProjectStore.getState().project.tracks.find((t) => t.id === trackId)
    ).not.toHaveProperty('role');
    expect(store.setTrackRole('no_existe', 'dialogue')).toBe(false);
  });

  it('[FAILS-WITHOUT-FIX] el rol diálogo activa el ducking de extremo a extremo', () => {
    const store = useProjectStore.getState();
    const audioTrackId = store.project.tracks.find((t) => t.type === 'audio')!.id;
    store.addTrack('audio', 'Voz');
    // OJO: `store` es la foto anterior a `addTrack` (zustand devuelve fotos
    // inmutables): la pista nueva se lee del estado FRESCO, no del viejo.
    const voiceTrackId = useProjectStore.getState().project.tracks[
      useProjectStore.getState().project.tracks.length - 1
    ].id;
    store.addClip(makeClip({ id: 'm', trackId: audioTrackId, start: 0, duration: 10 }));
    store.addClip(
      makeClip({ id: 'v', trackId: voiceTrackId, start: 2, duration: 4, name: 'Voz' })
    );
    store.setClipAudioEffects('m', { duck: true });
    // Sin rol todavía: no hay voz que dispare.
    let intervals = computeDialogueIntervals(
      useProjectStore.getState().project.clips,
      useProjectStore.getState().project.tracks
    );
    expect(intervals).toEqual([]);
    // Al marcar la pista como diálogo, la envolvente atenúa.
    store.setTrackRole(voiceTrackId, 'dialogue');
    intervals = computeDialogueIntervals(
      useProjectStore.getState().project.clips,
      useProjectStore.getState().project.tracks
    );
    expect(intervals).toHaveLength(1);
    expect(duckEnvelopeGain(3, true, audioTrackId, intervals)).toBeCloseTo(duckFullGain(), 9);
  });
});
