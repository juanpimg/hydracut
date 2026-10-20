/**
 * W-22 · Master volume: ONE shared, persisted preview preference.
 *
 * The desktop `PlayerControls` and the mobile `MobilePreviewPlayer` kept the
 * master volume in separate local component states: the value was lost on
 * every reload and the two layouts desynced each other. The fix is a small
 * shared module (`src/core/utils/masterVolume.ts`) that both controls read
 * and write: persisted in `localStorage`, synced live through subscribe /
 * notify, still driving the single audio path `audioEngine.setMasterVolume`.
 *
 * No jsdom exists in this project, so the component half is asserted at the
 * source level (both controls must reference the shared module, like the
 * mobile-parity suite does) while every behaviour of the shared module is
 * asserted against the REAL production code below.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MASTER_VOLUME_DEFAULT,
  MASTER_VOLUME_STORAGE_KEY,
  clampMasterVolumeValue,
  readMasterVolume,
  subscribeMasterVolume,
  writeMasterVolume,
} from '../core/utils/masterVolume';

const here = dirname(fileURLToPath(import.meta.url));
const playerSource: string = readFileSync(
  join(here, '..', 'components/player/PlayerControls.tsx'),
  'utf8'
);
const mobileSource: string = readFileSync(
  join(here, '..', 'components/mobile/MobilePreviewPlayer.tsx'),
  'utf8'
);

/** Backing map of the `localStorage` stub (sees exactly what is persisted). */
let backingStore = new Map<string, string>();

function installStorageStub(): void {
  const store = backingStore;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
}

beforeEach(() => {
  backingStore = new Map<string, string>();
  installStorageStub();
  writeMasterVolume(MASTER_VOLUME_DEFAULT);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('master volume · clamp (the engine range 0..1)', () => {
  it('clamps out-of-range writes to the range the engine actually applies', () => {
    // Deliberately NOT 0..2: AudioEngine.setMasterVolume clamps to 0..1 and
    // both sliders are min 0 / max 1, so persisting more than 1 would desync
    // the UI from what is heard.
    expect(clampMasterVolumeValue(2)).toBe(1);
    expect(writeMasterVolume(5)).toBe(1);
    expect(readMasterVolume()).toBe(1);
    expect(writeMasterVolume(-1)).toBe(0);
    expect(readMasterVolume()).toBe(0);
  });

  it('falls back to the default on non-finite input', () => {
    expect(clampMasterVolumeValue(Number.NaN)).toBe(MASTER_VOLUME_DEFAULT);
    expect(clampMasterVolumeValue(Number.POSITIVE_INFINITY)).toBe(MASTER_VOLUME_DEFAULT);
    expect(writeMasterVolume(Number.NaN)).toBe(MASTER_VOLUME_DEFAULT);
  });

  it('keeps in-between values untouched', () => {
    expect(writeMasterVolume(0.35)).toBeCloseTo(0.35, 12);
    expect(readMasterVolume()).toBeCloseTo(0.35, 12);
  });
});

describe('master volume · persistence (reload-proof)', () => {
  it('really reaches storage (not just the module memory)', () => {
    writeMasterVolume(0.35);
    expect(Number.parseFloat(backingStore.get(MASTER_VOLUME_STORAGE_KEY) as string)).toBeCloseTo(
      0.35,
      12
    );
  });

  it('reads from storage on every read, so a reload restores the value', () => {
    writeMasterVolume(0.25);
    // What a previous session (or another tab) left behind wins over the
    // stale in-memory copy: reads consult storage first.
    backingStore.set(MASTER_VOLUME_STORAGE_KEY, '0.6');
    expect(readMasterVolume()).toBeCloseTo(0.6, 12);
  });

  it('falls back to the default on a corrupted stored value', () => {
    writeMasterVolume(0.3);
    backingStore.set(MASTER_VOLUME_STORAGE_KEY, 'banana');
    expect(readMasterVolume()).toBe(MASTER_VOLUME_DEFAULT);
  });

  it('clamps an out-of-range stored value instead of trusting it', () => {
    backingStore.set(MASTER_VOLUME_STORAGE_KEY, '5');
    expect(readMasterVolume()).toBe(1);
    backingStore.set(MASTER_VOLUME_STORAGE_KEY, '-2');
    expect(readMasterVolume()).toBe(0);
  });
});

describe('master volume · without localStorage (private mode / SSR)', () => {
  it('degrades to the in-memory copy without throwing when storage is missing', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => writeMasterVolume(0.5)).not.toThrow();
    expect(writeMasterVolume(0.5)).toBeCloseTo(0.5, 12);
    expect(() => readMasterVolume()).not.toThrow();
    expect(readMasterVolume()).toBeCloseTo(0.5, 12);
  });

  it('degrades to the in-memory copy without throwing when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => writeMasterVolume(0.5)).not.toThrow();
    expect(() => readMasterVolume()).not.toThrow();
    expect(readMasterVolume()).toBeCloseTo(0.5, 12);
  });
});

describe('master volume · live sync (desktop <-> mobile)', () => {
  it('notifies every subscriber, so both controls show the same value', () => {
    const seenByDesktop: number[] = [];
    const seenByMobile: number[] = [];
    const stopDesktop = subscribeMasterVolume((next) => {
      seenByDesktop.push(next);
    });
    const stopMobile = subscribeMasterVolume((next) => {
      seenByMobile.push(next);
    });
    writeMasterVolume(0.4);
    expect(seenByDesktop).toEqual([0.4]);
    expect(seenByMobile).toEqual([0.4]);
    stopDesktop();
    writeMasterVolume(0.7);
    expect(seenByDesktop).toEqual([0.4]);
    expect(seenByMobile).toEqual([0.4, 0.7]);
    stopMobile();
  });
});

describe('master volume · single source wiring (regression guard)', () => {
  it('both controls read and write the shared module (no local copies)', () => {
    for (const source of [playerSource, mobileSource]) {
      expect(source).toContain('core/utils/masterVolume');
      expect(source).toContain('readMasterVolume');
      expect(source).toContain('writeMasterVolume');
      expect(source).toContain('subscribeMasterVolume');
    }
  });

  it('both controls still drive the single engine entry point', () => {
    expect(playerSource).toContain('audioEngine.setMasterVolume');
    expect(mobileSource).toContain('audioEngine.setMasterVolume');
  });

  it('neither control keeps the volume in a bare local useState anymore', () => {
    expect(playerSource).not.toContain('useState<number>(1)');
    expect(mobileSource).not.toContain('useState<number>(1)');
  });
});
