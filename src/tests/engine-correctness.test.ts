/**
 * Regression tests for the engine correctness wave (O3).
 *
 * Every test in this file exercises the PRODUCTION code paths
 * (`syncVideoTime`, `calculateTransition`, `MasterClock`, `MediaSourcePool`,
 * `AudioEngine`, `Compositor`). Nothing here re-implements the logic under
 * test: the assertions are made on the observable behaviour of the real
 * classes.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MasterClock, masterClock, CLOCK_STALL_THRESHOLD } from '../core/engine/MasterClock';
import { MediaSourcePool, mediaSourcePool, MIN_PLAYBACK_RATE } from '../core/engine/MediaSourcePool';
import { AudioEngine } from '../core/engine/AudioEngine';
import { Compositor, calculateTransition } from '../core/engine/Compositor';
import { Clip, MediaItem, Track } from '../types/project';

/* ------------------------------------------------------------------ */
/* Test doubles                                                         */
/* ------------------------------------------------------------------ */

class FakeMediaElement {
  src = '';
  crossOrigin = '';
  preload = '';
  muted = true;
  paused = true;
  volume = 1;
  playbackRate = 1;
  currentTime = 0;
  readyState = 1;
  videoWidth = 640;
  videoHeight = 360;
  seeking = false;
  preservesPitch = true;
  width = 0;
  height = 0;
  listeners: Record<string, Array<(payload?: unknown) => void>> = {};
  pauseCalls = 0;
  loadCalls = 0;
  removedAttributes: string[] = [];
  playCalls = 0;
  playShouldFail = false;

  addEventListener(type: string, cb: (payload?: unknown) => void): void {
    (this.listeners[type] ||= []).push(cb);
  }
  removeEventListener(type: string, cb: (payload?: unknown) => void): void {
    const list = this.listeners[type];
    if (!list) return;
    const idx = list.indexOf(cb);
    if (idx >= 0) list.splice(idx, 1);
  }
  dispatch(type: string, payload?: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(payload);
  }
  pause(): void {
    this.paused = true;
    this.pauseCalls++;
  }
  load(): void {
    this.loadCalls++;
  }
  removeAttribute(name: string): void {
    this.removedAttributes.push(name);
    if (name === 'src') this.src = '';
  }
  getContext(): { drawImage: () => void } {
    return { drawImage: () => {} };
  }
  play(): Promise<void> {
    this.playCalls++;
    if (this.playShouldFail) return Promise.reject(new Error('media cannot be played'));
    this.paused = false;
    return Promise.resolve();
  }
}

class MockAudioContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  destination = { name: 'destination' } as unknown as AudioDestinationNode;
  resume = vi.fn().mockResolvedValue(undefined);
  createdGains: Array<{ gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  createdSources: Array<{ connect: ReturnType<typeof vi.fn> }> = [];

  createGain() {
    const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    this.createdGains.push(node);
    return node;
  }
  createMediaElementSource() {
    const node = { connect: vi.fn() };
    this.createdSources.push(node);
    return node;
  }
}

const originalGlobals: Record<string, unknown> = {
  AudioContext: (globalThis as Record<string, unknown>).AudioContext,
  webkitAudioContext: (globalThis as Record<string, unknown>).webkitAudioContext,
  Audio: (globalThis as Record<string, unknown>).Audio,
  Image: (globalThis as Record<string, unknown>).Image,
  document: (globalThis as Record<string, unknown>).document,
  HTMLVideoElement: (globalThis as Record<string, unknown>).HTMLVideoElement,
};

function installFakeDOM(): void {
  (globalThis as Record<string, unknown>).document = {
    createElement: () => new FakeMediaElement(),
    createElementNS: () => new FakeMediaElement(),
  };
  (globalThis as Record<string, unknown>).Audio = FakeMediaElement;
  (globalThis as Record<string, unknown>).HTMLVideoElement = class FakeHTMLVideoElement {};
}

function makeMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media_1',
    name: 'Media 1',
    type: 'video',
    url: 'blob:media-1',
    duration: 10,
    width: 640,
    height: 360,
    fps: 30,
    thumbnailUrl: '',
    size: 100,
    createdAt: 0,
    ...overrides,
  };
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip_1',
    trackId: 'track_video_1',
    mediaId: 'media_1',
    name: 'Clip 1',
    type: 'video',
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

const videoTrack: Track = {
  id: 'track_video_1',
  name: 'Video 1',
  type: 'video',
  isMuted: false,
  isLocked: false,
  isVisible: true,
};
const audioTrack: Track = {
  id: 'track_audio_1',
  name: 'Audio 1',
  type: 'audio',
  isMuted: false,
  isLocked: false,
  isVisible: true,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) {
      delete (globalThis as Record<string, unknown>)[key];
    } else {
      (globalThis as Record<string, unknown>)[key] = value;
    }
  }
  masterClock.dispose();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* F1 — E-01: the dual clock failover must be continuous and latched   */
/* ------------------------------------------------------------------ */
describe('F1 · MasterClock dual-clock failover is continuous and latched', () => {
  it('never freezes or jumps when the audio clock freezes mid playback', () => {
    const ctx = new MockAudioContext();
    (globalThis as Record<string, unknown>).AudioContext = vi.fn().mockImplementation(() => ctx);

    let wall = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);

    const clock = new MasterClock();
    clock.setDuration(60);
    clock.play();

    const wallAtStart = wall;
    let maxLag = 0;
    let maxJump = 0;
    let previous = clock.getTime();

    // 12 healthy frames: the audio clock advances in lockstep with the wall clock.
    for (let frame = 0; frame < 12; frame++) {
      wall += 16;
      ctx.currentTime += 0.016;
      const t = clock.getTime();
      maxLag = Math.max(maxLag, (wall - wallAtStart) / 1000 - t);
      maxJump = Math.max(maxJump, t - previous);
      previous = t;
    }

    // The AudioContext freezes (throttled tab, energy saving, interrupted device)
    // while the wall clock keeps running.
    for (let frame = 0; frame < 40; frame++) {
      wall += 16;
      const t = clock.getTime();
      maxLag = Math.max(maxLag, (wall - wallAtStart) / 1000 - t);
      maxJump = Math.max(maxJump, t - previous);
      previous = t;
    }

    // The playhead must track the wall clock: the lag can never exceed the
    // detection window, and the timeline must never jump forward.
    expect(maxLag).toBeLessThanOrEqual(CLOCK_STALL_THRESHOLD * 2);
    expect(maxJump).toBeLessThanOrEqual(CLOCK_STALL_THRESHOLD * 2);
    // ... and it must keep moving (no freeze) after the failover.
    expect(previous).toBeGreaterThan(0.5);
  });

  it('latches the wall clock once the audio clock failed and never flips back', () => {
    const ctx = new MockAudioContext();
    (globalThis as Record<string, unknown>).AudioContext = vi.fn().mockImplementation(() => ctx);

    let wall = 5_000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);

    const clock = new MasterClock();
    clock.setDuration(60);
    clock.play();

    wall += 16;
    ctx.currentTime += 0.016;
    expect(clock.getTime()).toBeGreaterThan(0);
    expect(clock.getClockSource()).toBe('audio');

    // The audio clock freezes -> failover.
    for (let frame = 0; frame < 10; frame++) {
      wall += 16;
      clock.getTime();
    }
    expect(clock.getClockSource()).toBe('perf');

    // The audio clock recovers: the failover stays latched for this run.
    for (let frame = 0; frame < 10; frame++) {
      wall += 16;
      ctx.currentTime += 0.016;
      clock.getTime();
    }
    expect(clock.getClockSource()).toBe('perf');

    // A new playback run re-evaluates the audio clock.
    clock.pause();
    clock.play();
    wall += 16;
    ctx.currentTime += 0.016;
    clock.getTime();
    expect(clock.getClockSource()).toBe('audio');
  });
});

/* ------------------------------------------------------------------ */
/* F2 — E-15: getTime() must be a pure getter                           */
/* ------------------------------------------------------------------ */
describe('F2 · MasterClock.getTime() has no side effects', () => {
  it('does not pause playback when the timeline reaches its end', () => {
    delete (globalThis as Record<string, unknown>).AudioContext;
    delete (globalThis as Record<string, unknown>).webkitAudioContext;

    let wall = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);

    const clock = new MasterClock();
    clock.setDuration(5);
    clock.play();

    wall += 6_000;

    // Reading the time must not mutate the playback state.
    const t = clock.getTime();
    expect(t).toBe(5);
    expect(clock.getIsPlaying()).toBe(true);

    // The playback tick owns the pause at the end of the timeline.
    clock.tick();
    expect(clock.getIsPlaying()).toBe(false);
    expect(clock.getTime()).toBe(5);
  });

  it('keeps returning the same value when called repeatedly from a render', () => {
    delete (globalThis as Record<string, unknown>).AudioContext;
    let wall = 2_000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);

    const clock = new MasterClock();
    clock.setDuration(30);
    clock.play();
    wall += 500;

    const first = clock.getTime();
    const second = clock.getTime();
    expect(second).toBe(first);
  });
});

/* ------------------------------------------------------------------ */
/* F3 — E-02: a timeline seek re-anchors audio and video                */
/* ------------------------------------------------------------------ */
describe('F3 · MediaSourcePool re-anchors media on a timeline seek', () => {
  it('hard seeks the video instead of applying a rate correction when the target jumps', () => {
    const pool = new MediaSourcePool();
    const video = {
      readyState: 4,
      paused: false,
      seeking: false,
      currentTime: 1.0,
      playbackRate: 1,
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    } as unknown as HTMLVideoElement;

    // Steady playback: the target advances continuously.
    pool.syncVideoTime(video, 1.0, true, 1);
    expect(video.currentTime).toBe(1.0);
    expect(video.playbackRate).toBe(1);

    // The user drags the playhead 400ms forward: the target jumps.
    pool.syncVideoTime(video, 1.4, true, 1);

    // The video must jump to the new position (no 5 second 1.06x catch up).
    expect(video.currentTime).toBe(1.4);
    // No rate based correction may be applied while the seek is in flight.
    expect(video.playbackRate).toBe(1);
  });

  it('exposes an explicit resync path for timeline seeks', () => {
    const pool = new MediaSourcePool();
    const media = makeMedia({ duration: 30 });
    const clip = makeClip({ id: 'clip_resync', start: 2, duration: 5, sourceStart: 4 });

    const video = {
      readyState: 4,
      paused: false,
      seeking: false,
      currentTime: 0,
      playbackRate: 1,
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    } as unknown as HTMLVideoElement;
    (pool as any).videoElements.set('media_1_clip_resync', video);

    pool.resyncAll([clip], [media], 3);

    // sourceStart (4s) + 1s elapsed at t=3s -> source time 5s
    expect(video.currentTime).toBe(5);
  });
});

/* ------------------------------------------------------------------ */
/* F4 — E-03 / E-17: no strong maps pinning deleted media elements      */
/* ------------------------------------------------------------------ */
describe('F4 · MediaSourcePool does not pin deleted media elements', () => {
  it('drops the hard seek bookkeeping when a clip is released', () => {
    const pool = new MediaSourcePool();
    const video = new FakeMediaElement();
    video.readyState = 4;
    video.paused = false;
    video.currentTime = 15;

    pool.syncVideoTime(video as unknown as HTMLVideoElement, 1.0, true, 1);
    const hardSeekMap = (pool as any).lastHardSeekTimeMap;
    expect(hardSeekMap.has(video)).toBe(true);

    // The element belongs to a clip of the pool.
    (pool as any).videoElements.set('media_1_clip_1', video);
    pool.releaseClip('clip_1');

    // The entry must not survive the release of the element.
    expect(hardSeekMap.has(video)).toBe(false);
  });

  it('uses a WeakMap for the element keyed hard seek bookkeeping', () => {
    const pool = new MediaSourcePool();
    expect((pool as any).lastHardSeekTimeMap instanceof WeakMap).toBe(true);
  });

  it('clears the stored frame timestamps when a clip is released and when the pool is cleared', () => {
    const pool = new MediaSourcePool();
    const fakeVideo = { readyState: 4, videoWidth: 320, videoHeight: 180 } as unknown as HTMLVideoElement;

    pool.storeVideoFrame('clip_a', fakeVideo, 'media_a', true);
    expect((pool as any).lastStoredFrameTimeMap.size).toBeGreaterThan(0);

    pool.releaseClip('clip_a');
    expect((pool as any).lastStoredFrameTimeMap.has('clip_a')).toBe(false);

    pool.storeVideoFrame('clip_b', fakeVideo, 'media_b', true);
    pool.clear();
    expect((pool as any).lastStoredFrameTimeMap.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* F5 — E-04: the preview honours the same volume range as the export   */
/* ------------------------------------------------------------------ */
describe('F5 · AudioEngine honours clip volumes above 100%', () => {
  it('routes the element through the Web Audio graph for volumes above 100%', () => {
    const ctx = new MockAudioContext();
    (globalThis as Record<string, unknown>).AudioContext = vi.fn().mockImplementation(() => ctx);

    const element = new FakeMediaElement();
    element.muted = false;
    element.paused = false;
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(element as unknown as HTMLAudioElement);

    const engine = new AudioEngine();
    const clip = makeClip({ id: 'clip_loud', type: 'audio', trackId: 'track_audio_1', volume: 2 });

    engine.updateAudio(1, true, [audioTrack], [clip], [makeMedia({ type: 'audio', duration: 30 })]);

    // The element gain is capped at 100%, the rest comes from the graph.
    expect(element.volume).toBeCloseTo(1, 3);
    expect(ctx.createdGains.length).toBe(1);
    expect(ctx.createdGains[0].gain.value).toBeCloseTo(2, 3);
    // The graph is really connected to the destination.
    expect(ctx.createdGains[0].connect).toHaveBeenCalled();
    expect(ctx.createdSources.length).toBe(1);
    expect(ctx.createdSources[0].connect).toHaveBeenCalledWith(ctx.createdGains[0]);
  });

  it('applies the master volume to the graph gain as well', () => {
    const ctx = new MockAudioContext();
    (globalThis as Record<string, unknown>).AudioContext = vi.fn().mockImplementation(() => ctx);

    const element = new FakeMediaElement();
    element.muted = false;
    element.paused = false;
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(element as unknown as HTMLAudioElement);

    const engine = new AudioEngine();
    engine.setMasterVolume(0.8);
    const clip = makeClip({ id: 'clip_loud', type: 'audio', trackId: 'track_audio_1', volume: 2 });

    engine.updateAudio(1, true, [audioTrack], [clip], [makeMedia({ type: 'audio', duration: 30 })]);

    expect(element.volume).toBeCloseTo(1, 3);
    expect(ctx.createdGains[0].gain.value).toBeCloseTo(1.6, 3); // 2.0 * 0.8 master volume
  });

  it('does not create a graph for volumes at or below 100%', () => {
    const ctx = new MockAudioContext();
    (globalThis as Record<string, unknown>).AudioContext = vi.fn().mockImplementation(() => ctx);

    const element = new FakeMediaElement();
    element.muted = false;
    element.paused = false;
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(element as unknown as HTMLAudioElement);

    const engine = new AudioEngine();
    const clip = makeClip({ id: 'clip_normal', type: 'audio', trackId: 'track_audio_1', volume: 0.8 });

    engine.updateAudio(1, true, [audioTrack], [clip], [makeMedia({ type: 'audio', duration: 30 })]);

    expect(element.volume).toBeCloseTo(0.8, 3);
    expect(ctx.createdGains.length).toBe(0);
    expect(ctx.createdSources.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* F6 — E-05: the Web Audio graph must not be dead code                 */
/* ------------------------------------------------------------------ */
describe('F6 · AudioEngine Web Audio graph is live', () => {
  it('creates the routing once per element and keeps it across stopAll()', () => {
    const ctx = new MockAudioContext();
    (globalThis as Record<string, unknown>).AudioContext = vi.fn().mockImplementation(() => ctx);

    const element = new FakeMediaElement();
    element.muted = false;
    element.paused = false;
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(element as unknown as HTMLAudioElement);

    const engine = new AudioEngine();
    const clip = makeClip({ id: 'clip_loud', type: 'audio', trackId: 'track_audio_1', volume: 2 });
    const media = [makeMedia({ type: 'audio', duration: 30 })];

    for (let frame = 0; frame < 30; frame++) {
      engine.updateAudio(1 + frame * 0.016, true, [audioTrack], [clip], media);
    }

    // One source node and one gain node, no matter how many frames are rendered.
    expect(ctx.createdSources.length).toBe(1);
    expect(ctx.createdGains.length).toBe(1);

    engine.stopAll();
    // Tearing the routing down would silence the element forever.
    expect(ctx.createdGains[0].disconnect).not.toHaveBeenCalled();
  });

  it('never leaves a dangling master/track gain graph behind', () => {
    const ctx = new MockAudioContext();
    (globalThis as Record<string, unknown>).AudioContext = vi.fn().mockImplementation(() => ctx);

    const element = new FakeMediaElement();
    element.muted = false;
    element.paused = false;
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(element as unknown as HTMLAudioElement);

    const engine = new AudioEngine();
    const clip = makeClip({ id: 'clip_loud', type: 'audio', trackId: 'track_audio_1', volume: 2 });
    engine.updateAudio(1, true, [audioTrack], [clip], [makeMedia({ type: 'audio', duration: 30 })]);

    // The graph is only made of the per element nodes that carry real signal.
    const engineInternals = engine as any;
    expect(engineInternals.masterGain).toBeUndefined();
    expect(engineInternals.trackGains).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* F7 — C1: MediaSourcePool.clear() must really release everything     */
/* ------------------------------------------------------------------ */
describe('F7 · MediaSourcePool.clear() releases every resource', () => {
  it('stops the elements, drops the canvases and empties the bookkeeping maps', () => {
    installFakeDOM();
    const pool = new MediaSourcePool();
    const media = makeMedia();

    const video = pool.getVideoElement(media, 'clip_1') as unknown as FakeMediaElement;
    const audio = pool.getAudioElement(media, 'clip_1') as unknown as FakeMediaElement;
    video.paused = false;
    audio.paused = false;
    video.readyState = 4;
    video.videoWidth = 640;
    video.videoHeight = 360;

    pool.storeVideoFrame('clip_1', video as unknown as HTMLVideoElement, media.id, true);
    expect(pool.getLastFrame('clip_1')).not.toBeNull();

    pool.clear();

    expect(video.pauseCalls).toBeGreaterThan(0);
    expect(audio.pauseCalls).toBeGreaterThan(0);
    expect(video.removedAttributes).toContain('src');
    expect(audio.removedAttributes).toContain('src');
    expect(pool.getLastFrame('clip_1')).toBeNull();
    const internals = pool as any;
    expect(internals.videoElements.size).toBe(0);
    expect(internals.audioElements.size).toBe(0);
    expect(internals.imageElements.size).toBe(0);
    expect(internals.lastStoredFrameTimeMap.size).toBe(0);
    expect(internals.mediaFrameSourceTimeMap.size).toBe(0);
  });

  it('the compositor can drop its cached frame on a project switch', () => {
    const compositor = new Compositor();
    (compositor as any).lastCompositedCanvas = { width: 640, height: 360 };
    compositor.clear();
    expect((compositor as any).lastCompositedCanvas).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* F8 — E-07: a clip on an incompatible track renders black, not stale  */
/* ------------------------------------------------------------------ */
describe('F8 · Compositor ignores clips whose type does not match the track', () => {
  it('renders black instead of the last cached frame', async () => {
    const compositor = new Compositor();
    const fillRectMock = vi.fn();
    const drawImageMock = vi.fn();
    const fakeCanvas = {
      width: 640,
      height: 360,
      getContext: () => ({
        fillStyle: '',
        globalAlpha: 1,
        fillRect: fillRectMock,
        drawImage: drawImageMock,
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
      }),
    } as unknown as HTMLCanvasElement;

    const staleFrame = { width: 640, height: 360 } as unknown as HTMLCanvasElement;
    (compositor as any).lastCompositedCanvas = staleFrame;

    vi.spyOn(mediaSourcePool, 'getVideoElement').mockReturnValue({
      readyState: 4,
      currentTime: 0,
      paused: false,
    } as unknown as HTMLVideoElement);
    vi.spyOn(mediaSourcePool, 'getLastFrame').mockReturnValue(null);
    vi.spyOn(mediaSourcePool, 'getLastFrameForSource').mockReturnValue(null);

    const tracks: Track[] = [audioTrack];
    const clips: Clip[] = [
      makeClip({ id: 'clip_mismatch', trackId: 'track_audio_1', type: 'video', start: 0, duration: 5 }),
    ];

    compositor.renderFrame({
      time: 1,
      canvas: fakeCanvas,
      tracks,
      clips,
      mediaPool: [makeMedia()],
      isPlaying: false,
    });

    // The stale frame must never be painted for an incompatible clip.
    expect(drawImageMock).not.toHaveBeenCalledWith(staleFrame, 0, 0, 640, 360);
    // ... the canvas is cleared to black instead.
    expect(fillRectMock).toHaveBeenCalled();
  });

  it('still renders a matching clip on a video track', async () => {
    const compositor = new Compositor();
    const fillRectMock = vi.fn();
    const fakeCanvas = {
      width: 640,
      height: 360,
      getContext: () => ({
        fillStyle: '',
        globalAlpha: 1,
        fillRect: fillRectMock,
        drawImage: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
      }),
    } as unknown as HTMLCanvasElement;

    const drawn: string[] = [];
    (compositor as any).drawMediaToCanvas = vi.fn((_ctx: unknown, _el: unknown, clip: Clip) => {
      drawn.push(clip.id);
      return true;
    });

    vi.spyOn(mediaSourcePool, 'getVideoElement').mockReturnValue({
      readyState: 4,
      currentTime: 0,
      paused: false,
      seeking: false,
      playbackRate: 1,
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    } as unknown as HTMLVideoElement);

    compositor.renderFrame({
      time: 1,
      canvas: fakeCanvas,
      tracks: [videoTrack],
      clips: [makeClip({ id: 'clip_ok' })],
      mediaPool: [makeMedia()],
      isPlaying: false,
    });

    expect(drawn).toEqual(['clip_ok']);
  });
});

/* ------------------------------------------------------------------ */
/* F9 — E-06: fade-black and fade-white must be symmetric               */
/* ------------------------------------------------------------------ */
describe('F9 · Compositor fade transitions are symmetric', () => {
  it('applies the same curve to fade-black and fade-white', () => {
    const clip = makeClip({
      id: 'clip_fade',
      type: 'image',
      start: 0,
      duration: 4,
      transition: {
        fadeInType: 'fade-black',
        fadeInDuration: 1,
        fadeOutType: 'none',
        fadeOutDuration: 0,
      },
    });

    const black = calculateTransition(clip, 0.5, 1920);
    const white = calculateTransition(
      {
        ...clip,
        transition: { ...clip.transition!, fadeInType: 'fade-white' },
      },
      0.5,
      1920
    );

    // Symmetric: same alpha, same overlay opacity, only the colour differs.
    expect(black.alphaMultiplier).toBe(white.alphaMultiplier);
    expect(black.alphaMultiplier).toBe(1);
    expect(black.overlayOpacity).toBeCloseTo(white.overlayOpacity, 6);
    expect(black.overlayOpacity).toBeCloseTo(0.5, 6);
    expect(black.overlayColor).toBe('#000000');
    expect(white.overlayColor).toBe('#ffffff');
  });

  it('applies the same curve to the fade out direction', () => {
    const clip = makeClip({
      id: 'clip_fade_out',
      type: 'image',
      start: 0,
      duration: 4,
      transition: {
        fadeInType: 'none',
        fadeInDuration: 0,
        fadeOutType: 'fade-black',
        fadeOutDuration: 1,
      },
    });

    const black = calculateTransition(clip, 3.5, 1920);
    const white = calculateTransition(
      { ...clip, transition: { ...clip.transition!, fadeOutType: 'fade-white' } },
      3.5,
      1920
    );

    expect(black.alphaMultiplier).toBe(white.alphaMultiplier);
    expect(black.alphaMultiplier).toBe(1);
    expect(black.overlayOpacity).toBeCloseTo(white.overlayOpacity, 6);
    expect(black.overlayOpacity).toBeCloseTo(0.5, 6);
  });
});

/* ------------------------------------------------------------------ */
/* F10 — E-10: sourceStart must be honoured on the audio path           */
/* ------------------------------------------------------------------ */
describe('F10 · MediaSourcePool honours sourceStart for audio elements', () => {
  it('positions the audio element at the clip source start', () => {
    installFakeDOM();
    const pool = new MediaSourcePool();
    const media = makeMedia({ type: 'audio', duration: 30 });

    const element = pool.getAudioElement(media, 'clip_offset', 5) as unknown as FakeMediaElement;
    expect(element.currentTime).toBe(5);
  });

  it('passes the clip sourceStart to the pool from the AudioEngine', () => {
    installFakeDOM();
    const spy = vi.spyOn(mediaSourcePool, 'getAudioElement');
    const engine = new AudioEngine();
    const clip = makeClip({
      id: 'clip_offset',
      type: 'audio',
      trackId: 'track_audio_1',
      sourceStart: 7,
      start: 0,
      duration: 4,
    });

    engine.updateAudio(1, true, [audioTrack], [clip], [makeMedia({ type: 'audio', duration: 30 })]);

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][2]).toBe(7);
  });
});

/* ------------------------------------------------------------------ */
/* F11 — E-11: play()/resume() failures must not be retried every frame  */
/* ------------------------------------------------------------------ */
describe('F11 · AudioEngine backs off failing play()/resume() calls', () => {
  it('does not issue a play() call per frame when the element cannot play', () => {
    installFakeDOM();
    const ctx = new MockAudioContext();
    (globalThis as Record<string, unknown>).AudioContext = vi.fn().mockImplementation(() => ctx);

    const element = new FakeMediaElement();
    element.playShouldFail = true;
    element.paused = true;
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(element as unknown as HTMLAudioElement);

    const engine = new AudioEngine();
    const clip = makeClip({ id: 'clip_broken', type: 'audio', trackId: 'track_audio_1' });
    const media = [makeMedia({ type: 'audio', duration: 30 })];

    for (let frame = 0; frame < 60; frame++) {
      engine.updateAudio(frame * 0.016, true, [audioTrack], [clip], media);
    }

    // 60 frames must not produce 60 rejected promises.
    expect(element.playCalls).toBeLessThanOrEqual(2);
  });

  it('does not resume a suspended AudioContext on every frame', () => {
    installFakeDOM();
    const ctx = new MockAudioContext();
    ctx.state = 'suspended';
    (globalThis as Record<string, unknown>).AudioContext = vi.fn().mockImplementation(() => ctx);

    const element = new FakeMediaElement();
    element.muted = false;
    element.paused = false;
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(element as unknown as HTMLAudioElement);

    const engine = new AudioEngine();
    const clip = makeClip({ id: 'clip_suspended', type: 'audio', trackId: 'track_audio_1' });
    const media = [makeMedia({ type: 'audio', duration: 30 })];

    for (let frame = 0; frame < 60; frame++) {
      engine.updateAudio(frame * 0.016, true, [audioTrack], [clip], media);
    }

    expect(ctx.resume.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ */
/* F12 — E-12: broken media must be surfaced                             */
/* ------------------------------------------------------------------ */
describe('F12 · MediaSourcePool surfaces media errors', () => {
  it('records the failure and notifies the listeners', () => {
    installFakeDOM();
    const pool = new MediaSourcePool();
    const media = makeMedia();

    const errors: Array<{ mediaId: string; message: string }> = [];
    pool.onMediaError((info) => errors.push({ mediaId: info.mediaId, message: info.message }));

    const element = pool.getVideoElement(media, 'clip_broken') as unknown as FakeMediaElement;
    element.dispatch('error');

    expect(pool.hasMediaError(media.id)).toBe(true);
    expect(pool.getMediaError(media.id)).toBeTruthy();
    expect(errors.length).toBe(1);
    expect(errors[0].mediaId).toBe(media.id);
  });

  it('reports audio failures as well', () => {
    installFakeDOM();
    const pool = new MediaSourcePool();
    const media = makeMedia({ type: 'audio' });
    const element = pool.getAudioElement(media, 'clip_broken_audio') as unknown as FakeMediaElement;
    element.dispatch('error');
    expect(pool.hasMediaError(media.id)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* F13 — E-19: the slow motion floor must not break clips below 0.25x   */
/* ------------------------------------------------------------------ */
describe('F13 · MediaSourcePool honours slow motion speeds', () => {
  it('corrects a slow motion clip proportionally to its speed', () => {
    const pool = new MediaSourcePool();
    const video = {
      readyState: 4,
      paused: false,
      seeking: false,
      currentTime: 1.7,
      playbackRate: 0.1,
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    } as unknown as HTMLVideoElement;

    // Drift of +700ms on a 0.1x clip: the correction must stay proportional.
    pool.syncVideoTime(video, 1.0, true, 0.1);

    expect(video.playbackRate).toBeCloseTo(0.1 * 0.8, 4);
    // The old absolute floor of 0.25 would run the clip 2.5x too fast.
    expect(video.playbackRate).not.toBeCloseTo(0.25, 3);
    expect(video.playbackRate).toBeGreaterThan(MIN_PLAYBACK_RATE);
  });

  it('keeps the relative floor for fast clips', () => {
    const pool = new MediaSourcePool();
    const video = {
      readyState: 4,
      paused: false,
      seeking: false,
      currentTime: 1.25,
      playbackRate: 1,
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
    } as unknown as HTMLVideoElement;

    pool.syncVideoTime(video, 1.0, true, 1);
    expect(video.playbackRate).toBeCloseTo(0.94, 3);
  });
});

/* ------------------------------------------------------------------ */
/* F14 — E-21: a closed AudioContext must be recreated                   */
/* ------------------------------------------------------------------ */
describe('F14 · MasterClock recovers from a closed AudioContext', () => {
  it('replaces a closed context with a fresh one', () => {
    let created = 0;
    class ClosingContext extends MockAudioContext {
      constructor() {
        super();
        created++;
      }
    }
    (globalThis as Record<string, unknown>).AudioContext = vi.fn().mockImplementation(() => new ClosingContext());

    const clock = new MasterClock();
    const first = clock.getAudioContext();
    expect(first).not.toBeNull();
    expect(created).toBe(1);

    // The browser (or another subsystem) closed the context.
    (first as unknown as { state: AudioContextState }).state = 'closed';

    const second = clock.getAudioContext();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(created).toBe(2);
  });

  it('keeps the timeline running on the wall clock while the context is unusable', () => {
    const ctx = new MockAudioContext();
    (globalThis as Record<string, unknown>).AudioContext = vi.fn().mockImplementation(() => ctx);

    let wall = 3_000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);

    const clock = new MasterClock();
    clock.setDuration(30);
    clock.play();
    wall += 200;
    expect(clock.getTime()).toBeCloseTo(0.2, 2);

    ctx.state = 'closed';
    wall += 200;
    // The clock keeps running even when the audio context is dead.
    expect(clock.getTime()).toBeCloseTo(0.4, 2);
  });
});

/* ------------------------------------------------------------------ */
/* F15 — E-09 / E-13 / E-14 / E-16 / E-20: smaller engine corrections   */
/* ------------------------------------------------------------------ */
describe('F15 · Smaller engine corrections', () => {
  it('E-09: clamps the audio source offset to the media duration', () => {
    installFakeDOM();
    const element = new FakeMediaElement();
    element.muted = false;
    element.paused = false;
    vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(element as unknown as HTMLAudioElement);

    const engine = new AudioEngine();
    // The clip is longer than the media: the source offset is past the end.
    const clip = makeClip({
      id: 'clip_long',
      type: 'audio',
      trackId: 'track_audio_1',
      start: 0,
      duration: 20,
    });
    const media = [makeMedia({ type: 'audio', duration: 5 })];

    engine.updateAudio(8, true, [audioTrack], [clip], media);

    // The element must never be seeked past the end of the media (that caused a
    // seek on every single frame).
    expect(element.currentTime).not.toBe(8);
    expect(element.paused).toBe(true);
  });

  it('E-13: the media level frame cache is keyed by source time', () => {
    const pool = new MediaSourcePool();
    const fakeVideo = { readyState: 4, videoWidth: 320, videoHeight: 180 } as unknown as HTMLVideoElement;

    pool.storeVideoFrame('clip_a', fakeVideo, 'media_shared', true, 10);

    // The frame of source time 10s can be used for 10s...
    expect(pool.getLastFrameForSource('media_shared', 10)).not.toBeNull();
    // ... but not for a completely different point of the same source.
    expect(pool.getLastFrameForSource('media_shared', 40)).toBeNull();
  });

  it('E-14: an image that is not decoded yet is not reported as drawn', () => {
    installFakeDOM();
    const compositor = new Compositor();
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      drawImage: vi.fn(),
      globalAlpha: 1,
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D;

    const notLoadedImage = { complete: false, naturalWidth: 0 } as unknown as HTMLImageElement;

    const drawn = (compositor as any).drawMediaToCanvas(
      ctx,
      notLoadedImage,
      makeClip({ id: 'clip_img', type: 'image' }),
      640,
      360,
      640,
      360,
      0,
      makeMedia({ type: 'image' }),
      false
    );

    expect(drawn).toBe(false);
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it('E-16: does not create media elements for clips that are far in the future', () => {
    installFakeDOM();
    const videoSpy = vi.spyOn(mediaSourcePool, 'getVideoElement');
    const audioSpy = vi.spyOn(mediaSourcePool, 'getAudioElement');

    const engine = new AudioEngine();
    const clips: Clip[] = [];
    const media: MediaItem[] = [];
    for (let i = 0; i < 20; i++) {
      media.push(makeMedia({ id: `media_${i}` }));
      clips.push(
        makeClip({
          id: `clip_${i}`,
          mediaId: `media_${i}`,
          type: 'video',
          start: 100 + i * 10,
          duration: 5,
        })
      );
    }

    engine.updateAudio(0, true, [videoTrack], clips, media);

    // No element (and no media load) for clips that start a hundred seconds later.
    expect(videoSpy).not.toHaveBeenCalled();
    expect(audioSpy).not.toHaveBeenCalled();
  });

  it('E-20: pre-warms the audio of the upcoming clip', () => {
    installFakeDOM();
    const audioSpy = vi.spyOn(mediaSourcePool, 'getAudioElement');
    const engine = new AudioEngine();

    const clip = makeClip({
      id: 'clip_next',
      type: 'audio',
      trackId: 'track_audio_1',
      start: 2,
      duration: 4,
      sourceStart: 3,
    });

    // Two seconds before the clip starts the element already exists and it is
    // positioned at the clip source start, so there is no gap at the cut.
    engine.updateAudio(0, true, [audioTrack], [clip], [makeMedia({ type: 'audio', duration: 30 })]);

    expect(audioSpy).toHaveBeenCalled();
    const element = audioSpy.mock.results[0].value as unknown as FakeMediaElement;
    expect(element.currentTime).toBe(3);
  });
});
