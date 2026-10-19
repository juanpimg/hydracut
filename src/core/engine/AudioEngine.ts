import { Clip, MediaItem, Track } from '../../types/project';
import { masterClock } from './MasterClock';
import { mediaSourcePool } from './MediaSourcePool';
import { resolvePlayback } from '../utils/playbackRate';

/** Minimum interval between two `play()` attempts on the same element (ms). */
const PLAY_RETRY_INTERVAL_MS = 1000;

/** Consecutive `play()` failures after which an element is considered dead. */
const MAX_PLAY_FAILURES = 3;

/**
 * Window (seconds) in which upcoming clips are materialised ahead of time.
 * It bounds both the number of live media elements (E-16) and gives the audio
 * a pre-roll so there is no gap at every cut (E-20).
 */
const PREWARM_WINDOW = 2.5;

/** A media element routed through the Web Audio graph. */
interface RoutedElement {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  ctx: AudioContext;
}

/**
 * AudioEngine manages audio playback and mixing across multitrack clips.
 *
 * Volume semantics (kept identical to the exporter):
 * - `clip.volume` accepts 0..2 (0%..200%).
 * - The gain up to 100% is applied on the media element (`HTMLMediaElement.volume`).
 * - The amplification above 100% is applied through a per element `GainNode`,
 *   because `HTMLMediaElement.volume` is hard capped at 1 by the DOM.
 * - Muting (clip, track or master) is applied on the media element, so it also
 *   works when no Web Audio graph is available.
 */
export class AudioEngine {
  private masterVolume: number = 1;

  // Zero-thrashing caches
  private elementVolumeCache: WeakMap<HTMLMediaElement, number> = new WeakMap();
  private mediaMapCache: Map<string, MediaItem> = new Map();
  private trackMapCache: Map<string, Track> = new Map();

  /** Media elements routed through the Web Audio graph (one source node per element). */
  private routedElements: WeakMap<HTMLMediaElement, RoutedElement> = new WeakMap();
  /** The AudioContext the current routing belongs to. */
  private routedContext: AudioContext | null = null;

  /** Elements whose `play()` failed terminally (E-11). */
  private failedElements: WeakSet<HTMLMediaElement> = new WeakSet();
  private playFailureCountMap: WeakMap<HTMLMediaElement, number> = new WeakMap();
  private nextPlayAttemptMap: WeakMap<HTMLMediaElement, number> = new WeakMap();
  /** Backoff for `AudioContext.resume()` (E-11). */
  private nextContextResumeAttemptMap: WeakMap<AudioContext, number> = new WeakMap();

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * Routes a media element through the Web Audio graph so that volumes above
   * 100% can be honoured (`HTMLMediaElement.volume` is hard capped at 1).
   * Returns false when no graph is available: the caller then falls back to the
   * element level gain, which is capped at 100%.
   */
  private routeElement(el: HTMLMediaElement, gainValue: number): boolean {
    const ctx = masterClock.getAudioContext();
    if (!ctx || ctx.state === 'closed') return false;

    if (this.routedContext && this.routedContext !== ctx) {
      // The AudioContext was replaced (the previous one was closed): every
      // element routed to the old context is silent forever, so the pooled
      // elements are dropped and recreated for the new context.
      this.routedElements = new WeakMap();
      this.routedContext = ctx;
      try {
        mediaSourcePool.clear();
      } catch {
        // ignore
      }
      return false;
    }
    this.routedContext = ctx;

    let routed = this.routedElements.get(el);
    if (!routed) {
      try {
        const source = ctx.createMediaElementSource(el);
        const gain = ctx.createGain();
        gain.gain.value = 1;
        source.connect(gain);
        gain.connect(ctx.destination);
        routed = { source, gain, ctx };
        this.routedElements.set(el, routed);
      } catch {
        // The element cannot be routed (already connected elsewhere, or the
        // context does not support it): stay on the element level gain.
        return false;
      }
    }

    const target = Math.max(0, gainValue);
    if (Math.abs(routed.gain.gain.value - target) > 0.001) {
      routed.gain.gain.value = target;
    }
    return true;
  }

  /**
   * Starts playback of a media element with a bounded retry policy.
   * A failing `play()` is not retried 60 times per second (E-11).
   */
  private tryPlay(el: HTMLMediaElement): void {
    if (this.failedElements.has(el)) return;
    const now = this.now();
    const nextAttempt = this.nextPlayAttemptMap.get(el);
    if (nextAttempt !== undefined && now < nextAttempt) return;
    this.nextPlayAttemptMap.set(el, now + PLAY_RETRY_INTERVAL_MS);

    if (typeof el.play !== 'function') return;
    try {
      const result = el.play();
      if (result && typeof result.then === 'function') {
        result.then(
          () => {
            this.nextPlayAttemptMap.delete(el);
          },
          () => {
            const failures = (this.playFailureCountMap.get(el) || 0) + 1;
            this.playFailureCountMap.set(el, failures);
            if (failures >= MAX_PLAY_FAILURES) {
              // Terminal failure: stop hammering the element.
              this.failedElements.add(el);
            }
          }
        );
      }
    } catch {
      // Ignore: the element simply does not play
    }
  }

  /**
   * Resumes a suspended AudioContext with a backoff, so a failing resume is not
   * retried on every frame (E-11).
   */
  private resumeContext(ctx: AudioContext): void {
    const now = this.now();
    const nextAttempt = this.nextContextResumeAttemptMap.get(ctx);
    if (nextAttempt !== undefined && now < nextAttempt) return;
    this.nextContextResumeAttemptMap.set(ctx, now + PLAY_RETRY_INTERVAL_MS);
    try {
      const result = ctx.resume();
      if (result && typeof result.then === 'function') {
        result.then(
          () => {
            this.nextContextResumeAttemptMap.delete(ctx);
          },
          () => {
            // Retried with the backoff above.
          }
        );
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Updates audio output state for the current timeline position
   */
  public updateAudio(
    time: number,
    isPlaying: boolean,
    tracks: Track[],
    clips: Clip[],
    mediaPool: MediaItem[]
  ): void {
    try {
      const ctx = masterClock.getAudioContext();
      if (ctx && ctx.state === 'suspended' && isPlaying) {
        this.resumeContext(ctx);
      }

      // Re-populate reusable map caches without heap allocation on every frame
      this.mediaMapCache.clear();
      for (const m of mediaPool) this.mediaMapCache.set(m.id, m);

      this.trackMapCache.clear();
      for (const t of tracks) this.trackMapCache.set(t.id, t);

      // Process clips with audio
      for (const clip of clips) {
        if (clip.type !== 'audio' && clip.type !== 'video') continue;

        const track = this.trackMapCache.get(clip.trackId);
        const isTrackMuted = track ? track.isMuted : false;

        const clipEnd = clip.start + clip.duration;
        const isActive =
          isPlaying &&
          time >= clip.start &&
          time < clipEnd &&
          !clip.muted &&
          !isTrackMuted;

        const isUpcoming = clip.start > time;
        const withinPrewarm = isUpcoming && clip.start <= time + PREWARM_WINDOW;

        // Lazy element creation (E-16): a media element (and its media load) is
        // only created for clips that are active or about to become active.
        if (isUpcoming && !withinPrewarm) continue;

        const media = this.mediaMapCache.get(clip.mediaId);
        if (!media) continue;

        const mediaEl =
          clip.type === 'video'
            ? mediaSourcePool.getVideoElement(media, clip.id, clip.sourceStart)
            : mediaSourcePool.getAudioElement(media, clip.id, clip.sourceStart);

        if (!mediaEl) continue;

        // F4: the playback semantics of the clip (speed + pitch policy) are
        // resolved ONCE, here, with the same function the exporter uses. The
        // preview and the export therefore receive the same numbers.
        const playback = resolvePlayback(clip);

        // F4: the pitch policy is a decision of the clip and is applied to the
        // element of the preview (the export applies the equivalent
        // `detune` compensation to its `AudioBufferSourceNode`).
        mediaSourcePool.applyPitchPolicy(mediaEl, playback.preservesPitch);

        if (isActive) {
          const speed = playback.rate;
          const rawOffset = clip.sourceStart + (time - clip.start) * speed;
          // The source offset is clamped to the media duration, exactly like the
          // video path does, otherwise the element seeks past its end on every
          // single frame (E-09).
          const maxSourceTime = Math.max(0, (media.duration || 1000) - 0.05);
          const sourceOffset = Math.max(0, Math.min(maxSourceTime, rawOffset));
          const isPastMediaEnd = rawOffset >= maxSourceTime;

          // Sync media element
          if (clip.type === 'audio') {
            if (isPastMediaEnd) {
              // The clip points past the end of the media: nothing left to play.
              if (!mediaEl.paused) {
                mediaEl.pause();
              }
            } else {
              if (Math.abs(mediaEl.currentTime - sourceOffset) > 0.2) {
                mediaEl.currentTime = sourceOffset;
              }

              if (Math.abs(mediaEl.playbackRate - speed) > 0.01) {
                mediaEl.playbackRate = speed;
              }
            }
          }

          // Apply volume factoring in clip volume, master volume, and transitions
          let transitionMultiplier = 1;
          if (clip.transition) {
            const { fadeInType, fadeInDuration, fadeOutType, fadeOutDuration } = clip.transition;
            const timeInClip = time - clip.start;
            const timeLeft = clip.start + clip.duration - time;

            if (fadeInDuration > 0 && timeInClip >= 0 && timeInClip < fadeInDuration) {
              if (fadeInType === 'fade-black' || fadeInType === 'fade-white') {
                transitionMultiplier *= Math.max(0, timeInClip / fadeInDuration);
              }
            }

            if (fadeOutDuration > 0 && timeLeft >= 0 && timeLeft < fadeOutDuration) {
              if (fadeOutType === 'fade-black' || fadeOutType === 'fade-white') {
                transitionMultiplier *= Math.max(0, timeLeft / fadeOutDuration);
              }
            }
          }

          const effectiveVolume = (clip.volume ?? 1) * this.masterVolume * transitionMultiplier;

          // Gain up to 100% is applied on the element; anything above is applied
          // through the Web Audio graph so that 200% is really 200% (E-04).
          const elementTarget = Math.min(Math.max(effectiveVolume, 0), 1);
          const graphTarget = effectiveVolume > 1 ? effectiveVolume : 1;
          if (graphTarget > 1) {
            this.routeElement(mediaEl, graphTarget);
          }
          const cachedVolume = this.elementVolumeCache.get(mediaEl);

          // Guard volume mutation: update only when delta >= 0.01 or at boundary values (0 or 1)
          if (
            cachedVolume === undefined ||
            Math.abs(cachedVolume - elementTarget) >= 0.01 ||
            (elementTarget === 0 && cachedVolume !== 0) ||
            (elementTarget === 1 && cachedVolume !== 1)
          ) {
            mediaEl.volume = elementTarget;
            this.elementVolumeCache.set(mediaEl, elementTarget);
          }

          // Guard muted mutation: update only when changed
          const targetMuted = clip.muted || isTrackMuted || this.masterVolume === 0;
          if (mediaEl.muted !== targetMuted) {
            mediaEl.muted = targetMuted;
          }

          if (clip.type === 'audio' && !isPastMediaEnd && mediaEl.paused) {
            this.tryPlay(mediaEl);
          }
        } else {
          if (clip.type === 'audio') {
            if (!mediaEl.paused) {
              mediaEl.pause();
            }
          } else if (clip.type === 'video') {
            // Guard: silence video audio at most once upon entering inactive state
            if (!mediaEl.muted) {
              mediaEl.muted = true;
            }
          }
        }
      }
    } catch {
      // Audio engine errors should never crash React rendering loop
    }
  }

  public setMasterVolume(vol: number): void {
    const clamped = Math.max(0, Math.min(vol, 1));
    if (this.masterVolume === clamped) return;
    this.masterVolume = clamped;
  }

  /**
   * Stops every media element.
   * The Web Audio routing is intentionally kept alive: the media elements are
   * permanently bound to their source node, tearing the graph down would keep
   * them silent forever.
   */
  public stopAll(): void {
    this.elementVolumeCache = new WeakMap();
    this.mediaMapCache.clear();
    this.trackMapCache.clear();
    this.failedElements = new WeakSet();
    this.playFailureCountMap = new WeakMap();
    this.nextPlayAttemptMap = new WeakMap();
    try {
      mediaSourcePool.pauseAll();
    } catch {
      // ignore
    }
  }
}

export const audioEngine = new AudioEngine();
