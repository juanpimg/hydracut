/**
 * F8 · Keyframes de transform de un clip — regression suite.
 *
 * El contrato de esta feature NO es "hay una lista en el Inspector": es
 *
 *   1. la interpolación lineal mueve de verdad los píxeles del clip,
 *   2. el PREVIEW y el EXPORT aplican EXACTAMENTE la misma interpolación
 *      (ambos renderizan con el MISMO `Compositor`), y
 *   3. sin keyframes el clip se dibuja EXACTAMENTE igual que hoy.
 *
 * Cada aserción ejercita el código de PRODUCCIÓN
 * (`src/core/utils/keyframes.ts`, `Compositor.renderFrame`,
 * `webcodecsExporter.exportVideo`, `useProjectStore` y `projectStorage`).
 * Nada aquí reimplementa la lógica bajo prueba.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Compositor } from '../core/engine/Compositor';
import {
  clampKeyframeProps,
  clampKeyframeTime,
  cropKeyframesToDuration,
  evaluateKeyframes,
  evaluateKeyframesInto,
  evaluateSortedKeyframesInto,
  getKeyframePrepareCount,
  hasKeyframeProps,
  hasKeyframes,
  normalizeKeyframesForWrite,
  prepareSortedKeyframes,
  quantizeKeyframeTime,
  resetKeyframePrepareCount,
  shiftKeyframesAfterTrimStart,
  splitKeyframesAt,
  staticTransformOf,
  type ResolvedKeyframeTransform,
} from '../core/utils/keyframes';
import { Clip, ClipKeyframe, MediaItem, Track } from '../types/project';
import { useProjectStore } from '../store/useProjectStore';

/* ------------------------------------------------------------------ */
/* In-memory IndexedDB (the storage layer writes through idb-keyval)  */
/* ------------------------------------------------------------------ */
const memoryStore = vi.hoisted(() => new Map<string, unknown>());

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => memoryStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
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

/* ------------------------------------------------------------------ */
/* Fake DOM (registra posiciones, alfas y filtros)                     */
/* ------------------------------------------------------------------ */

class Fake2DContext {
  filter = 'none';
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  fillStyle = '';
  strokeStyle = '';
  font = '';
  textAlign = '';
  textBaseline = '';
  lineWidth = 1;

  drawImageCalls: Array<{
    source: unknown;
    x: number;
    y: number;
    w: number;
    h: number;
    alpha: number;
    filter: string;
  }> = [];
  fillRectCalls: Array<{ x: number; y: number; w: number; h: number; alpha: number }> = [];
  fillTextCalls: Array<{ text: string; alpha: number }> = [];

  private stack: Array<{ alpha: number; filter: string; composite: string; fill: string }> = [];

  save(): void {
    this.stack.push({
      alpha: this.globalAlpha,
      filter: this.filter,
      composite: this.globalCompositeOperation,
      fill: this.fillStyle,
    });
  }

  restore(): void {
    const state = this.stack.pop();
    if (!state) return;
    this.globalAlpha = state.alpha;
    this.filter = state.filter;
    this.globalCompositeOperation = state.composite;
    this.fillStyle = state.fill;
  }

  setTransform(): void {}
  beginPath(): void {}
  rect(): void {}
  clip(): void {}
  roundRect(): void {}
  fill(): void {}
  stroke(): void {}

  measureText(): { width: number } {
    return { width: 10 };
  }

  drawImage(source: unknown, x = 0, y = 0, w = 0, h = 0): void {
    this.drawImageCalls.push({ source, x, y, w, h, alpha: this.globalAlpha, filter: this.filter });
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.fillRectCalls.push({ x, y, w, h, alpha: this.globalAlpha });
  }

  fillText(text: string): void {
    this.fillTextCalls.push({ text: String(text), alpha: this.globalAlpha });
  }

  strokeText(): void {}
}

class FakeCanvas {
  width = 0;
  height = 0;
  readonly ctx: Fake2DContext;

  constructor(ctx?: Fake2DContext) {
    this.ctx = ctx ?? new Fake2DContext();
  }

  getContext(): Fake2DContext {
    return this.ctx;
  }
}

class FakeImage {
  complete = true;
  naturalWidth = 640;
  naturalHeight = 360;
  crossOrigin = '';
  onload: (() => void) | null = null;
  private source = '';

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

class FakeVideo {
  readyState = 4;
  videoWidth = 640;
  videoHeight = 360;
  currentTime = 0;
  paused = true;
  seeking = false;
  playbackRate = 1;
  preservesPitch = true;
  src = '';
  crossOrigin = '';
  preload = '';
  muted = true;

  addEventListener(): void {}
  removeEventListener(): void {}
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
  load(): void {}
  removeAttribute(): void {}
}

const dom = {
  canvases: [] as FakeCanvas[],
  contextFactory: (): Fake2DContext => new Fake2DContext(),
};

const originalGlobals: Record<string, unknown> = {
  document: (globalThis as Record<string, unknown>).document,
  Image: (globalThis as Record<string, unknown>).Image,
  HTMLVideoElement: (globalThis as Record<string, unknown>).HTMLVideoElement,
  VideoEncoder: (globalThis as Record<string, unknown>).VideoEncoder,
  VideoFrame: (globalThis as Record<string, unknown>).VideoFrame,
};

function installFakeDom(): void {
  dom.canvases = [];
  dom.contextFactory = () => new Fake2DContext();
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        const canvas = new FakeCanvas(dom.contextFactory());
        dom.canvases.push(canvas);
        return canvas;
      }
      if (tag === 'video') return new FakeVideo();
      return {} as HTMLElement;
    },
    body: { appendChild: () => {}, removeChild: () => {} },
  };
  (globalThis as Record<string, unknown>).Image = FakeImage;
  (globalThis as Record<string, unknown>).HTMLVideoElement = FakeVideo;
}

/** Installs a fake WebCodecs implementation (the exporter needs it). */
function installFakeWebCodecs(): void {
  class FakeVideoEncoder {
    state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
    encodeQueueSize = 0;
    private init: {
      output: (chunk: unknown, meta?: unknown) => void;
      error: (e: unknown) => void;
    };

    constructor(init: { output: (chunk: unknown, meta?: unknown) => void; error: (e: unknown) => void }) {
      this.init = init;
    }

    static isConfigSupported = vi.fn(async () => ({ supported: true }));

    configure(): void {
      this.state = 'configured';
    }

    encode(
      frame: { timestamp: number; duration?: number },
      options?: { keyFrame?: boolean }
    ): void {
      this.init.output(
        {
          byteLength: 4,
          copyTo: (dest: Uint8Array) => dest.set([0, 0, 0, 1]),
          type: options?.keyFrame ? 'key' : 'delta',
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

    async flush(): Promise<void> {}
    close(): void {
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
    close(): void {}
  };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip_1',
    trackId: 'track_video_1',
    mediaId: 'media_1',
    name: 'Clip 1',
    type: 'image',
    start: 0,
    duration: 4,
    sourceStart: 0,
    sourceDuration: 4,
    volume: 1,
    opacity: 1,
    scale: 1,
    positionX: 0,
    positionY: 0,
    muted: false,
    ...overrides,
  };
}

function makeMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media_1',
    name: 'Media 1',
    type: 'image',
    url: 'blob:media-1',
    duration: 4,
    width: 640,
    height: 360,
    fps: 30,
    thumbnailUrl: '',
    size: 100,
    createdAt: 0,
    ...overrides,
  };
}

const videoTrack: Track = {
  id: 'track_video_1',
  name: 'Video 1',
  type: 'video',
  isMuted: false,
  isLocked: false,
  isVisible: true,
};

const textTrack: Track = {
  id: 'track_text_1',
  name: 'Texto 1',
  type: 'text',
  isMuted: false,
  isLocked: false,
  isVisible: true,
};

interface RenderedFrame {
  canvas: FakeCanvas;
  ctx: Fake2DContext;
  compositor: Compositor;
}

/** Renders one frame of the preview with a SHARED compositor (cache-aware). */
function renderPreviewFrame(
  clip: Clip,
  time: number,
  compositor: Compositor,
  tracks: Track[] = [videoTrack]
): RenderedFrame {
  const ctx = new Fake2DContext();
  const canvas = new FakeCanvas(ctx);
  canvas.width = 640;
  canvas.height = 360;
  compositor.renderFrame({
    time,
    canvas: canvas as unknown as HTMLCanvasElement,
    tracks,
    clips: [clip],
    mediaPool: [makeMedia()],
    isPlaying: true,
  });
  return { canvas, ctx, compositor };
}

/** X positions at which the media of the clip was drawn (in frame order). */
function mediaDrawX(ctx: Fake2DContext): number[] {
  return ctx.drawImageCalls
    .filter((call) => call.source instanceof FakeImage)
    .map((call) => call.x);
}

function mediaDrawCount(ctx: Fake2DContext): number {
  return ctx.drawImageCalls.filter((call) => call.source instanceof FakeImage).length;
}

beforeEach(() => {
  installFakeDom();
  resetKeyframePrepareCount();
  memoryStore.clear();
  useProjectStore.getState().resetProject();
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) {
      delete (globalThis as Record<string, unknown>)[key];
    } else {
      (globalThis as Record<string, unknown>)[key] = value;
    }
  }
  vi.restoreAllMocks();
  resetKeyframePrepareCount();
});

/* ================================================================== */
/* 1 · La regla de interpolación (helper puro)                         */
/* ================================================================== */

describe('F8 · la regla de interpolación lineal', () => {
  const base = makeClip({ positionX: 30, positionY: -10, scale: 1.5, opacity: 0.8 });

  it('sin keyframes devuelve la transformación estática del clip', () => {
    expect(evaluateKeyframes(base, 0)).toEqual({ x: 30, y: -10, scale: 1.5, opacity: 0.8 });
    expect(evaluateKeyframes(base, 2.5)).toEqual({ x: 30, y: -10, scale: 1.5, opacity: 0.8 });
    expect(evaluateKeyframes(makeClip({ keyframes: [] }), 1)).toEqual({
      x: 0,
      y: 0,
      scale: 1,
      opacity: 1,
    });
    expect(hasKeyframes(makeClip())).toBe(false);
    expect(hasKeyframes(makeClip({ keyframes: [] }))).toBe(false);
  });

  it('la evaluación no recorta los valores estáticos (se dibujan como hoy)', () => {
    // Un clip heredado con escala fuera de rango se evalúa tal cual: la
    // evaluación nunca cambia el render estático.
    const legacy = makeClip({ scale: 5, opacity: 0.3 });
    expect(evaluateKeyframes(legacy, 1.5).scale).toBe(5);
  });

  it('interpola linealmente entre dos keyframes', () => {
    const clip = makeClip({
      keyframes: [
        { t: 0, x: 0, y: 0, scale: 1, opacity: 0 },
        { t: 2, x: 200, y: 100, scale: 2, opacity: 1 },
      ],
    });
    expect(evaluateKeyframes(clip, 1)).toEqual({ x: 100, y: 50, scale: 1.5, opacity: 0.5 });
    expect(evaluateKeyframes(clip, 0)).toEqual({ x: 0, y: 0, scale: 1, opacity: 0 });
    expect(evaluateKeyframes(clip, 2)).toEqual({ x: 200, y: 100, scale: 2, opacity: 1 });
    expect(evaluateKeyframes(clip, 0.5).x).toBeCloseTo(50, 9);
  });

  it('antes del primer keyframe mantiene sus valores', () => {
    const clip = makeClip({
      keyframes: [
        { t: 1, x: 50, scale: 1.5 },
        { t: 2, x: 100, scale: 2 },
      ],
    });
    expect(evaluateKeyframes(clip, 0)).toEqual({ x: 50, y: 0, scale: 1.5, opacity: 1 });
  });

  it('después del último keyframe mantiene sus valores', () => {
    const clip = makeClip({
      keyframes: [
        { t: 0, x: 50, scale: 1.5 },
        { t: 1, x: 100, scale: 2 },
      ],
    });
    // `y`/`opacity` no los define ningún keyframe: caen al estático.
    expect(evaluateKeyframes(clip, 3.5)).toEqual({ x: 100, y: 0, scale: 2, opacity: 1 });
  });

  it('un solo keyframe es constante en todo el clip', () => {
    const clip = makeClip({ keyframes: [{ t: 1, x: 70, opacity: 0.4 }] });
    expect(evaluateKeyframes(clip, 0).x).toBe(70);
    expect(evaluateKeyframes(clip, 1).x).toBe(70);
    expect(evaluateKeyframes(clip, 3.99).x).toBe(70);
    expect(evaluateKeyframes(clip, 2).opacity).toBeCloseTo(0.4, 9);
  });

  it('una propiedad ausente se interpola entre quienes la definen (sin caídas a 0)', () => {
    // Pistas de propiedad independientes: el keyframe intermedio no define
    // `x`, así que para `x` no existe (no aporta un extremo indefinido).
    const clip = makeClip({
      keyframes: [
        { t: 0, x: 0, y: 0 },
        { t: 1, y: 100 },
        { t: 2, x: 200, y: 200 },
      ],
    });
    const atMiddle = evaluateKeyframes(clip, 1);
    expect(atMiddle.x).toBeCloseTo(100, 9);
    expect(atMiddle.y).toBe(100);
    expect(Number.isNaN(atMiddle.x)).toBe(false);
  });

  it('una propiedad tras su último definidor conserva ese valor', () => {
    const clip = makeClip({
      keyframes: [
        { t: 0, x: 10 },
        { t: 1, y: 5 },
      ],
    });
    expect(evaluateKeyframes(clip, 1).x).toBe(10);
    expect(evaluateKeyframes(clip, 0.5).x).toBe(10);
  });

  it('evaluateKeyframesInto reutiliza el objeto de salida', () => {
    const clip = makeClip({ keyframes: [{ t: 0, x: 0 }, { t: 2, x: 200 }] });
    const out: ResolvedKeyframeTransform = { x: -1, y: -1, scale: -1, opacity: -1 };
    const returned = evaluateKeyframesInto(clip, 1, out);
    expect(returned).toBe(out);
    expect(out.x).toBeCloseTo(100, 9);
  });

  it('evaluateSortedKeyframesInto no interpola desde indefinidos', () => {
    const sorted = prepareSortedKeyframes([{ t: 0, y: 10 }, { t: 2, y: 30 }]);
    const out = evaluateSortedKeyframesInto(
      sorted,
      { x: 7, y: 0, scale: 1, opacity: 1 },
      1,
      { x: 0, y: 0, scale: 0, opacity: 0 }
    );
    expect(out.y).toBeCloseTo(20, 9);
    // `x` no lo define nadie: el estático.
    expect(out.x).toBe(7);
  });
});

/* ================================================================== */
/* 2 · Normalización de escritura (tiempos, valores, orden)            */
/* ================================================================== */

describe('F8 · normalización de keyframes al escribir', () => {
  it('los tiempos se cuantizan al frame del proyecto', () => {
    expect(quantizeKeyframeTime(1.01, 30)).toBe(1);
    expect(quantizeKeyframeTime(1.02, 30)).toBeCloseTo(1.033333, 5);
    expect(quantizeKeyframeTime(-3, 30)).toBe(0);
  });

  it('los tiempos se recortan a la duración del clip', () => {
    expect(clampKeyframeTime(-1, 4, 30)).toBe(0);
    expect(clampKeyframeTime(99, 4, 30)).toBe(4);
    expect(clampKeyframeTime(1, 4, 30)).toBe(1);
  });

  it('los valores se acotan (escala > 0, opacidad 0..1)', () => {
    expect(clampKeyframeProps({ scale: -2, opacity: 5 })).toEqual({ scale: 0.1, opacity: 1 });
    expect(clampKeyframeProps({ scale: 99, opacity: -1 })).toEqual({ scale: 3, opacity: 0 });
    expect(clampKeyframeProps({ x: Number.NaN, y: Number.POSITIVE_INFINITY })).toEqual({});
    expect(hasKeyframeProps(clampKeyframeProps({}))).toBe(false);
    expect(hasKeyframeProps(clampKeyframeProps({ x: 3 }))).toBe(true);
  });

  it('ordena por tiempo y fusiona duplicados (el posterior gana)', () => {
    const sorted = prepareSortedKeyframes([
      { t: 2, x: 1 },
      { t: 0.5, y: 2 },
      { t: 2, x: 9 },
    ]);
    expect(sorted).toEqual([
      { t: 0.5, y: 2 },
      { t: 2, x: 9 },
    ]);
  });

  it('normalizeKeyframesForWrite limpia, ordena y devuelve undefined si no queda nada', () => {
    expect(normalizeKeyframesForWrite(undefined, 30, 4)).toBeUndefined();
    expect(normalizeKeyframesForWrite([], 30, 4)).toBeUndefined();
    expect(normalizeKeyframesForWrite([{ t: 1 } as ClipKeyframe], 30, 4)).toBeUndefined();
    const out = normalizeKeyframesForWrite(
      [
        { t: 3, x: 30, scale: -5, opacity: 2 },
        { t: 1, x: 10 },
      ],
      30,
      4
    );
    expect(out).toEqual([
      { t: 1, x: 10 },
      { t: 3, x: 30, scale: 0.1, opacity: 1 },
    ]);
  });

  it('staticTransformOf refleja los valores del clip', () => {
    expect(staticTransformOf(makeClip())).toEqual({ x: 0, y: 0, scale: 1, opacity: 1 });
  });
});

/* ================================================================== */
/* 3 · El store (acciones deshacibles)                                 */
/* ================================================================== */

describe('F8 · acciones del store', () => {
  function addVideoClip(id = 'clip_kf'): Clip {
    const clip = makeClip({ id, type: 'video' });
    useProjectStore.getState().addClip(clip);
    return clip;
  }

  it('addKeyframe crea un keyframe con los valores efectivos actuales', () => {
    addVideoClip();
    const ok = useProjectStore
      .getState()
      .addKeyframe('clip_kf', 1.0);
    expect(ok).toBe(true);
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf');
    expect(clip?.keyframes).toEqual([{ t: 1, x: 0, y: 0, scale: 1, opacity: 1 }]);
  });

  it('addKeyframe sin clip no hace nada (sin entrada fantasma en el historial)', () => {
    const pastBefore = useProjectStore.getState().past.length;
    expect(useProjectStore.getState().addKeyframe('clip_missing', 1)).toBe(false);
    expect(useProjectStore.getState().past.length).toBe(pastBefore);
  });

  it('addKeyframe hereda el estado animado (no el estático)', () => {
    addVideoClip();
    const s = useProjectStore.getState();
    s.addKeyframe('clip_kf', 0, { x: 0 });
    s.addKeyframe('clip_kf', 2, { x: 200 });
    // A t=1 el efectivo es x=100: el nuevo keyframe nace ahí.
    s.addKeyframe('clip_kf', 1.0);
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf');
    expect(clip?.keyframes?.find((k) => k.t === 1)?.x).toBeCloseTo(100, 9);
  });

  it('addKeyframe cuantiza al frame, ordena y no duplica el instante', () => {
    addVideoClip();
    const s = useProjectStore.getState();
    expect(s.addKeyframe('clip_kf', 1.0, { x: 10 })).toBe(true);
    // 1.01 s cae en el mismo frame a 30 fps: fusiona, no duplica.
    expect(s.addKeyframe('clip_kf', 1.01, { y: 20 })).toBe(true);
    expect(s.addKeyframe('clip_kf', 0.5, { x: 5 })).toBe(true);
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf');
    expect(clip?.keyframes).toEqual([
      { t: 0.5, x: 5 },
      { t: 1, x: 10, y: 20 },
    ]);
  });

  it('addKeyframe acota valores y recorta tiempos al clip', () => {
    addVideoClip();
    const s = useProjectStore.getState();
    expect(s.addKeyframe('clip_kf', -5, { scale: -2, opacity: 5 })).toBe(true);
    expect(s.addKeyframe('clip_kf', 999, { scale: 99, opacity: -1 })).toBe(true);
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf');
    expect(clip?.keyframes).toEqual([
      { t: 0, scale: 0.1, opacity: 1 },
      { t: 4, scale: 3, opacity: 0 },
    ]);
  });

  it('addKeyframe sin propiedades aprovechables no escribe', () => {
    addVideoClip();
    const pastBefore = useProjectStore.getState().past.length;
    expect(useProjectStore.getState().addKeyframe('clip_kf', 1, {})).toBe(false);
    expect(useProjectStore.getState().past.length).toBe(pastBefore);
  });

  it('removeKeyframe borra y es deshacible', () => {
    addVideoClip();
    const s = useProjectStore.getState();
    s.addKeyframe('clip_kf', 0.5, { x: 1 });
    s.addKeyframe('clip_kf', 1.5, { x: 2 });
    expect(s.removeKeyframe('clip_kf', 0.5)).toBe(true);
    let clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf');
    expect(clip?.keyframes).toEqual([{ t: 1.5, x: 2 }]);
    // Sin keyframe en ese instante: no-op sin historial.
    const pastBefore = useProjectStore.getState().past.length;
    expect(s.removeKeyframe('clip_kf', 0.5)).toBe(false);
    expect(useProjectStore.getState().past.length).toBe(pastBefore);
    // Deshacer restaura el borrado.
    useProjectStore.getState().undo();
    clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf');
    expect(clip?.keyframes).toEqual([
      { t: 0.5, x: 1 },
      { t: 1.5, x: 2 },
    ]);
  });

  it('updateKeyframe fusiona, acota y no crea lo inexistente', () => {
    addVideoClip();
    const s = useProjectStore.getState();
    s.addKeyframe('clip_kf', 1, { x: 10, opacity: 0.5 });
    expect(s.updateKeyframe('clip_kf', 1, { x: 30, opacity: 9 })).toBe(true);
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf');
    expect(clip?.keyframes).toEqual([{ t: 1, x: 30, opacity: 1 }]);
    // Actualizar lo inexistente no crea nada ni empuja historial.
    const pastBefore = useProjectStore.getState().past.length;
    expect(s.updateKeyframe('clip_kf', 2, { x: 1 })).toBe(false);
    expect(useProjectStore.getState().past.length).toBe(pastBefore);
    expect(
      useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf')?.keyframes
    ).toHaveLength(1);
    void clip;
  });

  it('cada acción es un solo paso de deshacer', () => {
    addVideoClip();
    const pastBefore = useProjectStore.getState().past.length;
    useProjectStore.getState().addKeyframe('clip_kf', 1, { x: 10 });
    expect(useProjectStore.getState().past.length).toBe(pastBefore + 1);
    useProjectStore.getState().undo();
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf');
    expect(clip?.keyframes).toBeUndefined();
    useProjectStore.getState().redo();
    const redone = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf');
    expect(redone?.keyframes).toEqual([{ t: 1, x: 10 }]);
  });

  it('arrastrar updateKeyframe comparte un solo paso (coalescencia)', () => {
    addVideoClip();
    const s = useProjectStore.getState();
    s.addKeyframe('clip_kf', 1, { x: 0 });
    const pastBefore = useProjectStore.getState().past.length;
    // Dos ticks seguidos del mismo deslizador: UN solo push.
    expect(s.updateKeyframe('clip_kf', 1, { x: 10 })).toBe(true);
    expect(s.updateKeyframe('clip_kf', 1, { x: 20 })).toBe(true);
    expect(useProjectStore.getState().past.length).toBe(pastBefore + 1);
    // Un deshacer revierte AMBOS ticks.
    useProjectStore.getState().undo();
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf');
    expect(clip?.keyframes).toEqual([{ t: 1, x: 0 }]);
  });

  it('clearKeyframes borra todo y es deshacible', () => {
    addVideoClip();
    const s = useProjectStore.getState();
    s.addKeyframe('clip_kf', 0.5, { x: 1 });
    s.addKeyframe('clip_kf', 1.5, { x: 2 });
    expect(s.clearKeyframes('clip_kf')).toBe(true);
    expect(
      useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf')?.keyframes
    ).toBeUndefined();
    // Sin keyframes: no-op.
    expect(s.clearKeyframes('clip_kf')).toBe(false);
    useProjectStore.getState().undo();
    expect(
      useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf')?.keyframes
    ).toHaveLength(2);
  });

  it('updateClip normaliza keyframes escritos a mano', () => {
    addVideoClip();
    useProjectStore.getState().updateClip('clip_kf', {
      keyframes: [
        { t: 2, x: 20 },
        { t: 0.2, x: 5, opacity: 7 },
        { t: 2, y: 9 },
      ],
    });
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf');
    expect(clip?.keyframes).toEqual([
      { t: 0.2, x: 5, opacity: 1 },
      { t: 2, x: 20, y: 9 },
    ]);
  });

  it('splitClip reparte los keyframes entre las mitades', () => {
    addVideoClip();
    const s = useProjectStore.getState();
    s.addKeyframe('clip_kf', 1, { x: 10 });
    s.addKeyframe('clip_kf', 3, { x: 30 });
    s.splitClip('clip_kf', 2);
    const clips = useProjectStore.getState().project.clips;
    const first = clips.find((c) => c.id === 'clip_kf');
    const second = clips.find((c) => c.name.includes('parte 2'));
    expect(first?.duration).toBeCloseTo(2, 9);
    expect(first?.keyframes).toEqual([{ t: 1, x: 10 }]);
    expect(second?.start).toBeCloseTo(2, 9);
    // El keyframe de t=3 vive ahora a t=1 de la segunda mitad.
    expect(second?.keyframes).toEqual([{ t: 1, x: 30 }]);
  });

  it('trimClipEnd descarta los keyframes más allá del nuevo final', () => {
    addVideoClip();
    const s = useProjectStore.getState();
    s.addKeyframe('clip_kf', 1, { x: 10 });
    s.addKeyframe('clip_kf', 3, { x: 30 });
    s.trimClipEnd('clip_kf', 2.5, { snap: false });
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf');
    expect(clip?.duration).toBeCloseTo(2.5, 9);
    expect(clip?.keyframes).toEqual([{ t: 1, x: 10 }]);
  });

  it('trimClipStart desplaza los keyframes con el inicio', () => {
    addVideoClip();
    const s = useProjectStore.getState();
    s.addKeyframe('clip_kf', 1, { x: 10 });
    s.addKeyframe('clip_kf', 3, { x: 30 });
    s.trimClipStart('clip_kf', 1, { snap: false });
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_kf');
    expect(clip?.start).toBeCloseTo(1, 9);
    expect(clip?.keyframes).toEqual([
      { t: 0, x: 10 },
      { t: 2, x: 30 },
    ]);
  });

  it('shift/crop/split puros se comportan en los bordes', () => {
    expect(shiftKeyframesAfterTrimStart([], 1, 3, 30)).toBeUndefined();
    expect(cropKeyframesToDuration([{ t: 5, x: 1 }], 4)).toBeUndefined();
    expect(cropKeyframesToDuration([{ t: 1, x: 1 }], 4)).toEqual([{ t: 1, x: 1 }]);
    const [first, second] = splitKeyframesAt(
      [
        { t: 1, x: 1 },
        { t: 2, x: 2 },
      ],
      2,
      30
    );
    expect(first).toEqual([{ t: 1, x: 1 }]);
    expect(second).toEqual([{ t: 0, x: 2 }]);
  });
});

/* ================================================================== */
/* 4 · El preview (Compositor)                                         */
/* ================================================================== */

describe('F8 · el compositor anima el clip', () => {
  it('el preview mueve el clip entre keyframes', () => {
    const clip = makeClip({
      keyframes: [
        { t: 0, x: 0 },
        { t: 2, x: 200 },
      ],
    });
    const compositor = new Compositor();
    const at0 = renderPreviewFrame(clip, 0, compositor);
    const at1 = renderPreviewFrame(clip, 1, compositor);
    const at3 = renderPreviewFrame(clip, 3, compositor);
    expect(mediaDrawX(at0.ctx)).toEqual([0]);
    expect(mediaDrawX(at1.ctx)[0]).toBeCloseTo(100, 6);
    // Tras el último: se mantiene.
    expect(mediaDrawX(at3.ctx)[0]).toBeCloseTo(200, 6);
  });

  it('sin keyframes la transformación estática no cambia (regresión)', () => {
    const clip = makeClip({ positionX: 40, positionY: -15, scale: 1.25, opacity: 0.7 });
    const compositor = new Compositor();
    const at0 = renderPreviewFrame(clip, 0, compositor);
    const at1 = renderPreviewFrame(clip, 1, compositor);
    // 640x360 sobre 640x360 a escala 1.25: x = 320 + 40 - 640*1.25/2 = -40.
    expect(mediaDrawX(at0.ctx)).toEqual([-40]);
    expect(mediaDrawX(at1.ctx)).toEqual([-40]);
    expect(at0.ctx.drawImageCalls[0].alpha).toBeCloseTo(0.7, 9);
  });

  it('un clip con opacidad estática 0 pero keyframes visibles sí se pinta', () => {
    const clip = makeClip({ opacity: 0, keyframes: [{ t: 0, opacity: 0.9 }] });
    const compositor = new Compositor();
    const { ctx } = renderPreviewFrame(clip, 0, compositor);
    expect(mediaDrawCount(ctx)).toBe(1);
    expect(ctx.drawImageCalls[0].alpha).toBeCloseTo(0.9, 9);
  });

  it('la escala animada cambia el tamaño dibujado', () => {
    const clip = makeClip({
      keyframes: [
        { t: 0, scale: 1 },
        { t: 2, scale: 2 },
      ],
    });
    const compositor = new Compositor();
    const at0 = renderPreviewFrame(clip, 0, compositor);
    const at2 = renderPreviewFrame(clip, 2, compositor);
    const w0 = at0.ctx.drawImageCalls.filter((c) => c.source instanceof FakeImage)[0].w;
    const w2 = at2.ctx.drawImageCalls.filter((c) => c.source instanceof FakeImage)[0].w;
    expect(w0).toBeCloseTo(640, 6);
    expect(w2).toBeCloseTo(1280, 6);
  });

  it('el texto animado cambia de opacidad', () => {
    const clip = makeClip({
      id: 'clip_text',
      trackId: 'track_text_1',
      mediaId: '',
      type: 'text',
      text: 'Hola',
      keyframes: [
        { t: 0, opacity: 0.2 },
        { t: 2, opacity: 1 },
      ],
    });
    const compositor = new Compositor();
    const at0 = renderPreviewFrame(clip, 0, compositor, [textTrack]);
    const at2 = renderPreviewFrame(clip, 2, compositor, [textTrack]);
    expect(at0.ctx.fillTextCalls.length).toBeGreaterThan(0);
    expect(at0.ctx.fillTextCalls[0].alpha).toBeCloseTo(0.2, 6);
    expect(at2.ctx.fillTextCalls[0].alpha).toBeCloseTo(1, 6);
  });

  it('los keyframes solo se reordenan cuando cambian (cero asignaciones por frame)', () => {
    const clip = makeClip({
      keyframes: [
        { t: 0, x: 0 },
        { t: 2, x: 200 },
      ],
    });
    const compositor = new Compositor();
    resetKeyframePrepareCount();
    let firstX = 0;
    let lastX = 0;
    for (let frame = 0; frame < 20; frame++) {
      const { ctx } = renderPreviewFrame(clip, frame * 0.1, compositor);
      const xs = mediaDrawX(ctx);
      expect(xs).toHaveLength(1);
      if (frame === 0) firstX = xs[0];
      if (frame === 19) lastX = xs[0];
    }
    // 20 fotogramas, UNA sola reconstrucción del array ordenado…
    expect(getKeyframePrepareCount()).toBe(1);
    // …y los píxeles sí se mueven con el tiempo.
    expect(lastX).toBeGreaterThan(firstX);
  });

  it('cambiar los keyframes reconstruye la caché', () => {
    const clip = makeClip({ keyframes: [{ t: 0, x: 0 }] });
    const compositor = new Compositor();
    resetKeyframePrepareCount();
    renderPreviewFrame(clip, 0, compositor);
    expect(getKeyframePrepareCount()).toBe(1);
    // Nueva referencia = nueva edición = reconstrucción.
    clip.keyframes = [{ t: 0, x: 50 }];
    const { ctx } = renderPreviewFrame(clip, 0, compositor);
    expect(getKeyframePrepareCount()).toBe(2);
    expect(mediaDrawX(ctx)).toEqual([50]);
  });
});

/* ================================================================== */
/* 5 · El contrato real: preview == export                             */
/* ================================================================== */

describe('F8 · preview == export (el contrato real de la feature)', () => {
  it('el export recorre los mismos keyframes que el preview', async () => {
    installFakeWebCodecs();
    const { exportVideo } = await import('../core/export/webcodecsExporter');

    const clip = makeClip({
      id: 'clip_parity',
      keyframes: [
        { t: 0, x: 0 },
        { t: 2, x: 200 },
      ],
    });

    /* --- PREVIEW en los mismos instantes que los frames del export --- */
    const compositor = new Compositor();
    const fps = 30;
    const lastT = 59 / fps;
    const preview0 = mediaDrawX(renderPreviewFrame(clip, 0, compositor).ctx)[0];
    const previewLast = mediaDrawX(renderPreviewFrame(clip, lastT, compositor).ctx)[0];
    expect(preview0).toBeCloseTo(0, 6);
    expect(previewLast).toBeGreaterThan(100);

    /* --- EXPORT real (mismo Compositor dentro del exportador) --- */
    dom.canvases = [];
    const blob = await exportVideo({
      config: {
        aspectRatio: '16:9',
        width: 640,
        height: 360,
        fps,
        bitrate: 2_000_000,
        format: 'mp4',
      },
      duration: 2,
      tracks: [videoTrack],
      clips: [clip],
      mediaPool: [makeMedia()],
      onProgress: () => {},
    });
    expect(blob.size).toBeGreaterThan(0);

    const exportX = dom.canvases.flatMap((canvas) =>
      canvas.ctx.drawImageCalls
        .filter((call) => call.source instanceof FakeImage)
        .map((call) => call.x)
    );
    // 60 frames exportados, uno dibujado por frame.
    expect(exportX.length).toBe(60);
    // El MP4 empieza y termina donde el preview.
    expect(exportX[0]).toBeCloseTo(preview0, 6);
    expect(exportX[exportX.length - 1]).toBeCloseTo(previewLast, 6);
    // Y el clip se mueve a lo largo del export (no es un frame congelado).
    expect(exportX[exportX.length - 1]).toBeGreaterThan(exportX[0] + 100);
  });

  it('un clip sin keyframes se exporta con su transformación fija', async () => {
    installFakeWebCodecs();
    const { exportVideo } = await import('../core/export/webcodecsExporter');

    const clip = makeClip({ id: 'clip_static_export', positionX: 40 });
    const compositor = new Compositor();
    const previewX = mediaDrawX(renderPreviewFrame(clip, 1, compositor).ctx)[0];

    dom.canvases = [];
    await exportVideo({
      config: {
        aspectRatio: '16:9',
        width: 640,
        height: 360,
        fps: 30,
        bitrate: 2_000_000,
        format: 'mp4',
      },
      duration: 0.5,
      tracks: [videoTrack],
      clips: [clip],
      mediaPool: [makeMedia()],
      onProgress: () => {},
    });

    const exportX = dom.canvases.flatMap((canvas) =>
      canvas.ctx.drawImageCalls
        .filter((call) => call.source instanceof FakeImage)
        .map((call) => call.x)
    );
    expect(exportX.length).toBeGreaterThan(0);
    for (const x of exportX) expect(x).toBeCloseTo(previewX, 6);
  });
});

/* ================================================================== */
/* 6 · Persistencia                                                    */
/* ================================================================== */

describe('F8 · persistencia de los keyframes', () => {
  it('los keyframes sobreviven a guardar y recargar el proyecto', async () => {
    const { saveProject, getProjectById } = await import('../core/storage/projectStorage');
    const keyframes: ClipKeyframe[] = [
      { t: 0, x: 0, opacity: 0 },
      { t: 2, x: 200, opacity: 1 },
    ];
    const project = useProjectStore.getState().project;
    project.clips.push(makeClip({ id: 'clip_saved', type: 'video', keyframes }));

    await saveProject(project);

    const reloaded = await getProjectById(project.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.clips.find((c) => c.id === 'clip_saved')?.keyframes).toEqual(keyframes);
  });

  it('un proyecto antiguo sin keyframes sigue siendo válido', async () => {
    const { saveProject, getProjectById } = await import('../core/storage/projectStorage');
    const project = useProjectStore.getState().project;
    project.clips.push(makeClip({ id: 'clip_legacy', type: 'video' }));
    delete (project.clips[project.clips.length - 1] as Partial<Clip>).keyframes;

    await saveProject(project);

    const reloaded = await getProjectById(project.id);
    const clip = reloaded?.clips.find((c) => c.id === 'clip_legacy');
    expect(clip?.keyframes).toBeUndefined();
    // Y se evalúa como el estático de siempre.
    expect(evaluateKeyframes(clip!, 1)).toEqual({ x: 0, y: 0, scale: 1, opacity: 1 });
  });
});

/* ================================================================== */
/* 7 · El Inspector                                                    */
/* ================================================================== */

describe('F8 · el Inspector ofrece los controles de keyframes', () => {
  const inspector = readFileSync(
    new URL('../components/inspector/ClipInspector.tsx', import.meta.url),
    'utf8'
  );

  it('tiene una sección de keyframes en español', () => {
    expect(inspector).toContain('Keyframes de animación');
    expect(inspector).toContain('Añadir keyframe en el cabezal');
    expect(inspector).toContain('Borrar keyframes');
    expect(inspector).toContain('Volver a los valores fijos');
    expect(inspector).toContain('Sin keyframes: el clip usa su transformación fija');
  });

  it('los controles son accesibles (aria-label) y por teclado', () => {
    expect(inspector).toContain('aria-label="Añadir keyframe en el cabezal de reproducción"');
    expect(inspector).toContain('aria-label="Borrar todos los keyframes del clip"');
    expect(inspector).toContain('aria-label="Volver a editar los valores fijos del clip"');
    expect(inspector).toContain('Eliminar keyframe de');
    expect(inspector).toContain('Seleccionar keyframe de');
    expect(inspector).toContain('data-testid="keyframe-add"');
    expect(inspector).toContain('data-testid="keyframe-list"');
    expect(inspector).toContain('data-testid="keyframe-clear"');
    expect(inspector).toContain('aria-pressed');
  });

  it('avisa claramente cuando se edita un keyframe y no el valor fijo', () => {
    expect(inspector).toContain('data-testid="keyframe-editing-notice"');
    expect(inspector).toContain('Editando el keyframe de');
    expect(inspector).toContain('no el valor fijo del clip');
  });

  it('los cambios se escriben con las acciones del store (no en estado local)', () => {
    expect(inspector).toMatch(/addKeyframe\(clip\.id/);
    expect(inspector).toMatch(/updateKeyframe\(clip\.id/);
    expect(inspector).toMatch(/removeKeyframe\(clip\.id/);
    expect(inspector).toMatch(/clearKeyframes\(clip\.id\)/);
  });

  it('el keyframe nace del cabezal con los valores efectivos', () => {
    expect(inspector).toContain('currentTime - clip.start');
    expect(inspector).toContain('evaluateKeyframes');
  });
});
