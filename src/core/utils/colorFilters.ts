/**
 * F9 · Colour filters of a clip — the single source of truth.
 *
 * This module is deliberately PURE (plus a tiny, cached capability probe) so
 * that the preview and the export can never diverge:
 *
 * - `buildCssFilterString()` builds the CSS filter string that the Canvas 2D
 *   context understands (`brightness() contrast() saturate() grayscale()
 *   sepia()`).
 * - `resolveColorFilter()` returns EVERYTHING the compositor needs to paint a
 *   filtered clip: the CSS string and the temperature overlay.
 *
 * The `Compositor` is the only drawing path of the app (the preview renders
 * with it and the exporter renders with it too), so a clip filtered here is
 * filtered identically in the preview and in the exported MP4.
 *
 * ## Why the temperature is NOT part of the CSS filter string
 *
 * CSS has no "white balance" primitive, so the temperature is implemented as
 * a **semi-transparent warm/cool overlay blended with the `overlay` composite
 * operation** over the pixels of the clip (see `TEMPERATURE_OVERLAY_*`).
 *
 * The alternatives were rejected on purpose:
 *
 * - A *colour matrix* (the "proper" way) is not available in Canvas 2D: the
 *   only way to apply one is a `getImageData()`/`putImageData()` pass over
 *   every pixel of every frame. In the preview (60 fps, up to 1.3 M pixels
 *   per frame) that is a guaranteed frame-rate collapse, and it would make
 *   the preview and the export take different code paths (the very bug class
 *   this feature must not introduce).
 * - Faking the temperature with CSS primitives (`sepia()` + `hue-rotate()`)
 *   would fold it into the filter string, but `sepia()` and `hue-rotate()`
 *   are not a white balance: they also change the luminance and the hue of
 *   the skin tones in a way that is hard to predict, and the result depends
 *   on the order in which the browser applies the filter functions.
 *
 * The `overlay` blend mode, on the other hand, is a *pure tint*: it warms
 * the highlights and cools the shadows without touching the luminosity of the
 * midtones, it is supported by every browser that supports `ctx.filter`, and
 * it costs exactly one extra `fillRect()` per filtered clip (no readback, no
 * allocation). Both the preview and the export call the very same code, so
 * the result is identical by construction.
 */

import { ClipColorFilters } from '../../types/project';

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

export type ColorFilterPresetId =
  | 'original'
  | 'warm'
  | 'cool'
  | 'blackWhite'
  | 'sepia'
  | 'cinematic'
  | 'vivid';

export interface ColorFilterPreset {
  id: ColorFilterPresetId;
  /** Spanish label shown in the inspector. */
  label: string;
  /** The values the preset applies to the clip. */
  filters: ClipColorFilters;
}

/**
 * The named colour presets of the inspector (F9).
 *
 * `original` is the neutral one (no filtering at all). The others are pure
 * combinations of the values of `ClipColorFilters`.
 */
export const COLOR_FILTER_PRESETS: Record<ColorFilterPresetId, ColorFilterPreset> = {
  original: {
    id: 'original',
    label: 'Original',
    filters: {},
  },
  warm: {
    id: 'warm',
    label: 'Cálido',
    filters: { temperature: 0.55, saturation: 1.08, brightness: 1.03 },
  },
  cool: {
    id: 'cool',
    label: 'Frío',
    filters: { temperature: -0.55, saturation: 1.05, brightness: 0.99 },
  },
  blackWhite: {
    id: 'blackWhite',
    label: 'B/N',
    filters: { grayscale: 1, contrast: 1.05 },
  },
  sepia: {
    id: 'sepia',
    label: 'Sepia',
    filters: { sepia: 0.75, saturation: 0.9, brightness: 1.05 },
  },
  cinematic: {
    id: 'cinematic',
    label: 'Cine',
    // Teal / orange-ish: more contrast, a bit of warmth and a bit of saturation.
    filters: { contrast: 1.18, temperature: 0.2, saturation: 1.05, brightness: 0.96 },
  },
  vivid: {
    id: 'vivid',
    label: 'Vívido',
    filters: { saturation: 1.5, contrast: 1.12 },
  },
};

/** The order the presets are shown in the inspector. */
export const COLOR_FILTER_PRESET_ORDER: readonly ColorFilterPresetId[] = [
  'original',
  'warm',
  'cool',
  'blackWhite',
  'sepia',
  'cinematic',
  'vivid',
];

/* ------------------------------------------------------------------ */
/* Ranges                                                              */
/* ------------------------------------------------------------------ */

export type ColorFilterKey = keyof ClipColorFilters;

export interface ColorFilterRange {
  min: number;
  max: number;
  /** The value that means "nothing changes". */
  neutral: number;
}

/**
 * The range of every filter. The neutral value is the one that leaves the
 * pixels untouched.
 */
export const COLOR_FILTER_RANGES: Record<ColorFilterKey, ColorFilterRange> = {
  brightness: { min: 0, max: 2, neutral: 1 },
  contrast: { min: 0, max: 2, neutral: 1 },
  saturation: { min: 0, max: 2, neutral: 1 },
  temperature: { min: -1, max: 1, neutral: 0 },
  grayscale: { min: 0, max: 1, neutral: 0 },
  sepia: { min: 0, max: 1, neutral: 0 },
};

/** The colour of the warm overlay (temperature > 0). */
export const TEMPERATURE_OVERLAY_WARM = '#ff9b3d';
/** The colour of the cool overlay (temperature < 0). */
export const TEMPERATURE_OVERLAY_COOL = '#3d9bff';
/** The alpha of the overlay when the temperature is at its maximum (|t| = 1). */
export const TEMPERATURE_OVERLAY_MAX_ALPHA = 0.45;

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Clamps one filter value into its range. A missing / invalid value becomes
 * the neutral one (so a corrupted project never produces a broken filter).
 */
export function clampFilterValue(key: ColorFilterKey, value: unknown): number {
  const range = COLOR_FILTER_RANGES[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return range.neutral;
  return Math.min(range.max, Math.max(range.min, parsed));
}

/**
 * The normalised (clamped) value of every filter. `undefined` fields become
 * the neutral value.
 */
export interface NormalizedColorFilters {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  grayscale: number;
  sepia: number;
}

/**
 * Normalises a (possibly corrupted) filter object.
 *
 * Used by the import path of the storage layer: an untrusted project file
 * must never be able to inject a filter with absurd values.
 */
export function normalizeColorFilters(filters: unknown): ClipColorFilters | undefined {
  if (!filters || typeof filters !== 'object') return undefined;
  const source = filters as Partial<ClipColorFilters>;
  const normalized: ClipColorFilters = {};
  let neutral = true;
  for (const key of Object.keys(COLOR_FILTER_RANGES) as ColorFilterKey[]) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    const value = clampFilterValue(key, raw);
    normalized[key] = value;
    if (value !== COLOR_FILTER_RANGES[key].neutral) neutral = false;
  }
  if (neutral) return undefined;
  return normalized;
}

/** `true` when the filters do not change a single pixel. */
export function isNeutralColorFilters(filters?: ClipColorFilters | null): boolean {
  if (!filters) return true;
  for (const key of Object.keys(COLOR_FILTER_RANGES) as ColorFilterKey[]) {
    const raw = filters[key];
    if (raw === undefined || raw === null) continue;
    if (clampFilterValue(key, raw) !== COLOR_FILTER_RANGES[key].neutral) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* The CSS filter string                                               */
/* ------------------------------------------------------------------ */

/**
 * Formats a factor for the CSS filter string: at most 4 decimals and no
 * trailing zeros (`1.5`, `1`, `0.25`).
 */
function formatFactor(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return String(rounded);
}

/**
 * Builds the CSS filter string of a clip.
 *
 * Returns `''` (no filtering at all) when the filters are neutral, so the
 * compositor can skip the `ctx.filter` assignment completely.
 *
 * The order of the functions is fixed (brightness, contrast, saturate,
 * grayscale, sepia) so the SAME filters always produce the SAME string: the
 * preview and the export can be compared literally.
 */
export function buildCssFilterString(filters?: ClipColorFilters | null): string {
  if (!filters) return '';
  const parts: string[] = [];

  const brightness = clampFilterValue('brightness', filters.brightness);
  if (brightness !== COLOR_FILTER_RANGES.brightness.neutral) {
    parts.push(`brightness(${formatFactor(brightness)})`);
  }

  const contrast = clampFilterValue('contrast', filters.contrast);
  if (contrast !== COLOR_FILTER_RANGES.contrast.neutral) {
    parts.push(`contrast(${formatFactor(contrast)})`);
  }

  const saturation = clampFilterValue('saturation', filters.saturation);
  if (saturation !== COLOR_FILTER_RANGES.saturation.neutral) {
    parts.push(`saturate(${formatFactor(saturation)})`);
  }

  const grayscale = clampFilterValue('grayscale', filters.grayscale);
  if (grayscale !== COLOR_FILTER_RANGES.grayscale.neutral) {
    parts.push(`grayscale(${formatFactor(grayscale)})`);
  }

  const sepia = clampFilterValue('sepia', filters.sepia);
  if (sepia !== COLOR_FILTER_RANGES.sepia.neutral) {
    parts.push(`sepia(${formatFactor(sepia)})`);
  }

  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* The resolved filter                                                 */
/* ------------------------------------------------------------------ */

export interface ResolvedColorFilter {
  /** The CSS filter string (`''` = no CSS filtering). */
  css: string;
  /** The temperature strength (-1..1, 0 = neutral). */
  temperature: number;
  /** The colour of the temperature overlay (`null` = neutral). */
  overlayColor: string | null;
  /** The strength of the temperature overlay (0..1). */
  overlayAlpha: number;
  /** `true` when something has to be painted. */
  active: boolean;
}

/**
 * Resolves the filters of a clip into everything the compositor needs.
 *
 * NOTE: this function ALLOCATES. The compositor caches its result per clip
 * and only calls it when the values of the clip change (see
 * `Compositor.resolveClipFilter`): the hot path never allocates.
 */
export function resolveColorFilter(filters?: ClipColorFilters | null): ResolvedColorFilter {
  countColorFilterBuild();
  const css = buildCssFilterString(filters);
  const temperature = clampFilterValue('temperature', filters?.temperature);
  const hasTemperature = temperature !== COLOR_FILTER_RANGES.temperature.neutral;
  return {
    css,
    temperature,
    overlayColor: hasTemperature
      ? temperature > 0
        ? TEMPERATURE_OVERLAY_WARM
        : TEMPERATURE_OVERLAY_COOL
      : null,
    overlayAlpha: hasTemperature ? Math.abs(temperature) * TEMPERATURE_OVERLAY_MAX_ALPHA : 0,
    active: css !== '' || hasTemperature,
  };
}

/**
 * Returns the preset whose filters match the given ones exactly, or `null`
 * when the filters are a custom combination (or neutral).
 */
export function matchColorFilterPreset(filters?: ClipColorFilters | null): ColorFilterPresetId | null {
  if (isNeutralColorFilters(filters)) return 'original';
  const target = normalizeColorFilters(filters);
  if (!target) return null;
  for (const id of COLOR_FILTER_PRESET_ORDER) {
    const preset = normalizeColorFilters(COLOR_FILTER_PRESETS[id].filters);
    if (!preset) continue;
    const keys = Object.keys(COLOR_FILTER_RANGES) as ColorFilterKey[];
    const same = keys.every((key) => {
      const a = preset[key];
      const b = target[key];
      if (a === undefined && b === undefined) return true;
      if (a === undefined || b === undefined) return false;
      return Math.abs(a - b) < 1e-6;
    });
    if (same) return id;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Capability detection                                                */
/* ------------------------------------------------------------------ */

/**
 * Detects whether a 2D context really supports `ctx.filter`.
 *
 * The detection is not only "the property exists": some WebKit builds accept
 * the assignment and then IGNORE it (the pixels are drawn unfiltered), which
 * would be a silent no-op. The value is therefore read back after being
 * assigned: if the context did not keep it, the filters are NOT supported.
 */
export function detectCanvasFilterSupport(
  ctx?: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
): boolean {
  try {
    let context = ctx;
    if (!context) {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
        return false;
      }
      const canvas = document.createElement('canvas');
      context = canvas.getContext('2d') as CanvasRenderingContext2D | null;
    }
    if (!context) return false;
    if (!('filter' in context)) return false;
    const probe = 'brightness(1.5)';
    (context as CanvasRenderingContext2D).filter = probe;
    const supported = (context as CanvasRenderingContext2D).filter === probe;
    (context as CanvasRenderingContext2D).filter = 'none';
    return supported;
  } catch {
    return false;
  }
}

let cachedFilterSupport: boolean | null = null;

/**
 * `true` when the browser supports `ctx.filter`.
 *
 * The probe runs ONCE (the result is cached): it is a hot path (the
 * compositor asks for it on every frame) and creating a canvas is not free.
 */
export function getCanvasFilterSupport(): boolean {
  if (cachedFilterSupport === null) {
    cachedFilterSupport = detectCanvasFilterSupport();
  }
  return cachedFilterSupport;
}

/**
 * Forgets the cached capability probe.
 *
 * Needed when the environment changes (tests) or when a future version wants
 * to re-probe after a browser upgrade.
 */
export function resetCanvasFilterSupportCache(): void {
  cachedFilterSupport = null;
}

/**
 * The Spanish message shown when the browser cannot filter the clips.
 * The inspector uses it to explain WHY the controls are disabled.
 */
export const COLOR_FILTER_UNSUPPORTED_MESSAGE =
  'Este navegador no soporta los filtros de color (ctx.filter no está disponible). ' +
  'Los controles están desactivados y el clip se exportará sin ajustes de color: ' +
  'usa Chrome, Edge o Firefox actualizados.';

/* ------------------------------------------------------------------ */
/* Instrumentation (tests)                                             */
/* ------------------------------------------------------------------ */

let buildCount = 0;

/**
 * How many times a filter string was ACTUALLY built.
 *
 * The compositor caches the result per clip, so this counter must NOT grow
 * with the number of frames: it is the proof that the hot path does not
 * rebuild (nor re-allocate) the filter of every clip on every frame.
 */
export function getColorFilterBuildCount(): number {
  return buildCount;
}

/** Resets the instrumentation counter. */
export function resetColorFilterBuildCount(): void {
  buildCount = 0;
}

/** Internal: counts a real build of a filter string. */
export function countColorFilterBuild(): void {
  buildCount++;
}
