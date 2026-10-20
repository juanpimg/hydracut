/**
 * W-22 · Master volume: ONE shared, persisted preview preference.
 *
 * The desktop `PlayerControls` and the mobile `MobilePreviewPlayer` used to
 * keep the master volume in separate local component states: the value was
 * lost on every reload and the two layouts desynced each other (the engine
 * got whatever the last-mounted control set).
 *
 * This module is the single source of truth both controls read and write:
 *
 * - persisted in `localStorage` (a preview preference, NOT a project
 *   setting: it never affects the export, which uses the per-clip volumes);
 * - live-synced through a subscribe/notify mechanism, so the two controls
 *   show the same value and update each other when one changes;
 * - the ONLY audio path stays `audioEngine.setMasterVolume` (this module
 *   never touches the engine itself; the controls push the shared value
 *   into it).
 *
 * Range: 0..1. This deliberately does NOT follow the "0..2" example from
 * the brief: `AudioEngine.setMasterVolume` clamps to 0..1 and both sliders
 * are `min="0" max="1"`, so persisting anything above 1 would desync the UI
 * from what is actually heard. Non-finite input (NaN, Infinity, a corrupted
 * stored string) falls back to the default.
 *
 * Browser edge cases: `localStorage` missing or throwing (private mode,
 * SSR, blocked storage) degrades to an in-memory copy without ever
 * throwing; a present-but-corrupt stored value falls back to the default
 * (and repairs the in-memory copy).
 */

/** Value used on first run, on corrupt storage and on non-finite input. */
export const MASTER_VOLUME_DEFAULT = 1;

/** Lower bound of the master volume (silence). */
export const MASTER_VOLUME_MIN = 0;

/**
 * Upper bound of the master volume. Matches the single audio path
 * (`AudioEngine.setMasterVolume` clamps to 0..1) and both sliders.
 */
export const MASTER_VOLUME_MAX = 1;

/** The `localStorage` key of this preview preference. */
export const MASTER_VOLUME_STORAGE_KEY = 'hydracut.masterVolume';

/**
 * Clamps to `[MIN, MAX]`; anything non-finite (NaN, Infinity, a corrupted
 * stored string parsed to NaN) falls back to the default.
 */
export function clampMasterVolumeValue(value: number): number {
  if (!Number.isFinite(value)) return MASTER_VOLUME_DEFAULT;
  if (value < MASTER_VOLUME_MIN) return MASTER_VOLUME_MIN;
  if (value > MASTER_VOLUME_MAX) return MASTER_VOLUME_MAX;
  return value;
}

/**
 * In-memory copy: what `readMasterVolume` returns when `localStorage` is
 * missing/unreadable, and what keeps this tab working when a write cannot
 * be persisted (private mode). Always holds the last value this session
 * accepted, so the tab never desyncs from itself.
 */
let memoryVolume = MASTER_VOLUME_DEFAULT;

type MasterVolumeListener = (volume: number) => void;

const listeners = new Set<MasterVolumeListener>();

/**
 * Raw stored string, or `null` when there is nothing stored / storage is
 * unusable. Never throws.
 */
function readStorageRaw(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(MASTER_VOLUME_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The persisted master volume, clamped. Missing or unreadable storage
 * returns the in-memory copy; a present-but-corrupt value falls back to
 * the default (and repairs the in-memory copy). Never throws.
 */
export function readMasterVolume(): number {
  const raw = readStorageRaw();
  if (raw === null) return memoryVolume;
  memoryVolume = clampMasterVolumeValue(Number.parseFloat(raw));
  return memoryVolume;
}

/**
 * Stores `volume` (clamped), persists it, and notifies every subscriber so
 * the desktop and the mobile control update live. Returns the stored value.
 * Never throws: when persistence fails the in-memory copy and the
 * notification still keep this tab in sync.
 */
export function writeMasterVolume(volume: number): number {
  const next = clampMasterVolumeValue(volume);
  memoryVolume = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MASTER_VOLUME_STORAGE_KEY, String(next));
    }
  } catch {
    // Private mode / blocked storage: memory + notify still apply.
  }
  for (const listener of Array.from(listeners)) {
    try {
      listener(next);
    } catch {
      // One broken subscriber must not break the remaining controls.
    }
  }
  return next;
}

/**
 * Subscribes to live changes (the other control writing a new value).
 * Returns the unsubscribe function. Never throws.
 */
export function subscribeMasterVolume(listener: MasterVolumeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
