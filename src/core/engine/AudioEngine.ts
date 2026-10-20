import { Clip, MediaItem, Track } from '../../types/project';
import { masterClock } from './MasterClock';
import { mediaSourcePool } from './MediaSourcePool';
import { resolvePlayback } from '../utils/playbackRate';
import { previewClipFadeGain } from '../utils/audioFades';
import {
  duckEnvelopeGain,
  getBiquadFilterSupport,
  getStereoPannerSupport,
  resolveClipAudioChain,
  resolveEqInto,
  resolvePan,
  createDuckIndexCache,
  refreshDuckIndex,
  type DuckIndexCache,
  type ResolvedClipAudioChain,
  type ResolvedEq,
} from '../utils/audioEffects';
import {
  createCrossfadeIndexCache,
  crossfadeInGain,
  crossfadeOutGain,
  refreshCrossfadeIndex,
  type CrossfadeIndexCache,
} from '../utils/crossfade';

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

/**
 * Epsilon of the element-volume cache while a clip is INSIDE an audio fade.
 *
 * The idle path only rewrites `HTMLMediaElement.volume` when the delta is
 * >= 0.01 (see `07-perf-resources.md`: no 60 Hz DOM thrash of inaudible
 * deltas). A fade genuinely moves every frame, so that step would stair-step
 * the ramp; the fading path therefore uses a tight epsilon instead. The
 * write is still guarded (an identical value is never rewritten), so the
 * no-thrash contract holds: one DOM write per frame at most, only while the
 * gain really changes.
 */
const FADE_ACTIVE_VOLUME_EPSILON = 0.0001;

/** Epsilon del parámetro `pan` (el deslizador va en pasos de 0.01). */
const PAN_PARAM_EPSILON = 0.001;

/** Epsilon de las ganancias de EQ en dB (por debajo es inaudible). */
const EQ_DB_PARAM_EPSILON = 0.05;

/** A media element routed through the Web Audio graph. */
interface RoutedElement {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  /** EQ de 3 bandas en serie (`null` = el contexto no soporta biquads). */
  eqLow: BiquadFilterNode | null;
  eqMid: BiquadFilterNode | null;
  eqHigh: BiquadFilterNode | null;
  /** Paneo (`null` = el contexto no soporta `StereoPannerNode`). */
  panner: StereoPannerNode | null;
  /** Últimos parámetros aplicados (cero thrash: solo se escriben al cambiar). */
  lastPan: number;
  lastLow: number;
  lastMid: number;
  lastHigh: number;
  ctx: AudioContext;
}

/**
 * La cadena de audio que el PREVIEW deriva de un clip (paneo / EQ / duck).
 *
 * Llama a `resolveClipAudioChain` — LA MISMA función que usa el export —, así
 * que ambos caminos reciben los mismos números por construcción (el test de
 * paridad lo comprueba literalmente). Camino frío / tests: puede asignar.
 */
export function resolvePreviewAudioChain(clip: Clip): ResolvedClipAudioChain {
  return resolveClipAudioChain(clip, {
    panner: getStereoPannerSupport(),
    biquad: getBiquadFilterSupport(),
  });
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

  /**
   * F5 · Crossfade spans by clip id, rebuilt ONCE per clip change (the same
   * rule as the compositor: `refreshCrossfadeIndex` never allocates when the
   * relevant content did not change, so the zero-Map-allocation contract of
   * `updateAudio` holds frame after frame).
   */
  private crossfadeCache: CrossfadeIndexCache = createCrossfadeIndexCache();

  /**
   * Intervalos de diálogo audible, reconstruidos UNA VEZ por cambio (misma
   * disciplina que el crossfade: `refreshDuckIndex` no asigna cuando nada
   * relevante cambió). El `duckEnvelopeGain` por frame es aritmética escalar
   * sobre este índice.
   */
  private duckCache: DuckIndexCache = createDuckIndexCache();

  /**
   * Scratch reutilizable para la EQ del clip activo (ver `resolveEqInto`): el
   * camino caliente no asigna el objeto de la EQ en cada frame.
   */
  private eqScratch: ResolvedEq = { low: 0, mid: 0, high: 0 };

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
   * 100% can be honoured (`HTMLMediaElement.volume` is hard capped at 1) and
   * so that the per-clip pan / 3-band EQ can be applied.
   *
   * The chain is `source → eqLow → eqMid → eqHigh → panner → gain →
   * destination` (a missing node type is skipped when the context does not
   * support it: no panning/EQ there, exactly like the export degrades).
   * Every parameter after the first build is only rewritten when it really
   * changed (same zero-thrash discipline as the element volume).
   *
   * Returns false when no graph is available: the caller then falls back to the
   * element level gain, which is capped at 100%.
   *
   * Hot path: only scalar parameters, no allocations.
   */
  private routeElement(
    el: HTMLMediaElement,
    gainValue: number,
    pan: number,
    eqLow: number,
    eqMid: number,
    eqHigh: number
  ): boolean {
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
        const canBiquad = typeof ctx.createBiquadFilter === 'function';
        const canPan = typeof ctx.createStereoPanner === 'function';
        let eqLowNode: BiquadFilterNode | null = null;
        let eqMidNode: BiquadFilterNode | null = null;
        let eqHighNode: BiquadFilterNode | null = null;
        if (canBiquad) {
          eqLowNode = ctx.createBiquadFilter();
          eqLowNode.type = 'lowshelf';
          eqLowNode.frequency.value = 320;
          eqMidNode = ctx.createBiquadFilter();
          eqMidNode.type = 'peaking';
          eqMidNode.frequency.value = 1000;
          eqMidNode.Q.value = 1;
          eqHighNode = ctx.createBiquadFilter();
          eqHighNode.type = 'highshelf';
          eqHighNode.frequency.value = 3200;
        }
        let pannerNode: StereoPannerNode | null = null;
        if (canPan) {
          pannerNode = ctx.createStereoPanner();
          pannerNode.pan.value = 0;
        }
        // source → eqLow → eqMid → eqHigh → panner → gain → destination.
        let head: AudioNode = source;
        if (eqLowNode) {
          head.connect(eqLowNode);
          head = eqLowNode;
        }
        if (eqMidNode) {
          head.connect(eqMidNode);
          head = eqMidNode;
        }
        if (eqHighNode) {
          head.connect(eqHighNode);
          head = eqHighNode;
        }
        if (pannerNode) {
          head.connect(pannerNode);
          head = pannerNode;
        }
        head.connect(gain);
        gain.connect(ctx.destination);
        routed = {
          source,
          gain,
          eqLow: eqLowNode,
          eqMid: eqMidNode,
          eqHigh: eqHighNode,
          panner: pannerNode,
          lastPan: 0,
          lastLow: 0,
          lastMid: 0,
          lastHigh: 0,
          ctx,
        };
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
    if (routed.panner && Math.abs(routed.lastPan - pan) > PAN_PARAM_EPSILON) {
      routed.panner.pan.value = pan;
      routed.lastPan = pan;
    }
    if (routed.eqLow && Math.abs(routed.lastLow - eqLow) > EQ_DB_PARAM_EPSILON) {
      routed.eqLow.gain.value = eqLow;
      routed.lastLow = eqLow;
    }
    if (routed.eqMid && Math.abs(routed.lastMid - eqMid) > EQ_DB_PARAM_EPSILON) {
      routed.eqMid.gain.value = eqMid;
      routed.lastMid = eqMid;
    }
    if (routed.eqHigh && Math.abs(routed.lastHigh - eqHigh) > EQ_DB_PARAM_EPSILON) {
      routed.eqHigh.gain.value = eqHigh;
      routed.lastHigh = eqHigh;
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

      // F5: the crossfade index is refreshed once per clip change, never
      // per frame (zero allocations when nothing relevant changed).
      refreshCrossfadeIndex(this.crossfadeCache, clips);

      // Ducking: the dialogue intervals are rebuilt ONCE per clip/track
      // change, never per frame (same discipline as the crossfade index).
      refreshDuckIndex(this.duckCache, clips, tracks);

      // The support is read once per frame (cached probes, no allocation):
      // every active clip of this frame degrades identically.
      const pannerSupported = getStereoPannerSupport();
      const biquadSupported = getBiquadFilterSupport();

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

          // F5: crossfade with the neighbour clip of the same track. Both
          // clips are physically active over the shared region (the overlap
          // is deliberate), so both stay audible and are mixed by the LINEAR
          // curve shared with the video path and the exporter
          // (`out = 1 - p`, `in = p`). Each gain stays <= 1 and
          // `out + in = 1`, so the mixed amplitude never exceeds the loudest
          // source: no clipping beyond what a single clip could produce.
          // Scalar arithmetic only: nothing is allocated on the hot path.
          const xfSpan = this.crossfadeCache.spans.get(clip.id);
          if (
            xfSpan &&
            xfSpan.duration > 0 &&
            time >= xfSpan.regionStart &&
            time < xfSpan.regionEnd
          ) {
            const xfProgress = (time - xfSpan.regionStart) / xfSpan.duration;
            transitionMultiplier *=
              xfSpan.role === 'out' ? crossfadeOutGain(xfProgress) : crossfadeInGain(xfProgress);
          }

          // Fundidos de audio por clip: la envolvente 0..1 de
          // `previewClipFadeGain` (la MISMA función que muestrea el export)
          // multiplica la ganancia. Sin fundidos el coste es dos lecturas de
          // campo y la llamada ni siquiera ocurre; con fundidos es aritmética
          // escalar sin asignaciones (contrato de cero asignaciones por frame).
          const hasAudioFade =
            (clip.audioFadeIn?.duration ?? 0) > 0 || (clip.audioFadeOut?.duration ?? 0) > 0;
          const fadeMultiplier = hasAudioFade ? previewClipFadeGain(clip, time) : 1;

          // Efectos de audio por clip (camino caliente: escalares, sin
          // asignaciones). El paneo degrada al centro sin soporte; la EQ se
          // resuelve en el scratch reutilizable; el ducking es una ganancia
          // evaluada sobre el índice en caché (la MISMA función que el export
          // muestrea para su `GainNode` dedicado).
          const effects = clip.audioEffects;
          const pan = resolvePan(effects, pannerSupported);
          resolveEqInto(biquadSupported ? effects : undefined, this.eqScratch);
          const isDucked = effects?.duck === true;
          const duckGain = isDucked
            ? duckEnvelopeGain(time, true, clip.trackId, this.duckCache.intervals)
            : 1;

          const effectiveVolume =
            (clip.volume ?? 1) *
            this.masterVolume *
            transitionMultiplier *
            fadeMultiplier *
            duckGain;

          // Gain up to 100% is applied on the element; anything above is applied
          // through the Web Audio graph so that 200% is really 200% (E-04).
          // A clip with an active pan or EQ is routed too (otherwise the
          // effect would never sound); ducking needs no graph (it only
          // attenuates, like a fade).
          const elementTarget = Math.min(Math.max(effectiveVolume, 0), 1);
          const graphTarget = effectiveVolume > 1 ? effectiveVolume : 1;
          const needsGraph =
            pan !== 0 ||
            this.eqScratch.low !== 0 ||
            this.eqScratch.mid !== 0 ||
            this.eqScratch.high !== 0;
          if (graphTarget > 1 || needsGraph) {
            this.routeElement(
              mediaEl,
              graphTarget,
              pan,
              this.eqScratch.low,
              this.eqScratch.mid,
              this.eqScratch.high
            );
          }
          const cachedVolume = this.elementVolumeCache.get(mediaEl);

          // Guard volume mutation: update only when delta >= 0.01 or at boundary values (0 or 1).
          // A clip INSIDE its fade uses FADE_ACTIVE_VOLUME_EPSILON instead: the
          // gain genuinely moves every frame and the 0.01 step would stair-step
          // the ramp. The write stays guarded (identical values are never
          // rewritten), so this is not 60 Hz DOM thrash. A ducking ramp moves
          // the same way, so it shares the tight epsilon.
          const fadeActive = fadeMultiplier > 0 && fadeMultiplier < 1;
          const duckActive = duckGain > 0 && duckGain < 1;
          const volumeEpsilon = fadeActive || duckActive ? FADE_ACTIVE_VOLUME_EPSILON : 0.01;
          if (
            cachedVolume === undefined ||
            Math.abs(cachedVolume - elementTarget) >= volumeEpsilon ||
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
    this.crossfadeCache = createCrossfadeIndexCache();
    this.duckCache = createDuckIndexCache();
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
