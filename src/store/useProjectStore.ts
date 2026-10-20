import { create } from 'zustand';
import {
  AspectRatio,
  AudioFade,
  Clip,
  MediaItem,
  MediaStatus,
  MediaType,
  OverlapPolicy,
  Project,
  Track,
  TrackType,
  TrashEntry,
} from '../types/project';
import {
  autosaveProject,
  deleteMediaFiles,
  flushAutosave,
  relinkMediaBytes,
  revokeAllObjectUrls,
  revokeProjectObjectUrls,
  subscribeStorageEvents,
} from '../core/storage/projectStorage';
import type { StorageScope } from '../core/storage/projectStorage';
import { calculateSnapping } from '../core/utils/math';
import {
  isDeliberateCrossfadeOverlap,
  planCrossfade,
} from '../core/utils/crossfade';
import { clampClipAudioFades } from '../core/utils/audioFades';
import { mediaSourcePool } from '../core/engine/MediaSourcePool';
import { compositor } from '../core/engine/Compositor';
import { audioEngine } from '../core/engine/AudioEngine';
import { masterClock } from '../core/engine/MasterClock';

export interface HistoryState {
  tracks: Track[];
  clips: Clip[];
  /**
   * Media pool snapshot (S-01).
   * `MediaItem` objects are immutable by contract, so a SHALLOW array copy is enough:
   * it avoids deep-copying megabytes of base64 filmstrips on every history push.
   */
  mediaPool: MediaItem[];
  /**
   * Media trash snapshot (F2). The trash is part of the undoable state: undoing
   * a removal brings the media back AND empties the trash, redo re-fills it.
   */
  trash: TrashEntry[];
  /**
   * Selection snapshot (F6).
   *
   * The selection is part of the undoable state: a clip that is selected when
   * the snapshot was taken is still selected after the undo (as long as it
   * exists again).
   */
  selectedClipIds?: string[];
}

/** Maximum number of undo entries kept in the history stack. */
export const HISTORY_LIMIT = 30;

/**
 * Window (ms) during which consecutive `updateClip` calls on the same clip are
 * coalesced into a single undo entry (S-02). A slider drag therefore produces
 * ONE undo step instead of one per tick.
 */
export const UPDATE_COALESCE_WINDOW_MS = 400;

/**
 * Compatibility matrix between a track type and the media type it can host.
 * Audio media only fits on audio tracks; video/image media only fits on video
 * tracks; text clips only fit on text tracks.
 */
export function isTrackTypeCompatible(trackType: TrackType, mediaType: MediaType | Clip['type']): boolean {
  if (mediaType === 'audio') return trackType === 'audio';
  if (mediaType === 'text') return trackType === 'text';
  return trackType === 'video';
}

/** Track type required to host a given media type. */
export function trackTypeForMedia(mediaType: MediaType | Clip['type']): TrackType {
  if (mediaType === 'audio') return 'audio';
  if (mediaType === 'text') return 'text';
  return 'video';
}

/**
 * Duration (seconds) used for a project WITHOUT content (KI-01 / S-06 / B-06).
 * It keeps the player and the timeline usable instead of degenerate.
 */
export const DEFAULT_EMPTY_PROJECT_DURATION = 30;

/**
 * Minimum duration (seconds) of a project that DOES have content. A zero or
 * negative clip extent must never produce a zero/negative duration (that would
 * render an empty export).
 */
export const MIN_PROJECT_DURATION = 1;

/**
 * Computes the duration of a project from the REAL extent of its content
 * (KI-01 / S-06 / B-06).
 *
 * The old implementation used a hard-coded floor of 15 s plus an unconditional
 * +5 s of "breathing room", so a project with a single 5 s clip was exported
 * as a 20 s video with a 15 s black tail (4x the export time and file size).
 *
 * The contract is now:
 * - no clips            -> `DEFAULT_EMPTY_PROJECT_DURATION` (30 s)
 * - with content        -> `ceil(max(clip.start + clip.duration) + padding)`
 * - padding is opt-in   -> `project.endPaddingSeconds` (default 0)
 * - always finite and never negative (a clip with a 0/negative duration can
 *   only shrink the extent, never invert it).
 */
export function computeProjectDuration(
  clips: Array<Pick<Clip, 'start' | 'duration'>> | null | undefined,
  endPaddingSeconds: number = 0
): number {
  if (!clips || clips.length === 0) return DEFAULT_EMPTY_PROJECT_DURATION;

  let maxEnd = 0;
  for (const clip of clips) {
    const start = Number.isFinite(clip.start) ? Math.max(0, clip.start) : 0;
    const duration = Number.isFinite(clip.duration) ? Math.max(0, clip.duration) : 0;
    const end = start + duration;
    if (end > maxEnd) maxEnd = end;
  }

  const padding = Number.isFinite(endPaddingSeconds) ? Math.max(0, endPaddingSeconds) : 0;
  // `Math.ceil` keeps the frame count integral (a clip ending at 4.2 s gives
  // a duration of 5 s, not 4.2 s).
  const total = Math.ceil(maxEnd + padding);
  return Math.max(MIN_PROJECT_DURATION, total);
}

/**
 * Clamps a time value to a finite, non-negative number (S-19).
 * `Math.max(0, NaN) === NaN`, so NaN has to be filtered out explicitly before
 * it can reach the timeline state.
 */
export function toFiniteTime(time: number, fallback: number = 0): number {
  if (!Number.isFinite(time)) return fallback;
  return Math.max(0, time);
}

/* ------------------------------------------------------------------ */
/* F1 — Explicit overlap policy                                        */
/* ------------------------------------------------------------------ */

/** Policy applied when a project does not define one (the safest one). */
export const DEFAULT_OVERLAP_POLICY: OverlapPolicy = 'block';

/**
 * Result of `addClipFromMedia`.
 *
 * The UI needs to know WHY an insertion did not happen: a silent no-op is
 * indistinguishable from a broken app (B-08).
 */
export type AddClipFromMediaResult =
  | { ok: true; clipId: string }
  | { ok: false; reason: string };

/* ------------------------------------------------------------------ */
/* F5 — Fundido de cruce (crossfade) entre clips consecutivos          */
/* ------------------------------------------------------------------ */

/**
 * Result of `createCrossfade` / `removeCrossfade` / `setCrossfadeDuration`.
 *
 * Like `addClipFromMedia`, the UI needs to know WHY the operation did not
 * happen (locked track, non-adjacent clips, media too short).
 */
export type CrossfadeResult =
  | { ok: true; outClipId: string; inClipId: string; duration: number }
  | { ok: false; reason: string };

/**
 * Window (ms) during which consecutive `setCrossfadeDuration` calls on the
 * same pair share a single undo entry (same idea as S-02 for `updateClip`):
 * dragging the duration slider produces ONE undo step, not one per tick.
 */
export const CROSSFADE_COALESCE_WINDOW_MS = 400;

/* ------------------------------------------------------------------ */
/* Fundidos de audio por clip (fade in / fade out)                      */
/* ------------------------------------------------------------------ */

/**
 * Result of `setAudioFade`.
 *
 * Like `addClipFromMedia`, the UI needs to know WHY the values did not land
 * as requested: a fade longer than the clip is CLAMPED (not silently kept)
 * and the reason is reported (in `reason` and in `lastError`).
 */
export type AudioFadeResult =
  | { ok: true; clipId: string; clamped: boolean; reason: string | null }
  | { ok: false; reason: string };

/** Tolerance (seconds) used when comparing the edges of two intervals. */
const OVERLAP_EPSILON = 1e-6;

/** Minimum duration (seconds) of a clip that survives a trim. */
const MIN_SURVIVING_CLIP_DURATION = 0.05;

/** End (exclusive) of a clip on the timeline. */
export function clipEnd(clip: Clip): number {
  return clip.start + clip.duration;
}

/**
 * True when the half-open intervals `[aStart, aEnd)` and `[bStart, bEnd)`
 * overlap. Two clips that only touch (the end of one is the start of the
 * other) do NOT overlap.
 */
export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd - OVERLAP_EPSILON && bStart < aEnd - OVERLAP_EPSILON;
}

/**
 * Clips of `trackId` that overlap the `[start, start + duration)` interval.
 *
 * The physical contract never changes: every clip sharing time with the
 * interval is reported (a deliberate crossfade overlap IS a physical
 * overlap). Pass `{ excludeCrossfades: true }` together with
 * `excludeClipId` to whitelist the deliberate crossfade pair of that clip
 * (see `isDeliberateCrossfadeOverlap`): an illegal overlap can never pass
 * that filter because it carries no crossfade markers.
 */
export function findOverlappingClips(
  clips: Clip[],
  trackId: string,
  start: number,
  duration: number,
  excludeClipId?: string,
  options?: { excludeCrossfades?: boolean }
): Clip[] {
  const end = start + duration;
  const found = clips.filter(
    (clip) =>
      clip.trackId === trackId &&
      clip.id !== excludeClipId &&
      intervalsOverlap(clip.start, clipEnd(clip), start, end)
  );
  if (!options?.excludeCrossfades || !excludeClipId) return found;
  const self = clips.find((clip) => clip.id === excludeClipId);
  if (!self) return found;
  return found.filter((clip) => !isDeliberateCrossfadeOverlap(self, clip));
}

/**
 * Clips of `trackId` whose overlap with `[start, start + duration)` is
 * ILLEGAL (a deliberate crossfade pair of `excludeClipId` is whitelisted).
 *
 * This is the policy-level view (F1 + F5): the deliberate overlap created by
 * `createCrossfade` must not be treated as a conflict, while any other
 * overlap still is.
 */
export function findIllegalOverlappingClips(
  clips: Clip[],
  trackId: string,
  start: number,
  duration: number,
  excludeClipId?: string
): Clip[] {
  return findOverlappingClips(clips, trackId, start, duration, excludeClipId, {
    excludeCrossfades: true,
  });
}

export interface OverwriteInsertResult {
  /** The clips of the project after the insertion. */
  clips: Clip[];
  /** Clips that were shortened (the head or the tail was cut). */
  trimmed: Clip[];
  /** Clips that were removed completely (fully covered by the new clip). */
  removed: Clip[];
}

/**
 * `overwrite` policy: the new clip wins the overlapped region and the
 * existing clip is trimmed (the part that is not overlapped survives as a
 * separate clip when the new clip lands in the middle of it).
 *
 * Nothing is lost: the material before the insertion point stays in place and
 * the material after it is moved right, next to the new clip.
 */
export function applyOverwriteInsert(
  clips: Clip[],
  trackId: string,
  start: number,
  duration: number
): OverwriteInsertResult {
  const end = start + duration;
  const result: Clip[] = [];
  const trimmed: Clip[] = [];
  const removed: Clip[] = [];

  for (const clip of clips) {
    if (clip.trackId !== trackId || !intervalsOverlap(clip.start, clipEnd(clip), start, end)) {
      result.push(clip);
      continue;
    }

    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const originalEnd = clipEnd(clip);
    const pieces: Clip[] = [];

    // Head: the part of the existing clip BEFORE the new clip.
    if (clip.start < start - OVERLAP_EPSILON) {
      const headDuration = start - clip.start;
      if (headDuration >= MIN_SURVIVING_CLIP_DURATION) {
        const head: Clip = { ...clip, duration: headDuration };
        pieces.push(head);
        trimmed.push(head);
      }
    }

    // Tail: the part of the existing clip AFTER the new clip.
    if (originalEnd > end + OVERLAP_EPSILON) {
      const tailDuration = originalEnd - end;
      const tail: Clip = {
        ...clip,
        id: `${clip.id}_overwrite_${Math.random().toString(36).substring(2, 8)}`,
        start: end,
        duration: tailDuration,
        sourceStart: clip.sourceStart + (end - clip.start) * speed,
      };
      pieces.push(tail);
      trimmed.push(tail);
    }

    if (pieces.length === 0) {
      // The existing clip was fully covered by the new one.
      removed.push(clip);
      continue;
    }
    result.push(...pieces);
  }

  return { clips: result, trimmed, removed };
}

export interface RippleInsertResult {
  /** The clips of the project after the insertion. */
  clips: Clip[];
  /** Clips that moved to the right to make room. */
  shifted: Clip[];
  /** New clips created by splitting a clip cut in half by the insertion. */
  created: Clip[];
}

/**
 * `ripple` policy: the clips that follow the insertion point move to the
 * right so the new clip has room. A clip cut in half by the insertion point
 * is split: its head stays in place and its tail moves with the rest.
 */
export function applyRippleInsert(
  clips: Clip[],
  trackId: string,
  start: number,
  duration: number
): RippleInsertResult {
  const result: Clip[] = [];
  const shifted: Clip[] = [];
  const created: Clip[] = [];

  for (const clip of clips) {
    if (clip.trackId !== trackId) {
      result.push(clip);
      continue;
    }

    const end = clipEnd(clip);
    if (end <= start + OVERLAP_EPSILON) {
      // Entirely before the insertion point: it does not move.
      result.push(clip);
      continue;
    }

    if (clip.start >= start - OVERLAP_EPSILON) {
      // After the insertion point: it moves to the right.
      const moved: Clip = { ...clip, start: clip.start + duration };
      result.push(moved);
      shifted.push(moved);
      continue;
    }

    // The clip straddles the insertion point: it is split in two.
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const headDuration = start - clip.start;
    const tailDuration = end - start;

    if (headDuration >= MIN_SURVIVING_CLIP_DURATION) {
      result.push({ ...clip, duration: headDuration });
    }

    const tail: Clip = {
      ...clip,
      id: `${clip.id}_ripple_${Math.random().toString(36).substring(2, 8)}`,
      start: start + duration,
      duration: tailDuration,
      sourceStart: clip.sourceStart + headDuration * speed,
    };
    result.push(tail);
    shifted.push(tail);
    created.push(tail);
  }

  return { clips: result, shifted, created };
}

/**
 * Human readable reason of an overlap refusal (shown in the UI).
 */
export function buildOverlapRefusalReason(
  media: MediaItem,
  track: Track,
  conflicts: Clip[],
  start: number,
  end: number
): string {
  const conflict = conflicts[0];
  const conflictLabel = conflict ? `«${conflict.name}»` : 'otro clip';
  const conflictRange = conflict
    ? ` (${formatTimelineTime(conflict.start)}–${formatTimelineTime(clipEnd(conflict))})`
    : '';
  return (
    `No se puede insertar «${media.name}» en «${track.name}»: se solapa con ${conflictLabel}${conflictRange}. ` +
    `El clip entraría de ${formatTimelineTime(start)} a ${formatTimelineTime(end)}. ` +
    `Muévelo a otro momento o cambia la política de solapamiento a «Sobrescribir» o «Ripple» en el Inspector.`
  );
}

/**
 * Formats a time (seconds) as `m:ss` for the user facing messages.
 */
export function formatTimelineTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(m)}:${pad(s)}`;
}

/* ------------------------------------------------------------------ */
/* F6 — Multi-selección y acciones en lote                             */
/* ------------------------------------------------------------------ */

/**
 * Options of `selectClip` (F6).
 */
export interface SelectClipOptions {
  /**
   * Ctrl/Cmd + clic: the clip is TOGGLED in/out of the selection instead of
   * replacing it.
   */
  additive?: boolean;
  /**
   * Shift + clic: the contiguous range between the PRIMARY selection and the
   * clicked clip is selected (only on the track of the primary selection).
   */
  range?: boolean;
}

/**
 * Batch operations that the Inspector can apply to a whole selection (F6).
 */
export type BatchOperation = 'volume' | 'opacity' | 'speed' | 'muted';

/**
 * Availability of a batch operation for a given selection.
 */
export interface BatchOperationAvailability {
  /** True when the operation can be applied to EVERY selected clip. */
  enabled: boolean;
  /** Why the operation is not available (Spanish, ready to show). `null` when it is. */
  reason: string | null;
}

/** True when the clip carries audio (the volume and the mute make sense). */
export function clipHasAudio(clip: Clip): boolean {
  return clip.type === 'video' || clip.type === 'audio';
}

/** True when the clip is drawn on the canvas (the opacity makes sense). */
export function clipIsVisual(clip: Clip): boolean {
  return clip.type === 'video' || clip.type === 'image' || clip.type === 'text';
}

/** True when the clip has a source media (the speed makes sense). */
export function clipHasSourceMedia(clip: Clip): boolean {
  return clip.type !== 'text';
}

/**
 * Tells whether a batch operation can be applied to a WHOLE selection (F6).
 *
 * A mixed selection must NOT be edited "in part": the operation is either
 * available for every clip or it is refused WITH A REASON (the Inspector
 * disables the control and explains why).
 */
export function getBatchOperationAvailability(
  clips: Clip[],
  operation: BatchOperation
): BatchOperationAvailability {
  if (clips.length === 0) {
    return { enabled: false, reason: 'No hay ningún clip seleccionado.' };
  }

  if (operation === 'volume' || operation === 'muted') {
    const bad = clips.find((clip) => !clipHasAudio(clip));
    if (bad) {
      const label = operation === 'volume' ? 'El volumen' : 'El silencio';
      return {
        enabled: false,
        reason:
          `${label} no se puede aplicar a un clip de texto («${bad.name}»): no tiene audio. ` +
          'Selecciona sólo clips con audio.',
      };
    }
    return { enabled: true, reason: null };
  }

  if (operation === 'opacity') {
    const bad = clips.find((clip) => !clipIsVisual(clip));
    if (bad) {
      return {
        enabled: false,
        reason:
          `La opacidad no se puede aplicar a un clip de audio («${bad.name}»): no tiene imagen. ` +
          'Selecciona sólo clips con imagen.',
      };
    }
    return { enabled: true, reason: null };
  }

  // 'speed'
  const bad = clips.find((clip) => !clipHasSourceMedia(clip));
  if (bad) {
    return {
      enabled: false,
      reason:
        `La velocidad no se puede aplicar a un clip de texto («${bad.name}»): el texto no tiene ` +
        'material de origen. Selecciona sólo clips con vídeo, imagen o audio.',
    };
  }
  return { enabled: true, reason: null };
}

/**
 * Orders the clips the way they appear in the timeline: first by track (the
 * order of the tracks inside the project) and then by start time.
 */
export function orderClipsByTimeline(clips: Clip[], tracks: Track[]): Clip[] {
  const trackIndex = new Map(tracks.map((track, index) => [track.id, index]));
  return [...clips].sort((a, b) => {
    const ai = trackIndex.get(a.trackId) ?? Number.MAX_SAFE_INTEGER;
    const bi = trackIndex.get(b.trackId) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    if (a.start !== b.start) return a.start - b.start;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Ids of the clips of the track of `anchorId` that lie between the anchor and
 * `targetId` (both included), in timeline order.
 *
 * The range NEVER crosses tracks: a clip of another track is not selected.
 * When the anchor and the target are not on the same track (or one of them
 * does not exist) the range is empty.
 */
export function selectRangeOnTrack(clips: Clip[], anchorId: string, targetId: string): string[] {
  const anchor = clips.find((clip) => clip.id === anchorId);
  const target = clips.find((clip) => clip.id === targetId);
  if (!anchor || !target) return [];
  if (anchor.trackId !== target.trackId) return [];

  const trackClips = clips
    .filter((clip) => clip.trackId === anchor.trackId)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const anchorIndex = trackClips.findIndex((clip) => clip.id === anchorId);
  const targetIndex = trackClips.findIndex((clip) => clip.id === targetId);
  if (anchorIndex === -1 || targetIndex === -1) return [];

  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  return trackClips.slice(from, to + 1).map((clip) => clip.id);
}

/**
 * Removes the ids that do not exist any more from a selection (F6).
 *
 * A deleted clip must NEVER leave a dangling id inside `selectedClipIds`.
 */
export function pruneSelection(clipIds: string[] | undefined, clips: Clip[]): string[] {
  if (!clipIds || clipIds.length === 0) return [];
  const alive = new Set(clips.map((clip) => clip.id));
  return clipIds.filter((id) => alive.has(id));
}

/**
 * The patch of a clip when its playback speed changes (S-04).
 *
 * The same source window is kept and the timeline duration is rescaled, so the
 * invariant `sourceStart + duration * speed <= sourceDuration` always holds.
 */
export interface SpeedPatch {
  /** The new speed factor. */
  speed: number;
  /** The duration the clip would have with the new speed. */
  duration: number;
  /** The maximum duration the source window allows. */
  maxDuration: number;
}

/**
 * Resolves the patch of a clip when its speed changes.
 *
 * Returns `null` when the speed is invalid (not a finite positive number) or
 * when it is already the current one (nothing to change).
 */
export function resolveSpeedPatch(clip: Clip, requestedSpeed: number): SpeedPatch | null {
  if (typeof requestedSpeed !== 'number' || !Number.isFinite(requestedSpeed) || requestedSpeed <= 0) {
    return null;
  }
  const currentSpeed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  if (requestedSpeed === currentSpeed) return null;

  const sourceWindow = clip.duration * currentSpeed;
  const available = clip.sourceDuration - clip.sourceStart;
  const maxDuration = Number.isFinite(available) && available > 0 ? available / requestedSpeed : Infinity;
  let duration = sourceWindow / requestedSpeed;
  if (Number.isFinite(maxDuration)) duration = Math.min(duration, maxDuration);
  return { speed: requestedSpeed, duration: Math.max(0, duration), maxDuration };
}

/* ------------------------------------------------------------------ */
/* F7 — Internal clipboard (copy / paste / duplicate)                  */
/* ------------------------------------------------------------------ */

/**
 * One entry of the internal clipboard (F7).
 *
 * The clipboard holds a DEEP COPY of the copied clip: editing the original
 * afterwards must not change what is going to be pasted. The `offset` keeps
 * the relative position of the group (the second pasted clip keeps the
 * distance it had from the first one).
 */
export interface ClipboardEntry {
  /** Deep copy of the copied clip (never the live object). */
  clip: Clip;
  /** Offset (seconds) of the clip relative to the first copied clip. */
  offset: number;
}

/**
 * Deep copy of a clip.
 *
 * `JSON` round-trip is enough here: a clip is plain data (no functions, no
 * class instances) and it may carry nested objects (`textStyle`, `words`,
 * `transition`) that must NOT be shared with the live clip.
 */
export function deepCopyClip(clip: Clip): Clip {
  return JSON.parse(JSON.stringify(clip)) as Clip;
}

/** Id of a new clip (unique enough for the timeline). */
function createClipId(): string {
  return 'clip_' + Math.random().toString(36).substring(2, 9);
}

/**
 * True when two clips of the same group overlap each other.
 *
 * The pasted group comes from the clipboard, so it may carry clips that were
 * living on DIFFERENT tracks (and therefore overlapped). Pasting them on a
 * single track would create an illegal overlap, so the paste is refused.
 */
export function hasInternalOverlap(clips: Clip[]): boolean {
  for (let i = 0; i < clips.length; i++) {
    for (let j = i + 1; j < clips.length; j++) {
      if (
        intervalsOverlap(
          clips[i].start,
          clipEnd(clips[i]),
          clips[j].start,
          clipEnd(clips[j])
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Persistence failure surfaced to the user (S-08).
 *
 * The storage layer publishes the failures through `subscribeStorageEvents`;
 * the store keeps the LAST one so the UI can warn the user that their work is
 * NOT being saved (a quota error used to be invisible: it only reached
 * `console.error`).
 */
export interface StorageErrorState {
  /** Human readable message, ready to show in the UI. */
  message: string;
  /** True when the failure was a storage quota exhaustion. */
  quotaExceeded: boolean;
  /** Timestamp of the failure (ms since the epoch). */
  at: number;
  /** Where the failure happened: autosave | save | delete | import | export | media. */
  scope: StorageScope;
}

/**
 * Options of the trim actions.
 *
 * `snap: false` disables the magnetic snapping: a keyboard trim must move the
 * edge exactly one frame, never jump to the playhead or to the nearest edge.
 */
export interface TrimOptions {
  /** `false` = no magnetic snapping (frame exact). Defaults to `true`. */
  snap?: boolean;
}

export interface ProjectState {
  project: Project;
  /**
   * The PRIMARY clip of the selection (F6).
   *
   * It is ALWAYS the first element of `selectedClipIds` (`null` when the
   * selection is empty). It is kept for the components that only need the
   * "current" clip (the player, the mobile bar, the shortcuts).
   */
  selectedClipId: string | null;
  /**
   * The selection (F6) — the source of truth.
   *
   * The first element is the PRIMARY selection; the rest are the additional
   * clips selected with Ctrl/Cmd + clic, with Shift + clic or with the rubber
   * band.
   */
  selectedClipIds: string[];
  currentTime: number;
  isPlaying: boolean;
  zoom: number; // Pixels per second
  snapEnabled: boolean;
  snappingGuideTime: number | null;
  past: HistoryState[];
  future: HistoryState[];

  // Coalescing state for `updateClip` (S-02): consecutive edits to the same
  // clip inside UPDATE_COALESCE_WINDOW_MS share a single history entry.
  historyCoalesceKey: string | null;
  historyCoalesceAt: number;

  /** Last refusal/incoherence signal surfaced by the store (e.g. locked track). */
  lastError: string | null;

  /**
   * Last persistence failure (S-08). `null` when everything is fine.
   * The UI must show it: a quota error means the work is NOT being saved.
   */
  storageError: StorageErrorState | null;

  /**
   * Timestamp of the last SUCCESSFUL persistence write.
   *
   * `project.updatedAt` is optimistic (it changes on every mutation, even if
   * the write fails), so it can NOT be used to tell the user that the work is
   * safe. This field is only updated when the write really reached the disk.
   */
  lastSavedAt: number | null;

  // Actions
  setProject: (project: Project) => void;
  setProjectName: (name: string) => void;
  setAspectRatio: (ratio: AspectRatio) => void;
  setCurrentTime: (time: number) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setZoom: (zoom: number) => void;
  toggleSnap: () => void;
  setSnappingGuideTime: (time: number | null) => void;

  /* ---------------------------------------------------------------- */
  /* F6 — multi-selección                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Selects a clip (F6).
   *
   * - plain call → the selection is REPLACED by that clip;
   * - `{ additive: true }` (Ctrl/Cmd + clic) → the clip is toggled in/out of
   *   the selection;
   * - `{ range: true }` (Shift + clic) → the contiguous range between the
   *   PRIMARY selection and the clicked clip is selected (same track only).
   *
   * `null` clears the selection.
   */
  selectClip: (clipId: string | null, options?: SelectClipOptions) => void;

  /**
   * Replaces the selection with the given ids (F6).
   *
   * The first id becomes the PRIMARY selection. The ids that do not exist are
   * discarded (a dangling id can never enter the selection).
   */
  selectClips: (clipIds: string[]) => void;

  /** Selects EVERY clip of the project (F6). */
  selectAllClips: () => void;

  /** Clears the selection (F6). */
  clearSelection: () => void;

  /**
   * The clips of the current selection, in TIMELINE order (F6).
   *
   * It is a FUNCTION (not a derived field): never call it inside a zustand
   * selector (`useProjectStore((s) => s.getSelectedClips())` would return a
   * new array on every call and re-render the component forever). Use
   * `useMemo` over `selectedClipIds` instead.
   */
  getSelectedClips: () => Clip[];

  /**
   * Deletes EVERY selected clip as ONE undoable step (F6).
   */
  deleteSelectedClips: () => void;

  /** Sets the volume of EVERY selected clip as ONE undoable step (F6). */
  setSelectedClipsVolume: (volume: number) => void;

  /** Sets the opacity of EVERY selected clip as ONE undoable step (F6). */
  setSelectedClipsOpacity: (opacity: number) => void;

  /** Sets the speed of EVERY selected clip as ONE undoable step (F6). */
  setSelectedClipsSpeed: (speed: number) => void;

  /** Mutes / unmutes EVERY selected clip as ONE undoable step (F6). */
  setSelectedClipsMuted: (muted: boolean) => void;

  // Media
  addMediaItem: (item: MediaItem) => void;
  removeMediaItem: (mediaId: string) => void;

  /**
   * Media trash (F2).
   * `removeMediaItem` does NOT destroy anything: it moves the media (and its
   * clips) to `project.trash`. The bytes stay in OPFS until the trash is
   * purged.
   */
  restoreFromTrash: (mediaId: string) => boolean;
  /** Physically deletes every trashed media (OPFS blob + object URL). */
  purgeTrash: () => number;
  /** Physically deletes one trashed media (OPFS blob + object URL). */
  purgeTrashedMedia: (mediaId: string) => boolean;

  /**
   * Availability of a media item (F3).
   * `missing` = the bytes are gone, `error` = the file cannot be decoded.
   */
  setMediaStatus: (mediaId: string, status: MediaStatus) => void;

  /**
   * Replaces the bytes of a media item with a new local file (F3).
   * The media keeps its id (so its clips keep working) and its clips are NOT
   * re-added to the timeline.
   */
  relinkMedia: (mediaId: string, file: File) => Promise<boolean>;

  // Tracks
  addTrack: (type: TrackType, name?: string) => void;
  removeTrack: (trackId: string) => void;
  deleteTrack: (trackId: string) => void;
  duplicateTrack: (trackId: string) => void;
  reorderTrack: (trackId: string, direction: 'up' | 'down') => void;
  moveTrack: (trackId: string, direction: 'up' | 'down') => void;
  toggleTrackMute: (trackId: string) => void;
  toggleTrackLock: (trackId: string) => void;
  toggleTrackVisibility: (trackId: string) => void;

  // Clips
  addClip: (clip: Clip) => void;
  /**
   * Inserts a clip from a media item honouring the overlap policy (F1).
   * Returns the outcome so the UI can explain a refusal.
   */
  addClipFromMedia: (
    media: MediaItem,
    trackId?: string,
    startTime?: number
  ) => AddClipFromMediaResult;
  addTextClip: (text?: string, startTime?: number) => void;
  updateClip: (clipId: string, updates: Partial<Clip>) => void;
  removeClip: (clipId: string) => void;
  moveClip: (clipId: string, newStart: number, newTrackId?: string) => void;
  commitClipChange: () => void;
  trimClipStart: (clipId: string, newStart: number, options?: TrimOptions) => void;
  trimClipEnd: (clipId: string, newEnd: number, options?: TrimOptions) => void;
  splitClip: (clipId: string, splitTime?: number) => void;
  splitAtPlayhead: () => void;
  deleteSelectedClip: () => void;

  /**
   * Changes the overlap policy of the project (F1).
   */
  setOverlapPolicy: (policy: OverlapPolicy) => void;

  /* ---------------------------------------------------------------- */
  /* F5 — fundido de cruce entre clips consecutivos                    */
  /* ---------------------------------------------------------------- */

  /**
   * Creates a crossfade between two consecutive clips of the same track
   * (F5).
   *
   * The incoming clip moves earlier so both share a region of `duration`
   * seconds, and both clips record the region in their transition markers
   * (`crossfadeOutDuration` / `crossfadeInDuration`). The overlap is
   * DELIBERATE: `isDeliberateCrossfadeOverlap` recognises it and the overlap
   * policy helpers can whitelist it (an illegal overlap carries no markers).
   *
   * Refuses with a reason when the track is locked, the clips are not
   * adjacent on the same track, or the media is too short. Undoable, and the
   * project duration is recalculated (an overlap shortens the timeline).
   */
  createCrossfade: (
    outgoingId: string,
    incomingId: string,
    duration?: number
  ) => CrossfadeResult;

  /**
   * Removes the crossfade that involves `clipId` (F5).
   *
   * The incoming clip of the pair moves later by the overlap amount (the
   * timeline grows back) and both markers are cleared. Undoable.
   */
  removeCrossfade: (clipId: string) => CrossfadeResult;

  /**
   * Adjusts the duration of the crossfade that involves `clipId` (F5).
   *
   * Consecutive calls on the same pair inside the coalescing window share a
   * single undo entry, so dragging the Inspector slider is one undo step.
   */
  setCrossfadeDuration: (clipId: string, duration: number) => CrossfadeResult;

  /* ---------------------------------------------------------------- */
  /* Fundidos de audio por clip                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Sets the audio fades (fade in / fade out) of a clip.
   *
   * Only the sides present in `fade` change (pass `{ fadeIn }` to leave the
   * fade out untouched). The durations are quantised to frames of the project
   * and clamped to the clip duration (`clampClipAudioFades`): when anything
   * is trimmed the result reports `clamped: true` WITH the reason (also
   * published as `lastError` so the UI can show it).
   *
   * Undoable, and consecutive calls on the same clip inside the coalescing
   * window share a single undo entry (it delegates to `updateClip`, so a
   * slider drag is one undo step).
   *
   * Refuses with a reason when the clip does not exist, has no audio, or when
   * neither side is given.
   */
  setAudioFade: (clipId: string, fade: { fadeIn?: AudioFade; fadeOut?: AudioFade }) => AudioFadeResult;

  /**
   * Removes both audio fades of a clip (undoable, via `updateClip`).
   * Returns `false` when the clip does not exist.
   */
  clearAudioFades: (clipId: string) => boolean;

  /* ---------------------------------------------------------------- */
  /* F7 — internal clipboard                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Internal clipboard (F7).
   *
   * It holds DEEP COPIES of the copied clips, so editing the originals
   * afterwards does not change what will be pasted.
   */
  clipboard: ClipboardEntry[];

  /**
   * Copies the given clips into the internal clipboard (F7).
   * Returns the number of clips actually copied (0 when none exists).
   */
  copyClips: (clipIds: string[]) => number;

  /**
   * Pastes the clipboard into the timeline (F7).
   *
   * - `trackId`: destination track. When it is omitted the original track of
   *   the copied clips is used.
   * - `atTime`: where the first pasted clip lands. When it is omitted the
   *   playhead is used (and, when the playhead sits inside the copied
   *   region, the paste lands right after that region).
   *
   * The paste honours the overlap policy of the project (F1) and the track
   * type compatibility (a video clip never lands on an audio track).
   * It returns the ids of the new clips (empty when the paste was refused).
   */
  pasteClips: (trackId?: string, atTime?: number) => string[];

  /**
   * Duplicates the given clips (F7): each copy is placed right after its
   * original. Returns the ids of the new clips.
   */
  duplicateClips: (clipIds: string[]) => string[];

  // Undo / Redo
  undo: () => void;
  redo: () => void;
  pushHistory: () => void;
  // Gesture-scoped history: call once when a drag/trim gesture starts;
  // commitClipChange() closes the gesture without pushing.
  historyGesturePending: boolean;
  beginClipGesture: () => void;

  /** Clears the `lastError` signal. */
  clearLastError: () => void;

  /** Clears the `storageError` signal (the UI dismisses the warning). */
  clearStorageError: () => void;

  // Project persistence
  recalculateDuration: () => void;
  resetProject: () => void;
  loadProject: (project: Project) => void;
}

const DEFAULT_TRACKS: Track[] = [
  { id: 'track_text_1', name: 'Texto T1', type: 'text', isMuted: false, isLocked: false, isVisible: true },
  { id: 'track_video_2', name: 'Video V2 (Superposición)', type: 'video', isMuted: false, isLocked: false, isVisible: true },
  { id: 'track_video_1', name: 'Video V1 (Principal)', type: 'video', isMuted: false, isLocked: false, isVisible: true },
  { id: 'track_audio_1', name: 'Audio A1', type: 'audio', isMuted: false, isLocked: false, isVisible: true },
];

const INITIAL_PROJECT: Project = {
  id: 'proj_' + Math.random().toString(36).substring(2, 9),
  name: 'Mi Proyecto de Video',
  aspectRatio: '16:9',
  resolution: { width: 1920, height: 1080 },
  fps: 30,
  tracks: DEFAULT_TRACKS,
  clips: [],
  mediaPool: [],
  duration: DEFAULT_EMPTY_PROJECT_DURATION,
  // No tail: the export must match the content the user sees (KI-01).
  endPaddingSeconds: 0,
  // F1: the safest overlap policy. The user can change it in the Inspector.
  overlapPolicy: DEFAULT_OVERLAP_POLICY,
  // F2: the media trash starts empty.
  trash: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

/* ------------------------------------------------------------------ */
/* Engine / storage lifecycle helpers (module level, F1..F4)          */
/* ------------------------------------------------------------------ */

/**
 * Number of persistence failures observed so far.
 *
 * `autosaveProject` resolves in BOTH cases (a successful write and a failed
 * one): the failure is reported through the storage event channel, not
 * through a rejected promise. This counter is the only reliable way to tell a
 * saved project from a project that silently failed to reach the disk.
 */
let storageFailureCounter = 0;

/** True once the storage event subscription has been installed (F4). */
let storageSubscriptionInstalled = false;

/** True once the unload flush listener has been installed (F3). */
let unloadFlushInstalled = false;

/**
 * Runs an engine cleanup routine.
 *
 * A cleanup must NEVER break the operation that triggered it: a single
 * misbehaving media element (or a partial DOM implementation) cannot leave
 * the store in a broken state.
 */
function runEngineCleanup(name: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(`[store] ${name} failed:`, err);
  }
}

/**
 * Releases the pooled engine resources of a clip that leaves the project.
 *
 * `mediaSourcePool.releaseClip` frees the elements of that clip; when the
 * clip was the LAST user of its media, the media level resources (elements
 * created without a clip id and the cached frames) are released too.
 */
function releaseClipResources(clip: Clip, survivingClips: Clip[]): void {
  runEngineCleanup('mediaSourcePool.releaseClip', () => mediaSourcePool.releaseClip(clip.id));
  if (!clip.mediaId) return;
  const stillUsed = survivingClips.some((c) => c.mediaId === clip.mediaId);
  if (!stillUsed) {
    runEngineCleanup('mediaSourcePool.release', () => mediaSourcePool.release(clip.mediaId));
  }
}

/**
 * Persists the project and marks it as saved ONLY when the write really
 * succeeded (F2).
 *
 * A failed write (quota exceeded, IndexedDB unavailable) must never leave the
 * project looking "saved": the optimistic `project.updatedAt` says nothing
 * about the disk.
 */
function persistProject(project: Project): void {
  // F3: the unload flush is armed with the first write (it is installed once
  // and it survives every store reset).
  installAutosaveFlushOnUnload();
  const failuresBefore = storageFailureCounter;
  void autosaveProject(project).then(() => {
    // A failure was published while the write was in flight: the project is
    // NOT on the disk, so it must not be marked as saved.
    if (storageFailureCounter !== failuresBefore) return;
    useProjectStore.setState({ lastSavedAt: Date.now() });
  });
}

/**
 * The `set` of the store, as seen from a module level helper.
 */
type SetProjectState = (
  partial:
    | ProjectState
    | Partial<ProjectState>
    | ((state: ProjectState) => ProjectState | Partial<ProjectState>),
  replace?: false
) => void;

/**
 * F6 · Builds the state patch that replaces the selection.
 *
 * The PRIMARY selection is ALWAYS the first element of `selectedClipIds`, so
 * the two fields can never disagree.
 */
export function selectionPatch(clipIds: string[]): {
  selectedClipId: string | null;
  selectedClipIds: string[];
} {
  return { selectedClipId: clipIds[0] ?? null, selectedClipIds: clipIds };
}

/**
 * F6 · Applies a property to EVERY selected clip as ONE undoable step.
 *
 * The whole batch shares a SINGLE history entry (not one per clip). The
 * coalescing window of S-02 applies too: a slider drag over a selection
 * produces ONE undo step instead of one per tick.
 *
 * Returns the number of clips that really changed.
 */
function commitBatchEdit(
  get: () => ProjectState,
  set: SetProjectState,
  options: {
    /** Key of the coalescing group: the property + the selection. */
    coalesceKey: string;
    /** The patch of every selected clip. `null` = the clip does not change. */
    updater: (clip: Clip) => Partial<Clip> | null;
  }
): number {
  const state = get();
  const selected = new Set(state.selectedClipIds);
  if (selected.size === 0) return 0;

  let changed = 0;
  const clips = state.project.clips.map((clip) => {
    if (!selected.has(clip.id)) return clip;
    const patch = options.updater(clip);
    if (!patch) return clip;
    changed += 1;
    return { ...clip, ...patch };
  });
  if (changed === 0) return 0;

  const now = Date.now();
  // While a drag/trim gesture is open the gesture owns the history entry.
  const inGesture = state.historyGesturePending;
  const canCoalesce =
    !inGesture &&
    state.historyCoalesceKey === options.coalesceKey &&
    now - state.historyCoalesceAt <= UPDATE_COALESCE_WINDOW_MS;
  if (!inGesture && !canCoalesce) {
    get().pushHistory();
  }

  set((s) => {
    const updated: Project = { ...s.project, clips, updatedAt: Date.now() };
    persistProject(updated);
    return {
      project: updated,
      historyCoalesceKey: inGesture ? null : options.coalesceKey,
      historyCoalesceAt: inGesture ? 0 : now,
      // F6: a successful edit clears the stale refusal of a previous action.
      lastError: null,
    };
  });
  get().recalculateDuration();
  return changed;
}

/**
 * Installs the storage event subscription (F2/F4).
 *
 * It is installed EXACTLY ONCE at module level: it survives every store
 * reset and it is never re-created by a store write (a subscription per write
 * would leak a listener on every mutation).
 */
function installStorageSubscription(): void {
  if (storageSubscriptionInstalled) return;
  storageSubscriptionInstalled = true;
  subscribeStorageEvents((event) => {
    if (event.type !== 'error') return;
    storageFailureCounter += 1;
    useProjectStore.setState({
      storageError: {
        message: event.message,
        quotaExceeded: event.quotaExceeded,
        at: event.at,
        scope: event.scope,
      },
    });
  });
}

/**
 * Flushes the pending autosave when the page goes away (F3).
 *
 * `autosaveProject` is debounced 500 ms and IndexedDB writes are NOT
 * guaranteed during `beforeunload`: without this flush a change made right
 * before closing the tab is lost.
 *
 * The listener is installed once (F4) and it is idempotent: `flushAutosave`
 * consumes the pending snapshot, so a double flush is harmless.
 */
export function installAutosaveFlushOnUnload(): void {
  if (unloadFlushInstalled) return;
  if (typeof window === 'undefined') return;
  unloadFlushInstalled = true;
  const flush = () => {
    void flushAutosave();
  };
  window.addEventListener('beforeunload', flush);
  window.addEventListener('pagehide', flush);
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: INITIAL_PROJECT,
  selectedClipId: null,
  // F6: the selection (the first element is the PRIMARY selection).
  selectedClipIds: [],
  currentTime: 0,
  isPlaying: false,
  zoom: 60, // 60 px per second default
  snapEnabled: true,
  snappingGuideTime: null,
  past: [],
  future: [],
  historyGesturePending: false,
  historyCoalesceKey: null,
  historyCoalesceAt: 0,
  lastError: null,
  storageError: null,
  lastSavedAt: null,
  // F7: the internal clipboard starts empty.
  clipboard: [],

  clearLastError: () => set({ lastError: null }),
  clearStorageError: () => set({ storageError: null }),

  beginClipGesture: () => {
    if (get().historyGesturePending) return;
    get().pushHistory();
    set({ historyGesturePending: true });
  },
  setProject: (project) => {
    set({ project, lastError: null });
    persistProject(project);
  },

  setProjectName: (name) => {
    set((state) => {
      const updated = { ...state.project, name, updatedAt: Date.now() };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
  },

  setAspectRatio: (aspectRatio) => {
    set((state) => {
      let width = 1920;
      let height = 1080;
      if (aspectRatio === '9:16') {
        width = 1080;
        height = 1920;
      } else if (aspectRatio === '1:1') {
        width = 1080;
        height = 1080;
      }
      const updated: Project = {
        ...state.project,
        aspectRatio,
        resolution: { width, height },
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
  },

  // S-19: `Math.max(0, NaN) === NaN`, so the value is filtered explicitly.
  setCurrentTime: (currentTime) => set({ currentTime: toFiniteTime(currentTime) }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setZoom: (zoom) => set({ zoom: Math.max(10, Math.min(250, zoom)) }),
  toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),
  setSnappingGuideTime: (snappingGuideTime) => set({ snappingGuideTime }),

  /* ------------------------------------------------------------------ */
  /* F6 — multi-selección y acciones en lote                            */
  /* ------------------------------------------------------------------ */

  selectClip: (clipId, options) => {
    const state = get();

    // `null` clears the selection (click on the empty timeline, Escape…).
    if (clipId === null) {
      set(selectionPatch([]));
      return;
    }

    const clip = state.project.clips.find((c) => c.id === clipId);
    if (!clip) {
      // An id that does not exist can never enter the selection.
      set(selectionPatch([]));
      return;
    }

    // Shift + clic: the contiguous range between the PRIMARY selection and
    // the clicked clip (only on the track of the primary selection).
    if (options?.range) {
      const anchorId = state.selectedClipId;
      const anchor = anchorId
        ? state.project.clips.find((c) => c.id === anchorId)
        : undefined;
      const range = anchor ? selectRangeOnTrack(state.project.clips, anchor.id, clip.id) : [];
      if (range.length > 0) {
        // The anchor stays the PRIMARY selection so that a second Shift + clic
        // extends the very same range.
        const ordered = [anchor!.id, ...range.filter((id) => id !== anchor!.id)];
        set(selectionPatch(ordered));
        return;
      }
      // No anchor on the same track: the click selects that clip alone.
      set(selectionPatch([clip.id]));
      return;
    }

    // Ctrl/Cmd + clic: the clip is toggled in/out of the selection.
    if (options?.additive) {
      const current = state.selectedClipIds;
      if (current.includes(clip.id)) {
        const next = current.filter((id) => id !== clip.id);
        set(selectionPatch(next));
        return;
      }
      set(selectionPatch(current.length === 0 ? [clip.id] : [...current, clip.id]));
      return;
    }

    // Plain click: the selection is replaced by that clip.
    set(selectionPatch([clip.id]));
  },

  selectClips: (clipIds) => {
    const { project } = get();
    const alive = new Set(project.clips.map((c) => c.id));
    const ids = Array.from(new Set(clipIds ?? [])).filter((id) => alive.has(id));
    set(selectionPatch(ids));
  },

  selectAllClips: () => {
    const { project } = get();
    const ids = orderClipsByTimeline(project.clips, project.tracks).map((c) => c.id);
    set(selectionPatch(ids));
  },

  clearSelection: () => {
    set(selectionPatch([]));
  },

  getSelectedClips: () => {
    const { project, selectedClipIds } = get();
    const selected = new Set(selectedClipIds);
    return orderClipsByTimeline(
      project.clips.filter((c) => selected.has(c.id)),
      project.tracks
    );
  },

  deleteSelectedClips: () => {
    const state = get();
    if (state.selectedClipIds.length === 0) return;

    const selected = new Set(state.selectedClipIds);
    const doomed = state.project.clips.filter((c) => selected.has(c.id));
    if (doomed.length === 0) return;

    // S-03: a locked track freezes the removal of its clips. The locked clips
    // survive and the reason is published (a silent no-op is not acceptable).
    const locked = doomed.filter((c) =>
      state.project.tracks.find((t) => t.id === c.trackId)?.isLocked
    );
    const lockedIds = new Set(locked.map((c) => c.id));
    const removable = doomed.filter((c) => !lockedIds.has(c.id));

    if (removable.length === 0) {
      const trackName = state.project.tracks.find((t) => t.id === locked[0].trackId)?.name ?? '';
      const message = `La pista "${trackName}" está bloqueada: desbloquéala para poder eliminar ${
        doomed.length === 1 ? 'el clip' : 'los clips'
      } seleccionado${doomed.length === 1 ? '' : 's'}.`;
      console.warn(message);
      set({ lastError: message });
      return;
    }

    // ONE history entry for the whole batch (not one per clip).
    get().pushHistory();
    const removableIds = new Set(removable.map((c) => c.id));
    set((s) => {
      const updatedClips = s.project.clips.filter((c) => !removableIds.has(c.id));
      const updated: Project = {
        ...s.project,
        clips: updatedClips,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      // The deleted clips leave the selection: a dangling id is never kept.
      const remaining = s.selectedClipIds.filter((id) => !removableIds.has(id));
      return {
        project: updated,
        ...selectionPatch(remaining),
        lastError: null,
      };
    });

    // The pooled resources of the deleted clips die with them.
    const survivors = get().project.clips;
    for (const clip of removable) {
      releaseClipResources(clip, survivors);
    }
    get().recalculateDuration();

    if (locked.length > 0) {
      const trackName = state.project.tracks.find((t) => t.id === locked[0].trackId)?.name ?? '';
      const message = `Se han eliminado ${removable.length} clip${
        removable.length === 1 ? '' : 's'
      }, pero ${locked.length} clip${locked.length === 1 ? '' : 's'} de la pista bloqueada "${trackName}" no se han eliminado.`;
      console.warn(message);
      set({ lastError: message });
    }
  },

  setSelectedClipsVolume: (volume) => {
    const value = Math.max(0, Math.min(2, Number.isFinite(volume) ? volume : 1));
    const state = get();
    commitBatchEdit(get, set, {
      coalesceKey: `batch:volume:${state.selectedClipIds.join(',')}`,
      updater: () => ({ volume: value }),
    });
  },

  setSelectedClipsOpacity: (opacity) => {
    const value = Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 1));
    const state = get();
    commitBatchEdit(get, set, {
      coalesceKey: `batch:opacity:${state.selectedClipIds.join(',')}`,
      updater: () => ({ opacity: value }),
    });
  },

  setSelectedClipsSpeed: (speed) => {
    const state = get();
    commitBatchEdit(get, set, {
      coalesceKey: `batch:speed:${state.selectedClipIds.join(',')}`,
      // S-04: the speed rescales the duration of every clip of the batch.
      updater: (clip) => {
        const patch = resolveSpeedPatch(clip, speed);
        return patch ? { speed: patch.speed, duration: patch.duration } : null;
      },
    });
  },

  setSelectedClipsMuted: (muted) => {
    const state = get();
    commitBatchEdit(get, set, {
      coalesceKey: `batch:muted:${state.selectedClipIds.join(',')}`,
      updater: () => ({ muted: muted === true }),
    });
  },

  pushHistory: () => {
    const { project, past, selectedClipIds } = get();
    const currentSnap: HistoryState = {
      tracks: JSON.parse(JSON.stringify(project.tracks)),
      clips: JSON.parse(JSON.stringify(project.clips)),
      // Shallow copy: MediaItem objects are immutable (S-01).
      mediaPool: [...project.mediaPool],
      // The trash is undoable state too (F2).
      trash: [...(project.trash ?? [])],
      // F6: the selection is undoable state (a selected clip that is restored
      // by the undo stays selected).
      selectedClipIds: [...selectedClipIds],
    };
    const newPast = [...past, currentSnap];
    if (newPast.length > HISTORY_LIMIT) newPast.shift();
    // Any explicit history push closes the current `updateClip` coalescing group.
    set({ past: newPast, future: [], historyCoalesceKey: null, historyCoalesceAt: 0 });
  },

  undo: () => {
    const { past, future, project } = get();
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    const newPast = past.slice(0, past.length - 1);
    const currentSnap: HistoryState = {
      tracks: JSON.parse(JSON.stringify(project.tracks)),
      clips: JSON.parse(JSON.stringify(project.clips)),
      mediaPool: [...project.mediaPool],
      trash: [...(project.trash ?? [])],
      selectedClipIds: [...get().selectedClipIds],
    };
    const updated: Project = {
      ...project,
      tracks: JSON.parse(JSON.stringify(previous.tracks)),
      clips: JSON.parse(JSON.stringify(previous.clips)),
      // Restore the media pool together with the clips so no clip is orphaned (S-01).
      mediaPool: [...previous.mediaPool],
      // The trash is restored too (F2): undoing a removal empties it.
      trash: [...(previous.trash ?? [])],
      updatedAt: Date.now(),
    };
    // F6: the selection of the restored state is restored too, but a clip that
    // does not exist any more NEVER stays in the selection (no dangling id).
    const restoredSelection = pruneSelection(previous.selectedClipIds, updated.clips);
    set({
      project: updated,
      past: newPast,
      future: [currentSnap, ...future],
      ...selectionPatch(restoredSelection),
      // S-19: the snapping guide belongs to the state that is being undone.
      snappingGuideTime: null,
      historyGesturePending: false,
      historyCoalesceKey: null,
      historyCoalesceAt: 0,
      // F6: a successful undo clears the stale refusal of a previous action.
      lastError: null,
    });
    get().recalculateDuration();
    persistProject(updated);
  },

  redo: () => {
    const { past, future, project } = get();
    if (future.length === 0) return;
    const next = future[0];
    const newFuture = future.slice(1);
    const currentSnap: HistoryState = {
      tracks: JSON.parse(JSON.stringify(project.tracks)),
      clips: JSON.parse(JSON.stringify(project.clips)),
      mediaPool: [...project.mediaPool],
      trash: [...(project.trash ?? [])],
      selectedClipIds: [...get().selectedClipIds],
    };
    const updated: Project = {
      ...project,
      tracks: JSON.parse(JSON.stringify(next.tracks)),
      clips: JSON.parse(JSON.stringify(next.clips)),
      mediaPool: [...next.mediaPool],
      trash: [...(next.trash ?? [])],
      updatedAt: Date.now(),
    };
    // F6: same rule as the undo (no dangling id in the selection).
    const restoredSelection = pruneSelection(next.selectedClipIds, updated.clips);
    set({
      project: updated,
      past: [...past, currentSnap],
      future: newFuture,
      ...selectionPatch(restoredSelection),
      // S-19: the snapping guide belongs to the state that is being redone.
      snappingGuideTime: null,
      historyGesturePending: false,
      historyCoalesceKey: null,
      historyCoalesceAt: 0,
      // F6: a successful redo clears the stale refusal of a previous action.
      lastError: null,
    });
    get().recalculateDuration();
    persistProject(updated);
  },

  addMediaItem: (item) => {
    // The media pool is part of the history snapshot (S-01): importing a file is
    // undoable and can never leave a clip pointing at a missing asset.
    get().pushHistory();
    set((state) => {
      const updatedPool = [...state.project.mediaPool, item];
      const updated: Project = {
        ...state.project,
        mediaPool: updatedPool,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
  },

  removeMediaItem: (mediaId) => {
    // F2: the removed item is captured BEFORE it is filtered out of the pool:
    // it goes to the trash together with the clips that used it.
    const state = get();
    const removed = state.project.mediaPool.find((m) => m.id === mediaId);
    if (!removed) return;
    const removedClips = state.project.clips.filter((c) => c.mediaId === mediaId);

    get().pushHistory();
    set((s) => {
      const updatedPool = s.project.mediaPool.filter((m) => m.id !== mediaId);
      const updatedClips = s.project.clips.filter((c) => c.mediaId !== mediaId);
      const trash: TrashEntry[] = [
        ...(s.project.trash ?? []),
        { media: removed, clips: removedClips, deletedAt: Date.now() },
      ];
      const updated: Project = {
        ...s.project,
        mediaPool: updatedPool,
        clips: updatedClips,
        trash,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      // F6: the clips that die with the media leave the selection (no
      // dangling id can survive).
      return {
        project: updated,
        ...selectionPatch(pruneSelection(s.selectedClipIds, updated.clips)),
        lastError: null,
      };
    });
    runEngineCleanup('mediaSourcePool.release', () => mediaSourcePool.release(mediaId));
    void deleteMediaFiles([removed], 'trash');
  },

  restoreFromTrash: (mediaId) => {
    const state = get();
    const entry = (state.project.trash ?? []).find((e) => e.media.id === mediaId);
    if (!entry) return false;

    get().pushHistory();
    set((s) => {
      const updatedPool = [...s.project.mediaPool, entry.media];
      const updatedClips = [...s.project.clips, ...entry.clips];
      const updatedTrash = (s.project.trash ?? []).filter((e) => e.media.id !== mediaId);
      const updated: Project = {
        ...s.project,
        mediaPool: updatedPool,
        clips: updatedClips,
        trash: updatedTrash,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
    get().recalculateDuration();
    return true;
  },

  purgeTrash: () => {
    const trash = get().project.trash ?? [];
    if (trash.length === 0) return 0;

    get().pushHistory();
    set((s) => {
      const updated: Project = {
        ...s.project,
        trash: [],
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
    // The physical deletion: the OPFS blob is gone and the object URL revoked.
    void deleteMediaFiles(
      trash.map((entry) => entry.media),
      'purge'
    );
    return trash.length;
  },

  purgeTrashedMedia: (mediaId) => {
    const trash = get().project.trash ?? [];
    const entry = trash.find((e) => e.media.id === mediaId);
    if (!entry) return false;

    get().pushHistory();
    set((s) => {
      const updated: Project = {
        ...s.project,
        trash: (s.project.trash ?? []).filter((e) => e.media.id !== mediaId),
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
    void deleteMediaFiles([entry.media], 'purge');
    return true;
  },

  setMediaStatus: (mediaId, status) => {
    const state = get();
    const inPool = state.project.mediaPool.some((m) => m.id === mediaId);
    const inTrash = (state.project.trash ?? []).some((e) => e.media.id === mediaId);
    if (!inPool && !inTrash) return;

    // A status that does not change is not an edit: no write, no autosave
    // storm (the engine reports the same failure once per pooled element).
    const current = inPool
      ? state.project.mediaPool.find((m) => m.id === mediaId)?.status
      : (state.project.trash ?? []).find((e) => e.media.id === mediaId)?.media.status;
    if ((current ?? 'ok') === status) return;

    set((s) => {
      const updatedPool = s.project.mediaPool.map((m) =>
        m.id === mediaId ? { ...m, status } : m
      );
      const updatedTrash = (s.project.trash ?? []).map((entry) =>
        entry.media.id === mediaId
          ? { ...entry, media: { ...entry.media, status } }
          : entry
      );
      const updated: Project = {
        ...s.project,
        mediaPool: updatedPool,
        trash: updatedTrash,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated };
    });
  },

  relinkMedia: async (mediaId, file) => {
    if (!file) return false;
    const state = get();
    const media =
      state.project.mediaPool.find((m) => m.id === mediaId) ??
      (state.project.trash ?? []).find((e) => e.media.id === mediaId)?.media;
    if (!media) return false;

    const relinked = await relinkMediaBytes(media, file, state.project.id);
    if (!relinked) {
      const message = `No se pudo revincular «${media.name}»: el archivo no se pudo guardar.`;
      set({ lastError: message });
      return false;
    }

    set((s) => {
      const updatedPool = s.project.mediaPool.map((m) => (m.id === mediaId ? relinked : m));
      const updatedTrash = (s.project.trash ?? []).map((entry) =>
        entry.media.id === mediaId ? { ...entry, media: relinked } : entry
      );
      const updated: Project = {
        ...s.project,
        mediaPool: updatedPool,
        trash: updatedTrash,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
    // The pooled elements still point at the OLD bytes: they are released so
    // the engine rebuilds them with the new URL (otherwise the clip would
    // keep rendering the dead source).
    runEngineCleanup('mediaSourcePool.release', () => mediaSourcePool.release(mediaId));
    return true;
  },

  addTrack: (type, name) => {
    get().pushHistory();
    set((state) => {
      const index = state.project.tracks.filter((t) => t.type === type).length + 1;
      const trackName = name || `${type === 'video' ? 'Video' : type === 'audio' ? 'Audio' : 'Texto'} ${index}`;
      const newTrack: Track = {
        id: `track_${type}_${Date.now()}`,
        name: trackName,
        type,
        isMuted: false,
        isLocked: false,
        isVisible: true,
      };
      // Keep text tracks at the top, video tracks in the middle, and audio tracks at the bottom
      let newTracks = [...state.project.tracks];
      if (type === 'text') {
        newTracks.unshift(newTrack);
      } else if (type === 'video') {
        const firstAudioIdx = newTracks.findIndex((t) => t.type === 'audio');
        if (firstAudioIdx !== -1) {
          newTracks.splice(firstAudioIdx, 0, newTrack);
        } else {
          newTracks.push(newTrack);
        }
      } else {
        newTracks.push(newTrack);
      }
      const updated: Project = {
        ...state.project,
        tracks: newTracks,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
  },

  removeTrack: (trackId) => {
    const track = get().project.tracks.find((t) => t.id === trackId);
    if (!track) return;
    // S-03: a locked track freezes move/trim/split/remove. Removing it would
    // destroy the clips it protects, so the store refuses (guard lives here
    // because the UI is not the only caller).
    if (track.isLocked) {
      const message = `La pista "${track.name}" está bloqueada: desbloquéala para poder eliminarla.`;
      console.warn(message);
      set({ lastError: message });
      return;
    }
    get().pushHistory();
    // F1: the clips that die with the track release their pooled resources.
    const dyingClips = get().project.clips.filter((c) => c.trackId === trackId);
    set((state) => {
      const updatedTracks = state.project.tracks.filter((t) => t.id !== trackId);
      const updatedClips = state.project.clips.filter((c) => c.trackId !== trackId);
      const updated: Project = {
        ...state.project,
        tracks: updatedTracks,
        clips: updatedClips,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      // F6: the clips of the removed track leave the selection.
      return {
        project: updated,
        ...selectionPatch(pruneSelection(state.selectedClipIds, updated.clips)),
        lastError: null,
      };
    });
    get().recalculateDuration();
    const survivors = get().project.clips;
    for (const clip of dyingClips) {
      releaseClipResources(clip, survivors);
    }
  },

  deleteTrack: (trackId) => {
    get().removeTrack(trackId);
  },

  duplicateTrack: (trackId) => {
    // S-17: validate BEFORE pushing the history snapshot. Pushing first left a
    // phantom undo entry for a duplicate that never happened and, worse, it
    // wiped the `future` stack (destroying a redo the user could still do).
    const sourceTrack = get().project.tracks.find((t) => t.id === trackId);
    if (!sourceTrack) return;

    get().pushHistory();
    set((state) => {
      const trackIdx = state.project.tracks.findIndex((t) => t.id === trackId);
      if (trackIdx === -1) return state;

      const newTrackId = `track_${sourceTrack.type}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const newTrack: Track = {
        ...sourceTrack,
        id: newTrackId,
        name: `${sourceTrack.name} (Copia)`,
      };

      const newTracks = [...state.project.tracks];
      newTracks.splice(trackIdx + 1, 0, newTrack);

      const sourceClips = state.project.clips.filter((c) => c.trackId === trackId);
      const duplicatedClips: Clip[] = sourceClips.map((c) => ({
        ...JSON.parse(JSON.stringify(c)),
        id: `clip_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        trackId: newTrackId,
      }));

      const updated: Project = {
        ...state.project,
        tracks: newTracks,
        clips: [...state.project.clips, ...duplicatedClips],
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
    get().recalculateDuration();
  },

  reorderTrack: (trackId, direction) => {
    const { project } = get();
    const currentIndex = project.tracks.findIndex((t) => t.id === trackId);
    if (currentIndex === -1) return;

    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= project.tracks.length) return;

    get().pushHistory();
    set((state) => {
      const tracks = [...state.project.tracks];
      const [movedTrack] = tracks.splice(currentIndex, 1);
      tracks.splice(targetIndex, 0, movedTrack);

      const updated: Project = {
        ...state.project,
        tracks,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
  },

  moveTrack: (trackId, direction) => {
    get().reorderTrack(trackId, direction);
  },

  toggleTrackMute: (trackId) => {
    // S-18: mute/lock/visibility are edits: they push history so they can be
    // undone and so an unrelated undo cannot silently revert them.
    if (!get().project.tracks.some((t) => t.id === trackId)) return;
    get().pushHistory();
    set((state) => {
      const updatedTracks = state.project.tracks.map((t) =>
        t.id === trackId ? { ...t, isMuted: !t.isMuted } : t
      );
      const updated = { ...state.project, tracks: updatedTracks, updatedAt: Date.now() };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
  },

  toggleTrackLock: (trackId) => {
    // S-18: same as `toggleTrackMute`.
    if (!get().project.tracks.some((t) => t.id === trackId)) return;
    get().pushHistory();
    set((state) => {
      const updatedTracks = state.project.tracks.map((t) =>
        t.id === trackId ? { ...t, isLocked: !t.isLocked } : t
      );
      const updated = { ...state.project, tracks: updatedTracks, updatedAt: Date.now() };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
  },

  toggleTrackVisibility: (trackId) => {
    // S-18: same as `toggleTrackMute`.
    if (!get().project.tracks.some((t) => t.id === trackId)) return;
    get().pushHistory();
    set((state) => {
      const updatedTracks = state.project.tracks.map((t) =>
        t.id === trackId ? { ...t, isVisible: !t.isVisible } : t
      );
      const updated = { ...state.project, tracks: updatedTracks, updatedAt: Date.now() };
      persistProject(updated);
      return { project: updated };
    });
  },

  addClip: (clip) => {
    get().pushHistory();
    set((state) => {
      const updatedClips = [...state.project.clips, clip];
      const updated = { ...state.project, clips: updatedClips, updatedAt: Date.now() };
      persistProject(updated);
      return { project: updated, ...selectionPatch([clip.id]), lastError: null };
    });
    get().recalculateDuration();
  },

  addClipFromMedia: (media, targetTrackId, startTime) => {
    const { project, currentTime } = get();
    // F1: the policy is a property of the project (default: the safest one).
    const policy: OverlapPolicy = project.overlapPolicy ?? DEFAULT_OVERLAP_POLICY;

    // S-12 / B-04: never create a clip on a track that cannot render it.
    // A video clip on an audio track is never composited (silent data loss),
    // and an audio clip on a video track is ignored by the compositor.
    const requiredType = trackTypeForMedia(media.type);
    const compatibleTracks = project.tracks.filter((t) => t.type === requiredType);

    let track: Track | undefined;
    const requested = targetTrackId ? project.tracks.find((t) => t.id === targetTrackId) : undefined;
    if (requested && isTrackTypeCompatible(requested.type, media.type)) {
      track = requested;
    }
    if (!track) {
      // Prefer an unlocked compatible track, but fall back to any compatible one.
      track = compatibleTracks.find((t) => !t.isLocked) ?? compatibleTracks[0];
    }

    if (!track) {
      const message =
        media.type === 'audio'
          ? `No hay ninguna pista de audio para "${media.name}". Crea una pista de audio antes de insertarlo.`
          : `No hay ninguna pista de vídeo para "${media.name}". Crea una pista de vídeo antes de insertarlo.`;
      console.warn(message);
      set({ lastError: message });
      return { ok: false, reason: message };
    }

    // The refusal is published AFTER the clip is added: `addClip` clears the
    // stale error of a previous action (F6) and the message of THIS action
    // must survive it.
    let refusal: string | null = null;
    if (requested && requested.type !== requiredType) {
      refusal = `"${media.name}" es ${media.type === 'audio' ? 'audio' : 'vídeo'} y no puede colocarse en la pista "${requested.name}".`;
      console.warn(refusal);
    }

    const startPos = startTime !== undefined ? startTime : currentTime;
    const duration = media.duration > 0 ? media.duration : 5;
    const start = Math.max(0, startPos);
    const end = start + duration;

    // F1: the overlap is resolved BEFORE the clip is created, according to
    // the policy of the project.
    const conflicts = findOverlappingClips(project.clips, track.id, start, duration);
    if (conflicts.length > 0 && policy === 'block') {
      const reason = buildOverlapRefusalReason(media, track, conflicts, start, end);
      console.warn(reason);
      set({ lastError: reason });
      return { ok: false, reason };
    }

    const newClip: Clip = {
      id: 'clip_' + Math.random().toString(36).substring(2, 9),
      trackId: track.id,
      mediaId: media.id,
      name: media.name,
      type: media.type,
      start,
      duration: duration,
      sourceStart: 0,
      sourceDuration: duration,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };

    // F1: `overwrite` trims the existing clips, `ripple` moves them aside.
    let updatedClips = project.clips;
    if (conflicts.length > 0 && policy === 'overwrite') {
      const overwrite = applyOverwriteInsert(project.clips, track.id, start, duration);
      updatedClips = overwrite.clips;
      // The clips that disappeared release their pooled resources.
      for (const clip of overwrite.removed) {
        runEngineCleanup('mediaSourcePool.releaseClip', () => mediaSourcePool.releaseClip(clip.id));
      }
    } else if (conflicts.length > 0 && policy === 'ripple') {
      updatedClips = applyRippleInsert(project.clips, track.id, start, duration).clips;
    }

    get().pushHistory();
    set((state) => {
      const updated: Project = {
        ...state.project,
        clips: [...updatedClips, newClip],
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated, ...selectionPatch([newClip.id]), lastError: null };
    });
    get().recalculateDuration();
    if (refusal) set({ lastError: refusal });
    return { ok: true, clipId: newClip.id };
  },

  setOverlapPolicy: (policy) => {
    // A policy is a project SETTING, not an edit: it does not consume an undo
    // entry (the same reason the project name does not).
    set((state) => {
      const updated: Project = {
        ...state.project,
        overlapPolicy: policy,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
  },

  /* ------------------------------------------------------------------ */
  /* F5 — fundido de cruce entre clips consecutivos                      */
  /* ------------------------------------------------------------------ */

  createCrossfade: (outgoingId, incomingId, duration) => {
    const { project } = get();
    const plan = planCrossfade({
      clips: project.clips,
      tracks: project.tracks,
      outgoingId,
      incomingId,
      requestedDuration:
        duration === undefined ? Number.NaN : (duration as number),
      fps: project.fps ?? 30,
    });
    if (!plan.ok) {
      console.warn(plan.reason);
      set({ lastError: plan.reason });
      return plan;
    }

    get().pushHistory();
    set((state) => {
      const updatedClips = state.project.clips.map((clip) => {
        if (clip.id === plan.outClip.id) {
          return {
            ...clip,
            transition: {
              fadeInType: clip.transition?.fadeInType ?? 'none',
              fadeInDuration: clip.transition?.fadeInDuration ?? 0,
              fadeOutType: clip.transition?.fadeOutType ?? 'none',
              fadeOutDuration: clip.transition?.fadeOutDuration ?? 0,
              crossfadeInDuration: clip.transition?.crossfadeInDuration,
              crossfadeOutDuration: plan.duration,
            },
          };
        }
        if (clip.id === plan.inClip.id) {
          return {
            ...clip,
            start: plan.newIncomingStart,
            transition: {
              fadeInType: clip.transition?.fadeInType ?? 'none',
              fadeInDuration: clip.transition?.fadeInDuration ?? 0,
              fadeOutType: clip.transition?.fadeOutType ?? 'none',
              fadeOutDuration: clip.transition?.fadeOutDuration ?? 0,
              crossfadeInDuration: plan.duration,
              crossfadeOutDuration: clip.transition?.crossfadeOutDuration,
            },
          };
        }
        return clip;
      });
      const updated: Project = {
        ...state.project,
        clips: updatedClips,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
    // The overlap shortens the timeline: the duration is the max clip end.
    get().recalculateDuration();
    return {
      ok: true,
      outClipId: plan.outClip.id,
      inClipId: plan.inClip.id,
      duration: plan.duration,
    };
  },

  removeCrossfade: (clipId) => {
    const { project } = get();
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) {
      const reason = 'No se encontró el clip para eliminar el fundido de cruce.';
      console.warn(reason);
      set({ lastError: reason });
      return { ok: false, reason };
    }
    const track = project.tracks.find((t) => t.id === clip.trackId);
    if (track?.isLocked) {
      const reason = `La pista «${track.name}» está bloqueada: desbloquéala para poder eliminar el fundido de cruce.`;
      console.warn(reason);
      set({ lastError: reason });
      return { ok: false, reason };
    }

    const ordered = project.clips
      .filter((c) => c.trackId === clip.trackId)
      .sort((x, y) => x.start - y.start || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const index = ordered.findIndex((c) => c.id === clip.id);
    const prev = index > 0 ? ordered[index - 1] : null;
    const next = index >= 0 && index + 1 < ordered.length ? ordered[index + 1] : null;
    const pairedPrev = prev && isDeliberateCrossfadeOverlap(prev, clip) ? prev : null;
    const pairedNext = next && isDeliberateCrossfadeOverlap(clip, next) ? next : null;
    if (!pairedPrev && !pairedNext) {
      const reason = `«${clip.name}» no tiene ningún fundido de cruce activo con sus vecinos.`;
      console.warn(reason);
      set({ lastError: reason });
      return { ok: false, reason };
    }

    const outClip = pairedPrev ? pairedPrev : clip;
    const inClip = pairedPrev ? clip : pairedNext!;
    const overlap = Math.min(clipEnd(outClip), clipEnd(inClip)) - Math.max(outClip.start, inClip.start);

    get().pushHistory();
    // Dropping a marker from a transition that has nothing else left removes
    // the transition object itself (a `{none, 0, none, 0}` transition is a
    // no-op, but `undefined` keeps the timeline data clean).
    const stripMarker = (
      clip: Clip,
      marker: 'crossfadeInDuration' | 'crossfadeOutDuration'
    ): Clip['transition'] => {
      if (!clip.transition) return undefined;
      const { ...rest } = clip.transition;
      delete rest[marker];
      const hasFades =
        (rest.fadeInType !== undefined && rest.fadeInType !== 'none') ||
        (rest.fadeInDuration ?? 0) > 0 ||
        (rest.fadeOutType !== undefined && rest.fadeOutType !== 'none') ||
        (rest.fadeOutDuration ?? 0) > 0;
      const hasCrossfade =
        (rest.crossfadeInDuration ?? 0) > 0 || (rest.crossfadeOutDuration ?? 0) > 0;
      if (!hasFades && !hasCrossfade) return undefined;
      return {
        fadeInType: rest.fadeInType ?? 'none',
        fadeInDuration: rest.fadeInDuration ?? 0,
        fadeOutType: rest.fadeOutType ?? 'none',
        fadeOutDuration: rest.fadeOutDuration ?? 0,
        ...(rest.crossfadeInDuration !== undefined
          ? { crossfadeInDuration: rest.crossfadeInDuration }
          : {}),
        ...(rest.crossfadeOutDuration !== undefined
          ? { crossfadeOutDuration: rest.crossfadeOutDuration }
          : {}),
      };
    };
    set((state) => {
      const updatedClips = state.project.clips.map((c) => {
        if (c.id === inClip.id) {
          return { ...c, start: c.start + Math.max(0, overlap), transition: stripMarker(c, 'crossfadeInDuration') };
        }
        if (c.id === outClip.id) {
          return { ...c, transition: stripMarker(c, 'crossfadeOutDuration') };
        }
        return c;
      });
      const updated: Project = {
        ...state.project,
        clips: updatedClips,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return { project: updated, lastError: null };
    });
    get().recalculateDuration();
    return { ok: true, outClipId: outClip.id, inClipId: inClip.id, duration: 0 };
  },

  setCrossfadeDuration: (clipId, duration) => {
    const { project } = get();
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) {
      const reason = 'No se encontró el clip para ajustar el fundido de cruce.';
      console.warn(reason);
      set({ lastError: reason });
      return { ok: false, reason };
    }
    const ordered = project.clips
      .filter((c) => c.trackId === clip.trackId)
      .sort((x, y) => x.start - y.start || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const index = ordered.findIndex((c) => c.id === clip.id);
    const prev = index > 0 ? ordered[index - 1] : null;
    const next = index >= 0 && index + 1 < ordered.length ? ordered[index + 1] : null;
    const pairedPrev = prev && isDeliberateCrossfadeOverlap(prev, clip) ? prev : null;
    const pairedNext = next && isDeliberateCrossfadeOverlap(clip, next) ? next : null;
    if (!pairedPrev && !pairedNext) {
      const reason = `«${clip.name}» no tiene ningún fundido de cruce activo: créalo primero con un clip vecino.`;
      console.warn(reason);
      set({ lastError: reason });
      return { ok: false, reason };
    }
    const outClip = pairedPrev ? pairedPrev : clip;
    const inClip = pairedPrev ? clip : pairedNext!;

    const plan = planCrossfade({
      clips: project.clips,
      tracks: project.tracks,
      outgoingId: outClip.id,
      incomingId: inClip.id,
      requestedDuration: duration,
      fps: project.fps ?? 30,
    });
    if (!plan.ok) {
      console.warn(plan.reason);
      set({ lastError: plan.reason });
      return plan;
    }

    // Coalescing (same idea as S-02): dragging the slider shares ONE undo
    // entry per pair while the gesture lasts.
    const state = get();
    const coalesceKey = `crossfade:${outClip.id}:${inClip.id}`;
    const now = Date.now();
    const canCoalesce =
      !state.historyGesturePending &&
      state.historyCoalesceKey === coalesceKey &&
      now - state.historyCoalesceAt <= CROSSFADE_COALESCE_WINDOW_MS;
    if (!canCoalesce) {
      get().pushHistory();
    }

    set((s) => {
      const updatedClips = s.project.clips.map((c) => {
        if (c.id === plan.outClip.id) {
          return {
            ...c,
            transition: {
              fadeInType: c.transition?.fadeInType ?? 'none',
              fadeInDuration: c.transition?.fadeInDuration ?? 0,
              fadeOutType: c.transition?.fadeOutType ?? 'none',
              fadeOutDuration: c.transition?.fadeOutDuration ?? 0,
              crossfadeInDuration: c.transition?.crossfadeInDuration,
              crossfadeOutDuration: plan.duration,
            },
          };
        }
        if (c.id === plan.inClip.id) {
          return {
            ...c,
            start: plan.newIncomingStart,
            transition: {
              fadeInType: c.transition?.fadeInType ?? 'none',
              fadeInDuration: c.transition?.fadeInDuration ?? 0,
              fadeOutType: c.transition?.fadeOutType ?? 'none',
              fadeOutDuration: c.transition?.fadeOutDuration ?? 0,
              crossfadeInDuration: plan.duration,
              crossfadeOutDuration: c.transition?.crossfadeOutDuration,
            },
          };
        }
        return c;
      });
      const updated: Project = {
        ...s.project,
        clips: updatedClips,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      return {
        project: updated,
        historyCoalesceKey: state.historyGesturePending ? null : coalesceKey,
        historyCoalesceAt: state.historyGesturePending ? 0 : now,
        lastError: null,
      };
    });
    get().recalculateDuration();
    return {
      ok: true,
      outClipId: plan.outClip.id,
      inClipId: plan.inClip.id,
      duration: plan.duration,
    };
  },

  /* ------------------------------------------------------------------ */
  /* Fundidos de audio por clip                                          */
  /* ------------------------------------------------------------------ */

  setAudioFade: (clipId, fade) => {
    const state = get();
    const clip = state.project.clips.find((c) => c.id === clipId);
    if (!clip) {
      const reason = 'No se encontró el clip para ajustar el fundido de audio.';
      console.warn(reason);
      set({ lastError: reason });
      return { ok: false, reason };
    }
    if (clip.type !== 'audio' && clip.type !== 'video') {
      const reason =
        `«${clip.name}» no tiene audio: los fundidos de audio solo se aplican a clips con audio. ` +
        'Selecciona un clip de audio o de vídeo.';
      console.warn(reason);
      set({ lastError: reason });
      return { ok: false, reason };
    }
    // Solo cambian los lados presentes: `{ fadeIn }` deja el `fadeOut`
    // intacto (limpiar es `clearAudioFades`, no pasar `undefined` aquí).
    const patch: Partial<Clip> = {};
    if (fade.fadeIn !== undefined) patch.audioFadeIn = fade.fadeIn;
    if (fade.fadeOut !== undefined) patch.audioFadeOut = fade.fadeOut;
    if (!('audioFadeIn' in patch) && !('audioFadeOut' in patch)) {
      const reason =
        'Indica la duración del fundido de entrada o de salida (o usa «Quitar fundidos» para eliminarlos).';
      console.warn(reason);
      set({ lastError: reason });
      return { ok: false, reason };
    }

    // `updateClip` cuantiza y recorta con los fps del proyecto, comparte UNA
    // entrada de historial al arrastrar, y publica el motivo del recorte en
    // `lastError`: ese motivo es el `reason` de este resultado.
    get().updateClip(clipId, patch);
    const reason = get().lastError;
    return { ok: true, clipId, clamped: reason !== null, reason };
  },

  clearAudioFades: (clipId) => {
    const clip = get().project.clips.find((c) => c.id === clipId);
    if (!clip) return false;
    if (clip.audioFadeIn === undefined && clip.audioFadeOut === undefined) return true;
    get().updateClip(clipId, { audioFadeIn: undefined, audioFadeOut: undefined });
    return true;
  },

  /* ------------------------------------------------------------------ */
  /* F7 — internal clipboard                                             */
  /* ------------------------------------------------------------------ */

  copyClips: (clipIds) => {
    const { project } = get();
    const ids = Array.from(new Set(clipIds ?? []));
    const sources = ids
      .map((id) => project.clips.find((c) => c.id === id))
      .filter((c): c is Clip => Boolean(c));
    if (sources.length === 0) return 0;

    // The group keeps its relative layout: the first copied clip is the
    // anchor (offset 0) and the others keep their distance to it.
    const anchor = Math.min(...sources.map((c) => c.start));
    const entries: ClipboardEntry[] = sources.map((source) => ({
      clip: deepCopyClip(source),
      offset: source.start - anchor,
    }));

    set({ clipboard: entries, lastError: null });
    return entries.length;
  },

  pasteClips: (trackId, atTime) => {
    const { project, clipboard, currentTime } = get();
    if (clipboard.length === 0) return [];

    /* --- Destination track ------------------------------------------ */
    const requested = trackId ? project.tracks.find((t) => t.id === trackId) : undefined;
    const firstType = clipboard[0].clip.type;
    const sourceTrack = project.tracks.find((t) => t.id === clipboard[0].clip.trackId);
    const fallback =
      sourceTrack ?? project.tracks.find((t) => isTrackTypeCompatible(t.type, firstType));
    const track = requested ?? fallback;
    if (!track) {
      const message = 'No hay ninguna pista donde pegar los clips copiados.';
      console.warn(message);
      set({ lastError: message });
      return [];
    }
    if (track.isLocked) {
      const message = `La pista "${track.name}" está bloqueada: desbloquéala para poder pegar clips.`;
      console.warn(message);
      set({ lastError: message });
      return [];
    }

    /* --- Track type compatibility (S-12/B-04) ------------------------ */
    const incompatible = clipboard.find((entry) => !isTrackTypeCompatible(track.type, entry.clip.type));
    if (incompatible) {
      const clipKind =
        incompatible.clip.type === 'audio' ? 'audio' : incompatible.clip.type === 'text' ? 'texto' : 'vídeo';
      const trackKind = track.type === 'audio' ? 'audio' : track.type === 'text' ? 'texto' : 'vídeo';
      const message = `No se puede pegar un clip de ${clipKind} en la pista "${track.name}" (${trackKind}).`;
      console.warn(message);
      set({ lastError: message });
      return [];
    }

    /* --- Where the group lands -------------------------------------- */
    const sourceStart = Math.min(...clipboard.map((entry) => entry.clip.start));
    const sourceEnd = Math.max(...clipboard.map((entry) => entry.clip.start + entry.clip.duration));
    const span = Math.max(...clipboard.map((entry) => entry.offset + entry.clip.duration));

    let anchor: number;
    if (atTime !== undefined && Number.isFinite(atTime)) {
      anchor = Math.max(0, atTime);
    } else {
      anchor = currentTime;
      // The playhead sits INSIDE the copied region: the paste lands right
      // after it, otherwise the copy would collide with its own source (and
      // the `block` policy would refuse the paste).
      if (anchor >= sourceStart - OVERLAP_EPSILON && anchor < sourceEnd - OVERLAP_EPSILON) {
        anchor = sourceEnd;
      }
    }

    /* --- The new clips (new ids, deep copies) ------------------------ */
    const newClips: Clip[] = clipboard.map((entry) => ({
      ...deepCopyClip(entry.clip),
      id: createClipId(),
      trackId: track.id,
      start: anchor + entry.offset,
    }));

    if (hasInternalOverlap(newClips)) {
      const message =
        'Los clips copiados se solapan entre sí: pégalos de uno en uno para no crear un solape ilegal.';
      console.warn(message);
      set({ lastError: message });
      return [];
    }

    /* --- Overlap policy (F1) ----------------------------------------- */
    const policy: OverlapPolicy = project.overlapPolicy ?? DEFAULT_OVERLAP_POLICY;
    let working = project.clips;
    const removed: Clip[] = [];

    if (policy === 'overwrite') {
      for (const clip of newClips) {
        const result = applyOverwriteInsert(working, track.id, clip.start, clip.duration);
        working = result.clips;
        removed.push(...result.removed);
      }
    } else if (policy === 'ripple') {
      // The group is inserted as a block: the clips that follow move to the
      // right so the whole group has room.
      working = applyRippleInsert(working, track.id, anchor, span).clips;
    } else {
      // F7: the conflicts are checked CLIP BY CLIP, not against the bounding
      // box of the group. A group copied from two different tracks can be
      // very sparse (a clip at 0 s and another one at 100 s): the bounding
      // box would collide with everything in between and the paste would be
      // refused even though the clips themselves fit perfectly.
      const conflicts = newClips.flatMap((clip) =>
        findOverlappingClips(working, track.id, clip.start, clip.duration)
      );
      if (conflicts.length > 0) {
        const conflict = conflicts[0];
        const message =
          `No se puede pegar aquí: se solapa con «${conflict.name}» ` +
          `(${formatTimelineTime(conflict.start)}–${formatTimelineTime(clipEnd(conflict))}). ` +
          `Mueve el cabezal de reproducción o cambia la política de solapamiento a «Sobrescribir» o «Ripple» en el Inspector.`;
        console.warn(message);
        set({ lastError: message });
        return [];
      }
    }

    /* --- Commit ------------------------------------------------------- */
    get().pushHistory();
    set((state) => {
      const updated: Project = {
        ...state.project,
        clips: [...working, ...newClips],
        updatedAt: Date.now(),
      };
      persistProject(updated);
      // The pasted clips are selected so the user can move them right away.
      return {
        project: updated,
        ...selectionPatch(newClips.map((clip) => clip.id)),
        lastError: null,
      };
    });
    for (const clip of removed) {
      runEngineCleanup('mediaSourcePool.releaseClip', () => mediaSourcePool.releaseClip(clip.id));
    }
    get().recalculateDuration();
    return newClips.map((clip) => clip.id);
  },

  duplicateClips: (clipIds) => {
    const { project } = get();
    const ids = Array.from(new Set(clipIds ?? []));
    const sources = ids
      .map((id) => project.clips.find((c) => c.id === id))
      .filter((c): c is Clip => Boolean(c));
    if (sources.length === 0) return [];

    const policy: OverlapPolicy = project.overlapPolicy ?? DEFAULT_OVERLAP_POLICY;
    /**
     * F7: `working` holds EVERY clip of the project: the originals AND the
     * copies that were already placed.
     *
     * The copies live in the working set because they must be resolved
     * against EACH OTHER: with the old code the copies were appended at the
     * end, so the `overwrite` / `ripple` insertions never saw them and two
     * copies of the same track could end up on top of each other (an illegal
     * overlap the timeline can never show).
     */
    let working: Clip[] = [...project.clips];
    const newClips: Clip[] = [];
    const removed: Clip[] = [];

    // Ordered by track and time so two copies never collide with each other.
    const ordered = [...sources].sort((a, b) =>
      a.trackId === b.trackId ? a.start - b.start : a.trackId.localeCompare(b.trackId)
    );

    for (const source of ordered) {
      const track = project.tracks.find((t) => t.id === source.trackId);
      if (!track) continue;
      if (track.isLocked) {
        const message = `La pista "${track.name}" está bloqueada: desbloquéala para poder duplicar clips.`;
        console.warn(message);
        set({ lastError: message });
        return [];
      }

      // The copy goes right after its original.
      let start = source.start + source.duration;
      if (policy === 'overwrite') {
        const result = applyOverwriteInsert(working, track.id, start, source.duration);
        working = result.clips;
        removed.push(...result.removed);
      } else if (policy === 'ripple') {
        working = applyRippleInsert(working, track.id, start, source.duration).clips;
      } else {
        // `block`: the copy is pushed to the right until it finds a free spot
        // (the timeline never ends up with two clips on top of each other).
        let guard = 0;
        while (guard++ < 1000) {
          const conflicts = findOverlappingClips(working, track.id, start, source.duration);
          if (conflicts.length === 0) break;
          start = Math.max(...conflicts.map((conflict) => clipEnd(conflict)));
        }
      }

      const copy: Clip = {
        ...deepCopyClip(source),
        id: createClipId(),
        trackId: track.id,
        start,
      };
      newClips.push(copy);
      // The copy joins the working set: the next copy is resolved against it.
      working = [...working, copy];
    }

    if (newClips.length === 0) return [];

    get().pushHistory();
    set((state) => {
      const updated: Project = {
        ...state.project,
        // `working` already contains the copies (see the comment above).
        clips: working,
        updatedAt: Date.now(),
      };
      persistProject(updated);
      // The copies are selected so the user can move them right away.
      return {
        project: updated,
        ...selectionPatch(newClips.map((clip) => clip.id)),
        lastError: null,
      };
    });
    for (const clip of removed) {
      runEngineCleanup('mediaSourcePool.releaseClip', () => mediaSourcePool.releaseClip(clip.id));
    }
    get().recalculateDuration();
    return newClips.map((clip) => clip.id);
  },

  addTextClip: (text = 'Título Nuevo', startTime) => {
    const { project, currentTime } = get();
    let textTrack = project.tracks.find((t) => t.type === 'text');
    if (!textTrack) {
      get().addTrack('text', 'Pista de Texto');
      textTrack = get().project.tracks.find((t) => t.type === 'text');
    }
    if (!textTrack) return;

    const startPos = startTime !== undefined ? startTime : currentTime;

    const newClip: Clip = {
      id: 'clip_text_' + Math.random().toString(36).substring(2, 9),
      trackId: textTrack.id,
      mediaId: '',
      name: text,
      type: 'text',
      start: Math.max(0, startPos),
      duration: 5,
      sourceStart: 0,
      sourceDuration: 5,
      volume: 0,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: true,
      text: text,
      textStyle: {
        fontSize: 48,
        color: '#ffffff',
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        fontFamily: 'Inter, sans-serif',
        textAlign: 'center',
        fontWeight: 'bold',
        padding: 16,
        borderRadius: 8,
      },
    };

    get().addClip(newClip);
  },

  updateClip: (clipId, updates) => {
    const state = get();
    const clip = state.project.clips.find((c) => c.id === clipId);
    if (!clip) return;

    const now = Date.now();
    // While a drag/trim gesture is open the gesture owns the history entry.
    const inGesture = state.historyGesturePending;
    // S-02: consecutive edits of the same clip inside the coalescing window
    // share ONE history entry, so a slider drag does not flood the undo stack.
    const canCoalesce =
      !inGesture &&
      state.historyCoalesceKey === clipId &&
      now - state.historyCoalesceAt <= UPDATE_COALESCE_WINDOW_MS;

    if (!inGesture && !canCoalesce) {
      get().pushHistory();
    }

    // S-04: changing the speed rescales the clip duration so the invariant
    // `sourceStart + duration * speed <= sourceDuration` always holds.
    const nextUpdates: Partial<Clip> = { ...updates };
    if (updates.speed !== undefined) {
      const requestedSpeed = updates.speed;
      if (typeof requestedSpeed !== 'number' || !Number.isFinite(requestedSpeed) || requestedSpeed <= 0) {
        delete nextUpdates.speed;
      } else {
        // Keep the same source window, rescale the timeline duration.
        const patch = resolveSpeedPatch(clip, requestedSpeed);
        if (patch) {
          if (nextUpdates.duration === undefined) {
            nextUpdates.duration = patch.duration;
          } else if (Number.isFinite(patch.maxDuration)) {
            // An explicit duration must respect the same source window.
            nextUpdates.duration = Math.min(nextUpdates.duration, patch.maxDuration);
          }
          nextUpdates.speed = patch.speed;
        }
      }
    }

    // Fundidos de audio: toda escritura pasa por `clampClipAudioFades` con los
    // fps reales del proyecto (cuantización a frame + recorte a la duración
    // del clip). `'audioFadeIn' in nextUpdates` (y no `!== undefined`) porque
    // limpiar es asignar `undefined` explícito y también debe revalidar el
    // lado que queda (un fundido de salida que ya supera el clip no puede
    // sobrevivir a que se limpie el de entrada).
    let audioFadeClampReason: string | null = null;
    if ('audioFadeIn' in nextUpdates || 'audioFadeOut' in nextUpdates) {
      const fps = state.project.fps;
      const effectiveDuration =
        nextUpdates.duration !== undefined ? nextUpdates.duration : clip.duration;
      const clamped = clampClipAudioFades(
        'audioFadeIn' in nextUpdates ? nextUpdates.audioFadeIn : clip.audioFadeIn,
        'audioFadeOut' in nextUpdates ? nextUpdates.audioFadeOut : clip.audioFadeOut,
        effectiveDuration,
        fps
      );
      nextUpdates.audioFadeIn = clamped.fadeIn;
      nextUpdates.audioFadeOut = clamped.fadeOut;
      audioFadeClampReason = clamped.reason;
    }

    set((s) => {
      const updatedClips = s.project.clips.map((c) => (c.id === clipId ? { ...c, ...nextUpdates } : c));
      const updated = { ...s.project, clips: updatedClips, updatedAt: Date.now() };
      persistProject(updated);
      return {
        project: updated,
        historyCoalesceKey: inGesture ? null : clipId,
        historyCoalesceAt: inGesture ? 0 : now,
        // F6: a successful edit clears the stale refusal of a previous action.
        // A clamped audio fade keeps its reason instead (the values did NOT
        // land as requested and the user must know).
        lastError: audioFadeClampReason,
      };
    });
    get().recalculateDuration();
  },

  removeClip: (clipId) => {
    const clip = get().project.clips.find((c) => c.id === clipId);
    if (clip && get().project.tracks.find((t) => t.id === clip.trackId)?.isLocked) return;
    get().pushHistory();
    set((state) => {
      const updatedClips = state.project.clips.filter((c) => c.id !== clipId);
      const updated = { ...state.project, clips: updatedClips, updatedAt: Date.now() };
      persistProject(updated);
      return {
        project: updated,
        // F6: the deleted clip leaves the selection (no dangling id).
        ...selectionPatch(pruneSelection(state.selectedClipIds, updatedClips)),
        // F6: a successful removal clears the stale refusal of a previous action.
        lastError: null,
      };
    });
    // F1: the pooled resources of the clip die with it (and the media level
    // ones when the clip was the last user of that media).
    if (clip) {
      releaseClipResources(clip, get().project.clips);
    }
    get().recalculateDuration();
  },

  moveClip: (clipId, newStart, newTrackId) => {
    const { project, snapEnabled, currentTime, zoom } = get();
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) return;

    // Locked source track: positional edits are frozen entirely.
    const sourceTrack = project.tracks.find((t) => t.id === clip.trackId);
    if (sourceTrack?.isLocked) return;

    // S-19: `Math.max(0, NaN) === NaN`, so a non-finite time is refused
    // instead of poisoning the timeline state.
    if (!Number.isFinite(newStart)) {
      const message = 'No se puede mover el clip a un tiempo no válido.';
      console.warn(message);
      set({ lastError: message });
      return;
    }

    // Locked-track guard: never move a clip onto a locked track.
    // Keep the clip on its current track and only apply the time change.
    let effectiveTrackId = newTrackId || clip.trackId;
    // The refusal of THIS action is published with the move: a move that
    // succeeds clears the stale error of a previous action (F6).
    let refusal: string | null = null;
    if (newTrackId && newTrackId !== clip.trackId) {
      const target = project.tracks.find((t) => t.id === newTrackId);
      if (!target || target.isLocked) {
        effectiveTrackId = clip.trackId;
      } else if (!isTrackTypeCompatible(target.type, clip.type)) {
        // S-22: the UI filters the drops, but the store must not allow a
        // programmatic move to place a video clip on an audio track (the
        // compositor would never render it: silent data loss).
        // Same policy as `addClipFromMedia`: redirect to a compatible track
        // and report the refusal.
        const requiredType = trackTypeForMedia(clip.type);
        const compatibleTracks = project.tracks.filter((t) => t.type === requiredType);
        const replacement = compatibleTracks.find((t) => !t.isLocked) ?? compatibleTracks[0];
        effectiveTrackId = replacement ? replacement.id : clip.trackId;

        const clipKind =
          clip.type === 'audio' ? 'audio' : clip.type === 'text' ? 'texto' : 'vídeo';
        const trackKind =
          target.type === 'audio' ? 'audio' : target.type === 'text' ? 'texto' : 'vídeo';
        refusal = `Un clip de ${clipKind} no puede colocarse en la pista "${target.name}" (${trackKind}).`;
        console.warn(refusal);
      }
    }

    // Calculate snapping with both start AND end:
    const snap = calculateSnapping(
      newStart,
      project.clips,
      clipId,
      currentTime,
      zoom,
      12,
      snapEnabled,
      clip.duration
    );

    const finalStart = toFiniteTime(snap.snappedTime, clip.start);
    const snapGuide = snap.didSnap && snap.snapTargetTime !== undefined ? snap.snapTargetTime : null;

    set((state) => {
      const updatedClips = state.project.clips.map((c) => {
        if (c.id === clipId) {
          return {
            ...c,
            start: finalStart,
            trackId: effectiveTrackId,
          };
        }
        return c;
      });
      const updated = { ...state.project, clips: updatedClips, updatedAt: Date.now() };
      return { project: updated, snappingGuideTime: snapGuide, lastError: refusal };
    });
  },

  commitClipChange: () => {
    get().recalculateDuration();
    persistProject(get().project);
    set({ snappingGuideTime: null, historyGesturePending: false, historyCoalesceKey: null, historyCoalesceAt: 0 });
  },

  trimClipStart: (clipId, newStart, options) => {
    const { project, snapEnabled, currentTime, zoom } = get();
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) return;
    if (project.tracks.find((t) => t.id === clip.trackId)?.isLocked) return;

    // S-19: refuse a non-finite trim target instead of writing NaN.
    if (!Number.isFinite(newStart)) return;

    // F5: the keyboard path asks for a frame exact trim: the magnetic
    // snapping is disabled (`snap: false`), otherwise a single arrow press
    // can jump the edge to the playhead or to the nearest edge.
    const useSnapping = options?.snap !== false && snapEnabled;
    const snap = calculateSnapping(
      newStart,
      project.clips,
      clipId,
      currentTime,
      zoom,
      12,
      useSnapping
    );
    const targetStart = toFiniteTime(snap.snappedTime, clip.start);
    const snapGuide = snap.didSnap && snap.snapTargetTime !== undefined ? snap.snapTargetTime : null;

    // End point remains unchanged
    const originalEnd = clip.start + clip.duration;
    if (targetStart >= originalEnd - 0.1) return; // Min 0.1s

    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    // Bound how far we can trim to the left: cannot go past source media start (sourceStart = 0)
    const maxDeltaLeft = -clip.sourceStart / speed;
    const minAllowedStart = Math.max(0, clip.start + maxDeltaLeft);
    const effectiveStart = Math.max(minAllowedStart, targetStart);

    if (effectiveStart >= originalEnd - 0.1) return;

    const delta = effectiveStart - clip.start;
    const newSourceStart = Math.max(0, clip.sourceStart + delta * speed);
    const newDuration = originalEnd - effectiveStart;

    set((state) => {
      const updatedClips = state.project.clips.map((c) =>
        c.id === clipId
          ? { ...c, start: effectiveStart, duration: newDuration, sourceStart: newSourceStart }
          : c
      );
      // S-05: a trim is an edit, so the project must rise in the projects gallery.
      return {
        project: { ...state.project, clips: updatedClips, updatedAt: Date.now() },
        snappingGuideTime: snapGuide,
        // F6: a successful trim clears the stale refusal of a previous action.
        lastError: null,
      };
    });
  },

  trimClipEnd: (clipId, newEnd, options) => {
    const { project, snapEnabled, currentTime, zoom } = get();
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) return;
    if (project.tracks.find((t) => t.id === clip.trackId)?.isLocked) return;

    // S-19: refuse a non-finite trim target instead of writing NaN.
    if (!Number.isFinite(newEnd)) return;

    // F5: the keyboard path asks for a frame exact trim: the magnetic
    // snapping is disabled (`snap: false`), otherwise a single arrow press
    // can jump the edge to the playhead or to the nearest edge.
    const useSnapping = options?.snap !== false && snapEnabled;
    const snap = calculateSnapping(
      newEnd,
      project.clips,
      clipId,
      currentTime,
      zoom,
      12,
      useSnapping
    );
    const targetEnd = toFiniteTime(snap.snappedTime, clip.start + clip.duration);
    const snapGuide = snap.didSnap && snap.snapTargetTime !== undefined ? snap.snapTargetTime : null;

    // F1: the clip was trimmed away completely (an "empty" clip renders
    // nothing): it leaves the timeline and its pooled resources are released
    // with it.
    if (targetEnd <= clip.start) {
      get().removeClip(clipId);
      return;
    }

    if (targetEnd <= clip.start + 0.1) return; // Min 0.1s

    let newDuration = targetEnd - clip.start;
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const maxDuration = (clip.sourceDuration - clip.sourceStart) / speed;
    if (newDuration > maxDuration && clip.type !== 'text') {
      newDuration = maxDuration;
    }
    // S-19: never write a non-finite duration into the timeline.
    if (!Number.isFinite(newDuration) || newDuration <= 0) return;

    set((state) => {
      const updatedClips = state.project.clips.map((c) =>
        c.id === clipId ? { ...c, duration: newDuration } : c
      );
      // S-05: a trim is an edit, so the project must rise in the projects gallery.
      return {
        project: { ...state.project, clips: updatedClips, updatedAt: Date.now() },
        snappingGuideTime: snapGuide,
        // F6: a successful trim clears the stale refusal of a previous action.
        lastError: null,
      };
    });
  },

  splitClip: (clipId, splitTime) => {
    const { project, currentTime } = get();
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) return;
    if (project.tracks.find((t) => t.id === clip.trackId)?.isLocked) return;

    const cutPoint = splitTime !== undefined ? splitTime : currentTime;
    // S-19: refuse a non-finite cut point instead of poisoning the timeline.
    if (!Number.isFinite(cutPoint)) return;
    const clipEnd = clip.start + clip.duration;
    if (!Number.isFinite(clipEnd)) return;

    // Check if cut point is inside clip with at least 0.05s buffer on each side
    if (cutPoint <= clip.start + 0.05 || cutPoint >= clipEnd - 0.05) {
      return;
    }

    get().pushHistory();

    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const firstDuration = cutPoint - clip.start;
    const secondDuration = clipEnd - cutPoint;
    const secondSourceStart = clip.sourceStart + firstDuration * speed;

    // Seamless transition splitting: clip 1 preserves In fade, clip 2 preserves Out fade
    // F5: a split breaks any crossfade pair the clip belonged to (the halves
    // no longer share the deliberate overlap with the partner), so the
    // crossfade markers are dropped from both halves. Keeping them would
    // leave stale markers that claim a crossfade which no longer exists.
    const clip1Transition = clip.transition
      ? {
          ...clip.transition,
          fadeOutType: 'none' as const,
          fadeOutDuration: 0,
          crossfadeInDuration: undefined,
          crossfadeOutDuration: undefined,
        }
      : undefined;

    const clip2Transition = clip.transition
      ? {
          ...clip.transition,
          fadeInType: 'none' as const,
          fadeInDuration: 0,
          crossfadeInDuration: undefined,
          crossfadeOutDuration: undefined,
        }
      : undefined;

    // S-13: partition the synchronised words between both halves.
    // `WordTiming.start/end` are ABSOLUTE timeline times, so they are kept as-is
    // and only assigned to the half that contains them. A word that straddles
    // the cut point goes to the first half.
    const firstWords = clip.words ? clip.words.filter((w) => w.start < cutPoint) : undefined;
    const secondWords = clip.words ? clip.words.filter((w) => w.start >= cutPoint) : undefined;

    // Modify original clip as first part
    const updatedClip1: Clip = {
      ...clip,
      duration: firstDuration,
      transition: clip1Transition,
      // Fundidos de audio: la primera mitad conserva la entrada y pierde la
      // salida (igual que los fundidos de borde del `transition` de arriba).
      audioFadeOut: undefined,
      ...(firstWords ? { words: firstWords } : {}),
    };

    // Create second clip
    const clip2Id = 'clip_' + Math.random().toString(36).substring(2, 9);
    const updatedClip2: Clip = {
      ...clip,
      id: clip2Id,
      name: `${clip.name} (parte 2)`,
      start: cutPoint,
      duration: secondDuration,
      sourceStart: secondSourceStart,
      transition: clip2Transition,
      // La segunda mitad conserva la salida y pierde la entrada.
      audioFadeIn: undefined,
      ...(secondWords ? { words: secondWords } : {}),
    };

    set((state) => {
      const updatedClips = state.project.clips.map((c) => (c.id === clipId ? updatedClip1 : c));
      updatedClips.push(updatedClip2);
      const updated = { ...state.project, clips: updatedClips, updatedAt: Date.now() };
      persistProject(updated);
      // F6: a successful split clears the stale refusal of a previous action.
      return { project: updated, ...selectionPatch([clip2Id]), lastError: null };
    });
    get().recalculateDuration();
  },

  splitAtPlayhead: () => {
    const { project, selectedClipId } = get();
    // Read masterClock.getTime() directly for microsecond accuracy, falling back to state.currentTime if clock is 0
    const effectiveTime = masterClock.getTime() || get().currentTime;

    // 1. If a clip is selected and playhead is inside it, split that clip
    if (selectedClipId) {
      const sel = project.clips.find((c) => c.id === selectedClipId);
      if (sel && effectiveTime > sel.start + 0.05 && effectiveTime < sel.start + sel.duration - 0.05) {
        get().splitClip(selectedClipId, effectiveTime);
        return;
      }
    }

    // 2. Otherwise split the first unmuted/unlocked clip under playhead
    const targetClip = project.clips.find(
      (c) => effectiveTime > c.start + 0.05 && effectiveTime < c.start + c.duration - 0.05
    );
    if (targetClip) {
      get().splitClip(targetClip.id, effectiveTime);
    }
  },

  deleteSelectedClip: () => {
    // F6: the "delete" affordances (the toolbar button, the Supr key, the
    // mobile bar) act on the WHOLE selection. With a single selected clip it
    // is exactly the previous behaviour.
    get().deleteSelectedClips();
  },

  recalculateDuration: () => {
    // KI-01 / S-06 / B-06: the duration is the REAL extent of the content.
    // The old implementation used a hard-coded floor of 15 s plus an
    // unconditional +5 s of "breathing room", so a single 5 s clip produced a
    // 20 s export (4x the export time and file size, with a black tail).
    const { project } = get();
    const totalDuration = computeProjectDuration(project.clips, project.endPaddingSeconds ?? 0);
    if (project.duration === totalDuration) return;
    const updated: Project = { ...project, duration: totalDuration };
    set({ project: updated });
    // The duration is part of the persisted project: keep the gallery in sync.
    persistProject(updated);
  },

  resetProject: () => {
    // F1: the engine is reset with the project. Without this the pooled
    // elements, the cached frame of the compositor and the audio graph of the
    // PREVIOUS project survive forever (memory leak + ghost rendering).
    runEngineCleanup('mediaSourcePool.clear', () => mediaSourcePool.clear());
    runEngineCleanup('compositor.clear', () => compositor.clear());
    runEngineCleanup('audioEngine.stopAll', () => audioEngine.stopAll());
    // Every object URL of the previous project is dead now.
    revokeAllObjectUrls();
    set({
      project: {
        ...INITIAL_PROJECT,
        id: 'proj_' + Math.random().toString(36).substring(2, 9),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      selectedClipId: null,
      // F6: the selection of the previous project is meaningless now.
      selectedClipIds: [],
      currentTime: 0,
      isPlaying: false,
      past: [],
      future: [],
      historyGesturePending: false,
      historyCoalesceKey: null,
      historyCoalesceAt: 0,
      lastError: null,
      // The new project is not on the disk yet.
      lastSavedAt: null,
      // F7: the clipboard of the previous project is meaningless now.
      clipboard: [],
    });
    persistProject(get().project);
  },

  loadProject: (loadedProject) => {
    // F1: the engine is reset BEFORE the new project is loaded, otherwise the
    // elements and the cached frame of the previous project are reused for
    // the new one (the player would paint the last frame of another project).
    const previousProjectId = get().project.id;
    runEngineCleanup('mediaSourcePool.clear', () => mediaSourcePool.clear());
    runEngineCleanup('compositor.clear', () => compositor.clear());
    runEngineCleanup('audioEngine.stopAll', () => audioEngine.stopAll());
    // The object URLs of the previous project are dead. They are NOT revoked
    // when the same project is reloaded: in that case the rehydrated project
    // still uses them.
    if (previousProjectId && previousProjectId !== loadedProject.id) {
      revokeProjectObjectUrls(previousProjectId);
    }
    set({
      project: loadedProject,
      selectedClipId: null,
      // F6: the selection of the previous project is meaningless now.
      selectedClipIds: [],
      currentTime: 0,
      isPlaying: false,
      past: [],
      future: [],
      historyGesturePending: false,
      historyCoalesceKey: null,
      historyCoalesceAt: 0,
      lastError: null,
      // The loaded project is not on the disk yet (it is written right after).
      lastSavedAt: null,
      // F7: the clipboard of the previous project is meaningless now.
      clipboard: [],
    });
    get().recalculateDuration();
    persistProject(loadedProject);
  },
}));

/* ------------------------------------------------------------------ */
/* Module level wiring (F2/F3/F4)                                       */
/* ------------------------------------------------------------------ */

// The storage event subscription is installed ONCE: it survives every store
// reset and it is never re-created by a store write (F4).
installStorageSubscription();

// The unload flush is installed once as well (F3/F4).
installAutosaveFlushOnUnload();

/**
 * F3: a media that fails to load or decode is flagged in the project, so the
 * UI can warn the user ("medio ausente") instead of rendering a black and
 * silent clip without any explanation (B-14).
 *
 * The subscription is installed ONCE (module level): a listener per store
 * write would leak a listener on every mutation.
 */
mediaSourcePool.onMediaError((info) => {
  const state = useProjectStore.getState();
  const media =
    state.project.mediaPool.find((m) => m.id === info.mediaId) ??
    (state.project.trash ?? []).find((e) => e.media.id === info.mediaId)?.media;
  if (!media) return;
  // A media already flagged as `missing` keeps that status: the file is gone,
  // a decode error on top of it does not change the diagnosis.
  if (media.status === 'missing') return;
  state.setMediaStatus(info.mediaId, 'error');
});
