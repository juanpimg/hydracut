/**
 * Waveform peak extraction and visualization utilities
 */

/**
 * Extracts normalized audio peak values [0, 1] from an AudioBuffer.
 * Divides the audio into `numBins` and calculates peak amplitude for each bin.
 */
export function extractWaveformPeaks(
  audioBuffer: AudioBuffer,
  numBins: number = 100
): number[] {
  const bins = Math.max(1, Math.floor(numBins));
  const totalSamples = audioBuffer.length;
  if (totalSamples === 0) {
    return new Array(bins).fill(0);
  }

  const numChannels = audioBuffer.numberOfChannels;
  const samplesPerBin = Math.max(1, Math.floor(totalSamples / bins));
  const peaks = new Float32Array(bins);

  let maxPeak = 0;

  for (let i = 0; i < bins; i++) {
    const start = i * samplesPerBin;
    const end = Math.min(totalSamples, start + samplesPerBin);
    if (start >= totalSamples) {
      peaks[i] = 0;
      continue;
    }

    let binMax = 0;
    // Step size to process large buffers efficiently without blocking
    const step = Math.max(1, Math.floor((end - start) / 50));

    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let s = start; s < end; s += step) {
        const abs = Math.abs(channelData[s]);
        if (abs > binMax) binMax = abs;
      }
    }

    peaks[i] = binMax;
    if (binMax > maxPeak) maxPeak = binMax;
  }

  // If audio is completely silent, return all zeros
  if (maxPeak < 0.0001) {
    return new Array(bins).fill(0);
  }

  // Normalize so peaks utilize vertical space cleanly (with a sensible floor for audible sounds)
  const normalizationFactor = 1 / maxPeak;
  const result: number[] = new Array(bins);
  for (let i = 0; i < bins; i++) {
    if (peaks[i] === 0) {
      result[i] = 0;
    } else {
      const norm = peaks[i] * normalizationFactor;
      // Keep between 0.04 (minimal visible line for audible audio) and 1.0
      result[i] = Math.min(1, Math.max(0.04, Math.round(norm * 1000) / 1000));
    }
  }

  return result;
}

/**
 * Decodes audio from a Blob or File and returns extracted waveform peaks.
 */
export async function extractWaveformPeaksFromBlob(
  blob: Blob,
  numBins: number = 100
): Promise<number[]> {
  try {
    const AudioContextClass =
      typeof window !== 'undefined'
        ? window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        : null;

    if (!AudioContextClass) return [];

    const arrayBuffer = await blob.arrayBuffer();
    const tempCtx = new AudioContextClass();
    try {
      const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
      return extractWaveformPeaks(audioBuffer, numBins);
    } finally {
      tempCtx.close().catch(() => {});
    }
  } catch {
    // If media has no decodable audio (e.g. silent video or unsupported audio container), return empty array
    return [];
  }
}

/**
 * Generates synthetic waveform peaks for demo/mock audio clips.
 */
export function generateSyntheticWaveform(numBins: number = 60): number[] {
  const result: number[] = [];
  for (let i = 0; i < numBins; i++) {
    const t = i / numBins;
    // Envelope pattern: rise, fluctuate with harmonic beat, decay
    const env = Math.sin(t * Math.PI);
    const wave = 0.3 + 0.4 * Math.sin(t * 18) + 0.3 * Math.cos(t * 42);
    const peak = Math.max(0.08, Math.min(1, Math.abs(wave) * env));
    result.push(Math.round(peak * 1000) / 1000);
  }
  return result;
}
