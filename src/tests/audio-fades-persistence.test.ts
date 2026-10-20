/**
 * Regression tests: the import sanitiser must not drop `Clip.audioFadeIn` /
 * `Clip.audioFadeOut`.
 *
 * `sanitizeImportedProject` rebuilds every clip field by field: the fades
 * used to be lost on import (`.hydra` / `.json`) while `saveProject` /
 * `getProjectById` kept them. The sanitiser now carries them over through
 * the production normaliser (`clampClipAudioFades`), so imported fades are
 * quantised to the project fps and clamped to the clip duration — and a clip
 * without fades is rebuilt byte-identically (no `audioFadeIn` / `audioFadeOut`
 * key is added).
 *
 * The trash path is covered too: trashed clips are restored verbatim into
 * the live project, so their fades are normalised with the same normaliser
 * instead of travelling raw via the `...c` spread.
 *
 * Pure tests (no IndexedDB): they call `sanitizeImportedProject` directly.
 */
import { describe, it, expect } from 'vitest';

import { sanitizeImportedProject } from '../core/storage/projectStorage';
import { clampClipAudioFades } from '../core/utils/audioFades';

function baseClip(overrides: any = {}): any {
  return {
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
    ...overrides,
  };
}

function baseCandidate(overrides: any = {}): any {
  return {
    id: 'p1',
    name: 'Con fundidos',
    aspectRatio: '16:9',
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    tracks: [
      { id: 't1', name: 'V1', type: 'video', isMuted: false, isLocked: false, isVisible: true },
    ],
    clips: [baseClip()],
    mediaPool: [],
    duration: 4,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('Fundidos de audio — el saneador conserva audioFadeIn/audioFadeOut', () => {
  it('conserva los fundidos de un clip importado, normalizados', () => {
    const audioFadeIn = { duration: 0.5 };
    const audioFadeOut = { duration: 1, curve: 'linear' as const };
    const candidate = baseCandidate({ clips: [baseClip({ audioFadeIn, audioFadeOut })] });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });
    const clip = result.project.clips[0];

    expect(clip.audioFadeIn).toBeDefined();
    expect(clip.audioFadeOut).toBeDefined();
    // Same output as the production normaliser.
    const expected = clampClipAudioFades(audioFadeIn, audioFadeOut, 4, 30);
    expect(clip.audioFadeIn).toEqual(expected.fadeIn);
    expect(clip.audioFadeOut).toEqual(expected.fadeOut);
  });

  it('no añade las claves audioFadeIn/audioFadeOut cuando el clip no los tenía', () => {
    const result = sanitizeImportedProject(baseCandidate(), {
      projectId: 'p',
      fallbackName: 'x',
    });
    const clip = result.project.clips[0] as any;

    expect('audioFadeIn' in clip).toBe(false);
    expect('audioFadeOut' in clip).toBe(false);
    // Byte-identical persisted shape to before the fix (key order included:
    // JSON.stringify respects insertion order; undefined values are dropped).
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

  it('recorta fundidos corruptos en lugar de descartarlos (más largos que el clip)', () => {
    const audioFadeIn = { duration: 10 };
    const audioFadeOut = { duration: 3, curve: 'linear' as const };
    const candidate = baseCandidate({ clips: [baseClip({ audioFadeIn, audioFadeOut })] });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });
    const clip = result.project.clips[0];

    // Clamped, not dropped: both sides survive within the 4 s clip.
    const expected = clampClipAudioFades(audioFadeIn, audioFadeOut, 4, 30);
    expect(clip.audioFadeIn).toEqual(expected.fadeIn);
    expect(clip.audioFadeOut).toEqual(expected.fadeOut);
    expect(clip.audioFadeIn).toBeDefined();
    expect(clip.audioFadeOut).toBeDefined();
    expect(clip.audioFadeIn!.duration).toBeLessThanOrEqual(4);
    expect(clip.audioFadeIn!.duration + clip.audioFadeOut!.duration).toBeLessThanOrEqual(4);
  });

  it('elimina el lado no válido (duración negativa o NaN) pero conserva el lado sano', () => {
    const candidate = baseCandidate({
      clips: [
        baseClip({ audioFadeIn: { duration: -2 }, audioFadeOut: { duration: 1 } }),
        // NOTE: a second clip needs its own id/track slot; reuse the helper.
        { ...baseClip({ id: 'c2', audioFadeIn: { duration: NaN }, audioFadeOut: undefined }) },
      ],
    });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });

    expect(result.project.clips[0].audioFadeIn).toBeUndefined();
    expect(result.project.clips[0].audioFadeOut).toEqual(
      clampClipAudioFades({ duration: -2 }, { duration: 1 }, 4, 30).fadeOut
    );
    expect(result.project.clips[1].audioFadeIn).toBeUndefined();
    expect('audioFadeIn' in (result.project.clips[1] as any)).toBe(false);
  });

  it('no se rompe con fundidos basura no-objeto (null, texto) y los trata como ausentes', () => {
    const candidate = baseCandidate({
      clips: [baseClip({ audioFadeIn: null, audioFadeOut: 'fuerte' })],
    });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });
    const clip = result.project.clips[0] as any;

    expect(clip.audioFadeIn).toBeUndefined();
    expect(clip.audioFadeOut).toBeUndefined();
    expect('audioFadeIn' in clip).toBe(false);
    expect('audioFadeOut' in clip).toBe(false);
  });

  it('normaliza la curva desconocida al defecto (potencia igual)', () => {
    const candidate = baseCandidate({
      clips: [baseClip({ audioFadeIn: { duration: 0.5, curve: 'sierra' } })],
    });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });

    expect(result.project.clips[0].audioFadeIn).toEqual(
      clampClipAudioFades({ duration: 0.5, curve: 'sierra' } as any, undefined, 4, 30).fadeIn
    );
    expect(result.project.clips[0].audioFadeIn!.curve).toBe('equalPower');
  });

  it('la papelera conserva los fundidos normalizados (no crudos)', () => {
    const audioFadeIn = { duration: 10 };
    const audioFadeOut = { duration: 0.5, curve: 'linear' as const };
    const candidate = baseCandidate({
      clips: [],
      trash: [
        {
          media: { id: 'm9', name: 'Clip archivado' },
          clips: [baseClip({ id: 'ct1', audioFadeIn, audioFadeOut })],
          deletedAt: 2,
        },
        {
          media: { id: 'm8', name: 'Sin fundidos' },
          clips: [baseClip({ id: 'ct2' })],
          deletedAt: 3,
        },
      ],
    });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });

    expect(result.project.trash).toHaveLength(2);
    const trashed = result.project.trash![0].clips[0];
    const expected = clampClipAudioFades(audioFadeIn, audioFadeOut, 4, 30);
    expect(trashed.audioFadeIn).toEqual(expected.fadeIn);
    expect(trashed.audioFadeOut).toEqual(expected.fadeOut);
    expect(trashed.audioFadeIn!.duration).toBeLessThanOrEqual(4);
    // A trashed clip without fades gains no keys either.
    const plain = result.project.trash![1].clips[0] as any;
    expect('audioFadeIn' in plain).toBe(false);
    expect('audioFadeOut' in plain).toBe(false);
  });

  it('la papelera descarta el lado corrupto en lugar de arrastrarlo crudo', () => {
    const candidate = baseCandidate({
      clips: [],
      trash: [
        {
          media: { id: 'm9' },
          clips: [baseClip({ id: 'ct1', audioFadeIn: { duration: -5 }, audioFadeOut: null })],
          deletedAt: 2,
        },
      ],
    });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });
    const trashed = result.project.trash![0].clips[0] as any;

    expect('audioFadeIn' in trashed).toBe(false);
    expect('audioFadeOut' in trashed).toBe(false);
  });
});
