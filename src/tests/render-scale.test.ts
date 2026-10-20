/**
 * KI-02 — the preview must be rasterised at the resolution of the DISPLAY.
 *
 * The preview canvas used to be hard-wired to the project resolution
 * (1920x1080 = 2 073 600 px) while its CSS box was often 200x110: up to
 * 100x more pixels than the screen could ever show, at 60 fps.
 *
 * The maths lives in `computeRenderScale` (pure, no DOM) so it can be
 * exhaustively unit tested in the node environment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Compositor,
  computeRenderScale,
  MAX_PREVIEW_PIXELS,
} from '../core/engine/Compositor';
import { mediaSourcePool } from '../core/engine/MediaSourcePool';
import type { Clip, MediaItem, Track } from '../types/project';

/** The six viewports of the responsive audit. */
const VIEWPORTS = [
  { label: 'desktop 1440x900', css: [851, 478] },
  { label: 'tablet 768x1024', css: [414, 232] },
  { label: 'mobile 390x844', css: [372, 208] },
  { label: 'mobile-xs 320x568', css: [302, 169] },
  { label: 'landscape 844x390', css: [249, 139] },
  { label: 'landscape-xs 568x320', css: [192, 107] },
] as const;

const LOGICAL = { width: 1920, height: 1080 };

/** Relative aspect error of a backing store against the project aspect. */
function aspectError(width: number, height: number, lw: number, lh: number): number {
  return Math.abs(width / height - lw / lh) / (lw / lh);
}

describe('KI-02 · computeRenderScale', () => {
  it('never renders more pixels than the display can show', () => {
    for (const vp of VIEWPORTS) {
      for (const dpr of [1, 2, 3]) {
        const r = computeRenderScale({
          logicalWidth: LOGICAL.width,
          logicalHeight: LOGICAL.height,
          cssWidth: vp.css[0],
          cssHeight: vp.css[1],
          devicePixelRatio: dpr,
        });
        // The backing store is the size of the display, never more.
        expect(r.width).toBeLessThanOrEqual(Math.ceil(vp.css[0] * dpr) + 1);
        expect(r.height).toBeLessThanOrEqual(Math.ceil(vp.css[1] * dpr) + 1);
        // And never above the project resolution.
        expect(r.width).toBeLessThanOrEqual(LOGICAL.width);
        expect(r.height).toBeLessThanOrEqual(LOGICAL.height);
        expect(r.scale).toBeLessThanOrEqual(1);
      }
    }
  });

  it('drops the mobile fill rate by an order of magnitude (the KI-02 budget)', () => {
    const mobile = computeRenderScale({
      logicalWidth: LOGICAL.width,
      logicalHeight: LOGICAL.height,
      cssWidth: 372,
      cssHeight: 208,
      devicePixelRatio: 3,
    });
    // Was 2 073 600 px (the whole project) for a 372x208 box.
    expect(mobile.pixels).toBeLessThanOrEqual(1_300_000);
    expect(mobile.pixels).toBeLessThan(1_073_600);
    // The waste against the DISPLAY pixels is 1: the preview is exactly the
    // size of what the screen shows.
    expect(mobile.pixels).toBeLessThanOrEqual(372 * 3 * (208 * 3) + 4096);

    const mobileXs = computeRenderScale({
      logicalWidth: LOGICAL.width,
      logicalHeight: LOGICAL.height,
      cssWidth: 302,
      cssHeight: 169,
      devicePixelRatio: 2,
    });
    expect(mobileXs.pixels).toBeLessThanOrEqual(500_000);
    expect(mobileXs.pixels).toBeLessThan(600_000);
  });

  it('is crisp on HiDPI: the backing store matches CSS size x DPR', () => {
    const r = computeRenderScale({
      logicalWidth: LOGICAL.width,
      logicalHeight: LOGICAL.height,
      cssWidth: 851,
      cssHeight: 478,
      devicePixelRatio: 2,
    });
    // 851 x 478 CSS -> 1702 x 956 device px (2 px less because the backing
    // store is forced to even numbers).
    expect(r.width).toBe(1700);
    expect(r.height).toBe(956);
    expect(r.deviceWidth).toBe(1702);
    expect(r.deviceHeight).toBe(956);
  });

  it('covers the painted box on small boxes (LAYOUT-320x568@1-crisp regression)', () => {
    // Real browser failure: backing 204x114 vs a 206.1x115.2 painted box
    // (object-fit: contain, DPR 1) = 23256 px vs 23737 px, margin -0.0202.
    // Rounding both axes DOWN to even under-sampled the preview by ~2 %.
    //
    // Intent (unchanged): the backing store covers the painted box. Exact
    // rounding (changed, see computeRenderScale step 4): each axis snaps to
    // the even neighbour that covers, so 204.8x115.2 raw becomes 206x116,
    // not 204x114. Every candidate stays even (H.264): only the direction of
    // the snap changed, and this test fails on the old rounding.
    const cssWidth = 206.1;
    const cssHeight = 115.2;
    const r = computeRenderScale({
      logicalWidth: LOGICAL.width,
      logicalHeight: LOGICAL.height,
      cssWidth,
      cssHeight,
      devicePixelRatio: 1,
    });
    expect(r.width).toBe(206);
    expect(r.height).toBe(116);
    expect(r.width % 2).toBe(0);
    expect(r.height % 2).toBe(0);
    // The browser check, verbatim: backing >= painted * dpr * 0.98.
    const s = Math.min(cssWidth / r.width, cssHeight / r.height);
    const paintedDevicePixels = r.width * s * (r.height * s) * 1;
    expect(r.pixels).toBeGreaterThanOrEqual(paintedDevicePixels * 0.98);
    expect(aspectError(r.width, r.height, LOGICAL.width, LOGICAL.height)).toBeLessThan(0.01);
  });

  it('keeps the aspect tolerance where snapping up would stretch it (568x320@1)', () => {
    // Counter-case to the crisp fix: snapping UP is not always right either.
    // Raw 190.2x107.0 snapped to the mixed pair 190x108 is 1.04 % off the
    // project aspect (over the 1 % tolerance), so the winner must satisfy
    // BOTH contracts at once: cover the painted box AND keep the aspect.
    // This passes on the old rounding (190x106) and on the fixed one
    // (192x108, exact aspect): it only pins the dual contract, not exact dims.
    const cssWidth = 192;
    const cssHeight = 107;
    const r = computeRenderScale({
      logicalWidth: LOGICAL.width,
      logicalHeight: LOGICAL.height,
      cssWidth,
      cssHeight,
      devicePixelRatio: 1,
    });
    expect(r.width % 2).toBe(0);
    expect(r.height % 2).toBe(0);
    expect(aspectError(r.width, r.height, LOGICAL.width, LOGICAL.height)).toBeLessThan(0.01);
    const s = Math.min(cssWidth / r.width, cssHeight / r.height);
    const paintedDevicePixels = r.width * s * (r.height * s) * 1;
    expect(r.pixels).toBeGreaterThanOrEqual(paintedDevicePixels * 0.98);
  });

  it('never exceeds the project resolution (a 4K project in a small box)', () => {
    const r = computeRenderScale({
      logicalWidth: 3840,
      logicalHeight: 2160,
      cssWidth: 372,
      cssHeight: 208,
      devicePixelRatio: 3,
    });
    expect(r.width).toBeLessThanOrEqual(3840);
    expect(r.height).toBeLessThanOrEqual(2160);
    expect(r.pixels).toBeLessThanOrEqual(1_300_000);
  });

  it('never exceeds the project resolution, not even on a huge display', () => {
    const r = computeRenderScale({
      logicalWidth: LOGICAL.width,
      logicalHeight: LOGICAL.height,
      cssWidth: 3840,
      cssHeight: 2160,
      devicePixelRatio: 2,
      maxPixels: 1_000_000,
    });
    // The project resolution is the hard limit (the preview is never rendered
    // above it, whatever the display shows).
    expect(r.width).toBeLessThanOrEqual(LOGICAL.width);
    expect(r.height).toBeLessThanOrEqual(LOGICAL.height);
    expect(r.scale).toBeLessThanOrEqual(1);
    expect(r.pixels).toBeLessThanOrEqual(LOGICAL.width * LOGICAL.height);
  });

  it('keeps the pixel ceiling from blurring a HiDPI preview', () => {
    // The ceiling is a safety net for pathological cases, it must not force
    // the preview below the resolution the display needs.
    const r = computeRenderScale({
      logicalWidth: LOGICAL.width,
      logicalHeight: LOGICAL.height,
      cssWidth: 851,
      cssHeight: 478,
      devicePixelRatio: 2,
      maxPixels: 1_300_000,
    });
    expect(r.width * r.height).toBeGreaterThan(851 * 2 * 478 * 2 * 0.95);
  });

  it('always produces even dimensions', () => {
    const sizes = [1, 2, 3, 7, 13, 101, 333, 851, 1920, 1921];
    for (const lw of sizes) {
      for (const lh of sizes) {
        for (const dpr of [1, 2, 3]) {
          const r = computeRenderScale({
            logicalWidth: lw,
            logicalHeight: lh,
            cssWidth: 137,
            cssHeight: 91,
            devicePixelRatio: dpr,
          });
          expect(r.width % 2).toBe(0);
          expect(r.height % 2).toBe(0);
          expect(r.width).toBeGreaterThanOrEqual(2);
          expect(r.height).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it('preserves the project aspect ratio (the preview is never stretched)', () => {
    for (const vp of VIEWPORTS) {
      for (const dpr of [1, 2, 3]) {
        const r = computeRenderScale({
          logicalWidth: LOGICAL.width,
          logicalHeight: LOGICAL.height,
          cssWidth: vp.css[0],
          cssHeight: vp.css[1],
          devicePixelRatio: dpr,
        });
        // < 1 % of error: the even rounding of the height is the only source.
        expect(aspectError(r.width, r.height, LOGICAL.width, LOGICAL.height)).toBeLessThan(0.01);
      }
    }
  });

  it('preserves the aspect ratio of exotic project resolutions', () => {
    const logicals = [
      [1920, 1080],
      [1080, 1920],
      [1080, 1080],
      [3840, 2160],
      [720, 1280],
      [1333, 999],
    ];
    for (const [lw, lh] of logicals) {
      for (const dpr of [1, 2, 3]) {
        const r = computeRenderScale({
          logicalWidth: lw,
          logicalHeight: lh,
          cssWidth: 640,
          cssHeight: 360,
          devicePixelRatio: dpr,
        });
        expect(aspectError(r.width, r.height, lw, lh)).toBeLessThan(0.02);
      }
    }
  });

  it('falls back to a safe size when the layout is not known yet', () => {
    const r = computeRenderScale({
      logicalWidth: LOGICAL.width,
      logicalHeight: LOGICAL.height,
      cssWidth: 0,
      cssHeight: 0,
      devicePixelRatio: 1,
    });
    // No layout yet: the preview stays inside the pixel budget and inside
    // the project resolution (it is re-fitted as soon as the box is known).
    expect(r.width).toBeLessThanOrEqual(LOGICAL.width);
    expect(r.height).toBeLessThanOrEqual(LOGICAL.height);
    expect(r.pixels).toBeLessThanOrEqual(MAX_PREVIEW_PIXELS);
    expect(r.scale).toBeGreaterThan(0);
    expect(r.scale).toBeLessThanOrEqual(1);
  });

  it('survives hostile input (NaN, Infinity, zero, negative)', () => {
    const r = computeRenderScale({
      logicalWidth: Number.NaN,
      logicalHeight: Number.POSITIVE_INFINITY,
      cssWidth: -10,
      cssHeight: Number.NaN,
      devicePixelRatio: 0,
    });
    expect(Number.isFinite(r.width)).toBe(true);
    expect(Number.isFinite(r.height)).toBe(true);
    expect(r.width).toBeGreaterThanOrEqual(2);
    expect(r.height).toBeGreaterThanOrEqual(2);
    expect(r.scale).toBeGreaterThan(0);
  });

  it('exposes the default pixel ceiling', () => {
    expect(MAX_PREVIEW_PIXELS).toBe(1_300_000);
  });
});

/* ------------------------------------------------------------------ */
/* The compositor must keep the composition in the PROJECT space.       */
/* ------------------------------------------------------------------ */

const track: Track = {
  id: 't1',
  name: 'Video 1',
  type: 'video',
  isMuted: false,
  isLocked: false,
  isVisible: true,
};

const clip: Clip = {
  id: 'c1',
  trackId: 't1',
  mediaId: 'm1',
  name: 'Clip',
  type: 'image',
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
};

const media: MediaItem = {
  id: 'm1',
  name: 'M',
  type: 'image',
  url: 'blob:1',
  duration: 5,
  width: 1920,
  height: 1080,
  fps: 30,
  thumbnailUrl: '',
  size: 1,
  createdAt: 0,
};

function makeContext() {
  return {
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
    translate: vi.fn(),
    scale: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    strokeText: vi.fn(),
    fillText: vi.fn(),
  };
}

describe('KI-02 · Compositor renders the project space into a scaled context', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // The node environment has no `Image`: the media pool must not try to
    // create one (the drawing itself is mocked in these tests).
    vi.spyOn(mediaSourcePool, 'getImageElement').mockReturnValue({
      complete: true,
      naturalWidth: 1920,
      naturalHeight: 1080,
    } as unknown as HTMLImageElement);
  });

  it('scales the context and lays the media out in the LOGICAL space', () => {
    const compositor = new Compositor();
    const ctx = makeContext();
    const canvas = {
      width: 850,
      height: 478,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;

    const drawSpy = vi.spyOn(compositor as any, 'drawMediaToCanvas').mockReturnValue(true);

    compositor.renderFrame({
      time: 0,
      canvas,
      tracks: [track],
      clips: [clip],
      mediaPool: [media],
      isPlaying: false,
      logicalWidth: LOGICAL.width,
      logicalHeight: LOGICAL.height,
      renderScale: 850 / LOGICAL.width,
    });

    // The context is scaled once per frame.
    expect(ctx.setTransform).toHaveBeenCalledWith(850 / LOGICAL.width, 0, 0, 850 / LOGICAL.width, 0, 0);
    // The layout maths happens in the PROJECT space, not in the backing store.
    expect(drawSpy).toHaveBeenCalled();
    const args = drawSpy.mock.calls[0] as unknown[];
    expect(args[3]).toBe(LOGICAL.width);
    expect(args[4]).toBe(LOGICAL.height);
  });

  it('clears the WHOLE backing store (not only the logical area)', () => {
    const compositor = new Compositor();
    const ctx = makeContext();
    const canvas = {
      width: 850,
      height: 478,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;

    compositor.renderFrame({
      time: 0,
      canvas,
      tracks: [],
      clips: [],
      mediaPool: [],
      isPlaying: false,
      logicalWidth: LOGICAL.width,
      logicalHeight: LOGICAL.height,
      renderScale: 850 / LOGICAL.width,
    });

    const fillCalls = ctx.fillRect.mock.calls as unknown[][];
    expect(fillCalls.length).toBeGreaterThan(0);
    // The clear rectangle covers the backing store, in device pixels.
    expect(fillCalls[0][2]).toBe(850);
    expect(fillCalls[0][3]).toBe(478);
  });

  it('keeps the legacy behaviour when no logical size is given (export path)', () => {
    const compositor = new Compositor();
    const ctx = makeContext();
    const canvas = {
      width: 1920,
      height: 1080,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;

    const drawSpy = vi.spyOn(compositor as any, 'drawMediaToCanvas').mockReturnValue(true);

    compositor.renderFrame({
      time: 0,
      canvas,
      tracks: [track],
      clips: [clip],
      mediaPool: [media],
      isPlaying: false,
    });

    // The exporter renders at the export resolution: the logical space IS the
    // canvas and the scale is 1.
    expect(ctx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    const args = drawSpy.mock.calls[0] as unknown[];
    expect(args[3]).toBe(1920);
    expect(args[4]).toBe(1080);
  });

  it('re-renders when the backing store changes (resize of the display)', () => {
    const compositor = new Compositor();
    const ctx = makeContext();
    const canvas = {
      width: 850,
      height: 478,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;

    const options = {
      time: 1,
      canvas,
      tracks: [track],
      clips: [clip],
      mediaPool: [media],
      isPlaying: false,
      logicalWidth: LOGICAL.width,
      logicalHeight: LOGICAL.height,
      renderScale: 850 / LOGICAL.width,
    };

    compositor.renderFrame(options);
    const callsAfterFirst = ctx.fillRect.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Same time, same clips: the dirty check skips the frame.
    compositor.renderFrame(options);
    expect(ctx.fillRect.mock.calls.length).toBe(callsAfterFirst);

    // The display was resized: the backing store changed -> the frame is
    // painted again.
    (canvas as unknown as { width: number }).width = 400;
    (canvas as unknown as { height: number }).height = 225;
    compositor.renderFrame({ ...options, renderScale: 400 / LOGICAL.width });
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
