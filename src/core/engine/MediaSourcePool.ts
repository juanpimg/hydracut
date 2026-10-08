import { MediaItem } from '../../types/project';

/**
 * Manages reusable HTMLVideoElement and HTMLImageElement instances
 * for preview compositing and playback sync with zero memory leaks
 * and anti-flicker frame caching.
 */
export class MediaSourcePool {
  private videoElements: Map<string, HTMLVideoElement> = new Map();
  private imageElements: Map<string, HTMLImageElement> = new Map();
  private audioElements: Map<string, HTMLAudioElement> = new Map();
  private startingPlayMap: Set<HTMLVideoElement> = new Set();
  private lastFrameMap: Map<string, HTMLCanvasElement | OffscreenCanvas> = new Map();
  private frameReadyListeners: Set<() => void> = new Set();
  private frameReadyScheduled = false;

  public getVideoElement(media: MediaItem, clipId?: string, sourceStart?: number): HTMLVideoElement {
    const key = clipId ? `${media.id}_${clipId}` : media.id;
    let el = this.videoElements.get(key);
    if (!el) {
      if (typeof document !== 'undefined') {
        el = document.createElement('video');
        el.src = media.url;
        el.crossOrigin = 'anonymous';
        el.muted = true; // muted in video element; audio mixed via Web Audio API / AudioEngine
        el.playsInline = true;
        el.preload = 'auto';

        const storeFrameIfReady = () => {
          if (el && el.readyState >= 2) {
            this.storeVideoFrame(clipId || media.id, el, media.id);
          }
          this.notifyFrameReady();
        };

        el.addEventListener('loadeddata', storeFrameIfReady);
        el.addEventListener('seeked', storeFrameIfReady);
        el.addEventListener('canplay', () => this.notifyFrameReady());

        if (sourceStart !== undefined && sourceStart > 0) {
          el.addEventListener(
            'loadedmetadata',
            () => {
              if (el && Math.abs(el.currentTime - sourceStart) > 0.05) {
                el.currentTime = sourceStart;
              }
            },
            { once: true }
          );
        }
      } else {
        // Headless Node mock fallback
        el = {
          readyState: 4,
          videoWidth: media.width || 1280,
          videoHeight: media.height || 720,
          currentTime: 0,
          paused: true,
          seeking: false,
          play: async () => {},
          pause: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
        } as unknown as HTMLVideoElement;
      }
      this.videoElements.set(key, el);
    }
    return el;
  }

  public getImageElement(media: MediaItem, clipId?: string): HTMLImageElement {
    const key = clipId ? `${media.id}_${clipId}` : media.id;
    let el = this.imageElements.get(key);
    if (!el) {
      el = new Image();
      el.src = media.url;
      el.crossOrigin = 'anonymous';
      this.imageElements.set(key, el);
    }
    return el;
  }

  public getAudioElement(media: MediaItem, clipId?: string): HTMLAudioElement {
    const key = clipId ? `${media.id}_${clipId}` : media.id;
    let el = this.audioElements.get(key);
    if (!el) {
      el = new Audio();
      el.src = media.url;
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      this.audioElements.set(key, el);
    }
    return el;
  }

  /**
   * Stores the current video frame into an offscreen canvas cache to prevent black
   * flashes during temporary seeks or buffering periods. Caches by both clipId and mediaId.
   */
  public storeVideoFrame(clipId: string, video: HTMLVideoElement, mediaId?: string): void {
    if (video.readyState < 2) return;
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 360;
    if (w <= 0 || h <= 0) return;

    const saveToCanvas = (key: string) => {
      let canvas = this.lastFrameMap.get(key);
      if (!canvas) {
        if (typeof OffscreenCanvas !== 'undefined') {
          canvas = new OffscreenCanvas(w, h);
        } else if (typeof document !== 'undefined') {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          canvas = c;
        } else {
          // Headless Node environment fallback
          canvas = {
            width: w,
            height: h,
            getContext: () => ({ drawImage: () => {} }),
          } as unknown as HTMLCanvasElement;
        }
        this.lastFrameMap.set(key, canvas);
      } else if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      try {
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h);
        }
      } catch {
        // Ignored
      }
    };

    saveToCanvas(clipId);
    if (mediaId && mediaId !== clipId) {
      saveToCanvas(mediaId);
    }
  }

  /**
   * Retrieves the last successfully rendered frame for a clip or media.
   */
  public getLastFrame(id: string): HTMLCanvasElement | OffscreenCanvas | null {
    return this.lastFrameMap.get(id) || null;
  }

  /**
   * Notifies subscribers (e.g. PreviewPlayer) that a new frame has been decoded and is ready to display.
   * Throttled via requestAnimationFrame to avoid excess render calls.
   */
  public notifyFrameReady(): void {
    if (this.frameReadyScheduled) return;
    this.frameReadyScheduled = true;
    const scheduleFn = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16);
    scheduleFn(() => {
      this.frameReadyScheduled = false;
      for (const listener of this.frameReadyListeners) {
        try {
          listener();
        } catch (e) {
          console.warn('[MediaSourcePool] Frame ready listener error:', e);
        }
      }
    });
  }

  public onFrameReady(listener: () => void): () => void {
    this.frameReadyListeners.add(listener);
    return () => {
      this.frameReadyListeners.delete(listener);
    };
  }

  /**
   * Syncs video element time with source offset smoothly without stuttering or seek loops.
   */
  public syncVideoTime(
    video: HTMLVideoElement,
    targetTime: number,
    isPlaying: boolean,
    speed: number = 1
  ): void {
    if (video.readyState < 1) {
      // Not ready yet
      return;
    }

    if (isPlaying) {
      if (video.paused) {
        // Guard against continuous seek-loops while play promise is pending
        if (!video.seeking && !this.startingPlayMap.has(video)) {
          if (Math.abs(video.currentTime - targetTime) > 0.15) {
            video.currentTime = targetTime;
          }
          video.playbackRate = speed;
          this.startingPlayMap.add(video);
          video
            .play()
            .catch(() => {})
            .finally(() => {
              this.startingPlayMap.delete(video);
            });
        }
        return;
      }

      // If playback startup is in progress, allow it to stabilize
      if (this.startingPlayMap.has(video)) {
        return;
      }

      // Smooth drift correction during active playback:
      // NEVER hard-seek unless there is a huge jump (e.g. user clicked ruler)
      const drift = video.currentTime - targetTime;
      if (Math.abs(drift) > 0.8) {
        if (!video.seeking) {
          video.currentTime = targetTime;
        }
      } else if (Math.abs(drift) > 0.04) {
        // Micro-adjust playbackRate smoothly without interrupting hardware decode
        if (drift < -0.04) {
          video.playbackRate = speed * 1.08;
        } else {
          video.playbackRate = Math.max(0.2, speed * 0.92);
        }
      } else {
        if (Math.abs(video.playbackRate - speed) > 0.01) {
          video.playbackRate = speed;
        }
      }
    } else {
      // Paused / Scrubbing mode
      this.startingPlayMap.delete(video);
      if (!video.paused) {
        video.pause();
      }
      const diff = Math.abs(video.currentTime - targetTime);
      if (diff > 0.03 && !video.seeking) {
        video.currentTime = targetTime;
      }
    }
  }

  /**
   * Pauses video elements that are not currently active on the timeline,
   * avoiding wasted GPU/CPU decoding resources in the background.
   */
  public pauseInactiveVideos(activeKeys: Set<string>): void {
    for (const [key, v] of this.videoElements.entries()) {
      if (!activeKeys.has(key) && !v.paused) {
        v.pause();
      }
    }
  }

  public pauseAll(): void {
    this.startingPlayMap.clear();
    for (const v of this.videoElements.values()) {
      if (!v.paused) v.pause();
    }
    for (const a of this.audioElements.values()) {
      if (!a.paused) a.pause();
    }
  }

  /**
   * Releases all resources associated with a specific clip ID.
   */
  public releaseClip(clipId: string): void {
    const suffix = `_${clipId}`;
    for (const [key, v] of Array.from(this.videoElements.entries())) {
      if (key.endsWith(suffix) || key === clipId) {
        this.startingPlayMap.delete(v);
        v.pause();
        v.removeAttribute('src');
        v.load();
        this.videoElements.delete(key);
      }
    }
    for (const [key, a] of Array.from(this.audioElements.entries())) {
      if (key.endsWith(suffix) || key === clipId) {
        a.pause();
        a.removeAttribute('src');
        a.load();
        this.audioElements.delete(key);
      }
    }
    for (const [key] of Array.from(this.imageElements.entries())) {
      if (key.endsWith(suffix) || key === clipId) {
        this.imageElements.delete(key);
      }
    }
    this.lastFrameMap.delete(clipId);
  }

  /**
   * Releases all resources associated with a media ID (including any clip elements derived from it).
   */
  public release(mediaId: string): void {
    const prefix = `${mediaId}_`;
    for (const [key, v] of Array.from(this.videoElements.entries())) {
      if (key === mediaId || key.startsWith(prefix)) {
        this.startingPlayMap.delete(v);
        v.pause();
        v.removeAttribute('src');
        v.load();
        this.videoElements.delete(key);
      }
    }
    for (const [key, a] of Array.from(this.audioElements.entries())) {
      if (key === mediaId || key.startsWith(prefix)) {
        a.pause();
        a.removeAttribute('src');
        a.load();
        this.audioElements.delete(key);
      }
    }
    for (const [key] of Array.from(this.imageElements.entries())) {
      if (key === mediaId || key.startsWith(prefix)) {
        this.imageElements.delete(key);
      }
    }
    this.lastFrameMap.delete(mediaId);
  }

  public clear(): void {
    this.startingPlayMap.clear();
    this.lastFrameMap.clear();
    for (const v of this.videoElements.values()) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    this.videoElements.clear();
    for (const a of this.audioElements.values()) {
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    this.audioElements.clear();
    this.imageElements.clear();
  }
}

export const mediaSourcePool = new MediaSourcePool();
