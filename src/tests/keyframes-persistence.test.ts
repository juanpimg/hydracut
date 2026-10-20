/**
 * Regression tests: the import sanitiser must not drop `Clip.keyframes` (F8).
 *
 * `sanitizeImportedProject` rebuilds every clip field by field: `keyframes`
 * used to be lost on import (`.hydra` / `.json`) while `saveProject` /
 * `getProjectById` kept them. The sanitiser now carries them over through
 * the production normaliser (`normalizeKeyframesForWrite`), so imported
 * keyframes are sorted, de-duplicated by time, clamped (scale > 0, opacity
 * 0..1) and quantised to the project fps — and a clip without keyframes is
 * rebuilt byte-identically (no `keyframes` key is added).
 *
 * Pure tests (no IndexedDB): they call `sanitizeImportedProject` directly.
 */
import { describe, it, expect } from 'vitest';

import { sanitizeImportedProject } from '../core/storage/projectStorage';
import { normalizeKeyframesForWrite } from '../core/utils/keyframes';

function baseCandidate(overrides: any = {}): any {
  return {
    id: 'p1',
    name: 'Con keyframes',
    aspectRatio: '16:9',
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    tracks: [
      { id: 't1', name: 'V1', type: 'video', isMuted: false, isLocked: false, isVisible: true },
    ],
    clips: [
      {
        id: 'c1',
        trackId: 't1',
        mediaId: 'm1',
        name: 'Clip 1',
        type: 'video',
        start: 0,
        duration: 4,
        sourceStart: 0,
        sourceDuration: 10,
        volume: 1,
        opacity: 1,
        scale: 1,
        positionX: 0,
        positionY: 0,
        muted: false,
      },
    ],
    mediaPool: [],
    duration: 4,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('F8 — el saneador conserva los keyframes del clip', () => {
  it('conserva los keyframes de un clip importado, normalizados', () => {
    const raw = [
      { t: 2, x: 120, opacity: 0.4 },
      { t: 0.5, scale: 1.5 },
    ];
    const candidate = baseCandidate({ clips: [{ ...baseCandidate().clips[0], keyframes: raw }] });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });
    const clip = result.project.clips[0];

    expect(clip.keyframes).toBeDefined();
    // Same output as the production normaliser (sorted by t).
    expect(clip.keyframes).toEqual(normalizeKeyframesForWrite(raw, 30, 4));
    expect(clip.keyframes!.map((k) => k.t)).toEqual([0.5, 2]);
  });

  it('no añade la clave `keyframes` cuando el clip no los tenía', () => {
    const result = sanitizeImportedProject(baseCandidate(), {
      projectId: 'p',
      fallbackName: 'x',
    });
    const clip = result.project.clips[0] as any;

    expect('keyframes' in clip).toBe(false);
    // Byte-identical persisted shape to before the fix (key order included:
    // JSON.stringify respects insertion order).
    expect(JSON.stringify(clip)).toBe(
      JSON.stringify({
        id: 'c1',
        trackId: 't1',
        mediaId: 'm1',
        name: 'Clip 1',
        type: 'video',
        start: 0,
        duration: 4,
        sourceStart: 0,
        sourceDuration: 10,
        volume: 1,
        opacity: 1,
        scale: 1,
        positionX: 0,
        positionY: 0,
        muted: false,
        speed: 1,
        preservePitch: undefined,
        text: undefined,
        textStyle: undefined,
        words: undefined,
        transition: undefined,
      })
    );
  });

  it('normaliza keyframes corruptos (desordenados, duplicados, fuera de rango) en lugar de descartarlos', () => {
    const raw = [
      { t: 3, x: 10, scale: 99, opacity: 5 },
      { t: 0.04, y: -7, opacity: -2 },
      { t: 3, x: 20 },
      null,
      {},
      { t: 1 },
      'garbage',
    ] as any;
    const candidate = baseCandidate({ clips: [{ ...baseCandidate().clips[0], keyframes: raw }] });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });
    const keyframes = result.project.clips[0].keyframes;

    expect(keyframes).toBeDefined();
    // Garbage entries are dropped, salvageable ones are kept and normalised.
    expect(keyframes).toEqual(normalizeKeyframesForWrite(raw, 30, 4));
    expect(keyframes).toHaveLength(2);
    // Sorted by time.
    expect(keyframes![0].t).toBeLessThan(keyframes![1].t);
    // Clamped to the valid ranges.
    for (const kf of keyframes!) {
      if (kf.scale !== undefined) {
        expect(kf.scale).toBeGreaterThan(0);
        expect(kf.scale).toBeLessThanOrEqual(3);
      }
      if (kf.opacity !== undefined) {
        expect(kf.opacity).toBeGreaterThanOrEqual(0);
        expect(kf.opacity).toBeLessThanOrEqual(1);
      }
    }
    // Duplicated times are merged (the later entry wins per property).
    const atThree = keyframes!.find((k) => k.t === 3);
    expect(atThree).toMatchObject({ x: 20, scale: 3, opacity: 1 });
  });

  it('usa 30 fps por defecto cuando el proyecto no declara fps', () => {
    const raw = [{ t: 1, x: 5 }];
    const { fps: _dropped, ...withoutFps } = baseCandidate();
    const candidate = {
      ...withoutFps,
      clips: [{ ...baseCandidate().clips[0], keyframes: raw }],
    };

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });

    expect(result.project.fps).toBe(30);
    expect(result.project.clips[0].keyframes).toEqual(
      normalizeKeyframesForWrite(raw, 30, 4)
    );
  });
});
