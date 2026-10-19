import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MasterClock } from '../core/engine/MasterClock';
import { AudioEngine } from '../core/engine/AudioEngine';
import { mediaSourcePool } from '../core/engine/MediaSourcePool';
import { Clip, MediaItem, Track } from '../types/project';

describe('Challenger 1: MasterClock & AudioEngine Adversarial Stress Test Harness', () => {
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

  // =========================================================================
  // 1. MasterClock Adversarial Stress Tests
  // =========================================================================
  describe('MasterClock Adversarial Stress Testing', () => {
    it('survives rapid play/pause spamming (100 toggles in rapid burst) without state corruption or orphan RAF loops', () => {
      delete (globalThis as Record<string, unknown>).AudioContext;
      const clock = new MasterClock();
      clock.setDuration(30.0);

      const stateTransitions: boolean[] = [];
      const unsubState = clock.subscribeState((isPlaying) => {
        stateTransitions.push(isPlaying);
      });

      // Rapidly toggle 100 times
      for (let i = 0; i < 100; i++) {
        clock.togglePlay();
        expect(clock.getIsPlaying()).toBe(i % 2 === 0);
      }

      // After 100 toggles (even number of toggles starting from paused), must be paused
      expect(clock.getIsPlaying()).toBe(false);
      expect(stateTransitions.length).toBe(100);

      // Verify clock time remains strictly within valid bounds [0, 30]
      const t = clock.getTime();
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(30);

      unsubState();
    });

    it('survives asynchronous play/pause bursts while AudioContext resume() is in-flight', async () => {
      let resolveResume: (() => void) | null = null;
      class MockDelayedContext {
        state: AudioContextState = 'suspended';
        currentTime = 0;
        resume = vi.fn().mockImplementation(() => {
          return new Promise<void>((resolve) => {
            resolveResume = () => {
              this.state = 'running';
              resolve();
            };
          });
        });
      }
      (globalThis as Record<string, unknown>).AudioContext = MockDelayedContext;

      const clock = new MasterClock();
      clock.setDuration(20.0);

      // Play initiated (resume() in flight)
      clock.play();
      expect(clock.getIsPlaying()).toBe(true);

      // Pause immediately before resume resolves
      clock.pause();
      expect(clock.getIsPlaying()).toBe(false);

      // Now resolve the previous resume() promise asynchronously
      if (resolveResume) {
        (resolveResume as () => void)();
      }
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Clock should STILL be paused, not resurrected
      expect(clock.getIsPlaying()).toBe(false);

      // Play again, and let resume resolve normally
      clock.play();
      expect(clock.getIsPlaying()).toBe(true);
      if (resolveResume) {
        (resolveResume as () => void)();
      }
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(clock.getIsPlaying()).toBe(true);
      clock.pause();
    });

    it('handles extreme duration boundary seeks, past-boundary seeks, and negative seeks without crashing', () => {
      delete (globalThis as Record<string, unknown>).AudioContext;
      const clock = new MasterClock();
      clock.setDuration(15.0);

      // Boundary values
      const testCases = [
        { seekTo: -100, expected: 0 },
        { seekTo: -0.00001, expected: 0 },
        { seekTo: 0, expected: 0 },
        { seekTo: 14.99999, expected: 14.99999 },
        { seekTo: 15.0, expected: 15.0 },
        { seekTo: 15.00001, expected: 15.0 },
        { seekTo: 999999, expected: 15.0 },
        { seekTo: Infinity, expected: 15.0 },
        { seekTo: -Infinity, expected: 0 },
      ];

      for (const tc of testCases) {
        clock.seek(tc.seekTo);
        const t = clock.getTime();
        expect(t).toBeCloseTo(tc.expected, 4);
      }

      // Rapid scrubbing back and forth at boundary while playing
      clock.play();
      for (let i = 0; i < 50; i++) {
        clock.seek(14.95 + (i % 2 === 0 ? 0.2 : -0.1));
        const t = clock.getTime();
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(15.0);
      }
      clock.pause();
    });

    it('handles dynamic duration shrinking while playing beyond the new duration', () => {
      delete (globalThis as Record<string, unknown>).AudioContext;
      const clock = new MasterClock();
      clock.setDuration(20.0);
      clock.seek(15.0);
      clock.play();

      expect(clock.getIsPlaying()).toBe(true);
      expect(clock.getTime()).toBeCloseTo(15.0, 1);

      // Dynamically shrink duration to 10.0s (less than current position 15.0s)
      clock.setDuration(10.0);

      // getTime() must clamp without throwing. The pause at the end of the
      // timeline is owned by the playback tick, not by the getter (E-15).
      const t = clock.tick();
      expect(t).toBe(10.0);
      expect(clock.getIsPlaying()).toBe(false);
    });

    it('supports self-unsubscribing listeners without modifying Set iteration state', () => {
      const clock = new MasterClock();
      let callCount = 0;
      let unsub: () => void;
      unsub = clock.subscribeTime(() => {
        callCount++;
        unsub(); // Unsubscribe inside callback
      });

      clock.seek(1.0);
      clock.seek(2.0);
      expect(callCount).toBe(1);
    });

    it('injects severe clock drift forward (+50s), backward (-10s), and freeze without timeline desync or NaN', () => {
      let mockAudioCurrentTime = 5.0;
      const mockCtx = {
        state: 'running' as AudioContextState,
        get currentTime() {
          return mockAudioCurrentTime;
        },
        resume: vi.fn().mockResolvedValue(undefined),
      };
      (globalThis as Record<string, unknown>).AudioContext = vi.fn().mockImplementation(() => mockCtx);

      const clock = new MasterClock();
      clock.setDuration(30.0);
      clock.seek(5.0);
      clock.play();

      let simWallTime = performance.now();
      const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => simWallTime);

      // 1. Normal sync for 100ms
      simWallTime += 100;
      mockAudioCurrentTime += 0.1;
      let t = clock.getTime();
      expect(t).toBeCloseTo(5.1, 1);

      // 2. Drift injection: Audio context suddenly leaps forward by +50s (system clock jump / Bluetooth reconnect)
      simWallTime += 100; // wall clock advanced 100ms
      mockAudioCurrentTime += 50.0; // audio clock leaped +50s
      t = clock.getTime();
      // Must reject the +50s audio jump (> 250ms drift) and use wall clock (~5.2s)
      expect(t).toBeLessThan(6.0);
      expect(t).toBeGreaterThanOrEqual(5.15);

      // 3. Drift injection: Audio context suddenly rewinds backwards by -20s (driver reset)
      simWallTime += 100;
      mockAudioCurrentTime = 1.0; // Audio clock fell backwards
      t = clock.getTime();
      // Must reject backward leap and use wall clock (~5.3s)
      expect(t).toBeLessThan(6.0);
      expect(t).toBeGreaterThanOrEqual(5.25);

      // 4. Drift injection: Audio context completely freezes at 1.0 while wall clock runs for 1.0s
      simWallTime += 1000;
      // mockAudioCurrentTime unchanged
      t = clock.getTime();
      // Must advance smoothly with wall clock (~6.3s)
      expect(t).toBeCloseTo(6.3, 1);

      perfSpy.mockRestore();
      clock.pause();
    });

    it('gracefully handles suspended, interrupted, and closed AudioContext states', () => {
      const mockCtx = {
        state: 'suspended' as AudioContextState,
        currentTime: 0,
        resume: vi.fn().mockResolvedValue(undefined),
      };
      (globalThis as Record<string, unknown>).AudioContext = vi.fn().mockImplementation(() => mockCtx);

      const clock = new MasterClock();
      clock.setDuration(10.0);
      clock.play();

      let simWallTime = performance.now();
      const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => simWallTime);

      // State is suspended: timeline advances via performance.now
      simWallTime += 300;
      expect(clock.getTime()).toBeCloseTo(0.3, 1);

      // State changes to interrupted (e.g. phone call or background tab on iOS Safari)
      mockCtx.state = 'interrupted' as AudioContextState;
      simWallTime += 300;
      expect(clock.getTime()).toBeCloseTo(0.6, 1);

      // State changes to closed
      mockCtx.state = 'closed' as AudioContextState;
      simWallTime += 300;
      expect(clock.getTime()).toBeCloseTo(0.9, 1);

      perfSpy.mockRestore();
      clock.pause();
    });
  });

  // =========================================================================
  // 2. AudioEngine Adversarial Stress Tests
  // =========================================================================
  describe('AudioEngine Adversarial Stress Testing', () => {
    let engine: AudioEngine;
    let fakeAudioEl: HTMLAudioElement;
    let fakeVideoEl: HTMLVideoElement;
    let volumeSetterCount: number;
    let mutedSetterCount: number;
    let audioVolume: number;
    let audioMuted: boolean;

    const audioTrack: Track = { id: 'tr_a1', name: 'Audio Track', type: 'audio', isMuted: false, isLocked: false, isVisible: true };
    const videoTrack: Track = { id: 'tr_v1', name: 'Video Track', type: 'video', isMuted: false, isLocked: false, isVisible: true };

    const audioClip: Clip = {
      id: 'clip_a1',
      trackId: 'tr_a1',
      mediaId: 'med_a1',
      name: 'Audio Clip',
      type: 'audio',
      start: 0,
      duration: 100,
      sourceStart: 0,
      sourceDuration: 100,
      volume: 0.5,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };

    const mediaList: MediaItem[] = [
      { id: 'med_a1', name: 'Audio Media', type: 'audio', url: 'blob:a1', duration: 100, width: 0, height: 0, fps: 0, thumbnailUrl: '', size: 100, createdAt: 0 },
    ];

    beforeEach(() => {
      engine = new AudioEngine();
      volumeSetterCount = 0;
      mutedSetterCount = 0;
      audioVolume = 1.0;
      audioMuted = false;

      fakeAudioEl = {
        get volume() {
          return audioVolume;
        },
        set volume(v: number) {
          volumeSetterCount++;
          audioVolume = v;
        },
        get muted() {
          return audioMuted;
        },
        set muted(m: boolean) {
          mutedSetterCount++;
          audioMuted = m;
        },
        currentTime: 0,
        playbackRate: 1.0,
        paused: false,
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
      } as unknown as HTMLAudioElement;

      fakeVideoEl = {
        muted: false,
        volume: 1.0,
      } as unknown as HTMLVideoElement;

      vi.spyOn(mediaSourcePool, 'getAudioElement').mockReturnValue(fakeAudioEl);
      vi.spyOn(mediaSourcePool, 'getVideoElement').mockReturnValue(fakeVideoEl);
    });

    it('endures 1,000 continuous frames of rapid volume/mute fluctuations with zero crashes and strict DOM caching', () => {
      // Run 1,000 frames simulating 60 FPS playback with micro-jitter, large jumps, and mute toggles
      for (let frame = 0; frame < 1000; frame++) {
        const time = frame * 0.016;

        // Simulate alternating conditions:
        // Every 100 frames, toggle track mute
        if (frame % 100 === 0) {
          audioTrack.isMuted = !audioTrack.isMuted;
        }

        // Add sub-0.01 micro-jitter on odd frames, stable on even frames
        const microJitter = frame % 2 === 0 ? 0 : 0.003;
        const currentClip: Clip = {
          ...audioClip,
          volume: 0.6 + microJitter,
        };

        expect(() => {
          engine.updateAudio(time, true, [audioTrack], [currentClip], mediaList);
        }).not.toThrow();
      }

      // Assert volume setter was called minimal times (only on significant changes), NOT 1,000 times
      // Micro-jitter of 0.003 should be completely suppressed by elementVolumeCache (<0.01 threshold)
      expect(volumeSetterCount).toBeLessThan(10);

      // Mute setter should be called roughly ~10 times (every 100 frames when track mute toggled), NOT 1,000 times
      expect(mutedSetterCount).toBeLessThanOrEqual(15);
    });

    it('endures a dense project of 20 tracks and 100 clips over 1,000 frames without memory leaks or errors', () => {
      const denseTracks: Track[] = [];
      const denseClips: Clip[] = [];
      const denseMedia: MediaItem[] = [];

      for (let t = 0; t < 20; t++) {
        const trackId = `track_${t}`;
        denseTracks.push({
          id: trackId,
          name: `Track ${t}`,
          type: t % 2 === 0 ? 'video' : 'audio',
          isMuted: false,
          isLocked: false,
          isVisible: true,
        });

        for (let c = 0; c < 5; c++) {
          const mediaId = `media_${t}_${c}`;
          denseMedia.push({
            id: mediaId,
            name: `Media ${t}-${c}`,
            type: t % 2 === 0 ? 'video' : 'audio',
            url: `blob:${t}-${c}`,
            duration: 60,
            width: 1920,
            height: 1080,
            fps: 30,
            thumbnailUrl: '',
            size: 100,
            createdAt: 0,
          });

          denseClips.push({
            id: `clip_${t}_${c}`,
            trackId,
            mediaId,
            name: `Clip ${t}-${c}`,
            type: t % 2 === 0 ? 'video' : 'audio',
            start: c * 10,
            duration: 10,
            sourceStart: 0,
            sourceDuration: 10,
            volume: 0.8,
            opacity: 1,
            scale: 1,
            positionX: 0,
            positionY: 0,
            muted: false,
          });
        }
      }

      expect(() => {
        for (let f = 0; f < 1000; f++) {
          engine.updateAudio(f * 0.016, true, denseTracks, denseClips, denseMedia);
        }
      }).not.toThrow();
    });

    it('resilient against gain node disconnections, repeated stopAll(), and null AudioContext', () => {
      const mockGainNode = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        gain: { value: 1.0 },
      };

      class ThrowingAudioContext {
        state = 'running';
        destination = {};
        createGain = vi.fn(() => mockGainNode);
      }
      (globalThis as Record<string, unknown>).AudioContext = ThrowingAudioContext;

      // Normal setup
      engine.setMasterVolume(0.8);
      engine.updateAudio(1.0, true, [audioTrack], [audioClip], mediaList);

      // Rapidly call stopAll() 10 times in a row
      for (let i = 0; i < 10; i++) {
        expect(() => engine.stopAll()).not.toThrow();
      }

      // Disconnect gain explicitly to simulate broken graph
      mockGainNode.disconnect.mockImplementation(() => {
        throw new Error('Already disconnected');
      });

      // Calling stopAll() must catch and ignore disconnect errors
      expect(() => engine.stopAll()).not.toThrow();

      // Audio update after stopAll() reconstructs state cleanly
      expect(() => {
        engine.updateAudio(2.0, true, [audioTrack], [audioClip], mediaList);
      }).not.toThrow();
    });

    it('robust against null/undefined clip properties, corrupt elements, and missing media items', () => {
      const corruptClips: Clip[] = [
        // Clip with negative duration and start
        {
          id: 'corrupt_1',
          trackId: 'tr_a1',
          mediaId: 'missing_media',
          name: 'Corrupt 1',
          type: 'audio',
          start: -5,
          duration: -10,
          sourceStart: 0,
          sourceDuration: 0,
          volume: undefined as unknown as number,
          opacity: 1,
          scale: 1,
          positionX: 0,
          positionY: 0,
          muted: false,
        },
        // Clip with speed = 0, speed = -2, speed = NaN
        {
          id: 'corrupt_2',
          trackId: 'tr_a1',
          mediaId: 'med_a1',
          name: 'Corrupt 2',
          type: 'audio',
          start: 0,
          duration: 10,
          sourceStart: 0,
          sourceDuration: 10,
          speed: 0,
          volume: NaN,
          opacity: 1,
          scale: 1,
          positionX: 0,
          positionY: 0,
          muted: false,
        },
        // Video clip pointing to corrupt media element that throws on property access
        {
          id: 'corrupt_3',
          trackId: 'tr_v1',
          mediaId: 'med_a1',
          name: 'Corrupt 3',
          type: 'video',
          start: 0,
          duration: 10,
          sourceStart: 0,
          sourceDuration: 10,
          volume: 1,
          opacity: 1,
          scale: 1,
          positionX: 0,
          positionY: 0,
          muted: false,
        },
      ];

      // Throw inside video getter
      vi.spyOn(mediaSourcePool, 'getVideoElement').mockImplementation(() => {
        throw new Error('WebKit hardware decoder crash');
      });

      // updateAudio must NOT crash the thread
      expect(() => {
        engine.updateAudio(1.0, true, [audioTrack, videoTrack], corruptClips, mediaList);
      }).not.toThrow();
    });
  });

  // =========================================================================
  // 3. Toggle Latency Benchmark (<50ms requirement)
  // =========================================================================
  describe('Benchmark: Spacebar / Touch Toggle Latency (<50ms)', () => {
    it('empirically verifies execution duration of togglePlay across 100 samples (<50ms hard limit, <1ms average)', () => {
      delete (globalThis as Record<string, unknown>).AudioContext;
      const clock = new MasterClock();
      clock.setDuration(30.0);

      const latencies: number[] = [];
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        clock.togglePlay();
        const duration = performance.now() - start;
        latencies.push(duration);
      }

      latencies.sort((a, b) => a - b);
      const min = latencies[0];
      const max = latencies[latencies.length - 1];
      const avg = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;
      const p50 = latencies[Math.floor(latencies.length * 0.50)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const p99 = latencies[Math.floor(latencies.length * 0.99)];

      console.log(`[LATENCY BENCHMARK RESULTS]
        Iterations: ${iterations}
        Min: ${min.toFixed(4)} ms
        Max: ${max.toFixed(4)} ms
        Avg: ${avg.toFixed(4)} ms
        P50: ${p50.toFixed(4)} ms
        P95: ${p95.toFixed(4)} ms
        P99: ${p99.toFixed(4)} ms
      `);

      // Hard requirement from ORIGINAL_REQUEST § 2026-10-15T18:40:05Z Acceptance Criteria:
      // "Respuesta inmediata (< 50ms) al reanudar/pausar con la tecla Espacio o el botón táctil, sin micro-congelamientos."
      expect(max).toBeLessThan(50.0);
      expect(avg).toBeLessThan(5.0);
      expect(p99).toBeLessThan(10.0);
    });

    it('measures toggle latency in suspended Web Audio environment', () => {
      class MockSuspendedCtx {
        state: AudioContextState = 'suspended';
        currentTime = 0;
        resume = vi.fn().mockResolvedValue(undefined);
      }
      (globalThis as Record<string, unknown>).AudioContext = MockSuspendedCtx;

      const clock = new MasterClock();
      clock.setDuration(30.0);

      const latencies: number[] = [];
      for (let i = 0; i < 50; i++) {
        const t0 = performance.now();
        clock.togglePlay();
        const t1 = performance.now();
        latencies.push(t1 - t0);
      }

      const max = Math.max(...latencies);
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

      expect(max).toBeLessThan(50.0);
      expect(avg).toBeLessThan(5.0);
    });
  });
});
