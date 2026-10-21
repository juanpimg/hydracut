/**
 * Regression suite for the export pipeline (wave O2, worker W-2).
 *
 * Covers the fixes applied to:
 * - src/core/export/webcodecsExporter.ts   (F1..F8, F10, F11)
 * - src/components/export/ExportModal.tsx   (F8)
 * - src/core/utils/sampleMedia.ts           (F9)
 *
 * The whole WebCodecs/MediaRecorder boundary is mocked: the assertions are
 * about *the arguments the production code hands to the encoder, the muxer and
 * the recorder*, never about the mock's own behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/* Shared mock state (hoisted so the vi.mock factories can use it)     */
/* ------------------------------------------------------------------ */
const state = vi.hoisted(() => ({
  muxerOptions: null as Record<string, unknown> | null,
  videoChunks: [] as Array<{
    type: string;
    timestamp: number;
    duration: number;
    codec?: string;
  }>,
  audioChunks: [] as Array<{ type: string; timestamp: number; duration: number }>,
  muxerFinalized: false,
  renders: [] as Array<{ time: number; currentTime: number | null }>,
  videoElements: [] as Array<{ currentTime: number }>,
  videoEncoderConfigs: [] as Array<Record<string, unknown>>,
  audioEncoderConfigs: [] as Array<Record<string, unknown>>,
  audioStarts: [] as Array<{ when: number; offset: number; duration: number; rate: number }>,
  decodeCalls: 0,
  fetchCalls: [] as string[],
  progress: [] as Array<{ state: string; progress: number; etaSeconds: number }>,
  mediaRecorders: [] as Array<{
    started: boolean;
    stopped: boolean;
    stopThrows: boolean;
    emitData: boolean;
    stream: { tracks: Array<{ stop: () => void; stopped: boolean }> };
  }>,
  sampleRecorders: [] as Array<{ stopped: boolean; tracks: Array<{ stopped: boolean }> }>,
}));

vi.mock('mp4-muxer', () => {
  class MockMuxer {
    constructor(options: Record<string, unknown>) {
      state.muxerOptions = options;
    }
    addVideoChunkRaw(
      _data: Uint8Array,
      type: string,
      timestamp: number,
      duration: number,
      meta?: { decoderConfig?: { codec?: string } }
    ) {
      state.videoChunks.push({
        type,
        timestamp,
        duration,
        codec: meta?.decoderConfig?.codec,
      });
    }
    addAudioChunkRaw(
      _data: Uint8Array,
      type: string,
      timestamp: number,
      duration: number
    ) {
      state.audioChunks.push({ type, timestamp, duration });
    }
    finalize() {
      state.muxerFinalized = true;
    }
  }
  class MockArrayBufferTarget {
    buffer = new ArrayBuffer(2048);
  }
  return { Muxer: MockMuxer, ArrayBufferTarget: MockArrayBufferTarget };
});

vi.mock('../core/engine/Compositor', () => {
  class MockCompositor {
    renderFrame(options: { time: number }) {
      const element = state.videoElements[0];
      state.renders.push({
        time: options.time,
        currentTime: element ? element.currentTime : null,
      });
    }
  }
  return { Compositor: MockCompositor };
});

/* ------------------------------------------------------------------ */
/* Fake DOM                                                            */
/* ------------------------------------------------------------------ */
class FakeVideoElement {
  readyState = 4;
  paused = true;
  playbackRate = 1;
  videoWidth = 640;
  videoHeight = 360;
  src = '';
  private listeners: Record<string, Array<(ev?: unknown) => void>> = {};
  private time = 0;

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    this.time = value;
    // A real element fires "seeked" asynchronously once the frame is decoded.
    setTimeout(() => this.emit('seeked'), 0);
  }

  addEventListener(type: string, cb: (ev?: unknown) => void) {
    (this.listeners[type] ||= []).push(cb);
  }

  removeEventListener(type: string, cb: (ev?: unknown) => void) {
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
  tracks: FakeTrack[] = [];
  constructor() {
    this.tracks.push(new FakeTrack('video'));
  }
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

function makeFake2DContext(): Record<string, unknown> {
  const gradient = { addColorStop: () => {} };
  return {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    fillRect: () => {},
    strokeRect: () => {},
    clearRect: () => {},
    fillText: () => {},
    strokeText: () => {},
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    rect: () => {},
    arc: () => {},
    clip: () => {},
    fill: () => {},
    stroke: () => {},
    measureText: () => ({ width: 10 }),
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    lineWidth: 1,
  };
}

class FakeCanvas {
  width = 0;
  height = 0;
  getContext(): Record<string, unknown> {
    return makeFake2DContext();
  }
  captureStream(): FakeMediaStream {
    return new FakeMediaStream();
  }
  toDataURL(): string {
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  }
  remove() {}
}

/* ------------------------------------------------------------------ */
/* Fake WebCodecs                                                      */
/* ------------------------------------------------------------------ */
function installVideoEncoder(
  opts: {
    failOnConfigure?: boolean;
    failOnEncode?: boolean;
    /**
     * Indices of the `configure()` calls that must throw. Index 0 is the
     * *probe* encoder created by `findWorkingVideoEncoderConfig`; index 1 is
     * the real export encoder. Failing only the second one reproduces the
     * real EX-04 scenario: the probe survives but the export encoder dies.
     */
    failConfigureAt?: number[];
  } = {}
) {
  let configureCallIndex = 0;

  class FakeVideoEncoder {
    state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
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
      state.videoEncoderConfigs.push(cfg);
      const index = configureCallIndex++;
      const mustFail =
        opts.failOnConfigure || (opts.failConfigureAt ?? []).includes(index);
      if (mustFail) {
        this.state = 'closed';
        throw new DOMException('Operation is not supported', 'NotSupportedError');
      }
      this.state = 'configured';
    }

    encode(frame: { timestamp: number; duration?: number }, encodeOptions?: { keyFrame?: boolean }) {
      if (opts.failOnEncode) {
        throw new DOMException('Encoder creation error.', 'OperationError');
      }
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

function installAudioEncoder(opts: { failOnEncode?: boolean; chunkDuration?: number | null } = {}) {
  class FakeAudioEncoder {
    state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
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
      if (opts.failOnEncode) {
        throw new DOMException('Operation is not supported', 'NotSupportedError');
      }
      this.init.output(
        {
          byteLength: 8,
          copyTo: (dest: Uint8Array) => dest.set([1, 2, 3, 4, 5, 6, 7, 8]),
          type: 'key',
          timestamp: data.timestamp,
          duration: opts.chunkDuration === undefined ? null : opts.chunkDuration,
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

/* ------------------------------------------------------------------ */
/* Fake Web Audio                                                      */
/* ------------------------------------------------------------------ */
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
      const node = {
        buffer: null as unknown,
        playbackRate: { value: 1 },
        connect: () => {},
        start: (when: number, offset: number, duration: number) => {
          state.audioStarts.push({
            when,
            offset,
            duration,
            rate: node.playbackRate.value,
          });
        },
      };
      return node;
    }
    createGain() {
      return {
        gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} },
        connect: () => {},
      };
    }
    async decodeAudioData() {
      state.decodeCalls++;
      // A long buffer so the "available source audio" clamp does not kick in.
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
        return { stream: new FakeMediaStream() };
      }
      createBufferSource() {
        return {
          buffer: null,
          playbackRate: { value: 1 },
          connect: () => {},
          start: () => {},
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} },
          connect: () => {},
        };
      }
      close() {
        return Promise.resolve();
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Fake MediaRecorder                                                   */
/* ------------------------------------------------------------------ */
function installMediaRecorder(opts: { emitData?: boolean; stopThrows?: boolean } = {}) {
  class FakeMediaRecorder {
    static isTypeSupported = vi.fn((mime: string) => mime === 'video/webm;codecs=vp9');
    state: 'inactive' | 'recording' = 'inactive';
    mimeType = 'video/webm;codecs=vp9';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    private record: (typeof state.mediaRecorders)[number];

    constructor(public stream: FakeMediaStream) {
      this.record = {
        started: false,
        stopped: false,
        stopThrows: opts.stopThrows ?? false,
        emitData: opts.emitData ?? true,
        stream: stream as never,
      };
      state.mediaRecorders.push(this.record);
    }

    start() {
      this.state = 'recording';
      this.record.started = true;
    }

    stop() {
      if (this.record.stopThrows) {
        this.record.stopped = true;
        throw new DOMException('InvalidStateError', 'InvalidStateError');
      }
      this.state = 'inactive';
      this.record.stopped = true;
      setTimeout(() => {
        if (this.record.emitData) {
          this.ondataavailable?.({
            data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }),
          });
        }
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
  const duration = (overrides.duration as number) ?? 1;
  return {
    config: {
      aspectRatio: '16:9' as const,
      width: 640,
      height: 360,
      fps: 30,
      bitrate: 2_000_000,
      format: 'mp4' as const,
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
    onProgress: (p: { state: string; progress: number; etaSeconds: number }) => {
      state.progress.push({ state: p.state, progress: p.progress, etaSeconds: p.etaSeconds });
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */
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
  state.videoChunks = [];
  state.audioChunks = [];
  state.muxerFinalized = false;
  state.renders = [];
  state.videoElements = [];
  state.videoEncoderConfigs = [];
  state.audioEncoderConfigs = [];
  state.audioStarts = [];
  state.decodeCalls = 0;
  state.fetchCalls = [];
  state.progress = [];
  state.mediaRecorders = [];
  state.sampleRecorders = [];

  const fakeDocument = {
    createElement(tag: string) {
      if (tag === 'canvas') return new FakeCanvas();
      if (tag === 'video') {
        const element = new FakeVideoElement();
        state.videoElements.push(element);
        return element;
      }
      return {} as unknown as HTMLElement;
    },
    body: { appendChild: () => {}, removeChild: () => {} },
  };
  (globalThis as Record<string, unknown>).document = fakeDocument;

  // `isCanvasCaptureSupported()` inspects HTMLCanvasElement.prototype
  class FakeHTMLCanvasElement {}
  (FakeHTMLCanvasElement.prototype as unknown as Record<string, unknown>).captureStream =
    function () {
      return new FakeMediaStream();
    };
  (globalThis as Record<string, unknown>).HTMLCanvasElement = FakeHTMLCanvasElement;

  (globalThis as Record<string, unknown>).fetch = vi.fn(async (url: string) => {
    state.fetchCalls.push(url);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(1024),
    };
  });
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
/* F3 — AVC level derivation                                           */
/* ================================================================== */
describe('F3 · nivel AVC derivado de la resolución (EX-03)', () => {
  it('deriva el nivel mínimo suficiente: 1080p30→4.0, 1080p60→4.2, 4K30→5.1, 4K60→5.2', async () => {
    const { deriveAvcLevelIdc } = await import('../core/export/webcodecsExporter');
    expect(deriveAvcLevelIdc(1920, 1080, 30)).toBe(40);
    expect(deriveAvcLevelIdc(1920, 1080, 60)).toBe(42);
    expect(deriveAvcLevelIdc(3840, 2160, 30)).toBe(51);
    expect(deriveAvcLevelIdc(3840, 2160, 60)).toBe(52);
    // 4K vertical needs the same macroblock count
    expect(deriveAvcLevelIdc(2160, 3840, 30)).toBe(51);
  });

  it('el codec candidate incluye un nivel ≥ 5.1 para 4K (antes solo llegaba a 4.2)', async () => {
    const { buildAvcCodecCandidates } = await import('../core/export/webcodecsExporter');
    const candidates = buildAvcCodecCandidates(3840, 2160, 30);
    expect(candidates[0]).toBe('avc1.640033');
    expect(candidates).toContain('avc1.640033');
    // The legacy (insufficient) codecs are still there as a last resort
    expect(candidates).toContain('avc1.640028');
  });

  it('mantiene avc1.640028 para 1080p30 (el camino feliz verificado no cambia)', async () => {
    const { buildAvcCodecCandidates } = await import('../core/export/webcodecsExporter');
    expect(buildAvcCodecCandidates(1920, 1080, 30, 8_000_000)[0]).toBe('avc1.640028');
  });

  it('no degrada el nivel de las resoluciones pequeñas (720p sigue en 4.0)', async () => {
    const { buildAvcCodecCandidates } = await import('../core/export/webcodecsExporter');
    // 720p30 necesita 3 600 MBs (caben en 3.1) pero el codec histórico ya
    // declara 4.0: no se baja de nivel, sólo se sube cuando hace falta.
    expect(buildAvcCodecCandidates(1280, 720, 30, 8_000_000)[0]).toBe('avc1.640028');
  });

  it('sube a 4.2 el nivel de 1080p60 (4.0 no admite 489 600 MBPS)', async () => {
    const { buildAvcCodecCandidates } = await import('../core/export/webcodecsExporter');
    expect(buildAvcCodecCandidates(1920, 1080, 60, 8_000_000)[0]).toBe('avc1.64002a');
  });

  it('el export configura el encoder con el codec de nivel derivado', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();
    const { exportVideo } = await import('../core/export/webcodecsExporter');

    await exportVideo(
      makeParams({
        duration: 0.2,
        config: {
          aspectRatio: '16:9' as const,
          width: 3840,
          height: 2160,
          fps: 30,
          bitrate: 20_000_000,
          format: 'mp4' as const,
        },
      })
    );

    expect(
      state.videoEncoderConfigs.some((cfg) => cfg.codec === 'avc1.640033')
    ).toBe(true);
  });
});

/* ================================================================== */
/* F1 — el fallback MediaRecorder hace seek del vídeo                  */
/* ================================================================== */
describe('F1 · el fallback MediaRecorder hace seek antes de componer (EX-01)', () => {
  it('posiciona el <video> en el offset correcto de cada fotograma', async () => {
    // Sin WebCodecs -> el export cae al camino MediaRecorder.
    delete (globalThis as Record<string, unknown>).VideoEncoder;
    delete (globalThis as Record<string, unknown>).VideoFrame;
    installOfflineAudioContext();
    installMediaRecorder();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    const blob = await exportVideo(makeParams({ duration: 0.4 }));

    expect(blob.size).toBeGreaterThan(0);
    expect(state.renders.length).toBeGreaterThan(2);

    // En cada fotograma compuesto el elemento de vídeo debe estar en el
    // offset de origen de ese instante (t * speed + sourceStart).
    for (const render of state.renders) {
      expect(render.currentTime).not.toBeNull();
      expect(render.currentTime!).toBeCloseTo(render.time, 1);
    }
    // Y no puede quedarse congelado en el primer fotograma
    const last = state.renders[state.renders.length - 1];
    expect(last.currentTime!).toBeGreaterThan(0);
  });

  it('el seek del fallback respeta sourceStart y la velocidad del clip', async () => {
    delete (globalThis as Record<string, unknown>).VideoEncoder;
    delete (globalThis as Record<string, unknown>).VideoFrame;
    installOfflineAudioContext();
    installMediaRecorder();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await exportVideo(
      makeParams({
        duration: 0.4,
        clips: [makeVideoClip({ sourceStart: 2, speed: 2 })],
        mediaPool: [makeMedia({ duration: 10 })],
      })
    );

    for (const render of state.renders) {
      expect(render.currentTime!).toBeCloseTo(2 + render.time * 2, 1);
    }
  });
});

/* ================================================================== */
/* F2 — la velocidad del audio no está invertida                        */
/* ================================================================== */
describe('F2 · la duración del audio respeta la velocidad del clip (EX-02)', () => {
  it('pasa los segundos de BUFFER a start() (no playDuration/speed)', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await exportVideo(
      makeParams({
        duration: 2,
        clips: [makeVideoClip({ duration: 2, speed: 2 })],
      })
    );

    expect(state.audioStarts.length).toBe(1);
    const start = state.audioStarts[0];
    // clip.duration(2) * speed(2) = 4 s de buffer
    expect(start.duration).toBeCloseTo(4, 3);
    // El tiempo real de reproducción = duration / playbackRate = 4/2 = 2 s
    expect(start.duration / start.rate).toBeCloseTo(2, 3);
    expect(start.when).toBe(0);
  });

  it('a velocidad 0.5 el audio no se desborda del clip', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await exportVideo(
      makeParams({
        duration: 2,
        clips: [makeVideoClip({ duration: 2, speed: 0.5 })],
      })
    );

    const start = state.audioStarts[0];
    // clip.duration(2) * speed(0.5) = 1 s de buffer -> 1/0.5 = 2 s reales
    expect(start.duration).toBeCloseTo(1, 3);
    expect(start.duration / start.rate).toBeCloseTo(2, 3);
  });
});

/* ================================================================== */
/* F5 — la pista de audio no mide la mitad                             */
/* ================================================================== */
describe('F5 · la duración de la pista de audio coincide con el bloque (EX-05)', () => {
  it('usa 2048 muestras (no 1024) cuando el navegador no informa duration', async () => {
    installVideoEncoder();
    installAudioEncoder({ chunkDuration: null });
    installOfflineAudioContext();
    installMediaRecorder();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await exportVideo(makeParams({ duration: 1 }));

    expect(state.audioChunks.length).toBeGreaterThan(0);
    for (const chunk of state.audioChunks) {
      expect(chunk.duration).toBe(Math.round((2048 / 48000) * 1_000_000));
    }
  });
});

/* ================================================================== */
/* F6 — el fallo del codificador de audio no deja una pista rota       */
/* ================================================================== */
describe('F6 · un AudioEncoder que falla no deja una pista de audio vacía (EX-06)', () => {
  it('NO declara la pista de audio en el muxer y la exportación sigue adelante', async () => {
    installVideoEncoder();
    installAudioEncoder({ failOnEncode: true });
    installOfflineAudioContext();
    installMediaRecorder();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    const blob = await exportVideo(makeParams({ duration: 0.2 }));

    expect(blob.size).toBeGreaterThan(0);
    expect(state.muxerOptions).not.toBeNull();
    const audioOption = (state.muxerOptions as { audio?: unknown }).audio;
    expect(audioOption).toBeUndefined();
    expect(state.audioChunks.length).toBe(0);
    // El vídeo se exporta igualmente
    expect(state.videoChunks.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* F7 — no se descarga el fichero entero por cada clip                 */
/* ================================================================== */
describe('F7 · el audio se decodifica una vez por medio (EX-07)', () => {
  it('descarga y decodifica una sola vez un medio usado por varios clips', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await exportVideo(
      makeParams({
        duration: 2,
        clips: [
          makeVideoClip({ id: 'clip_1', start: 0, duration: 1 }),
          makeVideoClip({ id: 'clip_2', start: 1, duration: 1 }),
        ],
      })
    );

    expect(state.fetchCalls).toEqual(['blob:media-1']);
    expect(state.decodeCalls).toBe(1);
  });
});

/* ================================================================== */
/* F8 — ciclo de vida de la exportación                                */
/* ================================================================== */
describe('F8 · ciclo de vida de la exportación', () => {
  it('normaliza el fps: el muxer recibe siempre un frameRate entero', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await exportVideo(
      makeParams({
        duration: 0.2,
        config: {
          aspectRatio: '16:9' as const,
          width: 640,
          height: 360,
          fps: 29.97,
          bitrate: 2_000_000,
          format: 'mp4' as const,
        },
      })
    );

    const video = (state.muxerOptions as { video: { frameRate: number } }).video;
    expect(Number.isInteger(video.frameRate)).toBe(true);
    expect(video.frameRate).toBe(30);
  });

  it('rechaza con un error accionable cuando la grabación no produce datos (0 bytes)', async () => {
    delete (globalThis as Record<string, unknown>).VideoEncoder;
    delete (globalThis as Record<string, unknown>).VideoFrame;
    installOfflineAudioContext();
    installMediaRecorder({ emitData: false });

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await expect(exportVideo(makeParams({ duration: 0.2 }))).rejects.toThrow(/0 bytes/i);
  });

  it('no se queda colgado si recorder.stop() lanza (y libera los tracks)', async () => {
    delete (globalThis as Record<string, unknown>).VideoEncoder;
    delete (globalThis as Record<string, unknown>).VideoFrame;
    installOfflineAudioContext();
    installMediaRecorder({ stopThrows: true });

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await expect(exportVideo(makeParams({ duration: 0.2 }))).rejects.toThrow(
      /No se pudo finalizar la grabación/i
    );
    // Los tracks del MediaStream se detienen siempre
    const recorder = state.mediaRecorders[0];
    expect(recorder.stream.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('libera los tracks del MediaStream al terminar correctamente', async () => {
    delete (globalThis as Record<string, unknown>).VideoEncoder;
    delete (globalThis as Record<string, unknown>).VideoFrame;
    installOfflineAudioContext();
    installMediaRecorder();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await exportVideo(makeParams({ duration: 0.2 }));

    const recorder = state.mediaRecorders[0];
    expect(recorder.stream.tracks.length).toBeGreaterThan(0);
    expect(recorder.stream.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('el estado completed informa de etaSeconds = 0', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await exportVideo(makeParams({ duration: 0.2 }));

    const completed = state.progress.filter((p) => p.state === 'completed');
    expect(completed.length).toBe(1);
    expect(completed[0].etaSeconds).toBe(0);
    expect(completed[0].progress).toBe(100);
  });
});

/* ================================================================== */
/* F4 — degradación real a MediaRecorder                               */
/* ================================================================== */
describe('F4 · un fallo real del encoder degrada a MediaRecorder (EX-04)', () => {
  it('no aborta la exportación cuando el VideoEncoder falla al exportar', async () => {
    // La sonda (encoder #0) sobrevive, pero el encoder real de la exportación
    // (#1) muere: es exactamente el escenario que describía el comentario
    // "fall back to MediaRecorder" y que el código nunca implementó.
    installVideoEncoder({ failConfigureAt: [1] });
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    const blob = await exportVideo(makeParams({ duration: 0.2 }));

    expect(blob.size).toBeGreaterThan(0);
    // Se usó el respaldo
    expect(state.mediaRecorders.length).toBe(1);
    expect(state.mediaRecorders[0].started).toBe(true);
  });

  it('una cancelación del usuario NO se degrada a MediaRecorder', async () => {
    installVideoEncoder({ failConfigureAt: [1] });
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();

    const controller = new AbortController();
    controller.abort();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await expect(
      exportVideo(makeParams({ duration: 0.2, signal: controller.signal }))
    ).rejects.toThrow();
    expect(state.mediaRecorders.length).toBe(0);
  });
});

/* ================================================================== */
/* F10 — el exportador no secuestra el MediaSourcePool global         */
/* ================================================================== */
describe('F10 · el exportador usa su propio pool de medios (H9 / E-08)', () => {
  it('no deja el MediaSourcePool global hijacked al terminar', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();

    const { mediaSourcePool } = await import('../core/engine/MediaSourcePool');
    const originalGetVideoElement = mediaSourcePool.getVideoElement;

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await exportVideo(makeParams({ duration: 0.2 }));

    expect(mediaSourcePool.getVideoElement).toBe(originalGetVideoElement);
  });

  it('durante el export los elementos del pool global no se tocan', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();

    const { mediaSourcePool } = await import('../core/engine/MediaSourcePool');
    const seen: unknown[] = [];
    const originalGetVideoElement = mediaSourcePool.getVideoElement;
    mediaSourcePool.getVideoElement = function (media: never, clipId?: string, sourceStart?: number) {
      seen.push(media);
      return originalGetVideoElement.call(this, media, clipId, sourceStart);
    };

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    try {
      await exportVideo(makeParams({ duration: 0.2 }));
    } finally {
      mediaSourcePool.getVideoElement = originalGetVideoElement;
    }

    // El pool global nunca llegó a crear los elementos del export
    expect(seen.length).toBe(0);
  });
});

/* ================================================================== */
/* F11 — cancelación reactiva                                          */
/* ================================================================== */
describe('F11 · la cancelación se respeta durante la exportación', () => {
  it('una señal ya abortada cancela la exportación sin informar de "completed"', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();

    const controller = new AbortController();
    controller.abort();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await expect(
      exportVideo(makeParams({ duration: 1, signal: controller.signal }))
    ).rejects.toThrow(/cancelad/i);
    expect(state.progress.some((p) => p.state === 'completed')).toBe(false);
  });

  it('no descarga ni decodifica el audio cuando ya está cancelado', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();

    const controller = new AbortController();
    controller.abort();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await expect(
      exportVideo(makeParams({ duration: 1, signal: controller.signal }))
    ).rejects.toThrow(/cancelad/i);
    // El render de audio offline comprueba la señal: no se descarga el fichero
    expect(state.fetchCalls).toHaveLength(0);
    expect(state.decodeCalls).toBe(0);
  });

  it('libera el pool de medios aunque la exportación se cancele', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();

    const { mediaSourcePool } = await import('../core/engine/MediaSourcePool');
    const originalGetVideoElement = mediaSourcePool.getVideoElement;

    const controller = new AbortController();
    controller.abort();

    const { exportVideo } = await import('../core/export/webcodecsExporter');
    await expect(
      exportVideo(makeParams({ duration: 1, signal: controller.signal }))
    ).rejects.toThrow();
    expect(mediaSourcePool.getVideoElement).toBe(originalGetVideoElement);
  });

  it('abortar durante el bucle de fotogramas detiene la exportación', async () => {
    installVideoEncoder();
    installAudioEncoder();
    installOfflineAudioContext();
    installMediaRecorder();

    const controller = new AbortController();
    let abortadoEnVuelo = false;
    const { exportVideo } = await import('../core/export/webcodecsExporter');
    const promise = exportVideo(
      makeParams({
        duration: 5,
        signal: controller.signal,
        // Determinista (sin reloj): el abort aterriza en el primer informe de
        // progreso, es decir, con el bucle de fotogramas ya en vuelo. El
        // `setTimeout(abort, 30)` anterior era una carrera: en una máquina muy
        // rápida el export completaba antes del abort (falso rojo) y en una
        // lenta el abort podía llegar tarde por el motivo equivocado.
        onProgress: (p: { state: string; progress: number; etaSeconds: number }) => {
          state.progress.push({ state: p.state, progress: p.progress, etaSeconds: p.etaSeconds });
          if (!abortadoEnVuelo) {
            abortadoEnVuelo = true;
            controller.abort();
          }
        },
      })
    );
    await expect(promise).rejects.toThrow(/cancelad/i);
    expect(abortadoEnVuelo).toBe(true);
    expect(state.progress.some((p) => p.state === 'completed')).toBe(false);
  });
});

/* ================================================================== */
/* F8 — errores no-Error en el modal                                   */
/* ================================================================== */
describe('F8 · el modal normaliza los errores que no son Error (EX-23)', () => {
  it('toErrorMessage nunca lanza con valores exóticos', async () => {
    const { toErrorMessage } = await import('../core/export/webcodecsExporter');
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
    expect(toErrorMessage('texto plano')).toBe('texto plano');
    expect(toErrorMessage(undefined)).toBe('Error durante la exportación');
    expect(toErrorMessage(null)).toBe('Error durante la exportación');
    expect(toErrorMessage({})).toBe('Error durante la exportación');
    expect(toErrorMessage({ message: 'desde objeto' })).toBe('desde objeto');
  });

  it('isAbortLikeError detecta las cancelaciones', async () => {
    const { isAbortLikeError } = await import('../core/export/webcodecsExporter');
    expect(isAbortLikeError(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isAbortLikeError(new Error('Exportación cancelada por el usuario'))).toBe(true);
    expect(isAbortLikeError(new Error('fallo del encoder'))).toBe(false);
    expect(isAbortLikeError(undefined)).toBe(false);
  });

  it('la etiqueta de ETA se oculta al completarse la exportación', async () => {
    const { formatExportEta } = await import('../components/export/ExportModal');
    expect(formatExportEta('completed', 0)).toBeNull();
    expect(formatExportEta('completed', 12)).toBeNull();
    expect(formatExportEta('rendering', 5)).toBe('~5 s');
    expect(formatExportEta('rendering', 0)).toBe('Calculando...');
  });
});

/* ================================================================== */
/* F9 — sampleMedia                                                    */
/* ================================================================== */
describe('F9 · la generación de muestras no deja recursos ni se cuelga', () => {
  function installSampleMediaRecorder(opts: { neverStops?: boolean } = {}) {
    class FakeSampleRecorder {
      static isTypeSupported = vi.fn(() => true);
      state: 'inactive' | 'recording' = 'inactive';
      mimeType = 'video/webm;codecs=vp9';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;

      constructor(public stream: FakeMediaStream) {
        state.sampleRecorders.push({ stopped: false, tracks: stream.getTracks() });
      }

      start() {
        this.state = 'recording';
      }

      stop() {
        this.state = 'inactive';
        const record = state.sampleRecorders[state.sampleRecorders.length - 1];
        record.stopped = true;
        if (opts.neverStops) return;
        setTimeout(() => {
          this.ondataavailable?.({
            data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }),
          });
          this.onstop?.();
        }, 0);
      }
    }
    (globalThis as Record<string, unknown>).MediaRecorder = FakeSampleRecorder;
  }

  it('rechaza (y no se cuelga) si el recorder nunca emite stop', async () => {
    installSampleMediaRecorder({ neverStops: true });
    const { generateSampleVideoBlob } = await import('../core/utils/sampleMedia');
    await expect(generateSampleVideoBlob('Prueba', 1, '#fff', 60)).rejects.toThrow(
      /excedió el tiempo máximo/i
    );
  });

  it('detiene los tracks del MediaStream capturado (fuga corregida)', async () => {
    installSampleMediaRecorder();
    const { generateSampleVideoBlob } = await import('../core/utils/sampleMedia');
    const blob = await generateSampleVideoBlob('Prueba', 0.2, '#fff', 2000);
    expect(blob.size).toBeGreaterThan(0);
    const record = state.sampleRecorders[0];
    expect(record.tracks.length).toBeGreaterThan(0);
    expect(record.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('createPresetMediaItems produce 3 ítems válidos aunque el vídeo falle', async () => {
    installSampleMediaRecorder({ neverStops: true });
    const { createPresetMediaItems } = await import('../core/utils/sampleMedia');
    const items = await createPresetMediaItems(60);
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.every((i) => typeof i.url === 'string' && i.url.length > 0)).toBe(true);
  });
});
