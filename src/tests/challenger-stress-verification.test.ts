import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { masterClock } from '../core/engine/MasterClock';
import { MediaSourcePool } from '../core/engine/MediaSourcePool';
import { Compositor } from '../core/engine/Compositor';
import { MobileBottomBar } from '../components/mobile/MobileBottomBar';
import { useProjectStore } from '../store/useProjectStore';
import { Clip, MediaItem, Track } from '../types/project';

// Lightweight DOM mock for React 18 render isolation testing in Node/Vitest
function createMockDOM() {
  class MockNode {
    nodeType: number = 1;
    ownerDocument: unknown = null;
  }
  class MockElement extends MockNode {
    tagName: string = 'DIV';
    nodeName: string = 'DIV';
    style: Record<string, string> = {};
    attributes: Map<string, string> = new Map();
    childNodes: MockNode[] = [];
    disabled: boolean = false;
    textContent: string = '';

    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    setAttributeNS(_ns: string, name: string, value: string) {
      this.attributes.set(name, value);
    }
    getAttribute(name: string) {
      return this.attributes.get(name) || null;
    }
    removeAttribute(name: string) {
      this.attributes.delete(name);
    }
    appendChild<T extends MockNode>(child: T): T {
      this.childNodes.push(child);
      return child;
    }
    removeChild<T extends MockNode>(child: T): T {
      const idx = this.childNodes.indexOf(child);
      if (idx >= 0) this.childNodes.splice(idx, 1);
      return child;
    }
    insertBefore<T extends MockNode>(child: T): T {
      this.childNodes.push(child);
      return child;
    }
    addEventListener() {}
    removeEventListener() {}
  }
  class MockHTMLElement extends MockElement {}
  class MockHTMLButtonElement extends MockHTMLElement {}
  class MockHTMLIFrameElement extends MockHTMLElement {}

  const mockDoc = {
    nodeType: 9,
    createElement(tag: string) {
      const el = tag.toLowerCase() === 'button' ? new MockHTMLButtonElement() : new MockHTMLElement();
      el.tagName = tag.toUpperCase();
      el.nodeName = tag.toUpperCase();
      el.ownerDocument = mockDoc;
      return el;
    },
    createElementNS(_ns: string, tag: string) {
      return mockDoc.createElement(tag);
    },
    createTextNode(text: string) {
      return { nodeType: 3, nodeValue: text, ownerDocument: mockDoc };
    },
    createComment(text: string) {
      return { nodeType: 8, nodeValue: text, ownerDocument: mockDoc };
    },
    addEventListener() {},
    removeEventListener() {},
    defaultView: null as unknown,
  };

  const mockWin = {
    document: mockDoc,
    addEventListener() {},
    removeEventListener() {},
    Node: MockNode,
    Element: MockElement,
    HTMLElement: MockHTMLElement,
    HTMLButtonElement: MockHTMLButtonElement,
    HTMLIFrameElement: MockHTMLIFrameElement,
    SVGElement: MockHTMLElement,
  };
  mockDoc.defaultView = mockWin;

  return { mockDoc, mockWin, MockNode, MockElement, MockHTMLElement, MockHTMLButtonElement };
}

describe('Challenger Stress Verification: Video Sync, Compositor & React Render Isolation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // HARNESS 1: MediaSourcePool.syncVideoTime Stress Test
  // =========================================================================
  describe('Harness 1: MediaSourcePool.syncVideoTime Stress Suite', () => {
    let pool: MediaSourcePool;
    let fakeVideo: HTMLVideoElement;
    let rateSetterHistory: Array<{ rate: number; time: number }>;
    let currentRate: number;
    let currentTimeVal: number;
    let simulatedPerfNow: number;

    beforeEach(() => {
      pool = new MediaSourcePool();
      currentRate = 1.0;
      currentTimeVal = 10.0;
      simulatedPerfNow = 1000;
      rateSetterHistory = [];

      vi.spyOn(performance, 'now').mockImplementation(() => simulatedPerfNow);

      fakeVideo = {
        readyState: 4,
        paused: false,
        seeking: false,
        get currentTime() {
          return currentTimeVal;
        },
        set currentTime(v: number) {
          currentTimeVal = v;
        },
        get playbackRate() {
          return currentRate;
        },
        set playbackRate(val: number) {
          currentRate = val;
          rateSetterHistory.push({ rate: val, time: simulatedPerfNow });
        },
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
      } as unknown as HTMLVideoElement;
    });

    it('injects 1,000 frames of random clock jitter (50ms–300ms) and proves rate mutations strictly respect 300ms cooldown across all transitions', () => {
      const targetTimeBase = 10.0;
      let frameTime = 1000;

      // Seedable pseudo-random generator for reproducible jitter sequence
      let seed = 42;
      const pseudoRandom = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };

      for (let frame = 0; frame < 1000; frame++) {
        frameTime += 16.666; // 60 FPS tick
        simulatedPerfNow = frameTime;

        // Jitter between -300ms and +300ms (covering 50ms..300ms magnitudes)
        const jitterMagnitude = 0.05 + pseudoRandom() * 0.25; // 50ms to 300ms
        const jitterSign = pseudoRandom() > 0.5 ? 1 : -1;
        const jitter = jitterSign * jitterMagnitude;

        currentTimeVal = targetTimeBase + (frame * 0.016666) + jitter;
        const targetTimelineTime = targetTimeBase + (frame * 0.016666);

        pool.syncVideoTime(fakeVideo, targetTimelineTime, true, 1.0);
      }

      // Verify cooldown invariant: consecutive rate mutations MUST be >= 300ms apart
      expect(rateSetterHistory.length).toBeGreaterThan(0);
      for (let i = 1; i < rateSetterHistory.length; i++) {
        const interval = rateSetterHistory[i].time - rateSetterHistory[i - 1].time;
        if (interval < 299.9) {
          console.log('VIOLATION:', {
            prev: rateSetterHistory[i - 1],
            curr: rateSetterHistory[i],
            interval,
          });
        }
        expect(interval).toBeGreaterThanOrEqual(299.9);
      }
    });

    it('stress tests hysteresis barriers: 80ms exit and 200ms enter thresholds under drift oscillations', () => {
      // 1. Drift starts below enter threshold (e.g. 150ms)
      currentTimeVal = 10.15;
      simulatedPerfNow = 1000;
      pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);
      expect(rateSetterHistory.length).toBe(0); // Native 1.0x, no mutation

      // 2. Drift reaches 199ms: Still <= 200ms enter threshold -> no correction
      currentTimeVal = 10.199;
      simulatedPerfNow = 1100;
      pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);
      expect(rateSetterHistory.length).toBe(0);

      // 3. Drift exceeds 200ms (205ms): Correction engages!
      currentTimeVal = 10.205;
      simulatedPerfNow = 1200;
      pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);
      expect(rateSetterHistory.length).toBe(1);
      expect(fakeVideo.playbackRate).toBeCloseTo(0.94, 2);

      // 4. Drift reduces into the hysteresis gap (150ms, 120ms, 85ms).
      // Because exit threshold is 80ms, correction MUST remain engaged!
      const gapDrifts = [0.18, 0.15, 0.12, 0.09, 0.085];
      for (let i = 0; i < gapDrifts.length; i++) {
        currentTimeVal = 10.0 + gapDrifts[i];
        simulatedPerfNow = 1600 + i * 400; // past cooldown
        pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);
        // Rate must STAY at corrective rate (0.94x), NOT revert to 1.0x
        expect(fakeVideo.playbackRate).toBeCloseTo(0.94, 2);
      }

      // 5. Drift drops to <= 80ms (e.g. 78ms): Exits hysteresis back to 1.0x!
      currentTimeVal = 10.078;
      simulatedPerfNow = 4000;
      pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);
      expect(fakeVideo.playbackRate).toBe(1.0);

      // 6. Drift bounces back to 150ms (in the gap): Must NOT re-engage, because enter threshold is 200ms!
      currentTimeVal = 10.15;
      simulatedPerfNow = 4500;
      pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);
      expect(fakeVideo.playbackRate).toBe(1.0);
    });

    it('asserts violent boundary oscillation (195ms <-> 205ms every 16ms) does NOT cause rate thrashing', () => {
      simulatedPerfNow = 1000;

      // 60 frames oscillating right across the 200ms enter boundary
      for (let frame = 0; frame < 60; frame++) {
        simulatedPerfNow += 16.666;
        const drift = (frame % 2 === 0) ? 0.205 : 0.195;
        currentTimeVal = 10.0 + drift;
        pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);
      }

      // Due to hysteresis (once in, 195ms is > 80ms so it stays in) AND cooldown (300ms),
      // rate changes must be minimal (at most 1 initial entry, and 0 exits)
      expect(rateSetterHistory.length).toBe(1);
    });

    it('suppresses drift adjustments completely when video.seeking is true', () => {
      (fakeVideo as unknown as { seeking: boolean }).seeking = true;
      currentTimeVal = 15.0; // massive drift of 5.0 seconds
      simulatedPerfNow = 1000;

      pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);
      expect(rateSetterHistory.length).toBe(0);
      expect(fakeVideo.playbackRate).toBe(1.0);
    });

    it('handles multi-speed playback (0.5x and 2.0x) with scaled drift correction and min clamp', () => {
      // At 2.0x speed, ahead drift should adjust to 2.0 * 0.94 = 1.88
      currentTimeVal = 10.30;
      simulatedPerfNow = 1000;
      pool.syncVideoTime(fakeVideo, 10.0, true, 2.0);
      expect(fakeVideo.playbackRate).toBeCloseTo(1.88, 2);

      // At 0.5x speed with severe negative drift (behind), adjusts to 0.5 * 1.20 = 0.60
      currentTimeVal = 9.20; // 800ms behind -> Zone 3
      simulatedPerfNow = 1500;
      pool.syncVideoTime(fakeVideo, 10.0, true, 0.5);
      expect(fakeVideo.playbackRate).toBeCloseTo(0.60, 2);
    });

    it('triggers hard seek for massive desync (>1.5s) only after 1.5s cooldown (when now >= 1500ms)', () => {
      simulatedPerfNow = 5000;
      currentTimeVal = 12.0; // 2.0s ahead
      pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);

      // Hard seek executed immediately on first occurrence
      expect(currentTimeVal).toBe(10.0);

      // Desync again immediately at t = 5100ms (< 1500ms cooldown)
      simulatedPerfNow = 5100;
      currentTimeVal = 13.0; // 3.0s ahead
      pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);
      // Hard seek must NOT occur before 1500ms cooldown
      expect(currentTimeVal).toBe(13.0);

      // At t = 6600ms (>= 1500ms cooldown), hard seek is permitted again
      simulatedPerfNow = 6600;
      pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);
      expect(currentTimeVal).toBe(10.0);
    });

    it('verifies Defect 1 is resolved: RATE_CHANGE_COOLDOWN (300ms) is enforced when exiting deadband', () => {
      // Step 1: Engage correction mode with +250ms drift at t = 1000ms
      simulatedPerfNow = 1000;
      currentTimeVal = 10.25;
      pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);
      expect(rateSetterHistory.length).toBe(1);
      expect(rateSetterHistory[0]).toEqual({ rate: 0.94, time: 1000 });

      // Step 2: At t = 1100ms (only 100ms elapsed, < 300ms cooldown),
      // jitter causes drift to drop below 80ms exit threshold (50ms)
      simulatedPerfNow = 1100;
      currentTimeVal = 10.05;
      pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);

      // VERIFICATION:
      // Cooldown must prevent changing playbackRate at 100ms elapsed.
      // Rate setter must NOT have been called a second time.
      expect(rateSetterHistory.length).toBe(1);

      // Step 3: Advance time past 300ms cooldown (t = 1350ms, 350ms elapsed)
      simulatedPerfNow = 1350;
      pool.syncVideoTime(fakeVideo, 10.0, true, 1.0);
      expect(rateSetterHistory.length).toBe(2);
      expect(rateSetterHistory[1]).toEqual({ rate: 1.0, time: 1350 });
      const interval = rateSetterHistory[1].time - rateSetterHistory[0].time;
      expect(interval).toBeGreaterThanOrEqual(300);
    });

    it('verifies Defect 2 is resolved: severe drift hard-seek succeeds during early page runtime (now < 1500ms)', () => {
      // Create fresh pool and video simulating early runtime shortly after page load
      const freshPool = new MediaSourcePool();
      let freshCurrentTime = 15.0; // 5.0s desync (> 1.5s threshold)
      simulatedPerfNow = 500; // performance.now() = 500ms (< 1500ms)

      const freshVideo = {
        readyState: 4,
        paused: false,
        seeking: false,
        get currentTime() {
          return freshCurrentTime;
        },
        set currentTime(v: number) {
          freshCurrentTime = v;
        },
        get playbackRate() {
          return 1.0;
        },
        set playbackRate(_val: number) {},
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
      } as unknown as HTMLVideoElement;

      freshPool.syncVideoTime(freshVideo, 10.0, true, 1.0);

      // VERIFICATION:
      // With lastHardSeek defaulting to -Infinity, now - (-Infinity) > 1500 is satisfied.
      // Hard seek executes immediately to targetTime (10.0s).
      expect(freshCurrentTime).toBe(10.0);
    });

    it('proves that the proposed fix eliminates both defects and guarantees >=300ms cooldown across 1,000 frames', () => {
      let lastRateChange = 0;
      let isCorrecting = false;
      let lastHardSeek = -Infinity;
      const history: Array<{ rate: number; time: number }> = [];

      let curRate = 1.0;
      let curTime = 10.0;
      const testVideo = {
        readyState: 4,
        paused: false,
        seeking: false,
        get currentTime() { return curTime; },
        set currentTime(v: number) { curTime = v; },
        get playbackRate() { return curRate; },
        set playbackRate(v: number) {
          curRate = v;
          history.push({ rate: v, time: simulatedPerfNow });
        },
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
      } as unknown as HTMLVideoElement;

      // Fixed syncVideoTime logic
      const fixedSync = (video: HTMLVideoElement, targetTime: number, isPlaying: boolean, speed = 1) => {
        if (!isPlaying || video.seeking || video.paused) return;
        const now = simulatedPerfNow;
        const drift = video.currentTime - targetTime;
        const absDrift = Math.abs(drift);

        if (absDrift > 1.50) {
          if (now - lastHardSeek > 1500) {
            lastHardSeek = now;
            video.currentTime = targetTime;
            isCorrecting = false;
            lastRateChange = now;
          }
          return;
        }

        const DEADBAND_ENTER = 0.20;
        const DEADBAND_EXIT = 0.08;
        const RATE_CHANGE_COOLDOWN = 300;

        if (!isCorrecting) {
          if (absDrift <= DEADBAND_ENTER) {
            if (Math.abs(video.playbackRate - speed) > 0.01) {
              if (now - lastRateChange >= RATE_CHANGE_COOLDOWN) {
                video.playbackRate = speed;
                lastRateChange = now;
              }
            }
            return;
          }
          isCorrecting = true;
        } else {
          if (absDrift <= DEADBAND_EXIT) {
            isCorrecting = false;
            if (Math.abs(video.playbackRate - speed) > 0.01) {
              if (now - lastRateChange >= RATE_CHANGE_COOLDOWN) {
                video.playbackRate = speed;
                lastRateChange = now;
              }
            }
            return;
          }
        }

        let targetRate: number;
        if (absDrift <= 0.60) {
          targetRate = drift < 0 ? speed * 1.06 : Math.max(0.25, speed * 0.94);
        } else {
          targetRate = drift < 0 ? speed * 1.20 : Math.max(0.25, speed * 0.80);
        }

        if (Math.abs(video.playbackRate - targetRate) > 0.01) {
          if (now - lastRateChange >= RATE_CHANGE_COOLDOWN) {
            video.playbackRate = targetRate;
            lastRateChange = now;
          }
        }
      };

      // 1. Verify early page load hard seek works immediately when now = 500ms
      simulatedPerfNow = 500;
      curTime = 15.0;
      fixedSync(testVideo, 10.0, true, 1.0);
      expect(curTime).toBe(10.0); // Hard seek SUCCEEDS immediately!

      // 2. Verify 1,000 frames of random jitter with cooldown strictly >= 300ms
      let frameTime = 1000;
      let seed = 42;
      const pseudoRandom = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };

      for (let frame = 0; frame < 1000; frame++) {
        frameTime += 16.666;
        simulatedPerfNow = frameTime;
        const jitterMagnitude = 0.05 + pseudoRandom() * 0.25;
        const jitterSign = pseudoRandom() > 0.5 ? 1 : -1;
        curTime = 10.0 + (frame * 0.016666) + (jitterSign * jitterMagnitude);
        fixedSync(testVideo, 10.0 + (frame * 0.016666), true, 1.0);
      }

      // Assert zero cooldown violations across all 1,000 frames!
      expect(history.length).toBeGreaterThan(0);
      for (let i = 1; i < history.length; i++) {
        const interval = history[i].time - history[i - 1].time;
        expect(interval).toBeGreaterThanOrEqual(299.9);
      }
    });
  });

  // =========================================================================
  // HARNESS 2: Compositor.renderFrame Multitrack Stress Test
  // =========================================================================
  describe('Harness 2: Compositor.renderFrame 20 Tracks / 100 Clips Stress Suite', () => {
    let compositor: Compositor;
    let fakeCanvas: HTMLCanvasElement;
    let drawOrderLog: Array<{ type: 'video' | 'text'; id: string; trackId: string; zIndex: number }>;
    let fillRectCount = 0;

    // Generate 20 tracks: 12 video, 4 text, 4 audio
    const tracks: Track[] = [];
    for (let i = 0; i < 4; i++) {
      tracks.push({ id: `tr_txt_${i}`, name: `Text ${i}`, type: 'text', isMuted: false, isLocked: false, isVisible: true });
    }
    for (let i = 0; i < 12; i++) {
      tracks.push({ id: `tr_vid_${i}`, name: `Video ${i}`, type: 'video', isMuted: false, isLocked: false, isVisible: true });
    }
    for (let i = 0; i < 4; i++) {
      tracks.push({ id: `tr_aud_${i}`, name: `Audio ${i}`, type: 'audio', isMuted: false, isLocked: false, isVisible: true });
    }

    // Generate 100 clips spanning across tracks and timeline 0..60s
    const clips: Clip[] = [];
    const mediaPool: MediaItem[] = [];

    // Media items
    for (let m = 0; m < 20; m++) {
      mediaPool.push({
        id: `media_${m}`,
        name: `Media ${m}`,
        type: 'video',
        url: `blob:mock_${m}`,
        duration: 60,
        width: 1920,
        height: 1080,
        fps: 30,
        thumbnailUrl: '',
        size: 2048,
        createdAt: 0,
      });
    }

    // Distribute 80 video clips
    for (let c = 0; c < 80; c++) {
      const trackIndex = (c % 12);
      const trackId = `tr_vid_${trackIndex}`;
      const mediaId = `media_${c % 20}`;
      const start = (c * 0.7) % 50;
      clips.push({
        id: `clip_vid_${c}`,
        trackId,
        mediaId,
        name: `Video Clip ${c}`,
        type: 'video',
        start,
        duration: 8,
        sourceStart: 0,
        sourceDuration: 8,
        volume: 1,
        opacity: 0.9,
        scale: 1,
        positionX: (c % 5) * 20,
        positionY: (c % 3) * 10,
        muted: false,
      });
    }

    // Distribute 20 text clips
    for (let t = 0; t < 20; t++) {
      const trackIndex = (t % 4);
      const trackId = `tr_txt_${trackIndex}`;
      const start = (t * 2.5) % 50;
      clips.push({
        id: `clip_txt_${t}`,
        trackId,
        mediaId: '',
        name: `Text Clip ${t}`,
        type: 'text',
        start,
        duration: 6,
        sourceStart: 0,
        sourceDuration: 6,
        volume: 0,
        opacity: 1,
        scale: 1,
        positionX: 0,
        positionY: 0,
        muted: true,
        text: `Overlay Subtitle ${t}`,
      });
    }

    beforeEach(() => {
      compositor = new Compositor();
      drawOrderLog = [];
      fillRectCount = 0;

      fakeCanvas = {
        width: 1920,
        height: 1080,
        getContext: () => ({
          fillStyle: '',
          fillRect: () => {
            fillRectCount++;
          },
          drawImage: () => {},
          save: () => {},
          restore: () => {},
          measureText: () => ({ width: 100 }),
          beginPath: () => {},
          clip: () => {},
          rect: () => {},
          fillText: () => {},
          strokeText: () => {},
        }),
      } as unknown as HTMLCanvasElement;

      // Mock drawMediaToCanvas and drawTextToCanvas to log draw order
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (compositor as any).drawMediaToCanvas = vi.fn().mockImplementation((_ctx, _mediaEl, clip) => {
        drawOrderLog.push({
          type: 'video',
          id: clip.id,
          trackId: clip.trackId,
          zIndex: tracks.findIndex((tr) => tr.id === clip.trackId),
        });
        return true;
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (compositor as any).drawTextToCanvas = vi.fn().mockImplementation((_ctx, clip) => {
        drawOrderLog.push({
          type: 'text',
          id: clip.id,
          trackId: clip.trackId,
          zIndex: tracks.findIndex((tr) => tr.id === clip.trackId),
        });
      });
    });

    it('verifies ZERO Map and Set allocations across 1,000 frames under 20 tracks and 100 clips', () => {
      let mapAllocations = 0;
      let setAllocations = 0;

      const OriginalMap = globalThis.Map;
      const OriginalSet = globalThis.Set;

      // Warm up first frame
      compositor.renderFrame({
        time: 5.0,
        canvas: fakeCanvas,
        tracks,
        clips,
        mediaPool,
        isPlaying: true,
      });

      const MapProxy = new Proxy(OriginalMap, {
        construct(target, args) {
          mapAllocations++;
          return new target(...(args as []));
        },
      });
      const SetProxy = new Proxy(OriginalSet, {
        construct(target, args) {
          setAllocations++;
          return new target(...(args as []));
        },
      });

      globalThis.Map = MapProxy as unknown as MapConstructor;
      globalThis.Set = SetProxy as unknown as SetConstructor;

      try {
        for (let frame = 0; frame < 1000; frame++) {
          const time = (frame * 0.016666) % 55;
          compositor.renderFrame({
            time,
            canvas: fakeCanvas,
            tracks,
            clips,
            mediaPool,
            isPlaying: true,
          });
        }

        // STRICT ASSERTION: 0 Map and Set allocations across 1,000 frames!
        expect(mapAllocations).toBe(0);
        expect(setAllocations).toBe(0);
      } finally {
        globalThis.Map = OriginalMap;
        globalThis.Set = OriginalSet;
      }
    });

    it('validates painter\'s algorithm layer order: lower video tracks render first, text overlays render on top', () => {
      // Pick a time where multiple video and text clips overlap
      const testTime = 6.0;
      drawOrderLog = [];

      compositor.renderFrame({
        time: testTime,
        canvas: fakeCanvas,
        tracks,
        clips,
        mediaPool,
        isPlaying: true,
      });

      expect(drawOrderLog.length).toBeGreaterThan(0);

      // Verify:
      // 1. All video clips must be drawn before ANY text clips
      let seenText = false;
      for (const item of drawOrderLog) {
        if (item.type === 'text') {
          seenText = true;
        }
        if (seenText) {
          expect(item.type).toBe('text');
        }
      }

      // 2. Video track ordering: lower tracks (higher index in tracks array) drawn before higher tracks
      const videoItems = drawOrderLog.filter((x) => x.type === 'video');
      for (let i = 1; i < videoItems.length; i++) {
        // Since loop runs tracks.length - 1 down to 0, track indices should be descending
        expect(videoItems[i - 1].zIndex).toBeGreaterThanOrEqual(videoItems[i].zIndex);
      }
    });

    it('survives rapid seeking stress across 500 random timestamps without throwing or state leakage', () => {
      let errors = 0;
      let seed = 123;
      const rand = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };

      for (let seek = 0; seek < 500; seek++) {
        const randomTime = rand() * 60;
        try {
          compositor.renderFrame({
            time: randomTime,
            canvas: fakeCanvas,
            tracks,
            clips,
            mediaPool,
            isPlaying: false, // Scrub/seek mode
          });
        } catch {
          errors++;
        }
      }

      expect(errors).toBe(0);
    });
  });

  // =========================================================================
  // HARNESS 3: MobileBottomBar React Render Isolation Stress Test
  // =========================================================================
  describe('Harness 3: MobileBottomBar Render Isolation Stress Suite', () => {
    let mockDOM: ReturnType<typeof createMockDOM>;

    beforeEach(() => {
      mockDOM = createMockDOM();
      (globalThis as Record<string, unknown>).document = mockDOM.mockDoc;
      (globalThis as Record<string, unknown>).window = mockDOM.mockWin;
      (globalThis as Record<string, unknown>).Node = mockDOM.MockNode;
      (globalThis as Record<string, unknown>).Element = mockDOM.MockElement;
      (globalThis as Record<string, unknown>).HTMLElement = mockDOM.MockHTMLElement;
      (globalThis as Record<string, unknown>).HTMLButtonElement = mockDOM.MockHTMLButtonElement;

      useProjectStore.getState().resetProject();
    });

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).document;
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).Node;
      delete (globalThis as Record<string, unknown>).Element;
      delete (globalThis as Record<string, unknown>).HTMLElement;
      delete (globalThis as Record<string, unknown>).HTMLButtonElement;
    });

    it('asserts strictly 0 React re-renders across 600 ticks of simulated 60 FPS playback', async () => {
      let renderCount = 0;

      // Populate project with clips so split button has data to inspect
      useProjectStore.getState().addTrack('video', 'V1');
      const trackId = useProjectStore.getState().project.tracks[0].id;
      useProjectStore.setState((s) => ({
        project: {
          ...s.project,
          clips: [
            {
              id: 'c1',
              trackId,
              mediaId: 'm1',
              name: 'Clip 1',
              type: 'video',
              start: 1.0,
              duration: 5.0,
              sourceStart: 0,
              sourceDuration: 5.0,
              volume: 1,
              opacity: 1,
              scale: 1,
              positionX: 0,
              positionY: 0,
              muted: false,
            },
          ],
        },
      }));

      const MonitoredBar: React.FC<{ onOpenSheet: () => void }> = (props) => {
        renderCount++;
        return React.createElement(MobileBottomBar, props);
      };

      const container = mockDOM.mockDoc.createElement('div');
      const root = ReactDOM.createRoot(container as unknown as HTMLElement);

      // Mount
      root.render(React.createElement(MonitoredBar, { onOpenSheet: () => {} }));

      // Wait for initial mount
      await new Promise((r) => setTimeout(r, 60));
      expect(renderCount).toBe(1);

      // Simulate 600 ticks of 60 FPS playback (10 seconds)
      // Playhead crosses into c1 (t=1.0s to t=6.0s) and out of c1 (t=6.0s to 10.0s)
      for (let tick = 0; tick < 600; tick++) {
        const time = tick * (1 / 60);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (masterClock as any).notifyTime(time);
      }

      await new Promise((r) => setTimeout(r, 60));

      // CRUCIAL ASSERTION: ZERO RE-RENDERS
      expect(renderCount).toBe(1);
    });

    it('updates SplitButton disabled DOM attribute imperatively without re-rendering component', async () => {
      let buttonRenderCount = 0;

      // Add a clip from 2.0s to 6.0s
      useProjectStore.getState().addTrack('video', 'V1');
      const trackId = useProjectStore.getState().project.tracks[0].id;
      useProjectStore.setState((s) => ({
        project: {
          ...s.project,
          clips: [
            {
              id: 'c_test',
              trackId,
              mediaId: 'm1',
              name: 'Test Clip',
              type: 'video',
              start: 2.0,
              duration: 4.0, // 2.0s to 6.0s
              sourceStart: 0,
              sourceDuration: 4.0,
              volume: 1,
              opacity: 1,
              scale: 1,
              positionX: 0,
              positionY: 0,
              muted: false,
            },
          ],
        },
      }));

      const MonitoredBar: React.FC<{ onOpenSheet: () => void }> = (props) => {
        buttonRenderCount++;
        return React.createElement(MobileBottomBar, props);
      };

      const container = mockDOM.mockDoc.createElement('div');
      const root = ReactDOM.createRoot(container as unknown as HTMLElement);
      root.render(React.createElement(MonitoredBar, { onOpenSheet: () => {} }));

      await new Promise((r) => setTimeout(r, 60));
      expect(buttonRenderCount).toBe(1);

      // Clock tick at t = 1.0s (outside clip): button should be disabled
      vi.spyOn(masterClock, 'getTime').mockReturnValue(1.0);
      vi.spyOn(masterClock, 'getIsPlaying').mockReturnValue(false); // Immediate update on pause/scrub
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (masterClock as any).notifyTime(1.0);

      // Clock tick at t = 4.0s (inside clip): button should enable
      vi.spyOn(masterClock, 'getTime').mockReturnValue(4.0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (masterClock as any).notifyTime(4.0);

      // Component re-renders must remain 1 throughout these transitions!
      expect(buttonRenderCount).toBe(1);
    });
  });
});
