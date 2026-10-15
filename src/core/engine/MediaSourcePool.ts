import { Clip, MediaItem } from '../../types/project';

interface VideoSyncState {
  isCorrecting: boolean;
  lastRateChangeTime: number;
}

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
  private lastHardSeekTimeMap: Map<HTMLVideoElement, number> = new Map();
  private videoSyncStateMap: WeakMap<HTMLVideoElement, VideoSyncState> = new WeakMap();
  private lastFrameMap: Map<string, HTMLCanvasElement | OffscreenCanvas> = new Map();
  private lastStoredFrameTimeMap: Map<string, number> = new Map();
  private lastPrewarmTime = 0;
  private frameReadyListeners: Set<() => void> = new Set();
  private frameReadyScheduled = false;

  private getSyncState(video: HTMLVideoElement): VideoSyncState {
    let state = this.videoSyncStateMap.get(video);
    if (!state) {
      state = { isCorrecting: false, lastRateChangeTime: 0 };
      this.videoSyncStateMap.set(video, state);
    }
    return state;
  }

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
          if (el.readyState >= 1) {
            if (Math.abs(el.currentTime - sourceStart) > 0.05) {
              el.currentTime = sourceStart;
            }
          } else {
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
   * Throttled during continuous playback to avoid copying 8.3MB full-res frames 60 times a second.
   */
  public storeVideoFrame(clipId: string, video: HTMLVideoElement, mediaId?: string, force = false): void {
    if (video.readyState < 2) return;
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 360;
    if (w <= 0 || h <= 0) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const lastStored = this.lastStoredFrameTimeMap.get(clipId) || 0;
    if (!force && now - lastStored < 300) {
      return;
    }
    this.lastStoredFrameTimeMap.set(clipId, now);
    if (mediaId) {
      this.lastStoredFrameTimeMap.set(mediaId, now);
    }

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
   * Tolerates minor jitter (< 200ms) naturally without altering playback rate.
   * Employs asymmetric hysteresis (enter at 200ms, exit at 80ms) and a 300ms rate change cooldown
   * to eliminate hardware decoder micro-stutters and rate thrashing.
   * Guards against active seeks and pending play startup.
   * Only hard-seeks for massive desync (> 1.5s) with a 1.5s cooldown to prevent seek loops.
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
          // If already close to target time (<= 0.8s), DO NOT hard-seek:
          // Seeking stalls the hardware decoder right as the clip begins playing!
          // Let playback start instantly, and the drift controller will gently nudge the rate.
          if (Math.abs(video.currentTime - targetTime) > 0.8) {
            video.currentTime = targetTime;
          }
          if (Math.abs(video.playbackRate - speed) > 0.01) {
            video.playbackRate = speed;
          }
          this.startingPlayMap.add(video);
          if (typeof video.play === 'function') {
            video
              .play()
              .catch(() => {})
              .finally(() => {
                this.startingPlayMap.delete(video);
              });
          } else {
            this.startingPlayMap.delete(video);
          }
        }
        return;
      }

      // If playback startup is in progress or video is seeking, guard against drift evaluation
      if (this.startingPlayMap.has(video) || video.seeking) {
        return;
      }

      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const drift = video.currentTime - targetTime;
      const absDrift = Math.abs(drift);
      const syncState = this.getSyncState(video);

      // Severe drift (> 1.5s): Forced seek with cooldown to prevent stutter loops
      if (absDrift > 1.50) {
        const lastSeek = this.lastHardSeekTimeMap.has(video) ? this.lastHardSeekTimeMap.get(video)! : -Infinity;
        if (now - lastSeek > 1500) {
          this.lastHardSeekTimeMap.set(video, now);
          video.currentTime = targetTime;
          syncState.isCorrecting = false;
          syncState.lastRateChangeTime = now;
        }
        return;
      }

      // Asymmetric Hysteresis Deadband State Machine:
      // DEADBAND_ENTER = 200ms tolerance before engaging rate correction
      // DEADBAND_EXIT = 80ms release threshold to return to exact native 1.0x speed
      // RATE_CHANGE_COOLDOWN = 300ms minimum interval between playbackRate mutations
      const DEADBAND_ENTER = 0.20;
      const DEADBAND_EXIT = 0.08;
      const RATE_CHANGE_COOLDOWN = 300;

      if (!syncState.isCorrecting) {
        if (absDrift <= DEADBAND_ENTER) {
          // In native tolerance deadband: maintain exact native speed
          if (Math.abs(video.playbackRate - speed) > 0.01) {
            if (now - syncState.lastRateChangeTime >= RATE_CHANGE_COOLDOWN) {
              video.playbackRate = speed;
              syncState.lastRateChangeTime = now;
            }
          }
          return;
        }
        // Drift exceeded enter threshold: engage correction mode
        syncState.isCorrecting = true;
      } else {
        // In correction mode: check if drift has reduced below exit threshold
        if (absDrift <= DEADBAND_EXIT) {
          syncState.isCorrecting = false;
          if (Math.abs(video.playbackRate - speed) > 0.01) {
            if (now - syncState.lastRateChangeTime >= RATE_CHANGE_COOLDOWN) {
              video.playbackRate = speed;
              syncState.lastRateChangeTime = now;
            }
          }
          return;
        }
      }

      // Determine target rate with micro-adjustment (Zone 2) vs moderate adjustment (Zone 3)
      let targetRate: number;
      if (absDrift <= 0.60) {
        // Zone 2: Minor drift (gentle 6% micro-adjustment)
        targetRate = drift < 0 ? speed * 1.06 : Math.max(0.25, speed * 0.94);
      } else {
        // Zone 3: Moderate drift (20% adjustment)
        targetRate = drift < 0 ? speed * 1.20 : Math.max(0.25, speed * 0.80);
      }

      // Throttle rate mutations to avoid decoder pipeline resets
      if (Math.abs(video.playbackRate - targetRate) > 0.01) {
        if (now - syncState.lastRateChangeTime >= RATE_CHANGE_COOLDOWN) {
          video.playbackRate = targetRate;
          syncState.lastRateChangeTime = now;
        }
      }
    } else {
      // Paused / Scrubbing mode
      this.startingPlayMap.delete(video);
      const syncState = this.getSyncState(video);
      syncState.isCorrecting = false;

      if (!video.paused) {
        video.pause();
      }
      if (Math.abs(video.playbackRate - speed) > 0.01) {
        video.playbackRate = speed;
      }
      const diff = Math.abs(video.currentTime - targetTime);
      if (diff > 0.03 && !video.seeking) {
        video.currentTime = targetTime;
      }
    }
  }

  /**
   * Pre-warms video decoders and pre-seeks upcoming clips within a 2.5s window
   * so clip transitions happen instantaneously with zero latency or black flashes.
   */
  public prewarmUpcomingClips(time: number, clips: Clip[], mediaPool: MediaItem[], force = false): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && now - this.lastPrewarmTime < 250) {
      return;
    }
    this.lastPrewarmTime = now;

    const mediaMap = new Map<string, MediaItem>();
    for (const m of mediaPool) {
      mediaMap.set(m.id, m);
    }

    for (const clip of clips) {
      if (clip.type !== 'video') continue;
      // If clip starts within the next 2.5 seconds:
      if (clip.start > time && clip.start <= time + 2.5) {
        const media = mediaMap.get(clip.mediaId);
        if (!media) continue;
        const video = this.getVideoElement(media, clip.id, clip.sourceStart);
        if (video.readyState >= 1 && !video.seeking) {
          const expectedStart = clip.sourceStart;
          if (Math.abs(video.currentTime - expectedStart) > 0.15) {
            video.currentTime = expectedStart;
          }
        }
      }
    }
  }

  /**
   * Pauses video elements that are not currently active or pre-warming on the timeline,
   * avoiding wasted GPU/CPU decoding resources in the background.
   */
  public pauseInactiveVideos(activeKeys: Set<string>, prewarmKeys?: Set<string>): void {
    for (const [key, v] of this.videoElements.entries()) {
      if (!activeKeys.has(key) && (!prewarmKeys || !prewarmKeys.has(key)) && !v.paused) {
        v.pause();
      }
    }
  }

  public pauseAll(): void {
    this.startingPlayMap.clear();
    for (const v of this.videoElements.values()) {
      if (!v.paused) v.pause();
      const s = this.videoSyncStateMap.get(v);
      if (s) {
        s.isCorrecting = false;
      }
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
        this.videoSyncStateMap.delete(v);
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
        this.videoSyncStateMap.delete(v);
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
      this.videoSyncStateMap.delete(v);
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
