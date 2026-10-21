/**
 * F9 · Colour filters of a clip — regression suite.
 *
 * The contract of this feature is NOT "there is a slider": it is
 *
 *   1. the filters really change the pixels of the clip,
 *   2. the PREVIEW and the EXPORT apply EXACTLY the same filter, and
 *   3. the filters survive a save/load round trip.
 *
 * Every assertion below exercises the PRODUCTION code paths
 * (`src/core/utils/colorFilters.ts`, `Compositor.renderFrame`,
 * `webcodecsExporter.exportVideo`, `useProjectStore.updateClip` and
 * `projectStorage`). Nothing here re-implements the logic under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Compositor } from '../core/engine/Compositor';
import {
  COLOR_FILTER_PRESETS,
  COLOR_FILTER_PRESET_ORDER,
  COLOR_FILTER_RANGES,
  COLOR_FILTER_UNSUPPORTED_MESSAGE,
  TEMPERATURE_OVERLAY_COOL,
  TEMPERATURE_OVERLAY_WARM,
  buildCssFilterString,
  clampFilterValue,
  detectCanvasFilterSupport,
  getCanvasFilterSupport,
  getColorFilterBuildCount,
  isNeutralColorFilters,
  matchColorFilterPreset,
  normalizeColorFilters,
  resetColorFilterBuildCount,
  resetCanvasFilterSupportCache,
  resolveColorFilter,
  type ColorFilterKey,
} from '../core/utils/colorFilters';
import { Clip, MediaItem, Track } from '../types/project';
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
/* Fake DOM                                                            */
/* ------------------------------------------------------------------ */

/** The base of the fake contexts. */
class Fake2DContextBase {
  /**
   * `filter` is an ACCESSOR on purpose: each subclass implements it the way
   * the browser it simulates does (a normal property or an accessor that
   * swallows the assignments).
   */
  private currentFilter = 'none';

  get filter(): string {
    return this.currentFilter;
  }

  set filter(value: string) {
    this.currentFilter = value;
  }

  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  fillStyle = '';
  strokeStyle = '';
  font = '';
  textAlign = '';
  textBaseline = '';
  lineWidth = 1;

  drawImageCalls: Array<{ source: unknown; filter: string; composite: string }> = [];
  fillRectCalls: Array<{
    x: number;
    y: number;
    w: number;
    h: number;
    fillStyle: string;
    globalAlpha: number;
    composite: string;
    filter: string;
  }> = [];

  private stack: Array<{
    filter: string;
    globalAlpha: number;
    composite: string;
    fillStyle: string;
  }> = [];

  save(): void {
    this.stack.push({
      filter: this.filter,
      globalAlpha: this.globalAlpha,
      composite: this.globalCompositeOperation,
      fillStyle: this.fillStyle,
    });
  }

  restore(): void {
    const state = this.stack.pop();
    if (!state) return;
    this.filter = state.filter;
    this.globalAlpha = state.globalAlpha;
    this.globalCompositeOperation = state.composite;
    this.fillStyle = state.fillStyle;
  }

  setTransform(): void {}
  beginPath(): void {}
  rect(): void {}
  clip(): void {}
  roundRect(): void {}
  fill(): void {}
  stroke(): void {}
  fillText(): void {}
  strokeText(): void {}
  measureText(): { width: number } {
    return { width: 10 };
  }

  drawImage(source: unknown): void {
    this.drawImageCalls.push({
      source,
      filter: this.filter,
      composite: this.globalCompositeOperation,
    });
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.fillRectCalls.push({
      x,
      y,
      w,
      h,
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
      composite: this.globalCompositeOperation,
      filter: this.filter,
    });
  }
}

/** A 2D context that supports `ctx.filter` (Chrome / Firefox / Safari 18+). */
class Fake2DContext extends Fake2DContextBase {}

/**
 * A context that ACCEPTS `ctx.filter` but IGNORES it: the behaviour of the
 * WebKit builds that made this feature necessary. The assignments are
 * recorded so the test can prove the compositor never even tries.
 */
class Fake2DContextIgnoringFilter extends Fake2DContextBase {
  filterAssignments: string[] = [];

  override get filter(): string {
    return 'none';
  }

  override set filter(value: string) {
    if (value !== 'none') this.filterAssignments.push(value);
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  readonly ctx: Fake2DContext;

  constructor(ctx: Fake2DContext) {
    this.ctx = ctx;
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

interface FakeDom {
  canvases: FakeCanvas[];
  /** Factory of the context of every created canvas. */
  contextFactory: () => Fake2DContext;
}

const dom: FakeDom = {
  canvases: [],
  contextFactory: () => new Fake2DContext(),
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

function makeMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media_1',
    name: 'Media 1',
    type: 'image',
    url: 'blob:media-1',
    duration: 5,
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

/** Renders one frame of the preview and returns the recording context. */
function renderPreviewFrame(
  clip: Clip,
  ctx: Fake2DContext,
  time = 0
): { canvas: FakeCanvas; ctx: Fake2DContext } {
  const canvas = new FakeCanvas(ctx);
  canvas.width = 640;
  canvas.height = 360;
  const compositor = new Compositor();
  compositor.renderFrame({
    time,
    canvas: canvas as unknown as HTMLCanvasElement,
    tracks: [videoTrack],
    clips: [clip],
    mediaPool: [makeMedia()],
    isPlaying: false,
  });
  return { canvas, ctx };
}

/** The filters the context had when the media of the clip was drawn. */
function filtersUsedForMedia(ctx: Fake2DContext): string[] {
  return ctx.drawImageCalls
    .filter((call) => call.source instanceof FakeImage)
    .map((call) => call.filter);
}

beforeEach(() => {
  installFakeDom();
  resetCanvasFilterSupportCache();
  resetColorFilterBuildCount();
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
  resetCanvasFilterSupportCache();
});

/* ================================================================== */
/* 1 · The model                                                       */
/* ================================================================== */

describe('F9 · el modelo de los filtros de color', () => {
  it('el clip guarda los filtros y el store los persiste (sin tocar el store)', () => {
    useProjectStore.getState().addClip(makeClip({ id: 'clip_store', type: 'video' }));

    useProjectStore.getState().updateClip('clip_store', {
      filters: { brightness: 1.4, contrast: 0.8, saturation: 1.2 },
    });

    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_store');
    expect(clip?.filters).toEqual({ brightness: 1.4, contrast: 0.8, saturation: 1.2 });
  });

  it('el store puede devolver el clip a neutral (reset)', () => {
    useProjectStore.getState().addClip(makeClip({ id: 'clip_reset', type: 'video' }));
    useProjectStore.getState().updateClip('clip_reset', { filters: { brightness: 1.4 } });

    useProjectStore.getState().updateClip('clip_reset', { filters: undefined });

    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_reset');
    expect(clip?.filters).toBeUndefined();
    expect(isNeutralColorFilters(clip?.filters)).toBe(true);
  });

  it('los filtros sobreviven a un guardado y una recarga del proyecto', async () => {
    const { saveProject, getProjectById } = await import('../core/storage/projectStorage');
    const project = useProjectStore.getState().project;
    project.clips.push(
      makeClip({ id: 'clip_saved', type: 'video', filters: { brightness: 1.25, sepia: 0.5 } })
    );

    await saveProject(project);

    const reloaded = await getProjectById(project.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.clips.find((c) => c.id === 'clip_saved')?.filters).toEqual({
      brightness: 1.25,
      sepia: 0.5,
    });
  });
});

/* ================================================================== */
/* 2 · Los presets                                                     */
/* ================================================================== */

describe('F9 · los presets de color', () => {
  it('existe exactamente los siete presets del producto', () => {
    expect([...COLOR_FILTER_PRESET_ORDER]).toEqual([
      'original',
      'warm',
      'cool',
      'blackWhite',
      'sepia',
      'cinematic',
      'vivid',
    ]);
    for (const id of COLOR_FILTER_PRESET_ORDER) {
      expect(COLOR_FILTER_PRESETS[id]).toBeDefined();
      expect(COLOR_FILTER_PRESETS[id].id).toBe(id);
      expect(COLOR_FILTER_PRESETS[id].label.length).toBeGreaterThan(0);
    }
  });

  it('las etiquetas de los presets están en español', () => {
    expect(COLOR_FILTER_PRESETS.original.label).toBe('Original');
    expect(COLOR_FILTER_PRESETS.warm.label).toBe('Cálido');
    expect(COLOR_FILTER_PRESETS.cool.label).toBe('Frío');
    expect(COLOR_FILTER_PRESETS.blackWhite.label).toBe('B/N');
    expect(COLOR_FILTER_PRESETS.sepia.label).toBe('Sepia');
    expect(COLOR_FILTER_PRESETS.cinematic.label).toBe('Cine');
    expect(COLOR_FILTER_PRESETS.vivid.label).toBe('Vívido');
  });

  it('cada preset usa valores dentro del rango de su filtro', () => {
    for (const id of COLOR_FILTER_PRESET_ORDER) {
      const filters = COLOR_FILTER_PRESETS[id].filters;
      for (const key of Object.keys(filters) as ColorFilterKey[]) {
        const value = filters[key]!;
        const range = COLOR_FILTER_RANGES[key];
        expect(value).toBeGreaterThanOrEqual(range.min);
        expect(value).toBeLessThanOrEqual(range.max);
      }
    }
  });

  it('"original" es neutral y los demás cambian algo', () => {
    expect(isNeutralColorFilters(COLOR_FILTER_PRESETS.original.filters)).toBe(true);
    for (const id of COLOR_FILTER_PRESET_ORDER) {
      if (id === 'original') continue;
      expect(isNeutralColorFilters(COLOR_FILTER_PRESETS[id].filters)).toBe(false);
    }
  });

  it('el preset se reconoce a partir de los valores del clip', () => {
    expect(matchColorFilterPreset(undefined)).toBe('original');
    expect(matchColorFilterPreset({})).toBe('original');
    expect(matchColorFilterPreset(COLOR_FILTER_PRESETS.vivid.filters)).toBe('vivid');
    expect(matchColorFilterPreset(COLOR_FILTER_PRESETS.cinematic.filters)).toBe('cinematic');
    // A custom combination matches nothing.
    expect(matchColorFilterPreset({ brightness: 1.37, contrast: 0.93 })).toBeNull();
  });
});

/* ================================================================== */
/* 3 · La cadena de filtros (helper puro)                             */
/* ================================================================== */

describe('F9 · la cadena de filtros CSS', () => {
  it('un clip sin filtros no genera ninguna cadena', () => {
    expect(buildCssFilterString(undefined)).toBe('');
    expect(buildCssFilterString(null)).toBe('');
    expect(buildCssFilterString({})).toBe('');
    expect(buildCssFilterString({ brightness: 1, contrast: 1, saturation: 1, grayscale: 0, sepia: 0 })).toBe('');
  });

  it('cada filtro produce su función CSS', () => {
    expect(buildCssFilterString({ brightness: 1.5 })).toBe('brightness(1.5)');
    expect(buildCssFilterString({ contrast: 0.75 })).toBe('contrast(0.75)');
    expect(buildCssFilterString({ saturation: 1.25 })).toBe('saturate(1.25)');
    expect(buildCssFilterString({ grayscale: 1 })).toBe('grayscale(1)');
    expect(buildCssFilterString({ sepia: 0.5 })).toBe('sepia(0.5)');
  });

  it('el orden de las funciones es siempre el mismo (preview == export)', () => {
    const filters = { sepia: 0.2, grayscale: 0.3, saturation: 1.2, contrast: 1.1, brightness: 0.9 };
    const expected = 'brightness(0.9) contrast(1.1) saturate(1.2) grayscale(0.3) sepia(0.2)';
    expect(buildCssFilterString(filters)).toBe(expected);
    // The same filters in another order give the SAME string.
    expect(
      buildCssFilterString({
        brightness: 0.9,
        contrast: 1.1,
        saturation: 1.2,
        grayscale: 0.3,
        sepia: 0.2,
      })
    ).toBe(expected);
  });

  it('los valores se acotan al rango y los inválidos se vuelven neutrales', () => {
    expect(buildCssFilterString({ brightness: 99 })).toBe('brightness(2)');
    expect(buildCssFilterString({ brightness: -5 })).toBe('brightness(0)');
    expect(buildCssFilterString({ saturation: Number.NaN })).toBe('');
    expect(buildCssFilterString({ contrast: Number.POSITIVE_INFINITY })).toBe('');
    expect(clampFilterValue('temperature', 5)).toBe(1);
    expect(clampFilterValue('temperature', -5)).toBe(-1);
    expect(clampFilterValue('grayscale', undefined)).toBe(0);
  });

  it('normalizeColorFilters limpia los valores corruptos de un proyecto importado', () => {
    expect(normalizeColorFilters({ brightness: 99, contrast: -3 })).toEqual({
      brightness: 2,
      contrast: 0,
    });
    // A neutral set of filters is normalised to "no filters".
    expect(normalizeColorFilters({ brightness: 1, contrast: 1 })).toBeUndefined();
    expect(normalizeColorFilters('nonsense')).toBeUndefined();
    expect(normalizeColorFilters(null)).toBeUndefined();
  });

  it('la temperatura se resuelve como una capa cálida/fría (no como CSS)', () => {
    const warm = resolveColorFilter({ temperature: 0.5 });
    expect(warm.css).toBe('');
    expect(warm.temperature).toBe(0.5);
    expect(warm.overlayColor).toBe(TEMPERATURE_OVERLAY_WARM);
    expect(warm.overlayAlpha).toBeGreaterThan(0);
    expect(warm.active).toBe(true);

    const cool = resolveColorFilter({ temperature: -0.5 });
    expect(cool.overlayColor).toBe(TEMPERATURE_OVERLAY_COOL);

    const neutral = resolveColorFilter({ brightness: 1.2 });
    expect(neutral.overlayColor).toBeNull();
    expect(neutral.overlayAlpha).toBe(0);
    expect(neutral.active).toBe(true);
    expect(resolveColorFilter(undefined).active).toBe(false);
  });
});

/* ================================================================== */
/* 4 · El preview (Compositor)                                         */
/* ================================================================== */

describe('F9 · el compositor aplica los filtros al clip', () => {
  it('el preview pinta el clip con el filtro CSS y lo restaura después', () => {
    const ctx = new Fake2DContext();
    renderPreviewFrame(makeClip({ filters: { brightness: 1.4, saturation: 1.2 } }), ctx);

    expect(filtersUsedForMedia(ctx)).toEqual(['brightness(1.4) saturate(1.2)']);
    // The filter must not leak into the rest of the frame.
    expect(ctx.filter).toBe('none');
  });

  it('un clip sin filtros nunca toca ctx.filter', () => {
    const ctx = new Fake2DContext();
    renderPreviewFrame(makeClip(), ctx);

    expect(filtersUsedForMedia(ctx)).toEqual(['none']);
    expect(ctx.filter).toBe('none');
  });

  it('la temperatura se pinta como una capa cálida con el modo "overlay"', () => {
    const ctx = new Fake2DContext();
    renderPreviewFrame(makeClip({ filters: { temperature: 0.6 } }), ctx);

    const overlay = ctx.fillRectCalls.find((call) => call.fillStyle === TEMPERATURE_OVERLAY_WARM);
    expect(overlay).toBeDefined();
    expect(overlay?.composite).toBe('overlay');
    expect(overlay?.globalAlpha).toBeGreaterThan(0);
    // The overlay is painted over the area of the clip.
    expect(overlay?.w).toBeGreaterThan(0);
    expect(overlay?.h).toBeGreaterThan(0);
  });

  it('sin temperatura no se pinta ninguna capa de color', () => {
    const ctx = new Fake2DContext();
    renderPreviewFrame(makeClip({ filters: { brightness: 1.2 } }), ctx);

    expect(ctx.fillRectCalls.some((call) => call.fillStyle === TEMPERATURE_OVERLAY_WARM)).toBe(false);
    expect(ctx.fillRectCalls.some((call) => call.fillStyle === TEMPERATURE_OVERLAY_COOL)).toBe(false);
  });

  it('el filtro se construye UNA sola vez por clip (no en cada fotograma)', () => {
    const ctx = new Fake2DContext();
    const clip = makeClip({ filters: { brightness: 1.4 } });
    const compositor = new Compositor();
    const canvas = new FakeCanvas(ctx);
    canvas.width = 640;
    canvas.height = 360;

    for (let frame = 0; frame < 20; frame++) {
      compositor.renderFrame({
        time: frame * 0.1,
        canvas: canvas as unknown as HTMLCanvasElement,
        tracks: [videoTrack],
        clips: [clip],
        mediaPool: [makeMedia()],
        isPlaying: false,
      });
    }

    // 20 frames, ONE build of the filter string.
    expect(getColorFilterBuildCount()).toBe(1);
  });

  it('cambiar el valor de un filtro reconstruye la cadena', () => {
    const ctx = new Fake2DContext();
    const clip = makeClip({ filters: { brightness: 1.4 } });
    const compositor = new Compositor();
    const canvas = new FakeCanvas(ctx);
    canvas.width = 640;
    canvas.height = 360;

    compositor.renderFrame({
      time: 0,
      canvas: canvas as unknown as HTMLCanvasElement,
      tracks: [videoTrack],
      clips: [clip],
      mediaPool: [makeMedia()],
      isPlaying: false,
    });
    expect(getColorFilterBuildCount()).toBe(1);

    clip.filters = { brightness: 1.8 };
    compositor.renderFrame({
      time: 0.1,
      canvas: canvas as unknown as HTMLCanvasElement,
      tracks: [videoTrack],
      clips: [clip],
      mediaPool: [makeMedia()],
      isPlaying: false,
    });

    expect(getColorFilterBuildCount()).toBe(2);
    expect(filtersUsedForMedia(ctx)).toContain('brightness(1.8)');
  });
});

/* ================================================================== */
/* 5 · El fallback (ctx.filter no disponible)                          */
/* ================================================================== */

describe('F9 · fallback cuando el navegador no soporta ctx.filter', () => {
  it('la detección avisa a los navegadores que ignoran el filtro', () => {
    const ctx = new Fake2DContextIgnoringFilter();
    expect(detectCanvasFilterSupport(ctx as unknown as CanvasRenderingContext2D)).toBe(false);

    const supported = new Fake2DContext();
    expect(detectCanvasFilterSupport(supported as unknown as CanvasRenderingContext2D)).toBe(true);
  });

  it('el estado de soporte se expone a la interfaz (se detecta una sola vez)', () => {
    dom.contextFactory = () => new Fake2DContext();
    resetCanvasFilterSupportCache();
    expect(getCanvasFilterSupport()).toBe(true);

    // The probe is cached: changing the environment does not change the answer.
    dom.contextFactory = () => new Fake2DContextIgnoringFilter();
    expect(getCanvasFilterSupport()).toBe(true);

    resetCanvasFilterSupportCache();
    expect(getCanvasFilterSupport()).toBe(false);
  });

  it('sin soporte NO se aplica ningún filtro (ni CSS ni temperatura)', () => {
    dom.contextFactory = () => new Fake2DContextIgnoringFilter();
    resetCanvasFilterSupportCache();

    const ctx = new Fake2DContextIgnoringFilter();
    renderPreviewFrame(
      makeClip({ filters: { brightness: 1.5, saturation: 1.4, temperature: 0.8 } }),
      ctx
    );

    // The compositor never even tries to set a filter...
    expect(ctx.filterAssignments).toEqual([]);
    // ... and no temperature layer is painted either.
    expect(ctx.fillRectCalls.some((c) => c.fillStyle === TEMPERATURE_OVERLAY_WARM)).toBe(false);
    expect(ctx.fillRectCalls.some((c) => c.fillStyle === TEMPERATURE_OVERLAY_COOL)).toBe(false);
  });

  it('el mensaje de aviso explica por qué están desactivados los controles', () => {
    expect(COLOR_FILTER_UNSUPPORTED_MESSAGE).toMatch(/no soporta los filtros de color/i);
    expect(COLOR_FILTER_UNSUPPORTED_MESSAGE.length).toBeGreaterThan(40);
  });
});

/* ================================================================== */
/* 6 · El contrato real: preview == export                             */
/* ================================================================== */

describe('F9 · preview == export (el contrato real de la feature)', () => {
  it('el export aplica EXACTAMENTE el mismo filtro que el preview', async () => {
    installFakeWebCodecs();
    const { exportVideo, resolveClipColorFilter } = await import('../core/export/webcodecsExporter');

    const clip = makeClip({
      id: 'clip_parity',
      filters: { brightness: 1.4, saturation: 1.25, grayscale: 0.2 },
    });

    /* --- PREVIEW: el compositor del preview --- */
    const previewCtx = new Fake2DContext();
    renderPreviewFrame(clip, previewCtx);
    const previewFilters = filtersUsedForMedia(previewCtx);
    expect(previewFilters).toEqual(['brightness(1.4) saturate(1.25) grayscale(0.2)']);

    /* --- EXPORT: el exportador real (mismo Compositor) --- */
    const blob = await exportVideo({
      config: {
        aspectRatio: '16:9',
        width: 640,
        height: 360,
        fps: 30,
        bitrate: 2_000_000,
        format: 'mp4',
      },
      duration: 0.2,
      tracks: [videoTrack],
      clips: [clip],
      mediaPool: [makeMedia()],
      onProgress: () => {},
    });
    expect(blob.size).toBeGreaterThan(0);

    const exportFilters = dom.canvases.flatMap((canvas) => filtersUsedForMedia(canvas.ctx));
    expect(exportFilters.length).toBeGreaterThan(0);
    expect(exportFilters[0]).toBe(previewFilters[0]);

    // And the exported filter is the one the production helper builds.
    expect(resolveClipColorFilter(clip)).toBe(previewFilters[0]);
  });

  it('un clip sin filtros se exporta sin filtrar (igual que el preview)', async () => {
    installFakeWebCodecs();
    const { exportVideo, resolveClipColorFilter } = await import('../core/export/webcodecsExporter');

    const clip = makeClip({ id: 'clip_no_filters' });
    const previewCtx = new Fake2DContext();
    renderPreviewFrame(clip, previewCtx);
    expect(filtersUsedForMedia(previewCtx)).toEqual(['none']);

    await exportVideo({
      config: {
        aspectRatio: '16:9',
        width: 640,
        height: 360,
        fps: 30,
        bitrate: 2_000_000,
        format: 'mp4',
      },
      duration: 0.2,
      tracks: [videoTrack],
      clips: [clip],
      mediaPool: [makeMedia()],
      onProgress: () => {},
    });

    const exportFilters = dom.canvases.flatMap((canvas) => filtersUsedForMedia(canvas.ctx));
    expect(exportFilters.length).toBeGreaterThan(0);
    expect(exportFilters[0]).toBe('none');
    expect(resolveClipColorFilter(clip)).toBe('');
  });

  it('si el navegador no soporta ctx.filter, el export tampoco filtra', async () => {
    dom.contextFactory = () => new Fake2DContextIgnoringFilter();
    resetCanvasFilterSupportCache();
    installFakeWebCodecs();
    const { exportVideo, resolveClipColorFilter } = await import('../core/export/webcodecsExporter');

    const clip = makeClip({ id: 'clip_unsupported', filters: { brightness: 1.5 } });
    expect(resolveClipColorFilter(clip)).toBe('');

    await exportVideo({
      config: {
        aspectRatio: '16:9',
        width: 640,
        height: 360,
        fps: 30,
        bitrate: 2_000_000,
        format: 'mp4',
      },
      duration: 0.2,
      tracks: [videoTrack],
      clips: [clip],
      mediaPool: [makeMedia()],
      onProgress: () => {},
    });

    const exportFilters = dom.canvases.flatMap((canvas) => filtersUsedForMedia(canvas.ctx));
    expect(exportFilters.length).toBeGreaterThan(0);
    expect(exportFilters[0]).toBe('none');
  });
});

/* ================================================================== */
/* 7 · El Inspector                                                    */
/* ================================================================== */

describe('F9 · el Inspector ofrece los controles de color', () => {
  const inspector = readFileSync(
    new URL('../components/inspector/ClipInspector.tsx', import.meta.url),
    'utf8'
  );

  it('tiene una sección de color con presets y los seis deslizadores', () => {
    expect(inspector).toContain('titulo="Color"');
    expect(inspector).toContain('COLOR_FILTER_PRESET_ORDER');
    expect(inspector).toContain('COLOR_FILTER_PRESETS');
    for (const label of [
      'Brillo del clip',
      'Contraste del clip',
      'Saturación del clip',
      'Temperatura del clip',
      'Blanco y negro del clip',
      'Sepia del clip',
    ]) {
      expect(inspector).toContain(label);
    }
  });

  it('los controles son accesibles (aria-label) y están en español', () => {
    expect(inspector).toContain('aria-label="Preajuste de color del clip"');
    expect(inspector).toContain('aria-label="Restablecer los filtros de color del clip"');
    expect(inspector).toContain('Preajuste de color:');
    expect(inspector).toContain('Restablecer color');
  });

  it('los controles se desactivan con una explicación si ctx.filter no existe', () => {
    expect(inspector).toContain('getCanvasFilterSupport');
    expect(inspector).toContain('COLOR_FILTER_UNSUPPORTED_MESSAGE');
    expect(inspector).toContain('disabled={!colorFiltersEnabled}');
    expect(inspector).toContain('clip-color-unsupported');
  });

  it('los cambios se escriben en el clip (no en un estado local)', () => {
    expect(inspector).toMatch(/updateClip\(clip\.id, \{ filters:/);
    expect(inspector).toMatch(/filters: undefined/);
  });
});
