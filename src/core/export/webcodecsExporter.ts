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
 * Standard Rec.709 color space strictly matching mp4-muxer's internal mappings:
 * COLOR_PRIMARIES_MAP, TRANSFER_CHARACTERISTICS_MAP, and MATRIX_COEFFICIENTS_MAP.
 */
export const DEFAULT_COLOR_SPACE: VideoColorSpaceInit = {
  primaries: 'bt709',
  transfer: 'bt709',
  matrix: 'bt709',
  fullRange: false,
};

/**
 * Validates and sanitizes a VideoColorSpaceInit object to ensure it strictly matches
 * mp4-muxer's internal color maps. Prevents undefined / null / unsupported enum values
 * from crashing when mp4-muxer evaluates track.info.decoderConfig.colorSpace in colr(track).
 */
export function sanitizeColorSpace(cs?: VideoColorSpaceInit | null): VideoColorSpaceInit {
  if (!cs || typeof cs !== 'object') {
    return { ...DEFAULT_COLOR_SPACE };
  }
  const validPrimaries: VideoColorPrimaries[] = ['bt709', 'bt470bg', 'smpte170m'];
  const validTransfer: VideoTransferCharacteristics[] = ['bt709', 'smpte170m', 'iec61966-2-1'];
  const validMatrix: VideoMatrixCoefficients[] = ['rgb', 'bt709', 'bt470bg', 'smpte170m'];

  return {
    primaries:
      cs.primaries && validPrimaries.includes(cs.primaries as VideoColorPrimaries)
        ? (cs.primaries as VideoColorPrimaries)
        : 'bt709',
    transfer:
      cs.transfer && validTransfer.includes(cs.transfer as VideoTransferCharacteristics)
        ? (cs.transfer as VideoTransferCharacteristics)
        : 'bt709',
    matrix:
      cs.matrix && validMatrix.includes(cs.matrix as VideoMatrixCoefficients)
        ? (cs.matrix as VideoMatrixCoefficients)
        : 'bt709',
    fullRange: typeof cs.fullRange === 'boolean' ? cs.fullRange : false,
  };
}

/**
 * Extracts SPS (NAL unit type 7) and PPS (NAL unit type 8) from an H.264 chunk's byte buffer.
 * Supports both AVCC (4-byte length prefix) and Annex-B (00 00 01 / 00 00 00 01 start codes).
 */
export function extractSpsPpsFromChunk(chunkData: Uint8Array): {
  sps: Uint8Array | null;
  pps: Uint8Array | null;
} {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;

  if (!chunkData || chunkData.length < 5) return { sps, pps };

  const isAnnexB =
    (chunkData[0] === 0 && chunkData[1] === 0 && chunkData[2] === 1) ||
    (chunkData[0] === 0 && chunkData[1] === 0 && chunkData[2] === 0 && chunkData[3] === 1);

  if (isAnnexB) {
    let i = 0;
    while (i < chunkData.length) {
      let startCodeLen = 0;
      if (chunkData[i] === 0 && chunkData[i + 1] === 0) {
        if (chunkData[i + 2] === 1) {
          startCodeLen = 3;
        } else if (chunkData[i + 2] === 0 && chunkData[i + 3] === 1) {
          startCodeLen = 4;
        }
      }

      if (startCodeLen > 0) {
        const nalStart = i + startCodeLen;
        let nextStart = chunkData.length;
        for (let j = nalStart; j < chunkData.length - 2; j++) {
          if (
            chunkData[j] === 0 &&
            chunkData[j + 1] === 0 &&
            (chunkData[j + 2] === 1 || (chunkData[j + 2] === 0 && chunkData[j + 3] === 1))
          ) {
            nextStart = j;
            break;
          }
        }

        if (nalStart < nextStart) {
          const nalType = chunkData[nalStart] & 0x1f;
          if (nalType === 7 && !sps) {
            sps = chunkData.slice(nalStart, nextStart);
          } else if (nalType === 8 && !pps) {
            pps = chunkData.slice(nalStart, nextStart);
          }
        }
        i = nextStart;
      } else {
        i++;
      }
    }
  } else {
    // AVCC format: [4-byte big-endian length][NAL data]...
    let offset = 0;
    while (offset + 4 < chunkData.length) {
      const nalLength =
        ((chunkData[offset] << 24) >>> 0) +
        (chunkData[offset + 1] << 16) +
        (chunkData[offset + 2] << 8) +
        chunkData[offset + 3];

      const nalStart = offset + 4;
      const nalEnd = nalStart + nalLength;
      if (nalLength <= 0 || nalEnd > chunkData.length) break;

      const nalType = chunkData[nalStart] & 0x1f;
      if (nalType === 7 && !sps) {
        sps = chunkData.slice(nalStart, nalEnd);
      } else if (nalType === 8 && !pps) {
        pps = chunkData.slice(nalStart, nalEnd);
      }

      offset = nalEnd;
    }
  }

  return { sps, pps };
}

/**
 * Builds an ISO/IEC 14496-15 AVCDecoderConfigurationRecord buffer from SPS and PPS NAL units.
 */
export function buildAvcDecoderConfigurationRecord(
  sps: Uint8Array,
  pps: Uint8Array
): Uint8Array {
  const totalLength = 11 + sps.length + pps.length;
  const record = new Uint8Array(totalLength);
  const view = new DataView(record.buffer);

  record[0] = 1; // configurationVersion = 1
  record[1] = sps[1] ?? 0x64; // AVCProfileIndication (High Profile fallback)
  record[2] = sps[2] ?? 0x00; // profile_compatibility
  record[3] = sps[3] ?? 0x28; // AVCLevelIndication (Level 4.0 fallback)
  record[4] = 0xff; // lengthSizeMinusOne = 3 (indicates 4-byte NAL length)
  record[5] = 0xe1; // numOfSequenceParameterSets = 1
  view.setUint16(6, sps.length, false);
  record.set(sps, 8);

  const ppsPos = 8 + sps.length;
  record[ppsPos] = 1; // numOfPictureParameterSets = 1
  view.setUint16(ppsPos + 1, pps.length, false);
  record.set(pps, ppsPos + 3);

  return record;
}

/**
 * Generates a valid fallback AVCDecoderConfigurationRecord for H.264 High Profile Level 4.0 (1080p).
 */
export function getFallbackAvcDescription(_width = 1920, _height = 1080): Uint8Array {
  const sps = new Uint8Array([
    0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x5a, 0x80,
    0x80, 0x80, 0xa0, 0x00, 0x00, 0x03, 0x00, 0x20, 0x00, 0x00, 0x07, 0x81,
  ]);
  const pps = new Uint8Array([0x68, 0xee, 0x3c, 0x80]);
  return buildAvcDecoderConfigurationRecord(sps, pps);
}

/**
 * Dynamically queries VideoEncoder.isConfigSupported to find the best supported H.264 profile.
 * Prefers High Profile (avc1.640028), falls back to Main (avc1.4d002a) and Baseline (avc1.42001f).
 */
export async function getSupportedVideoCodec(width = 1920, height = 1080): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return null;
  }
  const codecsToTry = ['avc1.640028', 'avc1.4d002a', 'avc1.42001f'];
  for (const codec of codecsToTry) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
      });
      if (support.supported) {
        return codec;
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

/**
 * Checks if WebCodecs VideoEncoder is supported in this browser environment.
 */
export async function isWebCodecsSupported(): Promise<boolean> {
  return (await getSupportedVideoCodec()) !== null;
}

/**
 * Waits for the encoder queue to drain to prevent GPU/RAM memory exhaustion (backpressure).
 * Includes both dequeue event listener and an interval/timeout fallback to eliminate deadlocks.
 */
export function waitForEncoderDrain(encoder: VideoEncoder, maxQueue = 3): Promise<void> {
  if (encoder.encodeQueueSize <= maxQueue) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      encoder.removeEventListener('dequeue', onDequeue);
      if (timer) clearTimeout(timer);
      if (pollInterval) clearInterval(pollInterval);
    };

    const onDequeue = () => {
      if (encoder.encodeQueueSize <= maxQueue) {
        cleanup();
        resolve();
      }
    };

    encoder.addEventListener('dequeue', onDequeue);

    pollInterval = setInterval(() => {
      if (encoder.encodeQueueSize <= maxQueue) {
        cleanup();
        resolve();
      }
    }, 15);

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 1000);
  });
}

/**
 * Waits for the audio encoder queue to drain to prevent audio buffer buildup.
 */
export function waitForAudioDrain(encoder: AudioEncoder, maxQueue = 4): Promise<void> {
  if (encoder.encodeQueueSize <= maxQueue) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      encoder.removeEventListener('dequeue', onDequeue);
      if (timer) clearTimeout(timer);
      if (pollInterval) clearInterval(pollInterval);
    };

    const onDequeue = () => {
      if (encoder.encodeQueueSize <= maxQueue) {
        cleanup();
        resolve();
      }
    };

    encoder.addEventListener('dequeue', onDequeue);

    pollInterval = setInterval(() => {
      if (encoder.encodeQueueSize <= maxQueue) {
        cleanup();
        resolve();
      }
    }, 15);

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 800);
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
        const totalFade =
          (fadeInDuration > 0 ? fadeInDuration : 0) + (fadeOutDuration > 0 ? fadeOutDuration : 0);
        const scale = totalFade > clip.duration ? clip.duration / totalFade : 1;
        const effectiveIn = (fadeInDuration || 0) * scale;
        const effectiveOut = (fadeOutDuration || 0) * scale;

        const hasInFade =
          effectiveIn > 0 && (fadeInType === 'fade-black' || fadeInType === 'fade-white');
        const hasOutFade =
          effectiveOut > 0 && (fadeOutType === 'fade-black' || fadeOutType === 'fade-white');

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
 * Hardware-accelerated WebCodecs export with robust metadata sanitization and backpressure.
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

  // 2. Setup mp4-muxer with stream buffering and timestamp offsets
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width,
      height,
      frameRate: fps,
    },
    audio:
      hasAudioEncoder && renderedAudio
        ? {
            codec: 'aac',
            numberOfChannels: 2,
            sampleRate: renderedAudio.sampleRate,
          }
        : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  // Query best supported H.264 codec string
  const selectedCodec = (await getSupportedVideoCodec(width, height)) || 'avc1.640028';

  // 3. Active video decoder configuration tracking
  // In iOS Safari / WebKit, metadata from VideoEncoder output callback is frequently
  // omitted (undefined) or lacks decoderConfig/colorSpace. We maintain an active, valid
  // decoderConfig so mp4-muxer always receives non-null metadata with valid colorSpace.
  const activeDecoderConfig: VideoDecoderConfig = {
    codec: selectedCodec,
    codedWidth: width,
    codedHeight: height,
    colorSpace: { ...DEFAULT_COLOR_SPACE },
    description: getFallbackAvcDescription(width, height).buffer,
  };

  let encoderError: Error | null = null;

  const videoEncoder = new VideoEncoder({
    output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => {
      try {
        // Adopt incoming decoderConfig if emitted by browser
        if (meta?.decoderConfig) {
          if (meta.decoderConfig.codec) {
            activeDecoderConfig.codec = meta.decoderConfig.codec;
          }
          if (meta.decoderConfig.codedWidth) {
            activeDecoderConfig.codedWidth = meta.decoderConfig.codedWidth;
          }
          if (meta.decoderConfig.codedHeight) {
            activeDecoderConfig.codedHeight = meta.decoderConfig.codedHeight;
          }
          if (meta.decoderConfig.description) {
            activeDecoderConfig.description = meta.decoderConfig.description;
          }
          if (meta.decoderConfig.colorSpace) {
            activeDecoderConfig.colorSpace = sanitizeColorSpace(meta.decoderConfig.colorSpace);
          }
        }

        // On keyframe, extract SPS and PPS if description was not supplied out-of-band
        if (chunk.type === 'key') {
          try {
            const chunkData = new Uint8Array(chunk.byteLength);
            chunk.copyTo(chunkData);
            const { sps, pps } = extractSpsPpsFromChunk(chunkData);
            if (sps && pps) {
              const record = buildAvcDecoderConfigurationRecord(sps, pps);
              activeDecoderConfig.description = record.buffer;
            }
          } catch {
            // Keep existing fallback description
          }
        }

        // Always guarantee sanitized colorSpace
        activeDecoderConfig.colorSpace = sanitizeColorSpace(activeDecoderConfig.colorSpace);

        // Construct bulletproof metadata object for mp4-muxer
        const sanitizedMeta: EncodedVideoChunkMetadata = {
          ...meta,
          decoderConfig: {
            ...activeDecoderConfig,
            colorSpace: { ...activeDecoderConfig.colorSpace },
          },
        };

        muxer.addVideoChunk(chunk, sanitizedMeta);
      } catch (err) {
        console.error('Error adding video chunk to muxer:', err);
        encoderError = err instanceof Error ? err : new Error(String(err));
      }
    },
    error: (e) => {
      encoderError = e;
      console.error('VideoEncoder error:', e);
    },
  });

  videoEncoder.configure({
    codec: selectedCodec,
    width,
    height,
    bitrate: config.bitrate || 6_000_000,
    framerate: fps,
    hardwareAcceleration: 'prefer-hardware',
  });

  // 4. Setup AudioEncoder & encode audio in optimized standard frames (2048 samples)
  let audioEncoder: AudioEncoder | null = null;
  if (hasAudioEncoder && renderedAudio) {
    try {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          try {
            muxer.addAudioChunk(chunk, meta || undefined);
          } catch (e) {
            console.warn('muxer.addAudioChunk warning:', e);
          }
        },
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

      // AAC standard frame multiple: 2048 samples
      const chunkSize = 2048;
      // Preallocate planar buffer to eliminate thousands of small allocations during export
      const planarBuffer = new Float32Array(chunkSize * 2);

      for (let offset = 0; offset < numFrames; offset += chunkSize) {
        if (signal?.aborted) break;

        // Audio backpressure control
        if (audioEncoder.encodeQueueSize > 8) {
          await waitForAudioDrain(audioEncoder, 4);
        }

        const framesInChunk = Math.min(chunkSize, numFrames - offset);
        let chunkData: Float32Array;

        if (framesInChunk === chunkSize) {
          for (let i = 0; i < framesInChunk; i++) {
            planarBuffer[i] = left[offset + i];
            planarBuffer[framesInChunk + i] = right[offset + i];
          }
          chunkData = planarBuffer;
        } else {
          // Partial tail chunk
          chunkData = new Float32Array(framesInChunk * 2);
          for (let i = 0; i < framesInChunk; i++) {
            chunkData[i] = left[offset + i];
            chunkData[framesInChunk + i] = right[offset + i];
          }
        }

        const timestampUs = Math.round((offset / renderedAudio.sampleRate) * 1_000_000);
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: renderedAudio.sampleRate,
          numberOfFrames: framesInChunk,
          numberOfChannels: 2,
          timestamp: timestampUs,
          data: chunkData as unknown as BufferSource,
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

  // 5. Canvas & compositor
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

      // Pre-seek any active video clips at this frame (matching clip.id in MediaSourcePool)
      const activeVideoClips = clips.filter(
        (c) => c.type === 'video' && t >= c.start && t < c.start + c.duration
      );
      for (const vc of activeVideoClips) {
        const media = mediaMap.get(vc.mediaId);
        if (media) {
          const videoEl = mediaSourcePool.getVideoElement(media, vc.id, vc.sourceStart);
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
      const etaSeconds = Math.max(
        0,
        Math.round((totalFrames - framesDone) / Math.max(0.1, fpsSpeed))
      );

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
    if (audioEncoder && audioEncoder.state !== 'closed') {
      await audioEncoder.flush();
    }
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
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
