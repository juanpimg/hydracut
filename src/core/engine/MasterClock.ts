export type TimeUpdateListener = (time: number) => void;
export type StateChangeListener = (isPlaying: boolean) => void;

/**
 * Which clock currently drives the timeline.
 * - 'audio': AudioContext.currentTime (jitter free master clock)
 * - 'perf' : performance.now() (fallback, latched once the audio clock misbehaves)
 */
export type ClockSource = 'audio' | 'perf';

/** Maximum divergence tolerated between both clocks before failing over (seconds). */
export const CLOCK_DRIFT_TOLERANCE = 0.25;

/**
 * Wall clock time without any progress of the audio clock that declares the
 * audio clock frozen (seconds). A frozen (but previously healthy) clock is
 * detected here instead of waiting for the drift to exceed 250 ms (E-01).
 */
export const CLOCK_STALL_THRESHOLD = 0.05;

/**
 * MasterClock governs playback time using Web Audio API AudioContext.currentTime
 * as the jitter-free master clock.
 */
export class MasterClock {
  private audioCtx: AudioContext | null = null;
  private isPlaying: boolean = false;
  private timelineTime: number = 0;
  private audioCtxStart: number = 0;
  private perfStart: number = 0;
  private timelineStart: number = 0;
  private duration: number = 30; // Timeline max duration
  private animFrameId: number | null = null;

  // --- Dual clock failover state (E-01) ---
  /** Latched time base: once we leave the audio clock we never flip back mid playback. */
  private clockSource: ClockSource = 'audio';
  /** Last observed audio elapsed time (relative to audioCtxStart). */
  private lastAudioElapsed: number = 0;
  /** Wall clock elapsed time at the moment the audio clock last advanced. */
  private lastAudioProgressWallElapsed: number = 0;
  /** Last observed wall clock elapsed time (relative to perfStart). */
  private lastPerfElapsed: number = 0;
  /** Last time reported to the listeners (used to re-anchor without a jump). */
  private lastReportedTime: number = 0;
  /** False until the first sample of a playback run is taken. */
  private hasClockSample: boolean = false;
  /** True when a recovery attempt for a closed AudioContext already failed. */
  private audioCtxRecoveryAttempted: boolean = false;

  private timeListeners: Set<TimeUpdateListener> = new Set();
  private stateListeners: Set<StateChangeListener> = new Set();

  constructor() {
    // AudioContext will be initialized on first user interaction to comply with autoplay policies
  }

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * Returns the AudioContext, creating it on demand.
   * A context that reached the `closed` state is replaced (E-21): otherwise the
   * application would stay permanently silent. When the replacement is not
   * usable either, the clock keeps running on the wall clock and `null` is
   * returned so the caller knows that no audio graph is available.
   */
  public getAudioContext(): AudioContext | null {
    const existing = this.audioCtx;
    if (existing && existing.state !== 'closed') {
      this.audioCtxRecoveryAttempted = false;
      return existing;
    }
    if (existing && existing.state === 'closed') {
      if (this.audioCtxRecoveryAttempted) {
        // One recovery attempt already failed: stay on the wall clock.
        return null;
      }
      this.audioCtxRecoveryAttempted = true;
      this.audioCtx = null;
    }

    try {
      const AudioCtxClass =
        (typeof window !== 'undefined'
          ? window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : undefined) ||
        (typeof globalThis !== 'undefined'
          ? (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
            (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : undefined);

      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
        if (this.audioCtx.state === 'closed') {
          // The replacement is unusable as well.
          this.audioCtxRecoveryAttempted = true;
        }
      }
    } catch {
      this.audioCtx = null;
    }
    return this.audioCtx;
  }

  public setDuration(duration: number): void {
    this.duration = Math.max(1, duration);
  }

  /**
   * Re-anchors both time bases so that `timelineTime` is the timeline position
   * of the wall clock instant `now`.
   */
  private reanchor(now: number, timelineTime: number, clockSource: ClockSource): void {
    this.timelineStart = timelineTime;
    this.perfStart = now;
    this.audioCtxStart = this.audioCtx ? this.audioCtx.currentTime : 0;
    this.lastReportedTime = timelineTime;
    this.lastPerfElapsed = 0;
    this.lastAudioElapsed = 0;
    this.lastAudioProgressWallElapsed = 0;
    this.hasClockSample = false;
    this.clockSource = clockSource;
  }

  /**
   * Decides whether the audio clock can no longer be trusted.
   */
  private shouldFailOverToPerf(audioElapsed: number, perfElapsed: number): boolean {
    // The audio clock is stuck at (or before) its start value while the wall clock moved on.
    if (audioElapsed <= 0 && perfElapsed > CLOCK_STALL_THRESHOLD) return true;

    // Severe divergence: audio clock leap, throttling or a driver glitch.
    if (Math.abs(perfElapsed - audioElapsed) > CLOCK_DRIFT_TOLERANCE) return true;

    // The audio clock froze mid playback: it did not advance while the wall clock did.
    if (this.hasClockSample) {
      const stalledFor = perfElapsed - this.lastAudioProgressWallElapsed;
      const audioDelta = audioElapsed - this.lastAudioElapsed;
      if (stalledFor > CLOCK_STALL_THRESHOLD && audioDelta <= 0) return true;
    }

    return false;
  }

  /**
   * Latches the wall clock as the time base and re-anchors it so the reported
   * time stays continuous (no freeze, no jump) when the audio clock dies.
   */
  private failOverToPerfClock(now: number, perfElapsed: number): number {
    const wallDelta = Math.max(0, perfElapsed - this.lastPerfElapsed);
    const continuousTime = this.lastReportedTime + wallDelta;

    this.timelineStart = continuousTime;
    this.perfStart = now;
    this.clockSource = 'perf';
    this.lastReportedTime = continuousTime;
    this.lastPerfElapsed = 0;
    this.lastAudioElapsed = this.audioCtx ? this.audioCtx.currentTime - this.audioCtxStart : 0;
    this.lastAudioProgressWallElapsed = 0;
    this.hasClockSample = true;

    return continuousTime;
  }

  /**
   * Pure, side-effect-free calculation of current timeline time.
   * Uses dual-clock synchronization: tracks AudioContext.currentTime when healthy,
   * but falls back to performance.now() if AudioContext is null, suspended,
   * or stalled/throttled in mobile/background.
   */
  private calculateCurrentTime(): number {
    if (!this.isPlaying) {
      return this.timelineTime;
    }

    const now = this.now();
    const perfElapsed = (now - this.perfStart) / 1000;

    let timelineTime: number;

    if (this.clockSource === 'audio' && this.audioCtx && this.audioCtx.state === 'running') {
      const audioElapsed = this.audioCtx.currentTime - this.audioCtxStart;

      if (this.shouldFailOverToPerf(audioElapsed, perfElapsed)) {
        // Latched failover: the reported time continues from the last published
        // value, so the playhead neither freezes nor jumps.
        timelineTime = this.failOverToPerfClock(now, perfElapsed);
      } else {
        const audioAdvanced = !this.hasClockSample || audioElapsed > this.lastAudioElapsed + 0.0005;
        this.lastAudioElapsed = audioElapsed;
        this.lastPerfElapsed = perfElapsed;
        if (audioAdvanced) {
          // The audio clock is making progress: remember when it did.
          this.lastAudioProgressWallElapsed = perfElapsed;
        }
        timelineTime = this.timelineStart + Math.max(0, audioElapsed);
        this.lastReportedTime = timelineTime;
        this.hasClockSample = true;
      }
    } else {
      if (this.clockSource === 'audio') {
        // The audio clock became unusable (missing, suspended, interrupted or
        // closed). Latch the wall clock so we never flip back and forth.
        this.clockSource = 'perf';
      }
      this.lastPerfElapsed = perfElapsed;
      this.lastAudioElapsed = this.audioCtx ? this.audioCtx.currentTime - this.audioCtxStart : 0;
      timelineTime = this.timelineStart + Math.max(0, perfElapsed);
      this.lastReportedTime = timelineTime;
      this.hasClockSample = true;
    }

    if (timelineTime < 0) timelineTime = 0;
    return Math.max(0, Math.min(timelineTime, this.duration));
  }

  /**
   * Current timeline time. Side-effect free: it never pauses and never mutates
   * the playback state (E-15). It is safe to call from a React render.
   */
  public getTime(): number {
    if (!this.isPlaying) {
      return this.timelineTime;
    }
    return this.calculateCurrentTime();
  }

  /**
   * Advances the playback clock by one tick.
   * This is the only place that owns the "pause at the end of the timeline"
   * behaviour, so `getTime()` stays a pure getter (E-15).
   */
  public tick(): number {
    if (!this.isPlaying) {
      return this.timelineTime;
    }
    const current = this.calculateCurrentTime();
    if (current >= this.duration) {
      this.pause();
      return this.duration;
    }
    this.timelineTime = current;
    this.notifyTime(current);
    return current;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  /** Time base currently in use ('audio' or the latched 'perf' fallback). */
  public getClockSource(): ClockSource {
    return this.clockSource;
  }

  public play(): void {
    if (this.isPlaying) return;
    const ctx = this.getAudioContext();

    // If at end, loop back to start
    if (this.timelineTime >= this.duration) {
      this.timelineTime = 0;
    }

    this.reanchor(this.now(), this.timelineTime, 'audio');
    this.isPlaying = true;

    if (ctx && ctx.state === 'suspended') {
      ctx.resume().then(() => {
        if (this.isPlaying && this.audioCtx) {
          // The audio clock is healthy again: re-anchor on it without a jump.
          const current = this.calculateCurrentTime();
          this.reanchor(this.now(), current, 'audio');
        }
      }).catch(() => {});
    }

    this.notifyState(true);
    this.startTickLoop();
  }

  public pause(): void {
    if (!this.isPlaying) return;
    const finalTime = this.calculateCurrentTime();
    this.isPlaying = false;
    this.timelineTime = finalTime;

    if (this.animFrameId !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    this.notifyState(false);
    this.notifyTime(this.timelineTime);
  }

  public togglePlay(): void {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  public seek(targetTime: number): void {
    const clamped = Math.max(0, Math.min(targetTime, this.duration));
    this.timelineTime = clamped;

    if (this.isPlaying) {
      this.reanchor(this.now(), clamped, 'audio');
    }

    this.notifyTime(clamped);
  }

  public stepFrame(deltaFrames: number, fps: number = 30): void {
    if (this.isPlaying) this.pause();
    const frameDuration = 1 / fps;
    this.seek(this.timelineTime + deltaFrames * frameDuration);
  }

  public subscribeTime(listener: TimeUpdateListener): () => void {
    this.timeListeners.add(listener);
    return () => this.timeListeners.delete(listener);
  }

  public subscribeState(listener: StateChangeListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Closes the AudioContext and releases the clock. */
  public dispose(): void {
    if (this.isPlaying) this.pause();
    try {
      if (this.audioCtx && this.audioCtx.state !== 'closed') {
        void this.audioCtx.close?.();
      }
    } catch {
      // Ignore
    }
    this.audioCtx = null;
    this.audioCtxRecoveryAttempted = false;
  }

  private notifyTime(time: number): void {
    for (const listener of this.timeListeners) {
      listener(time);
    }
  }

  private notifyState(playing: boolean): void {
    for (const listener of this.stateListeners) {
      listener(playing);
    }
  }

  private startTickLoop(): void {
    if (typeof requestAnimationFrame === 'undefined') {
      return;
    }
    const tick = () => {
      if (!this.isPlaying) return;
      const current = this.tick();
      if (current < this.duration && this.isPlaying && typeof requestAnimationFrame !== 'undefined') {
        this.animFrameId = requestAnimationFrame(tick);
      }
    };
    this.animFrameId = requestAnimationFrame(tick);
  }
}

// Global master clock singleton
export const masterClock = new MasterClock();
