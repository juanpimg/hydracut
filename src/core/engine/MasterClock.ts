export type TimeUpdateListener = (time: number) => void;
export type StateChangeListener = (isPlaying: boolean) => void;

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

  private timeListeners: Set<TimeUpdateListener> = new Set();
  private stateListeners: Set<StateChangeListener> = new Set();

  constructor() {
    // AudioContext will be initialized on first user interaction to comply with autoplay policies
  }

  public getAudioContext(): AudioContext | null {
    if (!this.audioCtx) {
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
        }
      } catch {
        this.audioCtx = null;
      }
    }
    return this.audioCtx;
  }

  public setDuration(duration: number): void {
    this.duration = Math.max(1, duration);
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

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const perfElapsed = (now - this.perfStart) / 1000;

    let elapsed: number;
    if (this.audioCtx && this.audioCtx.state === 'running') {
      const audioElapsed = this.audioCtx.currentTime - this.audioCtxStart;
      // If audio clock has stalled (e.g. mobile energy-saving, throttled audio, or mock),
      // or if drift between wall clock and audio clock exceeds 250ms, fallback to performance.now
      if (audioElapsed <= 0 && perfElapsed > 0.05) {
        elapsed = perfElapsed;
      } else if (Math.abs(perfElapsed - audioElapsed) > 0.25) {
        elapsed = perfElapsed;
      } else {
        elapsed = audioElapsed;
      }
    } else {
      elapsed = perfElapsed;
    }

    if (elapsed < 0) elapsed = 0;
    const t = this.timelineStart + elapsed;
    return Math.max(0, Math.min(t, this.duration));
  }

  public getTime(): number {
    if (!this.isPlaying) {
      return this.timelineTime;
    }
    const current = this.calculateCurrentTime();
    if (current >= this.duration) {
      this.pause();
      return this.duration;
    }
    return current;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public play(): void {
    if (this.isPlaying) return;
    const ctx = this.getAudioContext();
    
    // If at end, loop back to start
    if (this.timelineTime >= this.duration) {
      this.timelineTime = 0;
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.perfStart = now;
    this.audioCtxStart = ctx ? ctx.currentTime : 0;
    this.timelineStart = this.timelineTime;
    this.isPlaying = true;

    if (ctx && ctx.state === 'suspended') {
      ctx.resume().then(() => {
        if (this.isPlaying && this.audioCtx) {
          this.audioCtxStart = this.audioCtx.currentTime;
          this.timelineStart = this.calculateCurrentTime();
          this.perfStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
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
      if (this.audioCtx) {
        this.audioCtxStart = this.audioCtx.currentTime;
      }
      this.perfStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this.timelineStart = clamped;
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
      const current = this.getTime();
      this.timelineTime = current;
      this.notifyTime(current);
      if (current < this.duration && this.isPlaying && typeof requestAnimationFrame !== 'undefined') {
        this.animFrameId = requestAnimationFrame(tick);
      }
    };
    this.animFrameId = requestAnimationFrame(tick);
  }
}

// Global master clock singleton
export const masterClock = new MasterClock();
