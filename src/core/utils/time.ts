/**
 * Formats time in seconds to HH:MM:SS:FF timecode
 */
export function formatTimecode(seconds: number, fps: number = 30): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  
  const totalFrames = Math.round(seconds * fps);
  const frames = totalFrames % fps;
  const totalSecs = Math.floor(totalFrames / fps);
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);

  const pad = (n: number) => n.toString().padStart(2, '0');

  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`;
}

/**
 * Formats time in seconds to mm:ss or hh:mm:ss for user-friendly display
 */
export function formatDuration(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  
  const totalSecs = Math.floor(seconds);
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);
  const ms = Math.floor((seconds % 1) * 10);

  const pad = (n: number) => n.toString().padStart(2, '0');

  if (h > 0) {
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}.${ms}`;
}

/**
 * Converts timeline time (seconds) to horizontal pixels based on zoom level
 */
export function timeToPixels(seconds: number, zoom: number): number {
  return seconds * zoom;
}

/**
 * Converts horizontal pixels to timeline time (seconds).
 * Supports negative deltas for dragging offsets.
 */
export function pixelsToTime(pixels: number, zoom: number): number {
  if (zoom <= 0) return 0;
  return pixels / zoom;
}

/**
 * Round time to nearest frame boundary
 */
export function quantizeToFrame(time: number, fps: number = 30): number {
  return Math.round(time * fps) / fps;
}
