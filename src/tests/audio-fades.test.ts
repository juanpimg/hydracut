/**
 * Regression suite for per-clip audio fades (fade in / fade out).
 *
 * A clip could be turned up and down, but its volume could never be RAMPED:
 * a music bed fading in at the start and out at the end was impossible (the
 * volume was a single constant applied identically for the whole clip).
 *
 * The single source of truth is `src/core/utils/audioFades.ts`:
 * - `audioFadeEnvelopeGain` / `previewClipFadeGain` (hot path, zero
 *   allocations) evaluated per frame by `AudioEngine`,
 * - `buildAudioFadeAutomation` (cold path) programmed into the dedicated
 *   offline `GainNode` by `renderOfflineAudio`,
 * - `clampClipAudioFades` (cold path) enforced on every write by the store,
 * - the Inspector edits through `updateClip` / `setAudioFade`.
 *
 * Curves: `linear` (`g(p) = p`) and `equalPower` (`g(p) = sin(p·π/2)`,
 * the DEFAULT: constant power along the ramp, no mid-fade loudness dip).
 *
 * Every suite below exercises PRODUCTION code. Suites marked
 * [FAILS-WITHOUT-FIX] assert behaviour that only exists after the change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  AUDIO_FADE_AUTOMATION_SEGMENTS,
  DEFAULT_AUDIO_FADE_CURVE,
  audioFadeCurveGain,
  audioFadeEnvelopeGain,
  buildAudioFadeAutomation,
  clampAudioFadeDuration,
  clampClipAudioFades,
  fadeDurationScale,
  normalizeAudioFadeCurve,
  previewClipFadeGain,
  quantizeAudioFadeDuration,
  type AudioFadeGainEvent,
} from '../core/utils/audioFades';
import { useProjectStore } from '../store/useProjectStore';
import { AudioEngine } from '../core/engine/AudioEngine';
import { mediaSourcePool } from '../core/engine/MediaSourcePool';
import { renderOfflineAudio } from '../core/export/webcodecsExporter';
import type { Clip, MediaItem, Track } from '../types/project';

/* ------------------------------------------------------------------ */
/* Mocks: in-memory IndexedDB + fake OPFS (same hermetic pattern as the  */
/* crossfade suite, so the store persistence never touches a backend)    */
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

const AUDIO_TRACK = 'track_audio_1';

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
    trackId: AUDIO_TRACK,
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

const audioTrack: Track = {
  id: AUDIO_TRACK,
  name: 'Audio A1',
  type: 'audio',
  isMuted: false,
  isLocked: false,
  isVisible: true,
};

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

/**
 * Models the Web Audio automation semantics (a `set` jumps, a `linearRamp`
 * interpolates from the previous event) so the envelope PROGRAMMED by the
 * export can be evaluated at any instant and compared with the envelope the
 * preview evaluates per frame. This is the platform semantics, not a copy of
 * the production envelope: the production values come from
 * `buildAudioFadeAutomation` itself.
 */
function evaluateExportedEnvelope(events: AudioFadeGainEvent[], t: number): number {
  if (events.length === 0) return 1;
  let prevTime = events[0].time;
  let prevValue = events[0].value;
  if (t <= prevTime) return prevValue;
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    if (t <= e.time) {
      if (e.type === 'set' || e.time === prevTime) return e.value;
      const p = (t - prevTime) / (e.time - prevTime);
      return prevValue + (e.value - prevValue) * p;
    }
    prevTime = e.time;
    prevValue = e.value;
  }
  return prevValue;
}

beforeEach(() => {
  useProjectStore.getState().resetProject();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ================================================================== */
/* A · Curve equations                                                 */
/* ================================================================== */

describe('A · las curvas del fundido', () => {
  it('[FAILS-WITHOUT-FIX] linear: la rampa es p (entrada) y su espejo (salida)', () => {
    expect(audioFadeCurveGain(0, 'linear')).toBe(0);
    expect(audioFadeCurveGain(0.5, 'linear')).toBeCloseTo(0.5, 9);
    expect(audioFadeCurveGain(1, 'linear')).toBe(1);
    // La salida usa el progreso espejado: misma función, (1 - p).
    expect(audioFadeCurveGain(1 - 0.25, 'linear')).toBeCloseTo(0.75, 9);
  });

  it('[FAILS-WITHOUT-FIX] equalPower: sin(p·π/2), en el punto medio √2/2', () => {
    expect(audioFadeCurveGain(0, 'equalPower')).toBe(0);
    expect(audioFadeCurveGain(0.5, 'equalPower')).toBeCloseTo(Math.SQRT1_2, 9);
    expect(audioFadeCurveGain(1, 'equalPower')).toBeCloseTo(1, 9);
    // Potencia constante: sin² + cos² = 1 en todo punto.
    for (const p of [0.1, 0.25, 0.4, 0.6, 0.9]) {
      const power =
        audioFadeCurveGain(p, 'equalPower') ** 2 + audioFadeCurveGain(1 - p, 'equalPower') ** 2;
      expect(power).toBeCloseTo(1, 9);
    }
    // El lineal SÍ tiene bache (0.5² + 0.5² = 0.5): por eso no es el defecto.
    expect(audioFadeCurveGain(0.5, 'linear') ** 2 + audioFadeCurveGain(0.5, 'linear') ** 2).toBeCloseTo(
      0.5,
      9
    );
  });

  it('el defecto es equalPower (curva ausente o desconocida)', () => {
    expect(DEFAULT_AUDIO_FADE_CURVE).toBe('equalPower');
    expect(normalizeAudioFadeCurve(undefined)).toBe('equalPower');
    expect(normalizeAudioFadeCurve('linear')).toBe('linear');
    // Basura de un proyecto importado a mano vuelve al defecto, no rompe.
    expect(
      normalizeAudioFadeCurve('logarithmic' as unknown as 'linear')
    ).toBe('equalPower');
  });

  it('el progreso se recorta a [0, 1] (NaN incluido)', () => {
    expect(audioFadeCurveGain(-2, 'linear')).toBe(0);
    expect(audioFadeCurveGain(3, 'equalPower')).toBeCloseTo(1, 9);
    expect(audioFadeCurveGain(Number.NaN, 'linear')).toBe(0);
  });
});

/* ================================================================== */
/* B · Envelope evaluation (preview scalar path)                       */
/* ================================================================== */

describe('B · la envolvente del preview', () => {
  it('[FAILS-WITHOUT-FIX] un clip con fundido de entrada arranca en silencio y llega al nivel', () => {
    const clip = makeClip({ audioFadeIn: { duration: 2 } });
    expect(previewClipFadeGain(clip, 0)).toBe(0);
    // Curva por defecto (potencia igual): el punto medio es √2/2, no 0.5.
    expect(previewClipFadeGain(clip, 1)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(previewClipFadeGain(clip, 2)).toBe(1);
    expect(previewClipFadeGain(clip, 3)).toBe(1);
  });

  it('[FAILS-WITHOUT-FIX] un clip con fundido de salida termina en silencio', () => {
    const clip = makeClip({ start: 10, duration: 4, audioFadeOut: { duration: 1, curve: 'linear' } });
    expect(previewClipFadeGain(clip, 10)).toBe(1);
    expect(previewClipFadeGain(clip, 13.5)).toBeCloseTo(0.5, 9);
    expect(previewClipFadeGain(clip, 14)).toBe(0);
  });

  it('fuera del clip y fuera de las regiones la ganancia es 1', () => {
    const clip = makeClip({ audioFadeIn: { duration: 1 }, audioFadeOut: { duration: 1 } });
    expect(previewClipFadeGain(clip, -0.5)).toBe(1);
    expect(previewClipFadeGain(clip, 4.5)).toBe(1);
    expect(previewClipFadeGain(clip, 2)).toBe(1);
  });

  it('[FAILS-WITHOUT-FIX] el fundido no puede superar el clip (recorte en lectura)', () => {
    // Fundido de 5 s en un clip de 2 s: la región efectiva es el clip entero.
    const clip = makeClip({ duration: 2, audioFadeIn: { duration: 5 } });
    expect(previewClipFadeGain(clip, 0)).toBe(0);
    expect(previewClipFadeGain(clip, 1)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(previewClipFadeGain(clip, 2)).toBe(1);
  });

  it('[FAILS-WITHOUT-FIX] entrada + salida que superan el clip se encogen en proporción', () => {
    // Clip de 4 s con 3 s + 3 s: efectivo 2 s + 2 s, el encuentro queda en 2.
    const clip = makeClip({
      duration: 4,
      audioFadeIn: { duration: 3, curve: 'linear' },
      audioFadeOut: { duration: 3, curve: 'linear' },
    });
    expect(fadeDurationScale(3, 3, 4)).toBeCloseTo(4 / 6, 12);
    expect(previewClipFadeGain(clip, 0)).toBe(0);
    expect(previewClipFadeGain(clip, 2)).toBe(1);
    expect(previewClipFadeGain(clip, 4)).toBe(0);
    expect(previewClipFadeGain(clip, 1)).toBeCloseTo(0.5, 9);
    expect(previewClipFadeGain(clip, 3)).toBeCloseTo(0.5, 9);
  });

  it('duraciones no útiles no atenúan nunca', () => {
    const clip = makeClip({
      audioFadeIn: { duration: 0 },
      audioFadeOut: { duration: Number.NaN },
    });
    for (const t of [0, 1, 2, 3.99]) {
      expect(previewClipFadeGain(clip, t)).toBe(1);
    }
    expect(audioFadeEnvelopeGain(1, 0, 1, 'linear', 1, 'linear')).toBe(1);
    expect(audioFadeEnvelopeGain(Number.NaN, 4, 1, 'linear', 0, 'linear')).toBe(1);
  });

  it('sin fundidos la ganancia es exactamente 1', () => {
    const clip = makeClip();
    for (const t of [0, 1.7, 3.99]) {
      expect(previewClipFadeGain(clip, t)).toBe(1);
    }
  });
});

/* ================================================================== */
/* C · Write path: frame quantisation + clamping                       */
/* ================================================================== */

describe('C · la escritura cuantiza a frames y recorta al clip', () => {
  it('cuantiza al frame del proyecto', () => {
    expect(quantizeAudioFadeDuration(0.5, 30)).toBe(0.5);
    // 0.05 s a 30 fps cae entre frames: redondea al más cercano (2/30).
    expect(quantizeAudioFadeDuration(0.05, 30)).toBeCloseTo(2 / 30, 12);
    expect(quantizeAudioFadeDuration(0.5, 60)).toBe(0.5);
    expect(quantizeAudioFadeDuration(Number.NaN, 30)).toBe(0);
    expect(quantizeAudioFadeDuration(-1, 30)).toBe(0);
  });

  it('[FAILS-WITHOUT-FIX] recorta al clip con motivo en español', () => {
    expect(clampAudioFadeDuration(5, 2, 30)).toBe(2);
    const clamped = clampClipAudioFades({ duration: 5 }, undefined, 2, 30);
    expect(clamped.fadeIn?.duration).toBe(2);
    expect(clamped.clamped).toBe(true);
    expect(typeof clamped.reason).toBe('string');
    expect(clamped.reason!.length).toBeGreaterThan(0);
  });

  it('una duración inválida elimina ese fundido con motivo', () => {
    const bad = clampClipAudioFades({ duration: -1 }, { duration: 1 }, 4, 30);
    expect(bad.fadeIn).toBeUndefined();
    expect(bad.fadeOut?.duration).toBe(1);
    expect(bad.clamped).toBe(true);
    expect(bad.reason).toMatch(/entrada/);
  });

  it('una curva desconocida vuelve al defecto con motivo', () => {
    const fixed = clampClipAudioFades(
      { duration: 1, curve: 'logarithmic' as unknown as 'linear' },
      undefined,
      4,
      30
    );
    expect(fixed.fadeIn?.curve).toBe('equalPower');
    expect(fixed.clamped).toBe(true);
    expect(fixed.reason).toMatch(/curva/);
  });

  it('ausencia de fundidos no es un recorte (limpiar no avisa)', () => {
    const empty = clampClipAudioFades(undefined, undefined, 4, 30);
    expect(empty.fadeIn).toBeUndefined();
    expect(empty.fadeOut).toBeUndefined();
    expect(empty.clamped).toBe(false);
    expect(empty.reason).toBeNull();
  });

  it('entrada + salida que superan el clip se encogen en proporción con motivo', () => {
    const both = clampClipAudioFades({ duration: 3 }, { duration: 3 }, 4, 30);
    expect(both.clamped).toBe(true);
    expect(both.reason).toMatch(/proporci/);
    const total = (both.fadeIn?.duration ?? 0) + (both.fadeOut?.duration ?? 0);
    expect(total).toBeLessThanOrEqual(4 + 1e-9);
    expect(both.fadeIn?.duration).toBeCloseTo(2, 6);
    expect(both.fadeOut?.duration).toBeCloseTo(2, 6);
  });
});

/* ================================================================== */
/* D · Store: settable, undoable, clamped                              */
/* ================================================================== */

describe('D · el store guarda, deshace y recorta los fundidos', () => {
  function addMusicClip() {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ id: 'clip_music', name: 'Música' }));
    return 'clip_music';
  }

  it('[FAILS-WITHOUT-FIX] setAudioFade guarda y es deshacible y rehacible', () => {
    const id = addMusicClip();
    const store = useProjectStore.getState();
    const result = store.setAudioFade(id, {
      fadeIn: { duration: 1 },
      fadeOut: { duration: 2, curve: 'linear' },
    });
    expect(result.ok).toBe(true);

    const saved = useProjectStore.getState().project.clips.find((c) => c.id === id);
    expect(saved?.audioFadeIn?.duration).toBeCloseTo(1, 6);
    expect(saved?.audioFadeOut).toMatchObject({ duration: 2, curve: 'linear' });

    useProjectStore.getState().undo();
    const undone = useProjectStore.getState().project.clips.find((c) => c.id === id);
    expect(undone?.audioFadeIn).toBeUndefined();
    expect(undone?.audioFadeOut).toBeUndefined();

    useProjectStore.getState().redo();
    const redone = useProjectStore.getState().project.clips.find((c) => c.id === id);
    expect(redone?.audioFadeIn?.duration).toBeCloseTo(1, 6);
  });

  it('[FAILS-WITHOUT-FIX] setAudioFade recorta un fundido más largo que el clip y lo explica', () => {
    const id = addMusicClip();
    const store = useProjectStore.getState();
    const result = store.setAudioFade(id, { fadeIn: { duration: 10 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clamped).toBe(true);
      expect(result.reason).toMatch(/clip/);
    }
    const saved = useProjectStore.getState().project.clips.find((c) => c.id === id);
    // El clip dura 4 s: el fundido no puede superarlo.
    expect(saved?.audioFadeIn?.duration).toBeLessThanOrEqual(4);
    expect(useProjectStore.getState().lastError).toMatch(/clip/);
  });

  it('setAudioFade rechaza con motivo: clip inexistente, clip sin audio, sin lados', () => {
    const store = useProjectStore.getState();
    expect(store.setAudioFade('no_existe', { fadeIn: { duration: 1 } }).ok).toBe(false);

    store.addClip(
      makeClip({ id: 'clip_text', name: 'Título', type: 'text', trackId: 'track_text_1', mediaId: '' })
    );
    const textResult = store.setAudioFade('clip_text', { fadeIn: { duration: 1 } });
    expect(textResult.ok).toBe(false);
    if (!textResult.ok) expect(textResult.reason).toMatch(/audio/);

    const id = addMusicClip();
    const emptyResult = store.setAudioFade(id, {});
    expect(emptyResult.ok).toBe(false);
  });

  it('setAudioFade deja intacto el lado no mencionado', () => {
    const id = addMusicClip();
    const store = useProjectStore.getState();
    store.setAudioFade(id, { fadeIn: { duration: 1 }, fadeOut: { duration: 1 } });
    store.setAudioFade(id, { fadeIn: { duration: 2 } });
    const saved = useProjectStore.getState().project.clips.find((c) => c.id === id);
    expect(saved?.audioFadeIn?.duration).toBeCloseTo(2, 6);
    expect(saved?.audioFadeOut?.duration).toBeCloseTo(1, 6);
  });

  it('dos ajustes seguidos comparten una entrada de historial (coalescencia 400 ms)', () => {
    const id = addMusicClip();
    const pastBefore = useProjectStore.getState().past.length;
    const store = useProjectStore.getState();
    store.setAudioFade(id, { fadeIn: { duration: 0.5 } });
    store.setAudioFade(id, { fadeIn: { duration: 1 } });
    expect(useProjectStore.getState().past.length).toBe(pastBefore + 1);
    // Y un solo undo deshace ambos.
    useProjectStore.getState().undo();
    const undone = useProjectStore.getState().project.clips.find((c) => c.id === id);
    expect(undone?.audioFadeIn).toBeUndefined();
  });

  it('[FAILS-WITHOUT-FIX] clearAudioFades limpia y es deshacible', () => {
    const id = addMusicClip();
    const store = useProjectStore.getState();
    store.setAudioFade(id, { fadeIn: { duration: 1 }, fadeOut: { duration: 1 } });
    // Cierra el grupo de coalescencia (la UI lo hace entre gestos): limpiar
    // debe ser SU propia entrada deshacible, no fundirse con el ajuste.
    store.commitClipChange();
    expect(store.clearAudioFades(id)).toBe(true);
    const cleared = useProjectStore.getState().project.clips.find((c) => c.id === id);
    expect(cleared?.audioFadeIn).toBeUndefined();
    expect(cleared?.audioFadeOut).toBeUndefined();
    expect(store.clearAudioFades('no_existe')).toBe(false);

    useProjectStore.getState().undo();
    const restored = useProjectStore.getState().project.clips.find((c) => c.id === id);
    expect(restored?.audioFadeIn?.duration).toBeCloseTo(1, 6);
    expect(restored?.audioFadeOut?.duration).toBeCloseTo(1, 6);
  });

  it('[FAILS-WITHOUT-FIX] updateClip directo también recorta (todas las vías cuantizan)', () => {
    const id = addMusicClip();
    useProjectStore.getState().updateClip(id, { audioFadeIn: { duration: 99 } });
    const saved = useProjectStore.getState().project.clips.find((c) => c.id === id);
    expect(saved?.audioFadeIn?.duration).toBeLessThanOrEqual(4);
    expect(useProjectStore.getState().lastError).toMatch(/clip/);
  });

  it('[FAILS-WITHOUT-FIX] splitClip reparte los fundidos como los bordes del transition', () => {
    const id = addMusicClip();
    const store = useProjectStore.getState();
    store.setAudioFade(id, {
      fadeIn: { duration: 1 },
      fadeOut: { duration: 1, curve: 'linear' },
    });
    store.splitClip(id, 2);

    const clips = useProjectStore.getState().project.clips;
    expect(clips.length).toBe(2);
    const first = clips.find((c) => c.id === id)!;
    const second = clips.find((c) => c.id !== id)!;
    // La primera mitad conserva la entrada y pierde la salida; la segunda al revés.
    expect(first.audioFadeIn?.duration).toBeCloseTo(1, 6);
    expect(first.audioFadeOut).toBeUndefined();
    expect(second.audioFadeIn).toBeUndefined();
    expect(second.audioFadeOut?.curve).toBe('linear');
  });
});

/* ================================================================== */
/* E · Preview: AudioEngine follows the fade per frame                 */
/* ================================================================== */

describe('E · el preview sigue la rampa por frame', () => {
  function fadedPreview() {
    delete (globalThis as Record<string, unknown>).AudioContext;
    delete (globalThis as Record<string, unknown>).webkitAudioContext;
    const element = new FakeAudioElement();
    element.muted = false;
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(
      element as unknown as HTMLAudioElement
    );
    const engine = new AudioEngine();
    const clip = makeClip({ audioFadeIn: { duration: 2 } });
    const media = [makeMedia({ type: 'audio', duration: 30 })];
    return { element, engine, clip, media };
  }

  it('[FAILS-WITHOUT-FIX] el volumen del elemento recorre la curva del fundido', () => {
    const { element, engine, clip, media } = fadedPreview();
    engine.updateAudio(0, true, [audioTrack], [clip], media);
    expect(element.volume).toBeCloseTo(0, 6);

    engine.updateAudio(1, true, [audioTrack], [clip], media);
    expect(element.volume).toBeCloseTo(Math.SQRT1_2, 2);

    engine.updateAudio(3, true, [audioTrack], [clip], media);
    expect(element.volume).toBeCloseTo(1, 6);
  });

  it('[FAILS-WITHOUT-FIX] la caché no derrota el fundido: cada frame mueve la ganancia', () => {
    const { element, engine, clip, media } = fadedPreview();
    // Fundido largo (4 s): el paso por frame (~0.007) queda POR DEBAJO del
    // umbral 0.01 de la caché en reposo. Sin el épsilon de fundido, el segundo
    // frame no se escribiría y la rampa iría a escalones.
    const longFade = { ...clip, duration: 8, audioFadeIn: { duration: 4 } };
    engine.updateAudio(2, true, [audioTrack], [longFade], media);
    const first = element.volume;
    engine.updateAudio(2 + 1 / 60, true, [audioTrack], [longFade], media);
    const second = element.volume;
    expect(second).not.toBe(first);
    expect(second).toBeCloseTo(previewClipFadeGain(longFade, 2 + 1 / 60), 4);
  });

  it('sin fundidos el volumen es constante (la caché en reposo sigue intacta)', () => {
    delete (globalThis as Record<string, unknown>).AudioContext;
    delete (globalThis as Record<string, unknown>).webkitAudioContext;
    const element = new FakeAudioElement();
    element.muted = false;
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(
      element as unknown as HTMLAudioElement
    );
    const engine = new AudioEngine();
    const clip = makeClip({ volume: 0.7 });
    const media = [makeMedia({ type: 'audio', duration: 30 })];
    engine.updateAudio(1, true, [audioTrack], [clip], media);
    expect(element.volume).toBeCloseTo(0.7, 6);
    engine.updateAudio(1.5, true, [audioTrack], [clip], media);
    expect(element.volume).toBeCloseTo(0.7, 6);
  });
});

/* ================================================================== */
/* F · Export: the offline envelope agrees with the preview            */
/* ================================================================== */

describe('F · la automatización del export', () => {
  it('[FAILS-WITHOUT-FIX] sin fundidos no hay eventos (el camino histórico queda intacto)', () => {
    expect(buildAudioFadeAutomation(makeClip())).toEqual([]);
    expect(
      buildAudioFadeAutomation(makeClip({ audioFadeIn: { duration: 0 } }))
    ).toEqual([]);
  });

  it('[FAILS-WITHOUT-FIX] la automatización arranca en 0, ancla en 1 y termina en 0', () => {
    const clip = makeClip({
      duration: 4,
      audioFadeIn: { duration: 1 },
      audioFadeOut: { duration: 1, curve: 'linear' },
    });
    const events = buildAudioFadeAutomation(clip);
    // set inicial + 64 segmentos de entrada + ancla + 64 de salida.
    expect(events.length).toBe(1 + AUDIO_FADE_AUTOMATION_SEGMENTS + 1 + AUDIO_FADE_AUTOMATION_SEGMENTS);
    expect(events[0]).toEqual({ type: 'set', time: 0, value: 0 });
    const anchor = events.find((e) => e.type === 'set' && e.time === 3);
    expect(anchor?.value).toBe(1);
    const last = events[events.length - 1];
    expect(last.type).toBe('linearRamp');
    expect(last.time).toBeCloseTo(4, 9);
    expect(last.value).toBeCloseTo(0, 9);
    // Monotonía: la entrada solo sube, la salida solo baja.
    const inValues = events.slice(0, 1 + AUDIO_FADE_AUTOMATION_SEGMENTS).map((e) => e.value);
    for (let i = 1; i < inValues.length; i++) {
      expect(inValues[i]).toBeGreaterThanOrEqual(inValues[i - 1]);
    }
  });

  it('[FAILS-WITHOUT-FIX] preview y export acuerdan en todo instante', () => {
    const clip = makeClip({
      start: 5,
      duration: 6,
      audioFadeIn: { duration: 2 },
      audioFadeOut: { duration: 1.5, curve: 'linear' },
    });
    const events = buildAudioFadeAutomation(clip);
    expect(events.length).toBeGreaterThan(0);
    // Barrido fino del clip (dentro y fuera de las regiones, bordes incluidos).
    for (let i = 0; i <= 120; i++) {
      const t = 5 + (6 * i) / 120;
      const preview = previewClipFadeGain(clip, t);
      const exported = evaluateExportedEnvelope(events, t);
      expect(exported).toBeCloseTo(preview, 3);
    }
  });

  it('[FAILS-WITHOUT-FIX] el acuerdo vale con curvas mezcladas y fundidos encogidos', () => {
    const clip = makeClip({
      duration: 4,
      audioFadeIn: { duration: 3, curve: 'linear' },
      audioFadeOut: { duration: 3 },
    });
    const events = buildAudioFadeAutomation(clip);
    for (let i = 0; i <= 80; i++) {
      const t = (4 * i) / 80;
      expect(evaluateExportedEnvelope(events, t)).toBeCloseTo(previewClipFadeGain(clip, t), 3);
    }
  });
});

/* ================================================================== */
/* G · renderOfflineAudio wires the fade node                          */
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

describe('G · renderOfflineAudio programa el nodo de fundido', () => {
  it('[FAILS-WITHOUT-FIX] un clip SIN fundidos usa un solo nodo con un solo set (camino intacto)', async () => {
    const state: {
      starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
      gains: RecordedGain[];
    } = { starts: [], gains: [] };
    installOfflineAudioFakes(state);

    const clip = makeClip({ id: 'plain', start: 1, duration: 4 });
    const rendered = await renderOfflineAudio(8, [audioTrack], [clip], [makeMedia()]);
    expect(rendered).not.toBeNull();
    expect(state.starts.length).toBe(1);
    // EXACTAMENTE el camino histórico: un nodo, un `set` con el volumen.
    expect(state.gains.length).toBe(1);
    expect(state.gains[0].events).toEqual([{ type: 'set', time: 1, value: 1 }]);
  });

  it('[FAILS-WITHOUT-FIX] un clip CON fundidos suena con la envolvente en un nodo en serie', async () => {
    const state: {
      starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
      gains: RecordedGain[];
    } = { starts: [], gains: [] };
    installOfflineAudioFakes(state);

    const clip = makeClip({
      id: 'faded',
      start: 1,
      duration: 4,
      volume: 0.5,
      audioFadeIn: { duration: 1 },
      audioFadeOut: { duration: 1, curve: 'linear' },
    });
    const rendered = await renderOfflineAudio(8, [audioTrack], [clip], [makeMedia()]);
    expect(rendered).not.toBeNull();
    expect(state.starts.length).toBe(1);

    // Dos nodos: el histórico lleva el volumen, el nuevo la envolvente 0..1.
    expect(state.gains.length).toBe(2);
    expect(state.gains[0].events).toEqual([{ type: 'set', time: 1, value: 0.5 }]);
    const fadeEvents = state.gains[1].events;
    expect(fadeEvents.length).toBeGreaterThan(10);
    expect(fadeEvents[0]).toEqual({ type: 'set', time: 1, value: 0 });
    const last = fadeEvents[fadeEvents.length - 1];
    expect(last.time).toBeCloseTo(5, 9);
    expect(last.value).toBeCloseTo(0, 9);
    // La envolvente programada acuerda con el preview en el punto medio.
    expect(evaluateExportedEnvelope(fadeEvents, 1.5)).toBeCloseTo(
      previewClipFadeGain(clip, 1.5),
      3
    );
    expect(evaluateExportedEnvelope(fadeEvents, 2.5)).toBe(1);
  });
});
