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

  private getMasterGain(): GainNode | null {
    if (!this.masterGain) {
      try {
        const ctx = masterClock.getAudioContext();
        if (!ctx) return null;
        this.masterGain = ctx.createGain();
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

      const mediaMap = new Map<string, MediaItem>();
      for (const m of mediaPool) mediaMap.set(m.id, m);

      const trackMap = new Map<string, Track>();
      for (const t of tracks) trackMap.set(t.id, t);

      // Update track gain muting
      for (const track of tracks) {
        const tg = this.getTrackGain(track.id);
        if (tg && tg.gain) {
          tg.gain.value = track.isMuted ? 0 : 1;
        }
      }

      // Process clips with audio
      for (const clip of clips) {
        if (clip.type !== 'audio' && clip.type !== 'video') continue;
        const media = mediaMap.get(clip.mediaId);
        if (!media) continue;

        const track = trackMap.get(clip.trackId);
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
          mediaEl.volume = Math.min(Math.max(effectiveVolume, 0), 1);
          mediaEl.muted = clip.muted || isTrackMuted || this.masterVolume === 0;

          if (clip.type === 'audio' && mediaEl.paused) {
            mediaEl.play().catch(() => {});
          }
        } else {
          if (clip.type === 'audio' && !mediaEl.paused) {
            mediaEl.pause();
          } else if (clip.type === 'video') {
            // If video clip is inactive or muted, ensure audio is silenced
            mediaEl.muted = true;
          }
        }
      }
    } catch {
      // Audio engine errors should never crash React rendering loop
    }
  }

  public setMasterVolume(vol: number): void {
    this.masterVolume = Math.max(0, Math.min(vol, 1));
    const g = this.getMasterGain();
    if (g && g.gain) {
      g.gain.value = this.masterVolume;
    }
  }

  public stopAll(): void {
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
