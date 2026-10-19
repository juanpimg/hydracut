/**
 * F4 — Velocidad coherente con el tono preservado (preview == export).
 *
 * El bug que se corrige:
 *  - el preview escribía `preservesPitch = false` en el elemento (chipmunk a 2x),
 *  - el export escribía `playbackRate` en el `AudioBufferSourceNode` SIN
 *    compensación de tono,
 *  - y la semántica estaba triplicada en tres ficheros sin fuente de verdad.
 *
 * La feature introduce UNA función pura (`resolvePlayback`) usada por las TRES
 * rutas (preview, motor de audio y exportador) y un control de usuario para
 * decidir si el tono se preserva.
 *
 * Todos los asserts de este fichero se hacen sobre el CÓDIGO DE PRODUCCIÓN:
 *  - `resolvePlayback()` (la función pura real),
 *  - `MediaSourcePool.applyPlayback()` / `applyPitchPolicy()` (elementos reales
 *    del pool, con sus escrituras observadas),
 *  - `AudioEngine.updateAudio()` (elemento del preview real),
 *  - `exportVideo()` (nodos de audio reales del `OfflineAudioContext`).
 *
 * No hay réplicas de la lógica: si se rompe la feature, estos tests fallan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  resolvePlayback,
  pitchFactorOf,
  applyPitchPolicyToElement,
  applyDetuneToParam,
  MIN_PLAYBACK_RATE,
  MAX_PLAYBACK_RATE,
} from '../core/utils/playbackRate';
import { MediaSourcePool, mediaSourcePool } from '../core/engine/MediaSourcePool';
import { AudioEngine } from '../core/engine/AudioEngine';
import { Clip, MediaItem, Track } from '../types/project';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media_1',
    name: 'voice.mp4',
    type: 'video',
    url: 'blob:test/media_1',
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

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip_1',
    trackId: 'track_v1',
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

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'track_v1',
    name: 'V1',
    type: 'video',
    isMuted: false,
    isLocked: false,
    isVisible: true,
    ...overrides,
  };
}

/**
 * Media element that RECORDS every write: the tests assert the values that
 * really reached the element, not the values of a re-implementation.
 */
class RecordingMediaElement {
  src = '';
  crossOrigin = '';
  preload = '';
  muted = true;
  paused = true;
  volume = 1;
  currentTime = 0;
  readyState = 4;
  videoWidth = 640;
  videoHeight = 360;
  seeking = false;
  preservesPitch = true;
  /** Values written to the element (the observable contract). */
  writes: { playbackRate: number[]; preservesPitch: boolean[] } = {
    playbackRate: [],
    preservesPitch: [],
  };

  private _playbackRate = 1;

  get playbackRate(): number {
    return this._playbackRate;
  }

  set playbackRate(value: number) {
    this._playbackRate = value;
    this.writes.playbackRate.push(value);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  removeAttribute(): void {}
  load(): void {}
  pause(): void {}
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  getContext(): { drawImage: () => void } {
    return { drawImage: () => {} };
  }
}

/* ------------------------------------------------------------------ */
/* 1 · La función pura                                                 */
/* ------------------------------------------------------------------ */

describe('F4 · resolvePlayback es la única fuente de verdad', () => {
  it('acota la velocidad a [0.0625, 4] y preserva el tono por defecto', () => {
    expect(resolvePlayback({ speed: 0.5 }).rate).toBe(0.5);
    expect(resolvePlayback({ speed: 1 }).rate).toBe(1);
    expect(resolvePlayback({ speed: 2 }).rate).toBe(2);
    expect(resolvePlayback({ speed: 4 }).rate).toBe(4);

    // Por debajo del suelo del navegador y por encima del techo del editor.
    expect(resolvePlayback({ speed: 0.01 }).rate).toBe(MIN_PLAYBACK_RATE);
    expect(resolvePlayback({ speed: 8 }).rate).toBe(MAX_PLAYBACK_RATE);

    // El pitch se preserva salvo que se pida explícitamente lo contrario.
    expect(resolvePlayback({}).preservesPitch).toBe(true);
    expect(resolvePlayback({ speed: 2 }).preservesPitch).toBe(true);
    expect(resolvePlayback({ speed: 2, preservePitch: undefined }).preservesPitch).toBe(true);
    expect(resolvePlayback({ speed: 2, preservePitch: true }).preservesPitch).toBe(true);
    expect(resolvePlayback({ speed: 2, preservePitch: false }).preservesPitch).toBe(false);
  });

  it('la compensación de tono es exacta en los casos límite', () => {
    // 1x no necesita compensación: 0 cents exactos.
    expect(resolvePlayback({ speed: 1 }).detuneCents).toBe(0);
    // 0.5x -> +1200 cents (una octava por debajo).
    expect(resolvePlayback({ speed: 0.5 }).detuneCents).toBeCloseTo(1200, 6);
    // 2x -> -1200 cents (una octava por encima).
    expect(resolvePlayback({ speed: 2 }).detuneCents).toBeCloseTo(-1200, 6);
    // 4x -> -2400 cents.
    expect(resolvePlayback({ speed: 4 }).detuneCents).toBeCloseTo(-2400, 6);
    // El suelo del navegador (2^-4) -> +4800 cents.
    expect(resolvePlayback({ speed: MIN_PLAYBACK_RATE }).detuneCents).toBeCloseTo(4800, 6);

    // Sin preservar el tono no hay compensación: el tono se desplaza.
    expect(resolvePlayback({ speed: 2, preservePitch: false }).detuneCents).toBe(0);
  });

  it('la compensación cancela exactamente el desplazamiento de tono', () => {
    for (const speed of [0.0625, 0.25, 0.5, 1, 1.5, 2, 3, 4]) {
      const preserved = resolvePlayback({ speed });
      // Con el tono preservado el factor de tono es 1 (el original).
      expect(pitchFactorOf(preserved)).toBeCloseTo(1, 9);
      // Sin preservarlo, el tono se desplaza con la velocidad.
      const shifted = resolvePlayback({ speed, preservePitch: false });
      expect(pitchFactorOf(shifted)).toBeCloseTo(speed, 9);
    }
  });

  it('un clip sin velocidad (o degenerado) se reproduce a 1x', () => {
    expect(resolvePlayback({}).rate).toBe(1);
    expect(resolvePlayback({ speed: undefined }).rate).toBe(1);
    // `speed <= 0` o no finito significan 1x (convención del resto del editor:
    // la duración del clip y su `sourceStart` se calculan con `speed > 0`).
    expect(resolvePlayback({ speed: 0 }).rate).toBe(1);
    expect(resolvePlayback({ speed: -2 }).rate).toBe(1);
    expect(resolvePlayback({ speed: Number.NaN }).rate).toBe(1);
  });

  it('applyDetuneToParam escribe el valor en el AudioParam (y en su valor intrínseco)', () => {
    const calls: Array<[number, number]> = [];
    const param = {
      value: 0,
      setValueAtTime: (v: number, t: number) => {
        calls.push([v, t]);
      },
    } as unknown as AudioParam;

    applyDetuneToParam(param, -1200);
    expect(calls[0][0]).toBe(-1200);
    expect(calls[0][1]).toBe(0);
    expect(param.value).toBe(-1200);

    // Un motor sin `detune` no debe romper nada.
    expect(() => applyDetuneToParam(undefined, -1200)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 2 · El preview (MediaSourcePool)                                    */
/* ------------------------------------------------------------------ */

describe('F4 · el preview aplica la reproducción resuelta', () => {
  it('el elemento del preview recibe la velocidad y la política de tono', () => {
    const pool = new MediaSourcePool();
    const el = new RecordingMediaElement();

    const resolved = pool.applyPlayback(el as unknown as HTMLMediaElement, { speed: 2 });

    expect(resolved.rate).toBe(2);
    expect(el.playbackRate).toBe(2);
    expect(el.writes.playbackRate).toContain(2);
    // El pitch se preserva por defecto: NO se fuerza `preservesPitch = false`.
    expect(el.preservesPitch).toBe(true);
  });

  it('con preservePitch=false el elemento deja de preservar el tono', () => {
    const pool = new MediaSourcePool();
    const el = new RecordingMediaElement();

    pool.applyPlayback(el as unknown as HTMLMediaElement, { speed: 2, preservePitch: false });

    expect(el.playbackRate).toBe(2);
    expect(el.preservesPitch).toBe(false);
  });

  it('escribe también las variantes con prefijo cuando existen', () => {
    const el = {
      preservesPitch: true,
      webkitPreservesPitch: true,
      mozPreservesPitch: true,
    } as unknown as HTMLMediaElement;

    applyPitchPolicyToElement(el, false);

    expect(el.preservesPitch).toBe(false);
    expect((el as unknown as { webkitPreservesPitch: boolean }).webkitPreservesPitch).toBe(false);
    expect((el as unknown as { mozPreservesPitch: boolean }).mozPreservesPitch).toBe(false);
  });

  it('los elementos que crea el pool arrancan preservando el tono', () => {
    const pool = new MediaSourcePool();
    const originalDocument = (globalThis as Record<string, unknown>).document;
    const originalAudio = (globalThis as Record<string, unknown>).Audio;
    (globalThis as Record<string, unknown>).document = {
      createElement: () => new RecordingMediaElement(),
    };
    (globalThis as Record<string, unknown>).Audio = class {
      src = '';
      crossOrigin = '';
      preload = '';
      muted = true;
      paused = true;
      volume = 1;
      playbackRate = 1;
      currentTime = 0;
      readyState = 4;
      preservesPitch = true;
      addEventListener(): void {}
      removeEventListener(): void {}
      removeAttribute(): void {}
      load(): void {}
      pause(): void {}
      play(): Promise<void> {
        return Promise.resolve();
      }
    };
    try {
      const video = pool.getVideoElement(makeMedia(), 'clip_1') as unknown as RecordingMediaElement;
      const audio = pool.getAudioElement(makeMedia(), 'clip_1') as unknown as RecordingMediaElement;
      // El código anterior forzaba `preservesPitch = false` (chipmunk).
      expect(video.preservesPitch).toBe(true);
      expect(audio.preservesPitch).toBe(true);
    } finally {
      (globalThis as Record<string, unknown>).document = originalDocument;
      (globalThis as Record<string, unknown>).Audio = originalAudio;
    }
  });

  it('el controlador de sincronización del vídeo usa la velocidad resuelta', () => {
    const pool = new MediaSourcePool();

    // Una velocidad fuera de rango se acota igual que en el export.
    const fast = new RecordingMediaElement();
    fast.paused = false;
    fast.currentTime = 1;
    pool.syncVideoTime(fast as unknown as HTMLVideoElement, 1, true, 8);
    expect(fast.playbackRate).toBe(MAX_PLAYBACK_RATE);

    const normal = new RecordingMediaElement();
    normal.paused = false;
    normal.currentTime = 1;
    pool.syncVideoTime(normal as unknown as HTMLVideoElement, 1, true, 2);
    expect(normal.playbackRate).toBe(2);
  });

  it('applyPlayback puede aplicar solo la política de tono (vídeo)', () => {
    const pool = new MediaSourcePool();
    const el = new RecordingMediaElement();

    pool.applyPlayback(el as unknown as HTMLMediaElement, { speed: 2 }, { applyRate: false });

    // La velocidad la gobierna el controlador de sincronización...
    expect(el.writes.playbackRate).toHaveLength(0);
    // ...pero el tono es una decisión del clip.
    expect(el.preservesPitch).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 3 · El export (webcodecsExporter)                                   */
/* ------------------------------------------------------------------ */

interface RecordedSource {
  rate: number;
  detune: number;
  when: number;
  offset: number;
  duration: number;
}

const exportState = vi.hoisted(() => ({
  sources: [] as Array<{
    rate: number;
    detune: number;
    when: number;
    offset: number;
    duration: number;
  }>,
}));

vi.mock('../core/engine/Compositor', () => {
  class MockCompositor {
    renderFrame(): void {}
    clear(): void {}
  }
  return { Compositor: MockCompositor };
});

class FakeAudioParam {
  value = 0;
  setValueAtTime(v: number, _t: number): void {
    this.value = v;
  }
}

function installExportEnvironment(): void {
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ fillRect: () => {}, drawImage: () => {}, save: () => {}, restore: () => {} }),
          captureStream: () => ({
            tracks: [] as unknown[],
            getTracks: () => [] as unknown[],
            addTrack: () => {},
          }),
        };
      }
      if (tag === 'video') {
        const listeners: Record<string, Array<() => void>> = {};
        let time = 0;
        return {
          readyState: 4,
          paused: true,
          playbackRate: 1,
          preservesPitch: true,
          videoWidth: 320,
          videoHeight: 180,
          src: '',
          seeking: false,
          muted: true,
          get currentTime(): number {
            return time;
          },
          set currentTime(value: number) {
            time = value;
            // Un `<video>` real emite "seeked" al terminar el salto.
            setTimeout(() => {
              for (const cb of [...(listeners['seeked'] ?? [])]) cb();
            }, 0);
          },
          addEventListener: (type: string, cb: () => void) => {
            (listeners[type] ||= []).push(cb);
          },
          removeEventListener: (type: string, cb: () => void) => {
            const list = listeners[type];
            if (!list) return;
            const idx = list.indexOf(cb);
            if (idx >= 0) list.splice(idx, 1);
          },
          removeAttribute: () => {},
          load: () => {},
          pause: () => {},
          play: () => Promise.resolve(),
        };
      }
      return {} as unknown as HTMLElement;
    },
    body: { appendChild: () => {}, removeChild: () => {} },
  };

  class FakeOfflineAudioContext {
    length: number;
    sampleRate = 48000;
    destination = {};
    constructor(_channels: number, length: number) {
      this.length = length;
    }
    createBufferSource() {
      const node = {
        buffer: null as unknown,
        playbackRate: { value: 1 },
        detune: new FakeAudioParam(),
        connect: () => {},
        start: (when: number, offset: number, duration: number) => {
          // Se captura el `detune` EN EL MOMENTO de `start()`: si la
          // compensación se escribiera después, aquí valdría 0.
          exportState.sources.push({
            rate: node.playbackRate.value,
            detune: node.detune.value,
            when,
            offset,
            duration,
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
      // Buffer largo: la ventana de fuente que consume un clip acelerado
      // (`duration * rate`) debe caber dentro del medio.
      const length = 47 * this.sampleRate;
      return {
        duration: 47,
        length,
        sampleRate: this.sampleRate,
        numberOfChannels: 2,
        getChannelData: () => new Float32Array(length),
      };
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

  (globalThis as Record<string, unknown>).window = {
    AudioContext: class {
      state = 'running';
      currentTime = 0;
      destination = {};
      createMediaElementSource() {
        return { connect: () => {} };
      }
      createMediaStreamDestination() {
        return { stream: { getAudioTracks: () => [{ kind: 'audio', stop: () => {} }] } };
      }
      createBufferSource() {
        // Nodo para reproducir el audio YA renderizado en el stream del
        // grabador: va a velocidad 1 y no participa del contrato de tono.
        return {
          buffer: null,
          playbackRate: { value: 1 },
          detune: new FakeAudioParam(),
          connect: () => {},
          start: () => {},
        };
      }
      createGain() {
        return { gain: { value: 1 }, connect: () => {} };
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    },
  };

  (globalThis as Record<string, unknown>).fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(1234),
  });

  class FakeMediaRecorder {
    static isTypeSupported = () => true;
    state: 'inactive' | 'recording' = 'inactive';
    mimeType = 'video/webm;codecs=vp9';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(_stream: unknown) {}
    start(): void {
      this.state = 'recording';
    }
    stop(): void {
      this.state = 'inactive';
      setTimeout(() => {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
        this.onstop?.();
      }, 0);
    }
  }
  (globalThis as Record<string, unknown>).MediaRecorder = FakeMediaRecorder;

  // Sin WebCodecs se usa el camino de respaldo (MediaRecorder), que también
  // renderiza el audio con el MISMO `renderOfflineAudio()`.
  delete (globalThis as Record<string, unknown>).VideoEncoder;
  delete (globalThis as Record<string, unknown>).VideoFrame;
}

/** Exporta un clip y devuelve los nodos de audio creados por el exportador. */
async function exportAndCaptureSources(clip: Clip): Promise<RecordedSource[]> {
  exportState.sources.length = 0;
  const { exportVideo } = await import('../core/export/webcodecsExporter');
  await exportVideo({
    config: {
      aspectRatio: '16:9',
      width: 320,
      height: 180,
      fps: 30,
      bitrate: 500_000,
      format: 'mp4',
    },
    duration: 0.2,
    tracks: [makeTrack()],
    clips: [clip],
    mediaPool: [makeMedia()],
    onProgress: () => {},
  });
  return exportState.sources;
}

describe('F4 · el export aplica la reproducción resuelta', () => {
  beforeEach(() => {
    exportState.sources.length = 0;
    installExportEnvironment();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).OfflineAudioContext;
    delete (globalThis as Record<string, unknown>).MediaRecorder;
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
    delete (globalThis as Record<string, unknown>).fetch;
  });

  it('el nodo de audio del export recibe la velocidad y la compensación de tono', async () => {
    const sources = await exportAndCaptureSources(makeClip({ speed: 2 }));

    expect(sources.length).toBe(1);
    expect(sources[0].rate).toBe(2);
    // El detune se escribe ANTES de start(): se captura en el start().
    expect(sources[0].detune).toBeCloseTo(-1200, 6);
  });

  it('con preservePitch=false el export NO compensa el tono', async () => {
    const sources = await exportAndCaptureSources(
      makeClip({ speed: 2, preservePitch: false })
    );

    expect(sources.length).toBe(1);
    expect(sources[0].rate).toBe(2);
    expect(sources[0].detune).toBe(0);
  });

  it('la duración de la fuente consumida es la misma que en el preview', async () => {
    // `clip.duration` son segundos de timeline; la fuente consumida es
    // `duration * rate` (velocidad de 2x -> 8 s de buffer para 4 s de clip).
    const sources = await exportAndCaptureSources(makeClip({ duration: 4, speed: 2 }));
    expect(sources[0].duration).toBeCloseTo(8, 3);
  });
});

/* ------------------------------------------------------------------ */
/* 4 · EL CONTRATO: preview == export                                   */
/* ------------------------------------------------------------------ */

describe('F4 · preview == export (el contrato real de la feature)', () => {
  beforeEach(() => {
    exportState.sources.length = 0;
    installExportEnvironment();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).OfflineAudioContext;
    delete (globalThis as Record<string, unknown>).MediaRecorder;
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
    delete (globalThis as Record<string, unknown>).fetch;
  });

  const SPEEDS = [0.5, 1, 2, 4];

  for (const speed of SPEEDS) {
    for (const preservePitch of [true, false]) {
      it(`la velocidad ${speed}x (preservePitch=${preservePitch}) coincide en preview y export`, async () => {
        const clip = makeClip({ speed, preservePitch });
        const expected = resolvePlayback(clip);

        /* --- PREVIEW: el elemento del pool --- */
        const pool = new MediaSourcePool();
        const el = new RecordingMediaElement();
        pool.applyPlayback(el as unknown as HTMLMediaElement, clip);

        /* --- EXPORT: el nodo de audio del exportador --- */
        const sources = await exportAndCaptureSources(clip);
        expect(sources.length).toBe(1);
        const source = sources[0];

        // 1) La velocidad es la misma en las dos rutas.
        expect(el.playbackRate).toBe(expected.rate);
        expect(source.rate).toBe(expected.rate);

        // 2) El tono efectivo es el mismo en las dos rutas.
        //    Preview: `preservesPitch` -> factor 1, si no -> factor `rate`.
        //    Export : `rate * 2^(detune/1200)`.
        const previewPitchFactor = expected.preservesPitch ? 1 : expected.rate;
        const exportPitchFactor = expected.rate * Math.pow(2, source.detune / 1200);
        expect(exportPitchFactor).toBeCloseTo(previewPitchFactor, 9);

        // 3) La política de tono del preview es la del clip.
        expect(el.preservesPitch).toBe(expected.preservesPitch);

        // 4) La duración del clip es la misma en las dos rutas (mismo `rate`).
        expect(source.duration / source.rate).toBeCloseTo(clip.duration, 6);
      });
    }
  }
});

/* ------------------------------------------------------------------ */
/* 5 · El motor de audio (preview)                                     */
/* ------------------------------------------------------------------ */

describe('F4 · el AudioEngine aplica la política de tono del clip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('escribe preservesPitch=false cuando el clip lo pide', () => {
    const el = new RecordingMediaElement();
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(
      el as unknown as HTMLAudioElement
    );

    const engine = new AudioEngine();
    engine.updateAudio(
      1,
      true,
      [makeTrack({ id: 'track_a1', type: 'audio' })],
      [makeClip({ type: 'audio', trackId: 'track_a1', speed: 2, preservePitch: false })],
      [makeMedia({ type: 'audio' })]
    );

    expect(el.preservesPitch).toBe(false);
    // La velocidad del elemento del preview es la velocidad resuelta.
    expect(el.playbackRate).toBe(2);
  });

  it('mantiene el tono cuando el clip no dice nada (valor por defecto)', () => {
    const el = new RecordingMediaElement();
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(
      el as unknown as HTMLAudioElement
    );

    const engine = new AudioEngine();
    engine.updateAudio(
      1,
      true,
      [makeTrack({ id: 'track_a1', type: 'audio' })],
      [makeClip({ type: 'audio', trackId: 'track_a1', speed: 2 })],
      [makeMedia({ type: 'audio' })]
    );

    expect(el.preservesPitch).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 6 · El control de usuario (Inspector)                               */
/* ------------------------------------------------------------------ */

describe('F4 · el Inspector ofrece el control de tono', () => {
  it('el Inspector renderiza el interruptor de "Preservar el tono (pitch)"', () => {
    // El DOM no se puede montar en el entorno node: se comprueba el cableado
    // real del control (mismo patrón que el resto de guards DOM de la suite).
    const inspector = readFileSync(
      new URL('../components/inspector/ClipInspector.tsx', import.meta.url),
      'utf8'
    );

    expect(inspector).toContain('Preservar el tono (pitch)');
    expect(inspector).toContain('clip-preserve-pitch');
    // El control escribe el campo del clip (no un estado local).
    expect(inspector).toMatch(/preservePitch: e\.target\.checked/);
    // Y el valor por defecto es "preservar" (undefined -> true).
    expect(inspector).toMatch(/checked=\{clip\.preservePitch !== false\}/);
  });
});
