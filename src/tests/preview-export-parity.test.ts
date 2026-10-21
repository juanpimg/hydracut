/**
 * W-B · Paridad preview ≡ export (A1–A4).
 *
 * La regla dura del proyecto: el mismo clip debe verse y oírse idéntico en
 * el visor y en el archivo exportado. Cada test de este archivo ejercita el
 * CÓDIGO DE PRODUCCIÓN (AudioEngine, renderOfflineAudio, Compositor,
 * seekActiveVideoClips, MasterClock, resolvePlayback), nunca una copia.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AudioEngine } from '../core/engine/AudioEngine';
import { Compositor } from '../core/engine/Compositor';
import { MasterClock } from '../core/engine/MasterClock';
import { mediaSourcePool } from '../core/engine/MediaSourcePool';
import {
  renderOfflineAudio,
  seekActiveVideoClips,
} from '../core/export/webcodecsExporter';
import { fadeDurationScale } from '../core/utils/audioFades';
import { resolvePlayback } from '../core/utils/playbackRate';
import type { Clip, MediaItem, Track } from '../types/project';

/* ------------------------------------------------------------------ */
/* Dobles de test                                                       */
/* ------------------------------------------------------------------ */

class FakeMediaElement {
  src = '';
  volume = 1;
  muted = false;
  paused = false;
  playbackRate = 1;
  currentTime = 0;
  readyState = 4;
  preservesPitch = true;
  seeking = false;
  listeners: Record<string, Array<() => void>> = {};
  addEventListener(type: string, cb: () => void): void {
    (this.listeners[type] ||= []).push(cb);
  }
  removeEventListener(): void {}
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 't_audio',
    name: 'Audio',
    type: 'audio',
    isMuted: false,
    isLocked: false,
    isVisible: true,
    ...overrides,
  };
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't_audio',
    mediaId: 'm1',
    name: 'Clip',
    type: 'audio',
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
    id: 'm1',
    name: 'Media',
    type: 'audio',
    url: 'blob:media',
    duration: 30,
    width: 0,
    height: 0,
    fps: 30,
    thumbnailUrl: '',
    size: 100,
    createdAt: 0,
    ...overrides,
  };
}

interface RecordedGainEvent {
  type: 'set' | 'linearRamp';
  time: number;
  value: number;
}

/** Graba los eventos de automatización de cada `GainNode` creado. */
function installOfflineAudioFakes(state: {
  starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
  gains: Array<{ events: RecordedGainEvent[] }>;
}): void {
  (globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
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
        detune: { value: 0, setValueAtTime: () => {} },
        connect: () => {},
        start: (when: number, offset: number, duration: number) => {
          state.starts.push({ when, offset, duration, rate: node.playbackRate.value });
        },
      };
      return node;
    }
    createGain() {
      const recorded: { events: RecordedGainEvent[] } = { events: [] };
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
    createStereoPanner() {
      return { pan: { value: 0 }, connect: () => {} };
    }
    createBiquadFilter() {
      return {
        type: '',
        frequency: { value: 0 },
        Q: { value: 1 },
        gain: { value: 0 },
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

/** Evalúa eventos set/linearRamp con semántica WebAudio en `t`. */
function evaluateEnvelope(events: RecordedGainEvent[], t: number): number {
  if (events.length === 0) return 1;
  let prevTime = events[0].time;
  let prevValue = events[0].value;
  if (t <= prevTime) return prevValue;
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    if (t <= e.time) {
      if (e.type === 'set' || e.time === prevTime) return e.value;
      const k = (t - prevTime) / (e.time - prevTime);
      return prevValue + (e.value - prevValue) * k;
    }
    prevTime = e.time;
    prevValue = e.value;
  }
  return prevValue;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).OfflineAudioContext;
  delete (globalThis as Record<string, unknown>).fetch;
  delete (globalThis as Record<string, unknown>).AudioContext;
  delete (globalThis as Record<string, unknown>).webkitAudioContext;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* A1 · los fundidos de borde se reescalan igual en preview y export    */
/* ------------------------------------------------------------------ */

describe('A1 · fundidos de borde con in+out > duración', () => {
  // Clip de 1 s con fundidos de 0,8 + 0,8 (p. ej. fundidos puestos y luego
  // un trim que acorta el clip).
  const trimClip = (): Clip =>
    makeClip({
      id: 'trim',
      start: 10,
      duration: 1,
      volume: 1,
      transition: {
        fadeInType: 'fade-black',
        fadeInDuration: 0.8,
        fadeOutType: 'fade-black',
        fadeOutDuration: 0.8,
      },
    });

  it('el helper compartido reescala in+out a la duración del clip', () => {
    // 0,8 + 0,8 = 1,6 > 1 → escala 0,625 (la que ya usa el export).
    expect(fadeDurationScale(0.8, 0.8, 1)).toBeCloseTo(0.625, 12);
    // Sin solape no hay escala.
    expect(fadeDurationScale(0.3, 0.3, 1)).toBe(1);
    expect(fadeDurationScale(0, 0, 1)).toBe(1);
  });

  it('el preview aplica la misma escala que el export (antes: 0,39 vs 1,0)', async () => {
    const clip = trimClip();
    const element = new FakeMediaElement();
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(
      element as unknown as HTMLAudioElement
    );

    const engine = new AudioEngine();
    engine.updateAudio(10.5, true, [makeTrack()], [clip], [makeMedia()]);

    const state = { starts: [], gains: [] } as {
      starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
      gains: Array<{ events: RecordedGainEvent[] }>;
    };
    installOfflineAudioFakes(state);
    await renderOfflineAudio(12, [makeTrack()], [clip], [makeMedia()]);

    // A mitad del clip (10,5) ambas envolventes valen 1,0.
    expect(element.volume).toBeCloseTo(1, 3);
    expect(evaluateEnvelope(state.gains[0].events, 10.5)).toBeCloseTo(1, 3);
    expect(element.volume).toBeCloseTo(
      evaluateEnvelope(state.gains[0].events, 10.5),
      3
    );
  });

  it('preview y export acuerdan en TODO el clip reescalado', async () => {
    const clip = trimClip();
    const track = makeTrack();
    const media = [makeMedia()];

    const state = { starts: [], gains: [] } as {
      starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
      gains: Array<{ events: RecordedGainEvent[] }>;
    };
    installOfflineAudioFakes(state);
    await renderOfflineAudio(12, [track], [clip], media);
    const exportEvents = state.gains[0].events;

    for (const t of [10.0, 10.1, 10.25, 10.4, 10.5, 10.6, 10.75, 10.9, 10.99]) {
      const element = new FakeMediaElement();
      vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(
        element as unknown as HTMLAudioElement
      );
      const engine = new AudioEngine();
      engine.updateAudio(t, true, [track], [clip], media);
      expect(element.volume).toBeCloseTo(evaluateEnvelope(exportEvents, t), 2);
    }
  });
});

/* ------------------------------------------------------------------ */
/* A2 · el volumen general (master) es ganancia de mezcla: va al export */
/* ------------------------------------------------------------------ */

describe('A2 · el volumen general se aplica en preview Y en export', () => {
  it('master 0,5 atenúa igual en el elemento y en la automatización', async () => {
    const clip = makeClip({ volume: 0.8 });
    const element = new FakeMediaElement();
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(
      element as unknown as HTMLAudioElement
    );

    const engine = new AudioEngine();
    engine.setMasterVolume(0.5);
    engine.updateAudio(1, true, [makeTrack()], [clip], [makeMedia()]);
    expect(element.volume).toBeCloseTo(0.4, 6);

    const state = { starts: [], gains: [] } as {
      starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
      gains: Array<{ events: RecordedGainEvent[] }>;
    };
    installOfflineAudioFakes(state);
    await renderOfflineAudio(8, [makeTrack()], [clip], [makeMedia()], undefined, 0.5);
    expect(state.gains[0].events).toEqual([{ type: 'set', time: 0, value: 0.4 }]);
  });

  it('master 0 silencia el preview y exporta silencio (no al 100 %)', async () => {
    const clip = makeClip({ volume: 0.8 });
    const element = new FakeMediaElement();
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(
      element as unknown as HTMLAudioElement
    );

    const engine = new AudioEngine();
    engine.setMasterVolume(0);
    engine.updateAudio(1, true, [makeTrack()], [clip], [makeMedia()]);
    expect(element.muted).toBe(true);

    const state = { starts: [], gains: [] } as {
      starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
      gains: Array<{ events: RecordedGainEvent[] }>;
    };
    installOfflineAudioFakes(state);
    const rendered = await renderOfflineAudio(
      8,
      [makeTrack()],
      [clip],
      [makeMedia()],
      undefined,
      0
    );
    expect(rendered).not.toBeNull();
    for (const e of state.gains[0].events) {
      expect(e.value).toBe(0);
    }
  });

  it('sin master explícito el export suena al 100 % (comportamiento intacto)', async () => {
    const clip = makeClip({ volume: 0.8 });
    const state = { starts: [], gains: [] } as {
      starts: Array<{ when: number; offset: number; duration: number; rate: number }>;
      gains: Array<{ events: RecordedGainEvent[] }>;
    };
    installOfflineAudioFakes(state);
    await renderOfflineAudio(8, [makeTrack()], [clip], [makeMedia()]);
    expect(state.gains[0].events).toEqual([{ type: 'set', time: 0, value: 0.8 }]);
  });
});

/* ------------------------------------------------------------------ */
/* A3 · la velocidad resuelta manda en el vídeo (preview y export)      */
/* ------------------------------------------------------------------ */

describe('A3 · speed fuera de rango usa resolvePlayback en el vídeo', () => {
  const videoTrack: Track = {
    id: 't_video',
    name: 'Video',
    type: 'video',
    isMuted: false,
    isLocked: false,
    isVisible: true,
  };

  function fastClip(): Clip {
    return makeClip({
      id: 'fast',
      trackId: 't_video',
      type: 'video',
      start: 0,
      duration: 5,
      sourceStart: 0,
      speed: 10,
    });
  }

  function videoMedia(): MediaItem {
    return makeMedia({ id: 'm1', type: 'video', duration: 100, width: 640, height: 360 });
  }

  function fakeCanvas() {
    return {
      width: 640,
      height: 360,
      getContext: () => ({
        fillStyle: '',
        globalAlpha: 1,
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
        setTransform: vi.fn(),
      }),
    } as unknown as HTMLCanvasElement;
  }

  it('el preview posiciona el vídeo a 4x (no a 10x en crudo)', () => {
    const clip = fastClip();
    const compositor = new Compositor();
    (compositor as unknown as { drawMediaToCanvas: unknown }).drawMediaToCanvas = vi
      .fn()
      .mockReturnValue(true);

    vi.spyOn(mediaSourcePool, 'getVideoElement').mockReturnValue(
      new FakeMediaElement() as unknown as HTMLVideoElement
    );
    vi.spyOn(mediaSourcePool, 'getLastFrame').mockReturnValue(null);
    vi.spyOn(mediaSourcePool, 'getLastFrameForSource').mockReturnValue(null);
    const seenTargets: number[] = [];
    vi.spyOn(mediaSourcePool, 'syncVideoTime').mockImplementation(
      (_video: unknown, targetTime: number) => {
        seenTargets.push(targetTime);
      }
    );

    compositor.renderFrame({
      time: 1,
      canvas: fakeCanvas(),
      tracks: [videoTrack],
      clips: [clip],
      mediaPool: [videoMedia()],
      isPlaying: true,
    });

    // sourceStart + 1 s × rate(10→4) = 4, no 10.
    expect(seenTargets.length).toBeGreaterThan(0);
    for (const target of seenTargets) {
      expect(target).toBeCloseTo(4, 9);
    }
  });

  it('el export busca el vídeo a 4x (no a 10x en crudo)', async () => {
    const clip = fastClip();
    const media = videoMedia();
    const mediaMap = new Map([[media.id, media]]);
    const elements = new Map<string, { currentTime: number }>();
    const getVideoElement = (_m: MediaItem, clipId?: string) => {
      const el = {
        currentTime: 0,
        readyState: 4,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      elements.set(clipId ?? '', el);
      return el as unknown as HTMLVideoElement;
    };

    await seekActiveVideoClips(1, [clip], mediaMap, getVideoElement);
    expect(elements.get('fast')?.currentTime).toBeCloseTo(4, 9);
  });

  it('preview y export avanzan la ventana de fuente al mismo ritmo', async () => {
    for (const speed of [10, 0.05]) {
      const rate = resolvePlayback({ speed }).rate;
      expect(rate).toBe(speed === 10 ? 4 : 0.0625);

      const clip = { ...fastClip(), speed };
      const media = videoMedia();
      const mediaMap = new Map([[media.id, media]]);
      const elements = new Map<string, { currentTime: number }>();
      await seekActiveVideoClips(
        2,
        [clip],
        mediaMap,
        (_m: MediaItem, clipId?: string) => {
          const el = {
            currentTime: 0,
            readyState: 4,
            addEventListener: () => {},
            removeEventListener: () => {},
          };
          elements.set(clipId ?? '', el);
          return el as unknown as HTMLVideoElement;
        }
      );
      // Ventana de fuente del export: sourceStart + 2 s × rate.
      expect(elements.get('fast')?.currentTime).toBeCloseTo(2 * rate, 9);
    }
  });
});

/* ------------------------------------------------------------------ */
/* A4 · getTime() es una lectura pura                                   */
/* ------------------------------------------------------------------ */

describe('A4 · MasterClock.getTime() no muta la fuente del reloj', () => {
  class MockAudioContext {
    state: AudioContextState = 'running';
    currentTime = 0;
    destination = {};
    resume = vi.fn().mockResolvedValue(undefined);
  }

  function bootClock(): { clock: MasterClock; ctx: MockAudioContext } {
    const ctx = new MockAudioContext();
    (globalThis as Record<string, unknown>).AudioContext = vi
      .fn()
      .mockImplementation(() => ctx);
    let wall = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    const clock = new MasterClock();
    clock.setDuration(60);
    clock.play();
    // Una muestra sana: el reloj va sobre el reloj de audio.
    wall += 16;
    ctx.currentTime += 0.016;
    clock.tick();
    expect(clock.getClockSource()).toBe('audio');
    return { clock, ctx };
  }

  it('una llamada a getTime() no cambia la fuente audio→perf', () => {
    const { clock } = bootClock();
    // El reloj de audio se congela pero el muro avanza: ANTES del fix, una
    // sola lectura ya enclavaba el failover a 'perf'.
    vi.mocked(performance.now).mockImplementation(() => 10_000 + 16 + 300);
    expect(clock.getTime()).toBeGreaterThan(0);
    expect(clock.getClockSource()).toBe('audio');
    expect(clock.getTime()).toBe(clock.getTime());
    expect(clock.getClockSource()).toBe('audio');
  });

  it('solo tick()/pause()/seek() muestrean: tick() sí enclava el failover', () => {
    const { clock } = bootClock();
    vi.mocked(performance.now).mockImplementation(() => 10_000 + 16 + 300);
    clock.getTime();
    expect(clock.getClockSource()).toBe('audio');
    clock.tick();
    expect(clock.getClockSource()).toBe('perf');
    // Continuidad: sin salto ni congelado tras el failover.
    expect(clock.getTime()).toBeGreaterThan(0.2);
  });
});
