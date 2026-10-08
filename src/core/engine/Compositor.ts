import { Clip, MediaItem, Track } from '../../types/project';
import { mediaSourcePool } from './MediaSourcePool';

export interface RenderOptions {
  time: number;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  tracks: Track[];
  clips: Clip[];
  mediaPool: MediaItem[];
  isPlaying: boolean;
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
        alphaMultiplier *= progressIn;
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
        alphaMultiplier *= progressOut;
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

  /**
   * Renders a frame at timeline time `time` onto the target canvas.
   */
  public renderFrame(options: RenderOptions): void {
    const { time, canvas, tracks, clips, mediaPool, isPlaying } = options;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // 1. Clear background
    ctx.fillStyle = '#0a0a0c';
    ctx.fillRect(0, 0, width, height);

    // Map media items by id for fast lookup
    const mediaMap = new Map<string, MediaItem>();
    for (const m of mediaPool) {
      mediaMap.set(m.id, m);
    }

    // Map tracks by id
    const trackMap = new Map<string, Track>();
    for (const t of tracks) {
      trackMap.set(t.id, t);
    }

    // Separate tracks by type and sort back-to-front (painters algorithm)
    // Video tracks in UI are listed top-to-bottom (V2 above V1).
    // Base video (V1) is rendered first (background), overlay video (V2) on top.
    const videoTracks = tracks.filter((t) => t.type === 'video');
    const textTracks = tracks.filter((t) => t.type === 'text');

    const sortedVideoTracks = [...videoTracks].reverse();
    const sortedTextTracks = [...textTracks].reverse();

    // Visual rendering sequence: base video -> overlay video -> text overlays
    const renderOrder = [...sortedVideoTracks, ...sortedTextTracks];
    const activeVideoKeys = new Set<string>();
    let hasActiveVisualClip = false;
    let hasDrawnVisualFrame = false;

    for (const track of renderOrder) {
      if (!track.isVisible) continue;

      // Find active clips in this track at time `time`
      const activeClips = clips.filter(
        (c) => c.trackId === track.id && time >= c.start && time < c.start + c.duration
      );

      for (const clip of activeClips) {
        if (clip.opacity <= 0) continue;

        if (clip.type === 'video' || clip.type === 'image') {
          hasActiveVisualClip = true;
          const media = mediaMap.get(clip.mediaId);
          if (!media) continue;

          if (clip.type === 'video') {
            const videoEl = mediaSourcePool.getVideoElement(media, clip.id, clip.sourceStart);
            activeVideoKeys.add(`${media.id}_${clip.id}`);
            const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
            const sourceOffset = clip.sourceStart + (time - clip.start) * speed;
            const maxSourceTime = Math.max(0, (media.duration || 1000) - 0.05);
            const clampedOffset = Math.max(0, Math.min(maxSourceTime, sourceOffset));
            mediaSourcePool.syncVideoTime(videoEl, clampedOffset, isPlaying, speed);

            const drawn = this.drawMediaToCanvas(ctx, videoEl, clip, width, height, media.width || 1280, media.height || 720, time, media, isPlaying);
            if (drawn !== false) {
              hasDrawnVisualFrame = true;
            }
          } else if (clip.type === 'image') {
            const imgEl = mediaSourcePool.getImageElement(media, clip.id);
            const drawn = this.drawMediaToCanvas(ctx, imgEl, clip, width, height, media.width || 1280, media.height || 720, time, media, isPlaying);
            if (drawn !== false) {
              hasDrawnVisualFrame = true;
            }
          }
        } else if (clip.type === 'text') {
          this.drawTextToCanvas(ctx, clip, width, height, time);
        }
      }
    }

    if (isPlaying) {
      mediaSourcePool.pauseInactiveVideos(activeVideoKeys);
    }

    // Anti-flicker protection:
    // If an active visual clip was scheduled to be visible, but produced no frames yet during active playback
    // (e.g. temporary asynchronous seek/decode latency across clip cuts), bridge with the last composited frame
    // instead of flashing black #0a0a0c!
    if (hasActiveVisualClip && !hasDrawnVisualFrame && isPlaying && this.lastCompositedCanvas) {
      try {
        ctx.drawImage(this.lastCompositedCanvas, 0, 0, width, height);
      } catch {
        // Ignored
      }
    } else if (hasDrawnVisualFrame) {
      // Save valid rendered visual frame into lastCompositedCanvas
      if (!this.lastCompositedCanvas) {
        if (typeof OffscreenCanvas !== 'undefined') {
          this.lastCompositedCanvas = new OffscreenCanvas(width, height);
        } else if (typeof document !== 'undefined') {
          const c = document.createElement('canvas');
          c.width = width;
          c.height = height;
          this.lastCompositedCanvas = c;
        }
      } else if (this.lastCompositedCanvas.width !== width || this.lastCompositedCanvas.height !== height) {
        this.lastCompositedCanvas.width = width;
        this.lastCompositedCanvas.height = height;
      }
      if (this.lastCompositedCanvas) {
        try {
          const bCtx = this.lastCompositedCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
          if (bCtx) {
            bCtx.drawImage(canvas, 0, 0, width, height);
          }
        } catch {
          // Ignored
        }
      }
    } else if (!hasActiveVisualClip) {
      this.lastCompositedCanvas = null;
    }
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
    isPlaying: boolean = false
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
          mediaSourcePool.storeVideoFrame(clip.id, mediaElement, media?.id);
          hasDrawn = true;
        } else {
          // Video element has not decoded this frame yet (temporary seek or buffer):
          // First try to display the last cached frame to prevent black flashes or thumbnail jumps
          const cachedFrame = mediaSourcePool.getLastFrame(clip.id) || (media ? mediaSourcePool.getLastFrame(media.id) : null);
          if (cachedFrame) {
            ctx.drawImage(cachedFrame, x, y, drawWidth, drawHeight);
            hasDrawn = true;
          } else if (!isPlaying && media?.thumbnailUrl) {
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
        ctx.drawImage(mediaElement, x, y, drawWidth, drawHeight);
        hasDrawn = true;
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
