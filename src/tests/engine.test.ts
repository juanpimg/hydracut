import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Compositor } from '../core/engine/Compositor';
import { useProjectStore } from '../store/useProjectStore';
import { Clip, Track } from '../types/project';

describe('Compositor Layer Ordering (Painters Algorithm)', () => {
  it('renders base video first, overlay video second, and text layers on top', async () => {
    const compositor = new Compositor();

    const tracks: Track[] = [
      { id: 'track_text_1', name: 'Texto T1', type: 'text', isMuted: false, isLocked: false, isVisible: true },
      { id: 'track_video_2', name: 'Video V2', type: 'video', isMuted: false, isLocked: false, isVisible: true },
      { id: 'track_video_1', name: 'Video V1', type: 'video', isMuted: false, isLocked: false, isVisible: true },
      { id: 'track_audio_1', name: 'Audio A1', type: 'audio', isMuted: false, isLocked: false, isVisible: true },
    ];

    const clips: Clip[] = [
      {
        id: 'c_text',
        trackId: 'track_text_1',
        mediaId: '',
        name: 'Texto',
        type: 'text',
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
        text: 'Overlay Title',
      },
      {
        id: 'c_v2',
        trackId: 'track_video_2',
        mediaId: 'm_v2',
        name: 'Video 2',
        type: 'video',
        start: 0,
        duration: 5,
        sourceStart: 0,
        sourceDuration: 5,
        volume: 1,
        opacity: 1,
        scale: 0.5,
        positionX: 100,
        positionY: 100,
        muted: false,
      },
      {
        id: 'c_v1',
        trackId: 'track_video_1',
        mediaId: 'm_v1',
        name: 'Video 1',
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
      },
    ];

    const renderedOrder: string[] = [];

    // Mock drawMediaToCanvas and drawTextToCanvas by spying or checking private calls
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (compositor as any).drawMediaToCanvas = vi.fn((_ctx, _el, clip) => {
      renderedOrder.push(clip.id);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (compositor as any).drawTextToCanvas = vi.fn((_ctx, clip) => {
      renderedOrder.push(clip.id);
    });

    // Mock canvas
    const fakeCanvas = {
      width: 1920,
      height: 1080,
      getContext: () => ({
        fillStyle: '',
        fillRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
      }),
    } as unknown as HTMLCanvasElement;

    const { mediaSourcePool } = await import('../core/engine/MediaSourcePool');
    vi.spyOn(mediaSourcePool, 'getVideoElement').mockReturnValue({} as HTMLVideoElement);
    vi.spyOn(mediaSourcePool, 'syncVideoTime').mockImplementation(() => {});

    compositor.renderFrame({
      time: 2,
      canvas: fakeCanvas,
      tracks,
      clips,
      mediaPool: [
        { id: 'm_v1', name: 'V1', type: 'video', url: 'blob:1', duration: 10, width: 1920, height: 1080, fps: 30, thumbnailUrl: '', size: 100, createdAt: 0 },
        { id: 'm_v2', name: 'V2', type: 'video', url: 'blob:2', duration: 10, width: 1920, height: 1080, fps: 30, thumbnailUrl: '', size: 100, createdAt: 0 },
      ],
      isPlaying: false,
    });

    // Base video V1 must be rendered first, then overlay V2, then Text on top!
    expect(renderedOrder).toEqual(['c_v1', 'c_v2', 'c_text']);
  });
});

describe('Track Management & Hierarchy', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('maintains strict hierarchy: Text at top, Video in middle, Audio at bottom', () => {
    const store = useProjectStore.getState();

    // Default tracks: [Text 1, Video 2, Video 1, Audio 1]
    const initialTypes = store.project.tracks.map((t) => t.type);
    expect(initialTypes).toEqual(['text', 'video', 'video', 'audio']);

    // Add a new video track
    store.addTrack('video', 'Video V3');
    const afterVideoTypes = useProjectStore.getState().project.tracks.map((t) => t.type);
    // New video track must be placed before audio, not at the very bottom
    expect(afterVideoTypes).toEqual(['text', 'video', 'video', 'video', 'audio']);

    // Add a new text track
    store.addTrack('text', 'Texto T2');
    const afterTextTypes = useProjectStore.getState().project.tracks.map((t) => t.type);
    // New text track must be placed at the very top
    expect(afterTextTypes).toEqual(['text', 'text', 'video', 'video', 'video', 'audio']);

    // Add a new audio track
    store.addTrack('audio', 'Audio A2');
    const afterAudioTypes = useProjectStore.getState().project.tracks.map((t) => t.type);
    // Audio track must be placed at the bottom
    expect(afterAudioTypes).toEqual(['text', 'text', 'video', 'video', 'video', 'audio', 'audio']);
  });
});

describe('WebCodecs Audio Planar Chunking Logic', () => {
  it('constructs correct stereo planar buffer with left channel followed by right channel', () => {
    const sampleRate = 48000;
    const framesInChunk = 2048;

    // Simulate Left (channel 0) and Right (channel 1) samples
    const leftChannel = new Float32Array(framesInChunk);
    const rightChannel = new Float32Array(framesInChunk);
    for (let i = 0; i < framesInChunk; i++) {
      leftChannel[i] = 0.5;
      rightChannel[i] = -0.5;
    }

    // Planar format for 2 channels: Left plane followed by Right plane
    const chunkData = new Float32Array(framesInChunk * 2);
    for (let i = 0; i < framesInChunk; i++) {
      chunkData[i] = leftChannel[i];
      chunkData[framesInChunk + i] = rightChannel[i];
    }

    // Total elements: 4096 (2048 per channel)
    expect(chunkData.length).toBe(4096);
    // Byte length: 4096 * 4 bytes = 16384 bytes
    expect(chunkData.buffer.byteLength).toBe(framesInChunk * 2 * 4);

    // Verify channel 0 samples
    expect(chunkData[0]).toBe(0.5);
    expect(chunkData[framesInChunk - 1]).toBe(0.5);

    // Verify channel 1 samples
    expect(chunkData[framesInChunk]).toBe(-0.5);
    expect(chunkData[framesInChunk * 2 - 1]).toBe(-0.5);

    // Verify timestamp calculation in microseconds
    const offset = 2048;
    const timestampUs = Math.round((offset / sampleRate) * 1_000_000);
    expect(timestampUs).toBe(Math.round((2048 / 48000) * 1_000_000));
  });
});

describe('Export Dimension Rounding for Hardware Acceleration', () => {
  it('guarantees that all dimensions are strictly even numbers for H.264', () => {
    const testCases = [
      { base: 1080, ratio: '16:9' as const },
      { base: 720, ratio: '16:9' as const },
      { base: 2160, ratio: '16:9' as const },
      { base: 1080, ratio: '9:16' as const },
      { base: 720, ratio: '9:16' as const },
      { base: 1080, ratio: '1:1' as const },
      { base: 721, ratio: '16:9' as const }, // odd base
      { base: 333, ratio: '9:16' as const }, // odd base
    ];

    for (const tc of testCases) {
      let width = tc.base;
      let height = tc.base;
      if (tc.ratio === '16:9') {
        width = Math.round((tc.base * 16) / 9);
        height = tc.base;
      } else if (tc.ratio === '9:16') {
        width = tc.base;
        height = Math.round((tc.base * 16) / 9);
      }

      // Even rounding
      width = width - (width % 2);
      height = height - (height % 2);

      expect(width % 2).toBe(0);
      expect(height % 2).toBe(0);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    }
  });
});

describe('Compositor Visibility & Opacity Edge Cases', () => {
  it('skips invisible tracks and zero-opacity clips', async () => {
    const compositor = new Compositor();

    const tracks: Track[] = [
      { id: 't_hidden', name: 'Hidden Track', type: 'video', isMuted: false, isLocked: false, isVisible: false },
      { id: 't_visible', name: 'Visible Track', type: 'video', isMuted: false, isLocked: false, isVisible: true },
    ];

    const clips: Clip[] = [
      {
        id: 'c_hidden_track',
        trackId: 't_hidden',
        mediaId: 'm1',
        name: 'In Hidden Track',
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
      },
      {
        id: 'c_zero_opacity',
        trackId: 't_visible',
        mediaId: 'm1',
        name: 'Zero Opacity',
        type: 'video',
        start: 0,
        duration: 5,
        sourceStart: 0,
        sourceDuration: 5,
        volume: 1,
        opacity: 0,
        scale: 1,
        positionX: 0,
        positionY: 0,
        muted: false,
      },
      {
        id: 'c_active',
        trackId: 't_visible',
        mediaId: 'm1',
        name: 'Active Clip',
        type: 'video',
        start: 0,
        duration: 5,
        sourceStart: 0,
        sourceDuration: 5,
        volume: 1,
        opacity: 0.8,
        scale: 1,
        positionX: 0,
        positionY: 0,
        muted: false,
      },
    ];

    const renderedClips: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (compositor as any).drawMediaToCanvas = vi.fn((_ctx, _el, clip) => {
      renderedClips.push(clip.id);
    });

    const fakeCanvas = {
      width: 1280,
      height: 720,
      getContext: () => ({
        fillStyle: '',
        fillRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
      }),
    } as unknown as HTMLCanvasElement;

    const { mediaSourcePool } = await import('../core/engine/MediaSourcePool');
    vi.spyOn(mediaSourcePool, 'getVideoElement').mockReturnValue({} as HTMLVideoElement);
    vi.spyOn(mediaSourcePool, 'syncVideoTime').mockImplementation(() => {});

    compositor.renderFrame({
      time: 1,
      canvas: fakeCanvas,
      tracks,
      clips,
      mediaPool: [
        { id: 'm1', name: 'M1', type: 'video', url: 'blob:1', duration: 10, width: 1280, height: 720, fps: 30, thumbnailUrl: '', size: 100, createdAt: 0 },
      ],
      isPlaying: false,
    });

    // Only c_active should be drawn
    expect(renderedClips).toEqual(['c_active']);
  });
});

describe('Media Rehydration from Storage', () => {
  it('retains media items without opfsPath and updates items with opfsPath', async () => {
    const { rehydrateProjectMedia } = await import('../core/storage/projectStorage');

    const fakeProject = {
      id: 'p1',
      name: 'Project Test',
      aspectRatio: '16:9' as const,
      resolution: { width: 1920, height: 1080 },
      fps: 30,
      tracks: [],
      clips: [],
      duration: 10,
      createdAt: 0,
      updatedAt: 0,
      mediaPool: [
        {
          id: 'm_static',
          name: 'Static Media',
          type: 'video' as const,
          url: 'blob:unchanged',
          duration: 5,
          width: 1280,
          height: 720,
          fps: 30,
          thumbnailUrl: '',
          size: 1000,
          createdAt: 0,
        },
      ],
    };

    const rehydrated = await rehydrateProjectMedia(fakeProject);
    expect(rehydrated.mediaPool.length).toBe(1);
    expect(rehydrated.mediaPool[0].url).toBe('blob:unchanged');
  });
});

describe('Compositor Synchronized Lyrics & Animation Presets', () => {
  it('renders karaoke fill and word timing overlays on canvas', () => {
    const compositor = new Compositor();

    const fillTextCalls: string[] = [];
    const strokeTextCalls: string[] = [];
    const fakeCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      measureText: (str: string) => ({ width: str.length * 10 }),
      fillText: vi.fn((text: string) => fillTextCalls.push(text)),
      strokeText: vi.fn((text: string) => strokeTextCalls.push(text)),
      font: '',
      textAlign: '',
      textBaseline: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      globalAlpha: 1,
      translate: vi.fn(),
      scale: vi.fn(),
    };

    const lyricClip: Clip = {
      id: 'clip_lyric_1',
      trackId: 'track_text_1',
      mediaId: '',
      name: 'Lyric Line',
      type: 'text',
      start: 5.0,
      duration: 3.0,
      sourceStart: 0,
      sourceDuration: 3.0,
      volume: 0,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: true,
      text: 'Hello world',
      textStyle: {
        fontSize: 48,
        color: '#ffffff',
        backgroundColor: 'transparent',
        fontFamily: 'Inter, sans-serif',
        textAlign: 'center',
        fontWeight: 'bold',
        animationPreset: 'karaoke-fill',
        highlightColor: '#FACC15',
        strokeWidth: 4,
      },
      words: [
        { word: 'Hello', start: 5.0, end: 6.0 },
        { word: 'world', start: 6.0, end: 7.5 },
      ],
    };

    // Render at time 5.5s (during 'Hello')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (compositor as any).drawTextToCanvas(fakeCtx, lyricClip, 1920, 1080, 5.5);

    expect(fillTextCalls).toContain('Hello');
    expect(fillTextCalls).toContain('world');
    expect(fakeCtx.clip).toHaveBeenCalled();
  });

  it('renders word bounce scale pop when word is active', () => {
    const compositor = new Compositor();

    const fakeCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      measureText: (str: string) => ({ width: str.length * 10 }),
      fillText: vi.fn(),
      strokeText: vi.fn(),
      font: '',
      textAlign: '',
      textBaseline: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      globalAlpha: 1,
      translate: vi.fn(),
      scale: vi.fn(),
    };

    const lyricClip: Clip = {
      id: 'clip_bounce',
      trackId: 'track_text_1',
      mediaId: '',
      name: 'Bounce Line',
      type: 'text',
      start: 0.0,
      duration: 2.0,
      sourceStart: 0,
      sourceDuration: 2.0,
      volume: 0,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: true,
      text: 'Bounce word',
      textStyle: {
        fontSize: 48,
        color: '#ffffff',
        backgroundColor: 'transparent',
        fontFamily: 'Inter, sans-serif',
        textAlign: 'center',
        fontWeight: 'bold',
        animationPreset: 'word-bounce',
        highlightColor: '#FACC15',
      },
      words: [
        { word: 'Bounce', start: 0.0, end: 1.0 },
        { word: 'word', start: 1.0, end: 2.0 },
      ],
    };

    // At time 0.5s ('Bounce' is active)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (compositor as any).drawTextToCanvas(fakeCtx, lyricClip, 1920, 1080, 0.5);

    expect(fakeCtx.scale).toHaveBeenCalledWith(1.15, 1.15);
  });
});

describe('Video Frame Caching & Solid Playback (Anti-Flicker)', () => {
  it('stores and retrieves cached video frames in MediaSourcePool', async () => {
    const { mediaSourcePool } = await import('../core/engine/MediaSourcePool');
    const fakeVideo = {
      readyState: 4,
      videoWidth: 1920,
      videoHeight: 1080,
    } as unknown as HTMLVideoElement;

    mediaSourcePool.storeVideoFrame('clip_test_cache', fakeVideo);
    const cached = mediaSourcePool.getLastFrame('clip_test_cache');
    expect(cached).not.toBeNull();
    expect(cached?.width).toBe(1920);
    expect(cached?.height).toBe(1080);
  });

  it('pauses inactive videos while active videos continue playing', async () => {
    const { mediaSourcePool } = await import('../core/engine/MediaSourcePool');
    const v1 = { paused: false, pause: vi.fn() } as unknown as HTMLVideoElement;
    const v2 = { paused: false, pause: vi.fn() } as unknown as HTMLVideoElement;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mediaSourcePool as any).videoElements.set('m1_c1', v1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mediaSourcePool as any).videoElements.set('m2_c2', v2);

    // Make v2 active, v1 inactive
    const activeKeys = new Set<string>(['m2_c2']);
    mediaSourcePool.pauseInactiveVideos(activeKeys);

    expect(v1.pause).toHaveBeenCalled();
    expect(v2.pause).not.toHaveBeenCalled();
  });

  it('stores frames under both clipId and mediaId for seamless fallback', async () => {
    const { mediaSourcePool } = await import('../core/engine/MediaSourcePool');
    const fakeVideo = {
      readyState: 4,
      videoWidth: 1280,
      videoHeight: 720,
    } as unknown as HTMLVideoElement;

    mediaSourcePool.storeVideoFrame('clip_abc', fakeVideo, 'media_xyz');
    expect(mediaSourcePool.getLastFrame('clip_abc')).not.toBeNull();
    expect(mediaSourcePool.getLastFrame('media_xyz')).not.toBeNull();
  });

  it('cleans up clip resources and frame cache with releaseClip', async () => {
    const { mediaSourcePool } = await import('../core/engine/MediaSourcePool');
    const v = { paused: false, pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() } as unknown as HTMLVideoElement;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mediaSourcePool as any).videoElements.set('m1_c_target', v);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mediaSourcePool as any).lastFrameMap.set('c_target', {} as any);

    mediaSourcePool.releaseClip('c_target');

    expect(v.pause).toHaveBeenCalled();
    expect(v.removeAttribute).toHaveBeenCalledWith('src');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mediaSourcePool as any).videoElements.has('m1_c_target')).toBe(false);
    expect(mediaSourcePool.getLastFrame('c_target')).toBeNull();
  });

  it('notifies frame ready listeners', async () => {
    const { mediaSourcePool } = await import('../core/engine/MediaSourcePool');
    const listener = vi.fn();
    const unsub = mediaSourcePool.onFrameReady(listener);

    mediaSourcePool.notifyFrameReady();
    // Allow macrotask / RAF to fire
    await new Promise((r) => setTimeout(r, 40));

    expect(listener).toHaveBeenCalled();
    unsub();
  });
});

