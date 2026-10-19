import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MasterClock } from '../core/engine/MasterClock';
import { AudioEngine } from '../core/engine/AudioEngine';
import { mediaSourcePool } from '../core/engine/MediaSourcePool';
import { Clip, MediaItem, Track } from '../types/project';

describe('MasterClock & AudioEngine Web Audio API Hardening', () => {
  const originalAudioContext = (globalThis as Record<string, unknown>).AudioContext;
  const originalWebkitAudioContext = (globalThis as Record<string, unknown>).webkitAudioContext;

  afterEach(() => {
    if (originalAudioContext === undefined) {
      delete (globalThis as Record<string, unknown>).AudioContext;
    } else {
      (globalThis as Record<string, unknown>).AudioContext = originalAudioContext;
    }

    if (originalWebkitAudioContext === undefined) {
      delete (globalThis as Record<string, unknown>).webkitAudioContext;
    } else {
      (globalThis as Record<string, unknown>).webkitAudioContext = originalWebkitAudioContext;
    }
    vi.restoreAllMocks();
  });

  describe('MasterClock dual-clock fallback & resilience', () => {
    it('returns null from getAudioContext when Web Audio is completely unsupported without throwing', () => {
      delete (globalThis as Record<string, unknown>).AudioContext;
      delete (globalThis as Record<string, unknown>).webkitAudioContext;

      const clock = new MasterClock();
      expect(() => clock.getAudioContext()).not.toThrow();
      expect(clock.getAudioContext()).toBeNull();
    });

    it('returns null when AudioContext constructor throws an exception', () => {
      (globalThis as Record<string, unknown>).AudioContext = class {
        constructor() {
          throw new Error('AudioContext creation blocked by policy');
        }
      };

      const clock = new MasterClock();
      expect(() => clock.getAudioContext()).not.toThrow();
      expect(clock.getAudioContext()).toBeNull();
    });

    it('advances timeline using performance.now fallback when AudioContext is null', async () => {
      delete (globalThis as Record<string, unknown>).AudioContext;
      delete (globalThis as Record<string, unknown>).webkitAudioContext;

      const clock = new MasterClock();
      clock.setDuration(10);
      expect(clock.getTime()).toBe(0);

      clock.play();
      expect(clock.getIsPlaying()).toBe(true);

      // Simulate passage of 150ms using performance.now
      const nowSpy = vi.spyOn(performance, 'now');
      const start = performance.now();
      nowSpy.mockReturnValue(start + 250);

      const elapsed = clock.getTime();
      expect(elapsed).toBeGreaterThanOrEqual(0.24);
      expect(elapsed).toBeLessThanOrEqual(0.30);

      clock.pause();
      expect(clock.getIsPlaying()).toBe(false);
      expect(clock.getTime()).toBeCloseTo(elapsed, 2);
    });

    it('falls back to performance.now when AudioContext is in suspended state', () => {
      class MockSuspendedAudioContext {
        state: AudioContextState = 'suspended';
        currentTime = 0;
        resume = vi.fn(async () => {
          this.state = 'running';
        });
      }
      (globalThis as Record<string, unknown>).AudioContext = MockSuspendedAudioContext;

      const clock = new MasterClock();
      clock.setDuration(10);
      clock.play();

      // In suspended state, currentTime would remain 0, but dual-clock uses performance.now
      const start = performance.now();
      vi.spyOn(performance, 'now').mockReturnValue(start + 500);

      const t = clock.getTime();
      expect(t).toBeGreaterThanOrEqual(0.49);
      expect(t).toBeLessThanOrEqual(0.55);
    });

    it('automatically pauses at max duration without freezing or exceeding limit', () => {
      delete (globalThis as Record<string, unknown>).AudioContext;
      delete (globalThis as Record<string, unknown>).webkitAudioContext;

      const clock = new MasterClock();
      clock.setDuration(5);
      clock.play();

      const start = performance.now();
      vi.spyOn(performance, 'now').mockReturnValue(start + 6000);

      // The pause at the end of the timeline is owned by the playback tick,
      // `getTime()` is a pure getter (E-15).
      const t = clock.tick();
      expect(t).toBe(5);
      expect(clock.getIsPlaying()).toBe(false);
    });

    it('allows seeking and resuming accurately with performance.now clock', () => {
      delete (globalThis as Record<string, unknown>).AudioContext;
      delete (globalThis as Record<string, unknown>).webkitAudioContext;

      const clock = new MasterClock();
      clock.setDuration(30);
      clock.seek(12.5);
      expect(clock.getTime()).toBe(12.5);

      clock.play();
      const start = performance.now();
      vi.spyOn(performance, 'now').mockReturnValue(start + 1000);

      expect(clock.getTime()).toBeCloseTo(13.5, 1);
    });
  });

  describe('AudioEngine null-safety & graph resilience', () => {
    let mockTracks: Track[];
    let mockClips: Clip[];
    let mockMedia: MediaItem[];

    beforeEach(() => {
      mockTracks = [
        { id: 'track_1', name: 'Audio 1', type: 'audio', isMuted: false, isLocked: false, isVisible: true },
      ];
      mockMedia = [
        {
          id: 'media_1',
          name: 'Sound.wav',
          type: 'audio',
          url: 'blob:sound-test',
          duration: 4,
          width: 0,
          height: 0,
          fps: 0,
          thumbnailUrl: '',
          size: 1024,
          createdAt: Date.now(),
        },
      ];
      mockClips = [
        {
          id: 'clip_1',
          trackId: 'track_1',
          mediaId: 'media_1',
          name: 'Sound Clip',
          type: 'audio',
          start: 0,
          duration: 4,
          sourceStart: 0,
          sourceDuration: 4,
          volume: 1,
          opacity: 1,
          scale: 1,
          positionX: 0,
          positionY: 0,
          muted: false,
        },
      ];
    });

    it('safely runs updateAudio when AudioContext is null without throwing into caller', () => {
      delete (globalThis as Record<string, unknown>).AudioContext;
      delete (globalThis as Record<string, unknown>).webkitAudioContext;

      const engine = new AudioEngine();
      expect(() => {
        engine.updateAudio(1.0, true, mockTracks, mockClips, mockMedia);
      }).not.toThrow();
    });

    it('safely runs setMasterVolume when AudioContext is null', () => {
      delete (globalThis as Record<string, unknown>).AudioContext;
      delete (globalThis as Record<string, unknown>).webkitAudioContext;

      const engine = new AudioEngine();
      expect(() => {
        engine.setMasterVolume(0.75);
      }).not.toThrow();
    });

    it('handles unexpected exceptions in mediaSourcePool or gain nodes inside updateAudio without crashing', () => {
      const engine = new AudioEngine();
      vi.spyOn(mediaSourcePool, 'getAudioElement').mockImplementation(() => {
        throw new Error('Corrupt HTMLAudioElement in WebKit webview');
      });

      expect(() => {
        engine.updateAudio(2.0, true, mockTracks, mockClips, mockMedia);
      }).not.toThrow();
    });

    it('stopAll pauses media pool and resets gain nodes without throwing', () => {
      const pauseAllSpy = vi.spyOn(mediaSourcePool, 'pauseAll');
      const engine = new AudioEngine();

      expect(() => {
        engine.stopAll();
      }).not.toThrow();

      expect(pauseAllSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps the Web Audio routing alive on stopAll and amplifies above 100% through the graph', () => {
      const disconnectMock = vi.fn();
      const mockGainNode = {
        connect: vi.fn(),
        disconnect: disconnectMock,
        gain: { value: 1 },
      };

      class MockAudioContext {
        state = 'running';
        destination = {};
        createGain = vi.fn(() => mockGainNode);
        createMediaElementSource = vi.fn(() => ({ connect: vi.fn() }));
      }
      (globalThis as Record<string, unknown>).AudioContext = MockAudioContext;

      const fakeAudioEl = {
        volume: 1,
        muted: false,
        currentTime: 0,
        playbackRate: 1,
        paused: false,
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
      } as unknown as HTMLAudioElement;
      vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(fakeAudioEl);

      const engine = new AudioEngine();
      engine.setMasterVolume(0.8);

      // A clip at 200% needs the graph: `HTMLMediaElement.volume` is capped at 1.
      const loudClip: Clip = { ...mockClips[0], volume: 2 };
      engine.updateAudio(1.0, true, mockTracks, [loudClip], mockMedia);

      expect(fakeAudioEl.volume).toBeCloseTo(1, 2);
      expect(mockGainNode.gain.value).toBeCloseTo(1.6, 2); // 2.0 * 0.8 master volume

      engine.stopAll();

      // Tearing the graph down would silence the media elements forever.
      expect(disconnectMock).not.toHaveBeenCalled();
    });
  });
});
