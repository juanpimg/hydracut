/**
 * Regression tests: the on-clip action row (ClipItem) must behave
 * identically to the keyboard (Ctrl+C / Ctrl+D) and operate on the WHOLE
 * multi-selection when the clicked clip is part of it.
 *
 * No jsdom is installed, so the React wiring itself is guarded on the
 * source (same pattern as `src/tests/shortcuts.test.ts`): the pure
 * decision (`resolveActionScopeIds`) is unit-tested directly, the real
 * store (`copyClips` / `duplicateClips` over the resolved ids) proves the
 * end-to-end scope, and the source guards prove the buttons use it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { useProjectStore } from '../store/useProjectStore';
import { resolveActionScopeIds } from '../components/timeline/ClipItem';
import { Clip } from '../types/project';

const VIDEO_TRACK = 'track_video_1';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip_1',
    trackId: VIDEO_TRACK,
    mediaId: 'media_1',
    name: 'Clip',
    type: 'video',
    start: 0,
    duration: 10,
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

function addClip(overrides: Partial<Clip> = {}): string {
  const clip = makeClip(overrides);
  useProjectStore.getState().addClip(clip);
  return clip.id;
}

const SRC = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf-8');

beforeEach(() => {
  useProjectStore.getState().resetProject();
});

describe('resolveActionScopeIds — el botón cubre lo mismo que el teclado', () => {
  it('devuelve TODA la selección cuando el clip clicado forma parte de ella (3 clips)', () => {
    expect(resolveActionScopeIds('b', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('devuelve solo el clip clicado cuando no forma parte de la selección', () => {
    expect(resolveActionScopeIds('z', ['a', 'b', 'c'])).toEqual(['z']);
  });

  it('devuelve solo el clip clicado cuando la selección está vacía', () => {
    expect(resolveActionScopeIds('a', [])).toEqual(['a']);
  });

  it('devuelve una copia: mutarla no toca el array del store', () => {
    const ids = ['a', 'b'];
    const resolved = resolveActionScopeIds('a', ids);
    resolved.push('x');
    expect(ids).toEqual(['a', 'b']);
  });
});

describe('ClipItem — la fila de acciones usa el alcance de la selección', () => {
  const clipItemSource = () => SRC('components/timeline/ClipItem.tsx');

  it('el botón de copiar pasa la selección completa (no solo [clip.id])', () => {
    const source = clipItemSource();
    expect(source).toContain('copyClips(resolveActionScopeIds(clip.id, selectedClipIds))');
    expect(source).not.toContain('copyClips([clip.id])');
  });

  it('el botón de duplicar pasa la selección completa (no solo [clip.id])', () => {
    const source = clipItemSource();
    expect(source).toContain('duplicateClips(resolveActionScopeIds(clip.id, selectedClipIds))');
    expect(source).not.toContain('duplicateClips([clip.id])');
  });

  it('las etiquetas reflejan el alcance en español ("Copiar N clips" / "Duplicar N clips")', () => {
    const source = clipItemSource();
    expect(source).toContain('Copiar ${scopeCount} clips');
    expect(source).toContain('Duplicar ${scopeCount} clips');
  });

  it('los botones mantienen el tamaño táctil mínimo (min-h-[26px])', () => {
    expect(clipItemSource()).toContain('min-h-[26px]');
  });

  it('reutiliza la suscripción existente a selectedClipIds (sin segunda suscripción)', () => {
    const occurrences =
      clipItemSource().split('useProjectStore((s) => s.selectedClipIds)').length - 1;
    expect(occurrences).toBe(1);
  });

  it('copyClips sobre los ids resueltos copia los TRES clips de la selección real', () => {
    addClip({ id: 'a', start: 0 });
    addClip({ id: 'b', start: 10 });
    addClip({ id: 'c', start: 20 });
    const state = useProjectStore.getState();
    state.selectClip('a');
    state.selectClip('b', { additive: true });
    state.selectClip('c', { additive: true });

    const current = useProjectStore.getState();
    expect(current.selectedClipIds).toEqual(['a', 'b', 'c']);
    const copied = current.copyClips(
      resolveActionScopeIds('b', current.selectedClipIds)
    );
    expect(copied).toBe(3);
    expect(useProjectStore.getState().clipboard).toHaveLength(3);
  });

  it('duplicateClips sobre los ids resueltos duplica TODA la selección, no solo el clip clicado', () => {
    addClip({ id: 'a', start: 0 });
    addClip({ id: 'b', start: 10 });
    const state = useProjectStore.getState();
    state.selectClip('a');
    state.selectClip('b', { additive: true });

    const current = useProjectStore.getState();
    const duplicated = current.duplicateClips(
      resolveActionScopeIds('a', current.selectedClipIds)
    );
    expect(duplicated).toHaveLength(2);
    expect(useProjectStore.getState().project.clips).toHaveLength(4);
  });
});
