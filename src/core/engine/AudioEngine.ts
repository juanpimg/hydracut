import { Clip, MediaItem, Track } from '../../types/project';
import { masterClock } from './MasterClock';
import { mediaSourcePool } from './MediaSourcePool';

/**
 * AudioEngine manages audio playback and mixing across multitrack clips
 * using Web Audio API nodes.
 */
export class AudioEngine {
  private masterGain: GainNode | null = null;
  private trackGains: Map<string, GainNode> = new Map();
  private masterVolume: number = 1;

  // Zero-thrashing caches
  private trackMuteCache: Map<string, boolean> = new Map();
  private elementVolumeCache: WeakMap<HTMLMediaElement, number> = new WeakMap();
  private mediaMapCache: Map<string, MediaItem> = new Map();
  private trackMapCache: Map<string, Track> = new Map();

  private getMasterGain(): GainNode | null {
    if (!this.masterGain) {
      try {
        const ctx = masterClock.getAudioContext();
        if (!ctx) return null;
        this.masterGain = ctx.createGain();
        this.masterGain.gain.value = this.masterVolume;
        this.masterGain.connect(ctx.destination);
      } catch {
        this.masterGain = null;
      }
    }
    return this.masterGain;
  }

  private getTrackGain(trackId: string): GainNode | null {
    let gain = this.trackGains.get(trackId);
    if (!gain) {
      try {
        const ctx = masterClock.getAudioContext();
        if (!ctx) return null;
        gain = ctx.createGain();
        const master = this.getMasterGain();
        if (master) {
          gain.connect(master);
        }
        this.trackGains.set(trackId, gain);
      } catch {
        return null;
      }
    }
    return gain;
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
        ctx.resume().catch(() => {});
      }

      // Re-populate reusable map caches without heap allocation on every frame
      this.mediaMapCache.clear();
      for (const m of mediaPool) this.mediaMapCache.set(m.id, m);

      this.trackMapCache.clear();
      for (const t of tracks) this.trackMapCache.set(t.id, t);

      // Update track gain muting ONLY when state changed
      for (const track of tracks) {
        const cachedMute = this.trackMuteCache.get(track.id);
        if (cachedMute !== track.isMuted) {
          this.trackMuteCache.set(track.id, track.isMuted);
          const tg = this.getTrackGain(track.id);
          if (tg && tg.gain) {
            tg.gain.value = track.isMuted ? 0 : 1;
          }
        }
      }

      // Process clips with audio
      for (const clip of clips) {
        if (clip.type !== 'audio' && clip.type !== 'video') continue;
        const media = this.mediaMapCache.get(clip.mediaId);
        if (!media) continue;

        const track = this.trackMapCache.get(clip.trackId);
        const isTrackMuted = track ? track.isMuted : false;

        const mediaEl = clip.type === 'video'
          ? mediaSourcePool.getVideoElement(media, clip.id)
          : mediaSourcePool.getAudioElement(media, clip.id);

        if (!mediaEl) continue;

        const isActive = isPlaying && time >= clip.start && time < clip.start + clip.duration && !clip.muted && !isTrackMuted;

        if (isActive) {
          const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
          const sourceOffset = clip.sourceStart + (time - clip.start) * speed;
          
          // Sync media element
          if (clip.type === 'audio') {
            if (Math.abs(mediaEl.currentTime - sourceOffset) > 0.2) {
              mediaEl.currentTime = sourceOffset;
            }

            if (Math.abs(mediaEl.playbackRate - speed) > 0.01) {
              mediaEl.playbackRate = speed;
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
          const targetVolume = Math.min(Math.max(effectiveVolume, 0), 1);
          const cachedVolume = this.elementVolumeCache.get(mediaEl);

          // Guard volume mutation: update only when delta >= 0.01 or at boundary values (0 or 1)
          if (
            cachedVolume === undefined ||
            Math.abs(cachedVolume - targetVolume) >= 0.01 ||
            (targetVolume === 0 && cachedVolume !== 0) ||
            (targetVolume === 1 && cachedVolume !== 1)
          ) {
            mediaEl.volume = targetVolume;
            this.elementVolumeCache.set(mediaEl, targetVolume);
          }

          // Guard muted mutation: update only when changed
          const targetMuted = clip.muted || isTrackMuted || this.masterVolume === 0;
          if (mediaEl.muted !== targetMuted) {
            mediaEl.muted = targetMuted;
          }

          if (clip.type === 'audio' && mediaEl.paused) {
            mediaEl.play().catch(() => {});
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
    const g = this.getMasterGain();
    if (g && g.gain && g.gain.value !== this.masterVolume) {
      g.gain.value = this.masterVolume;
    }
  }

  public stopAll(): void {
    this.trackMuteCache.clear();
    this.elementVolumeCache = new WeakMap();
    this.mediaMapCache.clear();
    this.trackMapCache.clear();
    try {
      mediaSourcePool.pauseAll();
    } catch {
      // ignore
    }
    try {
      for (const gain of this.trackGains.values()) {
        try {
          gain.disconnect();
        } catch {
          // ignore
        }
      }
      this.trackGains.clear();
      if (this.masterGain) {
        try {
          this.masterGain.disconnect();
        } catch {
          // ignore
        }
        this.masterGain = null;
      }
    } catch {
      // ignore
    }
  }
}

export const audioEngine = new AudioEngine();
