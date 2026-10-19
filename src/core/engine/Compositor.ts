import { Clip, MediaItem, Track } from '../../types/project';
import { mediaSourcePool } from './MediaSourcePool';

export interface RenderOptions {
  time: number;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  tracks: Track[];
  clips: Clip[];
  mediaPool: MediaItem[];
  isPlaying: boolean;
  /**
   * Logical width of the composition (the PROJECT resolution).
   *
   * Every layout computation (positions, sizes, `drawImage` destination
   * rects, `measureText` baselines, transitions) happens in this space, so the
   * composition is identical no matter how big the backing store of the
   * canvas is. Defaults to `canvas.width` (legacy behaviour: the canvas *is*
   * the project resolution).
   */
  logicalWidth?: number;
  /**
   * Logical height of the composition (the PROJECT resolution).
   * Defaults to `canvas.height`.
   */
  logicalHeight?: number;
  /**
   * Uniform scale applied to the logical space.
   *
   * The compositor applies it once per frame with
   * `ctx.setTransform(scale, 0, 0, scale, 0, 0)`, so the project-space maths
   * keeps working unchanged while the rasterisation happens at the resolution
   * of the display. Defaults to `canvas.width / logicalWidth`.
   */
  renderScale?: number;
}

/**
 * Hard ceiling for the number of pixels the PREVIEW may rasterise.
 *
 * The preview used to always allocate a canvas as big as the project
 * (1920x1080 = 2 073 600 px) even when the canvas was displayed inside a
 * 200x110 box: 100x more pixels than the display could ever show, at 60 fps
 * (KI-02). The preview now renders at the size of the display; this ceiling
 * only protects the pathological cases (a 4K project shown full screen).
 */
export const MAX_PREVIEW_PIXELS = 1_300_000;

export interface RenderScaleInput {
  /** Project width in pixels (the logical space). */
  logicalWidth: number;
  /** Project height in pixels (the logical space). */
  logicalHeight: number;
  /** CSS width of the canvas box (device independent pixels). */
  cssWidth: number;
  /** CSS height of the canvas box (device independent pixels). */
  cssHeight: number;
  /** `window.devicePixelRatio` of the display. */
  devicePixelRatio: number;
  /** Maximum number of pixels the backing store may use. */
  maxPixels?: number;
}

export interface RenderScaleResult {
  /** Uniform scale applied to the logical space. Always <= 1. */
  scale: number;
  /** Width of the backing store (always even). */
  width: number;
  /** Height of the backing store (always even). */
  height: number;
  /** `width * height` — the number of pixels actually rasterised. */
  pixels: number;
  /** Device pixels the display shows (`cssWidth * devicePixelRatio`). */
  deviceWidth: number;
  /** Device pixels the display shows (`cssHeight * devicePixelRatio`). */
  deviceHeight: number;
  /**
   * `pixels / (cssWidth * cssHeight)` — how many times more pixels are
   * rasterised than the CSS box has. 1 = exactly the pixels of the display
   * (at DPR 1), DPR = the pixels of the display at that DPR.
   */
  wasteFactor: number;
}

/** Clamps a number into `[min, max]`, tolerating NaN / Infinity. */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Computes the backing store of the preview canvas.
 *
 * The formula (all the maths is pure, so it is unit tested):
 *
 *   1. `scale = min(cssWidth * dpr / logicalWidth, cssHeight * dpr / logicalHeight)`
 *      → the backing store matches the DISPLAY (device pixels), so the preview
 *        is crisp on HiDPI screens and never renders more pixels than the
 *        display can show.
 *   2. `scale = min(scale, 1)`
 *      → the preview is NEVER rendered above the project resolution (a 4K
 *        project shown in a small box is downscaled, not upscaled).
 *   3. `scale = min(scale, sqrt(pixelBudget / (logicalWidth * logicalHeight)))`
 *      with `pixelBudget = max(maxPixels, min(devicePixels, projectPixels))`
 *      → the absolute pixel ceiling is enforced, but it never forces the
 *        preview below the resolution the display actually needs (that would
 *        blur a HiDPI preview) and never above the project resolution.
 *   4. The backing store is `round(logical * scale)`, rounded DOWN to an even
 *      number (H.264 friendly), keeping the project aspect ratio.
 */
export function computeRenderScale(input: RenderScaleInput): RenderScaleResult {
  const logicalWidth = Math.max(1, Math.round(clampNumber(input.logicalWidth, 1, 1e6, 1920)));
  const logicalHeight = Math.max(1, Math.round(clampNumber(input.logicalHeight, 1, 1e6, 1080)));
  const dpr = clampNumber(input.devicePixelRatio, 0.1, 8, 1);
  const cssWidth = Math.max(0, clampNumber(input.cssWidth, 0, 1e6, 0));
  const cssHeight = Math.max(0, clampNumber(input.cssHeight, 0, 1e6, 0));
  const maxPixels = Math.max(1, clampNumber(input.maxPixels ?? MAX_PREVIEW_PIXELS, 1, 1e9, MAX_PREVIEW_PIXELS));

  const deviceWidth = cssWidth * dpr;
  const deviceHeight = cssHeight * dpr;

  // 1. The scale that matches the display (device pixels).
  let scale: number;
  if (deviceWidth > 0 && deviceHeight > 0) {
    scale = Math.min(deviceWidth / logicalWidth, deviceHeight / logicalHeight);
  } else {
    // No layout information yet: keep the project resolution.
    scale = 1;
  }

  // 2. Never render above the project resolution.
  scale = Math.min(scale, 1);

  // 3. Absolute pixel ceiling (never below what the display needs).
  const projectPixels = logicalWidth * logicalHeight;
  const neededPixels = Math.min(deviceWidth * deviceHeight, projectPixels);
  const pixelBudget = Math.max(maxPixels, neededPixels);
  scale = Math.min(scale, Math.sqrt(pixelBudget / projectPixels));

  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  // 4. Backing store: even numbers, project aspect ratio preserved.
  let width = Math.max(2, Math.round(logicalWidth * scale));
  let height = Math.max(2, Math.round(logicalHeight * scale));
  if (width % 2 !== 0) width -= 1;
  if (height % 2 !== 0) height -= 1;
  if (width < 2) width = 2;
  if (height < 2) height = 2;

  const pixels = width * height;
  const cssPixels = cssWidth * cssHeight;

  return {
    scale,
    width,
    height,
    pixels,
    deviceWidth,
    deviceHeight,
    wasteFactor: cssPixels > 0 ? pixels / cssPixels : 0,
  };
}

export interface TransitionParams {
  alphaMultiplier: number;
  offsetX: number;
  wipeWidth: number | null;
  overlayColor: string | null;
  overlayOpacity: number;
}

/**
 * Calculates transition parameters (fades, slides, wipes) for a given clip at time `time`.
 */
export function calculateTransition(clip: Clip, time: number, canvasWidth: number): TransitionParams {
  let alphaMultiplier = 1;
  let offsetX = 0;
  let wipeWidth: number | null = null;
  let overlayColor: string | null = null;
  let overlayOpacity = 0;

  if (clip.transition) {
    const { fadeInType, fadeInDuration, fadeOutType, fadeOutDuration } = clip.transition;
    const timeInClip = time - clip.start;
    const timeLeft = clip.start + clip.duration - time;

    // 1. Fade In / Transition In
    if (fadeInDuration > 0 && timeInClip >= 0 && timeInClip < fadeInDuration) {
      const progressIn = Math.max(0, Math.min(1, timeInClip / fadeInDuration));

      if (fadeInType === 'fade-black') {
        // Symmetric with 'fade-white': the transition is an overlay only.
        // Multiplying the alpha AND overlaying black would darken the clip twice
        // (0.25*C + 0.75*B at 50% instead of 0.5*C + 0.5*B) (E-06).
        overlayColor = '#000000';
        overlayOpacity = Math.max(overlayOpacity, 1 - progressIn);
      } else if (fadeInType === 'fade-white') {
        overlayColor = '#ffffff';
        overlayOpacity = Math.max(overlayOpacity, 1 - progressIn);
      } else if (fadeInType === 'slide-left') {
        offsetX += canvasWidth * (1 - progressIn);
      } else if (fadeInType === 'wipe-right') {
        wipeWidth = canvasWidth * progressIn;
      }
    }

    // 2. Fade Out / Transition Out
    if (fadeOutDuration > 0 && timeLeft >= 0 && timeLeft < fadeOutDuration) {
      const progressOut = Math.max(0, Math.min(1, timeLeft / fadeOutDuration));

      if (fadeOutType === 'fade-black') {
        // Symmetric with 'fade-white' (see the fade in branch) (E-06).
        overlayColor = '#000000';
        overlayOpacity = Math.max(overlayOpacity, 1 - progressOut);
      } else if (fadeOutType === 'fade-white') {
        overlayColor = '#ffffff';
        overlayOpacity = Math.max(overlayOpacity, 1 - progressOut);
      } else if (fadeOutType === 'slide-left') {
        offsetX -= canvasWidth * (1 - progressOut);
      } else if (fadeOutType === 'wipe-right') {
        const outWipe = canvasWidth * progressOut;
        wipeWidth = wipeWidth !== null ? Math.min(wipeWidth, outWipe) : outWipe;
      }
    }
  }

  return { alphaMultiplier, offsetX, wipeWidth, overlayColor, overlayOpacity };
}

export class Compositor {
  private lastCompositedCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private lastCompositedTime = 0;
  // Reused collections (zero per-frame heap allocations)
  private mediaMap: Map<string, MediaItem> = new Map();
  private trackMap: Map<string, Track> = new Map();
  private activeVideoKeys: Set<string> = new Set();
  private prewarmKeys: Set<string> = new Set();

  // Dirty-checking state
  private lastRenderedTime = -1;
  private lastRenderedCanvasRef: HTMLCanvasElement | OffscreenCanvas | null = null;
  private lastRenderedWidth = 0;
  private lastRenderedHeight = 0;
  private lastRenderedLogicalWidth = 0;
  private lastRenderedLogicalHeight = 0;
  private lastRenderedScale = 0;
  private lastRenderedTracksRef: Track[] | null = null;
  private lastRenderedClipsRef: Clip[] | null = null;
  private lastWasPlaying = false;
  private isCanvasBlankBlack = false;
  private lastHadUnreadyVideo = false;

  /**
   * Drops every cached frame and invalidates the dirty-check state.
   * MUST be called when the project is replaced, otherwise the anti-flicker
   * bridge paints the last frame of the previous project (C1).
   */
  public clear(): void {
    this.lastCompositedCanvas = null;
    this.lastCompositedTime = 0;
    this.lastRenderedTime = -1;
    this.lastRenderedCanvasRef = null;
    this.lastRenderedWidth = 0;
    this.lastRenderedHeight = 0;
    this.lastRenderedLogicalWidth = 0;
    this.lastRenderedLogicalHeight = 0;
    this.lastRenderedScale = 0;
    this.lastRenderedTracksRef = null;
    this.lastRenderedClipsRef = null;
    this.lastWasPlaying = false;
    this.isCanvasBlankBlack = false;
    this.lastHadUnreadyVideo = false;
    this.activeVideoKeys.clear();
    this.prewarmKeys.clear();
  }

  /**
   * `true` when the 2D context supports the full transform API.
   *
   * The unit tests use fake contexts that only implement a subset of the API,
   * so every transform related call has to be feature detected.
   */
  private static supportsTransform(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  ): boolean {
    return (
      typeof (ctx as CanvasRenderingContext2D).setTransform === 'function' &&
      typeof (ctx as CanvasRenderingContext2D).save === 'function' &&
      typeof (ctx as CanvasRenderingContext2D).restore === 'function'
    );
  }

  /**
   * Fills the WHOLE backing store with the background colour.
   *
   * The clear rectangle is expressed in DEVICE pixels (not in the logical
   * space): with a scaled context a logical sized rectangle would leave an
   * uncleared strip on the right/bottom edge of the canvas.
   */
  private clearDevice(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    deviceWidth: number,
    deviceHeight: number
  ): void {
    const transformed = Compositor.supportsTransform(ctx);
    if (transformed) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.fillStyle = '#0a0a0c';
    ctx.fillRect(0, 0, deviceWidth, deviceHeight);
    if (transformed) ctx.restore();
  }

  /**
   * Paints the cached frame over the whole backing store (1:1, device pixels).
   */
  private blitCache(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    deviceWidth: number,
    deviceHeight: number
  ): void {
    const transformed = Compositor.supportsTransform(ctx);
    if (transformed) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.drawImage(this.lastCompositedCanvas as CanvasImageSource, 0, 0, deviceWidth, deviceHeight);
    if (transformed) ctx.restore();
  }

  /**
   * Renders a frame at timeline time `time` onto the target canvas.
   *
   * The composition always happens in the LOGICAL space (the project
   * resolution); the canvas is only the raster target. `logicalWidth` /
   * `logicalHeight` / `renderScale` describe how the logical space maps onto
   * the backing store of the canvas (KI-02: the preview is rasterised at the
   * resolution of the display, not at the project resolution).
   */
  public renderFrame(options: RenderOptions): void {
    const { time, canvas, tracks, clips, mediaPool, isPlaying } = options;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return;

    // Device pixels: the real size of the backing store of the canvas.
    const deviceWidth = canvas.width;
    const deviceHeight = canvas.height;

    // Logical pixels: the project space every layout computation happens in.
    const logicalWidth = Math.max(1, Math.round(options.logicalWidth ?? deviceWidth));
    const logicalHeight = Math.max(1, Math.round(options.logicalHeight ?? deviceHeight));
    const width = logicalWidth;
    const height = logicalHeight;

    // Scale the context once per frame: the project space maths below keeps
    // working unchanged while the rasterisation happens at the resolution of
    // the display.
    const canTransform = Compositor.supportsTransform(ctx);
    let renderScale = options.renderScale ?? (deviceWidth / logicalWidth);
    if (!Number.isFinite(renderScale) || renderScale <= 0) renderScale = 1;
    if (canTransform) {
      ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    } else {
      renderScale = 1;
    }

    // Populate persistent lookup maps without allocating new heap instances
    this.mediaMap.clear();
    for (let i = 0; i < mediaPool.length; i++) {
      const m = mediaPool[i];
      this.mediaMap.set(m.id, m);
    }

    this.trackMap.clear();
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      this.trackMap.set(t.id, t);
    }

    this.activeVideoKeys.clear();

    // Single-pass visual readiness & active clip pre-check
    let hasActiveVisualClip = false;
    let hasActiveTextClip = false;
    let hasUnreadyVideo = false;

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      if (clip.opacity <= 0) continue;
      if (time < clip.start || time >= clip.start + clip.duration) continue;

      const track = this.trackMap.get(clip.trackId);
      if (!track || !track.isVisible) continue;

      // The pre-check MUST agree with the draw pass (E-07): a clip whose media
      // type does not match its track type is not renderable at all. Counting it
      // as an active visual clip made the anti-flicker cache paint a stale frame
      // instead of black.
      if (track.type === 'video') {
        if (clip.type !== 'video' && clip.type !== 'image') continue;
        const media = this.mediaMap.get(clip.mediaId);
        if (!media) continue;
        hasActiveVisualClip = true;
        if (clip.type === 'video') {
          const videoEl = mediaSourcePool.getVideoElement(media, clip.id, clip.sourceStart);
          // The very same source time the draw pass will ask for, so the
          // "is the frame ready" decision and the draw pass always agree.
          const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
          const rawOffset = clip.sourceStart + (time - clip.start) * speed;
          const maxSourceTime = Math.max(0, (media.duration || 1000) - 0.05);
          const clampedOffset = Math.max(0, Math.min(maxSourceTime, rawOffset));
          if (
            videoEl.readyState < 2 &&
            !mediaSourcePool.getLastFrame(clip.id) &&
            !mediaSourcePool.getLastFrameForSource(media.id, clampedOffset)
          ) {
            hasUnreadyVideo = true;
          }
        }
      } else if (track.type === 'text') {
        if (clip.type !== 'text') continue;
        hasActiveTextClip = true;
      }
      // Audio tracks never render visuals.
    }

    // Dirty check: skip rendering if paused and frame parameters are identical
    const canvasUnchanged = canvas === this.lastRenderedCanvasRef;
    const sizeUnchanged = deviceWidth === this.lastRenderedWidth && deviceHeight === this.lastRenderedHeight;
    const logicalUnchanged =
      logicalWidth === this.lastRenderedLogicalWidth && logicalHeight === this.lastRenderedLogicalHeight;
    const scaleUnchanged = renderScale === this.lastRenderedScale;
    const tracksUnchanged = tracks === this.lastRenderedTracksRef;
    const clipsUnchanged = clips === this.lastRenderedClipsRef;
    const isSameTime = Math.abs(time - this.lastRenderedTime) < 0.0001;

    if (
      !isPlaying &&
      !this.lastWasPlaying &&
      canvasUnchanged &&
      sizeUnchanged &&
      logicalUnchanged &&
      scaleUnchanged &&
      tracksUnchanged &&
      clipsUnchanged &&
      isSameTime &&
      !this.lastHadUnreadyVideo &&
      !hasUnreadyVideo
    ) {
      return;
    }

    // Canvas Background Management:
    // If an active video is still decoding (readyState < 2 and no cached frame),
    // AVOID clearing with black #0a0a0c to eliminate black flashes!
    // Instead bridge with lastCompositedCanvas if available.
    if (hasActiveVisualClip && hasUnreadyVideo && this.lastCompositedCanvas) {
      try {
        this.blitCache(ctx, deviceWidth, deviceHeight);
      } catch {
        this.clearDevice(ctx, deviceWidth, deviceHeight);
      }
      this.isCanvasBlankBlack = false;
    } else if (!hasActiveVisualClip && !hasActiveTextClip) {
      // In empty gap: only fillRect if not already blank black or dimensions changed
      if (!this.isCanvasBlankBlack || !sizeUnchanged || !canvasUnchanged) {
        this.clearDevice(ctx, deviceWidth, deviceHeight);
        this.isCanvasBlankBlack = true;
      }
      this.lastCompositedCanvas = null;
    } else {
      // Normal clear
      this.clearDevice(ctx, deviceWidth, deviceHeight);
      this.isCanvasBlankBlack = false;
    }

    let hasDrawnVisualFrame = false;

    // Pass 1: Video tracks rendered bottom-to-top (painters algorithm: V1 background first, V2 overlay on top)
    for (let i = tracks.length - 1; i >= 0; i--) {
      const track = tracks[i];
      if (track.type !== 'video' || !track.isVisible) continue;

      for (let j = 0; j < clips.length; j++) {
        const clip = clips[j];
        if (clip.trackId !== track.id) continue;
        if (time < clip.start || time >= clip.start + clip.duration) continue;
        if (clip.opacity <= 0) continue;

        if (clip.type === 'video' || clip.type === 'image') {
          const media = this.mediaMap.get(clip.mediaId);
          if (!media) continue;

          if (clip.type === 'video') {
            const videoEl = mediaSourcePool.getVideoElement(media, clip.id, clip.sourceStart);
            this.activeVideoKeys.add(`${media.id}_${clip.id}`);
            const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
            const sourceOffset = clip.sourceStart + (time - clip.start) * speed;
            const maxSourceTime = Math.max(0, (media.duration || 1000) - 0.05);
            const clampedOffset = Math.max(0, Math.min(maxSourceTime, sourceOffset));
            mediaSourcePool.syncVideoTime(videoEl, clampedOffset, isPlaying, speed);

            const drawn = this.drawMediaToCanvas(
              ctx,
              videoEl,
              clip,
              width,
              height,
              media.width || 1280,
              media.height || 720,
              time,
              media,
              isPlaying,
              clampedOffset
            );
            if (drawn !== false) {
              hasDrawnVisualFrame = true;
            }
          } else if (clip.type === 'image') {
            const imgEl = mediaSourcePool.getImageElement(media, clip.id);
            const drawn = this.drawMediaToCanvas(
              ctx,
              imgEl,
              clip,
              width,
              height,
              media.width || 1280,
              media.height || 720,
              time,
              media,
              isPlaying
            );
            if (drawn !== false) {
              hasDrawnVisualFrame = true;
            }
          }
        }
      }
    }

    // Pass 2: Text tracks rendered in reverse order (T1, T2 overlays on top of video)
    for (let i = tracks.length - 1; i >= 0; i--) {
      const track = tracks[i];
      if (track.type !== 'text' || !track.isVisible) continue;

      for (let j = 0; j < clips.length; j++) {
        const clip = clips[j];
        if (clip.trackId !== track.id) continue;
        if (time < clip.start || time >= clip.start + clip.duration) continue;
        if (clip.opacity <= 0) continue;

        if (clip.type === 'text') {
          this.drawTextToCanvas(ctx, clip, width, height, time);
        }
      }
    }

    // Pause inactive video elements and prewarm upcoming ones
    if (isPlaying) {
      this.prewarmKeys.clear();
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        if (c.type === 'video' && c.start > time && c.start <= time + 2.5) {
          this.prewarmKeys.add(`${c.mediaId}_${c.id}`);
        }
      }
      mediaSourcePool.pauseInactiveVideos(this.activeVideoKeys, this.prewarmKeys);
    }

    // Anti-flicker protection and full-buffer snapshot throttling (500ms during continuous playback)
    if (hasActiveVisualClip && !hasDrawnVisualFrame && this.lastCompositedCanvas) {
      try {
        this.blitCache(ctx, deviceWidth, deviceHeight);
      } catch {
        // Ignored
      }
    } else if (hasDrawnVisualFrame) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      // Throttle copying to lastCompositedCanvas to at most 500ms intervals during continuous playback
      // to eliminate 8.3MB full-canvas texture copying at 60 FPS, while taking immediate snapshots when paused.
      const throttleInterval = isPlaying ? 500 : 0;
      if (now - this.lastCompositedTime >= throttleInterval) {
        this.lastCompositedTime = now;
        if (!this.lastCompositedCanvas) {
          if (typeof OffscreenCanvas !== 'undefined') {
            this.lastCompositedCanvas = new OffscreenCanvas(deviceWidth, deviceHeight);
          } else if (typeof document !== 'undefined') {
            const c = document.createElement('canvas');
            c.width = deviceWidth;
            c.height = deviceHeight;
            this.lastCompositedCanvas = c;
          }
        } else if (this.lastCompositedCanvas.width !== deviceWidth || this.lastCompositedCanvas.height !== deviceHeight) {
          this.lastCompositedCanvas.width = deviceWidth;
          this.lastCompositedCanvas.height = deviceHeight;
        }
        if (this.lastCompositedCanvas) {
          try {
            const bCtx = this.lastCompositedCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
            if (bCtx) {
              // 1:1 copy of the DEVICE pixels (the cache lives in the same
              // resolution as the canvas it mirrors).
              bCtx.drawImage(canvas, 0, 0, deviceWidth, deviceHeight);
            }
          } catch {
            // Ignored
          }
        }
      }
    } else if (!hasActiveVisualClip) {
      this.lastCompositedCanvas = null;
    }

    // Update dirty-checking cache
    this.lastRenderedTime = time;
    this.lastRenderedCanvasRef = canvas;
    this.lastRenderedWidth = deviceWidth;
    this.lastRenderedHeight = deviceHeight;
    this.lastRenderedLogicalWidth = logicalWidth;
    this.lastRenderedLogicalHeight = logicalHeight;
    this.lastRenderedScale = renderScale;
    this.lastRenderedTracksRef = tracks;
    this.lastRenderedClipsRef = clips;
    this.lastWasPlaying = isPlaying;
    this.lastHadUnreadyVideo = hasUnreadyVideo;
  }

  /**
   * Draws a media element (video or image) with aspect ratio fit, scale, position, opacity and transitions.
   */
  private drawMediaToCanvas(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    mediaElement: CanvasImageSource,
    clip: Clip,
    canvasWidth: number,
    canvasHeight: number,
    sourceWidth: number,
    sourceHeight: number,
    time: number = 0,
    media?: MediaItem,
    isPlaying: boolean = false,
    sourceTime?: number
  ): boolean {
    const transition = calculateTransition(clip, time, canvasWidth);

    ctx.save();

    if (transition.wipeWidth !== null) {
      ctx.beginPath();
      ctx.rect(0, 0, Math.max(0, transition.wipeWidth), canvasHeight);
      ctx.clip();
    }

    // Opacity factoring in transition fade
    const baseAlpha = Math.max(0, Math.min(1, clip.opacity ?? 1));
    ctx.globalAlpha = baseAlpha * transition.alphaMultiplier;

    // Calculate aspect ratio fit
    const srcAspect = sourceWidth / sourceHeight;
    const canvasAspect = canvasWidth / canvasHeight;

    let drawWidth = canvasWidth;
    let drawHeight = canvasHeight;

    if (srcAspect > canvasAspect) {
      // Source is wider than canvas
      drawWidth = canvasWidth;
      drawHeight = canvasWidth / srcAspect;
    } else {
      // Source is taller than canvas
      drawHeight = canvasHeight;
      drawWidth = canvasHeight * srcAspect;
    }

    // Apply scale
    const scale = clip.scale ?? 1;
    drawWidth *= scale;
    drawHeight *= scale;

    // Apply position offset (from center) + transition slide offset
    const centerX = canvasWidth / 2 + (clip.positionX ?? 0) + transition.offsetX;
    const centerY = canvasHeight / 2 + (clip.positionY ?? 0);

    const x = centerX - drawWidth / 2;
    const y = centerY - drawHeight / 2;

    let hasDrawn = false;

    try {
      if (mediaElement instanceof HTMLVideoElement) {
        if (mediaElement.readyState >= 2) {
          ctx.drawImage(mediaElement, x, y, drawWidth, drawHeight);
          mediaSourcePool.storeVideoFrame(clip.id, mediaElement, media?.id, !isPlaying, sourceTime);
          hasDrawn = true;
        } else {
          // Video element has not decoded this frame yet (temporary seek or buffer):
          // First try to display the last cached frame to prevent black flashes or thumbnail jumps.
          // The media level fallback is only used when the cached frame belongs to
          // the requested source time, otherwise a frame of a completely different
          // point of the same source would be shown (E-13).
          const cachedFrame =
            mediaSourcePool.getLastFrame(clip.id) ||
            (media && sourceTime !== undefined
              ? mediaSourcePool.getLastFrameForSource(media.id, sourceTime)
              : null);
          if (cachedFrame) {
            ctx.drawImage(cachedFrame, x, y, drawWidth, drawHeight);
            hasDrawn = true;
          } else if (media?.thumbnailUrl) {
            // ONLY on cold start while paused before any video frames have ever been rendered:
            const thumbImg = mediaSourcePool.getImageElement({ ...media, url: media.thumbnailUrl }, 'fallback_' + clip.id);
            if (thumbImg.complete && thumbImg.naturalWidth > 0) {
              ctx.drawImage(thumbImg, x, y, drawWidth, drawHeight);
              hasDrawn = true;
            } else if (!thumbImg.complete) {
              thumbImg.onload = () => {
                mediaSourcePool.notifyFrameReady();
              };
            }
          }
        }
      } else {
        // An image that is not decoded yet is a silent no-op: reporting it as
        // drawn poisoned the anti-flicker cache with a black frame (E-14).
        const img = mediaElement as HTMLImageElement;
        const isDecoded =
          typeof img.complete !== 'boolean' ? true : img.complete && (img.naturalWidth || 0) > 0;
        if (isDecoded) {
          ctx.drawImage(mediaElement, x, y, drawWidth, drawHeight);
          hasDrawn = true;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('HTMLVideoElement') && !msg.includes('readyState') && !msg.includes('NS_ERROR_NOT_AVAILABLE')) {
        console.warn(`[Compositor] drawImage error on "${clip.name}" (${clip.id}):`, err);
      }
    }

    // Color overlay for fade-black / fade-white
    if (transition.overlayColor && transition.overlayOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, transition.overlayOpacity * baseAlpha);
      ctx.fillStyle = transition.overlayColor;
      ctx.fillRect(x, y, drawWidth, drawHeight);
      ctx.restore();
    }

    ctx.restore();
    return hasDrawn;
  }

  /**
   * Draws styled text and synchronized lyrics overlay onto canvas.
   */
  private drawTextToCanvas(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    clip: Clip,
    canvasWidth: number,
    canvasHeight: number,
    time: number = 0
  ): void {
    if (!clip.text) return;

    const transition = calculateTransition(clip, time, canvasWidth);

    ctx.save();

    if (transition.wipeWidth !== null) {
      ctx.beginPath();
      ctx.rect(0, 0, Math.max(0, transition.wipeWidth), canvasHeight);
      ctx.clip();
    }

    const style = clip.textStyle || {
      fontSize: 48,
      color: '#ffffff',
      backgroundColor: 'transparent',
      fontFamily: 'Inter, sans-serif',
      textAlign: 'center',
      fontWeight: 'bold',
    };

    const preset = style.animationPreset || 'none';

    // Opacity calculation (including smooth fade-in/out for 'fade-phrase' and transition alpha)
    let baseOpacity = Math.max(0, Math.min(1, (clip.opacity ?? 1) * transition.alphaMultiplier));
    if (preset === 'fade-phrase') {
      const fadeInDuration = 0.35;
      const fadeOutDuration = 0.35;
      const timeInClip = time - clip.start;
      const timeLeft = clip.start + clip.duration - time;

      if (timeInClip < fadeInDuration && timeInClip >= 0) {
        baseOpacity *= Math.max(0, timeInClip / fadeInDuration);
      } else if (timeLeft < fadeOutDuration && timeLeft >= 0) {
        baseOpacity *= Math.max(0, timeLeft / fadeOutDuration);
      }
    }
    ctx.globalAlpha = baseOpacity;

    const fontSize = style.fontSize || 48;
    const fontFamily = style.fontFamily || 'Inter, sans-serif';
    const fontWeight = style.fontWeight || 'bold';

    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const textLines = clip.text.split('\n');
    const lineHeight = fontSize * 1.3;
    const totalTextHeight = textLines.length * lineHeight;

    const centerX = canvasWidth / 2 + (clip.positionX ?? 0) + transition.offsetX;
    const startY = canvasHeight / 2 + (clip.positionY ?? 0) - (totalTextHeight / 2) + (lineHeight / 2);

    // Optional background badge/card
    if (style.backgroundColor && style.backgroundColor !== 'transparent') {
      let maxLineWidth = 0;
      for (const line of textLines) {
        const metrics = ctx.measureText(line);
        if (metrics.width > maxLineWidth) maxLineWidth = metrics.width;
      }

      const padding = style.padding || 16;
      const bgWidth = maxLineWidth + padding * 2;
      const bgHeight = totalTextHeight + padding;

      let bgX = centerX - bgWidth / 2;
      if (style.textAlign === 'left') bgX = centerX - padding;
      if (style.textAlign === 'right') bgX = centerX - bgWidth + padding;
      const bgY = canvasHeight / 2 + (clip.positionY ?? 0) - (bgHeight / 2);

      ctx.fillStyle = style.backgroundColor;
      ctx.beginPath();
      const r = style.borderRadius ?? 8;
      ctx.roundRect ? ctx.roundRect(bgX, bgY, bgWidth, bgHeight, r) : ctx.rect(bgX, bgY, bgWidth, bgHeight);
      ctx.fill();
    }

    const strokeWidth = style.strokeWidth ?? 4;
    const strokeColor = style.strokeColor ?? 'rgba(0, 0, 0, 0.75)';
    const highlightColor = style.highlightColor ?? '#FACC15'; // Neon yellow accent
    const baseColor = style.color || '#ffffff';

    const hasWordTimings = Array.isArray(clip.words) && clip.words.length > 0;
    const isAnimatedLyrics = hasWordTimings && (preset === 'karaoke-fill' || preset === 'word-bounce');

    if (isAnimatedLyrics && clip.words) {
      // Synchronized word-by-word animation
      const spaceWidth = ctx.measureText(' ').width;
      let globalWordIdx = 0;

      textLines.forEach((line, lineIndex) => {
        const lineY = startY + lineIndex * lineHeight;
        const wordsInLine = line.trim().split(/\s+/).filter((w) => w.length > 0);

        // Measure words for exact positioning
        const wordMetrics = wordsInLine.map((w) => ({ text: w, width: ctx.measureText(w).width }));
        const totalLineWidth =
          wordMetrics.reduce((sum, m) => sum + m.width, 0) + Math.max(0, wordsInLine.length - 1) * spaceWidth;

        let currentX = centerX - totalLineWidth / 2;
        if (style.textAlign === 'left') currentX = centerX;
        if (style.textAlign === 'right') currentX = centerX - totalLineWidth;

        wordsInLine.forEach((wordText, i) => {
          const wWidth = wordMetrics[i].width;
          const wordCenterX = currentX + wWidth / 2;
          const timing = globalWordIdx < clip.words!.length ? clip.words![globalWordIdx] : null;
          globalWordIdx++;

          const isSung = timing ? time >= timing.end : false;
          const isCurrent = timing ? time >= timing.start && time < timing.end : false;
          const isUpcoming = timing ? time < timing.start : true;

          if (preset === 'word-bounce') {
            ctx.save();
            if (isCurrent) {
              // Active pop/bounce
              ctx.translate(wordCenterX, lineY);
              ctx.scale(1.15, 1.15);
              if (strokeWidth > 0) {
                ctx.lineWidth = strokeWidth + 2;
                ctx.strokeStyle = strokeColor;
                ctx.strokeText(wordText, 0, 0);
              }
              ctx.fillStyle = highlightColor;
              ctx.fillText(wordText, 0, 0);
            } else {
              if (strokeWidth > 0) {
                ctx.lineWidth = strokeWidth;
                ctx.strokeStyle = strokeColor;
                ctx.strokeText(wordText, wordCenterX, lineY);
              }
              ctx.fillStyle = isSung ? highlightColor : baseColor;
              ctx.fillText(wordText, wordCenterX, lineY);
            }
            ctx.restore();
          } else {
            // 'karaoke-fill' - Apple Music style smooth wipe
            if (strokeWidth > 0) {
              ctx.lineWidth = strokeWidth;
              ctx.strokeStyle = strokeColor;
              ctx.strokeText(wordText, wordCenterX, lineY);
            }

            if (isSung) {
              // Already sung: highlighted color
              ctx.fillStyle = highlightColor;
              ctx.fillText(wordText, wordCenterX, lineY);
            } else if (isUpcoming) {
              // Not yet sung: dimmed base color
              ctx.fillStyle = baseColor;
              ctx.fillText(wordText, wordCenterX, lineY);
            } else if (isCurrent && timing) {
              // In progress: progressive reveal
              const duration = Math.max(0.05, timing.end - timing.start);
              const progress = Math.max(0, Math.min(1, (time - timing.start) / duration));

              // 1. Draw base text
              ctx.fillStyle = baseColor;
              ctx.fillText(wordText, wordCenterX, lineY);

              // 2. Draw highlighted overlay with clipping mask
              ctx.save();
              ctx.beginPath();
              ctx.rect(currentX - 2, lineY - lineHeight / 2, (wWidth + 4) * progress, lineHeight);
              ctx.clip();
              ctx.fillStyle = highlightColor;
              ctx.fillText(wordText, wordCenterX, lineY);
              ctx.restore();
            }
          }

          currentX += wWidth + spaceWidth;
        });
      });
    } else {
      // Standard line-by-line text rendering
      if (style.textAlign === 'left') {
        ctx.textAlign = 'left';
      } else if (style.textAlign === 'right') {
        ctx.textAlign = 'right';
      } else {
        ctx.textAlign = 'center';
      }

      textLines.forEach((line, index) => {
        const lineY = startY + index * lineHeight;
        if (strokeWidth > 0) {
          ctx.lineWidth = strokeWidth;
          ctx.strokeStyle = strokeColor;
          ctx.strokeText(line, centerX, lineY);
        }
        ctx.fillStyle = baseColor;
        ctx.fillText(line, centerX, lineY);
      });
    }

    // Color overlay for fade-black / fade-white on text
    if (transition.overlayColor && transition.overlayOpacity > 0) {
      let maxLineWidth = 0;
      for (const line of textLines) {
        const metrics = ctx.measureText(line);
        if (metrics.width > maxLineWidth) maxLineWidth = metrics.width;
      }
      const padding = (style.padding || 16) + 4;
      const overlayWidth = maxLineWidth + padding * 2;
      const overlayHeight = totalTextHeight + padding;
      const overlayX = centerX - overlayWidth / 2;
      const overlayY = canvasHeight / 2 + (clip.positionY ?? 0) - overlayHeight / 2;

      ctx.save();
      ctx.globalAlpha = Math.min(1, transition.overlayOpacity * baseOpacity);
      ctx.fillStyle = transition.overlayColor;
      ctx.beginPath();
      const r = style.borderRadius ?? 8;
      ctx.roundRect ? ctx.roundRect(overlayX, overlayY, overlayWidth, overlayHeight, r) : ctx.rect(overlayX, overlayY, overlayWidth, overlayHeight);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }
}

export const compositor = new Compositor();
