/**
 * Regression tests of the two documentation-review defects (W-28):
 *
 * - Defect 1: the global copy/duplicate shortcuts operated on the PRIMARY
 *   clip only (`selectedClipId`), silently ignoring the multi-selection.
 *   They must operate on the WHOLE selection (`selectedClipIds`), falling
 *   back to the primary clip when the selection is empty.
 * - Defect 2: the in-app shortcuts help (`ShortcutsModal`) did not list
 *   `Ctrl+C` / `Ctrl+V` / `Ctrl+D` nor `Ctrl+A`, although they work.
 *
 * Every test asserts the REAL production behaviour: the exported pure
 * decision (`resolveClipboardIds`), the real store (`copyClips` /
 * `duplicateClips` over the resolved ids) and the real sources (the handler
 * in `MainLayout.tsx` passes the whole selection; the literal list in
 * `ShortcutsModal.tsx` contains the new entries). No jsdom is installed, so
 * the React wiring itself is guarded on the source (same pattern as the
 * other DOM-only guards of the suite).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { useProjectStore } from '../store/useProjectStore';
import { resolveClipboardIds } from '../components/layout/MainLayout';
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

/* ------------------------------------------------------------------ */
/* Defect 1 — the shortcuts operate on the whole selection             */
/* ------------------------------------------------------------------ */

describe('Defect 1 — Ctrl+C / Ctrl+D resolve the whole multi-selection', () => {
  it('resolveClipboardIds devuelve TODA la selección con tres clips elegidos', () => {
    expect(resolveClipboardIds(['a', 'b', 'c'], 'a')).toEqual(['a', 'b', 'c']);
  });

  it('resolveClipboardIds recurre al clip primario cuando la selección está vacía', () => {
    expect(resolveClipboardIds([], 'a')).toEqual(['a']);
  });

  it('resolveClipboardIds devuelve [] sin selección y sin primario (el atajo no hace nada)', () => {
    expect(resolveClipboardIds([], null)).toEqual([]);
  });

  it('resolveClipboardIds devuelve una copia: mutarla no toca el array del store', () => {
    const ids = ['a', 'b'];
    const resolved = resolveClipboardIds(ids, 'a');
    resolved.push('x');
    expect(ids).toEqual(['a', 'b']);
  });

  it('el manejador de MainLayout pasa la selección completa al store (no solo el primario)', () => {
    const source = SRC('components/layout/MainLayout.tsx');
    expect(source).toContain('resolveClipboardIds(state.selectedClipIds, state.selectedClipId)');
    // The old primary-only wiring must be gone.
    expect(source).not.toContain('state.selectedClipId ? [state.selectedClipId] : []');
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
      resolveClipboardIds(current.selectedClipIds, current.selectedClipId)
    );
    expect(copied).toBe(3);
    expect(useProjectStore.getState().clipboard).toHaveLength(3);
  });

  it('duplicateClips sobre los ids resueltos duplica TODA la selección, no solo el primario', () => {
    addClip({ id: 'a', start: 0 });
    addClip({ id: 'b', start: 10 });
    const state = useProjectStore.getState();
    state.selectClip('a');
    state.selectClip('b', { additive: true });

    const current = useProjectStore.getState();
    const duplicated = current.duplicateClips(
      resolveClipboardIds(current.selectedClipIds, current.selectedClipId)
    );
    // Both clips are duplicated (one copy each), not just the primary.
    expect(duplicated).toHaveLength(2);
    expect(useProjectStore.getState().project.clips).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ */
/* Defect 2 — the in-app help lists the new shortcuts                  */
/* ------------------------------------------------------------------ */

describe('Defect 2 — ShortcutsModal lista copiar / pegar / duplicar / seleccionar todo', () => {
  const modalSource = () => SRC('components/modals/ShortcutsModal.tsx');

  it('el modal lista Ctrl+C (copiar) en español', () => {
    expect(modalSource()).toContain('Ctrl + C');
    expect(modalSource()).toContain('Copiar los clips seleccionados');
  });

  it('el modal lista Ctrl+V (pegar) en español', () => {
    expect(modalSource()).toContain('Ctrl + V');
    expect(modalSource()).toContain('Pegar los clips copiados');
  });

  it('el modal lista Ctrl+D (duplicar) en español', () => {
    expect(modalSource()).toContain('Ctrl + D');
    expect(modalSource()).toContain('Duplicar los clips seleccionados');
  });

  it('el modal lista Ctrl+A (seleccionar todo) en español', () => {
    expect(modalSource()).toContain('Ctrl + A');
    expect(modalSource()).toContain('Seleccionar todos los clips');
  });

  it('las entradas nuevas van agrupadas y ANTES de Ctrl+Z (mismo orden que el README)', () => {
    const source = modalSource();
    const order = ['Ctrl + C', 'Ctrl + V', 'Ctrl + D', 'Ctrl + A', 'Ctrl + Z'].map((k) =>
      source.indexOf(k)
    );
    expect(order.every((i) => i !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
