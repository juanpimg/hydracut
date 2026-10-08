import { MediaItem } from '../../types/project';
import { generateFilmstrip, generatePlaceholderFilmstrip, generateVideoThumbnail, createPlaceholderThumbnail } from './thumbnails';
import { generateSyntheticWaveform, extractWaveformPeaksFromBlob } from './waveform';

/**
 * Generates an audio WAV blob using Web Audio API synthesis
 */
export function generateSampleAudioBlob(durationSeconds: number = 4, frequency: number = 440): Blob {
  const sampleRate = 44100;
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const buffer = new Float32Array(numSamples);

  // Generate pleasant harmonic chime/drone with attack and release
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Envelope: fast attack, gentle decay
    const env = Math.min(t / 0.1, 1) * Math.max(0, 1 - (t / durationSeconds));
    const tone1 = Math.sin(2 * Math.PI * frequency * t);
    const tone2 = 0.5 * Math.sin(2 * Math.PI * (frequency * 1.5) * t);
    const tone3 = 0.25 * Math.sin(2 * Math.PI * (frequency * 2) * t);
    buffer[i] = (tone1 + tone2 + tone3) * 0.3 * env;
  }

  // Convert Float32Array to 16-bit PCM WAV
  const wavBuffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(wavBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF chunk descriptor
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, 1, true); // NumChannels (1 mono)
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  // Write PCM audio data
  let offset = 44;
  for (let i = 0; i < numSamples; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, buffer[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([wavBuffer], { type: 'audio/wav' });
}

/**
 * Generates an animated video WebM/MP4 Blob using HTML5 Canvas captureStream and MediaRecorder
 */
export async function generateSampleVideoBlob(
  title: string,
  durationSeconds: number = 4,
  themeColor: string = '#3b82f6'
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d')!;

  const fps = 30;
  const totalFrames = fps * durationSeconds;
  const stream = canvas.captureStream(fps);

  // Fallback to supported mimeTypes
  let mimeType = 'video/webm;codecs=vp9';
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm;codecs=vp8';
  }
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm';
  }

  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
  const chunks: Blob[] = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.start();

  let frame = 0;
  return new Promise((resolve) => {
    const drawInterval = setInterval(() => {
      const progress = frame / totalFrames;
      const t = frame / fps;

      // Render colorful background
      const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      grad.addColorStop(0, '#0f172a');
      grad.addColorStop(0.5, themeColor);
      grad.addColorStop(1, '#020617');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Rotating animated geometric polygon
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(t * 1.5);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 4;
      ctx.strokeRect(-60, -60, 120, 120);
      ctx.restore();

      // Title & Frame info
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 28px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(title, canvas.width / 2, canvas.height / 2 - 10);

      ctx.font = '16px monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`Tiempo: ${t.toFixed(1)}s / ${durationSeconds}s`, canvas.width / 2, canvas.height / 2 + 30);

      // Bottom progress bar
      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.fillRect(20, canvas.height - 24, canvas.width - 40, 8);
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(20, canvas.height - 24, (canvas.width - 40) * progress, 8);

      frame++;
      if (frame >= totalFrames) {
        clearInterval(drawInterval);
        recorder.onstop = () => {
          const finalBlob = new Blob(chunks, { type: mimeType });
          resolve(finalBlob);
        };
        recorder.stop();
      }
    }, 1000 / fps);
  });
}

/**
 * Creates preset sample media items ready to use without uploading anything
 */
export async function createPresetMediaItems(): Promise<MediaItem[]> {
  const items: MediaItem[] = [];

  try {
    // 1. Video Demo 1: Cyber Neon
    const video1Blob = await generateSampleVideoBlob('Clip 1: Intro Neón', 5, '#6366f1');
    const video1Url = URL.createObjectURL(video1Blob);
    const video1Thumb = await generateVideoThumbnail(video1Blob, 1.5).catch(() => createPlaceholderThumbnail('Intro Neón', '#6366f1'));
    const video1Filmstrip = await generateFilmstrip(video1Blob, 5, 5).catch(() => generatePlaceholderFilmstrip(5, '#6366f1'));
    const video1Peaks = generateSyntheticWaveform(40);

    items.push({
      id: 'demo_video_1',
      name: 'Intro Neón (5s)',
      type: 'video',
      url: video1Url,
      duration: 5,
      width: 640,
      height: 360,
      fps: 30,
      thumbnailUrl: video1Thumb,
      thumbnails: video1Filmstrip,
      waveformPeaks: video1Peaks,
      size: video1Blob.size,
      createdAt: Date.now(),
    });

    // 2. Video Demo 2: Action Beat
    const video2Blob = await generateSampleVideoBlob('Clip 2: B-Roll Pulso', 4, '#ec4899');
    const video2Url = URL.createObjectURL(video2Blob);
    const video2Thumb = await generateVideoThumbnail(video2Blob, 1.0).catch(() => createPlaceholderThumbnail('B-Roll Pulso', '#ec4899'));
    const video2Filmstrip = await generateFilmstrip(video2Blob, 4, 4).catch(() => generatePlaceholderFilmstrip(4, '#ec4899'));
    const video2Peaks = generateSyntheticWaveform(35);

    items.push({
      id: 'demo_video_2',
      name: 'B-Roll Pulso (4s)',
      type: 'video',
      url: video2Url,
      duration: 4,
      width: 640,
      height: 360,
      fps: 30,
      thumbnailUrl: video2Thumb,
      thumbnails: video2Filmstrip,
      waveformPeaks: video2Peaks,
      size: video2Blob.size,
      createdAt: Date.now() + 1,
    });

    // 3. Audio Demo
    const audioBlob = generateSampleAudioBlob(5, 523.25); // C5 Chime
    const audioUrl = URL.createObjectURL(audioBlob);
    const audioPeaks = await extractWaveformPeaksFromBlob(audioBlob, 60).catch(() => generateSyntheticWaveform(60));
    const audioThumb = createPlaceholderThumbnail('Chime C5', '#10b981');

    items.push({
      id: 'demo_audio_1',
      name: 'Audio Chime Acústico',
      type: 'audio',
      url: audioUrl,
      duration: 5,
      width: 0,
      height: 0,
      fps: 0,
      thumbnailUrl: audioThumb,
      waveformPeaks: audioPeaks.length > 0 ? audioPeaks : generateSyntheticWaveform(60),
      size: audioBlob.size,
      createdAt: Date.now() + 2,
    });
  } catch (err) {
    console.error('Error creating preset media items:', err);
  }

  return items;
}
