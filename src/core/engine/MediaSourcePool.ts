import { Clip, MediaItem } from '../../types/project';
import {
  applyPitchPolicyToElement,
  resolvePlayback,
  DEFAULT_PRESERVE_PITCH,
  MIN_PLAYBACK_RATE,
  PlaybackOptions,
  ResolvedPlayback,
} from '../utils/playbackRate';

interface VideoSyncState {
  isCorrecting: boolean;
  lastRateChangeTime: number;
  /** Last source time requested for this element (NaN until the first sample). */
  lastTargetTime: number;
  hasTargetTime: boolean;
  /** performance.now() timestamp until which rate correction is suppressed. */
  seekSuppressUntil: number;
}

/**
 * A jump of the requested source time bigger than this is treated as an explicit
 * timeline seek (E-02) instead of playback drift.
 */
export const SEEK_JUMP_THRESHOLD = 0.25;

/**
 * Browsers clamp `playbackRate` below 0.0625 (Chrome/Safari minimum). The old
 * absolute floor of 0.25 broke every slow-motion clip below 0.25x (E-19).
 *
 * F4: the constant lives in `core/utils/playbackRate` (the single source of
 * truth for the playback semantics); it is re-exported here for backwards
 * compatibility with the existing importers.
 */
export { MIN_PLAYBACK_RATE };

/** Cooldown between two forced hard seeks on the same element (ms). */
const HARD_SEEK_COOLDOWN_MS = 1500;

/** Rate based correction is suppressed during this window after a seek (ms). */
const SEEK_CORRECTION_SUPPRESSION_MS = 400;

/** Minimum interval between two `play()` attempts on the same element (ms). */
const PLAY_RETRY_INTERVAL_MS = 1000;

/** Consecutive `play()` failures after which an element is considered dead. */
const MAX_PLAY_FAILURES = 3;

/** Information surfaced when a media element fails to load or decode. */
export interface MediaErrorInfo {
  mediaId: string;
  clipId?: string;
  message: string;
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
  /** WeakMap: the key is a DOM element, a strong Map would pin deleted clips forever (E-03). */
  private lastHardSeekTimeMap: WeakMap<HTMLVideoElement, number> = new WeakMap();
  private videoSyncStateMap: WeakMap<HTMLVideoElement, VideoSyncState> = new WeakMap();
  private lastFrameMap: Map<string, HTMLCanvasElement | OffscreenCanvas> = new Map();
  private lastStoredFrameTimeMap: Map<string, number> = new Map();
  /** Source time of the frame cached under a media id (E-13). */
  private mediaFrameSourceTimeMap: Map<string, number> = new Map();
  /** Applied `sourceStart` per element, so it is only seeked once (E-10). */
  private sourceStartMap: WeakMap<HTMLMediaElement, number> = new WeakMap();
  /** Elements whose `play()` failed terminally (E-11). */
  private failedElements: WeakSet<HTMLMediaElement> = new WeakSet();
  private playFailureCountMap: WeakMap<HTMLMediaElement, number> = new WeakMap();
  private nextPlayAttemptMap: WeakMap<HTMLMediaElement, number> = new WeakMap();
  /** Media id -> last error message (E-12). */
  private mediaErrors: Map<string, string> = new Map();
  private mediaErrorListeners: Set<(info: MediaErrorInfo) => void> = new Set();
  private lastPrewarmTime = 0;
  private frameReadyListeners: Set<() => void> = new Set();
  private frameReadyScheduled = false;

  private getSyncState(video: HTMLVideoElement): VideoSyncState {
    let state = this.videoSyncStateMap.get(video);
    if (!state) {
      state = {
        isCorrecting: false,
        lastRateChangeTime: 0,
        lastTargetTime: Number.NaN,
        hasTargetTime: false,
        seekSuppressUntil: 0,
      };
      this.videoSyncStateMap.set(video, state);
    }
    return state;
  }

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * Reports a media failure (undecodable file, revoked blob URL, missing source)
   * so the UI can warn about it instead of silently rendering nothing (E-12).
   */
  private reportMediaError(mediaId: string, clipId: string | undefined, message: string): void {
    this.mediaErrors.set(mediaId, message);
    for (const listener of this.mediaErrorListeners) {
      try {
        listener({ mediaId, clipId, message });
      } catch (err) {
        console.warn('[MediaSourcePool] Media error listener error:', err);
      }
    }
  }

  /** Subscribes to media load/decode failures. Returns an unsubscribe function. */
  public onMediaError(listener: (info: MediaErrorInfo) => void): () => void {
    this.mediaErrorListeners.add(listener);
    return () => {
      this.mediaErrorListeners.delete(listener);
    };
  }

  /** Last error recorded for a media item, or null when the media is healthy. */
  public getMediaError(mediaId: string): string | null {
    return this.mediaErrors.get(mediaId) ?? null;
  }

  /** True when the media item failed to load or decode at least once. */
  public hasMediaError(mediaId: string): boolean {
    return this.mediaErrors.has(mediaId);
  }

  /**
   * True when the media has no usable source (F3).
   *
   * A media flagged as `missing` (its bytes are gone) or without a URL can
   * never be decoded: the clip that uses it renders black and silent, so the
   * UI has to warn the user instead of pretending everything is fine.
   */
  public isMediaUnavailable(media: MediaItem | null | undefined): boolean {
    if (!media) return true;
    if (media.status === 'missing') return true;
    if (typeof media.url !== 'string' || media.url.length === 0) return true;
    return false;
  }

  /**
   * Reports a media that cannot be loaded (F3).
   * Used when the source is known to be unavailable BEFORE touching the DOM.
   */
  public reportUnavailableMedia(mediaId: string, clipId?: string): void {
    this.reportMediaError(
      mediaId,
      clipId,
      'Media file is missing or unavailable (it cannot be decoded)'
    );
  }

  /**
   * Positions an element at the clip's `sourceStart`.
   * Applied lazily (and only once per element/source pair) so that a clip with a
   * non-zero `sourceStart` does not start at media time 0 (E-10).
   */
  private applySourceStart(el: HTMLMediaElement, sourceStart: number | undefined): void {
    if (sourceStart === undefined || !isFinite(sourceStart) || sourceStart <= 0) return;

    const applied = this.sourceStartMap.get(el);
    if (applied === sourceStart) return;

    const seek = () => {
      if (!el) return;
      if (Math.abs(el.currentTime - sourceStart) > 0.05) {
        try {
          el.currentTime = sourceStart;
        } catch {
          // Ignore invalid state (element not seekable yet)
        }
      }
      this.sourceStartMap.set(el, sourceStart);
    };

    if (el.readyState >= 1) {
      seek();
    } else if (typeof el.addEventListener === 'function') {
      this.sourceStartMap.set(el, sourceStart);
      el.addEventListener('loadedmetadata', seek, { once: true });
    }
  }

  public getVideoElement(media: MediaItem, clipId?: string, sourceStart?: number): HTMLVideoElement {
    const key = clipId ? `${media.id}_${clipId}` : media.id;
    let el = this.videoElements.get(key);
    if (!el) {
      if (typeof document !== 'undefined') {
        el = document.createElement('video');
        // F3: a media without a usable source is reported right away: the
        // clip must not look like a normal clip when it renders black.
        if (this.isMediaUnavailable(media)) {
          this.reportUnavailableMedia(media.id, clipId);
        } else {
          el.src = media.url;
        }
        el.crossOrigin = 'anonymous';
        el.muted = true; // muted in video element; audio mixed via AudioEngine
        el.playsInline = true;
        el.preload = 'auto';
        // F4: the default policy is to PRESERVE the pitch. The clip policy
        // (`clip.preservePitch`) is applied by the AudioEngine as soon as the
        // clip is known; the previous code forced `preservesPitch = false`
        // (chipmunk at 2x) and made the preview disagree with the export.
        applyPitchPolicyToElement(el, DEFAULT_PRESERVE_PITCH);

        const storeFrameIfReady = () => {
          if (el && el.readyState >= 2) {
            this.storeVideoFrame(clipId || media.id, el, media.id);
          }
          this.notifyFrameReady();
        };

        el.addEventListener('loadeddata', storeFrameIfReady);
        el.addEventListener('seeked', storeFrameIfReady);
        el.addEventListener('canplay', () => this.notifyFrameReady());
        el.addEventListener('error', () => {
          this.reportMediaError(media.id, clipId, 'Video media failed to load or decode');
        });
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
    this.applySourceStart(el, sourceStart);
    return el;
  }

  public getImageElement(media: MediaItem, clipId?: string): HTMLImageElement {
    const key = clipId ? `${media.id}_${clipId}` : media.id;
    let el = this.imageElements.get(key);
    if (!el) {
      el = new Image();
      // F3: no source -> no request. NOTE: the thumbnail fallback of the
      // compositor calls this method with a DERIVED media (an empty
      // thumbnailUrl), so a failure is NOT reported here: a missing
      // thumbnail must not flag a perfectly healthy media as broken.
      if (!this.isMediaUnavailable(media)) {
        el.src = media.url;
      }
      el.crossOrigin = 'anonymous';
      el.addEventListener('error', () => {
        this.reportMediaError(media.id, clipId, 'Image media failed to load');
      });
      this.imageElements.set(key, el);
    }
    return el;
  }

  public getAudioElement(media: MediaItem, clipId?: string, sourceStart?: number): HTMLAudioElement {
    const key = clipId ? `${media.id}_${clipId}` : media.id;
    let el = this.audioElements.get(key);
    if (!el) {
      el = new Audio();
      if (this.isMediaUnavailable(media)) {
        this.reportUnavailableMedia(media.id, clipId);
      } else {
        el.src = media.url;
      }
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      // F4: the default policy is to PRESERVE the pitch (the clip policy is
      // applied by the AudioEngine). Forcing `false` here is what made the
      // preview and the export disagree about the height of the voice.
      applyPitchPolicyToElement(el, DEFAULT_PRESERVE_PITCH);
      el.addEventListener('error', () => {
        this.reportMediaError(media.id, clipId, 'Audio media failed to load or decode');
      });
      this.audioElements.set(key, el);
    }
    this.applySourceStart(el, sourceStart);
    return el;
  }

  /**
   * F4 · Aplica al elemento la reproducción resuelta de un clip
   * (velocidad + política de tono).
   *
   * Esta es la escritura canónica del lado del preview: usa la MISMA
   * `resolvePlayback()` que el exportador, de modo que el elemento del
   * preview y el `AudioBufferSourceNode` del export reciben exactamente los
   * mismos números (preview == export).
   *
   * @param applyRate `false` cuando la velocidad la controla otro sistema
   *   (el controlador de sincronización del vídeo, que modula el `playbackRate`
   *   para corregir la deriva): en ese caso solo se aplica la política de tono.
   */
  public applyPlayback(
    el: HTMLMediaElement | null | undefined,
    clip: PlaybackOptions | null | undefined,
    options?: { applyRate?: boolean }
  ): ResolvedPlayback {
    const resolved = resolvePlayback(clip);
    const applyRate = options?.applyRate !== false;
    if (el && applyRate) {
      try {
        if (Math.abs(el.playbackRate - resolved.rate) > 0.001) {
          el.playbackRate = resolved.rate;
        }
      } catch {
        // El elemento no admite cambios de velocidad (ignorado).
      }
    }
    applyPitchPolicyToElement(el, resolved.preservesPitch);
    return resolved;
  }

  /**
   * F4 · Aplica SOLO la política de tono al elemento.
   *
   * La velocidad de un elemento de vídeo la gobierna el controlador de
   * sincronización (`syncVideoTime`), que puede modularla temporalmente para
   * corregir la deriva; el tono, en cambio, es una decisión del clip.
   */
  public applyPitchPolicy(
    el: HTMLMediaElement | null | undefined,
    preservesPitch: boolean
  ): void {
    applyPitchPolicyToElement(el, preservesPitch);
  }

  /**
   * Stores the current video frame into an offscreen canvas cache to prevent black
   * flashes during temporary seeks or buffering periods. Caches by both clipId and mediaId.
   * Throttled during continuous playback to avoid copying 8.3MB full-res frames 60 times a second.
   */
  public storeVideoFrame(
    clipId: string,
    video: HTMLVideoElement,
    mediaId?: string,
    force = false,
    sourceTime?: number
  ): void {
    if (video.readyState < 2) return;
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 360;
    if (w <= 0 || h <= 0) return;

    const now = this.now();
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
      // Remember which source time the media level frame belongs to, so a frame
      // from a different point of the same source is never shown (E-13).
      if (sourceTime !== undefined && isFinite(sourceTime)) {
        this.mediaFrameSourceTimeMap.set(mediaId, sourceTime);
      }
    }
  }

  /**
   * Retrieves the last successfully rendered frame for a clip or media.
   */
  public getLastFrame(id: string): HTMLCanvasElement | OffscreenCanvas | null {
    return this.lastFrameMap.get(id) || null;
  }

  /**
   * Retrieves the media level cached frame only when it belongs (approximately)
   * to the requested source time. Prevents showing a frame captured at a totally
   * different point of the same source (E-13).
   */
  public getLastFrameForSource(
    mediaId: string,
    sourceTime: number,
    tolerance = 0.25
  ): HTMLCanvasElement | OffscreenCanvas | null {
    const frame = this.lastFrameMap.get(mediaId);
    if (!frame) return null;
    const stored = this.mediaFrameSourceTimeMap.get(mediaId);
    if (stored === undefined) return null;
    if (!isFinite(sourceTime)) return null;
    if (Math.abs(stored - sourceTime) > tolerance) return null;
    return frame;
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
   * Starts playback of an element with a bounded retry policy.
   * A failing `play()` is not retried 60 times per second (E-11).
   * Returns the play promise (already settled-safe) or null when the attempt was
   * skipped (backoff, terminal failure or unsupported element).
   */
  private tryPlay(video: HTMLMediaElement): Promise<void> | null {
    if (this.failedElements.has(video)) return null;
    const now = this.now();
    const nextAttempt = this.nextPlayAttemptMap.get(video);
    if (nextAttempt !== undefined && now < nextAttempt) return null;
    this.nextPlayAttemptMap.set(video, now + PLAY_RETRY_INTERVAL_MS);

    if (typeof video.play !== 'function') return null;
    try {
      const result = video.play();
      if (result && typeof result.then === 'function') {
        return result.then(
          () => {
            this.nextPlayAttemptMap.delete(video);
          },
          () => {
            const failures = (this.playFailureCountMap.get(video) || 0) + 1;
            this.playFailureCountMap.set(video, failures);
            if (failures >= MAX_PLAY_FAILURES) {
              // Terminal failure: stop hammering the element.
              this.failedElements.add(video);
            }
          }
        );
      }
    } catch {
      // Ignore: the element simply does not play
    }
    return null;
  }

  /**
   * Explicitly re-anchors a media element to a source time.
   * Used for timeline seeks: both the audio and the video path must jump to the
   * new position instead of slowly re-syncing at 1.06x (E-02).
   */
  public resyncVideo(video: HTMLVideoElement, targetTime: number, speed: number = 1): void {
    if (!video) return;
    // F4: the rate is always the one resolved by the single source of truth,
    // so the preview and the export can never disagree about the speed.
    const rate = resolvePlayback({ speed }).rate;
    const syncState = this.getSyncState(video);
    const now = this.now();
    syncState.isCorrecting = false;
    syncState.lastTargetTime = targetTime;
    syncState.hasTargetTime = true;
    syncState.lastRateChangeTime = now;
    syncState.seekSuppressUntil = now + SEEK_CORRECTION_SUPPRESSION_MS;
    this.lastHardSeekTimeMap.set(video, now);
    try {
      video.currentTime = targetTime;
    } catch {
      // Element not seekable yet
    }
    try {
      if (Math.abs(video.playbackRate - rate) > 0.01) {
        video.playbackRate = rate;
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Re-anchors every media element of the clips that are active at `time`.
   * Explicit seek path: the caller (timeline seek) uses it to guarantee that the
   * audio and the video jump to the new position together (E-02).
   */
  public resyncAll(clips: Clip[], mediaPool: MediaItem[], time: number): void {
    const mediaMap = new Map<string, MediaItem>();
    for (const m of mediaPool) mediaMap.set(m.id, m);

    for (const clip of clips) {
      if (clip.type !== 'video' && clip.type !== 'audio') continue;
      if (time < clip.start || time >= clip.start + clip.duration) continue;
      const media = mediaMap.get(clip.mediaId);
      if (!media) continue;
      // F4: the source window advances at the resolved rate, and the element
      // receives the very same rate + the pitch policy of the clip.
      const playback = resolvePlayback(clip);
      const speed = playback.rate;
      const rawOffset = clip.sourceStart + (time - clip.start) * speed;
      const maxSourceTime = Math.max(0, (media.duration || 1000) - 0.05);
      const clampedOffset = Math.max(0, Math.min(maxSourceTime, rawOffset));

      if (clip.type === 'video') {
        const video = this.videoElements.get(`${media.id}_${clip.id}`);
        if (video) {
          this.applyPitchPolicy(video, playback.preservesPitch);
          this.resyncVideo(video, clampedOffset, speed);
        }
      } else {
        const audio = this.audioElements.get(`${media.id}_${clip.id}`);
        if (audio) {
          this.applyPitchPolicy(audio, playback.preservesPitch);
          try {
            audio.currentTime = clampedOffset;
          } catch {
            // Ignore
          }
        }
      }
    }
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

    // F4: the base rate of the clip is the one resolved by the single source
    // of truth (`resolvePlayback`), so the element of the preview plays at
    // exactly the same speed as the exported file.
    const rate = resolvePlayback({ speed }).rate;

    const now = this.now();
    const syncState = this.getSyncState(video);

    // Detect an explicit seek: the requested source time jumped instead of
    // advancing continuously. Drifts are corrected with the rate, seeks are
    // corrected with a hard seek (E-02).
    const isSeekJump =
      syncState.hasTargetTime &&
      Math.abs(targetTime - syncState.lastTargetTime) > SEEK_JUMP_THRESHOLD;
    syncState.lastTargetTime = targetTime;
    syncState.hasTargetTime = true;

    if (isSeekJump) {
      this.resyncVideo(video, targetTime, rate);
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
          if (Math.abs(video.playbackRate - rate) > 0.01) {
            video.playbackRate = rate;
          }
          this.startingPlayMap.add(video);
          const settled = this.tryPlay(video);
          if (settled) {
            const release = () => this.startingPlayMap.delete(video);
            settled.then(release, release);
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

      // A seek is in flight: do not apply any rate based correction (E-02).
      if (now < syncState.seekSuppressUntil) {
        return;
      }

      const drift = video.currentTime - targetTime;
      const absDrift = Math.abs(drift);

      // Severe drift (> 1.5s): Forced seek with cooldown to prevent stutter loops
      if (absDrift > 1.50) {
        const lastSeek = this.lastHardSeekTimeMap.has(video) ? this.lastHardSeekTimeMap.get(video)! : -Infinity;
        if (now - lastSeek > HARD_SEEK_COOLDOWN_MS) {
          this.lastHardSeekTimeMap.set(video, now);
          video.currentTime = targetTime;
          syncState.isCorrecting = false;
          syncState.lastRateChangeTime = now;
          syncState.seekSuppressUntil = now + SEEK_CORRECTION_SUPPRESSION_MS;
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
          if (Math.abs(video.playbackRate - rate) > 0.01) {
            if (now - syncState.lastRateChangeTime >= RATE_CHANGE_COOLDOWN) {
              video.playbackRate = rate;
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
          if (Math.abs(video.playbackRate - rate) > 0.01) {
            if (now - syncState.lastRateChangeTime >= RATE_CHANGE_COOLDOWN) {
              video.playbackRate = rate;
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
        targetRate = drift < 0 ? rate * 1.06 : Math.max(MIN_PLAYBACK_RATE, rate * 0.94);
      } else {
        // Zone 3: Moderate drift (20% adjustment)
        targetRate = drift < 0 ? rate * 1.20 : Math.max(MIN_PLAYBACK_RATE, rate * 0.80);
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
      syncState.isCorrecting = false;

      if (!video.paused) {
        video.pause();
      }
      if (Math.abs(video.playbackRate - rate) > 0.01) {
        video.playbackRate = rate;
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
    const now = this.now();
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
        this.lastHardSeekTimeMap.delete(v);
        this.sourceStartMap.delete(v);
        v.pause();
        v.removeAttribute('src');
        v.load();
        this.videoElements.delete(key);
      }
    }
    for (const [key, a] of Array.from(this.audioElements.entries())) {
      if (key.endsWith(suffix) || key === clipId) {
        this.sourceStartMap.delete(a);
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
    this.lastStoredFrameTimeMap.delete(clipId);
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
        this.lastHardSeekTimeMap.delete(v);
        this.sourceStartMap.delete(v);
        v.pause();
        v.removeAttribute('src');
        v.load();
        this.videoElements.delete(key);
      }
    }
    for (const [key, a] of Array.from(this.audioElements.entries())) {
      if (key === mediaId || key.startsWith(prefix)) {
        this.sourceStartMap.delete(a);
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
    this.lastStoredFrameTimeMap.delete(mediaId);
    this.mediaFrameSourceTimeMap.delete(mediaId);
  }

  /**
   * Releases every pooled resource (video/audio/image elements, cached frames and
   * bookkeeping). MUST be called when a project is replaced or reset, otherwise
   * the elements of the previous project survive forever (C1).
   */
  public clear(): void {
    this.startingPlayMap.clear();
    this.lastFrameMap.clear();
    this.lastStoredFrameTimeMap.clear();
    this.mediaFrameSourceTimeMap.clear();
    this.mediaErrors.clear();
    this.failedElements = new WeakSet();
    this.playFailureCountMap = new WeakMap();
    this.nextPlayAttemptMap = new WeakMap();
    this.lastPrewarmTime = 0;
    for (const v of this.videoElements.values()) {
      this.videoSyncStateMap.delete(v);
      this.lastHardSeekTimeMap.delete(v);
      this.sourceStartMap.delete(v);
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    this.videoElements.clear();
    for (const a of this.audioElements.values()) {
      this.sourceStartMap.delete(a);
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    this.audioElements.clear();
    this.imageElements.clear();
  }
}

export const mediaSourcePool = new MediaSourcePool();
