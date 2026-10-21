/**
 * Rotación / volteo / recorte (encuadre) de un clip — suite de regresión.
 *
 * Cubre el cierre del hueco P0 (rotar / voltear / recortar):
 *
 *   1. la geometría es matemática pura (`src/core/utils/clipTransform.ts`):
 *      rectángulo de destino rotado/ajustado y rectángulo de origen del
 *      recorte, probados de forma exhaustiva
 *      (0/90/180/270 × flipH × flipV; presets sobre 16:9, 9:16, 1:1 y 4:5;
 *      fuente más ancha, más alta o cuadrada);
 *   2. el `Compositor` dibuja el clip rotado sobre su centro, DENTRO de su
 *      caja (la caja no crece), y compone con posición/escala, fundidos de
 *      borde y fundido de cruce;
 *   3. el contrato duro del proyecto: preview ≡ export (el MISMO `Compositor`
 *      pinta en ambos caminos; el test compara lo que dibuja uno y otro);
 *   4. el camino caliente no recalcula por fotograma (caché por clip, como
 *      los filtros y los keyframes) y los valores son deshacibles y
 *      sobreviven al trim y al movimiento.
 *
 * Orden elegido: PRIMERO voltear (en el espacio de la fuente) y DESPUÉS
 * rotar en sentido horario. Así `flipH` siempre espeja la izquierda y la
 * derecha de la fuente original, sin importar la rotación; el orden
 * contrario haría que `flipH` espejase ejes distintos según el ángulo y el
 * control mentiría con 90°/270°.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Compositor } from '../core/engine/Compositor';
import {
  CLIP_ROTATIONS,
  CROP_PRESET_ASPECTS,
  CROP_PRESET_LABELS,
  CROP_PRESET_ORDER,
  applyPointTransform,
  cropPresetForSource,
  cropResultAspect,
  formatCropAspect,
  getClipTransformBuildCount,
  isNeutralCrop,
  isNeutralVisualTransform,
  matchCropPreset,
  normalizeCrop,
  resetClipTransformBuildCount,
  resolveCanvasTransform,
  resolveClipVisualTransform,
  resolveCropSource,
  resolveFittedSize,
  sanitizeFlip,
  sanitizeRotation,
  swapsAxes,
  type CropPresetId,
} from '../core/utils/clipTransform';
import type { Clip, MediaItem, Track } from '../types/project';
import { useProjectStore } from '../store/useProjectStore';

/* ------------------------------------------------------------------ */
/* In-memory IndexedDB (la capa de almacenamiento escribe vía idb-keyval) */
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
/* Dobles de test (el mismo patrón que color-filters.test.ts)          */
/* ------------------------------------------------------------------ */

class Fake2DContext {
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

  translateCalls: Array<{ x: number; y: number }> = [];
  rotateCalls: number[] = [];
  scaleCalls: Array<{ x: number; y: number }> = [];
  drawImageCalls: Array<{
    args: unknown[];
    alpha: number;
    filter: string;
    composite: string;
  }> = [];
  fillRectCalls: Array<{ x: number; y: number; w: number; h: number }> = [];

  private stack: Array<{ filter: string; globalAlpha: number }> = [];

  save(): void {
    this.stack.push({ filter: this.filter, globalAlpha: this.globalAlpha });
  }

  restore(): void {
    const state = this.stack.pop();
    if (!state) return;
    this.filter = state.filter;
    this.globalAlpha = state.globalAlpha;
  }

  setTransform(): void {}
  beginPath(): void {}
  rect(): void {}
  clip(): void {}
  fill(): void {}
  stroke(): void {}
  fillText(): void {}
  strokeText(): void {}
  measureText(): { width: number } {
    return { width: 10 };
  }

  translate(x: number, y: number): void {
    this.translateCalls.push({ x, y });
  }

  rotate(angle: number): void {
    this.rotateCalls.push(angle);
  }

  scale(x: number, y: number): void {
    this.scaleCalls.push({ x, y });
  }

  drawImage(...args: unknown[]): void {
    this.drawImageCalls.push({
      args,
      alpha: this.globalAlpha,
      filter: this.filter,
      composite: this.globalCompositeOperation,
    });
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.fillRectCalls.push({ x, y, w, h });
  }
}

/** Contexto mínimo: sin translate/rotate/scale (navegador antiguo). */
class Fake2DContextLegacy {
  globalAlpha = 1;
  fillStyle = '';
  drawImageCalls: unknown[][] = [];

  save(): void {}
  restore(): void {}
  setTransform(): void {}
  beginPath(): void {}
  rect(): void {}
  clip(): void {}
  fillRect(): void {}
  fillText(): void {}
  strokeText(): void {}
  measureText(): { width: number } {
    return { width: 10 };
  }

  drawImage(...args: unknown[]): void {
    this.drawImageCalls.push(args);
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

const dom = {
  canvases: [] as FakeCanvas[],
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
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        const canvas = new FakeCanvas(new Fake2DContext());
        dom.canvases.push(canvas);
        return canvas;
      }
      return {} as HTMLElement;
    },
    body: { appendChild: () => {}, removeChild: () => {} },
  };
  (globalThis as Record<string, unknown>).Image = FakeImage;
  (globalThis as Record<string, unknown>).HTMLVideoElement = class {};
}

/** WebCodecs falso (el exportador lo necesita; patrón de color-filters). */
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
  name: 'Vídeo 1',
  type: 'video',
  isMuted: false,
  isLocked: false,
  isVisible: true,
};

function renderPreviewFrame(
  clip: Clip,
  ctx: Fake2DContext,
  time = 0,
  clips: Clip[] = [clip]
): { canvas: FakeCanvas; ctx: Fake2DContext } {
  const canvas = new FakeCanvas(ctx);
  canvas.width = 640;
  canvas.height = 360;
  const compositor = new Compositor();
  compositor.renderFrame({
    time,
    canvas: canvas as unknown as HTMLCanvasElement,
    tracks: [videoTrack],
    clips,
    mediaPool: [makeMedia()],
    isPlaying: false,
  });
  return { canvas, ctx };
}

/** Llamadas de dibujado del medio (no del fondo): las de 9 argumentos. */
function mediaDraws(ctx: Fake2DContext): Array<{ args: unknown[]; alpha: number }> {
  return ctx.drawImageCalls.filter((call) => call.args.length === 9);
}

beforeEach(() => {
  installFakeDom();
  resetClipTransformBuildCount();
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
});

/* ================================================================== */
/* 1 · El modelo: rotación                                             */
/* ================================================================== */

describe('rotación · el modelo solo admite ángulos rectos', () => {
  it('acepta 0/90/180/270 y nada más', () => {
    expect(CLIP_ROTATIONS).toEqual([0, 90, 180, 270]);
    expect(sanitizeRotation(0)).toBe(0);
    expect(sanitizeRotation(90)).toBe(90);
    expect(sanitizeRotation(180)).toBe(180);
    expect(sanitizeRotation(270)).toBe(270);
  });

  it('los ángulos libres, negativos o corruptos son 0° (sin rotar)', () => {
    expect(sanitizeRotation(45)).toBe(0);
    expect(sanitizeRotation(-90)).toBe(0);
    expect(sanitizeRotation(360)).toBe(0);
    expect(sanitizeRotation(Number.NaN)).toBe(0);
    expect(sanitizeRotation(undefined)).toBe(0);
    expect(sanitizeRotation('90')).toBe(0);
    expect(sanitizeRotation(null)).toBe(0);
  });

  it('el volteo es booleano estricto', () => {
    expect(sanitizeFlip(true)).toBe(true);
    expect(sanitizeFlip(false)).toBe(false);
    expect(sanitizeFlip(undefined)).toBe(false);
    expect(sanitizeFlip(1)).toBe(false);
    expect(sanitizeFlip('sí')).toBe(false);
  });

  it('sin rotación ni volteo ni recorte la transformación es neutral', () => {
    expect(isNeutralVisualTransform(makeClip())).toBe(true);
    expect(isNeutralVisualTransform(makeClip({ rotation: 0, flipH: false }))).toBe(true);
    expect(isNeutralVisualTransform(makeClip({ rotation: 90 }))).toBe(false);
    expect(isNeutralVisualTransform(makeClip({ flipH: true }))).toBe(false);
    expect(isNeutralVisualTransform(makeClip({ flipV: true }))).toBe(false);
    expect(
      isNeutralVisualTransform(makeClip({ crop: { top: 0, right: 0, bottom: 0, left: 0.1 } }))
    ).toBe(false);
  });
});

/* ================================================================== */
/* 2 · Orden volteo→rotación (las 16 combinaciones)                    */
/* ================================================================== */

describe('volteo+rotación · el orden es voltear primero y rotar después', () => {
  it('el lienzo recibe la rotación en radianes y el volteo como escala', () => {
    for (const rotation of CLIP_ROTATIONS) {
      for (const flipH of [false, true]) {
        for (const flipV of [false, true]) {
          const t = resolveCanvasTransform(rotation, flipH, flipV);
          expect(t.rotateRadians).toBeCloseTo((rotation * Math.PI) / 180, 12);
          expect(t.scaleX).toBe(flipH ? -1 : 1);
          expect(t.scaleY).toBe(flipV ? -1 : 1);
        }
      }
    }
  });

  it('el punto (1,0) con flipH y 90° acaba en (0,-1): el volteo va primero', () => {
    // Volteo primero: (1,0) → (-1,0); rotación horaria 90°: (-1,0) → (0,-1).
    // Con el orden contrario (rotar y luego voltear) acabaría en (0,1).
    const p = applyPointTransform(1, 0, 90, true, false);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(-1, 12);
  });

  it('el orden se nota en las 4 esquinas con 270° y volteo vertical', () => {
    // Volteo V primero: (x,y) → (x,-y); rotación horaria 270°: (x,y) → (y,-x).
    // Combinado: (1,0) → (1,0) → (0,-1).
    const p = applyPointTransform(1, 0, 270, false, true);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(-1, 12);
    // Sin volteo, 270° lleva (1,0) a (0,1)… no, a (0,-1)… se comprueba:
    const q = applyPointTransform(1, 0, 270, false, false);
    expect(q.x).toBeCloseTo(0, 12);
    expect(q.y).toBeCloseTo(-1, 12);
    // …y con volteo V sí cambia el resultado en otro punto:
    const r = applyPointTransform(0, 1, 270, false, true);
    // (0,1) → volteo V → (0,-1) → rot 270° (x,y)→(y,-x) → (-1, 0).
    expect(r.x).toBeCloseTo(-1, 12);
    expect(r.y).toBeCloseTo(0, 12);
  });

  it('solo 90°/270° intercambian los ejes', () => {
    expect(swapsAxes(0)).toBe(false);
    expect(swapsAxes(90)).toBe(true);
    expect(swapsAxes(180)).toBe(false);
    expect(swapsAxes(270)).toBe(true);
  });
});

/* ================================================================== */
/* 3 · Caja de destino rotada/ajustada (matemática pura)               */
/* ================================================================== */

describe('caja de destino · la rotación vive dentro de su caja', () => {
  it('sin rotar ajusta la fuente al lienzo (contener)', () => {
    // Fuente 16:9 en lienzo 16:9: ocupa todo.
    expect(resolveFittedSize(1920, 1080, 1920, 1080, 1, 0)).toEqual({ w: 1920, h: 1080 });
    // Fuente más alta (9:16) en lienzo 16:9: manda la altura.
    const tall = resolveFittedSize(1920, 1080, 1080, 1920, 1, 0);
    expect(tall.h).toBe(1080);
    expect(tall.w).toBeCloseTo(1080 * (1080 / 1920), 9);
    // Fuente más ancha (21:9) en lienzo 16:9: manda la anchura.
    const wide = resolveFittedSize(1920, 1080, 2560, 1080, 1, 0);
    expect(wide.w).toBe(1920);
    expect(wide.h).toBeCloseTo(1920 * (1080 / 2560), 9);
    // Fuente cuadrada en lienzo 16:9: manda la altura.
    const square = resolveFittedSize(1920, 1080, 800, 800, 1, 0);
    expect(square).toEqual({ w: 1080, h: 1080 });
  });

  it('con 90°/270° la fuente se ajusta con los ejes cambiados', () => {
    // 1920×1080 rotado 90° se comporta como 1080×1920 (9:16).
    const rot90 = resolveFittedSize(1920, 1080, 1920, 1080, 1, 90);
    expect(rot90.h).toBe(1080);
    expect(rot90.w).toBeCloseTo(1080 * (1080 / 1920), 9);
    const rot270 = resolveFittedSize(1920, 1080, 1920, 1080, 1, 270);
    expect(rot270).toEqual(rot90);
    // 180° no cambia la caja.
    expect(resolveFittedSize(1920, 1080, 1920, 1080, 1, 180)).toEqual({ w: 1920, h: 1080 });
    // Fuente cuadrada: rotar no cambia nada.
    expect(resolveFittedSize(1920, 1080, 800, 800, 1, 90)).toEqual({ w: 1080, h: 1080 });
  });

  it('la escala multiplica la caja ajustada (también rotada)', () => {
    const box = resolveFittedSize(1920, 1080, 1920, 1080, 2, 90);
    expect(box.h).toBe(2160);
    expect(box.w).toBeCloseTo(2160 * (1080 / 1920), 9);
  });

  it('las dimensiones degeneradas no rompen el ajuste', () => {
    for (const box of [
      resolveFittedSize(0, 0, 640, 360, 1, 0),
      resolveFittedSize(640, 360, 0, 0, 1, 90),
      resolveFittedSize(640, 360, 640, 360, Number.NaN, 0),
      resolveFittedSize(-100, 360, 640, 360, 1, 270),
    ]) {
      expect(Number.isFinite(box.w)).toBe(true);
      expect(Number.isFinite(box.h)).toBe(true);
      expect(box.w).toBeGreaterThan(0);
      expect(box.h).toBeGreaterThan(0);
    }
  });
});

/* ================================================================== */
/* 4 · Recorte: del modelo al rectángulo de origen                    */
/* ================================================================== */

describe('recorte · el modelo son fracciones eliminadas por lado', () => {
  it('sin recorte el origen es la fuente completa', () => {
    expect(resolveCropSource(640, 360, undefined)).toEqual({ sx: 0, sy: 0, sw: 640, sh: 360 });
    expect(resolveCropSource(640, 360, { top: 0, right: 0, bottom: 0, left: 0 })).toEqual({
      sx: 0,
      sy: 0,
      sw: 640,
      sh: 360,
    });
  });

  it('cada lado elimina su fracción de la fuente', () => {
    // Quitar el 10 % de la izquierda y el 20 % de arriba de 1000×500.
    expect(
      resolveCropSource(1000, 500, { top: 0.2, right: 0, bottom: 0, left: 0.1 })
    ).toEqual({ sx: 100, sy: 100, sw: 900, sh: 400 });
    expect(
      resolveCropSource(1000, 500, { top: 0.1, right: 0.25, bottom: 0.1, left: 0.25 })
    ).toEqual({ sx: 250, sy: 50, sw: 500, sh: 400 });
  });

  it('los valores se acotan a 0..1 y la suma por eje a menos del total', () => {
    expect(isNeutralCrop(undefined)).toBe(true);
    expect(isNeutralCrop({ top: 0, right: 0, bottom: 0, left: 0 })).toBe(true);
    expect(isNeutralCrop({ top: 0, right: 0, bottom: 0, left: 0.01 })).toBe(false);
    // Basura fuera de rango se acota y el eje saturado se reescala en
    // proporción (right 1 + left 0,1 suman 1,1 ≥ 1: ambos se encogen ×0,909).
    const clamped = normalizeCrop({ top: -5, right: 99, bottom: NaN, left: 0.1 });
    expect(clamped?.top).toBe(0);
    expect(clamped?.bottom).toBe(0);
    expect(clamped!.left + clamped!.right).toBeLessThan(1);
    expect(clamped!.right).toBeCloseTo(0.90909, 5);
    expect(clamped!.left).toBeCloseTo(0.090909, 5);
    // left+right >= 1 se reescala en proporción (el centro manda).
    const overfull = normalizeCrop({ top: 0, right: 0.8, bottom: 0, left: 0.8 });
    expect(overfull).toBeDefined();
    expect(overfull!.left + overfull!.right).toBeLessThan(1);
    expect(overfull!.left).toBeCloseTo(overfull!.right, 12);
    expect(normalizeCrop('basura')).toBeUndefined();
    expect(normalizeCrop(null)).toBeUndefined();
  });

  it('el aspecto resultante describe lo que se encuadra', () => {
    expect(cropResultAspect(1920, 1080, undefined)).toBeCloseTo(16 / 9, 9);
    expect(
      cropResultAspect(1920, 1080, { top: 0, right: 0.25, bottom: 0, left: 0.25 })
    ).toBeCloseTo(8 / 9, 9);
    expect(formatCropAspect(16 / 9)).toBe('16:9');
    expect(formatCropAspect(9 / 16)).toBe('9:16');
    expect(formatCropAspect(1)).toBe('1:1');
    expect(formatCropAspect(4 / 5)).toBe('4:5');
    // Un aspecto libre se muestra con coma decimal (norma de copy).
    expect(formatCropAspect(2)).toBe('2,00:1');
  });
});

/* ================================================================== */
/* 5 · Presets de recorte (centrados, desde el aspecto de la fuente)   */
/* ================================================================== */

describe('recorte · presets centrados desde la fuente', () => {
  it('existen los cinco presets del producto, en español', () => {
    expect([...CROP_PRESET_ORDER]).toEqual(['original', '16:9', '9:16', '1:1', '4:5']);
    expect(CROP_PRESET_LABELS.original).toBe('Original');
    expect(CROP_PRESET_ASPECTS['16:9']).toBeCloseTo(16 / 9, 12);
    expect(CROP_PRESET_ASPECTS['9:16']).toBeCloseTo(9 / 16, 12);
    expect(CROP_PRESET_ASPECTS['1:1']).toBe(1);
    expect(CROP_PRESET_ASPECTS['4:5']).toBeCloseTo(4 / 5, 12);
  });

  it('«Original» no recorta nada', () => {
    expect(cropPresetForSource(1920, 1080, 'original')).toBeUndefined();
    expect(cropPresetForSource(1080, 1920, 'original')).toBeUndefined();
  });

  it.each([
    ['16:9', 1920, 1080],
    ['9:16', 1080, 1920],
    ['1:1', 800, 800],
    ['4:5', 800, 1000],
  ] as Array<[CropPresetId, number, number]>)(
    'el preset %s sobre su propio aspecto no recorta',
    (preset, w, h) => {
      expect(cropPresetForSource(w, h, preset)).toBeUndefined();
    }
  );

  it('cada preset encuadra su aspecto sobre fuente más ancha, más alta y cuadrada', () => {
    const sources: Array<[string, number, number]> = [
      ['ancha 16:9', 1920, 1080],
      ['alta 9:16', 1080, 1920],
      ['cuadrada 1:1', 1000, 1000],
      ['4:5', 800, 1000],
    ];
    const presets: Array<Exclude<CropPresetId, 'original'>> = ['16:9', '9:16', '1:1', '4:5'];
    for (const [label, w, h] of sources) {
      for (const preset of presets) {
        const crop = cropPresetForSource(w, h, preset);
        if (crop === undefined) continue; // mismo aspecto: nada que recortar
        const aspect = cropResultAspect(w, h, crop);
        expect(aspect, `${label} → ${preset}`).toBeCloseTo(CROP_PRESET_ASPECTS[preset], 6);
        // Centrado: lo quitado a un lado es lo quitado al otro.
        expect(crop.left, `${label} → ${preset} (lados)`).toBeCloseTo(crop.right, 12);
        expect(crop.top, `${label} → ${preset} (arriba/abajo)`).toBeCloseTo(crop.bottom, 12);
        // Solo se recorta un eje (el otro queda intacto).
        const trimsSides = crop.left + crop.right > 1e-9;
        const trimsTopBottom = crop.top + crop.bottom > 1e-9;
        expect(
          trimsSides !== trimsTopBottom || (!trimsSides && !trimsTopBottom),
          `${label} → ${preset}: un solo eje`
        ).toBe(true);
      }
    }
  });

  it('el preset se reconoce desde los valores del clip', () => {
    expect(matchCropPreset(1920, 1080, undefined)).toBe('original');
    const vertical = cropPresetForSource(1920, 1080, '9:16');
    expect(vertical).toBeDefined();
    expect(matchCropPreset(1920, 1080, vertical)).toBe('9:16');
    expect(
      matchCropPreset(1920, 1080, { top: 0.07, right: 0.31, bottom: 0.02, left: 0.29 })
    ).toBeNull();
  });
});

/* ================================================================== */
/* 6 · El Compositor dibuja rotación y volteo                          */
/* ================================================================== */

describe('compositor · rotación y volteo dentro de la caja', () => {
  it('un clip neutral no toca translate/rotate/scale (cero sobrecoste)', () => {
    const ctx = new Fake2DContext();
    renderPreviewFrame(makeClip(), ctx);

    expect(ctx.translateCalls).toEqual([]);
    expect(ctx.rotateCalls).toEqual([]);
    expect(ctx.scaleCalls).toEqual([]);
    // El dibujado histórico (fuente completa a la caja: origen + 4 números).
    const draws = ctx.drawImageCalls.filter((call) => call.args.length === 5);
    expect(draws.length).toBeGreaterThan(0);
  });

  it('90° rota sobre el centro de la caja sin cambiar la caja', () => {
    const plainCtx = new Fake2DContext();
    renderPreviewFrame(makeClip(), plainCtx);
    const plainBox = plainCtx.fillRectCalls[0];
    expect(plainBox).toBeDefined();

    const ctx = new Fake2DContext();
    renderPreviewFrame(makeClip({ rotation: 90 }), ctx);

    // Una rotación horaria de un cuarto de vuelta sobre el centro.
    expect(ctx.rotateCalls).toHaveLength(1);
    expect(ctx.rotateCalls[0]).toBeCloseTo(Math.PI / 2, 12);
    expect(ctx.translateCalls).toHaveLength(1);
    // El centro es el de la caja sin rotar (misma posición y escala).
    expect(ctx.translateCalls[0].x).toBeCloseTo(plainBox.w / 2, 9);
    expect(ctx.translateCalls[0].y).toBeCloseTo(plainBox.h / 2, 9);
    // La caja del lienzo no crece: el fondo mide lo mismo.
    expect(ctx.fillRectCalls[0]).toEqual(plainBox);
  });

  it('180° y 270° usan su ángulo exacto', () => {
    const ctx180 = new Fake2DContext();
    renderPreviewFrame(makeClip({ rotation: 180 }), ctx180);
    expect(ctx180.rotateCalls).toHaveLength(1);
    expect(ctx180.rotateCalls[0]).toBeCloseTo(Math.PI, 12);

    const ctx270 = new Fake2DContext();
    renderPreviewFrame(makeClip({ rotation: 270 }), ctx270);
    expect(ctx270.rotateCalls).toHaveLength(1);
    expect(ctx270.rotateCalls[0]).toBeCloseTo((3 * Math.PI) / 2, 12);
  });

  it('el volteo horizontal y vertical llegan como escala negativa', () => {
    const ctxH = new Fake2DContext();
    renderPreviewFrame(makeClip({ flipH: true }), ctxH);
    expect(ctxH.scaleCalls).toEqual([{ x: -1, y: 1 }]);
    expect(ctxH.rotateCalls).toEqual([]);

    const ctxV = new Fake2DContext();
    renderPreviewFrame(makeClip({ flipV: true }), ctxV);
    expect(ctxV.scaleCalls).toEqual([{ x: 1, y: -1 }]);

    const ctxBoth = new Fake2DContext();
    renderPreviewFrame(makeClip({ flipH: true, flipV: true, rotation: 180 }), ctxBoth);
    expect(ctxBoth.scaleCalls).toEqual([{ x: -1, y: -1 }]);
    expect(ctxBoth.rotateCalls[0]).toBeCloseTo(Math.PI, 12);
  });

  it('la rotación compone con la posición y la escala del clip', () => {
    const ctx = new Fake2DContext();
    renderPreviewFrame(makeClip({ rotation: 90, positionX: 40, scale: 2 }), ctx);

    // El centro se desplaza con la posición…
    expect(ctx.translateCalls[0].x).toBeCloseTo(640 / 2 + 40, 9);
    expect(ctx.translateCalls[0].y).toBeCloseTo(360 / 2, 9);
    // …y el destino local intercambia los ejes (90°), con la escala aplicada.
    // Sin recorte el dibujado es de 5 argumentos (fuente completa en local).
    expect(ctx.drawImageCalls).toHaveLength(1);
    const dest = ctx.drawImageCalls[0].args.slice(1) as number[];
    // Caja: 640×360 rotado (ejes 360×640) ajustado a 202,5×360, con escala 2
    // → 405×720; en local (ejes cambiados): 720×405 centrado.
    expect(dest[0]).toBeCloseTo(-360, 9);
    expect(dest[1]).toBeCloseTo(-202.5, 9);
    expect(dest[2]).toBeCloseTo(720, 9);
    expect(dest[3]).toBeCloseTo(405, 9);
  });

  it('la rotación compone con la opacidad y el fundido de borde', () => {
    const ctx = new Fake2DContext();
    renderPreviewFrame(
      makeClip({
        rotation: 90,
        opacity: 0.5,
        transition: {
          fadeInType: 'fade-black',
          fadeInDuration: 2,
          fadeOutType: 'none',
          fadeOutDuration: 0,
        },
      }),
      ctx,
      0.5
    );

    const draws = ctx.drawImageCalls;
    expect(draws).toHaveLength(1);
    // La opacidad manda (el fundido a negro es una capa, no un alfa).
    expect(draws[0].alpha).toBeCloseTo(0.5, 9);
    expect(ctx.rotateCalls).toHaveLength(1);
  });

  it('la rotación compone con el fundido de cruce (alfa × alfa)', () => {
    const earlier = makeClip({
      id: 'clip_a',
      start: 0,
      duration: 2,
      transition: {
        fadeInType: 'none',
        fadeInDuration: 0,
        fadeOutType: 'none',
        fadeOutDuration: 0,
        crossfadeOutDuration: 0.5,
      },
    });
    const later = makeClip({
      id: 'clip_b',
      start: 1.5,
      duration: 2,
      rotation: 90,
      transition: {
        fadeInType: 'none',
        fadeInDuration: 0,
        fadeOutType: 'none',
        fadeOutDuration: 0,
        crossfadeInDuration: 0.5,
      },
    });
    const ctx = new Fake2DContext();
    const canvas = new FakeCanvas(ctx);
    canvas.width = 640;
    canvas.height = 360;
    new Compositor().renderFrame({
      time: 1.75,
      canvas: canvas as unknown as HTMLCanvasElement,
      tracks: [videoTrack],
      clips: [earlier, later],
      mediaPool: [makeMedia()],
      isPlaying: false,
    });

    // Los DOS clips se dibujan (el neutral en plano, el rotado girado).
    const draws = ctx.drawImageCalls;
    expect(draws).toHaveLength(2);
    // En mitad de la región (p = 0,5): sale 0,5 y entra 0,5.
    expect(draws[0].alpha).toBeCloseTo(0.5, 6);
    expect(draws[1].alpha).toBeCloseTo(0.5, 6);
    // Y el que entra lo hace rotado.
    expect(ctx.rotateCalls).toHaveLength(1);
    expect(ctx.rotateCalls[0]).toBeCloseTo(Math.PI / 2, 12);
  });

  it('sin API de transformación no se rompe (degrada al dibujado plano)', () => {
    const ctx = new Fake2DContextLegacy();
    const canvas = { width: 640, height: 360, getContext: () => ctx };
    expect(() =>
      new Compositor().renderFrame({
        time: 0,
        canvas: canvas as unknown as HTMLCanvasElement,
        tracks: [videoTrack],
        clips: [makeClip({ rotation: 90, flipH: true })],
        mediaPool: [makeMedia()],
        isPlaying: false,
      })
    ).not.toThrow();
    expect(ctx.drawImageCalls.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* 7 · El Compositor dibuja el recorte (estirado a la caja)            */
/* ================================================================== */

describe('compositor · el recorte muestra su región estirada a la caja', () => {
  it('el origen del dibujado es la región recortada y el destino la caja', () => {
    const plainCtx = new Fake2DContext();
    renderPreviewFrame(makeClip(), plainCtx);
    const plainDest = plainCtx.drawImageCalls.find((call) => call.args.length === 5);
    expect(plainDest).toBeDefined();

    const ctx = new Fake2DContext();
    renderPreviewFrame(
      makeClip({ crop: { top: 0.25, right: 0.25, bottom: 0.25, left: 0.25 } }),
      ctx
    );

    const draws = mediaDraws(ctx);
    expect(draws).toHaveLength(1);
    const [source, sx, sy, sw, sh, dx, dy, dw, dh] = draws[0].args as unknown[];
    expect(source).toBeInstanceOf(FakeImage);
    // Región central de 640×360: (160, 90, 320, 180)…
    expect(sx).toBeCloseTo(160, 9);
    expect(sy).toBeCloseTo(90, 9);
    expect(sw).toBeCloseTo(320, 9);
    expect(sh).toBeCloseTo(180, 9);
    // …estirada a la MISMA caja que sin recorte.
    expect(dx).toBeCloseTo(plainDest!.args[1] as number, 9);
    expect(dy).toBeCloseTo(plainDest!.args[2] as number, 9);
    expect(dw).toBeCloseTo(plainDest!.args[3] as number, 9);
    expect(dh).toBeCloseTo(plainDest!.args[4] as number, 9);
  });

  it('el recorte compone con la rotación (origen recortado + destino girado)', () => {
    const ctx = new Fake2DContext();
    renderPreviewFrame(
      makeClip({ rotation: 90, crop: { top: 0, right: 0.5, bottom: 0, left: 0 } }),
      ctx
    );

    const draws = mediaDraws(ctx);
    expect(draws).toHaveLength(1);
    const [, sx, , sw] = draws[0].args as unknown[];
    expect(sx).toBe(0);
    expect(sw).toBeCloseTo(320, 9);
    expect(ctx.rotateCalls[0]).toBeCloseTo(Math.PI / 2, 12);
  });
});

/* ================================================================== */
/* 8 · Camino caliente: la geometría se cachea por clip                */
/* ================================================================== */

describe('caché · la geometría no se recalcula por fotograma', () => {
  function renderFrames(clip: Clip, frames: number): Fake2DContext {
    const ctx = new Fake2DContext();
    const canvas = new FakeCanvas(ctx);
    canvas.width = 640;
    canvas.height = 360;
    const compositor = new Compositor();
    for (let frame = 0; frame < frames; frame++) {
      compositor.renderFrame({
        time: frame * 0.1,
        canvas: canvas as unknown as HTMLCanvasElement,
        tracks: [videoTrack],
        clips: [clip],
        mediaPool: [makeMedia()],
        isPlaying: true,
      });
    }
    return ctx;
  }

  it('60 fotogramas con rotación y recorte resuelven UNA sola vez', () => {
    const clip = makeClip({
      rotation: 90,
      flipH: true,
      crop: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
    });
    renderFrames(clip, 60);
    expect(getClipTransformBuildCount()).toBe(1);
  });

  it('cambiar el valor reconstruye una sola vez (no por fotograma)', () => {
    const clip = makeClip({ rotation: 90 });
    const ctx = new Fake2DContext();
    const canvas = new FakeCanvas(ctx);
    canvas.width = 640;
    canvas.height = 360;
    const compositor = new Compositor();
    const frame = (time: number): void => {
      compositor.renderFrame({
        time,
        canvas: canvas as unknown as HTMLCanvasElement,
        tracks: [videoTrack],
        clips: [clip],
        mediaPool: [makeMedia()],
        isPlaying: true,
      });
    };
    frame(0);
    frame(0.1);
    expect(getClipTransformBuildCount()).toBe(1);
    clip.rotation = 180;
    frame(0.2);
    frame(0.3);
    expect(getClipTransformBuildCount()).toBe(2);
  });

  it('un clip neutral no resuelve nada (cero asignaciones de geometría)', () => {
    renderFrames(makeClip(), 20);
    expect(getClipTransformBuildCount()).toBe(0);
  });
});

/* ================================================================== */
/* 9 · El contrato real: preview ≡ export                              */
/* ================================================================== */

describe('preview ≡ export · el exportador dibuja lo mismo que el visor', () => {
  it('rotación + volteo + recorte: el export pinta los mismos píxeles', async () => {
    installFakeWebCodecs();
    const { exportVideo, resolveExportClipTransform } = await import(
      '../core/export/webcodecsExporter'
    );

    const clip = makeClip({
      id: 'clip_parity',
      rotation: 90,
      flipH: true,
      crop: { top: 0.1, right: 0.2, bottom: 0.1, left: 0.2 },
    });

    /* --- PREVIEW --- */
    const previewCtx = new Fake2DContext();
    renderPreviewFrame(clip, previewCtx);
    const previewDraws = mediaDraws(previewCtx);
    expect(previewDraws).toHaveLength(1);

    /* --- EXPORT (el exportador real, con el MISMO Compositor) --- */
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

    const exportDraws = dom.canvases.flatMap((canvas) =>
      canvas.ctx.drawImageCalls.filter((call) => call.args.length === 9)
    );
    expect(exportDraws.length).toBeGreaterThan(0);
    // Mismo origen (región recortada), mismo destino y mismo alfa.
    for (const exportDraw of exportDraws) {
      const [sx, sy, sw, sh, dx, dy, dw, dh] = exportDraw.args.slice(1) as number[];
      const [psx, psy, psw, psh, pdx, pdy, pdw, pdh] = previewDraws[0].args.slice(1) as number[];
      expect(sx).toBeCloseTo(psx, 9);
      expect(sy).toBeCloseTo(psy, 9);
      expect(sw).toBeCloseTo(psw, 9);
      expect(sh).toBeCloseTo(psh, 9);
      expect(dx).toBeCloseTo(pdx, 9);
      expect(dy).toBeCloseTo(pdy, 9);
      expect(dw).toBeCloseTo(pdw, 9);
      expect(dh).toBeCloseTo(pdh, 9);
      expect(exportDraw.alpha).toBeCloseTo(previewDraws[0].alpha, 9);
    }
    // Y la MISMA rotación/volteo en ambos lienzos.
    const exportRotates = dom.canvases.flatMap((canvas) => canvas.ctx.rotateCalls);
    expect(exportRotates.length).toBeGreaterThan(0);
    for (const angle of exportRotates) {
      expect(angle).toBeCloseTo(previewCtx.rotateCalls[0], 12);
    }

    // El helper del exportador resuelve lo mismo que el compositor.
    expect(resolveExportClipTransform(clip)).toEqual(resolveClipVisualTransform(clip));
  });

  it('un clip neutral se exporta sin transformar (igual que el preview)', async () => {
    installFakeWebCodecs();
    const { exportVideo } = await import('../core/export/webcodecsExporter');

    const clip = makeClip({ id: 'clip_neutral' });
    const previewCtx = new Fake2DContext();
    renderPreviewFrame(clip, previewCtx);
    expect(previewCtx.rotateCalls).toEqual([]);

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

    for (const canvas of dom.canvases) {
      expect(canvas.ctx.rotateCalls).toEqual([]);
      expect(canvas.ctx.scaleCalls).toEqual([]);
    }
  });
});

/* ================================================================== */
/* 10 · El store: deshacer, recortar y mover conservan los valores     */
/* ================================================================== */

describe('store · rotación, volteo y recorte son deshacibles y viajan con el clip', () => {
  it('los valores se guardan con updateClip y se deshacen con Ctrl+Z', () => {
    useProjectStore.getState().addClip(makeClip({ id: 'clip_store', type: 'video' }));
    useProjectStore
      .getState()
      .updateClip('clip_store', {
        rotation: 90,
        flipH: true,
        crop: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
      });

    const edited = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_store');
    expect(edited?.rotation).toBe(90);
    expect(edited?.flipH).toBe(true);
    expect(edited?.crop).toEqual({ top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 });

    useProjectStore.getState().undo();
    const undone = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_store');
    expect(undone?.rotation).toBeUndefined();
    expect(undone?.flipH).toBeUndefined();
    expect(undone?.crop).toBeUndefined();
  });

  it('el reset devuelve el clip a neutral', () => {
    useProjectStore.getState().addClip(makeClip({ id: 'clip_reset', type: 'video' }));
    useProjectStore.getState().updateClip('clip_reset', { rotation: 270, flipV: true });
    useProjectStore
      .getState()
      .updateClip('clip_reset', { rotation: 0, flipH: false, flipV: false, crop: undefined });

    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_reset');
    expect(isNeutralVisualTransform(clip!)).toBe(true);
  });

  it('recortar y mover el clip no pierden la transformación', () => {
    useProjectStore.getState().addClip(
      makeClip({
        id: 'clip_trim',
        type: 'video',
        start: 0,
        duration: 4,
        rotation: 180,
        flipH: true,
        crop: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
      })
    );

    useProjectStore.getState().trimClipEnd('clip_trim', 3);
    const trimmed = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_trim');
    expect(trimmed?.rotation).toBe(180);
    expect(trimmed?.flipH).toBe(true);
    expect(trimmed?.crop).toEqual({ top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 });

    useProjectStore.getState().moveClip('clip_trim', 5);
    const moved = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_trim');
    expect(moved?.rotation).toBe(180);
    expect(moved?.flipH).toBe(true);
    expect(moved?.crop).toEqual({ top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 });
  });

  it('los valores sobreviven a un guardado y una recarga del proyecto', async () => {
    const { saveProject, getProjectById } = await import('../core/storage/projectStorage');
    const project = useProjectStore.getState().project;
    project.clips.push(
      makeClip({
        id: 'clip_saved',
        type: 'video',
        rotation: 90,
        flipV: true,
        crop: { top: 0.1, right: 0.2, bottom: 0.1, left: 0.2 },
      })
    );

    await saveProject(project);

    const reloaded = await getProjectById(project.id);
    const saved = reloaded?.clips.find((c) => c.id === 'clip_saved');
    expect(saved?.rotation).toBe(90);
    expect(saved?.flipV).toBe(true);
    expect(saved?.crop).toEqual({ top: 0.1, right: 0.2, bottom: 0.1, left: 0.2 });
  });
});

/* ================================================================== */
/* 11 · El Inspector                                                   */
/* ================================================================== */

describe('inspector · controles de transformación en español y con teclado', () => {
  const inspector = readFileSync(
    new URL('../components/inspector/ClipInspector.tsx', import.meta.url),
    'utf8'
  );

  it('la sección Transformación tiene rotación, volteos y recorte', () => {
    expect(inspector).toContain('titulo="Transformación"');
    // La rotación se genera (clip-rotation-${angle} sobre [0, 90, 180, 270]).
    expect(inspector).toContain('clip-rotation-');
    expect(inspector).toContain('[0, 90, 180, 270]');
    for (const testid of [
      'clip-flip-h',
      'clip-flip-v',
      'clip-crop-preset',
      'clip-crop-aspect',
    ]) {
      expect(inspector).toContain(testid);
    }
  });

  it('los controles son accesibles (aria-label) y están en español', () => {
    // La etiqueta de rotación se genera (`Rotar el clip a ${angle} grados`).
    expect(inspector).toContain('Rotar el clip a ');
    expect(inspector).toContain(' grados');
    for (const label of [
      'Voltear horizontalmente el clip',
      'Voltear verticalmente el clip',
      'Preajuste de encuadre del clip',
      'Restablecer la transformación del clip',
    ]) {
      expect(inspector).toContain(label);
    }
    expect(inspector).toContain('Encuadre resultante');
    expect(inspector).toContain('Recorte superior del clip');
  });

  it('los cambios se escriben en el clip (no en un estado local) y el reset limpia', () => {
    expect(inspector).toMatch(/updateClip\(clip\.id, \{[^}]*rotation:/);
    expect(inspector).toMatch(/updateClip\(clip\.id, \{[^}]*flipH:/);
    expect(inspector).toMatch(/updateClip\(clip\.id, \{[^}]*crop:/);
    expect(inspector).toContain('crop: undefined');
  });
});
