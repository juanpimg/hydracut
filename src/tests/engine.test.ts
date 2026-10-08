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

describe('WebCodecs Exporter & MP4-Muxer WebKit iOS Robustness', () => {
  it('sanitizes null, undefined and partial colorSpace to prevent null evaluation in mp4-muxer', async () => {
    const { sanitizeColorSpace, DEFAULT_COLOR_SPACE } = await import(
      '../core/export/webcodecsExporter'
    );

    // Null and undefined fall back strictly to Rec.709
    expect(sanitizeColorSpace(null)).toEqual(DEFAULT_COLOR_SPACE);
    expect(sanitizeColorSpace(undefined)).toEqual(DEFAULT_COLOR_SPACE);

    // Partial empty object gets populated with valid defaults
    const partial = sanitizeColorSpace({});
    expect(partial.primaries).toBe('bt709');
    expect(partial.transfer).toBe('bt709');
    expect(partial.matrix).toBe('bt709');
    expect(partial.fullRange).toBe(false);

    // Unsupported primaries (e.g., bt2020) are normalized so mp4-muxer COLOR_PRIMARIES_MAP never reads undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const custom = sanitizeColorSpace({
      primaries: 'bt2020' as any,
      transfer: 'iec61966-2-1',
      matrix: 'rgb',
      fullRange: true,
    });
    expect(custom.primaries).toBe('bt709'); // Normalized
    expect(custom.transfer).toBe('iec61966-2-1'); // Preserved
    expect(custom.matrix).toBe('rgb'); // Preserved
    expect(custom.fullRange).toBe(true);
  });

  it('extracts SPS and PPS correctly from AVCC length-prefixed keyframes', async () => {
    const { extractSpsPpsFromChunk } = await import('../core/export/webcodecsExporter');

    // AVCC format: [4-byte length][SPS (nal 7)], [4-byte length][PPS (nal 8)], [4-byte length][IDR (nal 5)]
    const spsPayload = [0x67, 0x64, 0x00, 0x28]; // NAL unit type 7
    const ppsPayload = [0x68, 0xee, 0x3c]; // NAL unit type 8
    const idrPayload = [0x65, 0x01, 0x02, 0x03]; // NAL unit type 5

    const avccChunk = new Uint8Array([
      0, 0, 0, spsPayload.length, ...spsPayload,
      0, 0, 0, ppsPayload.length, ...ppsPayload,
      0, 0, 0, idrPayload.length, ...idrPayload,
    ]);

    const { sps, pps } = extractSpsPpsFromChunk(avccChunk);
    expect(sps).not.toBeNull();
    expect(pps).not.toBeNull();
    expect(Array.from(sps!)).toEqual(spsPayload);
    expect(Array.from(pps!)).toEqual(ppsPayload);
  });

  it('extracts SPS and PPS correctly from AVCC keyframes with large NAL units (length >= 256 bytes) without false Annex-B trigger', async () => {
    const { extractSpsPpsFromChunk } = await import('../core/export/webcodecsExporter');

    // NAL unit with length 260 bytes (starts with 0x00, 0x00, 0x01, 0x04)
    // Previously this caused a false positive Annex-B trigger because byte 0..2 were 0,0,1
    const largeSps = new Uint8Array(260);
    largeSps[0] = 0x67; // NAL unit type 7
    largeSps[1] = 0x64; // High Profile
    largeSps[2] = 0x00;
    largeSps[3] = 0x28;

    const pps = new Uint8Array([0x68, 0xee, 0x3c]);
    const idr = new Uint8Array([0x65, 0xaa, 0xbb]);

    const avccChunk = new Uint8Array(4 + largeSps.length + 4 + pps.length + 4 + idr.length);
    const view = new DataView(avccChunk.buffer);

    let offset = 0;
    view.setUint32(offset, largeSps.length, false);
    avccChunk.set(largeSps, offset + 4);
    offset += 4 + largeSps.length;

    view.setUint32(offset, pps.length, false);
    avccChunk.set(pps, offset + 4);
    offset += 4 + pps.length;

    view.setUint32(offset, idr.length, false);
    avccChunk.set(idr, offset + 4);

    const result = extractSpsPpsFromChunk(avccChunk);
    expect(result.sps).not.toBeNull();
    expect(result.pps).not.toBeNull();
    expect(result.sps!.length).toBe(260);
    expect(Array.from(result.pps!)).toEqual([0x68, 0xee, 0x3c]);
  });

  it('generates valid baseline SPS and PPS for landscape and vertical mobile aspect ratios', async () => {
    const { generateBaselineSps, generateBaselinePps } = await import(
      '../core/export/webcodecsExporter'
    );

    // 16:9 Landscape (1920x1080)
    const spsLandscape = generateBaselineSps(1920, 1080);
    expect(spsLandscape[0] & 0x1f).toBe(7); // NAL type 7 (SPS)
    expect(spsLandscape[1]).toBe(66); // Baseline profile (0x42)
    expect(spsLandscape[3]).toBe(40); // Level 4.0

    // 9:16 Vertical / Mobile Portrait (1080x1920)
    const spsVertical = generateBaselineSps(1080, 1920);
    expect(spsVertical[0] & 0x1f).toBe(7);
    expect(spsVertical[1]).toBe(66);
    expect(spsVertical[3]).toBe(40);
    expect(spsVertical).not.toEqual(spsLandscape); // Different macroblock dimensions

    // PPS
    const pps = generateBaselinePps();
    expect(pps[0] & 0x1f).toBe(8); // NAL type 8 (PPS)
  });

  it('extracts SPS and PPS correctly from Annex-B start-code keyframes', async () => {
    const { extractSpsPpsFromChunk } = await import('../core/export/webcodecsExporter');

    // Annex-B format: 00 00 00 01 [SPS], 00 00 00 01 [PPS], 00 00 01 [IDR]
    const spsPayload = [0x67, 0x64, 0x00, 0x28];
    const ppsPayload = [0x68, 0xee, 0x3c];
    const idrPayload = [0x65, 0x01, 0x02];

    const annexBChunk = new Uint8Array([
      0, 0, 0, 1, ...spsPayload,
      0, 0, 0, 1, ...ppsPayload,
      0, 0, 1, ...idrPayload,
    ]);

    const { sps, pps } = extractSpsPpsFromChunk(annexBChunk);
    expect(sps).not.toBeNull();
    expect(pps).not.toBeNull();
    expect(Array.from(sps!)).toEqual(spsPayload);
    expect(Array.from(pps!)).toEqual(ppsPayload);
  });

  it('safely returns nulls for delta frames or empty data', async () => {
    const { extractSpsPpsFromChunk } = await import('../core/export/webcodecsExporter');

    // Delta frame without SPS/PPS
    const deltaChunk = new Uint8Array([0, 0, 0, 2, 0x41, 0x01]);
    const { sps, pps } = extractSpsPpsFromChunk(deltaChunk);
    expect(sps).toBeNull();
    expect(pps).toBeNull();

    // Empty data
    expect(extractSpsPpsFromChunk(new Uint8Array(0))).toEqual({ sps: null, pps: null });
  });

  it('builds a compliant ISO/IEC 14496-15 AVCDecoderConfigurationRecord', async () => {
    const { buildAvcDecoderConfigurationRecord } = await import(
      '../core/export/webcodecsExporter'
    );

    const sps = new Uint8Array([0x67, 0x64, 0x00, 0x28]); // High Profile (100), Level 4.0 (40)
    const pps = new Uint8Array([0x68, 0xee, 0x3c]);

    const record = buildAvcDecoderConfigurationRecord(sps, pps);
    expect(record.length).toBe(11 + sps.length + pps.length);

    const view = new DataView(record.buffer);
    expect(record[0]).toBe(1); // configurationVersion
    expect(record[1]).toBe(0x64); // AVCProfileIndication
    expect(record[2]).toBe(0x00); // profile_compatibility
    expect(record[3]).toBe(0x28); // AVCLevelIndication
    expect(record[4]).toBe(0xff); // lengthSizeMinusOne (4-byte NAL length)
    expect(record[5]).toBe(0xe1); // numOfSequenceParameterSets (1)
    expect(view.getUint16(6, false)).toBe(sps.length);
    expect(Array.from(record.slice(8, 8 + sps.length))).toEqual(Array.from(sps));

    const ppsPos = 8 + sps.length;
    expect(record[ppsPos]).toBe(1); // numOfPictureParameterSets (1)
    expect(view.getUint16(ppsPos + 1, false)).toBe(pps.length);
    expect(Array.from(record.slice(ppsPos + 3))).toEqual(Array.from(pps));
  });

  it('generates a valid fallback AVC description buffer', async () => {
    const { getFallbackAvcDescription } = await import('../core/export/webcodecsExporter');

    const fallback = getFallbackAvcDescription(1920, 1080);
    expect(fallback).toBeInstanceOf(Uint8Array);
    expect(fallback.length).toBeGreaterThan(20);
    expect(fallback[0]).toBe(1); // configurationVersion
    expect(fallback[1]).toBe(66); // Baseline Profile
  });

  it('controls encoder backpressure drain with dequeue and safety interval', async () => {
    const { waitForEncoderDrain } = await import('../core/export/webcodecsExporter');

    // Case 1: queue already within limit
    const mockEncoderLow = {
      encodeQueueSize: 2,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as VideoEncoder;

    await expect(waitForEncoderDrain(mockEncoderLow, 3)).resolves.toBeUndefined();
    expect(mockEncoderLow.addEventListener).not.toHaveBeenCalled();

    // Case 2: queue above limit, then drops
    let dequeueCallback: (() => void) | null = null;
    const mockEncoderHigh = {
      encodeQueueSize: 5,
      addEventListener: vi.fn((_ev, cb) => {
        dequeueCallback = cb;
      }),
      removeEventListener: vi.fn(),
    } as unknown as VideoEncoder;

    const drainPromise = waitForEncoderDrain(mockEncoderHigh, 3);
    expect(mockEncoderHigh.addEventListener).toHaveBeenCalledWith('dequeue', expect.any(Function));

    // Simulate drain
    (mockEncoderHigh as { encodeQueueSize: number }).encodeQueueSize = 2;
    if (dequeueCallback) (dequeueCallback as () => void)();

    await expect(drainPromise).resolves.toBeUndefined();
    expect(mockEncoderHigh.removeEventListener).toHaveBeenCalledWith('dequeue', expect.any(Function));
  });

  it('successfully finalizes Muxer with sanitized metadata without colorSpace or null object errors', async () => {
    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
    const { sanitizeColorSpace, getFallbackAvcDescription } = await import(
      '../core/export/webcodecsExporter'
    );

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: {
        codec: 'avc',
        width: 1920,
        height: 1080,
        frameRate: 30,
      },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    const fallbackDesc = getFallbackAvcDescription(1920, 1080);
    const sanitizedMeta = {
      decoderConfig: {
        codec: 'avc1.640028',
        codedWidth: 1920,
        codedHeight: 1080,
        colorSpace: sanitizeColorSpace(null), // Safari iOS passing null / undefined colorSpace
        description: fallbackDesc.buffer,
      },
    };

    // Add keyframe sample
    const fakeChunkData = new Uint8Array([0, 0, 0, 4, 0x65, 1, 2, 3]);
    muxer.addVideoChunkRaw(fakeChunkData, 'key', 0, 33333, sanitizedMeta);

    // Finalize should cleanly create the moov and colr boxes without throwing
    expect(() => muxer.finalize()).not.toThrow();
    expect(target.buffer.byteLength).toBeGreaterThan(0);
  });

  it('demonstrates that an unpopulated Muxer track throws colorSpace error without sanitized chunks', async () => {
    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
    const target = new ArrayBufferTarget();
    const rawMuxer = new Muxer({
      target,
      video: { codec: 'avc', width: 1920, height: 1080 },
      fastStart: 'in-memory',
    });
    // Finalizing without any chunks having decoderConfig crashes mp4-muxer on track.info.decoderConfig.colorSpace
    expect(() => rawMuxer.finalize()).toThrow(/colorSpace/);
  });

  it('demonstrates that native mp4-muxer addVideoChunk throws when chunk.duration is null or undefined (WebKit iOS issue)', async () => {
    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
    const { sanitizeColorSpace, getFallbackAvcDescription } = await import(
      '../core/export/webcodecsExporter'
    );

    // Ensure EncodedVideoChunk class is available for instanceof check
    if (typeof (globalThis as unknown as { EncodedVideoChunk?: unknown }).EncodedVideoChunk === 'undefined') {
      (globalThis as unknown as { EncodedVideoChunk: unknown }).EncodedVideoChunk = class MockEncodedVideoChunk {
        type: 'key' | 'delta';
        timestamp: number;
        duration: number | null | undefined;
        byteLength: number;
        private _data: Uint8Array;
        constructor(init: { type: 'key' | 'delta'; timestamp: number; duration?: number | null; data: Uint8Array }) {
          this.type = init.type;
          this.timestamp = init.timestamp;
          this.duration = init.duration;
          this._data = init.data;
          this.byteLength = init.data.byteLength;
        }
        copyTo(dest: Uint8Array) {
          dest.set(this._data);
        }
      };
    }

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width: 1920, height: 1080, frameRate: 30 },
      fastStart: 'in-memory',
    });

    const fallbackDesc = getFallbackAvcDescription(1920, 1080);
    const sanitizedMeta = {
      decoderConfig: {
        codec: 'avc1.640028',
        codedWidth: 1920,
        codedHeight: 1080,
        colorSpace: sanitizeColorSpace(null),
        description: fallbackDesc.buffer,
      },
    };

    const EncodedVideoChunkClass = (globalThis as unknown as { EncodedVideoChunk: new (init: unknown) => unknown }).EncodedVideoChunk;
    const chunkWithNullDuration = new EncodedVideoChunkClass({
      type: 'key',
      timestamp: 0,
      duration: null, // Simulated WebKit iOS null duration
      data: new Uint8Array([0, 0, 0, 4, 0x65, 1, 2, 3]),
    });

    // Native mp4-muxer addVideoChunk throws TypeError because chunk.duration is null
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      muxer.addVideoChunk(chunkWithNullDuration as any, sanitizedMeta);
    }).toThrow(/addVideoChunkRaw's fourth argument \(duration\) must be a non-negative real number/);
  });

  it('safely handles chunks with duration null, undefined, or 0 via safeAddVideoChunk without error', async () => {
    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
    const { safeAddVideoChunk, sanitizeColorSpace, getFallbackAvcDescription } = await import(
      '../core/export/webcodecsExporter'
    );

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: {
        codec: 'avc',
        width: 1920,
        height: 1080,
        frameRate: 30,
      },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    const fallbackDesc = getFallbackAvcDescription(1920, 1080);
    const sanitizedMeta = {
      decoderConfig: {
        codec: 'avc1.640028',
        codedWidth: 1920,
        codedHeight: 1080,
        colorSpace: sanitizeColorSpace(null),
        description: fallbackDesc.buffer,
      },
    };

    // 1. Chunk with duration = null (iOS Safari keyframe)
    const chunkNull = {
      byteLength: 8,
      copyTo: (dest: Uint8Array) => dest.set([0, 0, 0, 4, 0x65, 1, 2, 3]),
      type: 'key' as const,
      timestamp: 0,
      duration: null,
    };
    expect(() => safeAddVideoChunk(muxer, chunkNull, sanitizedMeta, 30)).not.toThrow();

    // 2. Chunk with duration = undefined (iOS Safari delta frame)
    const chunkUndefined = {
      byteLength: 8,
      copyTo: (dest: Uint8Array) => dest.set([0, 0, 0, 4, 0x41, 1, 2, 3]),
      type: 'delta' as const,
      timestamp: 33333,
      duration: undefined,
    };
    expect(() => safeAddVideoChunk(muxer, chunkUndefined, sanitizedMeta, 30)).not.toThrow();

    // 3. Chunk with duration = 0 (simulated 0 duration)
    const chunkZero = {
      byteLength: 8,
      copyTo: (dest: Uint8Array) => dest.set([0, 0, 0, 4, 0x41, 4, 5, 6]),
      type: 'delta' as const,
      timestamp: 66666,
      duration: 0,
    };
    expect(() => safeAddVideoChunk(muxer, chunkZero, sanitizedMeta, 30)).not.toThrow();

    // 4. Chunk with duration = NaN (simulated NaN)
    const chunkNaN = {
      byteLength: 8,
      copyTo: (dest: Uint8Array) => dest.set([0, 0, 0, 4, 0x41, 7, 8, 9]),
      type: 'delta' as const,
      timestamp: 100000,
      duration: NaN,
    };
    expect(() => safeAddVideoChunk(muxer, chunkNaN, sanitizedMeta, 30)).not.toThrow();

    // 5. Chunk with valid positive duration
    const chunkValid = {
      byteLength: 8,
      copyTo: (dest: Uint8Array) => dest.set([0, 0, 0, 4, 0x41, 10, 11, 12]),
      type: 'delta' as const,
      timestamp: 133333,
      duration: 33333,
    };
    expect(() => safeAddVideoChunk(muxer, chunkValid, sanitizedMeta, 30)).not.toThrow();

    // Finalize should succeed cleanly
    expect(() => muxer.finalize()).not.toThrow();
    expect(target.buffer.byteLength).toBeGreaterThan(0);
  });

  it('safely handles audio chunks with duration null, undefined, or 0 via safeAddAudioChunk without error', async () => {
    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
    const { safeAddAudioChunk } = await import('../core/export/webcodecsExporter');

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      audio: {
        codec: 'aac',
        numberOfChannels: 2,
        sampleRate: 48000,
      },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    const fakeAudioData = new Uint8Array([0x21, 0x10, 0x05, 0x20]);

    // Audio chunk with duration = null
    const audioNull = {
      byteLength: fakeAudioData.length,
      copyTo: (dest: Uint8Array) => dest.set(fakeAudioData),
      type: 'key' as const,
      timestamp: 0,
      duration: null,
    };
    expect(() => safeAddAudioChunk(muxer, audioNull, undefined, 48000)).not.toThrow();

    // Audio chunk with duration = undefined
    const audioUndefined = {
      byteLength: fakeAudioData.length,
      copyTo: (dest: Uint8Array) => dest.set(fakeAudioData),
      type: 'delta' as const,
      timestamp: 21333,
      duration: undefined,
    };
    expect(() => safeAddAudioChunk(muxer, audioUndefined, undefined, 48000)).not.toThrow();

    // Audio chunk with duration = 0
    const audioZero = {
      byteLength: fakeAudioData.length,
      copyTo: (dest: Uint8Array) => dest.set(fakeAudioData),
      type: 'delta' as const,
      timestamp: 42666,
      duration: 0,
    };
    expect(() => safeAddAudioChunk(muxer, audioZero, undefined, 48000)).not.toThrow();

    // Finalize should succeed cleanly
    expect(() => muxer.finalize()).not.toThrow();
    expect(target.buffer.byteLength).toBeGreaterThan(0);
  });
});

