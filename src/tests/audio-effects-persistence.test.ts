/**
 * Regression tests: the import sanitiser must not drop `Clip.audioEffects`
 * (pan / 3-band EQ / ducking) or `Track.role` (dialogue / music / sfx).
 *
 * `sanitizeImportedProject` rebuilds every track and clip field by field: the
 * audio effects and the track role used to be lost on import (`.hydra` /
 * `.json`) while `saveProject` / `getProjectById` kept them. A project
 * exported with panning/EQ/ducking and re-imported lost all of it silently,
 * and losing the dialogue/music marking silently disabled the ducking.
 *
 * The sanitiser now carries both over through the production normalisers
 * (`normalizeAudioEffects`, `normalizeTrackRole`), so imported values are
 * clamped/sanitised exactly like edited ones — and a clip/track without them
 * is rebuilt byte-identically (no key is added when the field is absent).
 *
 * The trash path is covered too: trashed clips are restored verbatim into
 * the live project, so their effects are normalised with the same normaliser
 * instead of travelling raw via a `...c` spread (which is gone).
 *
 * Pure tests (no IndexedDB): they call `sanitizeImportedProject` directly.
 */
import { describe, it, expect } from 'vitest';

import { sanitizeImportedProject } from '../core/storage/projectStorage';
import {
  computeDialogueIntervals,
  normalizeAudioEffects,
  normalizeTrackRole,
} from '../core/utils/audioEffects';

function baseTrack(overrides: any = {}): any {
  return {
    id: 't1',
    name: 'V1',
    type: 'video',
    isMuted: false,
    isLocked: false,
    isVisible: true,
    ...overrides,
  };
}

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
    name: 'Con efectos de audio',
    aspectRatio: '16:9',
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    tracks: [baseTrack()],
    clips: [baseClip()],
    mediaPool: [],
    duration: 4,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('Efectos de audio — el saneador conserva Clip.audioEffects', () => {
  it('conserva paneo, EQ y ducking de un clip importado, normalizados', () => {
    const audioEffects = { pan: -0.5, eq: { low: 3, mid: -2, high: 6 }, duck: true };
    const candidate = baseCandidate({ clips: [baseClip({ audioEffects })] });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });
    const clip = result.project.clips[0];

    expect(clip.audioEffects).toBeDefined();
    // Same output as the production normaliser.
    expect(clip.audioEffects).toEqual(normalizeAudioEffects(audioEffects));
    expect(clip.audioEffects).toEqual({
      pan: -0.5,
      eq: { low: 3, mid: -2, high: 6 },
      duck: true,
    });
  });

  it('no añade la clave audioEffects cuando el clip no la tenía (forma idéntica)', () => {
    const result = sanitizeImportedProject(baseCandidate(), {
      projectId: 'p',
      fallbackName: 'x',
    });
    const clip = result.project.clips[0] as any;

    expect('audioEffects' in clip).toBe(false);
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

  it('recorta valores fuera de rango en lugar de descartarlos', () => {
    const audioEffects = { pan: 5, eq: { low: 30, mid: -30, high: 4 } };
    const candidate = baseCandidate({ clips: [baseClip({ audioEffects })] });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });
    const clip = result.project.clips[0];

    expect(clip.audioEffects).toEqual(normalizeAudioEffects(audioEffects));
    expect(clip.audioEffects).toEqual({ pan: 1, eq: { low: 12, mid: -12, high: 4 } });
  });

  it('elimina los efectos neutros (paneo 0, EQ a 0 dB, duck falso): no se escribe la clave', () => {
    const candidate = baseCandidate({
      clips: [baseClip({ audioEffects: { pan: 0, eq: { low: 0, mid: 0, high: 0 }, duck: false } })],
    });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });
    const clip = result.project.clips[0] as any;

    expect(clip.audioEffects).toBeUndefined();
    expect('audioEffects' in clip).toBe(false);
  });

  it('no se rompe con efectos basura no-objeto (null, texto) y los trata como ausentes', () => {
    const candidate = baseCandidate({
      clips: [baseClip({ id: 'c1', audioEffects: null })],
    });
    const candidate2 = baseCandidate({
      clips: [baseClip({ id: 'c1', audioEffects: 'mucho eco' })],
    });

    for (const c of [candidate, candidate2]) {
      const result = sanitizeImportedProject(c, { projectId: 'p', fallbackName: 'x' });
      const clip = result.project.clips[0] as any;
      expect(clip.audioEffects).toBeUndefined();
      expect('audioEffects' in clip).toBe(false);
    }
  });

  it('la papelera conserva los efectos normalizados (no crudos) y sin spread crudo', () => {
    const audioEffects = { pan: 5, eq: { low: 3 }, duck: true };
    const candidate = baseCandidate({
      clips: [],
      trash: [
        {
          media: { id: 'm9', name: 'Clip archivado' },
          clips: [baseClip({ id: 'ct1', audioEffects, efectoCasero: 'mucho eco' })],
          deletedAt: 2,
        },
        {
          media: { id: 'm8', name: 'Sin efectos' },
          clips: [baseClip({ id: 'ct2' })],
          deletedAt: 3,
        },
      ],
    });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });

    expect(result.project.trash).toHaveLength(2);
    const trashed = result.project.trash![0].clips[0] as any;
    // Normalised with the production normaliser (pan clamped), not raw.
    expect(trashed.audioEffects).toEqual(normalizeAudioEffects(audioEffects));
    expect(trashed.audioEffects).toEqual({ pan: 1, eq: { low: 3 }, duck: true });
    // No `...c` spread: unknown hand-edited keys do not leak through.
    expect('efectoCasero' in trashed).toBe(false);
    // A trashed clip without effects gains no key either.
    const plain = result.project.trash![1].clips[0] as any;
    expect('audioEffects' in plain).toBe(false);
  });
});

describe('Rol de pista — el saneador conserva Track.role', () => {
  it('conserva los roles dialogue, music y sfx', () => {
    const candidate = baseCandidate({
      tracks: [
        baseTrack({ id: 't1', type: 'audio', role: 'dialogue' }),
        baseTrack({ id: 't2', name: 'Música', type: 'audio', role: 'music' }),
        baseTrack({ id: 't3', name: 'FX', type: 'audio', role: 'sfx' }),
      ],
      clips: [],
    });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });

    expect(result.project.tracks.map((t) => t.role)).toEqual(['dialogue', 'music', 'sfx']);
  });

  it('normaliza el rol desconocido a "sin rol" (sin clave) en lugar de arrastrarlo', () => {
    const candidate = baseCandidate({
      tracks: [baseTrack({ role: 'voz' }), baseTrack({ id: 't2', role: null })],
      clips: [],
    });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });

    expect(result.project.tracks).toHaveLength(2);
    for (const track of result.project.tracks) {
      expect(track.role).toBeUndefined();
      expect('role' in track).toBe(false);
    }
    // Same output as the production normaliser.
    expect(normalizeTrackRole('voz')).toBeUndefined();
    expect(normalizeTrackRole('dialogue')).toBe('dialogue');
  });

  it('no añade la clave role cuando la pista no la tenía (forma idéntica)', () => {
    const result = sanitizeImportedProject(baseCandidate(), {
      projectId: 'p',
      fallbackName: 'x',
    });
    const track = result.project.tracks[0] as any;

    expect('role' in track).toBe(false);
    expect(JSON.stringify(track)).toBe(
      JSON.stringify({
        id: 't1',
        name: 'V1',
        type: 'video',
        isMuted: false,
        isLocked: false,
        isVisible: true,
      })
    );
  });

  it('el ducking sigue funcionando tras la importación (diálogo + duck)', () => {
    const candidate = baseCandidate({
      tracks: [
        baseTrack({ id: 't1', name: 'Voz', type: 'audio', role: 'dialogue' }),
        baseTrack({ id: 't2', name: 'Música', type: 'audio', role: 'music' }),
      ],
      clips: [
        baseClip({ id: 'c1', trackId: 't1', type: 'audio', start: 1, duration: 2 }),
        baseClip({
          id: 'c2',
          trackId: 't2',
          type: 'audio',
          start: 0,
          duration: 4,
          audioEffects: { duck: true },
        }),
      ],
    });

    const result = sanitizeImportedProject(candidate, { projectId: 'p', fallbackName: 'x' });

    // The markings survived the round trip…
    expect(result.project.tracks.find((t) => t.id === 't1')?.role).toBe('dialogue');
    expect(result.project.clips.find((c) => c.id === 'c2')?.audioEffects?.duck).toBe(true);
    // …so the ducking rule still sees the voice interval for the other track.
    const intervals = computeDialogueIntervals(result.project.clips, result.project.tracks);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].start).toBe(1);
    expect(intervals[0].end).toBe(3);
    expect(intervals[0].trackId).toBe('t1');
  });
});
