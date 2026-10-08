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
  private timelineStart: number = 0;
  private duration: number = 30; // Timeline max duration
  private animFrameId: number | null = null;

  private timeListeners: Set<TimeUpdateListener> = new Set();
  private stateListeners: Set<StateChangeListener> = new Set();

  constructor() {
    // AudioContext will be initialized on first user interaction to comply with autoplay policies
  }

  public getAudioContext(): AudioContext {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioCtxClass();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  public setDuration(duration: number): void {
    this.duration = Math.max(1, duration);
  }

  public getTime(): number {
    if (!this.isPlaying) {
      return this.timelineTime;
    }
    if (!this.audioCtx) return this.timelineTime;
    const elapsed = this.audioCtx.currentTime - this.audioCtxStart;
    const t = this.timelineStart + elapsed;
    if (t >= this.duration) {
      this.seek(this.duration);
      this.pause();
      return this.duration;
    }
    return t;
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

    this.audioCtxStart = ctx.currentTime;
    this.timelineStart = this.timelineTime;
    this.isPlaying = true;

    this.notifyState(true);
    this.startTickLoop();
  }

  public pause(): void {
    if (!this.isPlaying) return;
    this.timelineTime = this.getTime();
    this.isPlaying = false;

    if (this.animFrameId !== null) {
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

    if (this.isPlaying && this.audioCtx) {
      this.audioCtxStart = this.audioCtx.currentTime;
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
    const tick = () => {
      if (!this.isPlaying) return;
      const current = this.getTime();
      this.timelineTime = current;
      this.notifyTime(current);
      if (current < this.duration && this.isPlaying) {
        this.animFrameId = requestAnimationFrame(tick);
      }
    };
    this.animFrameId = requestAnimationFrame(tick);
  }
}

// Global master clock singleton
export const masterClock = new MasterClock();
