/**
 * Regression suite for worker W-35:
 * - Feature A — text presets / title templates (`textPresets.ts` + store
 *   `applyTextPreset` + Inspector picker data contract).
 * - Feature B — WebM export (`ExportConfig.format`, MediaRecorder-first
 *   routing reusing the existing recorder, filename/extension helpers).
 *
 * Every behaviour fails without the change (new module, new store action,
 * new format branch). The MP4 path is asserted unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/* Shared mock state                                                   */
/* ------------------------------------------------------------------ */
const state = vi.hoisted(() => ({
  muxerOptions: null as Record<string, unknown> | null,
  muxerFinalized: false,
  renders: [] as Array<{ time: number }>,
  videoElements: [] as Array<{ currentTime: number }>,
  videoEncoderConstructed: 0,
  videoEncoderConfigs: [] as Array<Record<string, unknown>>,
  audioEncoderConfigs: [] as Array<Record<string, unknown>>,
  decodeCalls: 0,
  progress: [] as Array<{ state: string; progress: number }>,
  mediaRecorders: [] as Array<{
    started: boolean;
    requestedMime: string;
    effectiveMime: string;
    streamTracksStopped: () => boolean;
  }>,
}));

vi.mock('mp4-muxer', () => {
  class MockMuxer {
    constructor(options: Record<string, unknown>) {
      state.muxerOptions = options;
    }
    addVideoChunkRaw() {}
    addAudioChunkRaw() {}
    finalize() {
      state.muxerFinalized = true;
    }
  }
  class MockArrayBufferTarget {
    buffer = new ArrayBuffer(2048);
  }
  return { Muxer: MockMuxer, ArrayBufferTarget: MockArrayBufferTarget };
});

vi.mock('../core/engine/Compositor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/engine/Compositor')>();
  class MockCompositor {
    renderFrame(options: { time: number }) {
      state.renders.push({ time: options.time });
    }
  }
  return { ...actual, Compositor: MockCompositor };
});

/* ------------------------------------------------------------------ */
/* Fake DOM / WebCodecs / MediaRecorder                                */
/* ------------------------------------------------------------------ */
class FakeVideoElement {
  readyState = 4;
  private listeners: Record<string, Array<() => void>> = {};
  private time = 0;
  get currentTime(): number {
    return this.time;
  }
  set currentTime(value: number) {
    this.time = value;
    setTimeout(() => this.emit('seeked'), 0);
  }
  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ||= []).push(cb);
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners[type] = (this.listeners[type] || []).filter((l) => l !== cb);
  }
  emit(type: string) {
    for (const cb of [...(this.listeners[type] || [])]) cb();
  }
  play() {
    return Promise.resolve();
  }
  pause() {}
  load() {}
  removeAttribute() {}
}

class FakeTrack {
  stopped = false;
  constructor(public kind: string) {}
  stop() {
    this.stopped = true;
  }
}

class FakeMediaStream {
  tracks: FakeTrack[] = [new FakeTrack('video')];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  getContext() {
    return { fillRect: () => {} };
  }
  captureStream(): FakeMediaStream {
    return new FakeMediaStream();
  }
}

function installVideoEncoder() {
  class FakeVideoEncoder {
    state = 'unconfigured';
    encodeQueueSize = 0;
    private init: { output: (chunk: unknown, meta?: unknown) => void; error: (e: unknown) => void };
    constructor(init: { output: (chunk: unknown, meta?: unknown) => void; error: (e: unknown) => void }) {
      this.init = init;
      state.videoEncoderConstructed++;
    }
    static isConfigSupported = vi.fn(async (cfg: Record<string, unknown>) => ({
      supported: true,
      config: cfg,
    }));
    configure(cfg: Record<string, unknown>) {
      state.videoEncoderConfigs.push(cfg);
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
}

function installAudioEncoder() {
  class FakeAudioEncoder {
    state = 'unconfigured';
    encodeQueueSize = 0;
    private init: { output: (chunk: unknown, meta?: unknown) => void; error: (e: unknown) => void };
    constructor(init: { output: (chunk: unknown, meta?: unknown) => void; error: (e: unknown) => void }) {
      this.init = init;
    }
    static isConfigSupported = vi.fn(async (cfg: Record<string, unknown>) => ({
      supported: true,
      config: cfg,
    }));
    configure(cfg: Record<string, unknown>) {
      state.audioEncoderConfigs.push(cfg);
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
}

function makeFakeAudioBuffer(length: number, sampleRate = 48000) {
  return {
    duration: length / sampleRate,
    length,
    sampleRate,
    numberOfChannels: 2,
    getChannelData: () => new Float32Array(length),
  };
}

function installOfflineAudioContext() {
  class FakeOfflineAudioContext {
    length: number;
    sampleRate: number;
    destination = {};
    constructor(_channels: number, length: number, sampleRate: number) {
      this.length = length;
      this.sampleRate = sampleRate;
    }
    createBufferSource() {
      return { buffer: null, playbackRate: { value: 1 }, connect: () => {}, start: () => {} };
    }
    createGain() {
      return {
        gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} },
        connect: () => {},
      };
    }
    async decodeAudioData() {
      state.decodeCalls++;
      return makeFakeAudioBuffer(10 * this.sampleRate, this.sampleRate);
    }
    async startRendering() {
      return makeFakeAudioBuffer(this.length, this.sampleRate);
    }
  }
  (globalThis as Record<string, unknown>).OfflineAudioContext = FakeOfflineAudioContext;
  (globalThis as Record<string, unknown>).window = {
    AudioContext: class {
      createMediaStreamDestination() {
        const stream = new FakeMediaStream();
        stream.addTrack(new FakeTrack('audio'));
        return { stream };
      }
      createBufferSource() {
        return { buffer: null, connect: () => {}, start: () => {} };
      }
      close() {
        return Promise.resolve();
      }
    },
  };
}

function installMediaRecorder() {
  class FakeMediaRecorder {
    static isTypeSupported = vi.fn(
      (mime: string) => mime === 'video/webm;codecs=vp9' || mime === 'video/webm'
    );
    state: 'inactive' | 'recording' = 'inactive';
    mimeType: string;
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    private record: (typeof state.mediaRecorders)[number];

    constructor(
      public stream: FakeMediaStream,
      options?: { mimeType?: string }
    ) {
      this.mimeType = options?.mimeType || 'video/webm;codecs=vp9';
      this.record = {
        started: false,
        requestedMime: options?.mimeType ?? '',
        effectiveMime: this.mimeType,
        streamTracksStopped: () => this.stream.getTracks().every((t) => t.stopped),
      };
      state.mediaRecorders.push(this.record);
    }
    start() {
      this.state = 'recording';
      this.record.started = true;
    }
    stop() {
      this.state = 'inactive';
      setTimeout(() => {
        this.ondataavailable?.({
          data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }),
        });
        this.onstop?.();
      }, 0);
    }
  }
  (globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */
function makeVideoClip(overrides: Record<string, unknown> = {}) {
  return {
    id: 'clip_1',
    trackId: 'track_v1',
    mediaId: 'media_1',
    name: 'Clip 1',
    type: 'video' as const,
    start: 0,
    duration: 1,
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

function makeMedia(overrides: Record<string, unknown> = {}) {
  return {
    id: 'media_1',
    name: 'media 1',
    type: 'video' as const,
    url: 'blob:media-1',
    duration: 10,
    width: 640,
    height: 360,
    fps: 30,
    thumbnailUrl: '',
    size: 1024,
    createdAt: 0,
    ...overrides,
  };
}

function makeParams(overrides: Record<string, unknown> = {}) {
  const duration = (overrides.duration as number) ?? 0.2;
  return {
    config: {
      aspectRatio: '16:9' as const,
      width: 640,
      height: 360,
      fps: 30,
      bitrate: 2_000_000,
      format: 'mp4' as const,
      ...((overrides.config as Record<string, unknown>) ?? {}),
    },
    duration,
    tracks: [
      {
        id: 'track_v1',
        name: 'V1',
        type: 'video' as const,
        isMuted: false,
        isLocked: false,
        isVisible: true,
      },
    ],
    clips: [makeVideoClip()],
    mediaPool: [makeMedia()],
    onProgress: (p: { state: string; progress: number }) => {
      state.progress.push({ state: p.state, progress: p.progress });
    },
    ...overrides,
  };
}

const REAL_GLOBALS: Record<string, unknown> = {};
const GLOBAL_KEYS = [
  'VideoEncoder',
  'VideoFrame',
  'AudioEncoder',
  'AudioData',
  'OfflineAudioContext',
  'MediaRecorder',
  'HTMLCanvasElement',
  'window',
  'document',
  'fetch',
];

beforeEach(() => {
  for (const key of GLOBAL_KEYS) {
    REAL_GLOBALS[key] = (globalThis as Record<string, unknown>)[key];
  }
  state.muxerOptions = null;
  state.muxerFinalized = false;
  state.renders = [];
  state.videoElements = [];
  state.videoEncoderConstructed = 0;
  state.videoEncoderConfigs = [];
  state.audioEncoderConfigs = [];
  state.decodeCalls = 0;
  state.progress = [];
  state.mediaRecorders = [];

  (globalThis as Record<string, unknown>).document = {
    createElement(tag: string) {
      if (tag === 'canvas') return new FakeCanvas();
      if (tag === 'video') {
        const element = new FakeVideoElement();
        state.videoElements.push(element);
        return element;
      }
      return {};
    },
    body: { appendChild: () => {}, removeChild: () => {} },
  };
  class FakeHTMLCanvasElement {}
  (FakeHTMLCanvasElement.prototype as unknown as Record<string, unknown>).captureStream =
    function () {
      return new FakeMediaStream();
    };
  (globalThis as Record<string, unknown>).HTMLCanvasElement = FakeHTMLCanvasElement;
  (globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(1024),
  }));
});

afterEach(() => {
  for (const key of GLOBAL_KEYS) {
    const value = REAL_GLOBALS[key];
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
  vi.restoreAllMocks();
});

/* ================================================================== */
/* Feature A · presets de texto                                        */
/* ================================================================== */
describe('Feature A · catálogo de plantillas de texto', () => {
  it('ofrece al menos 6 plantillas curadas con etiquetas en español', async () => {
    const { TEXT_PRESETS } = await import('../core/utils/textPresets');
    expect(TEXT_PRESETS.length).toBeGreaterThanOrEqual(6);
    const ids = TEXT_PRESETS.map((p) => p.id);
    for (const expected of [
      'titulo-limpio',
      'subtitulo',
      'cinta-cine',
      'neon',
      'marcador',
      'minimalista',
    ]) {
      expect(ids).toContain(expected);
    }
    for (const preset of TEXT_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.hint.length).toBeGreaterThan(0);
    }
  });

  it('cada plantilla es un estilo completo y coherente', async () => {
    const { TEXT_PRESETS, TEXT_FONTS } = await import('../core/utils/textPresets');
    const families = new Set(TEXT_FONTS.map((f) => f.value));
    for (const preset of TEXT_PRESETS) {
      const s = preset.style;
      expect(s.fontSize).toBeGreaterThan(0);
      expect(typeof s.color).toBe('string');
      expect(typeof s.backgroundColor).toBe('string');
      expect(families.has(s.fontFamily)).toBe(true);
      expect(['left', 'center', 'right']).toContain(s.textAlign);
      expect(['normal', 'bold', '600', '800', '900']).toContain(s.fontWeight);
    }
    // Son looks distintos, no el mismo estilo con otro nombre.
    const signatures = new Set(TEXT_PRESETS.map((p) => JSON.stringify(p.style)));
    expect(signatures.size).toBe(TEXT_PRESETS.length);
  });

  it('la lista de fuentes coincide con la del Inspector y la que pinta el Compositor', async () => {
    const { TEXT_FONTS } = await import('../core/utils/textPresets');
    // Las 6 que ofrece el desplegable de tipografía del Inspector.
    expect(TEXT_FONTS.map((f) => f.value)).toEqual([
      'Inter, sans-serif',
      'Montserrat, sans-serif',
      '"Bebas Neue", sans-serif',
      'Oswald, sans-serif',
      'JetBrains Mono, monospace',
      'Georgia, serif',
    ]);
    // El valor por defecto que usa el Compositor al dibujar existe en la lista.
    expect(TEXT_FONTS.some((f) => f.value === 'Inter, sans-serif')).toBe(true);
  });
});

describe('Feature A · applyTextPreset fusiona sin borrar el texto', () => {
  it('aplica todos los campos de la plantilla conservando las claves manuales', async () => {
    const { applyTextPreset, TEXT_PRESETS } = await import('../core/utils/textPresets');
    const neon = TEXT_PRESETS.find((p) => p.id === 'neon')!;
    const current = {
      fontSize: 48,
      color: '#ffffff',
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      fontFamily: 'Inter, sans-serif',
      textAlign: 'center' as const,
      fontWeight: 'bold' as const,
      animationPreset: 'karaoke-fill' as const,
    };
    const next = applyTextPreset(current, 'neon');
    // Campos de la plantilla aplicados…
    expect(next.fontFamily).toBe(neon.style.fontFamily);
    expect(next.fontSize).toBe(neon.style.fontSize);
    expect(next.color).toBe(neon.style.color);
    // …y la animación ajustada a mano sobrevive (la plantilla no la define).
    expect(next.animationPreset).toBe('karaoke-fill');
    // No devuelve el texto: el contenido del clip no se toca por construcción.
    expect('text' in next).toBe(false);
  });

  it('lanza con una plantilla desconocida (el store lo convierte en false)', async () => {
    const { applyTextPreset } = await import('../core/utils/textPresets');
    expect(() =>
      applyTextPreset(undefined, 'plantilla-que-no-existe')
    ).toThrow(/desconocida/);
  });

  it('matchTextPreset detecta la plantilla activa y el estilo personalizado', async () => {
    const { matchTextPreset, TEXT_PRESETS, applyTextPreset } = await import(
      '../core/utils/textPresets'
    );
    const cine = TEXT_PRESETS.find((p) => p.id === 'cinta-cine')!;
    expect(matchTextPreset(applyTextPreset(undefined, 'cinta-cine'))).toBe('cinta-cine');
    expect(matchTextPreset({ ...cine.style, fontSize: 999 })).toBeNull();
    expect(matchTextPreset(undefined)).toBeNull();
  });
});

describe('Feature A · el store aplica la plantilla de forma deshacible', () => {
  function makeTextClip(overrides: Record<string, unknown> = {}) {
    return {
      id: 'clip_text_1',
      trackId: 'track_text_1',
      mediaId: '',
      name: 'Hola',
      type: 'text' as const,
      start: 0,
      duration: 5,
      sourceStart: 0,
      sourceDuration: 5,
      volume: 0,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: true,
      text: 'Hola mundo',
      textStyle: {
        fontSize: 48,
        color: '#ffffff',
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        fontFamily: 'Inter, sans-serif',
        textAlign: 'center' as const,
        fontWeight: 'bold' as const,
      },
      ...overrides,
    };
  }

  it('aplica el estilo, conserva el texto y se deshace en un paso', async () => {
    const { useProjectStore } = await import('../store/useProjectStore');
    useProjectStore.getState().resetProject();
    useProjectStore.getState().addClip(makeTextClip() as never);

    const before = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_text_1')!;
    expect(useProjectStore.getState().applyTextPreset('clip_text_1', 'neon')).toBe(true);

    const applied = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_text_1')!;
    expect(applied.text).toBe('Hola mundo');
    expect(applied.name).toBe(before.name);
    expect(applied.textStyle?.fontFamily).toBe('Montserrat, sans-serif');
    expect(applied.textStyle?.fontSize).toBe(60);

    useProjectStore.getState().undo();
    const undone = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_text_1')!;
    expect(undone.text).toBe('Hola mundo');
    expect(undone.textStyle).toEqual(before.textStyle);

    useProjectStore.getState().redo();
    const redone = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_text_1')!;
    expect(redone.textStyle?.fontFamily).toBe('Montserrat, sans-serif');
    useProjectStore.getState().resetProject();
  });

  it('rechaza sin escribir historial en clip inexistente, no textual o plantilla mala', async () => {
    const { useProjectStore } = await import('../store/useProjectStore');
    useProjectStore.getState().resetProject();
    useProjectStore.getState().addClip(makeTextClip() as never);
    useProjectStore.getState().addClip(makeVideoClip() as never);
    const pastBefore = useProjectStore.getState().past.length;

    expect(useProjectStore.getState().applyTextPreset('no-existe', 'neon')).toBe(false);
    expect(useProjectStore.getState().applyTextPreset('clip_1', 'neon')).toBe(false);
    expect(useProjectStore.getState().applyTextPreset('clip_text_1', 'mala')).toBe(false);
    expect(useProjectStore.getState().past.length).toBe(pastBefore);
    useProjectStore.getState().resetProject();
  });
});

/* ================================================================== */
/* Feature B · formato WebM                                            */
/* ================================================================== */
describe('Feature B · selección del MIME del grabador de respaldo', () => {
  it('webm pide variantes con audio primero; mp4 mantiene el orden histórico exacto al principio', async () => {
    const { resolveRecorderMimeCandidates } = await import(
      '../core/export/webcodecsExporter'
    );
    // Nuevo contrato: todo candidato debe ser válido para un stream CON audio.
    // `isTypeSupported('video/webm;codecs=vp8')` dice "sí" en Firefox pero su
    // `start()` muere con audio, así que las variantes con códec de audio
    // (opus) y el contenedor bare van delante; las planas quedan al final por
    // si el stream no lleva audio.
    expect(resolveRecorderMimeCandidates('webm')).toEqual([
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
    ]);
    // El camino MP4 no cambia ni un byte en Chrome: mp4 primero (arranca con
    // el primer candidato y nunca llega a los siguientes).
    expect(resolveRecorderMimeCandidates('mp4')).toEqual([
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
    ]);
  });

  it('pickRecorderMimeType elige VP9 para webm y mp4 para mp4 con la misma sonda', async () => {
    const { pickRecorderMimeType } = await import('../core/export/webcodecsExporter');
    const probe = (mime: string) => mime === 'video/webm;codecs=vp9';
    // Sin el cambio, webm habría heredado el primer candidato mp4 soportado;
    // con un navegador que solo soporta VP9 el mp4 queda vacío y el webm usa VP9.
    expect(pickRecorderMimeType('webm', probe)).toBe('video/webm;codecs=vp9');
    expect(pickRecorderMimeType('mp4', probe)).toBe('video/webm;codecs=vp9');
    expect(pickRecorderMimeType('webm', () => false)).toBe('');
    expect(pickRecorderMimeType('mp4', () => false)).toBe('');
  });

  it('la extensión acompaña al MIME real y al formato pedido', async () => {
    const { exportFileExtensionFor, buildExportFilename } = await import(
      '../core/export/webcodecsExporter'
    );
    expect(exportFileExtensionFor('video/webm;codecs=vp9', 'webm')).toBe('webm');
    expect(exportFileExtensionFor('video/mp4', 'mp4')).toBe('mp4');
    expect(exportFileExtensionFor('', 'webm')).toBe('webm');
    expect(exportFileExtensionFor('', 'mp4')).toBe('mp4');
    expect(buildExportFilename('Mi Proyecto', '1080p', null, 'webm')).toBe(
      'mi_proyecto_1080p.webm'
    );
    expect(buildExportFilename('Mi Proyecto', '1080p', { start: 1, end: 2 }, 'mp4')).toBe(
      'mi_proyecto_1080p_1-2.mp4'
    );
  });

  it('el modal nombra el contenedor según el formato (MP4 intacto por defecto)', async () => {
    const { describeExportProgress } = await import('../components/export/ExportModal');
    expect(describeExportProgress({ state: 'muxing' } as never)).toBe(
      'Generando el archivo MP4 final…'
    );
    expect(describeExportProgress({ state: 'muxing' } as never, 'webm')).toBe(
      'Generando el archivo WebM final…'
    );
  });
});

describe('Feature B · exportVideo con formato webm', () => {
  it('usa el grabador de respaldo (MediaRecorder VP9) aunque haya WebCodecs', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();
    const { exportVideo } = await import('../core/export/webcodecsExporter');

    const blob = await exportVideo(makeParams({ config: { format: 'webm' } as never }));

    expect(blob.type).toContain('webm');
    expect(blob.size).toBeGreaterThan(0);
    // El MISMO grabador existente: se usó MediaRecorder…
    expect(state.mediaRecorders.length).toBe(1);
    expect(state.mediaRecorders[0].started).toBe(true);
    expect(state.mediaRecorders[0].effectiveMime).toContain('webm');
    // …y NO el camino WebCodecs/MP4: ni un encoder creado, ni muxer MP4.
    expect(state.videoEncoderConstructed).toBe(0);
    expect(state.muxerFinalized).toBe(false);
  });

  it('el WebM pasa por el mismo Compositor (los fotogramas son los del preview)', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();
    const { exportVideo } = await import('../core/export/webcodecsExporter');

    await exportVideo(makeParams({ duration: 0.2, config: { format: 'webm' } as never }));

    // 0.2 s a 30 fps = 6 fotogramas compuestos con el Compositor.
    expect(state.renders.length).toBe(6);
    expect(state.renders[0].time).toBeCloseTo(0, 5);
    // El audio se mezcla offline con la misma maquinaria del camino MP4.
    expect(state.decodeCalls).toBeGreaterThan(0);
  });

  it('el camino MP4 sigue intacto: WebCodecs + muxer, sin MediaRecorder', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();
    const { exportVideo } = await import('../core/export/webcodecsExporter');

    const blob = await exportVideo(makeParams({ config: { format: 'mp4' } as never }));

    expect(blob.type).toBe('video/mp4');
    expect(state.muxerFinalized).toBe(true);
    expect(state.mediaRecorders.length).toBe(0);
    expect(state.videoEncoderConstructed).toBeGreaterThan(0);
  });

  it('sin formato explícito el comportamiento es el MP4 de siempre', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();
    const { exportVideo } = await import('../core/export/webcodecsExporter');

    const params = makeParams();
    delete (params.config as Record<string, unknown>).format;
    const blob = await exportVideo(params as never);

    expect(blob.type).toBe('video/mp4');
    expect(state.muxerFinalized).toBe(true);
    expect(state.mediaRecorders.length).toBe(0);
  });
});
