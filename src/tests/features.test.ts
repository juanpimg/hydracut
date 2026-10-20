import { describe, it, expect, beforeEach } from 'vitest';
import { extractWaveformPeaks, generateSyntheticWaveform } from '../core/utils/waveform';
import { calculateTransition } from '../core/engine/Compositor';
import { useProjectStore } from '../store/useProjectStore';
import { Clip } from '../types/project';

describe('Waveform Peak Extraction', () => {
  function createMockAudioBuffer(channels: number, length: number, sampleRate = 44100): AudioBuffer {
    const channelData = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (ch: number) => channelData[ch],
      copyFromChannel: () => {},
      copyToChannel: () => {},
    } as unknown as AudioBuffer;
  }

  it('handles empty audio buffer gracefully', () => {
    const emptyBuf = createMockAudioBuffer(1, 0);
    const peaks = extractWaveformPeaks(emptyBuf, 20);
    expect(peaks).toHaveLength(20);
    expect(peaks.every((p) => p === 0)).toBe(true);
  });

  it('handles silent non-empty audio buffer with all zeroes', () => {
    const silentBuf = createMockAudioBuffer(1, 44100);
    const peaks = extractWaveformPeaks(silentBuf, 20);
    expect(peaks).toHaveLength(20);
    expect(peaks.every((p) => p === 0)).toBe(true);
  });

  it('normalizes sine wave audio peaks correctly', () => {
    const sampleRate = 44100;
    const durationSec = 1;
    const numSamples = sampleRate * durationSec;
    const buf = createMockAudioBuffer(1, numSamples);
    const data = buf.getChannelData(0);

    // Fill with a sine wave that has amplitude 0.8
    for (let i = 0; i < numSamples; i++) {
      data[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    }

    const peaks = extractWaveformPeaks(buf, 50);
    expect(peaks).toHaveLength(50);
    // Normalized peak should reach 1.0 (or very close)
    const max = Math.max(...peaks);
    expect(max).toBeCloseTo(1.0, 1);
    // All values should be between 0 and 1
    expect(peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it('aggregates multiple audio channels (stereo) into peaks', () => {
    const buf = createMockAudioBuffer(2, 1000);
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);

    // Left channel quiet, right channel loud burst in second half
    left.fill(0.1);
    right.fill(0);
    for (let i = 500; i < 1000; i++) {
      right[i] = 0.9;
    }

    const peaks = extractWaveformPeaks(buf, 10);
    expect(peaks).toHaveLength(10);
    // First half (bins 0-4) should have lower values than second half (bins 5-9)
    const firstHalfAvg = peaks.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const secondHalfAvg = peaks.slice(5, 10).reduce((a, b) => a + b, 0) / 5;
    expect(secondHalfAvg).toBeGreaterThan(firstHalfAvg);
  });

  it('generates synthetic waveforms with requested bin counts', () => {
    const synth30 = generateSyntheticWaveform(30);
    const synth60 = generateSyntheticWaveform(60);
    expect(synth30).toHaveLength(30);
    expect(synth60).toHaveLength(60);
    expect(synth30.every((v) => v >= 0.04 && v <= 1)).toBe(true);
  });
});

describe('Transition Engine Calculation', () => {
  const baseClip: Clip = {
    id: 'c1',
    trackId: 't1',
    mediaId: 'm1',
    name: 'Clip',
    type: 'video',
    start: 2.0,
    duration: 6.0, // active [2.0, 8.0]
    sourceStart: 0,
    sourceDuration: 10,
    volume: 1,
    opacity: 1,
    scale: 1,
    positionX: 0,
    positionY: 0,
    muted: false,
  };

  it('returns default transition params when clip has no transition', () => {
    const result = calculateTransition(baseClip, 3.0, 1920);
    expect(result.alphaMultiplier).toBe(1);
    expect(result.offsetX).toBe(0);
    expect(result.wipeWidth).toBeNull();
    expect(result.overlayColor).toBeNull();
    expect(result.overlayOpacity).toBe(0);
  });

  it('calculates fade-black transition correctly', () => {
    const clipWithFade: Clip = {
      ...baseClip,
      transition: {
        fadeInType: 'fade-black',
        fadeInDuration: 1.0,
        fadeOutType: 'fade-black',
        fadeOutDuration: 1.0,
      },
    };

    // The fade is a single overlay (like 'fade-white'): the clip itself is never
    // darkened twice. Before the fix the clip alpha was multiplied AND a black
    // overlay was drawn, which produced 0.25*C + 0.75*B at 50% instead of the
    // symmetric 0.5*C + 0.5*B (E-06).
    // 1. At start of fade in (t = 2.0): fully covered by black
    const startIn = calculateTransition(clipWithFade, 2.0, 1920);
    expect(startIn.alphaMultiplier).toBe(1);
    expect(startIn.overlayColor).toBe('#000000');
    expect(startIn.overlayOpacity).toBe(1);

    // 2. Midway through fade in (t = 2.5): half covered by black
    const midIn = calculateTransition(clipWithFade, 2.5, 1920);
    expect(midIn.alphaMultiplier).toBe(1);
    expect(midIn.overlayOpacity).toBeCloseTo(0.5);

    // 3. Middle of clip (t = 5.0): fully visible, no transition
    const midClip = calculateTransition(clipWithFade, 5.0, 1920);
    expect(midClip.alphaMultiplier).toBe(1);
    expect(midClip.overlayOpacity).toBe(0);

    // 4. Midway through fade out (t = 7.5, 0.5s left out of 1.0s): half covered
    const midOut = calculateTransition(clipWithFade, 7.5, 1920);
    expect(midOut.alphaMultiplier).toBe(1);
    expect(midOut.overlayOpacity).toBeCloseTo(0.5);
  });

  it('calculates fade-white transition overlay', () => {
    const clipWhite: Clip = {
      ...baseClip,
      transition: {
        fadeInType: 'fade-white',
        fadeInDuration: 1.0,
        fadeOutType: 'none',
        fadeOutDuration: 0,
      },
    };

    const startIn = calculateTransition(clipWhite, 2.0, 1920);
    expect(startIn.overlayColor).toBe('#ffffff');
    expect(startIn.overlayOpacity).toBe(1);
  });

  it('calculates slide-left transition offset', () => {
    const clipSlide: Clip = {
      ...baseClip,
      transition: {
        fadeInType: 'slide-left',
        fadeInDuration: 1.0,
        fadeOutType: 'slide-left',
        fadeOutDuration: 1.0,
      },
    };

    const canvasWidth = 1000;

    // At t = 2.0 (progressIn = 0): slides in from right, offsetX = 1000
    const startIn = calculateTransition(clipSlide, 2.0, canvasWidth);
    expect(startIn.offsetX).toBeCloseTo(1000);

    // At t = 2.5 (progressIn = 0.5): offsetX = 500
    const midIn = calculateTransition(clipSlide, 2.5, canvasWidth);
    expect(midIn.offsetX).toBeCloseTo(500);

    // At t = 5.0: normal position, offsetX = 0
    const midClip = calculateTransition(clipSlide, 5.0, canvasWidth);
    expect(midClip.offsetX).toBe(0);

    // At t = 8.0 (end of clip, progressOut = 0): slides out towards left, offsetX = -1000
    const endOut = calculateTransition(clipSlide, 8.0, canvasWidth);
    expect(endOut.offsetX).toBeCloseTo(-1000);
  });

  it('calculates wipe-right transition clipping width', () => {
    const clipWipe: Clip = {
      ...baseClip,
      transition: {
        fadeInType: 'wipe-right',
        fadeInDuration: 2.0,
        fadeOutType: 'wipe-right',
        fadeOutDuration: 2.0,
      },
    };

    const canvasWidth = 1000;

    // At t = 2.0 (start): wipeWidth = 0
    const startIn = calculateTransition(clipWipe, 2.0, canvasWidth);
    expect(startIn.wipeWidth).toBeCloseTo(0);

    // At t = 3.0 (progress 0.5): wipeWidth = 500
    const midIn = calculateTransition(clipWipe, 3.0, canvasWidth);
    expect(midIn.wipeWidth).toBeCloseTo(500);

    // At t = 5.0: fully revealed, wipeWidth = null
    const midClip = calculateTransition(clipWipe, 5.0, canvasWidth);
    expect(midClip.wipeWidth).toBeNull();
  });
});

describe('Snapping Guide & Speed Controls', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('updates snappingGuideTime during clip moves near alignment points', () => {
    const store = useProjectStore.getState();

    // Add clip 1 from 0s to 5s
    const clip1: Clip = {
      id: 'clip_snap_1',
      trackId: 'track_video_1',
      mediaId: 'm1',
      name: 'Clip 1',
      type: 'video',
      start: 0,
      duration: 5,
      sourceStart: 0,
      sourceDuration: 10,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };
    store.addClip(clip1);

    // Add clip 2 from 8s to 12s
    const clip2: Clip = {
      id: 'clip_snap_2',
      trackId: 'track_video_1',
      mediaId: 'm2',
      name: 'Clip 2',
      type: 'video',
      start: 8,
      duration: 4,
      sourceStart: 0,
      sourceDuration: 10,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };
    store.addClip(clip2);

    // Move clip 2 close to clip 1 end (5.05s) with zoom = 60
    // Threshold is 12px / 60px/s = 0.2s, so 5.05s will snap to 5.0s
    store.moveClip('clip_snap_2', 5.05);

    const updated = useProjectStore.getState();
    const movedClip = updated.project.clips.find((c) => c.id === 'clip_snap_2');
    expect(movedClip?.start).toBe(5);
    // Snapping guide line must be set to 5.0
    expect(updated.snappingGuideTime).toBe(5);

    // Clear snapping guide on drag release
    store.setSnappingGuideTime(null);
    expect(useProjectStore.getState().snappingGuideTime).toBeNull();
  });

  it('updates clip speed factor properly', () => {
    const store = useProjectStore.getState();
    const clip: Clip = {
      id: 'clip_spd',
      trackId: 'track_video_1',
      mediaId: 'm1',
      name: 'Speed Clip',
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
    };
    store.addClip(clip);

    store.updateClip('clip_spd', { speed: 2 });
    const updated = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_spd');
    expect(updated?.speed).toBe(2);
  });

  it('calculates secondSourceStart correctly with speed factor during splitClip', () => {
    const store = useProjectStore.getState();
    const clip: Clip = {
      id: 'clip_split_speed',
      trackId: 'track_video_1',
      mediaId: 'm1',
      name: 'Speed Split Clip',
      type: 'video',
      start: 0,
      duration: 4,
      sourceStart: 1.0,
      sourceDuration: 10,
      speed: 2.0,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };
    store.addClip(clip);

    // Split at t = 2.0 (2 seconds into timeline)
    store.splitClip('clip_split_speed', 2.0);

    const clips = useProjectStore.getState().project.clips;
    expect(clips).toHaveLength(2);

    const part1 = clips.find((c) => c.id === 'clip_split_speed')!;
    const part2 = clips.find((c) => c.id !== 'clip_split_speed')!;

    // Part 1: start 0, duration 2, sourceStart 1.0
    expect(part1.start).toBe(0);
    expect(part1.duration).toBe(2.0);
    expect(part1.sourceStart).toBe(1.0);

    // Part 2: start 2, duration 2, sourceStart = 1.0 + 2.0 * 2.0 = 5.0
    expect(part2.start).toBe(2.0);
    expect(part2.duration).toBe(2.0);
    expect(part2.sourceStart).toBe(5.0);
  });

  it('splits transitions cleanly across split slices without duplicating fades in the cut', () => {
    const store = useProjectStore.getState();
    const clip: Clip = {
      id: 'clip_split_trans',
      trackId: 'track_video_1',
      mediaId: 'm1',
      name: 'Transition Split Clip',
      type: 'video',
      start: 0,
      duration: 6,
      sourceStart: 0,
      sourceDuration: 10,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
      transition: {
        fadeInType: 'fade-black',
        fadeInDuration: 1.0,
        fadeOutType: 'fade-white',
        fadeOutDuration: 1.2,
      },
    };
    store.addClip(clip);

    store.splitClip('clip_split_trans', 3.0);

    const clips = useProjectStore.getState().project.clips;
    const part1 = clips.find((c) => c.id === 'clip_split_trans')!;
    const part2 = clips.find((c) => c.id !== 'clip_split_trans')!;

    // Part 1 should retain Fade In, but clear Fade Out at cut point
    expect(part1.transition?.fadeInType).toBe('fade-black');
    expect(part1.transition?.fadeInDuration).toBe(1.0);
    expect(part1.transition?.fadeOutType).toBe('none');
    expect(part1.transition?.fadeOutDuration).toBe(0);

    // Part 2 should clear Fade In at cut point, but retain Fade Out
    expect(part2.transition?.fadeInType).toBe('none');
    expect(part2.transition?.fadeInDuration).toBe(0);
    expect(part2.transition?.fadeOutType).toBe('fade-white');
    expect(part2.transition?.fadeOutDuration).toBe(1.2);
  });

  it('correctly factors clip speed into trimClipStart and trimClipEnd', () => {
    const store = useProjectStore.getState();
    const clip: Clip = {
      id: 'clip_trim_speed',
      trackId: 'track_video_1',
      mediaId: 'm1',
      name: 'Trim Speed Clip',
      type: 'video',
      start: 2.0,
      duration: 4.0,
      sourceStart: 1.0,
      sourceDuration: 10.0,
      speed: 2.0,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };
    store.addClip(clip);

    // Trim start: move start from 2.0 to 3.0 (delta = 1.0s on timeline)
    // At speed 2.0, sourceStart must increase by delta * speed = 1.0 * 2.0 = 2.0 -> new sourceStart = 3.0
    store.trimClipStart('clip_trim_speed', 3.0);
    let updated = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_trim_speed')!;
    expect(updated.start).toBe(3.0);
    expect(updated.duration).toBe(3.0);
    expect(updated.sourceStart).toBe(3.0);

    // Trim end: sourceDuration is 10.0, sourceStart is 3.0.
    // Remaining source duration is 7.0s. At speed 2.0, max timeline duration is 7.0 / 2.0 = 3.5s.
    // If user attempts to drag end to t = 10.0 (requested duration 7.0s):
    // Duration must clamp to 3.5s!
    store.trimClipEnd('clip_trim_speed', 10.0);
    updated = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_trim_speed')!;
    expect(updated.duration).toBeCloseTo(3.5, 2);
  });

  it('allows moving clips between tracks and commits changes', () => {
    const store = useProjectStore.getState();
    const clip: Clip = {
      id: 'clip_move_track',
      trackId: 'track_video_1',
      mediaId: 'm1',
      name: 'Move Track Clip',
      type: 'video',
      start: 2.0,
      duration: 3.0,
      sourceStart: 0,
      sourceDuration: 10.0,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };
    store.addClip(clip);

    // Move to track_video_2 at start = 5.0
    store.moveClip('clip_move_track', 5.0, 'track_video_2');
    const updated = useProjectStore.getState().project.clips.find((c) => c.id === 'clip_move_track')!;
    expect(updated.start).toBe(5.0);
    expect(updated.trackId).toBe('track_video_2');

    // Commit change
    store.commitClipChange();
    expect(useProjectStore.getState().snappingGuideTime).toBeNull();
  });

  it('snaps the END of a moving clip when near another clip start', async () => {
    const { calculateSnapping } = await import('../core/utils/math');
    const existingClip: Clip = {
      id: 'c_existing',
      trackId: 'track_video_1',
      mediaId: 'm1',
      name: 'Existing',
      type: 'video',
      start: 10.0,
      duration: 5.0,
      sourceStart: 0,
      sourceDuration: 5.0,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };

    // Moving clip with duration = 4.0.
    // If user places it at start = 5.95s, its end would be at 9.95s (close to 10.0s).
    // Snapping should snap the END to 10.0s, making start = 6.0s!
    const zoom = 50; // 50px per second, threshold 12px -> 0.24s
    const snap = calculateSnapping(
      5.95,
      [existingClip],
      'c_moving',
      0,
      zoom,
      12,
      true,
      4.0 // clip duration
    );

    expect(snap.didSnap).toBe(true);
    expect(snap.snappedTime).toBeCloseTo(6.0, 2); // 10.0 - 4.0
    expect(snap.snapTargetTime).toBe(10.0);
  });
});
