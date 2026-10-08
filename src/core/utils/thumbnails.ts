/**
 * Generates a thumbnail DataURL from a video file at a given timestamp.
 */
export async function generateVideoThumbnail(
  videoSource: File | Blob | string,
  time: number = 0.5,
  width: number = 240
): Promise<string> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    if (typeof videoSource === 'string' && videoSource.startsWith('http')) {
      video.crossOrigin = 'anonymous';
    }
    video.preload = 'metadata';

    const url = typeof videoSource === 'string' ? videoSource : URL.createObjectURL(videoSource);
    video.src = url;

    let resolved = false;

    const cleanup = () => {
      video.pause();
      video.src = '';
      if (typeof videoSource !== 'string') {
        setTimeout(() => {
          try { URL.revokeObjectURL(url); } catch {}
        }, 5000);
      }
      video.remove();
    };

    video.onloadedmetadata = () => {
      const targetTime = Math.min(Math.max(0.1, time), video.duration || 1);
      video.currentTime = targetTime;
    };

    video.onseeked = () => {
      if (resolved) return;
      resolved = true;
      try {
        const aspect = (video.videoHeight || 9) / (video.videoWidth || 16);
        const height = Math.round(width * aspect);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = Math.max(height, 36);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          cleanup();
          resolve(dataUrl);
          return;
        }
      } catch (e) {
        console.warn('Error generating thumbnail:', e);
      }
      cleanup();
      resolve(createPlaceholderThumbnail('Video', '#3b82f6'));
    };

    video.onerror = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(createPlaceholderThumbnail('Video', '#3b82f6'));
    };

    // Timeout fallback after 3 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(createPlaceholderThumbnail('Video', '#3b82f6'));
      }
    }, 3000);
  });
}

/**
 * Creates an SVG/Canvas placeholder thumbnail for audio or missing thumbnails
 */
export function createPlaceholderThumbnail(label: string, color: string = '#6366f1'): string {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Background
  const gradient = ctx.createLinearGradient(0, 0, 160, 90);
  gradient.addColorStop(0, '#18181b');
  gradient.addColorStop(1, '#27272a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 160, 90);

  // Border & Accent bar
  ctx.fillStyle = color;
  ctx.fillRect(0, 86, 160, 4);

  // Label text
  ctx.fillStyle = '#f4f4f5';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 80, 45);

  return canvas.toDataURL('image/png');
}

/**
 * Creates an array of placeholder thumbnails for filmstrip display
 */
export function generatePlaceholderFilmstrip(count: number = 5, color: string = '#3b82f6'): string[] {
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    result.push(createPlaceholderThumbnail(`Fotograma ${i + 1}`, color));
  }
  return result;
}

/**
 * Generates an array of sequential thumbnail DataURLs (filmstrip) across a video's duration.
 */
export async function generateFilmstrip(
  videoSource: File | Blob | string,
  duration: number,
  count: number = 5,
  width: number = 120
): Promise<string[]> {
  if (typeof document === 'undefined') {
    return [];
  }

  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    if (typeof videoSource === 'string' && videoSource.startsWith('http')) {
      video.crossOrigin = 'anonymous';
    }
    video.preload = 'metadata';

    const url = typeof videoSource === 'string' ? videoSource : URL.createObjectURL(videoSource);
    video.src = url;

    let finished = false;
    const thumbnails: string[] = [];

    let seekTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (seekTimeoutId) {
        clearTimeout(seekTimeoutId);
        seekTimeoutId = null;
      }
      video.pause();
      video.src = '';
      if (typeof videoSource !== 'string') {
        setTimeout(() => {
          try { URL.revokeObjectURL(url); } catch {}
        }, 5000);
      }
      video.remove();
    };

    const countClamped = Math.max(1, Math.min(10, count));
    const validDuration = Math.max(0.1, duration);
    const timePoints: number[] = [];
    for (let i = 0; i < countClamped; i++) {
      timePoints.push(Math.min(validDuration - 0.05, Math.max(0.05, ((i + 0.5) / countClamped) * validDuration)));
    }

    let currentIndex = 0;

    const seekNext = () => {
      if (finished) return;
      if (seekTimeoutId) clearTimeout(seekTimeoutId);
      if (currentIndex < timePoints.length) {
        seekTimeoutId = setTimeout(() => {
          // If seeking takes too long, push placeholder and proceed
          if (!finished) {
            thumbnails.push(createPlaceholderThumbnail(`Fotograma ${currentIndex + 1}`, '#3b82f6'));
            currentIndex++;
            seekNext();
          }
        }, 1200);
        video.currentTime = timePoints[currentIndex];
      } else {
        if (!finished) {
          finished = true;
          cleanup();
          resolve(thumbnails);
        }
      }
    };

    const captureFrame = () => {
      if (seekTimeoutId) {
        clearTimeout(seekTimeoutId);
        seekTimeoutId = null;
      }
      try {
        const aspect = (video.videoHeight || 9) / (video.videoWidth || 16);
        const height = Math.round(width * aspect);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = Math.max(height, 36);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          thumbnails.push(canvas.toDataURL('image/jpeg', 0.7));
        } else {
          thumbnails.push(createPlaceholderThumbnail(`Fotograma ${currentIndex + 1}`, '#3b82f6'));
        }
      } catch {
        thumbnails.push(createPlaceholderThumbnail(`Fotograma ${currentIndex + 1}`, '#3b82f6'));
      }

      currentIndex++;
      seekNext();
    };

    video.onloadedmetadata = () => {
      seekNext();
    };

    video.onseeked = () => {
      if (!finished) {
        captureFrame();
      }
    };

    video.onerror = () => {
      if (!finished) {
        finished = true;
        cleanup();
        resolve(thumbnails.length > 0 ? thumbnails : generatePlaceholderFilmstrip(countClamped));
      }
    };

    // Global timeout safety after 6s
    setTimeout(() => {
      if (!finished) {
        finished = true;
        cleanup();
        resolve(thumbnails.length > 0 ? thumbnails : generatePlaceholderFilmstrip(countClamped));
      }
    }, 6000);
  });
}

