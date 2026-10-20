/**
 * Regresión del bug crítico de exportación con audio (worker W-39).
 *
 * En Firefox, `MediaRecorder.isTypeSupported('video/webm;codecs=vp8')`
 * devuelve `true`, pero `start()` rechaza el stream cuando lleva pista de
 * audio (`NotSupportedError: An audio track cannot be recorded`). El grabador
 * de respaldo elegía el MIME solo con `isTypeSupported` y el `catch` de
 * `start()` abortaba sin probar más candidatos.
 *
 * Estos tests fallan con el código anterior y pasan con el fix:
 * - `startRecorderWithFallback` prueba cada candidato con construir + start()
 *   reales, sigue con el siguiente si `start()` falla y reintenta con los
 *   defaults del navegador antes de rendirse.
 * - La lista de candidatos incluye variantes con códec de audio + bare.
 * - El error final es accionable y en español (hardware + respaldo).
 * - Con Chrome (todo arranca) el MIME elegido sigue siendo el primero.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/* Integración vía exportVideo (fakes Firefox-like)                    */
/* ------------------------------------------------------------------ */
const istate = vi.hoisted(() => ({
  renders: [] as number[],
  requestedMimes: [] as Array<string | undefined>,
  effectiveMime: '' as string,
  audioTracksAtStart: -1,
  recordersBuilt: 0,
}));

vi.mock('../core/engine/Compositor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/engine/Compositor')>();
  class MockCompositor {
    renderFrame(options: { time: number }) {
      istate.renders.push(options.time);
    }
  }
  return { ...actual, Compositor: MockCompositor };
});

vi.mock('mp4-muxer', () => {
  class MockMuxer {
    addVideoChunkRaw() {}
    addAudioChunkRaw() {}
    finalize() {}
  }
  class MockArrayBufferTarget {
    buffer = new ArrayBuffer(16);
  }
  return { Muxer: MockMuxer, ArrayBufferTarget: MockArrayBufferTarget };
});

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
}

class FakeCanvas {
  width = 0;
  height = 0;
  captureStream(): FakeMediaStream {
    return new FakeMediaStream();
  }
}

function installDom() {
  (globalThis as Record<string, unknown>).document = {
    createElement(tag: string) {
      if (tag === 'canvas') return new FakeCanvas();
      if (tag === 'video') return new FakeVideoElement();
      return {};
    },
    body: { appendChild: () => {}, removeChild: () => {} },
  };
  (globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(1024),
  }));
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

function installAudio() {
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

/**
 * Imita al Firefox 158 real: el constructor rechaza mp4 y vp9, acepta vp8 /
 * opus / bare; `start()` rechaza el vp8 plano cuando el stream lleva audio.
 */
function installFirefoxLikeRecorder() {
  const okCtor = (mime: string | undefined) =>
    mime === undefined ||
    mime === 'video/webm;codecs=vp8' ||
    mime === 'video/webm;codecs=vp8,opus' ||
    mime === 'video/webm';
  class FakeRecorder {
    state: 'inactive' | 'recording' = 'inactive';
    mimeType: string;
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(
      public stream: FakeMediaStream,
      options?: { mimeType?: string }
    ) {
      istate.recordersBuilt++;
      istate.requestedMimes.push(options?.mimeType);
      if (!okCtor(options?.mimeType)) {
        throw new DOMException(
          `Unsupported mimeType: ${options?.mimeType}`,
          'NotSupportedError'
        );
      }
      this.mimeType = options?.mimeType || 'video/webm';
    }
    start() {
      const hasAudio = this.stream.getAudioTracks().length > 0;
      istate.audioTracksAtStart = this.stream.getAudioTracks().length;
      if (hasAudio && this.mimeType === 'video/webm;codecs=vp8') {
        throw new DOMException(
          'MediaRecorder.start: An audio track cannot be recorded: video/webm;codecs=vp8 indicates an unsupported codec',
          'NotSupportedError'
        );
      }
      this.state = 'recording';
      istate.effectiveMime = this.mimeType;
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
  (globalThis as Record<string, unknown>).MediaRecorder = FakeRecorder;
}

function installAlwaysFailingRecorder() {
  class FakeRecorder {
    state: 'inactive' | 'recording' = 'inactive';
    mimeType = 'video/webm';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(public stream: FakeMediaStream) {}
    start() {
      throw new DOMException(
        'MediaRecorder.start: no se pudo iniciar la grabación con ningún formato',
        'NotSupportedError'
      );
    }
    stop() {
      this.state = 'inactive';
      setTimeout(() => this.onstop?.(), 0);
    }
  }
  (globalThis as Record<string, unknown>).MediaRecorder = FakeRecorder;
}

function installFailingExportEncoder() {
  let configureCalls = 0;
  class FakeVideoEncoder {
    state = 'unconfigured';
    encodeQueueSize = 0;
    constructor(_init: { output: (c: unknown, m?: unknown) => void; error: (e: unknown) => void }) {
      // Solo importa configure()/isConfigSupported para este test.
    }
    static isConfigSupported = vi.fn(async (cfg: Record<string, unknown>) => ({
      supported: true,
      config: cfg,
    }));
    configure() {
      // La sonda (llamada 0) sobrevive; el encoder real de la exportación (1) muere.
      if (configureCalls++ === 1) {
        this.state = 'closed';
        throw new DOMException('Operation is not supported', 'NotSupportedError');
      }
      this.state = 'configured';
    }
    encode() {}
    async flush() {}
    close() {
      this.state = 'closed';
    }
  }
  (globalThis as Record<string, unknown>).VideoEncoder = FakeVideoEncoder;
  (globalThis as Record<string, unknown>).VideoFrame = class {
    constructor(
      public source: unknown,
      public init: unknown
    ) {}
    close() {}
  };
}

function makeExportParams(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      aspectRatio: '16:9' as const,
      width: 640,
      height: 360,
      fps: 30,
      bitrate: 2_000_000,
      format: 'mp4' as const,
    },
    duration: 0.2,
    tracks: [
      { id: 'track_v1', name: 'V1', type: 'video' as const, isMuted: false, isLocked: false, isVisible: true },
      { id: 'track_a1', name: 'A1', type: 'audio' as const, isMuted: false, isLocked: false, isVisible: true },
    ],
    clips: [
      {
        id: 'clip_v', trackId: 'track_v1', mediaId: 'media_v', name: 'V',
        type: 'video' as const, start: 0, duration: 0.2, sourceStart: 0,
        sourceDuration: 10, volume: 1, opacity: 1, scale: 1, positionX: 0,
        positionY: 0, muted: false,
      },
      {
        id: 'clip_a', trackId: 'track_a1', mediaId: 'media_a', name: 'A',
        type: 'audio' as const, start: 0, duration: 0.2, sourceStart: 0,
        sourceDuration: 10, volume: 1, opacity: 1, scale: 1, positionX: 0,
        positionY: 0, muted: false,
      },
    ],
    mediaPool: [
      { id: 'media_v', name: 'v', type: 'video' as const, url: 'blob:v', duration: 10, width: 640, height: 360, fps: 30, thumbnailUrl: '', size: 1, createdAt: 0 },
      { id: 'media_a', name: 'a', type: 'audio' as const, url: 'blob:a', duration: 10, width: 0, height: 0, fps: 0, thumbnailUrl: '', size: 1, createdAt: 0 },
    ],
    onProgress: () => {},
    ...overrides,
  };
}

const INTEGRATION_GLOBALS = ['VideoEncoder', 'VideoFrame', 'OfflineAudioContext', 'MediaRecorder', 'document', 'window', 'fetch'];
const savedGlobals: Record<string, unknown> = {};

beforeEach(() => {
  for (const key of INTEGRATION_GLOBALS) {
    savedGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  istate.renders = [];
  istate.requestedMimes = [];
  istate.effectiveMime = '';
  istate.audioTracksAtStart = -1;
  istate.recordersBuilt = 0;
  installDom();
  installAudio();
});

afterEach(() => {
  for (const key of INTEGRATION_GLOBALS) {
    const value = savedGlobals[key];
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
  vi.restoreAllMocks();
});

describe('W-39 · exportVideo con audio en un Firefox-like', () => {
  it('degrada al MIME con audio (vp8,opus) en vez de morir al 0 %', async () => {
    delete (globalThis as Record<string, unknown>).VideoEncoder;
    delete (globalThis as Record<string, unknown>).VideoFrame;
    installFirefoxLikeRecorder();
    const { exportVideo } = await import('../core/export/webcodecsExporter');

    const blob = await exportVideo(makeExportParams() as never);

    expect(blob.size).toBeGreaterThan(0);
    // El stream llevaba audio (el bug solo aparece con audio)…
    expect(istate.audioTracksAtStart).toBeGreaterThan(0);
    // …y el grabador no se quedó en el vp8 plano: progresó hasta el opus.
    expect(istate.requestedMimes).toEqual([
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
    ]);
    expect(istate.effectiveMime).toBe('video/webm;codecs=vp8,opus');
    expect(istate.renders.length).toBeGreaterThan(0);
  });

  it('si el hardware Y el respaldo fallan, el error menciona ambos y es accionable', async () => {
    installFailingExportEncoder();
    installAlwaysFailingRecorder();
    const { exportVideo } = await import('../core/export/webcodecsExporter');

    let thrown: Error | null = null;
    try {
      await exportVideo(makeExportParams() as never);
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).not.toBeNull();
    const message = thrown!.message;
    expect(message).toMatch(/hardware/i);
    expect(message).toMatch(/respaldo/i);
    expect(message).toMatch(/se probaron los formatos/);
    expect(message).toMatch(/video\/mp4;codecs=avc1/);
    expect(message).toMatch(/Chrome\/Edge/);
    expect(message).toMatch(/WebM/);
    // Los detalles técnicos originales se conservan (diagnóstico).
    expect(message).toMatch(/Operation is not supported/);
    expect(message).toMatch(/MediaRecorder/);
  });
});

/* ------------------------------------------------------------------ */
/* Fábrica mock (node no tiene MediaRecorder)                          */
/* ------------------------------------------------------------------ */
interface MockRecorder {
  mimeType: string;
  started: boolean;
  start(): void;
}

function makeFactory(opts: {
  log: Array<string | undefined>;
  ctorThrowsFor?: Set<string | undefined>;
  startThrowsFor?: Set<string | undefined>;
}) {
  return (_stream: unknown, options?: { mimeType?: string }): MockRecorder => {
    const mime = options?.mimeType;
    opts.log.push(mime);
    if (opts.ctorThrowsFor?.has(mime)) {
      throw new DOMException(`Unsupported mimeType: ${mime}`, 'NotSupportedError');
    }
    return {
      mimeType: mime || 'video/webm (default)',
      started: false,
      start() {
        if (opts.startThrowsFor?.has(mime)) {
          throw new DOMException(
            `MediaRecorder.start: An audio track cannot be recorded: ${mime} indicates an unsupported codec`,
            'NotSupportedError'
          );
        }
        (this as MockRecorder).started = true;
      },
    };
  };
}

const FAKE_STREAM = {} as MediaStream;

describe('W-39 · startRecorderWithFallback prueba de verdad (construir + start)', () => {
  it('si start() falla con el primer candidato, se prueba el segundo y se usa el que arranca', async () => {
    const { startRecorderWithFallback } = await import(
      '../core/export/webcodecsExporter'
    );
    const log: Array<string | undefined> = [];
    const factory = makeFactory({
      log,
      startThrowsFor: new Set(['video/webm;codecs=vp8']),
    });

    const result = startRecorderWithFallback(
      FAKE_STREAM,
      ['video/webm;codecs=vp8', 'video/webm;codecs=vp8,opus'],
      factory
    );

    // El caso exacto de Firefox: el primero pasa isTypeSupported pero su
    // start() muere; el segundo debe intentarse y ganar.
    expect(log).toEqual(['video/webm;codecs=vp8', 'video/webm;codecs=vp8,opus']);
    expect(result.mimeType).toBe('video/webm;codecs=vp8,opus');
    expect(result.recorder.started).toBe(true);
  });

  it('el constructor que lanza también pasa al siguiente candidato', async () => {
    const { startRecorderWithFallback } = await import(
      '../core/export/webcodecsExporter'
    );
    const log: Array<string | undefined> = [];
    const factory = makeFactory({
      log,
      ctorThrowsFor: new Set(['video/mp4;codecs=avc1', 'video/mp4']),
    });

    const result = startRecorderWithFallback(
      FAKE_STREAM,
      ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp8,opus'],
      factory
    );

    expect(log).toEqual(['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp8,opus']);
    expect(result.mimeType).toBe('video/webm;codecs=vp8,opus');
    expect(result.recorder.started).toBe(true);
  });

  it('si start() falla con todos, se prueba el default del navegador (sin mimeType)', async () => {
    const { startRecorderWithFallback } = await import(
      '../core/export/webcodecsExporter'
    );
    const log: Array<string | undefined> = [];
    const factory = makeFactory({
      log,
      startThrowsFor: new Set(['video/webm;codecs=vp8', 'video/webm;codecs=vp8,opus']),
    });

    const result = startRecorderWithFallback(
      FAKE_STREAM,
      ['video/webm;codecs=vp8', 'video/webm;codecs=vp8,opus'],
      factory
    );

    // Tras agotar los candidatos, el "retry with browser defaults" que el
    // comentario antiguo prometía y nunca ejecutaba.
    expect(log).toEqual(['video/webm;codecs=vp8', 'video/webm;codecs=vp8,opus', undefined]);
    expect(result.recorder.started).toBe(true);
    expect(result.mimeType).toBe('video/webm (default)');
  });

  it('si también el default falla, el error menciona el hardware y el respaldo, y es accionable', async () => {
    const { startRecorderWithFallback } = await import(
      '../core/export/webcodecsExporter'
    );
    const log: Array<string | undefined> = [];
    const factory = makeFactory({
      log,
      startThrowsFor: new Set(['video/webm;codecs=vp8', undefined]),
    });

    let thrown: Error | null = null;
    try {
      startRecorderWithFallback(FAKE_STREAM, ['video/webm;codecs=vp8'], factory, 6_000_000, {
        hardwareDetail: 'NotSupportedError: Operation is not supported',
      });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).not.toBeNull();
    const message = thrown!.message;
    // Las dos cosas que pasaron: el camino acelerado falló Y el respaldo tampoco grabó.
    expect(message).toMatch(/hardware/i);
    expect(message).toMatch(/respaldo/i);
    // Se probaron varios formatos…
    expect(message).toMatch(/video\/webm;codecs=vp8/);
    expect(message).toMatch(/automático del navegador|defaults/i);
    // …y es accionable, manteniendo el detalle técnico original.
    expect(message).toMatch(/Chrome\/Edge/);
    expect(message).toMatch(/NotSupportedError/);
  });

  it('con Chrome (todos los candidatos arrancan) el MIME elegido es el primero de la lista', async () => {
    const {
      startRecorderWithFallback,
      resolveRecorderMimeCandidates,
    } = await import('../core/export/webcodecsExporter');
    for (const format of ['mp4', 'webm'] as const) {
      const candidates = resolveRecorderMimeCandidates(format);
      const log: Array<string | undefined> = [];
      const result = startRecorderWithFallback(FAKE_STREAM, candidates, makeFactory({ log }));
      // Un solo intento: el primero ya arranca ⇒ el fallback de Chrome no cambia de byte.
      expect(log).toEqual([candidates[0]]);
      expect(result.mimeType).toBe(candidates[0]);
    }
    // Y el primero del camino MP4 sigue siendo el histórico.
    expect(resolveRecorderMimeCandidates('mp4')[0]).toBe('video/mp4;codecs=avc1');
  });
});

describe('W-39 · la lista de candidatos vale para un stream con audio', () => {
  it('incluye variantes con códec de audio y el contenedor bare', async () => {
    const { resolveRecorderMimeCandidates } = await import(
      '../core/export/webcodecsExporter'
    );
    for (const format of ['mp4', 'webm'] as const) {
      const candidates = resolveRecorderMimeCandidates(format);
      expect(candidates.some((m) => m.includes('opus'))).toBe(true);
      expect(candidates).toContain('video/webm');
    }
    // mp4 primero (Chrome no cambia ni un byte); las variantes con audio
    // van delante de las planas, que solo valen sin pista de audio.
    const mp4 = resolveRecorderMimeCandidates('mp4');
    expect(mp4[0]).toBe('video/mp4;codecs=avc1');
    expect(mp4[1]).toBe('video/mp4');
    expect(mp4.indexOf('video/webm;codecs=vp8,opus')).toBeLessThan(
      mp4.indexOf('video/webm;codecs=vp8')
    );
  });
});
