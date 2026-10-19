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
 * Detects whether HTMLCanvasElement real-time capture stream is supported.
 */
export function isCanvasCaptureSupported(): boolean {
  return (
    typeof HTMLCanvasElement !== 'undefined' &&
    Boolean(
      'captureStream' in HTMLCanvasElement.prototype ||
      'webkitCaptureStream' in HTMLCanvasElement.prototype
    )
  );
}

/**
 * Evaluates candidate video MIME types in preference order.
 * Supports WebM codecs and MP4 (for Safari / iOS).
 */
export function getSupportedVideoMimeType(): string | null {
  if (
    typeof MediaRecorder === 'undefined' ||
    typeof MediaRecorder.isTypeSupported !== 'function'
  ) {
    return null;
  }
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4;codecs=avc1',
    'video/mp4',
  ];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function safeCreateObjectURL(blob: Blob): string {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      return URL.createObjectURL(blob);
    } catch {
      // ignore
    }
  }
  return 'blob:mock-sample';
}

function generateFallbackColorCard(title: string, color: string): { url: string; thumbnailUrl: string } {
  if (typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const grad = ctx.createLinearGradient(0, 0, 640, 360);
        grad.addColorStop(0, '#0f172a');
        grad.addColorStop(0.5, color);
        grad.addColorStop(1, '#020617');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 640, 360);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 30px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(title, 320, 180);

        const dataUrl = canvas.toDataURL('image/png');
        return { url: dataUrl, thumbnailUrl: dataUrl };
      }
    } catch {
      // ignore
    }
  }
  const thumb = createPlaceholderThumbnail(title, color);
  return { url: thumb, thumbnailUrl: thumb };
}

/**
 * Maximum time we wait for a sample clip to be recorded.
 *
 * The recording is done in real time (MediaRecorder), so a slow device needs
 * some slack, but the promise MUST settle: when `recorder.onstop` never fires
 * the UI used to hang forever on "Generando clips de muestra..." and the
 * colour-card fallback was never reached.
 */
export const SAMPLE_GENERATION_TIMEOUT_MS = 30_000;

/**
 * Duration (in seconds) of the generated sample clips.
 *
 * The samples are recorded in real time, so their duration IS the time the
 * user waits. 2 s keeps the generated media valid and playable while cutting
 * the blocking time of the "Generar clips de prueba" button roughly in half.
 */
export const SAMPLE_VIDEO_DURATION_SECONDS = 2;

/**
 * Generates an animated video WebM/MP4 Blob using HTML5 Canvas captureStream and MediaRecorder
 */
export async function generateSampleVideoBlob(
  title: string,
  durationSeconds: number = SAMPLE_VIDEO_DURATION_SECONDS,
  themeColor: string = '#3b82f6',
  timeoutMs: number = SAMPLE_GENERATION_TIMEOUT_MS
): Promise<Blob> {
  if (!isCanvasCaptureSupported()) {
    throw new Error('Canvas captureStream no está soportado en este navegador.');
  }

  const mimeType = getSupportedVideoMimeType();
  if (!mimeType) {
    throw new Error('MediaRecorder no soporta ningún formato de video compatible.');
  }

  if (typeof document === 'undefined') {
    throw new Error('Document no está disponible para crear el lienzo canvas.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('No se pudo obtener el contexto 2D del canvas.');
  }

  const fps = 30;
  const totalFrames = Math.max(1, Math.round(fps * durationSeconds));
  const stream: MediaStream =
    typeof canvas.captureStream === 'function'
      ? canvas.captureStream(fps)
      : (canvas as unknown as { webkitCaptureStream: (fps: number) => MediaStream }).webkitCaptureStream(fps);

  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
  const chunks: Blob[] = [];

  let frame = 0;

  return new Promise<Blob>((resolve, reject) => {
    let settled = false;
    let drawInterval: ReturnType<typeof setInterval> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    /**
     * Releases EVERY resource: the drawing interval, the timeout, the
     * recorder and — crucially — the tracks of the captured MediaStream.
     * `canvas.captureStream()` keeps producing frames (and holding a GPU
     * surface) until its tracks are stopped, which used to leak one live
     * track per generated sample (KI-04 / EX-18).
     */
    const cleanup = () => {
      if (drawInterval !== null) {
        clearInterval(drawInterval);
        drawInterval = null;
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // ignore (the recorder may already be inactive)
      }
      try {
        for (const track of stream.getTracks()) track.stop();
      } catch {
        // ignore
      }
    };

    const resolveOnce = (blob: Blob) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(blob);
    };

    const rejectOnce = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      if (chunks.length === 0) {
        rejectOnce(
          new Error(`La grabación del clip de muestra "${title}" no produjo ningún dato.`)
        );
        return;
      }
      resolveOnce(new Blob(chunks, { type: mimeType }));
    };

    recorder.onerror = (ev) => {
      const detail = (ev as ErrorEvent)?.error;
      rejectOnce(
        new Error(
          `Error grabando el clip de muestra "${title}": ${
            detail instanceof Error ? detail.message : 'fallo desconocido del grabador'
          }`
        )
      );
    };

    // Bounded timeout: guarantees the promise settles even if `onstop` never
    // fires, so the caller can fall back to the colour cards.
    timeoutId = setTimeout(() => {
      rejectOnce(
        new Error(
          `La generación del clip de muestra "${title}" excedió el tiempo máximo ` +
            `(${Math.round(timeoutMs / 1000)} s).`
        )
      );
    }, timeoutMs);

    try {
      recorder.start();
    } catch (err) {
      rejectOnce(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const drawFrame = () => {
      try {
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
          if (drawInterval !== null) {
            clearInterval(drawInterval);
            drawInterval = null;
          }
          try {
            recorder.stop();
          } catch (err) {
            rejectOnce(err instanceof Error ? err : new Error(String(err)));
          }
        }
      } catch (err) {
        // EX-18: the interval used to reject() without stopping the recorder,
        // leaving an orphan recording running forever.
        rejectOnce(err instanceof Error ? err : new Error(String(err)));
      }
    };

    drawInterval = setInterval(drawFrame, 1000 / fps);
  });
}

/**
 * Creates preset sample media items ready to use without uploading anything.
 *
 * `timeoutMs` bounds the recording of every sample clip so the promise always
 * settles (and the colour-card fallback is reachable) even on a device where
 * `MediaRecorder.onstop` never fires.
 */
export async function createPresetMediaItems(
  timeoutMs: number = SAMPLE_GENERATION_TIMEOUT_MS
): Promise<MediaItem[]> {
  const items: MediaItem[] = [];
  const canGenerateVideo = isCanvasCaptureSupported() && getSupportedVideoMimeType() !== null;

  if (canGenerateVideo) {
    // Both clips are recorded in real time, so they are generated IN PARALLEL:
    // the user waits for the longest clip instead of for the sum of both.
    const sampleDuration = SAMPLE_VIDEO_DURATION_SECONDS;
    const [video1Result, video2Result] = await Promise.allSettled([
      generateSampleVideoBlob('Clip 1: Intro Neón', sampleDuration, '#6366f1', timeoutMs),
      generateSampleVideoBlob('Clip 2: B-Roll Pulso', sampleDuration, '#ec4899', timeoutMs),
    ]);

    if (video1Result.status === 'fulfilled') {
      const video1Blob = video1Result.value;
      const video1Url = safeCreateObjectURL(video1Blob);
      const video1Thumb = await generateVideoThumbnail(video1Blob, 1.0).catch(() => createPlaceholderThumbnail('Intro Neón', '#6366f1'));
      const video1Filmstrip = await generateFilmstrip(video1Blob, sampleDuration, 4).catch(() => generatePlaceholderFilmstrip(4, '#6366f1'));
      const video1Peaks = generateSyntheticWaveform(40);

      items.push({
        id: 'demo_video_1',
        name: `Intro Neón (${sampleDuration}s)`,
        type: 'video',
        url: video1Url,
        duration: sampleDuration,
        width: 640,
        height: 360,
        fps: 30,
        thumbnailUrl: video1Thumb,
        thumbnails: video1Filmstrip,
        waveformPeaks: video1Peaks,
        size: video1Blob.size,
        createdAt: Date.now(),
      });
    } else {
      console.warn('Video sample generation failed, using fallback cards:', video1Result.reason);
    }

    if (video2Result.status === 'fulfilled') {
      const video2Blob = video2Result.value;
      const video2Url = safeCreateObjectURL(video2Blob);
      const video2Thumb = await generateVideoThumbnail(video2Blob, 0.8).catch(() => createPlaceholderThumbnail('B-Roll Pulso', '#ec4899'));
      const video2Filmstrip = await generateFilmstrip(video2Blob, sampleDuration, 4).catch(() => generatePlaceholderFilmstrip(4, '#ec4899'));
      const video2Peaks = generateSyntheticWaveform(35);

      items.push({
        id: 'demo_video_2',
        name: `B-Roll Pulso (${sampleDuration}s)`,
        type: 'video',
        url: video2Url,
        duration: sampleDuration,
        width: 640,
        height: 360,
        fps: 30,
        thumbnailUrl: video2Thumb,
        thumbnails: video2Filmstrip,
        waveformPeaks: video2Peaks,
        size: video2Blob.size,
        createdAt: Date.now() + 1,
      });
    } else {
      console.warn('Video sample generation failed, using fallback cards:', video2Result.reason);
    }
  }

  // Fallback cards if video generation is unsupported or failed
  if (items.length === 0) {
    const card1 = generateFallbackColorCard('Tarjeta 1: Intro Neón', '#6366f1');
    items.push({
      id: 'demo_card_1',
      name: `Tarjeta 1: Intro Neón (${SAMPLE_VIDEO_DURATION_SECONDS}s)`,
      type: 'image',
      url: card1.url,
      duration: SAMPLE_VIDEO_DURATION_SECONDS,
      width: 640,
      height: 360,
      fps: 30,
      thumbnailUrl: card1.thumbnailUrl,
      thumbnails: [card1.thumbnailUrl],
      size: 1024,
      createdAt: Date.now(),
    });

    const card2 = generateFallbackColorCard('Tarjeta 2: B-Roll Pulso', '#ec4899');
    items.push({
      id: 'demo_card_2',
      name: `Tarjeta 2: B-Roll Pulso (${SAMPLE_VIDEO_DURATION_SECONDS}s)`,
      type: 'image',
      url: card2.url,
      duration: SAMPLE_VIDEO_DURATION_SECONDS,
      width: 640,
      height: 360,
      fps: 30,
      thumbnailUrl: card2.thumbnailUrl,
      thumbnails: [card2.thumbnailUrl],
      size: 1024,
      createdAt: Date.now() + 1,
    });
  }

  // 3. Audio Demo
  try {
    const audioBlob = generateSampleAudioBlob(5, 523.25); // C5 Chime
    const audioUrl = safeCreateObjectURL(audioBlob);
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
    console.warn('Audio sample generation failed:', err);
  }

  // Ultimate fallback to guarantee non-empty array
  if (items.length === 0) {
    items.push({
      id: 'demo_card_default',
      name: 'Tarjeta Predeterminada',
      type: 'image',
      url: '',
      duration: 5,
      width: 640,
      height: 360,
      fps: 30,
      thumbnailUrl: '',
      size: 0,
      createdAt: Date.now(),
    });
  }

  return items;
}
