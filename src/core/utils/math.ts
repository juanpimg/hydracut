import { Clip } from '../../types/project';

export interface SnapResult {
  snappedTime: number;
  didSnap: boolean;
  snapTargetTime?: number;
}

/**
 * Calculates magnetic snapping for a moving or trimming point in the timeline.
 * Snaps to:
 * - 0s
 * - playhead
 * - other clips' start and end points
 */
export function calculateSnapping(
  targetTime: number,
  allClips: Clip[],
  ignoreClipId: string | null,
  playheadTime: number,
  zoom: number,
  snapThresholdPixels: number = 10,
  enabled: boolean = true,
  clipDuration?: number
): SnapResult {
  if (!enabled || zoom <= 0) {
    return { snappedTime: Math.max(0, targetTime), didSnap: false };
  }

  const thresholdSeconds = snapThresholdPixels / zoom;
  let closestSnappedTime: number | null = null;
  let closestTargetLine: number | null = null;
  let minDiff = thresholdSeconds;

  // Potential snap points:
  const snapPoints: number[] = [0, playheadTime];

  for (const clip of allClips) {
    if (clip.id === ignoreClipId) continue;
    snapPoints.push(clip.start);
    snapPoints.push(clip.start + clip.duration);
  }

  // 1. Check if START snaps to any snap point:
  for (const pt of snapPoints) {
    const diff = Math.abs(targetTime - pt);
    if (diff < minDiff) {
      minDiff = diff;
      closestSnappedTime = pt;
      closestTargetLine = pt;
    }
  }

  // 2. Check if END snaps to any snap point:
  if (clipDuration !== undefined && clipDuration > 0) {
    const targetEndTime = targetTime + clipDuration;
    for (const pt of snapPoints) {
      if (pt < clipDuration) continue; // Clip end cannot snap to points less than clipDuration
      const diff = Math.abs(targetEndTime - pt);
      if (diff < minDiff) {
        minDiff = diff;
        closestSnappedTime = pt - clipDuration;
        closestTargetLine = pt;
      }
    }
  }

  if (closestSnappedTime !== null) {
    return {
      snappedTime: Math.max(0, closestSnappedTime),
      didSnap: true,
      snapTargetTime: closestTargetLine !== null ? closestTargetLine : closestSnappedTime,
    };
  }

  return {
    snappedTime: Math.max(0, targetTime),
    didSnap: false,
  };
}

/**
 * Clamps a number between min and max
 */
export function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}
