import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { Clip, ExportConfig, ExportProgress, MediaItem, Track } from '../../types/project';
import { Compositor } from '../engine/Compositor';
import { mediaSourcePool } from '../engine/MediaSourcePool';

export interface ExportParams {
  config: ExportConfig;
  duration: number;
  tracks: Track[];
  clips: Clip[];
  mediaPool: MediaItem[];
  onProgress: (progress: ExportProgress) => void;
  signal?: AbortSignal;
}

/**
 * Checks if WebCodecs VideoEncoder is supported in this browser environment.
 */
export async function isWebCodecsSupported(): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return false;
  }
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: 'avc1.640028',
      width: 1920,
      height: 1080,
    });
    return !!support.supported;
  } catch {
    return false;
  }
}

/**
 * Waits for the encoder queue to drain to prevent memory exhaustion (backpressure).
 */
function waitForEncoderDrain(encoder: VideoEncoder, maxQueue = 3): Promise<void> {
  if (encoder.encodeQueueSize <= maxQueue) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const onDequeue = () => {
      if (encoder.encodeQueueSize <= maxQueue) {
        encoder.removeEventListener('dequeue', onDequeue);
        resolve();
      }
    };
    encoder.addEventListener('dequeue', onDequeue);
  });
}

/**
 * Seeks a video element and waits for seeked event.
 */
function seekVideoElement(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const doSeek = () => {
      if (Math.abs(video.currentTime - time) < 0.03) {
        resolve();
        return;
      }
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked, { once: true });
      video.currentTime = time;

      // Timeout safety
      setTimeout(() => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      }, 300);
    };

    if (video.readyState >= 1) {
      doSeek();
    } else {
      const onLoaded = () => {
        video.removeEventListener('loadedmetadata', onLoaded);
        doSeek();
      };
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      setTimeout(() => {
        video.removeEventListener('loadedmetadata', onLoaded);
        doSeek();
      }, 500);
    }
  });
}

/**
 * Mixes audio from all audio/video clips into an AudioBuffer using OfflineAudioContext.
 */
async function renderOfflineAudio(
  totalDuration: number,
  tracks: Track[],
  clips: Clip[],
  mediaPool: MediaItem[]
): Promise<AudioBuffer | null> {
  const trackMap = new Map<string, Track>();
  for (const t of tracks) trackMap.set(t.id, t);

  const audioClips = clips.filter((c) => {
    const track = trackMap.get(c.trackId);
    return (
      (c.type === 'audio' || c.type === 'video') &&
      !c.muted &&
      c.volume > 0 &&
      (!track || !track.isMuted)
    );
  });
  if (audioClips.length === 0 || totalDuration <= 0) return null;

  const sampleRate = 48000;
  const offlineCtx = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);
  const mediaMap = new Map<string, MediaItem>();
  for (const m of mediaPool) mediaMap.set(m.id, m);

  let hasValidAudio = false;

  for (const clip of audioClips) {
    const media = mediaMap.get(clip.mediaId);
    if (!media) continue;

    try {
      // Fetch audio data
      const response = await fetch(media.url);
      const arrayBuffer = await response.arrayBuffer();
      const decodedBuffer = await offlineCtx.decodeAudioData(arrayBuffer);

      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
      const sourceNode = offlineCtx.createBufferSource();
      sourceNode.buffer = decodedBuffer;
      sourceNode.playbackRate.value = speed;

      const gainNode = offlineCtx.createGain();
      const baseVol = clip.volume ?? 1;

      // Transitions for audio fade-in and fade-out
      if (clip.transition) {
        const { fadeInType, fadeInDuration, fadeOutType, fadeOutDuration } = clip.transition;
        const totalFade = (fadeInDuration > 0 ? fadeInDuration : 0) + (fadeOutDuration > 0 ? fadeOutDuration : 0);
        const scale = totalFade > clip.duration ? clip.duration / totalFade : 1;
        const effectiveIn = (fadeInDuration || 0) * scale;
        const effectiveOut = (fadeOutDuration || 0) * scale;

        const hasInFade = effectiveIn > 0 && (fadeInType === 'fade-black' || fadeInType === 'fade-white');
        const hasOutFade = effectiveOut > 0 && (fadeOutType === 'fade-black' || fadeOutType === 'fade-white');

        if (hasInFade) {
          gainNode.gain.setValueAtTime(0, clip.start);
          gainNode.gain.linearRampToValueAtTime(baseVol, clip.start + effectiveIn);
        } else {
          gainNode.gain.setValueAtTime(baseVol, clip.start);
        }

        if (hasOutFade) {
          const fadeOutStart = clip.start + clip.duration - effectiveOut;
          if (!hasInFade || fadeOutStart > clip.start + effectiveIn) {
            gainNode.gain.setValueAtTime(baseVol, fadeOutStart);
          }
          gainNode.gain.linearRampToValueAtTime(0, clip.start + clip.duration);
        }
      } else {
        gainNode.gain.setValueAtTime(baseVol, clip.start);
      }

      sourceNode.connect(gainNode);
      gainNode.connect(offlineCtx.destination);

      const offset = Math.min(clip.sourceStart, Math.max(0, decodedBuffer.duration - 0.01));
      const bufferDurationAvailable = Math.max(0, decodedBuffer.duration - offset);
      const playDuration = Math.min(clip.duration * speed, bufferDurationAvailable);
      if (playDuration > 0) {
        sourceNode.start(clip.start, offset, playDuration / speed);
        hasValidAudio = true;
      }
    } catch {
      // Ignore clips whose audio cannot be decoded
    }
  }

  if (!hasValidAudio) return null;
  return await offlineCtx.startRendering();
}

/**
 * Main export function using WebCodecs + mp4-muxer with MediaRecorder fallback.
 */
export async function exportVideo(params: ExportParams): Promise<Blob> {
  const fps = params.config.fps || 30;
  const totalFrames = Math.max(1, Math.round(params.duration * fps));
  const startTime = performance.now();

  const webCodecsSupported = await isWebCodecsSupported();

  if (webCodecsSupported) {
    return await exportWithWebCodecs(params, totalFrames, startTime);
  } else {
    // Fallback: Canvas captureStream + MediaRecorder
    return await exportWithMediaRecorder(params, totalFrames);
  }
}

/**
 * Hardware-accelerated WebCodecs export.
 */
async function exportWithWebCodecs(
  params: ExportParams,
  totalFrames: number,
  renderStartTime: number
): Promise<Blob> {
  const { config, duration, tracks, clips, mediaPool, onProgress, signal } = params;
  const fps = config.fps || 30;
  // Ensure even dimensions for H.264 hardware encoders
  const width = config.width - (config.width % 2);
  const height = config.height - (config.height % 2);

  // 1. Prepare offline audio if available
  let renderedAudio: AudioBuffer | null = null;
  try {
    renderedAudio = await renderOfflineAudio(duration, tracks, clips, mediaPool);
  } catch (err) {
    console.warn('Offline audio render failed, exporting video without audio:', err);
  }

  // Pre-validate AudioEncoder if audio is present
  let hasAudioEncoder = false;
  if (renderedAudio && typeof AudioEncoder !== 'undefined') {
    try {
      const audioSupport = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        numberOfChannels: 2,
        sampleRate: renderedAudio.sampleRate,
        bitrate: 192_000,
      });
      hasAudioEncoder = !!audioSupport.supported;
    } catch {
      hasAudioEncoder = false;
    }
  }

  // 2. Setup mp4-muxer
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width,
      height,
    },
    audio: hasAudioEncoder && renderedAudio
      ? {
          codec: 'aac',
          numberOfChannels: 2,
          sampleRate: renderedAudio.sampleRate,
        }
      : undefined,
    fastStart: 'in-memory',
  });

  // 3. Setup VideoEncoder
  let encoderError: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encoderError = e;
      console.error('VideoEncoder error:', e);
    },
  });

  videoEncoder.configure({
    codec: 'avc1.640028',
    width,
    height,
    bitrate: config.bitrate || 6_000_000,
    framerate: fps,
    hardwareAcceleration: 'prefer-hardware',
  });

  // 4. Setup AudioEncoder & encode audio in standard chunks
  let audioEncoder: AudioEncoder | null = null;
  if (hasAudioEncoder && renderedAudio) {
    try {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => console.error('AudioEncoder error:', e),
      });
      audioEncoder.configure({
        codec: 'mp4a.40.2', // AAC LC
        numberOfChannels: 2,
        sampleRate: renderedAudio.sampleRate,
        bitrate: 192_000,
      });

      const numFrames = renderedAudio.length;
      const left = renderedAudio.getChannelData(0);
      const right = renderedAudio.numberOfChannels > 1 ? renderedAudio.getChannelData(1) : left;

      // AAC encodes chunks in standard frame sizes (e.g. 2048 samples)
      const chunkSize = 2048;
      for (let offset = 0; offset < numFrames; offset += chunkSize) {
        if (signal?.aborted) break;
        const framesInChunk = Math.min(chunkSize, numFrames - offset);
        const chunkData = new Float32Array(framesInChunk * 2);

        // Planar format: Channel 0 (left) samples, followed by Channel 1 (right) samples
        for (let i = 0; i < framesInChunk; i++) {
          chunkData[i] = left[offset + i];
          chunkData[framesInChunk + i] = right[offset + i];
        }

        const timestampUs = Math.round((offset / renderedAudio.sampleRate) * 1_000_000);
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: renderedAudio.sampleRate,
          numberOfFrames: framesInChunk,
          numberOfChannels: 2,
          timestamp: timestampUs,
          data: chunkData.buffer,
        });

        try {
          audioEncoder.encode(audioData);
        } finally {
          audioData.close();
        }
      }

      await audioEncoder.flush();
    } catch (err) {
      console.warn('AudioEncoder failed, proceeding with video only:', err);
      audioEncoder = null;
    }
  }

  // 5. Offscreen canvas & compositor
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const compositor = new Compositor();

  const mediaMap = new Map<string, MediaItem>();
  for (const m of mediaPool) mediaMap.set(m.id, m);

  // 6. Frame rendering loop
  try {
    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      if (signal?.aborted) {
        throw new Error('Exportación cancelada por el usuario');
      }
      if (encoderError) {
        throw encoderError;
      }

      const t = frameIdx / fps;

      // Pre-seek any active video clips at this frame (supporting clip.speed)
      const activeVideoClips = clips.filter(
        (c) => c.type === 'video' && t >= c.start && t < c.start + c.duration
      );
      for (const vc of activeVideoClips) {
        const media = mediaMap.get(vc.mediaId);
        if (media) {
          const videoEl = mediaSourcePool.getVideoElement(media);
          const speed = vc.speed && vc.speed > 0 ? vc.speed : 1;
          const sourceOffset = vc.sourceStart + (t - vc.start) * speed;
          const maxSourceTime = Math.max(0, (media.duration || 1000) - 0.05);
          const clampedOffset = Math.max(0, Math.min(maxSourceTime, sourceOffset));
          await seekVideoElement(videoEl, clampedOffset);
        }
      }

      // Render frame to canvas
      compositor.renderFrame({
        time: t,
        canvas,
        tracks,
        clips,
        mediaPool,
        isPlaying: false,
      });

      // Control backpressure
      await waitForEncoderDrain(videoEncoder, 3);

      // Create VideoFrame & encode strictly protected with try...finally
      const timestampUs = Math.round(t * 1_000_000);
      const videoFrame = new VideoFrame(canvas, { timestamp: timestampUs });
      try {
        videoEncoder.encode(videoFrame, { keyFrame: frameIdx % (fps * 2) === 0 });
      } finally {
        videoFrame.close();
      }

      // Progress reporting & ETA
      const progressPercent = Math.round(((frameIdx + 1) / totalFrames) * 95);
      const elapsedSecs = (performance.now() - renderStartTime) / 1000;
      const framesDone = frameIdx + 1;
      const fpsSpeed = framesDone / Math.max(0.001, elapsedSecs);
      const etaSeconds = Math.max(0, Math.round((totalFrames - framesDone) / Math.max(0.1, fpsSpeed)));

      onProgress({
        state: 'rendering',
        progress: progressPercent,
        currentFrame: framesDone,
        totalFrames,
        etaSeconds,
      });
    }

    // 7. Flush encoders and finalize muxer
    onProgress({
      state: 'muxing',
      progress: 98,
      currentFrame: totalFrames,
      totalFrames,
      etaSeconds: 1,
    });

    await videoEncoder.flush();
    muxer.finalize();
  } finally {
    if (videoEncoder.state !== 'closed') {
      videoEncoder.close();
    }
    if (audioEncoder && audioEncoder.state !== 'closed') {
      audioEncoder.close();
    }
  }

  const buffer = target.buffer;
  const outputBlob = new Blob([buffer], { type: 'video/mp4' });

  onProgress({
    state: 'completed',
    progress: 100,
    currentFrame: totalFrames,
    totalFrames,
    etaSeconds: 0,
    outputBlob,
  });

  return outputBlob;
}

/**
 * Fallback export using MediaRecorder.
 */
async function exportWithMediaRecorder(
  params: ExportParams,
  totalFrames: number
): Promise<Blob> {
  const { config, duration, tracks, clips, mediaPool, onProgress, signal } = params;
  const fps = config.fps || 30;
  const width = config.width - (config.width % 2);
  const height = config.height - (config.height % 2);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const compositor = new Compositor();

  const stream = canvas.captureStream(fps);

  // Render offline audio if available and attach to MediaStream
  let offlineAudioCtx: AudioContext | null = null;
  try {
    const renderedAudio = await renderOfflineAudio(duration, tracks, clips, mediaPool);
    if (renderedAudio) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      offlineAudioCtx = new AudioCtx();
      const dest = offlineAudioCtx.createMediaStreamDestination();
      const source = offlineAudioCtx.createBufferSource();
      source.buffer = renderedAudio;
      source.connect(dest);
      for (const t of dest.stream.getAudioTracks()) {
        stream.addTrack(t);
      }
      source.start(0);
    }
  } catch (err) {
    console.warn('Could not attach audio to MediaRecorder stream:', err);
  }

  let mimeType = 'video/mp4';
  if (!MediaRecorder.isTypeSupported('video/mp4')) {
    mimeType = 'video/webm;codecs=vp9';
  }
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm';
  }

  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: config.bitrate });
  const chunks: Blob[] = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.start();

  return new Promise<Blob>((resolve, reject) => {
    let frameIdx = 0;
    const intervalMs = 1000 / fps;

    const intervalId = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(intervalId);
        recorder.stop();
        if (offlineAudioCtx) offlineAudioCtx.close().catch(() => {});
        reject(new Error('Exportación cancelada'));
        return;
      }

      if (frameIdx >= totalFrames) {
        clearInterval(intervalId);
        recorder.onstop = () => {
          if (offlineAudioCtx) offlineAudioCtx.close().catch(() => {});
          const finalBlob = new Blob(chunks, { type: mimeType });
          onProgress({
            state: 'completed',
            progress: 100,
            currentFrame: totalFrames,
            totalFrames,
            etaSeconds: 0,
            outputBlob: finalBlob,
          });
          resolve(finalBlob);
        };
        recorder.stop();
        return;
      }

      const t = frameIdx / fps;
      compositor.renderFrame({
        time: t,
        canvas,
        tracks,
        clips,
        mediaPool,
        isPlaying: false,
      });

      frameIdx++;
      const progressPercent = Math.round((frameIdx / totalFrames) * 98);
      onProgress({
        state: 'rendering',
        progress: progressPercent,
        currentFrame: frameIdx,
        totalFrames,
        etaSeconds: Math.round(((totalFrames - frameIdx) * intervalMs) / 1000),
      });
    }, intervalMs);
  });
}
