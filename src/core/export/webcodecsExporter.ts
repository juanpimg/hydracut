import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { Clip, ExportConfig, ExportProgress, MediaItem, Track } from '../../types/project';
import { applySoloToTracks } from '../engine/AudioEngine';
import { Compositor } from '../engine/Compositor';
import { MediaSourcePool, mediaSourcePool } from '../engine/MediaSourcePool';
import { applyDetuneToParam, resolvePlayback } from '../utils/playbackRate';
import { buildAudioFadeAutomation, fadeDurationScale } from '../utils/audioFades';
import { readMasterVolume } from '../utils/masterVolume';
import {
  buildDuckAutomation,
  computeDialogueIntervals,
  isNeutralAudioEffects,
  resolveClipAudioChain,
  resolveEqFilterConfig,
  type DialogueInterval,
  type ResolvedClipAudioChain,
} from '../utils/audioEffects';
import { buildCssFilterString, getCanvasFilterSupport } from '../utils/colorFilters';
import {
  resolveClipVisualTransform,
  type ResolvedClipVisual,
} from '../utils/clipTransform';
import {
  buildCrossfadeAudioSchedule,
  buildCrossfadeIndex,
  type CrossfadeSpan,
} from '../utils/crossfade';

export interface ExportParams {
  config: ExportConfig;
  duration: number;
  tracks: Track[];
  clips: Clip[];
  mediaPool: MediaItem[];
  onProgress: (progress: ExportProgress) => void;
  signal?: AbortSignal;
  /**
   * F-A3-02 · Volumen general (0..1) aplicado como ganancia de mezcla.
   *
   * Decisión de semántica: el master ES parte del export (preview ≡ export).
   * El preview multiplica cada clip por el master en `AudioEngine`, así que
   * el export multiplica la misma ganancia base por el mismo master.
   * Opcional por compatibilidad: cuando se omite se lee el valor persistido
   * (`readMasterVolume`, el que ambas barras de volumen escriben).
   */
  masterVolume?: number;
}

/**
 * The colour filter (F9) that the EXPORT applies to a clip.
 *
 * The export does NOT have its own compositing code: it renders every frame
 * with the very same `Compositor` class the preview uses (`renderFrame`),
 * so the pixels of the exported MP4 are filtered exactly like the pixels of
 * the preview.
 *
 * This helper exists to make that contract explicit and testable: it derives
 * the filter of a clip through the SAME production helper the compositor
 * uses (`buildCssFilterString`), so `resolveClipColorFilter(clip)` and the
 * preview can be compared literally.
 *
 * Returns `''` when the clip has no filters (or when the browser cannot
 * filter at all: then the preview is unfiltered too, so both agree).
 */
export function resolveClipColorFilter(clip: Clip): string {
  if (!getCanvasFilterSupport()) return '';
  return buildCssFilterString(clip.filters);
}

/**
 * La transformación visual (rotación / volteo / recorte) que el EXPORT
 * aplica a un clip.
 *
 * El export NO tiene su propio código de dibujado: renderiza cada fotograma
 * con la MISMA clase `Compositor` del preview (`renderFrame`), así que los
 * píxeles del MP4 rotan, se voltean y se recortan exactamente como los del
 * preview.
 *
 * Este helper existe para hacer ese contrato explícito y comprobable:
 * deriva la geometría con la MISMA función de producción que usa el
 * compositor (`resolveClipVisualTransform`), así que
 * `resolveExportClipTransform(clip)` y lo que el preview dibuja se comparan
 * literalmente (ver `src/tests/rotate-flip-crop.test.ts`).
 */
export function resolveExportClipTransform(clip: Clip): ResolvedClipVisual {
  return resolveClipVisualTransform(clip);
}

/**
 * La cadena de audio que el EXPORT deriva de un clip (paneo / EQ / duck).
 *
 * Llama a `resolveClipAudioChain` — LA MISMA función que usa el preview
 * (`resolvePreviewAudioChain` en `AudioEngine`) —, así que ambos caminos
 * reciben los mismos números por construcción (el test de paridad lo
 * comprueba literalmente). El `support` se resuelve contra el contexto
 * offline real cuando se conoce; por defecto usa las sondas en caché.
 */
export function resolveExportAudioChain(
  clip: Clip,
  support?: { panner?: boolean; biquad?: boolean }
): ResolvedClipAudioChain {
  return resolveClipAudioChain(clip, support);
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
 * Generates a valid H.264 Baseline Profile SPS for arbitrary dimensions.
 * The declared level defaults to the minimum level that actually fits the
 * frame size at 30 fps (level 4.0 for 1080p, level 5.1 for 4K).
 */
export function generateBaselineSps(
  width: number,
  height: number,
  levelIdc: number = deriveAvcLevelIdc(width, height, 30)
): Uint8Array {
  const w = new H264BitWriter();
  w.writeBits(0x67, 8); // NAL type 7 (SPS), ref_idc 3
  w.writeBits(66, 8); // Baseline Profile (0x42)
  w.writeBits(0xe0, 8); // constraint_set0..2 flags (0xE0)
  w.writeBits(levelIdc & 0xff, 8); // level_idc
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
 * The declared level is derived from the dimensions so the `avcC` box never
 * contradicts the actual frame size (a 4K stream declared as level 4.0 is
 * self-inconsistent and rejected by conformant decoders).
 */
export function getFallbackAvcDescription(
  width = 1920,
  height = 1080,
  levelIdc: number = deriveAvcLevelIdc(width, height, 30)
): Uint8Array {
  const sps = generateBaselineSps(width, height, levelIdc);
  const pps = generateBaselinePps();
  return buildAvcDecoderConfigurationRecord(sps, pps);
}

/**
 * H.264 level table (ITU-T H.264 Annex A).
 *
 * - `idc`         → `level_idc` value written in the codec string / SPS
 * - `maxFs`       → maximum frame size, in macroblocks
 * - `maxMbsPerSec`→ maximum macroblock processing rate
 * - `maxBr`       → maximum bitrate, in kbit/s
 */
const AVC_LEVELS: ReadonlyArray<{
  idc: number;
  maxFs: number;
  maxMbsPerSec: number;
  maxBr: number;
}> = [
  { idc: 10, maxFs: 99, maxMbsPerSec: 1485, maxBr: 64 },
  { idc: 11, maxFs: 396, maxMbsPerSec: 3000, maxBr: 192 },
  { idc: 12, maxFs: 396, maxMbsPerSec: 6000, maxBr: 384 },
  { idc: 13, maxFs: 396, maxMbsPerSec: 11880, maxBr: 768 },
  { idc: 20, maxFs: 396, maxMbsPerSec: 11880, maxBr: 2000 },
  { idc: 21, maxFs: 792, maxMbsPerSec: 19800, maxBr: 4000 },
  { idc: 22, maxFs: 1620, maxMbsPerSec: 20250, maxBr: 4000 },
  { idc: 30, maxFs: 1620, maxMbsPerSec: 40500, maxBr: 10000 },
  { idc: 31, maxFs: 3600, maxMbsPerSec: 108000, maxBr: 14000 },
  { idc: 32, maxFs: 5120, maxMbsPerSec: 216000, maxBr: 20000 },
  { idc: 40, maxFs: 8192, maxMbsPerSec: 245760, maxBr: 20000 },
  { idc: 41, maxFs: 8192, maxMbsPerSec: 245760, maxBr: 50000 },
  { idc: 42, maxFs: 8704, maxMbsPerSec: 522240, maxBr: 50000 },
  { idc: 50, maxFs: 22080, maxMbsPerSec: 589824, maxBr: 135000 },
  { idc: 51, maxFs: 36864, maxMbsPerSec: 983040, maxBr: 240000 },
  { idc: 52, maxFs: 36864, maxMbsPerSec: 2073600, maxBr: 240000 },
];

/**
 * Historical codec candidates with the level each one declares.
 *
 * They are kept as the *baseline* of the candidate list: a candidate is only
 * upgraded to a higher, derived level when the resolution/framerate really
 * needs more than the level it already declares. That way:
 *
 * - 1080p30 / 720p30 keep the battle-tested `avc1.640028` (level 4.0),
 * - 1080p60 is upgraded to level 4.2 (level 4.0 does not allow 489 600 MBPS),
 * - 4K is upgraded to level 5.1 / 5.2 (level 4.0/4.2 cannot hold 32 400 MBs).
 */
const LEGACY_AVC_CODECS: ReadonlyArray<{ codec: string; profile: string; levelIdc: number }> = [
  { codec: 'avc1.640028', profile: '64', levelIdc: 40 },
  { codec: 'avc1.4d002a', profile: '4d', levelIdc: 42 },
  { codec: 'avc1.42001f', profile: '42', levelIdc: 31 },
];

/**
 * Number of macroblocks (16x16 units) of a frame.
 */
export function macroblockCount(width: number, height: number): number {
  const mbWidth = Math.max(1, Math.ceil(Math.max(0, width) / 16));
  const mbHeight = Math.max(1, Math.ceil(Math.max(0, height) / 16));
  return mbWidth * mbHeight;
}

/**
 * Derives the MINIMUM H.264 level (`level_idc`) that is sufficient for the
 * requested resolution, framerate and bitrate.
 *
 * The previous implementation only ever offered level ≤ 4.2
 * (`avc1.640028` / `avc1.4d002a` / `avc1.42001f`), whose `MaxFS` is 8 704
 * macroblocks. A 4K frame needs 240×135 = 32 400 macroblocks, so the 4K
 * preset could never be encoded with WebCodecs and always fell back to the
 * (broken) MediaRecorder path. Deriving the level fixes that:
 *
 * - 1920x1080@30 → level 4.0 (8 160 MBs, 244 800 MBPS)
 * - 1920x1080@60 → level 4.2 (489 600 MBPS > 245 760)
 * - 3840x2160@30 → level 5.1 (32 400 MBs, 972 000 MBPS)
 * - 3840x2160@60 → level 5.2 (1 944 000 MBPS > 983 040)
 */
export function deriveAvcLevelIdc(
  width: number,
  height: number,
  fps = 30,
  bitrate = 0
): number {
  const mbs = macroblockCount(width, height);
  const mbps = mbs * Math.max(1, Math.round(fps));
  const brKbps = bitrate > 0 ? bitrate / 1000 : 0;

  for (const level of AVC_LEVELS) {
    if (mbs > level.maxFs) continue;
    if (mbps > level.maxMbsPerSec) continue;
    if (brKbps > 0 && brKbps > level.maxBr) continue;
    return level.idc;
  }
  // Nothing fits (e.g. 8K): use the highest level we know about.
  return AVC_LEVELS[AVC_LEVELS.length - 1].idc;
}

/**
 * Builds the ordered list of H.264 codec candidates for a configuration.
 *
 * The level declared by each candidate is upgraded to the derived (sufficient)
 * level when the historical one is too low, so a 4K export is encoded with a
 * level 5.1/5.2 codec instead of being rejected outright. The historical
 * strings are kept at the end of the list as a last resort for devices that
 * reject the derived level.
 */
export function buildAvcCodecCandidates(
  width = 1920,
  height = 1080,
  fps = 30,
  bitrate = 0
): string[] {
  const derivedLevel = deriveAvcLevelIdc(width, height, fps, bitrate);
  const derivedHex = derivedLevel.toString(16).padStart(2, '0');

  const candidates: string[] = [];
  for (const legacy of LEGACY_AVC_CODECS) {
    const codec =
      derivedLevel > legacy.levelIdc
        ? `avc1.${legacy.profile}00${derivedHex}`
        : legacy.codec;
    if (!candidates.includes(codec)) candidates.push(codec);
  }
  // Last resort: the historical strings, in case a device rejects the level
  // derived from the real configuration.
  for (const legacy of LEGACY_AVC_CODECS) {
    if (!candidates.includes(legacy.codec)) candidates.push(legacy.codec);
  }
  return candidates;
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
  const codecsToTry = buildAvcCodecCandidates(width, height, framerate, bitrate);
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
  const codecsToTry = buildAvcCodecCandidates(width, height, framerate, bitrate);

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
 * Prefers High Profile, falls back to Main and Baseline, always declaring a level that is
 * sufficient for the requested frame size (see `buildAvcCodecCandidates`).
 * NOTE: only checks codec+dimensions (fast path). For export, prefer
 * `selectSupportedVideoConfig`, which also validates bitrate+framerate.
 */
export async function getSupportedVideoCodec(width = 1920, height = 1080): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return null;
  }
  const codecsToTry = buildAvcCodecCandidates(width, height, 30, 0);
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
 * Resolves the raw bytes of a media item without keeping them alive any
 * longer than necessary.
 *
 * The export pipeline used to `fetch()` + `arrayBuffer()` the *whole* file for
 * every clip (EX-07): a project with three cuts of the same 4K source
 * downloaded and decoded the same file three times, tripling the peak RAM.
 * Now the bytes are only materialised once per *distinct* media item and the
 * decoded PCM buffer is released as soon as the last clip using it has been
 * mixed.
 */
async function readMediaArrayBuffer(media: MediaItem): Promise<ArrayBuffer> {
  // Some callers attach the in-memory blob to the media item; when present we
  // avoid the network round-trip and the extra copy entirely.
  const attached = (media as unknown as { blob?: Blob; file?: Blob }).blob ??
    (media as unknown as { file?: Blob }).file;
  if (attached && typeof attached.arrayBuffer === 'function') {
    return await attached.arrayBuffer();
  }

  const response = await fetch(media.url);
  if (!response.ok) {
    throw new Error(`No se pudo leer el medio "${media.name}" (HTTP ${response.status})`);
  }
  return await response.arrayBuffer();
}

/**
 * Resuelve el volumen general efectivo del export (0..1).
 *
 * Un valor explícito fuera de rango se recorta (la misma regla que
 * `AudioEngine.setMasterVolume`); sin valor explícito se lee el persistido,
 * que es el que el usuario escucha en el preview. Nunca lanza: ante la duda,
 * el export suena al 100 %.
 */
export function resolveExportMasterVolume(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return Math.max(0, Math.min(1, explicit));
  }
  try {
    const stored = readMasterVolume();
    if (typeof stored === 'number' && Number.isFinite(stored)) {
      return Math.max(0, Math.min(1, stored));
    }
  } catch {
    // Almacenamiento ilegible: al 100 %.
  }
  return 1;
}

/**
 * Frecuencia de muestreo del render offline de audio (fija).
 */
export const OFFLINE_AUDIO_SAMPLE_RATE = 48000;

/**
 * Duración máxima (segundos) cuyo audio se renderiza en memoria.
 *
 * P9: el búfer estéreo a 48 kHz ocupa `duración × 384 000 B/s`; 10 min son
 * ~230 MB de búfer más el PCM decodificado (~400–500 MB transitorios) y
 * 60 min ~1,4 GB (OOM de la pestaña). Por encima de este umbral (20 min ≈
 * 460 MB solo de búfer) la exportación se rechaza ANTES de asignar nada, con
 * un mensaje que ofrece el «Rango personalizado» del modal (la misma
 * funcionalidad que ya permite exportar por partes).
 */
export const MAX_EXPORT_DURATION_SECONDS = 20 * 60;

/**
 * Bytes estimados del búfer renderizado para `duration` segundos de audio
 * estéreo a `OFFLINE_AUDIO_SAMPLE_RATE` (Float32 por canal).
 */
export function estimateOfflineAudioBytes(duration: number): number {
  const safe = Number.isFinite(duration) && duration > 0 ? duration : 0;
  return Math.ceil(safe * OFFLINE_AUDIO_SAMPLE_RATE) * 2 * 4;
}

/**
 * Rechaza las duraciones que agotarían la memoria ANTES de asignar el
 * `OfflineAudioContext`. El mensaje es accionable y en español: dice cuánto
 * pediría y cómo exportar por rangos.
 */
export function assertExportAudioBudget(duration: number): void {
  if (!Number.isFinite(duration) || duration <= MAX_EXPORT_DURATION_SECONDS) return;
  const minutes = duration / 60;
  const mb = Math.round(estimateOfflineAudioBytes(duration) / (1024 * 1024));
  throw new Error(
    `La exportación es demasiado larga (${minutes.toFixed(0)} min): solo el audio ` +
      `necesitaría ~${mb} MB de memoria y el navegador podría quedarse sin memoria. ` +
      `Exporta por rangos más cortos con «Rango personalizado» en el modal de exportación.`
  );
}

/**
 * Mixes audio from all audio/video clips into an AudioBuffer using OfflineAudioContext.
 *
 * F5: two clips that share a deliberate crossfade overlap are BOTH started
 * (their sounded intervals overlap, exactly like the preview keeps both
 * elements audible) and their gains follow the LINEAR crossfade curve shared
 * with the preview (`buildCrossfadeAudioSchedule`). Exported for the
 * regression tests so the offline mix can be asserted directly.
 *
 * F-A3-02: `masterVolume` (0..1, por defecto 1) multiplica la ganancia base
 * de cada clip: el master es ganancia de mezcla y el export lo obedece como
 * el preview.
 */
export async function renderOfflineAudio(
  totalDuration: number,
  tracks: Track[],
  clips: Clip[],
  mediaPool: MediaItem[],
  signal?: AbortSignal,
  masterVolume: number = 1
): Promise<AudioBuffer | null> {
  // P9: la guarda dispara ANTES de asignar el búfer (que es lo que agota la
  // memoria), no después.
  assertExportAudioBudget(totalDuration);

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

  const sampleRate = OFFLINE_AUDIO_SAMPLE_RATE;
  const offlineCtx = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);
  const mediaMap = new Map<string, MediaItem>();
  for (const m of mediaPool) mediaMap.set(m.id, m);

  // F-A3-02: el master es ganancia de mezcla (la misma regla que el preview).
  const master = Number.isFinite(masterVolume) ? Math.max(0, Math.min(1, masterVolume)) : 1;

  let hasValidAudio = false;

  // EX-07: decode every distinct media file at most once and release the
  // decoded PCM as soon as the last clip that needs it has been mixed.
  const decodedCache = new Map<string, AudioBuffer>();
  const pendingUses = new Map<string, number>();
  for (const clip of audioClips) {
    pendingUses.set(clip.mediaId, (pendingUses.get(clip.mediaId) ?? 0) + 1);
  }

  // F5: the deliberate crossfade pairs, resolved ONCE for the whole render
  // (not per clip change per frame: this function runs once per export).
  // The video path needs no equivalent handling: it renders every frame
  // through the very same `Compositor` class the preview uses, so the
  // exported pixels already dissolve exactly like the previewed ones.
  const crossfadeSpans = new Map<string, CrossfadeSpan>();
  buildCrossfadeIndex(clips, crossfadeSpans);

  // Efectos de audio: los intervalos de diálogo audible se calculan UNA VEZ
  // para todo el render (no por clip). Cada clip con `duck: true` muestrea la
  // MISMA envolvente que el preview (`duckEnvelopeGain`) en su `GainNode`
  // dedicado (ver `buildDuckAutomation`).
  const dialogueIntervals: DialogueInterval[] = computeDialogueIntervals(clips, tracks);
  const offlinePannerSupported =
    typeof offlineCtx.createStereoPanner === 'function';
  const offlineBiquadSupported =
    typeof offlineCtx.createBiquadFilter === 'function';

  for (const clip of audioClips) {
    // EX-14: honour cancellation while decoding (the decode of a large file
    // can take seconds and used to be completely uninterruptible).
    if (signal?.aborted) {
      throw new Error('Exportación cancelada por el usuario');
    }

    const media = mediaMap.get(clip.mediaId);
    if (!media) continue;

    try {
      let decodedBuffer = decodedCache.get(clip.mediaId);
      if (!decodedBuffer) {
        const arrayBuffer = await readMediaArrayBuffer(media);
        decodedBuffer = await offlineCtx.decodeAudioData(arrayBuffer);
        decodedCache.set(clip.mediaId, decodedBuffer);
      }

      const playback = resolvePlayback(clip);
      const sourceNode = offlineCtx.createBufferSource();
      sourceNode.buffer = decodedBuffer;
      sourceNode.playbackRate.value = playback.rate;
      // F4: `playbackRate` multiplies the frequency by the rate (the voice
      // turns into a chipmunk at 2x). The `detune` compensation cancels that
      // multiplication EXACTLY (-1200 * log2(rate) cents), so the exported file
      // keeps the original pitch while the tempo changes: the same contract
      // the preview applies through `preservesPitch`.
      // It MUST be written before `start()`: the node takes the value of the
      // AudioParam when it starts.
      applyDetuneToParam(sourceNode.detune, playback.detuneCents);

      const gainNode = offlineCtx.createGain();
      const baseVol = (clip.volume ?? 1) * master;

      // F5: a clip inside a deliberate crossfade overlap follows the shared
      // linear curve (the preview multiplies the same curve per frame, so
      // both envelopes agree). Clips outside any crossfade keep the exact
      // historical automation below (untouched).
      const crossfadeSpan = crossfadeSpans.get(clip.id);
      if (crossfadeSpan && crossfadeSpan.duration > 0) {
        for (const event of buildCrossfadeAudioSchedule(clip, crossfadeSpan)) {
          if (event.type === 'set') {
            gainNode.gain.setValueAtTime(event.value, event.time);
          } else {
            gainNode.gain.linearRampToValueAtTime(event.value, event.time);
          }
        }
      } else if (clip.transition) {
        const { fadeInType, fadeInDuration, fadeOutType, fadeOutDuration } = clip.transition;
        // F-A3-01: la MISMA reescala que el preview (`fadeDurationScale`, la
        // función compartida): si `in + out` supera la duración, ambas
        // ventanas se encogen en proporción.
        const scale = fadeDurationScale(
          fadeInDuration > 0 ? fadeInDuration : 0,
          fadeOutDuration > 0 ? fadeOutDuration : 0,
          clip.duration
        );
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

      // Fundidos de audio por clip: la envolvente vive en un `GainNode`
      // DEDICADO en serie (`source → gain → fade → destino`) muestreada de
      // `audioFadeEnvelopeGain`, LA MISMA función que evalúa el preview por
      // frame, así que ambas envolventes acuerdan en todo instante. Sin
      // fundidos no hay segundo nodo ni eventos nuevos: el camino histórico
      // queda intacto (un export sin fundidos se comporta igual que hoy).
      //
      // Efectos de audio (pan / EQ / ducking): más nodos en serie DESPUÉS del
      // fundido (`… → fade → duck → eq → pan → destino`). Sin efectos el
      // cableado es EXACTAMENTE el histórico de arriba (un export sin efectos
      // se comporta igual que hoy); con efectos, los parámetros vienen de
      // `resolveClipAudioChain`, LA MISMA función que usa el preview.
      const fadeEvents = buildAudioFadeAutomation(clip);
      const duckEvents = isNeutralAudioEffects(clip.audioEffects)
        ? []
        : buildDuckAutomation(clip, dialogueIntervals);
      let tail: AudioNode = gainNode;
      if (fadeEvents.length > 0) {
        const fadeNode = offlineCtx.createGain();
        tail.connect(fadeNode);
        tail = fadeNode;
        for (const fadeEvent of fadeEvents) {
          if (fadeEvent.type === 'set') {
            fadeNode.gain.setValueAtTime(fadeEvent.value, fadeEvent.time);
          } else {
            fadeNode.gain.linearRampToValueAtTime(fadeEvent.value, fadeEvent.time);
          }
        }
      }
      if (duckEvents.length > 0) {
        const duckNode = offlineCtx.createGain();
        tail.connect(duckNode);
        tail = duckNode;
        for (const duckEvent of duckEvents) {
          if (duckEvent.type === 'set') {
            duckNode.gain.setValueAtTime(duckEvent.value, duckEvent.time);
          } else {
            duckNode.gain.linearRampToValueAtTime(duckEvent.value, duckEvent.time);
          }
        }
      }
      if (offlineBiquadSupported) {
        const eqConfig = resolveEqFilterConfig(clip.audioEffects);
        if (eqConfig.some((band) => band.gain !== 0)) {
          for (const band of eqConfig) {
            const filter = offlineCtx.createBiquadFilter();
            filter.type = band.type;
            filter.frequency.value = band.frequency;
            if (band.Q !== undefined) filter.Q.value = band.Q;
            filter.gain.value = band.gain;
            tail.connect(filter);
            tail = filter;
          }
        }
      }
      const exportPan = resolveExportAudioChain(clip, {
        panner: offlinePannerSupported,
        biquad: offlineBiquadSupported,
      }).pan;
      if (exportPan !== 0 && offlinePannerSupported) {
        const panner = offlineCtx.createStereoPanner();
        panner.pan.value = exportPan;
        tail.connect(panner);
        tail = panner;
      }
      tail.connect(offlineCtx.destination);

      const offset = Math.min(clip.sourceStart, Math.max(0, decodedBuffer.duration - 0.01));
      const bufferDurationAvailable = Math.max(0, decodedBuffer.duration - offset);
      // F4: the source window consumed is `duration * rate` (the rate is the
      // resolved one, identical to the preview).
      const playDuration = Math.min(clip.duration * playback.rate, bufferDurationAvailable);
      if (playDuration > 0) {
        // EX-02: `duration` is expressed in *buffer* seconds and is
        // independent of `playbackRate`. Passing `playDuration / speed` made
        // the audio play at 1/speed² (half of the clip silent at speed 2 and
        // an overrun at speed 0.5). `playDuration` is already expressed in
        // buffer seconds, so it must be passed unchanged.
        sourceNode.start(clip.start, offset, playDuration);
        hasValidAudio = true;
      }
    } catch {
      if (signal?.aborted) {
        throw new Error('Exportación cancelada por el usuario');
      }
      // Ignore clips whose audio cannot be decoded
    } finally {
      // Release the decoded PCM of this media as soon as the last clip that
      // needs it has been processed.
      const left = (pendingUses.get(clip.mediaId) ?? 1) - 1;
      pendingUses.set(clip.mediaId, left);
      if (left <= 0) {
        decodedCache.delete(clip.mediaId);
      }
    }
  }

  if (!hasValidAudio) return null;
  const rendered = await offlineCtx.startRendering();
  if (signal?.aborted) {
    throw new Error('Exportación cancelada por el usuario');
  }
  return rendered;
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
 *
 * `frameSize` MUST match the number of samples actually handed to the encoder.
 * The export pipeline encodes 2048-sample blocks, so when the browser does not
 * report `chunk.duration` (WebKit / iOS Safari) the fallback duration has to be
 * 2048 samples too — assuming 1024 declared an audio track half as long as
 * the video (A/V desync of ~50 %).
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
  preAllocatedData?: Uint8Array,
  frameSize = 1024
): void {
  let audioData: Uint8Array;
  if (preAllocatedData) {
    audioData = preAllocatedData;
  } else {
    audioData = new Uint8Array(chunk.byteLength);
    chunk.copyTo(audioData);
  }

  const safeSampleRate = Math.max(1, Math.round(sampleRate));
  const expectedAudioDurationUs = Math.round((frameSize / safeSampleRate) * 1_000_000);
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
 * Normalises any thrown value into a readable message.
 *
 * `exportVideo()` may reject with a `DOMException`, a plain string or even
 * `undefined`. Reading `.message` off a non-Error used to throw *inside the
 * catch block* of the export modal, leaving the UI stuck in "rendering"
 * forever (EX-23).
 */
export function toErrorMessage(err: unknown, fallback = 'Error durante la exportación'): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.length > 0) return err;
  if (err && typeof err === 'object') {
    const maybeMessage = (err as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.length > 0) return maybeMessage;
    try {
      const serialised = JSON.stringify(err);
      if (serialised && serialised !== '{}') return serialised;
    } catch {
      // ignore
    }
  }
  return fallback;
}

/**
 * Detects a user cancellation (as opposed to a genuine encoder failure).
 * Used to make sure a cancellation is never swallowed by the MediaRecorder
 * degradation path.
 */
export function isAbortLikeError(err: unknown): boolean {
  if (!err) return false;
  const name =
    err instanceof DOMException ? err.name : (err as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const message = toErrorMessage(err, '');
  return /cancelad|canceled|cancelled|abort/i.test(message);
}

/**
 * Formatos de contenedor que `exportVideo` sabe producir.
 *
 * - `mp4`: camino acelerado WebCodecs (H.264 + mp4-muxer) con degradación a
 *   MediaRecorder cuando el encoder de la plataforma falla.
 * - `webm`: SIEMPRE el grabador de respaldo (`exportWithMediaRecorder`, el
 *   MISMO que ya existe: sin segundo grabador). Es el formato nativo del
 *   camino MediaRecorder (VP9/VP8) y produce un archivo válido y reproducible
 *   con vídeo y audio.
 */
export type ExportContainerFormat = 'mp4' | 'webm';

/**
 * Candidatos MIME del grabador de respaldo según el formato pedido.
 *
 * El orden importa: el grabador prueba cada candidato con construir + start()
 * reales (`startRecorderWithFallback`) y se queda con el primero que arranca.
 *
 * Para MP4 se mantiene EXACTAMENTE el orden histórico al principio (mp4
 * primero), así que el camino MP4 en Chrome no cambia ni un byte: Chrome
 * arranca con el primer candidato y nunca llega a los siguientes.
 *
 * Tras los mp4 van las variantes webm CON códec de audio (`opus`) y el
 * contenedor bare: son las únicas que Firefox acepta cuando el stream lleva
 * pista de audio (`isTypeSupported('video/webm;codecs=vp8')` dice "sí" pero
 * su `start()` muere con audio). Las variantes planas se conservan al final
 * por si el stream no lleva audio. Nuevo contrato: todo candidato debe ser
 * válido para un stream con audio, y por eso las variantes con audio van
 * delante.
 */
export function resolveRecorderMimeCandidates(format: ExportContainerFormat): string[] {
  if (format === 'webm') {
    return [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
    ];
  }
  return [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
  ];
}

/**
 * Elige el MIME del grabador de respaldo para el formato pedido.
 *
 * Reutiliza la detección que ya existe (`MediaRecorder.isTypeSupported`, la
 * misma que usa `getSupportedVideoMimeType` en `sampleMedia.ts`): devuelve el
 * primer candidato soportado o `''` cuando hay que dejar que el navegador
 * decida. Exportada para los tests de regresión.
 */
export function pickRecorderMimeType(
  format: ExportContainerFormat,
  isTypeSupported?: (mime: string) => boolean
): string {
  const probe =
    isTypeSupported ??
    (typeof MediaRecorder !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function'
      ? (mime: string) => {
          try {
            return MediaRecorder.isTypeSupported(mime);
          } catch {
            return false;
          }
        }
      : undefined);
  if (!probe) return '';
  return resolveRecorderMimeCandidates(format).find((mime) => probe(mime)) ?? '';
}

/**
 * Opciones mínimas para construir un grabador en `startRecorderWithFallback`.
 * Es el subconjunto de `MediaRecorderOptions` que usa el respaldo.
 */
export interface RecorderStartOptions {
  mimeType?: string;
  videoBitsPerSecond?: number;
}

/** Superficie mínima de un grabador que `startRecorderWithFallback` necesita. */
export interface StartableRecorder {
  start(timeslice?: number): void;
  readonly mimeType?: string;
}

/**
 * Arranca un grabador probando cada candidato DE VERDAD (construir + start()),
 * no solo con `MediaRecorder.isTypeSupported()`.
 *
 * La sonda `isTypeSupported` solo valida el códec de vídeo: en Firefox dice
 * "sí" a `video/webm;codecs=vp8` pero su `start()` rechaza el stream cuando
 * lleva pista de audio. Por eso cada candidato se construye Y se arranca
 * dentro del `try/catch`: si el constructor o `start()` lanzan, se sigue con
 * el siguiente (un `start()` fallido deja el grabador inactivo y los tracks
 * del stream intactos, así que el mismo stream se reutiliza).
 *
 * Si se agotan los candidatos se prueba una última vez con los defaults del
 * navegador (sin `mimeType`); si tampoco arranca se lanza un error accionable
 * en español (ver `buildRecorderFallbackError`).
 *
 * El arranque usa un `timeslice` de 1 s: sin él el navegador entrega TODO en
 * un único `ondataavailable` al parar (~450 MB a los 10 min de una tacada) y
 * el sumidero no podría ir escribiendo a disco por el camino (P10).
 *
 * La fábrica es inyectable para poder testearla en node sin DOM. En Chrome,
 * donde todos los candidatos arrancan, el elegido es el primero de la lista,
 * así que el fallback de Chrome no cambia de byte.
 */
export function startRecorderWithFallback<R extends StartableRecorder>(
  stream: MediaStream,
  candidates: string[],
  createRecorder: (stream: MediaStream, options?: RecorderStartOptions) => R,
  videoBitsPerSecond?: number,
  opts?: { hardwareDetail?: string }
): { recorder: R; mimeType: string } {
  const tried: string[] = [];
  let lastError: unknown = null;

  for (const mimeType of candidates) {
    tried.push(mimeType);
    let recorder: R;
    try {
      recorder = createRecorder(stream, { mimeType, videoBitsPerSecond });
    } catch (err) {
      // El constructor rechaza el MIME (p. ej. mp4 en Firefox): siguiente.
      lastError = err;
      continue;
    }
    try {
      recorder.start(RECORDER_TIMESLICE_MS);
    } catch (err) {
      // El constructor aceptó pero start() rechaza el stream (p. ej. vp8 con
      // audio en Firefox): el grabador queda inactivo, el stream intacto.
      lastError = err;
      continue;
    }
    return { recorder, mimeType };
  }

  // "Retry with browser defaults": sin mimeType, el navegador elige.
  try {
    const recorder = createRecorder(
      stream,
      videoBitsPerSecond !== undefined ? { videoBitsPerSecond } : undefined
    );
    recorder.start(RECORDER_TIMESLICE_MS);
    return { recorder, mimeType: recorder.mimeType || '' };
  } catch (err) {
    lastError = err;
  }

  if (opts?.hardwareDetail) {
    throw buildRecorderFallbackError(tried, lastError, opts.hardwareDetail);
  }
  throw new RecorderStartFailedError(tried, lastError);
}

/**
 * El respaldo agotó todos los candidatos y el modo automático del navegador.
 *
 * Lleva los datos (`triedMimeTypes`, `lastError`) ADEMÁS del mensaje: cuando
 * el camino acelerado también falló, `exportVideo` reconstruye UN SOLO error
 * combinado (sin anidar dos veces la lista de formatos ni la sugerencia).
 */
export class RecorderStartFailedError extends Error {
  readonly triedMimeTypes: string[];
  readonly lastError: unknown;
  constructor(triedMimeTypes: string[], lastError: unknown) {
    super(buildRecorderFallbackError(triedMimeTypes, lastError).message);
    this.name = 'RecorderStartFailedError';
    this.triedMimeTypes = [...triedMimeTypes];
    this.lastError = lastError;
  }
}

/**
 * Error final del respaldo, accionable y en español.
 *
 * Dice las dos cosas que pasaron cuando `hardwareDetail` viene informado (el
 * camino acelerado falló Y el respaldo tampoco pudo grabar), lista los
 * formatos que se probaron, conserva el detalle técnico original y sugiere
 * una salida (navegador con WebCodecs o formato WebM).
 */
export function buildRecorderFallbackError(
  triedMimeTypes: string[],
  cause: unknown,
  hardwareDetail?: string
): Error {
  const detail =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : String(cause ?? 'error desconocido');
  const tried =
    triedMimeTypes.length > 0
      ? `se probaron los formatos ${triedMimeTypes.map((m) => `"${m}"`).join(', ')} y el modo automático del navegador`
      : 'se probó el modo automático del navegador';
  const hardwarePrefix = hardwareDetail
    ? `La exportación acelerada por hardware falló (${hardwareDetail}) y el respaldo tampoco pudo grabar: `
    : 'No se pudo grabar el vídeo con el respaldo (MediaRecorder): ';
  return new Error(
    `${hardwarePrefix}${tried}, sin éxito (detalle técnico: ${detail}). ` +
      `Prueba a exportar en un navegador con WebCodecs (Chrome/Edge) o usa el formato WebM.`
  );
}

/**
 * Extensión del archivo descargado a partir del MIME grabado y del formato
 * pedido. El MIME manda (es lo que realmente contiene el blob); el formato es
 * el respaldo cuando el MIME viene vacío.
 */
export function exportFileExtensionFor(mimeType: string, format: ExportContainerFormat): 'mp4' | 'webm' {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  return format === 'webm' ? 'webm' : 'mp4';
}

/**
 * Nombre del archivo descargado (`minusculas_con_guiones_resolucion.ext`).
 * Exportado para los tests: la extensión debe acompañar al formato.
 */
export function buildExportFilename(
  projectName: string,
  resolutionLabel: string,
  range: { start: number; end: number } | null,
  extension: 'mp4' | 'webm'
): string {
  const base = projectName.toLowerCase().replace(/\s+/g, '_');
  const rangeSuffix = range ? `_${range.start}-${range.end}` : '';
  return `${base}_${resolutionLabel}${rangeSuffix}.${extension}`;
}

/**
 * Seeks every video clip that is active at `time` so the frame that is about
 * to be composited is the right one.
 *
 * This helper is shared by BOTH export paths. The MediaRecorder fallback used
 * to skip it entirely, which meant every video clip was exported as a frozen
 * frame for its whole duration (EX-01): the compositor only *requests* a seek
 * (`syncVideoTime`) but draws the element synchronously, so it painted the
 * previous frame while the decoder was still seeking.
 */
export async function seekActiveVideoClips(
  time: number,
  clips: Clip[],
  mediaMap: Map<string, MediaItem>,
  getVideoElement: (
    media: MediaItem,
    clipId?: string,
    sourceStart?: number
  ) => HTMLVideoElement
): Promise<void> {
  const activeVideoClips = clips.filter(
    (c) => c.type === 'video' && time >= c.start && time < c.start + c.duration
  );
  if (activeVideoClips.length === 0) return;

  await Promise.all(
    activeVideoClips.map((vc) => {
      const media = mediaMap.get(vc.mediaId);
      if (!media) return Promise.resolve();
      const videoEl = getVideoElement(media, vc.id, vc.sourceStart);
      // F-A3-03: la ventana de fuente avanza a la velocidad RESUELTA (la
      // misma del audio, del preview y del export de audio), nunca al `speed`
      // crudo del clip.
      const speed = resolvePlayback(vc).rate;
      const sourceOffset = vc.sourceStart + (time - vc.start) * speed;
      const maxSourceTime = Math.max(0, (media.duration || 1000) - 0.05);
      const clampedOffset = Math.max(0, Math.min(maxSourceTime, sourceOffset));
      return seekVideoElement(videoEl, clampedOffset);
    })
  );
}

/**
 * Gives the exporter its own isolated media-element pool.
 *
 * The exporter used to reuse the *global* `MediaSourcePool` of the live
 * preview (H9 / E-08): it seeked the preview's `<video>` elements to export
 * positions (desynchronising the preview), kept the decoders hijacked after
 * the export and could encode a stale frame taken from the shared
 * `lastFrameMap` cache.
 *
 * The pool is not injectable into `Compositor` (it is a module singleton), so
 * the exporter temporarily routes the singleton's element/cache accessors to a
 * private pool and restores them afterwards.
 */
export interface ExportPoolIsolation {
  pool: MediaSourcePool;
  restore(): void;
}

export function createExportPoolIsolation(): ExportPoolIsolation {
  const pool = new MediaSourcePool();
  const target = mediaSourcePool as unknown as {
    getVideoElement: MediaSourcePool['getVideoElement'];
    getImageElement: MediaSourcePool['getImageElement'];
    storeVideoFrame: MediaSourcePool['storeVideoFrame'];
    getLastFrame: MediaSourcePool['getLastFrame'];
  };

  const original = {
    getVideoElement: target.getVideoElement,
    getImageElement: target.getImageElement,
    storeVideoFrame: target.storeVideoFrame,
    getLastFrame: target.getLastFrame,
  };

  target.getVideoElement = (media, clipId, sourceStart) =>
    pool.getVideoElement(media, clipId, sourceStart);
  target.getImageElement = (media, clipId) => pool.getImageElement(media, clipId);
  target.storeVideoFrame = (clipId, video, mediaId, force) =>
    pool.storeVideoFrame(clipId, video, mediaId, force);
  target.getLastFrame = (id) => pool.getLastFrame(id);

  let restored = false;
  return {
    pool,
    restore() {
      if (restored) return;
      restored = true;
      target.getVideoElement = original.getVideoElement;
      target.getImageElement = original.getImageElement;
      target.storeVideoFrame = original.storeVideoFrame;
      target.getLastFrame = original.getLastFrame;
      // Release the exporter's own elements/decoders.
      try {
        pool.clear();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Main export function using WebCodecs + mp4-muxer with MediaRecorder fallback.
 */
export async function exportVideo(params: ExportParams): Promise<Blob> {
  const fps = Math.max(1, Math.round(params.config.fps || 30));
  // P9/P10: la guarda de duración dispara antes de probar encoders, de
  // reservar el lienzo y de grabar nada (el MediaRecorder también retiene la
  // grabación entera en RAM).
  assertExportAudioBudget(params.duration);
  const totalFrames = Math.max(1, Math.round(params.duration * fps));
  const startTime = performance.now();
  const format: ExportContainerFormat = params.config.format === 'webm' ? 'webm' : 'mp4';

  // WebM: SIEMPRE el grabador de respaldo (MediaRecorder, VP9/VP8), el MISMO
  // `exportWithMediaRecorder` que ya existe — sin segundo grabador — y con los
  // MISMOS fotogramas del `Compositor` que el preview. Es una grabación en
  // tiempo real (un proyecto de 10 s tarda 10 s) y NO usa la aceleración GPU
  // del camino MP4 (ver el aviso del modal de exportación).
  if (format === 'webm') {
    return await exportWithMediaRecorder(params, totalFrames, fps);
  }

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
      try {
        return await exportWithWebCodecs(params, totalFrames, startTime, workingConfig, fps);
      } catch (err) {
        // EX-04: a genuine encoder failure must degrade to the MediaRecorder
        // path instead of failing the whole export. A user cancellation is
        // never swallowed: aborting must abort.
        if (params.signal?.aborted || isAbortLikeError(err)) {
          throw err;
        }
        console.warn(
          'La exportación con WebCodecs falló; se degrada a MediaRecorder como respaldo:',
          err
        );
        try {
          return await exportWithMediaRecorder(params, totalFrames, fps);
        } catch (fallbackError) {
          // Fallaron las dos cosas (el camino acelerado Y el respaldo): el
          // error final lo dice todo, en español y con salida accionable. Si
          // el respaldo ya trae sus datos, se reutilizan para no anidar dos
          // veces la lista de formatos ni la sugerencia.
          console.warn('El respaldo con MediaRecorder también falló:', fallbackError);
          if (fallbackError instanceof RecorderStartFailedError) {
            throw buildRecorderFallbackError(
              fallbackError.triedMimeTypes,
              fallbackError.lastError,
              toErrorMessage(err)
            );
          }
          throw buildRecorderFallbackError(
            resolveRecorderMimeCandidates(format),
            fallbackError,
            toErrorMessage(err)
          );
        }
      }
    }
    console.warn(
      `WebCodecs no soporta ${width}x${height}@${fps}fps en este dispositivo; usando MediaRecorder como respaldo.`
    );
  }
  // Fallback: Canvas captureStream + MediaRecorder
  return await exportWithMediaRecorder(params, totalFrames, fps);
}

/**
 * Number of samples per audio block handed to the AudioEncoder.
 * The fallback duration used when the browser does not report `chunk.duration`
 * has to match this value, otherwise the muxed audio track is shorter than
 * the video (EX-05).
 */
export const AUDIO_BLOCK_SIZE = 2048;

/**
 * Encoded audio kept in memory until the muxer is created.
 */
interface EncodedAudioTrack {
  codec: 'aac' | 'opus';
  sampleRate: number;
  chunks: Array<{
    data: Uint8Array;
    type: 'key' | 'delta';
    timestamp: number;
    duration: number | null;
    meta?: EncodedAudioChunkMetadata;
  }>;
}

/**
 * Encodes the rendered audio BEFORE the muxer is created.
 *
 * EX-06: the muxer used to be created first (declaring the audio track) and
 * the AudioEncoder failure was swallowed, so the MP4 ended up with a declared
 * but empty (or truncated) audio track. Encoding first means we can decide
 * *explicitly* whether the audio track exists: on failure the track is simply
 * not declared, never muxed half-empty.
 */
async function encodeAudioTrack(
  renderedAudio: AudioBuffer | null,
  audioConfig: { codec: 'aac' | 'opus'; encoderCodec: string; bitrate: number } | null,
  signal?: AbortSignal
): Promise<EncodedAudioTrack | null> {
  if (!renderedAudio || !audioConfig || typeof AudioEncoder === 'undefined') return null;

  const chunks: EncodedAudioTrack['chunks'] = [];
  let encoderError: Error | null = null;

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      try {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({
          data,
          type: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration ?? null,
          meta: meta ?? undefined,
        });
      } catch (err) {
        console.warn('No se pudo copiar el fragmento de audio:', err);
      }
    },
    error: (e) => {
      encoderError = e instanceof Error ? e : new Error(toErrorMessage(e));
      console.error('AudioEncoder error:', e);
    },
  });

  try {
    audioEncoder.configure({
      codec: audioConfig.encoderCodec,
      numberOfChannels: 2,
      sampleRate: renderedAudio.sampleRate,
      bitrate: audioConfig.bitrate,
    });

    const numFrames = renderedAudio.length;
    const left = renderedAudio.getChannelData(0);
    const right = renderedAudio.numberOfChannels > 1 ? renderedAudio.getChannelData(1) : left;

    // Preallocate planar buffer to eliminate thousands of small allocations during export
    const planarBuffer = new Float32Array(AUDIO_BLOCK_SIZE * 2);

    for (let offset = 0; offset < numFrames; offset += AUDIO_BLOCK_SIZE) {
      if (signal?.aborted) {
        throw new Error('Exportación cancelada por el usuario');
      }
      if (encoderError) throw encoderError;

      // Audio backpressure control
      if (audioEncoder.encodeQueueSize > 8) {
        await waitForAudioDrain(audioEncoder, 4);
      }

      const framesInChunk = Math.min(AUDIO_BLOCK_SIZE, numFrames - offset);
      let chunkData: Float32Array;

      if (framesInChunk === AUDIO_BLOCK_SIZE) {
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

    if (encoderError) throw encoderError;
    if (chunks.length === 0) {
      throw new Error('El codificador de audio no produjo ningún fragmento.');
    }

    return { codec: audioConfig.codec, sampleRate: renderedAudio.sampleRate, chunks };
  } catch (err) {
    if (signal?.aborted) {
      throw new Error('Exportación cancelada por el usuario');
    }
    // The audio track is dropped EXPLICITLY: the muxer will not declare it,
    // so the MP4 can never contain an empty or truncated audio track.
    console.warn(
      'El codificador de audio falló; la exportación continuará SIN audio (no se muxará una pista vacía):',
      err
    );
    return null;
  } finally {
    try {
      if (audioEncoder.state !== 'closed') audioEncoder.close();
    } catch {
      // ignore close errors
    }
  }
}

/**
 * Hardware-accelerated WebCodecs export with robust metadata sanitization and backpressure.
 */
async function exportWithWebCodecs(
  params: ExportParams,
  totalFrames: number,
  renderStartTime: number,
  workingConfig: WorkingVideoEncoderConfig,
  fps: number
): Promise<Blob> {
  const { config, duration, tracks, clips, mediaPool, onProgress, signal } = params;
  // Ensure even dimensions for H.264 hardware encoders
  const width = config.width - (config.width % 2);
  const height = config.height - (config.height % 2);

  // H9 / E-08: the exporter gets its own media-element pool so the live
  // preview keeps its decoders and its frame cache.
  const isolation = createExportPoolIsolation();

  const mediaMap = new Map<string, MediaItem>();
  for (const m of mediaPool) mediaMap.set(m.id, m);

  try {
    // 1. Prepare offline audio if available
    let renderedAudio: AudioBuffer | null = null;
    try {
      // El solo manda sobre la mezcla (preview ≡ export): las pistas no solo
      // llegan enmudecidas al render, la MISMA decisión del preview y del WAV
      // (`applySoloToTracks`; sin solo devuelve el mismo array, sin asignar).
      const pistasEfectivas = applySoloToTracks(tracks);
      renderedAudio = await renderOfflineAudio(
        duration,
        pistasEfectivas,
        clips,
        mediaPool,
        signal,
        resolveExportMasterVolume(params.masterVolume)
      );
    } catch (err) {
      if (signal?.aborted || isAbortLikeError(err)) throw err;
      console.warn('Offline audio render failed, exporting video without audio:', err);
    }
    if (signal?.aborted) {
      throw new Error('Exportación cancelada por el usuario');
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

    // 2. Encode the audio BEFORE creating the muxer, so a failure can drop
    //    the audio track explicitly instead of muxing a broken one (EX-06).
    const encodedAudio = await encodeAudioTrack(renderedAudio, audioConfig, signal);
    if (signal?.aborted) {
      throw new Error('Exportación cancelada por el usuario');
    }

    // 3. Setup mp4-muxer with stream buffering and timestamp offsets
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: {
        codec: 'avc',
        width,
        height,
        frameRate: fps,
      },
      audio: encodedAudio
        ? {
            codec: encodedAudio.codec,
            numberOfChannels: 2,
            sampleRate: encodedAudio.sampleRate,
          }
        : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    // Feed the already-encoded audio into the muxer.
    if (encodedAudio) {
      for (const chunk of encodedAudio.chunks) {
        safeAddAudioChunk(
          muxer,
          {
            byteLength: chunk.data.byteLength,
            copyTo: (dest: Uint8Array) => dest.set(chunk.data),
            type: chunk.type,
            timestamp: chunk.timestamp,
            duration: chunk.duration,
          },
          chunk.meta,
          encodedAudio.sampleRate,
          chunk.data,
          AUDIO_BLOCK_SIZE
        );
      }
    }

    // Use the encoder configuration that was deep-probed in exportVideo
    // (codec + hardwareAcceleration validated by actually creating a real
    // encoder and verifying it survives). This avoids the async platform
    // encoder death ("Operation is not supported") that isConfigSupported()
    // cannot detect.
    const activeCodec = workingConfig.codec;

    // 4. Active video decoder configuration tracking
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
    // If it still fails (encoder raced to closed), `exportVideo` degrades to
    // the MediaRecorder path instead of surfacing a raw platform error.
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
      try {
        if (videoEncoder.state !== 'closed') videoEncoder.close();
      } catch {
        // ignore close errors during failed setup
      }
      throw toActionableExportError(
        asyncCause ?? new Error('el encoder de la plataforma se cerró al configurarse'),
        { width, height, fps }
      );
    }

    // 5. Canvas & compositor
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const compositor = new Compositor();

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
        await seekActiveVideoClips(t, clips, mediaMap, (media, clipId, sourceStart) =>
          isolation.pool.getVideoElement(media, clipId, sourceStart)
        );

        // Render frame to canvas
        // F9: the colour filters of the clip are applied by the compositor
        // itself (the SAME class the preview uses), so the exported pixels are
        // filtered exactly like the previewed ones. La rotación, el volteo y
        // el recorte del clip viajan por el mismo camino (ver
        // `resolveExportClipTransform`): el MP4 y el preview acuerdan por
        // construcción.
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
        try {
          videoEncoder.close();
        } catch {
          // ignore close errors (never mask the original error)
        }
      }
    }

    const buffer = target.buffer;
    if (!buffer || buffer.byteLength === 0) {
      throw new Error('El archivo MP4 generado está vacío (0 bytes). Intenta de nuevo.');
    }
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
  } finally {
    isolation.restore();
  }
}

/**
 * Intervalo (ms) con el que el grabador de respaldo entrega fragmentos.
 * Ver `startRecorderWithFallback`.
 */
export const RECORDER_TIMESLICE_MS = 1000;

/**
 * Maximum time we wait for `MediaRecorder.onstop` to fire after `stop()`.
 * Without it a broken recorder leaves the export promise pending forever and
 * the UI stuck in "rendering" (EX-11).
 */
export const RECORDER_STOP_TIMEOUT_MS = 10_000;

/**
 * Sumidero de los fragmentos del grabador de respaldo (P10).
 *
 * P10: el respaldo retenía TODA la grabación en RAM (`chunks: Blob[]`, ~450 MB
 * a los 10 min @6 Mbps) y al ensamblar (`new Blob(chunks)`) el pico se
 * duplicaba (retenido + copia final). El sumidero escribe cada fragmento a
 * disco (OPFS) cuando el navegador lo permite, así que durante la grabación
 * no se retiene casi nada en RAM y el pico final es una sola copia en vez de
 * dos. Sin OPFS degrada al array en RAM de siempre (una copia retenida, como
 * hoy, pero sin copiar los bytes hasta el ensamblado final: `new Blob` con
 * partes `Blob` ya es una sola copia).
 */
export interface RecorderChunkSink {
  /** Guarda un fragmento (ignora los vacíos). Nunca lanza. */
  push(chunk: Blob): void;
  /** Bytes guardados hasta ahora. */
  readonly bytes: number;
  /** Fragmentos guardados hasta ahora. */
  readonly count: number;
  /** Ensambla el archivo final (una sola copia). */
  finalize(mimeType: string, emptyTypeFallback: string): Promise<Blob>;
  /** Descarta lo guardado (borra el temporal de disco si lo hay). */
  discard(): Promise<void>;
}

/** Sumidero en RAM (el comportamiento histórico, sin copiar hasta el final). */
export function createRamRecorderChunkSink(): RecorderChunkSink {
  const parts: Blob[] = [];
  let bytes = 0;
  return {
    push(chunk: Blob): void {
      try {
        if (!chunk || chunk.size <= 0) return;
        parts.push(chunk);
        bytes += chunk.size;
      } catch {
        // Un fragmento corrupto no puede tumbar la exportación.
      }
    },
    get bytes(): number {
      return bytes;
    },
    get count(): number {
      return parts.length;
    },
    async finalize(mimeType: string, emptyTypeFallback: string): Promise<Blob> {
      // `new Blob` con partes `Blob` concatena en UNA copia (ya verificado:
      // no hay duplicado intermedio; el pico es retenido + final).
      return new Blob(parts as BlobPart[], { type: mimeType || emptyTypeFallback });
    },
    async discard(): Promise<void> {
      parts.length = 0;
      bytes = 0;
    },
  };
}

interface OpfsDirectoryHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{
    createWritable(): Promise<{
      write(chunk: Blob): Promise<void>;
      close(): Promise<void>;
      abort(): Promise<void>;
    }>;
    getFile(): Promise<Blob>;
  }>;
  removeEntry(name: string): Promise<void>;
}

/** Sumidero en OPFS, o `null` cuando no está disponible (degrada a RAM). */
async function createOpfsRecorderChunkSink(): Promise<RecorderChunkSink | null> {
  try {
    const storage = (
      globalThis as unknown as { navigator?: { storage?: { getDirectory?: () => Promise<OpfsDirectoryHandle> } } }
    ).navigator?.storage;
    if (!storage || typeof storage.getDirectory !== 'function') return null;
    const dir = await storage.getDirectory();
    const name = `hydra-export-${Date.now()}-${Math.floor(Math.random() * 1e9)}.tmp`;
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    let totalBytes = 0;
    let count = 0;
    let settled = false;
    // Si una escritura a disco falla (cuota, OPFS capado, motor sin soporte
    // real), el sumidero NO pierde el fragmento: lo guarda en RAM y todo lo
    // siguiente va a RAM también. Al finalizar se ensambla el prefijo de
    // disco más el sufijo de RAM, en orden. Nunca un archivo corrupto.
    let ramFallback = false;
    const ramParts: Blob[] = [];
    let diskBytes = 0;
    // Las escrituras se encadenan: el stream no admite `write` concurrentes.
    // La cadena conserva el orden aunque falle una escritura (el fragmento
    // fallido y los siguientes van al sufijo de RAM, en orden).
    let tail: Promise<void> = Promise.resolve();
    return {
      push(chunk: Blob): void {
        try {
          if (settled || !chunk || chunk.size <= 0) return;
          totalBytes += chunk.size;
          count++;
          if (ramFallback) {
            ramParts.push(chunk);
            return;
          }
          tail = tail.then(
            () =>
              writable.write(chunk).then(
                () => {
                  diskBytes += chunk.size;
                },
                () => {
                  ramFallback = true;
                  ramParts.push(chunk);
                }
              ),
            () => {
              ramFallback = true;
              ramParts.push(chunk);
            }
          );
        } catch {
          // Ignorado (ver `push` de RAM).
        }
      },
      get bytes(): number {
        return totalBytes;
      },
      get count(): number {
        return count;
      },
      async finalize(mimeType: string, emptyTypeFallback: string): Promise<Blob> {
        settled = true;
        await tail;
        try {
          await writable.close();
        } catch {
          // El cierre puede fallar si el stream ya murió: el ensamblado de
          // abajo verifica los bytes de todos modos.
        }
        const type = mimeType || emptyTypeFallback;
        if (!ramFallback && ramParts.length === 0) {
          // Camino rápido: todo está en disco. Los bytes se materializan
          // ANTES de borrar el temporal (un `Blob` sobre un fichero borrado
          // puede leerse vacío en algunos motores: lectura perezosa).
          const file = await handle.getFile();
          if (file.size !== totalBytes) {
            throw new Error(
              `el temporal de disco quedó incompleto (${file.size} de ${totalBytes} B)`
            );
          }
          const bytes = await file.arrayBuffer();
          try {
            await dir.removeEntry(name);
          } catch {
            // El temporal ya no existe: nada que limpiar.
          }
          return new Blob([bytes], { type });
        }
        // Híbrido: prefijo de disco + sufijo de RAM, en orden, verificado.
        let prefix: Blob | null = null;
        if (diskBytes > 0) {
          const file = await handle.getFile();
          if (file.size !== diskBytes) {
            throw new Error(
              `el temporal de disco quedó incompleto (${file.size} de ${diskBytes} B)`
            );
          }
          prefix = new Blob([await file.arrayBuffer()]);
        }
        try {
          await dir.removeEntry(name);
        } catch {
          // Ignorado.
        }
        const assembled = new Blob(
          (prefix ? [prefix, ...ramParts] : [...ramParts]) as BlobPart[],
          { type }
        );
        if (assembled.size !== totalBytes) {
          throw new Error(
            `el ensamblado quedó incompleto (${assembled.size} de ${totalBytes} B)`
          );
        }
        return assembled;
      },
      async discard(): Promise<void> {
        settled = true;
        try {
          await tail;
        } catch {
          // Ignorado.
        }
        try {
          await writable.abort();
        } catch {
          try {
            await writable.close();
          } catch {
            // Ignorado.
          }
        }
        ramParts.length = 0;
        try {
          await dir.removeEntry(name);
        } catch {
          // Ignorado.
        }
      },
    };
  } catch {
    return null;
  }
}

/**
 * Crea el sumidero de fragmentos: OPFS cuando se puede (casi nada en RAM),
 * RAM cuando no (comportamiento histórico). Nunca lanza.
 */
export async function createRecorderChunkSink(): Promise<RecorderChunkSink> {
  return (await createOpfsRecorderChunkSink()) ?? createRamRecorderChunkSink();
}

/**
 * Fallback export using MediaRecorder.
 */
async function exportWithMediaRecorder(
  params: ExportParams,
  totalFrames: number,
  fps: number
): Promise<Blob> {
  const { config, duration, tracks, clips, mediaPool, onProgress, signal } = params;
  const width = config.width - (config.width % 2);
  const height = config.height - (config.height % 2);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const compositor = new Compositor();

  const mediaMap = new Map<string, MediaItem>();
  for (const m of mediaPool) mediaMap.set(m.id, m);

  // H9 / E-08: isolated pool for the fallback path too, so the preview keeps
  // its own decoders and frame cache.
  const isolation = createExportPoolIsolation();

  const hasCaptureStream =
    typeof canvas.captureStream === 'function' ||
    typeof (canvas as unknown as { webkitCaptureStream?: unknown }).webkitCaptureStream === 'function';

  if (!hasCaptureStream) {
    isolation.restore();
    throw new Error(
      'Tu navegador o entorno webview no soporta la captura de canvas en tiempo real (HTMLCanvasElement.captureStream). ' +
      'Para exportar videos, utiliza un navegador compatible como Google Chrome, Microsoft Edge, Firefox o Safari actualizado.'
    );
  }

  const stream: MediaStream =
    typeof canvas.captureStream === 'function'
      ? canvas.captureStream(fps)
      : (canvas as unknown as { webkitCaptureStream: (fps: number) => MediaStream }).webkitCaptureStream(fps);

  // Render offline audio if available and attach to MediaStream
  let offlineAudioCtx: AudioContext | null = null;
  try {
    // El solo manda también en el respaldo (misma regla que arriba y que el WAV).
    const pistasEfectivas = applySoloToTracks(tracks);
    const renderedAudio = await renderOfflineAudio(
      duration,
      pistasEfectivas,
      clips,
      mediaPool,
      signal,
      resolveExportMasterVolume(params.masterVolume)
    );
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
    if (signal?.aborted || isAbortLikeError(err)) {
      isolation.restore();
      throw err;
    }
    console.warn('Could not attach audio to MediaRecorder stream:', err);
  }

  if (typeof MediaRecorder === 'undefined') {
    isolation.restore();
    throw new Error(
      'Tu navegador o entorno webview no soporta la API MediaRecorder necesaria para exportar video. ' +
      'Para exportar videos, utiliza un navegador compatible como Google Chrome, Microsoft Edge, Firefox o Safari actualizado.'
    );
  }

  const mimeCandidates = resolveRecorderMimeCandidates(
    params.config.format === 'webm' ? 'webm' : 'mp4'
  );

  // El MIME se elige probando de verdad (construir + start()), no solo con
  // `isTypeSupported()`: en Firefox esa sonda dice "sí" a vp8 pero su
  // `start()` rechaza el stream cuando lleva pista de audio. Si todos los
  // candidatos fallan se reintenta con los defaults del navegador; si tampoco,
  // el error ya es accionable y en español.
  let recorder: MediaRecorder;
  let mimeType: string;
  try {
    const started = startRecorderWithFallback(
      stream,
      mimeCandidates,
      (s, options) => new MediaRecorder(s, options),
      config.bitrate
    );
    recorder = started.recorder;
    mimeType = started.mimeType;
  } catch (err) {
    isolation.restore();
    throw err instanceof Error ? err : new Error(toErrorMessage(err));
  }
  // P10: los fragmentos van al sumidero (OPFS cuando se puede: casi nada en
  // RAM durante la grabación) en vez de retenerse todos en un array.
  const sink = await createRecorderChunkSink();

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) sink.push(e.data);
  };

  // El grabador ya arrancó dentro de `startRecorderWithFallback`: si estamos
  // aquí, `start()` funcionó para el MIME elegido.

  return new Promise<Blob>((resolve, reject) => {
    let frameIdx = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopTimeout: ReturnType<typeof setTimeout> | null = null;
    const intervalMs = 1000 / fps;

    // EX-12: the MediaStream tracks (canvas capture + audio destination) are
    // never released, so the canvas kept producing frames for the whole
    // session. They are stopped on every exit path.
    const releaseResources = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (stopTimeout !== null) {
        clearTimeout(stopTimeout);
        stopTimeout = null;
      }
      try {
        for (const track of stream.getTracks()) track.stop();
      } catch {
        // ignore
      }
      try {
        canvas.width = 0;
        canvas.height = 0;
      } catch {
        // ignore
      }
      // El temporal de disco del sumidero (si lo hay) se borra aquí en todos
      // los caminos de salida; tras un `finalize` con éxito ya no existe.
      void sink.discard().catch(() => {});
      if (offlineAudioCtx) {
        const ctx = offlineAudioCtx;
        offlineAudioCtx = null;
        try {
          void ctx.close().catch(() => {});
        } catch {
          // ignore
        }
      }
      isolation.restore();
    };

    const resolveOnce = (blob: Blob) => {
      if (settled) return;
      settled = true;
      releaseResources();
      resolve(blob);
    };

    const rejectOnce = (err: Error) => {
      if (settled) return;
      settled = true;
      releaseResources();
      reject(err);
    };

    // EX-11: `recorder.stop()` may throw (InvalidStateError / quota). It used
    // to be called unguarded inside the interval, so the promise never
    // settled and the UI was stuck in "rendering" forever.
    const stopRecorderSafely = () => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch (err) {
        rejectOnce(
          new Error(
            `No se pudo finalizar la grabación de respaldo: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        );
        return;
      }
      // Safety net: if `onstop` never fires the promise would hang forever.
      stopTimeout = setTimeout(() => {
        rejectOnce(
          new Error(
            'La grabación de respaldo no terminó a tiempo. Intenta de nuevo con una resolución menor.'
          )
        );
      }, RECORDER_STOP_TIMEOUT_MS);
    };

    recorder.onstop = () => {
      if (settled) return;
      if (stopTimeout !== null) {
        clearTimeout(stopTimeout);
        stopTimeout = null;
      }
      void (async () => {
        // EX-10: an "empty" recording must not be reported as a success.
        if (sink.bytes === 0) {
          rejectOnce(
            new Error(
              'La grabación de respaldo no produjo ningún dato de video (0 bytes). ' +
                'Prueba con una resolución menor (720p) o con otro navegador.'
            )
          );
          return;
        }
        let finalBlob: Blob;
        try {
          finalBlob = await sink.finalize(
            mimeType,
            // WebM sin MIME detectado: el blob debe declararse webm para que la
            // descarga lleve la extensión correcta. El camino MP4 se queda EXACTO
            // como estaba (`mimeType`, aunque venga vacío).
            params.config.format === 'webm' ? 'video/webm' : mimeType
          );
        } catch (err) {
          rejectOnce(
            new Error(
              `No se pudo ensamblar la grabación de respaldo: ${toErrorMessage(err)}`
            )
          );
          return;
        }
        onProgress({
          state: 'completed',
          progress: 100,
          currentFrame: totalFrames,
          totalFrames,
          etaSeconds: 0,
          outputBlob: finalBlob,
        });
        resolveOnce(finalBlob);
      })();
    };

    recorder.onerror = (ev) => {
      const detail = (ev as ErrorEvent)?.error;
      rejectOnce(
        new Error(
          `Error durante la grabación de respaldo: ${
            detail ? toErrorMessage(detail) : 'fallo desconocido del grabador'
          }`
        )
      );
    };

    const step = async () => {
      if (settled) return;

      if (signal?.aborted) {
        stopRecorderSafely();
        rejectOnce(new Error('Exportación cancelada por el usuario'));
        return;
      }

      if (frameIdx >= totalFrames) {
        stopRecorderSafely();
        return;
      }

      const t = frameIdx / fps;

      // EX-01: the fallback MUST seek the video elements before compositing.
      // `Compositor.renderFrame` only *requests* the seek (syncVideoTime) and
      // paints the element synchronously, so without this await every video
      // clip was exported as a frozen frame for its whole duration.
      try {
        await seekActiveVideoClips(t, clips, mediaMap, (media, clipId, sourceStart) =>
          isolation.pool.getVideoElement(media, clipId, sourceStart)
        );
      } catch (err) {
        console.warn('No se pudo preparar el fotograma para el respaldo MediaRecorder:', err);
      }

      if (signal?.aborted) {
        stopRecorderSafely();
        rejectOnce(new Error('Exportación cancelada por el usuario'));
        return;
      }

      // F9: the colour filters are applied by the compositor (same code path
      // as the preview), so the MediaRecorder fallback exports the same
      // filtered pixels as the WebCodecs path.
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
        etaSeconds: Math.max(0, Math.round(((totalFrames - frameIdx) * intervalMs) / 1000)),
      });

      timer = setTimeout(() => {
        void step();
      }, intervalMs);
    };

    timer = setTimeout(() => {
      void step();
    }, 0);
  });
}
