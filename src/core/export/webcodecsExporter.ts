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
 * Helper bit writer for generating syntactically valid H.264 SPS/PPS records.
 */
class H264BitWriter {
  private bytes: number[] = [];
  private currentByte = 0;
  private numBits = 0;

  writeBits(value: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) {
      const bit = (value >> i) & 1;
      this.currentByte = (this.currentByte << 1) | bit;
      this.numBits++;
      if (this.numBits === 8) {
        this.bytes.push(this.currentByte);
        this.currentByte = 0;
        this.numBits = 0;
      }
    }
  }

  writeUe(val: number): void {
    const v = val + 1;
    let m = 0;
    while (1 << m <= v) m++;
    this.writeBits(0, m - 1);
    this.writeBits(v, m);
  }

  writeSe(val: number): void {
    if (val <= 0) this.writeUe(-val * 2);
    else this.writeUe(val * 2 - 1);
  }

  finish(): Uint8Array {
    if (this.numBits > 0) {
      this.writeBits(1, 1); // rbsp_stop_one_bit
      if (this.numBits > 0) {
        this.writeBits(0, 8 - this.numBits); // rbsp_alignment_zero_bit
      }
    }
    return new Uint8Array(this.bytes);
  }
}

/**
 * Generates a valid H.264 Baseline Profile Level 4.0 SPS for arbitrary dimensions.
 */
export function generateBaselineSps(width: number, height: number): Uint8Array {
  const w = new H264BitWriter();
  w.writeBits(0x67, 8); // NAL type 7 (SPS), ref_idc 3
  w.writeBits(66, 8); // Baseline Profile (0x42)
  w.writeBits(0xe0, 8); // constraint_set0..2 flags (0xE0)
  w.writeBits(40, 8); // Level 4.0 (0x28)
  w.writeUe(0); // seq_parameter_set_id = 0
  w.writeUe(0); // log2_max_frame_num_minus4 = 0
  w.writeUe(0); // pic_order_cnt_type = 0
  w.writeUe(2); // log2_max_pic_order_cnt_lsb_minus4 = 2
  w.writeUe(1); // max_num_ref_frames = 1
  w.writeBits(0, 1); // gaps_in_frame_num_value_allowed_flag = 0

  const mbsW = Math.ceil(width / 16);
  const mbsH = Math.ceil(height / 16);
  w.writeUe(mbsW - 1); // pic_width_in_mbs_minus1
  w.writeUe(mbsH - 1); // pic_height_in_map_units_minus1
  w.writeBits(1, 1); // frame_mbs_only_flag = 1
  w.writeBits(1, 1); // direct_8x8_inference_flag = 1

  const cropRight = (mbsW * 16 - width) / 2;
  const cropBottom = (mbsH * 16 - height) / 2;
  const hasCrop = cropRight > 0 || cropBottom > 0;
  w.writeBits(hasCrop ? 1 : 0, 1);
  if (hasCrop) {
    w.writeUe(0); // crop_left
    w.writeUe(cropRight);
    w.writeUe(0); // crop_top
    w.writeUe(cropBottom);
  }
  w.writeBits(0, 1); // vui_parameters_present_flag = 0
  return w.finish();
}

/**
 * Generates a valid H.264 PPS.
 */
export function generateBaselinePps(): Uint8Array {
  const w = new H264BitWriter();
  w.writeBits(0x68, 8); // NAL type 8 (PPS), ref_idc 3
  w.writeUe(0); // pic_parameter_set_id = 0
  w.writeUe(0); // seq_parameter_set_id = 0
  w.writeBits(0, 1); // entropy_coding_mode_flag = 0 (CAVLC)
  w.writeBits(0, 1); // bottom_field_pic_order_in_frame_present_flag = 0
  w.writeUe(0); // num_slice_groups_minus1 = 0
  w.writeUe(0); // num_ref_idx_l0_default_active_minus1 = 0
  w.writeUe(0); // num_ref_idx_l1_default_active_minus1 = 0
  w.writeBits(0, 1); // weighted_pred_flag = 0
  w.writeBits(0, 2); // weighted_bipred_idc = 0
  w.writeSe(0); // pic_init_qp_minus26 = 0
  w.writeSe(0); // pic_init_qs_minus26 = 0
  w.writeSe(0); // chroma_qp_index_offset = 0
  w.writeBits(0, 1); // deblocking_filter_control_present_flag = 0
  w.writeBits(0, 1); // constrained_intra_pred_flag = 0
  w.writeBits(0, 1); // redundant_pic_cnt_present_flag = 0
  return w.finish();
}

/**
 * Parses AVCC formatted chunk (4-byte length prefixes).
 */
function parseAvcc(chunkData: Uint8Array): { sps: Uint8Array | null; pps: Uint8Array | null } {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  let offset = 0;
  const view = new DataView(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength);

  while (offset + 4 <= chunkData.length) {
    const nalLength = view.getUint32(offset, false);
    const nalStart = offset + 4;
    const nalEnd = nalStart + nalLength;

    if (nalLength === 0 || nalEnd > chunkData.length) {
      return { sps: null, pps: null };
    }

    const nalType = chunkData[nalStart] & 0x1f;
    if (nalType === 7 && !sps) {
      sps = chunkData.slice(nalStart, nalEnd);
    } else if (nalType === 8 && !pps) {
      pps = chunkData.slice(nalStart, nalEnd);
    }

    offset = nalEnd;
  }

  if (offset === chunkData.length) {
    return { sps, pps };
  }
  return { sps: null, pps: null };
}

/**
 * Parses Annex-B formatted chunk (00 00 01 / 00 00 00 01 start codes).
 */
function parseAnnexB(chunkData: Uint8Array): { sps: Uint8Array | null; pps: Uint8Array | null } {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  const startPositions: { start: number; codeLen: number }[] = [];
  let i = 0;

  while (i < chunkData.length - 2) {
    if (chunkData[i] === 0 && chunkData[i + 1] === 0) {
      if (chunkData[i + 2] === 1) {
        startPositions.push({ start: i, codeLen: 3 });
        i += 3;
        continue;
      } else if (chunkData[i + 2] === 0 && i + 3 < chunkData.length && chunkData[i + 3] === 1) {
        startPositions.push({ start: i, codeLen: 4 });
        i += 4;
        continue;
      }
    }
    i++;
  }

  for (let k = 0; k < startPositions.length; k++) {
    const nalStart = startPositions[k].start + startPositions[k].codeLen;
    const nalEnd = k + 1 < startPositions.length ? startPositions[k + 1].start : chunkData.length;
    if (nalStart < nalEnd) {
      const nalType = chunkData[nalStart] & 0x1f;
      if (nalType === 7 && !sps) {
        sps = chunkData.slice(nalStart, nalEnd);
      } else if (nalType === 8 && !pps) {
        pps = chunkData.slice(nalStart, nalEnd);
      }
    }
  }

  return { sps, pps };
}

/**
 * Extracts SPS (NAL unit type 7) and PPS (NAL unit type 8) from an H.264 chunk's byte buffer.
 * Supports both AVCC (4-byte length prefix) and Annex-B (00 00 01 / 00 00 00 01 start codes).
 */
export function extractSpsPpsFromChunk(chunkData: Uint8Array): {
  sps: Uint8Array | null;
  pps: Uint8Array | null;
} {
  if (!chunkData || chunkData.length < 5) {
    return { sps: null, pps: null };
  }

  // 1. Try parsing as AVCC (4-byte length prefixed, standard WebCodecs EncodedVideoChunk format)
  const avccResult = parseAvcc(chunkData);
  if (avccResult.sps && avccResult.pps) {
    return avccResult;
  }

  // 2. Try parsing as Annex-B (elementary stream with start codes)
  const annexBResult = parseAnnexB(chunkData);
  return {
    sps: avccResult.sps ?? annexBResult.sps,
    pps: avccResult.pps ?? annexBResult.pps,
  };
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
  record[1] = sps[1] ?? 0x64; // AVCProfileIndication
  record[2] = sps[2] ?? 0x00; // profile_compatibility
  record[3] = sps[3] ?? 0x28; // AVCLevelIndication
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
 * Generates a valid fallback AVCDecoderConfigurationRecord tailored to width and height.
 */
export function getFallbackAvcDescription(width = 1920, height = 1080): Uint8Array {
  const sps = generateBaselineSps(width, height);
  const pps = generateBaselinePps();
  return buildAvcDecoderConfigurationRecord(sps, pps);
}

/**
 * Tries H.264 codecs in order (High → Main → Baseline) validating the FULL
 * encode configuration (codec + dimensions + bitrate + framerate).
 * Returns the first fully-supported codec string, or null if the encoder
 * cannot handle the requested configuration on this device/GPU.
 *
 * NOTE: `getSupportedVideoCodec` only checks codec+dimensions. Exporting at
 * 4K or with a high bitrate can still fail `configure()` on weak GPUs, which
 * previously surfaced later as the cryptic
 * "VideoEncoder.encode: Encoder must be configured first". Checking the full
 * config up-front lets us fall back to MediaRecorder with a clear warning
 * instead of crashing mid-export.
 */
export async function selectSupportedVideoConfig(
  width = 1920,
  height = 1080,
  bitrate = 6_000_000,
  framerate = 30
): Promise<string | null> {
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
        bitrate,
        framerate,
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
 * Hardware acceleration strategies to try, in order of preference.
 * `prefer-hardware` gives the best performance when available, but on some
 * GPU/driver/browser combinations `VideoEncoder.configure()` succeeds
 * synchronously and then the platform encoder dies asynchronously
 * (OperationError: "Encoder creation error" / NotSupportedError
 * "Operation is not supported"). The only reliable way to detect this is to
 * create a real encoder, configure it, and verify it survives a short grace
 * period before committing to it for the export.
 */
export const HARDWARE_ACCELERATION_CHAIN: HardwareAcceleration[] = [
  'prefer-hardware',
  'no-preference',
  'prefer-software',
];

/**
 * Creates and configures a throwaway VideoEncoder to verify that the platform
 * encoder actually survives configuration (not just isConfigSupported()).
 * Resolves true only if the encoder is still 'configured' after `graceMs`.
 */
export function probeEncoderSurvives(
  codec: string,
  width: number,
  height: number,
  bitrate: number,
  framerate: number,
  hardwareAcceleration: HardwareAcceleration,
  graceMs = 120
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let encoder: VideoEncoder | null = null;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        if (encoder && encoder.state !== 'closed') encoder.close();
      } catch {
        // ignore close errors during probe
      }
      resolve(ok);
    };

    try {
      encoder = new VideoEncoder({
        output: () => {},
        error: () => finish(false),
      });
    } catch {
      finish(false);
      return;
    }

    try {
      encoder.configure({
        codec,
        width,
        height,
        bitrate,
        framerate,
        hardwareAcceleration,
      });
    } catch {
      finish(false);
      return;
    }

    // Grace period: platform encoder creation failures are asynchronous.
    setTimeout(() => finish(encoder!.state === 'configured'), graceMs);
  });
}

export interface WorkingVideoEncoderConfig {
  codec: string;
  hardwareAcceleration: HardwareAcceleration;
}

/**
 * Finds a codec + hardwareAcceleration combination that is not only reported
 * as supported, but whose platform encoder actually survives configuration.
 * Tries hardware acceleration modes in order (hardware → default → software)
 * and codec profiles High → Main → Baseline within each mode.
 *
 * Returns null when no combination works, in which case the caller should
 * fall back to MediaRecorder instead of failing mid-export.
 */
export async function findWorkingVideoEncoderConfig(
  width: number,
  height: number,
  bitrate: number,
  framerate: number,
  graceMs = 120
): Promise<WorkingVideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return null;
  }
  const codecsToTry = ['avc1.640028', 'avc1.4d002a', 'avc1.42001f'];

  for (const hw of HARDWARE_ACCELERATION_CHAIN) {
    for (const codec of codecsToTry) {
      // Fast pre-check to skip obviously unsupported combinations.
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec,
          width,
          height,
          bitrate,
          framerate,
          hardwareAcceleration: hw,
        });
        if (!support.supported) continue;
      } catch {
        continue;
      }
      const survived = await probeEncoderSurvives(
        codec,
        width,
        height,
        bitrate,
        framerate,
        hw,
        graceMs
      );
      if (survived) {
        return { codec, hardwareAcceleration: hw };
      }
    }
  }
  return null;
}

/**
 * Dynamically queries VideoEncoder.isConfigSupported to find the best supported H.264 profile.
 * Prefers High Profile (avc1.640028), falls back to Main (avc1.4d002a) and Baseline (avc1.42001f).
 * NOTE: only checks codec+dimensions (fast path). For export, prefer
 * `selectSupportedVideoConfig`, which also validates bitrate+framerate.
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

export interface SafeChunkLike {
  byteLength: number;
  copyTo: (dest: Uint8Array) => void;
  type: 'key' | 'delta';
  timestamp: number;
  duration?: number | null;
  compositionTimeOffset?: number;
}

/**
 * Safely adds an encoded video chunk to mp4-muxer.
 * In WebKit / iOS Safari, EncodedVideoChunk often has `duration === null`, `undefined`, or `NaN`.
 * mp4-muxer strictly asserts that duration is a non-negative real number (`!isNaN(duration) && duration >= 0`),
 * otherwise throwing `TypeError: addVideoChunkRaw's fourth argument (duration) must be a non-negative real number.`
 * This helper calculates the expected frame duration in microseconds (1_000_000 / fps) when chunk.duration
 * is missing, non-finite, or <= 0, guarantees integer microsecond values, forwards compositionTimeOffset,
 * and safely routes to muxer.addVideoChunkRaw.
 */
export function safeAddVideoChunk(
  muxer: {
    addVideoChunkRaw: (
      data: Uint8Array,
      type: 'key' | 'delta',
      timestamp: number,
      duration: number,
      meta?: EncodedVideoChunkMetadata,
      compositionTimeOffset?: number
    ) => void;
  },
  chunk: SafeChunkLike,
  meta?: EncodedVideoChunkMetadata,
  fps = 30,
  preAllocatedData?: Uint8Array,
  compositionTimeOffset?: number
): void {
  let chunkData: Uint8Array;
  if (preAllocatedData) {
    chunkData = preAllocatedData;
  } else {
    chunkData = new Uint8Array(chunk.byteLength);
    chunk.copyTo(chunkData);
  }

  const safeFps = Math.max(1, Math.round(fps));
  const expectedDurationUs = Math.round(1_000_000 / safeFps);
  const rawDuration = chunk.duration;
  const durationUs =
    typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.round(rawDuration)
      : expectedDurationUs;

  const rawTimestamp = chunk.timestamp;
  const timestampUs =
    typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp) && rawTimestamp >= 0
      ? Math.round(rawTimestamp)
      : 0;

  const rawCto = compositionTimeOffset ?? chunk.compositionTimeOffset;
  const cto =
    typeof rawCto === 'number' && Number.isFinite(rawCto)
      ? Math.round(rawCto)
      : undefined;

  muxer.addVideoChunkRaw(
    chunkData,
    chunk.type,
    timestampUs,
    durationUs,
    meta,
    cto
  );
}

/**
 * Safely adds an encoded audio chunk to mp4-muxer.
 * Guarantees that duration and timestamp are strictly finite, non-negative integer microseconds,
 * preventing analogous exceptions or chunk drops in WebKit / iOS Safari.
 */
export function safeAddAudioChunk(
  muxer: {
    addAudioChunkRaw: (
      data: Uint8Array,
      type: 'key' | 'delta',
      timestamp: number,
      duration: number,
      meta?: EncodedAudioChunkMetadata
    ) => void;
  },
  chunk: SafeChunkLike,
  meta?: EncodedAudioChunkMetadata,
  sampleRate = 48000,
  preAllocatedData?: Uint8Array
): void {
  let audioData: Uint8Array;
  if (preAllocatedData) {
    audioData = preAllocatedData;
  } else {
    audioData = new Uint8Array(chunk.byteLength);
    chunk.copyTo(audioData);
  }

  const safeSampleRate = Math.max(1, Math.round(sampleRate));
  const expectedAudioDurationUs = Math.round((1024 / safeSampleRate) * 1_000_000);
  const rawDuration = chunk.duration;
  const durationUs =
    typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.round(rawDuration)
      : expectedAudioDurationUs;

  const rawTimestamp = chunk.timestamp;
  const timestampUs =
    typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp) && rawTimestamp >= 0
      ? Math.round(rawTimestamp)
      : 0;

  muxer.addAudioChunkRaw(
    audioData,
    chunk.type,
    timestampUs,
    durationUs,
    meta || undefined
  );
}

/**
 * Translates raw platform encoder errors (which vary by browser/GPU/driver)
 * into an actionable Spanish message. Returns the original error untouched
 * when it doesn't look encoder-related, so real bugs stay visible.
 *
 * Covered raw shapes:
 * - EncodingError / NotSupportedError from VideoEncoder.configure/encode/flush
 *   (Chrome/Edge report e.g. "Operation is not supported" when the GPU
 *   rejects the stream mid-export).
 * - InvalidStateError "Encoder must be configured first" (stale symptom of
 *   a failed configure / closed encoder; the underlying `encoderError` or
 *   the resolution guidance is far more useful).
 */
export function toActionableExportError(
  err: unknown,
  opts: { width: number; height: number; fps: number },
  encoderError?: Error | null
): Error {
  // Prefer the underlying cause when the platform error callback fired, but
  // ALWAYS translate it: returning the raw encoderError was how
  // "Operation is not supported" reached the user untranslated.
  const source = encoderError ?? err;
  const name = source instanceof DOMException ? source.name : (source as Error)?.name;
  const msg = source instanceof Error ? source.message : String(source);
  const looksEncoderRelated =
    name === 'NotSupportedError' ||
    name === 'EncodingError' ||
    name === 'InvalidStateError' ||
    name === 'OperationError' ||
    /operation is not supported|not supported|configured first|encoder|creation error/i.test(msg);
  if (!looksEncoderRelated) {
    return source instanceof Error ? source : new Error(String(source));
  }
  const { width, height, fps } = opts;
  return new Error(
    `El codificador de video de este dispositivo rechazó la exportación ` +
      `(${width}x${height}@${fps}fps): ${msg} ` +
      `Prueba con resolución 1080p o 720p a 30 FPS, o con otro navegador (Chrome/Edge).`
  );
}

/**
 * Main export function using WebCodecs + mp4-muxer with MediaRecorder fallback.
 */
export async function exportVideo(params: ExportParams): Promise<Blob> {
  const fps = Math.max(1, Math.round(params.config.fps || 30));
  const totalFrames = Math.max(1, Math.round(params.duration * fps));
  const startTime = performance.now();

  // Fast path: no WebCodecs at all -> MediaRecorder fallback.
  const webCodecsSupported = await isWebCodecsSupported();

  if (webCodecsSupported) {
    // Full-config check with the REAL export dimensions/bitrate/framerate.
    // The old code only validated 1920x1080 defaults, so e.g. a 4K export on
    // a GPU that caps at 1080p failed at configure() time and surfaced later
    // as "VideoEncoder.encode: Encoder must be configured first".
    const width = params.config.width - (params.config.width % 2);
    const height = params.config.height - (params.config.height % 2);
    const bitrate = params.config.bitrate || 6_000_000;
    // Deep probe: create+configure a real encoder and verify it survives.
    // Detects async platform-encoder failures ("Operation is not supported",
    // "Encoder creation error") that isConfigSupported() cannot see, and
    // finds a working hardwareAcceleration mode before the export starts.
    const workingConfig = await findWorkingVideoEncoderConfig(width, height, bitrate, fps);
    if (workingConfig) {
      return await exportWithWebCodecs(params, totalFrames, startTime, workingConfig);
    }
    console.warn(
      `WebCodecs no soporta ${width}x${height}@${fps}fps en este dispositivo; usando MediaRecorder como respaldo.`
    );
  }
  // Fallback: Canvas captureStream + MediaRecorder
  return await exportWithMediaRecorder(params, totalFrames);
}

/**
 * Hardware-accelerated WebCodecs export with robust metadata sanitization and backpressure.
 */
async function exportWithWebCodecs(
  params: ExportParams,
  totalFrames: number,
  renderStartTime: number,
  workingConfig: WorkingVideoEncoderConfig
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

  // Pre-validate AudioEncoder if audio is present.
  // Chrome/Linux has NO AAC encoder (NotSupportedError "Unsupported codec
  // type"), which used to silently drop audio from exports. Try AAC first,
  // then fall back to Opus (supported by Chrome everywhere; mp4-muxer can
  // mux Opus into MP4).
  let audioConfig: { codec: 'aac' | 'opus'; encoderCodec: string; bitrate: number } | null = null;
  if (renderedAudio && typeof AudioEncoder !== 'undefined') {
    const audioCandidates: Array<{ codec: 'aac' | 'opus'; encoderCodec: string; bitrate: number }> = [
      { codec: 'aac', encoderCodec: 'mp4a.40.2', bitrate: 192_000 },
      { codec: 'opus', encoderCodec: 'opus', bitrate: 128_000 },
    ];
    for (const candidate of audioCandidates) {
      try {
        const audioSupport = await AudioEncoder.isConfigSupported({
          codec: candidate.encoderCodec,
          numberOfChannels: 2,
          sampleRate: renderedAudio.sampleRate,
          bitrate: candidate.bitrate,
        });
        if (audioSupport.supported) {
          audioConfig = candidate;
          break;
        }
      } catch {
        // Try next audio candidate
      }
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
      audioConfig && renderedAudio
        ? {
            codec: audioConfig.codec,
            numberOfChannels: 2,
            sampleRate: renderedAudio.sampleRate,
          }
        : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  // Use the encoder configuration that was deep-probed in exportVideo
  // (codec + hardwareAcceleration validated by actually creating a real
  // encoder and verifying it survives). This avoids the async platform
  // encoder death ("Operation is not supported") that isConfigSupported()
  // cannot detect.
  const activeCodec = workingConfig.codec;

  // 3. Active video decoder configuration tracking
  // In iOS Safari / WebKit, metadata from VideoEncoder output callback is frequently
  // omitted (undefined) or lacks decoderConfig/colorSpace. We maintain an active, valid
  // decoderConfig so mp4-muxer always receives non-null metadata with valid colorSpace.
  const activeDecoderConfig: VideoDecoderConfig = {
    codec: activeCodec,
    codedWidth: width,
    codedHeight: height,
    colorSpace: { ...DEFAULT_COLOR_SPACE },
    description: getFallbackAvcDescription(width, height).buffer,
  };

  let videoChunksEncoded = 0;
  let encoderError: Error | null = null;

  const videoEncoder = new VideoEncoder({
    output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => {
      try {
        videoChunksEncoded++;

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

        const chunkData = new Uint8Array(chunk.byteLength);
        chunk.copyTo(chunkData);

        // On keyframe, extract SPS and PPS if description was not supplied by browser
        if (chunk.type === 'key' && !meta?.decoderConfig?.description) {
          try {
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

        safeAddVideoChunk(muxer, chunk, sanitizedMeta, fps, chunkData);
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

  // Configure with the deep-probed codec + hardwareAcceleration combination.
  // If it still fails (encoder raced to closed), fall back to MediaRecorder
  // instead of surfacing a raw platform error to the user.
  try {
    videoEncoder.configure({
      codec: workingConfig.codec,
      width,
      height,
      bitrate: config.bitrate || 6_000_000,
      framerate: fps,
      hardwareAcceleration: workingConfig.hardwareAcceleration,
    });
  } catch (err) {
    try {
      if (videoEncoder.state !== 'closed') videoEncoder.close();
    } catch {
      // ignore close errors during failed setup
    }
    throw toActionableExportError(err, { width, height, fps });
  }
  if (videoEncoder.state !== 'configured') {
    const asyncCause = encoderError as Error | null;
    const detail = asyncCause ? asyncCause.message : null;
    try {
      if (videoEncoder.state !== 'closed') videoEncoder.close();
    } catch {
      // ignore close errors during failed setup
    }
    throw toActionableExportError(
      asyncCause ?? new Error(detail ?? 'el encoder de la plataforma se cerró al configurarse'),
      { width, height, fps }
    );
  }

  // 4. Setup AudioEncoder & encode audio in optimized standard frames (2048 samples)
  let audioEncoder: AudioEncoder | null = null;
  if (audioConfig && renderedAudio) {
    try {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          try {
            safeAddAudioChunk(muxer, chunk, meta || undefined, renderedAudio.sampleRate);
          } catch (e) {
            console.warn('safeAddAudioChunk warning:', e);
          }
        },
        error: (e) => console.error('AudioEncoder error:', e),
      });
      audioEncoder.configure({
        codec: audioConfig.encoderCodec,
        numberOfChannels: 2,
        sampleRate: renderedAudio.sampleRate,
        bitrate: audioConfig.bitrate,
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
        throw toActionableExportError(encoderError, { width, height, fps });
      }

      const t = frameIdx / fps;

      // Pre-seek any active video clips at this frame in parallel (matching clip.id in MediaSourcePool)
      const activeVideoClips = clips.filter(
        (c) => c.type === 'video' && t >= c.start && t < c.start + c.duration
      );
      if (activeVideoClips.length > 0) {
        await Promise.all(
          activeVideoClips.map((vc) => {
            const media = mediaMap.get(vc.mediaId);
            if (!media) return Promise.resolve();
            const videoEl = mediaSourcePool.getVideoElement(media, vc.id, vc.sourceStart);
            const speed = vc.speed && vc.speed > 0 ? vc.speed : 1;
            const sourceOffset = vc.sourceStart + (t - vc.start) * speed;
            const maxSourceTime = Math.max(0, (media.duration || 1000) - 0.05);
            const clampedOffset = Math.max(0, Math.min(maxSourceTime, sourceOffset));
            return seekVideoElement(videoEl, clampedOffset);
          })
        );
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

      // Control backpressure (allow hardware encoder pipeline depth up to 5)
      await waitForEncoderDrain(videoEncoder, 5);

      // Guard: if a previous async encoding error closed/reset the encoder,
      // encode() would throw the cryptic "Encoder must be configured first".
      // Surface the translated underlying error instead.
      if (videoEncoder.state !== 'configured') {
        throw toActionableExportError(
          encoderError ??
            new Error('el codificador se cerró inesperadamente durante la exportación'),
          { width, height, fps }
        );
      }

      // Create VideoFrame & encode strictly protected with try...finally
      const timestampUs = Math.round(t * 1_000_000);
      const frameDurationUs = Math.round(1_000_000 / fps);
      const videoFrame = new VideoFrame(canvas, {
        timestamp: timestampUs,
        duration: frameDurationUs,
      });
      try {
        try {
          videoEncoder.encode(videoFrame, { keyFrame: frameIdx % (fps * 2) === 0 });
        } catch (encodeErr) {
          const msg = encodeErr instanceof Error ? encodeErr.message : String(encodeErr);
          if (/configured first/i.test(msg) && encoderError) {
            throw toActionableExportError(encoderError, { width, height, fps });
          }
          throw new Error(
            `Fallo al codificar el cuadro ${frameIdx + 1}/${totalFrames}: ${msg}. ` +
              `Prueba con resolución 1080p o 720p.`
          );
        }
      } finally {
        videoFrame.close();
      }

      // Progress reporting & ETA (throttled to avoid flooding React state updates)
      const framesDone = frameIdx + 1;
      const progressPercent = Math.round((framesDone / totalFrames) * 95);
      if (framesDone === totalFrames || frameIdx % 4 === 0) {
        const elapsedSecs = (performance.now() - renderStartTime) / 1000;
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
    }

    // 7. Flush encoders and finalize muxer
    onProgress({
      state: 'muxing',
      progress: 98,
      currentFrame: totalFrames,
      totalFrames,
      etaSeconds: 1,
    });

    try {
      await videoEncoder.flush();
    } catch (flushErr) {
      // flush() rejects with the raw platform error when the GPU/driver
      // fails mid-export (e.g. EncodingError "Operation is not supported").
      // Prefer the error-callback cause when present, else translate.
      throw toActionableExportError(flushErr, { width, height, fps }, encoderError);
    }
    if (audioEncoder && audioEncoder.state !== 'closed') {
      try {
        await audioEncoder.flush();
      } catch (err) {
        console.warn('AudioEncoder flush warning:', err);
      }
    }

    if (encoderError) {
      throw toActionableExportError(encoderError, { width, height, fps });
    }

    if (videoChunksEncoded === 0) {
      throw new Error('El codificador de video no generó ningún cuadro de video.');
    }

    try {
      muxer.finalize();
    } catch (err) {
      throw new Error(
        `Error al finalizar el archivo MP4: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } finally {
    const videoState: string = videoEncoder.state;
    if (videoState !== 'closed') {
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
  if (
    typeof MediaRecorder === 'undefined' ||
    !MediaRecorder.isTypeSupported('video/mp4')
  ) {
    mimeType = 'video/webm;codecs=vp9';
  }
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm';
  }

  // The constructor throws NotSupportedError when the mimeType is rejected;
  // retry with browser defaults before giving a clear error.
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: config.bitrate });
  } catch (err) {
    try {
      recorder = new MediaRecorder(stream);
      mimeType = recorder.mimeType || 'video/webm';
    } catch {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Este navegador no soporta grabación de video (MediaRecorder: ${detail}). ` +
          `Prueba con Chrome o Edge actualizados.`
      );
    }
  }
  const chunks: Blob[] = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.onerror = (ev) => {
    console.error('MediaRecorder error:', (ev as ErrorEvent).error ?? ev);
  };

  try {
    recorder.start();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`No se pudo iniciar la grabación de respaldo: ${detail}`);
  }

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
