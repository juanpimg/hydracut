/**
 * Import-time sanitising of the clip fields that used to travel raw.
 *
 * `sanitizeImportedProject` (`src/core/storage/projectStorage.ts`) rebuilds
 * every imported clip field by field, but `transition`, `textStyle` and
 * `words` were carried through verbatim: a hand-edited or corrupt
 * `.hydra`/`.json` could inject an invalid `TransitionType`, a
 * `fadeInDuration` of `-999` or `NaN`, a negative font size, or word timings
 * outside the clip. Those values flow straight into the `Compositor`
 * (`calculateTransition` divides by the fade duration — `NaN` poisons the
 * whole frame) and into the audio engine, so they are validated and clamped
 * here, on import, with pure functions.
 *
 * Optional-carry contract (same as `filters` / `keyframes` / `audioFades`):
 * every function returns `undefined` when the field is absent, so no key is
 * added to the rebuilt clip and the persisted shape of the valid case does
 * not change (a project exported by an older build imports byte-identically
 * when it contains no exotic values).
 */

import type {
  ClipTransition,
  LyricAnimationPreset,
  TextStyle,
  TransitionType,
  WordTiming,
} from '../../types/project';

/* ------------------------------------------------------------------ */
/* Transitions                                                          */
/* ------------------------------------------------------------------ */

/** Every valid `TransitionType` (mirrors `src/types/project.ts`). */
export const VALID_TRANSITION_TYPES: readonly TransitionType[] = [
  'none',
  'fade-black',
  'fade-white',
  'slide-left',
  'wipe-right',
];

/**
 * A transition type coming from an untrusted file: unknown values
 * (typos, values from a newer build) fall back to `'none'`.
 */
export function sanitizeTransitionType(value: unknown): TransitionType {
  if (typeof value === 'string') {
    for (const valid of VALID_TRANSITION_TYPES) {
      if (value === valid) return valid;
    }
  }
  return 'none';
}

/** A fade-edge duration: finite and >= 0, clamped to the clip duration. */
function sanitizeFadeDuration(value: unknown, clipDuration: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, clipDuration);
}

/**
 * An optional crossfade marker: `undefined` stays `undefined` (the clip does
 * not take part in any crossfade), a usable duration is clamped to the clip,
 * garbage is dropped instead of crashing the crossfade index.
 */
function sanitizeCrossfadeMarker(value: unknown, clipDuration: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, clipDuration);
}

/**
 * Validates the `transition` of an imported clip against its duration.
 *
 * - unknown types become `'none'`;
 * - non-finite or negative durations become `0`;
 * - every duration is clamped to the clip duration, and when `in + out`
 *   still exceeds it both shrink proportionally (the same rule the audio
 *   fades follow, so the compositor never divides by a duration longer than
 *   the clip it belongs to).
 *
 * Returns `undefined` when the clip has no transition (optional carry).
 */
export function sanitizeClipTransition(
  raw: unknown,
  clipDuration: number
): ClipTransition | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const max = Number.isFinite(clipDuration) && clipDuration > 0 ? clipDuration : 0;
  const t = raw as Partial<ClipTransition>;

  let fadeInDuration = sanitizeFadeDuration(t.fadeInDuration, max);
  let fadeOutDuration = sanitizeFadeDuration(t.fadeOutDuration, max);
  const total = fadeInDuration + fadeOutDuration;
  if (total > max && total > 0) {
    const scale = max / total;
    fadeInDuration = Math.max(0, fadeInDuration * scale);
    fadeOutDuration = Math.max(0, fadeOutDuration * scale);
  }

  const out: ClipTransition = {
    fadeInType: sanitizeTransitionType(t.fadeInType),
    fadeInDuration,
    fadeOutType: sanitizeTransitionType(t.fadeOutType),
    fadeOutDuration,
  };
  const crossfadeIn = sanitizeCrossfadeMarker(t.crossfadeInDuration, max);
  if (crossfadeIn !== undefined) out.crossfadeInDuration = crossfadeIn;
  const crossfadeOut = sanitizeCrossfadeMarker(t.crossfadeOutDuration, max);
  if (crossfadeOut !== undefined) out.crossfadeOutDuration = crossfadeOut;
  return out;
}

/* ------------------------------------------------------------------ */
/* Text style                                                           */
/* ------------------------------------------------------------------ */

/** Smallest readable font size on import (a negative size breaks layout). */
export const TEXT_STYLE_FONT_SIZE_MIN = 8;
/** Largest sane font size on import (canvas text beyond this is garbage). */
export const TEXT_STYLE_FONT_SIZE_MAX = 256;
/** Font size used when the imported one is not a number at all. */
export const TEXT_STYLE_FONT_SIZE_FALLBACK = 48;

/**
 * A colour coming from an untrusted file: it must be a short non-empty
 * string (hex, `rgb()/rgba()`, a named colour, `transparent`…). Anything
 * else (objects, numbers, megabyte-long strings) is dropped so the canvas
 * never receives a value it cannot interpret.
 */
function sanitizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > 128) return undefined;
  return value;
}

function sanitizeTextAlign(value: unknown): TextStyle['textAlign'] {
  return value === 'left' || value === 'right' ? value : 'center';
}

function sanitizeFontWeight(value: unknown): TextStyle['fontWeight'] {
  return value === 'normal' ||
    value === 'bold' ||
    value === '600' ||
    value === '800' ||
    value === '900'
    ? value
    : 'bold';
}

function sanitizeAnimationPreset(value: unknown): LyricAnimationPreset | undefined {
  return value === 'none' ||
    value === 'karaoke-fill' ||
    value === 'word-bounce' ||
    value === 'fade-phrase'
    ? value
    : undefined;
}

/** An optional non-negative number, clamped to `[0, max]`. */
function sanitizeOptionalNonNegative(value: unknown, max: number): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(0, parsed));
}

/**
 * Validates the `textStyle` of an imported clip.
 *
 * - the font size is clamped to `[8, 256]` (`NaN` falls back to `48`, the
 *   size new text clips are created with);
 * - colours must be short non-empty strings (invalid ones fall back to the
 *   defaults for the required slots and are dropped for the optional ones);
 * - `fontFamily` / `textAlign` / `fontWeight` fall back to the creation
 *   defaults when they carry unknown values;
 * - the optional geometry (`padding`, `borderRadius`, `strokeWidth`) is
 *   clamped to >= 0, the optional colours and the animation preset are kept
 *   only when they are valid.
 *
 * Returns `undefined` when the clip has no text style (optional carry).
 */
export function sanitizeClipTextStyle(raw: unknown): TextStyle | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Partial<TextStyle>;

  const fontSizeRaw = Number(s.fontSize);
  const fontSize = Number.isFinite(fontSizeRaw)
    ? Math.min(TEXT_STYLE_FONT_SIZE_MAX, Math.max(TEXT_STYLE_FONT_SIZE_MIN, fontSizeRaw))
    : TEXT_STYLE_FONT_SIZE_FALLBACK;

  const style: TextStyle = {
    fontSize,
    color: sanitizeColor(s.color) ?? '#ffffff',
    backgroundColor: sanitizeColor(s.backgroundColor) ?? 'transparent',
    fontFamily:
      typeof s.fontFamily === 'string' && s.fontFamily.length > 0
        ? s.fontFamily
        : 'Inter, sans-serif',
    textAlign: sanitizeTextAlign(s.textAlign),
    fontWeight: sanitizeFontWeight(s.fontWeight),
  };

  const padding = sanitizeOptionalNonNegative(s.padding, 128);
  if (padding !== undefined) style.padding = padding;
  const borderRadius = sanitizeOptionalNonNegative(s.borderRadius, 64);
  if (borderRadius !== undefined) style.borderRadius = borderRadius;
  const strokeWidth = sanitizeOptionalNonNegative(s.strokeWidth, 32);
  if (strokeWidth !== undefined) style.strokeWidth = strokeWidth;
  const strokeColor = sanitizeColor(s.strokeColor);
  if (strokeColor !== undefined) style.strokeColor = strokeColor;
  const highlightColor = sanitizeColor(s.highlightColor);
  if (highlightColor !== undefined) style.highlightColor = highlightColor;
  const animationPreset = sanitizeAnimationPreset(s.animationPreset);
  if (animationPreset !== undefined) style.animationPreset = animationPreset;

  return style;
}

/* ------------------------------------------------------------------ */
/* Word timings                                                         */
/* ------------------------------------------------------------------ */

/**
 * Validates the synchronised-lyrics timings (`words`) of an imported clip
 * against its duration.
 *
 * - entries that are not objects, have no string `word`, or have non-finite
 *   `start`/`end` are dropped;
 * - times are clamped to `[0, clipDuration]` (negative or overflowing values
 *   would desynchronise the karaoke highlight);
 * - an `end` before its `start` is pulled up to `start`;
 * - the survivors come out sorted by `start` (the compositor walks them in
 *   order).
 *
 * Returns `undefined` when nothing usable survives (optional carry).
 */
export function sanitizeClipWords(raw: unknown, clipDuration: number): WordTiming[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const max = Number.isFinite(clipDuration) && clipDuration > 0 ? clipDuration : 0;

  const out: WordTiming[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const w = entry as Partial<WordTiming>;
    if (typeof w.word !== 'string') continue;
    const startRaw = Number(w.start);
    const endRaw = Number(w.end);
    if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) continue;
    const start = Math.min(Math.max(0, startRaw), max);
    let end = Math.min(Math.max(0, endRaw), max);
    if (end < start) end = start;
    out.push({ word: w.word, start, end });
  }

  if (out.length === 0) return undefined;
  out.sort((a, b) => a.start - b.start);
  return out;
}
