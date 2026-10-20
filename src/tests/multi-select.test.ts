/**
 * Regression tests of F6 — multi-selección y acciones en lote.
 *
 * Every test asserts the REAL production behaviour of the store (and of the
 * pure helpers it exposes): no re-implementation of the logic under test and
 * no tautological asserts.
 *
 * Covered:
 * - the selection (`selectedClipIds` is the source of truth, `selectedClipId`
 *   is its PRIMARY element);
 * - Ctrl/Cmd + clic (toggle), Shift + clic (range on the same track),
 *   "seleccionar todo" and the rubber band geometry;
 * - the batch actions (delete / volume / opacity / speed / mute) as ONE
 *   undoable step each;
 * - the selection across undo / redo (no dangling id, a restored clip that
 *   was selected stays selected);
 * - the availability of the batch operations (a mixed selection is refused
 *   WITH A REASON, never applied "to some of the clips").
 *
 * The DOM level guarantees (the ring of a selected clip, the rubber band on
 * the screen, the "N clips seleccionados" panel) can only be asserted in a
 * real browser: jsdom is not installed. The wiring of those parts is asserted
 * on the source (same pattern as the other DOM-only guards of the suite).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  useProjectStore,
  getBatchOperationAvailability,
  orderClipsByTimeline,
  selectRangeOnTrack,
} from '../store/useProjectStore';
import { selectClipIdsInRect, mergeSelection, TRACK_LANE_HEIGHT } from '../components/timeline/Timeline';
import { Clip, Track } from '../types/project';

const VIDEO_TRACK = 'track_video_1';
const VIDEO_TRACK_2 = 'track_video_2';
const AUDIO_TRACK = 'track_audio_1';
const TEXT_TRACK = 'track_text_1';

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

/** Adds a clip to the project and returns its id. */
function addClip(overrides: Partial<Clip> = {}): string {
  const clip = makeClip(overrides);
  useProjectStore.getState().addClip(clip);
  return clip.id;
}

/** Locks a track by id (the store has no dedicated "lock" action for tests). */
function lockTrack(trackId: string): void {
  const state = useProjectStore.getState();
  useProjectStore.setState({
    project: {
      ...state.project,
      tracks: state.project.tracks.map((t) => (t.id === trackId ? { ...t, isLocked: true } : t)),
    },
  });
}

const selection = () => useProjectStore.getState().selectedClipIds;
const primary = () => useProjectStore.getState().selectedClipId;

beforeEach(() => {
  useProjectStore.getState().resetProject();
});

/* ------------------------------------------------------------------ */
/* F6 — the selection                                                  */
/* ------------------------------------------------------------------ */

describe('F6 — la selección (selectedClipIds es la fuente de verdad)', () => {
  it('un clic normal REEMPLAZA la selección y sincroniza el clip primario', () => {
    addClip({ id: 'a' });
    addClip({ id: 'b', start: 20 });

    useProjectStore.getState().selectClip('a');
    expect(selection()).toEqual(['a']);
    expect(primary()).toBe('a');

    useProjectStore.getState().selectClip('b');
    expect(selection()).toEqual(['b']);
    expect(primary()).toBe('b');
  });

  it('Ctrl/Cmd + clic AÑADE el clip a la selección sin cambiar el primario', () => {
    addClip({ id: 'a' });
    addClip({ id: 'b', start: 20 });

    useProjectStore.getState().selectClip('a');
    useProjectStore.getState().selectClip('b', { additive: true });

    expect(selection()).toEqual(['a', 'b']);
    // The primary stays the first element of the array.
    expect(primary()).toBe('a');
  });

  it('Ctrl/Cmd + clic SACA el clip de la selección y el primario avanza', () => {
    addClip({ id: 'a' });
    addClip({ id: 'b', start: 20 });

    useProjectStore.getState().selectClip('a');
    useProjectStore.getState().selectClip('b', { additive: true });
    useProjectStore.getState().selectClip('a', { additive: true });

    expect(selection()).toEqual(['b']);
    expect(primary()).toBe('b');
  });

  it('Ctrl/Cmd + clic sobre una selección vacía selecciona el clip', () => {
    addClip({ id: 'a' });
    useProjectStore.getState().clearSelection();

    useProjectStore.getState().selectClip('a', { additive: true });

    expect(selection()).toEqual(['a']);
    expect(primary()).toBe('a');
  });

  it('Shift + clic selecciona el rango contiguo de la MISMA pista', () => {
    addClip({ id: 'a', trackId: VIDEO_TRACK, start: 0 });
    addClip({ id: 'b', trackId: VIDEO_TRACK, start: 10 });
    addClip({ id: 'c', trackId: VIDEO_TRACK, start: 20 });
    // A clip of ANOTHER track inside the same time range: it must NOT be
    // selected by the range.
    addClip({ id: 'd', trackId: VIDEO_TRACK_2, start: 5 });

    useProjectStore.getState().selectClip('a');
    useProjectStore.getState().selectClip('c', { range: true });

    expect(selection()).toEqual(['a', 'b', 'c']);
    // The anchor stays the primary so a second Shift + clic extends the same
    // range.
    expect(primary()).toBe('a');
  });

  it('Shift + clic hacia atrás selecciona el rango en sentido inverso', () => {
    addClip({ id: 'a', trackId: VIDEO_TRACK, start: 0 });
    addClip({ id: 'b', trackId: VIDEO_TRACK, start: 10 });
    addClip({ id: 'c', trackId: VIDEO_TRACK, start: 20 });

    useProjectStore.getState().selectClip('c');
    useProjectStore.getState().selectClip('a', { range: true });

    expect(selection().slice().sort()).toEqual(['a', 'b', 'c']);
    expect(selection()).toHaveLength(3);
  });

  it('Shift + clic sobre otra pista selecciona sólo ese clip', () => {
    addClip({ id: 'a', trackId: VIDEO_TRACK, start: 0 });
    addClip({ id: 'd', trackId: VIDEO_TRACK_2, start: 5 });

    useProjectStore.getState().selectClip('a');
    useProjectStore.getState().selectClip('d', { range: true });

    expect(selection()).toEqual(['d']);
  });

  it('Shift + clic sin ancla previa selecciona sólo ese clip', () => {
    addClip({ id: 'a' });
    addClip({ id: 'b', start: 20 });

    useProjectStore.getState().selectClip('b', { range: true });

    expect(selection()).toEqual(['b']);
  });

  it('seleccionar todo coje todos los clips en orden de timeline', () => {
    addClip({ id: 'a', trackId: VIDEO_TRACK, start: 0 });
    addClip({ id: 'b', trackId: AUDIO_TRACK, start: 5 });
    addClip({ id: 'c', trackId: VIDEO_TRACK, start: 20 });

    useProjectStore.getState().selectAllClips();

    // The tracks of the project are: text, video 2, video 1 and audio.
    expect(selection()).toEqual(['a', 'c', 'b']);
    expect(primary()).toBe('a');
  });

  it('clearSelection y selectClip(null) vacían la selección', () => {
    addClip({ id: 'a' });
    useProjectStore.getState().selectClip('a');

    useProjectStore.getState().clearSelection();
    expect(selection()).toEqual([]);
    expect(primary()).toBeNull();

    useProjectStore.getState().selectClip('a');
    expect(selection()).toEqual(['a']);
    useProjectStore.getState().selectClip(null);
    expect(selection()).toEqual([]);
    expect(primary()).toBeNull();
  });

  it('un id que no existe NUNCA entra en la selección', () => {
    addClip({ id: 'a' });

    useProjectStore.getState().selectClip('no-existe');

    expect(selection()).toEqual([]);
    expect(primary()).toBeNull();
  });

  it('getSelectedClips devuelve los clips de la selección en orden de timeline', () => {
    addClip({ id: 'a', trackId: VIDEO_TRACK, start: 0 });
    addClip({ id: 'b', trackId: AUDIO_TRACK, start: 5 });
    addClip({ id: 'c', trackId: VIDEO_TRACK, start: 20 });

    useProjectStore.getState().selectAllClips();
    const clips = useProjectStore.getState().getSelectedClips();

    expect(clips.map((c) => c.id)).toEqual(['a', 'c', 'b']);
  });
});

/* ------------------------------------------------------------------ */
/* F6 — batch actions (one undoable step each)                        */
/* ------------------------------------------------------------------ */

describe('F6 — las acciones en lote son UN solo paso deshacible', () => {
  it('deleteSelectedClips borra todos los clips seleccionados en UNA entrada de historial', () => {
    addClip({ id: 'a' });
    addClip({ id: 'b', start: 20 });
    addClip({ id: 'c', start: 40 });

    const store = useProjectStore.getState();
    store.selectClip('a');
    store.selectClip('b', { additive: true });

    const pastBefore = useProjectStore.getState().past.length;
    useProjectStore.getState().deleteSelectedClips();

    expect(useProjectStore.getState().project.clips.map((c) => c.id)).toEqual(['c']);
    // ONE history entry for the whole batch (not one per clip).
    expect(useProjectStore.getState().past.length).toBe(pastBefore + 1);
    // The deleted clips leave the selection (no dangling id).
    expect(selection()).toEqual([]);
    expect(primary()).toBeNull();
  });

  it('un solo undo restituye el lote entero', () => {
    addClip({ id: 'a' });
    addClip({ id: 'b', start: 20 });

    useProjectStore.getState().selectClip('a');
    useProjectStore.getState().selectClip('b', { additive: true });
    useProjectStore.getState().deleteSelectedClips();
    expect(useProjectStore.getState().project.clips).toHaveLength(0);

    useProjectStore.getState().undo();

    expect(useProjectStore.getState().project.clips.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('los clips de una pista BLOQUEADA sobreviven al borrado en lote y el motivo se publica', () => {
    addClip({ id: 'a' });
    addClip({ id: 'b', start: 20 });
    lockTrack(VIDEO_TRACK);

    useProjectStore.getState().selectClip('a');
    useProjectStore.getState().selectClip('b', { additive: true });
    useProjectStore.getState().deleteSelectedClips();

    expect(useProjectStore.getState().project.clips).toHaveLength(2);
    // The refusal is surfaced with a reason (a silent no-op is not acceptable).
    expect(useProjectStore.getState().lastError).toMatch(/bloqueada/i);
  });

  it('setSelectedClipsVolume aplica el volumen a TODOS los clips en una entrada', () => {
    addClip({ id: 'a', volume: 1 });
    addClip({ id: 'b', start: 20, volume: 0.8 });

    useProjectStore.getState().selectClip('a');
    useProjectStore.getState().selectClip('b', { additive: true });

    const pastBefore = useProjectStore.getState().past.length;
    useProjectStore.getState().setSelectedClipsVolume(0.25);

    const clips = useProjectStore.getState().project.clips;
    expect(clips.map((c) => c.volume)).toEqual([0.25, 0.25]);
    expect(useProjectStore.getState().past.length).toBe(pastBefore + 1);

    // One undo reverts the whole batch.
    useProjectStore.getState().undo();
    const reverted = useProjectStore.getState().project.clips;
    expect(reverted.map((c) => c.volume)).toEqual([1, 0.8]);
  });

  it('setSelectedClipsOpacity aplica la opacidad a TODOS los clips', () => {
    addClip({ id: 'a' });
    addClip({ id: 'b', start: 20 });

    useProjectStore.getState().selectAllClips();
    useProjectStore.getState().setSelectedClipsOpacity(0.4);

    expect(useProjectStore.getState().project.clips.map((c) => c.opacity)).toEqual([0.4, 0.4]);
  });

  it('setSelectedClipsSpeed reescala la duración de cada clip del lote (S-04)', () => {
    addClip({ id: 'a', duration: 10, sourceDuration: 10 });
    addClip({ id: 'b', start: 20, duration: 8, sourceDuration: 8 });

    useProjectStore.getState().selectAllClips();
    useProjectStore.getState().setSelectedClipsSpeed(2);

    const clips = useProjectStore.getState().project.clips;
    expect(clips.map((c) => c.speed)).toEqual([2, 2]);
    expect(clips.map((c) => c.duration)).toEqual([5, 4]);
    // The source window still fits inside the media.
    for (const clip of clips) {
      expect(clip.sourceStart + clip.duration * (clip.speed as number)).toBeLessThanOrEqual(
        clip.sourceDuration
      );
    }
  });

  it('setSelectedClipsMuted silencia (o reactiva) TODOS los clips', () => {
    addClip({ id: 'a' });
    addClip({ id: 'b', start: 20 });

    useProjectStore.getState().selectAllClips();
    useProjectStore.getState().setSelectedClipsMuted(true);
    expect(useProjectStore.getState().project.clips.map((c) => c.muted)).toEqual([true, true]);

    useProjectStore.getState().setSelectedClipsMuted(false);
    expect(useProjectStore.getState().project.clips.map((c) => c.muted)).toEqual([false, false]);
  });

  it('una acción en lote sin selección no hace nada (ni historial, ni cambios)', () => {
    addClip({ id: 'a', volume: 1 });
    useProjectStore.getState().clearSelection();
    const pastBefore = useProjectStore.getState().past.length;

    useProjectStore.getState().setSelectedClipsVolume(0.1);
    useProjectStore.getState().deleteSelectedClips();

    expect(useProjectStore.getState().project.clips[0].volume).toBe(1);
    expect(useProjectStore.getState().past.length).toBe(pastBefore);
  });
});

/* ------------------------------------------------------------------ */
/* F6 — the selection across undo / redo                              */
/* ------------------------------------------------------------------ */

describe('F6 — la selección sobrevive al undo / redo', () => {
  it('un clip borrado NO deja un id colgante en la selección', () => {
    addClip({ id: 'a' });
    addClip({ id: 'b', start: 20 });

    useProjectStore.getState().selectClip('a');
    useProjectStore.getState().selectClip('b', { additive: true });
    useProjectStore.getState().removeClip('a');

    expect(selection()).toEqual(['b']);
    expect(primary()).toBe('b');
  });

  it('el undo de un borrado en lote restaura los clips Y su selección', () => {
    addClip({ id: 'a' });
    addClip({ id: 'b', start: 20 });

    useProjectStore.getState().selectClip('a');
    useProjectStore.getState().selectClip('b', { additive: true });
    useProjectStore.getState().deleteSelectedClips();
    expect(selection()).toEqual([]);

    useProjectStore.getState().undo();

    expect(useProjectStore.getState().project.clips).toHaveLength(2);
    // The restored clips that were selected stay selected.
    expect(selection()).toEqual(['a', 'b']);
    expect(primary()).toBe('a');
  });

  it('un clip que sigue existiendo permanece seleccionado tras un undo', () => {
    addClip({ id: 'a', volume: 1 });
    useProjectStore.getState().selectClip('a');

    useProjectStore.getState().updateClip('a', { volume: 0.5 });
    expect(useProjectStore.getState().project.clips[0].volume).toBe(0.5);

    useProjectStore.getState().undo();

    expect(useProjectStore.getState().project.clips[0].volume).toBe(1);
    expect(selection()).toEqual(['a']);
    expect(primary()).toBe('a');
  });

  it('el redo vuelve a borrar el lote y deja la selección sin ids colgantes', () => {
    addClip({ id: 'a' });
    addClip({ id: 'b', start: 20 });

    useProjectStore.getState().selectClip('a');
    useProjectStore.getState().selectClip('b', { additive: true });
    useProjectStore.getState().deleteSelectedClips();
    useProjectStore.getState().undo();
    expect(selection()).toEqual(['a', 'b']);

    useProjectStore.getState().redo();

    expect(useProjectStore.getState().project.clips).toHaveLength(0);
    expect(selection()).toEqual([]);
    expect(primary()).toBeNull();
  });

  it('quitar una pista deja la selección sin los clips de esa pista', () => {
    addClip({ id: 'a', trackId: VIDEO_TRACK });
    addClip({ id: 'b', trackId: AUDIO_TRACK, start: 20 });

    useProjectStore.getState().selectClip('a');
    useProjectStore.getState().selectClip('b', { additive: true });
    useProjectStore.getState().removeTrack(VIDEO_TRACK);

    expect(selection()).toEqual(['b']);
    expect(primary()).toBe('b');
  });
});

/* ------------------------------------------------------------------ */
/* F6 — pure helpers                                                  */
/* ------------------------------------------------------------------ */

describe('F6 — los helpers puros de la selección', () => {
  it('selectRangeOnTrack sólo devuelve clips de la pista del ancla', () => {
    const clips: Clip[] = [
      makeClip({ id: 'a', trackId: VIDEO_TRACK, start: 0 }),
      makeClip({ id: 'b', trackId: VIDEO_TRACK, start: 10 }),
      makeClip({ id: 'c', trackId: VIDEO_TRACK_2, start: 5 }),
    ];

    expect(selectRangeOnTrack(clips, 'a', 'b')).toEqual(['a', 'b']);
    // Another track: the range is empty.
    expect(selectRangeOnTrack(clips, 'a', 'c')).toEqual([]);
    // Unknown ids: the range is empty (never a dangling id).
    expect(selectRangeOnTrack(clips, 'a', 'zzz')).toEqual([]);
  });

  it('orderClipsByTimeline ordena por pista y luego por tiempo', () => {
    const tracks: Track[] = [
      { id: 't2', name: 'T2', type: 'video', isMuted: false, isLocked: false, isVisible: true },
      { id: 't1', name: 'T1', type: 'audio', isMuted: false, isLocked: false, isVisible: true },
    ];
    const clips: Clip[] = [
      makeClip({ id: 'x', trackId: 't1', start: 0 }),
      makeClip({ id: 'y', trackId: 't2', start: 10 }),
      makeClip({ id: 'z', trackId: 't2', start: 2 }),
    ];

    expect(orderClipsByTimeline(clips, tracks).map((c) => c.id)).toEqual(['z', 'y', 'x']);
  });

  it('getBatchOperationAvailability explica por qué una operación no se puede aplicar', () => {
    const video = makeClip({ id: 'v', type: 'video' });
    const text = makeClip({ id: 't', type: 'text', trackId: TEXT_TRACK });
    const audio = makeClip({ id: 'a', type: 'audio', trackId: AUDIO_TRACK });

    // A homogeneous selection: everything is available.
    expect(getBatchOperationAvailability([video, video], 'speed').enabled).toBe(true);
    expect(getBatchOperationAvailability([video, video], 'volume').enabled).toBe(true);
    expect(getBatchOperationAvailability([video, video], 'opacity').enabled).toBe(true);

    // The speed of a TEXT clip does not make sense: it is refused WITH A
    // REASON (it is never applied to "some of the clips").
    const speed = getBatchOperationAvailability([video, text], 'speed');
    expect(speed.enabled).toBe(false);
    expect(speed.reason).toMatch(/velocidad/i);
    expect(speed.reason).toMatch(/texto/i);

    // The volume of a text clip does not make sense either (it has no audio).
    const volume = getBatchOperationAvailability([video, text], 'volume');
    expect(volume.enabled).toBe(false);
    expect(volume.reason).toBeTruthy();

    // The opacity of an audio clip does not make sense (it has no image).
    const opacity = getBatchOperationAvailability([video, audio], 'opacity');
    expect(opacity.enabled).toBe(false);
    expect(opacity.reason).toMatch(/opacidad/i);

    // An empty selection has nothing to edit.
    expect(getBatchOperationAvailability([], 'volume').enabled).toBe(false);
  });

  it('selectClipIdsInRect (rectángulo de arrastre) coje los clips que TOCA', () => {    const tracks: Track[] = [
      { id: VIDEO_TRACK, name: 'V1', type: 'video', isMuted: false, isLocked: false, isVisible: true },
      { id: AUDIO_TRACK, name: 'A1', type: 'audio', isMuted: false, isLocked: false, isVisible: true },
    ];
    const zoom = 60;
    const clips: Clip[] = [
      makeClip({ id: 'a', trackId: VIDEO_TRACK, start: 0, duration: 5 }),
      makeClip({ id: 'b', trackId: VIDEO_TRACK, start: 10, duration: 5 }),
      makeClip({ id: 'c', trackId: AUDIO_TRACK, start: 2, duration: 5 }),
    ];

    // A band over the first lane that touches the clip "a" only.
    const laneBand = {
      left: 0,
      top: 0,
      right: 200,
      bottom: TRACK_LANE_HEIGHT,
    };
    expect(selectClipIdsInRect(clips, tracks, zoom, laneBand)).toEqual(['a']);

    // A band that covers the audio lane never selects the clips of the video
    // lane (the band never crosses tracks).
    const audioBand = {
      left: 0,
      top: TRACK_LANE_HEIGHT,
      right: 400,
      bottom: TRACK_LANE_HEIGHT * 2,
    };
    expect(selectClipIdsInRect(clips, tracks, zoom, audioBand)).toEqual(['c']);

    // A band over an empty area selects nothing.
    expect(
      selectClipIdsInRect(clips, tracks, zoom, { left: 5000, top: 0, right: 6000, bottom: 50 })
    ).toEqual([]);
  });

  it('mergeSelection (Ctrl + arrastre) une el rectángulo a la selección sin repetir ids', () => {
    expect(mergeSelection(['a'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    // A clip that is already selected is not duplicated.
    expect(mergeSelection(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(mergeSelection([], ['a'])).toEqual(['a']);
  });
});

/* ------------------------------------------------------------------ */
/* F6 — the DOM wiring (asserted on the source)                       */
/* ------------------------------------------------------------------ */

describe('F6 — el cableado de la UI (multi-selección)', () => {
  const clipItemSource = readFileSync(
    new URL('../components/timeline/ClipItem.tsx', import.meta.url),
    'utf8'
  );
  const timelineSource = readFileSync(
    new URL('../components/timeline/Timeline.tsx', import.meta.url),
    'utf8'
  );
  const inspectorSource = readFileSync(
    new URL('../components/inspector/ClipInspector.tsx', import.meta.url),
    'utf8'
  );

  it('el clip usa el patrón de botón conmutador (aria-pressed), NO aria-selected', () => {
    expect(clipItemSource).toContain('aria-pressed={isInSelection}');
    // `aria-selected` is NOT valid on role="button": the old misuse is gone.
    expect(clipItemSource).not.toMatch(/aria-selected\s*=/);
  });

  it('el clip distingue la selección del clip primario', () => {
    expect(clipItemSource).toContain('data-selected={isInSelection');
    expect(clipItemSource).toContain('data-primary={isSelected');
    expect(clipItemSource).toContain('data-clip-id={clip.id}');
  });

  it('el clip honours Ctrl/Cmd (alternar) and Shift (rango) en el clic', () => {
    expect(clipItemSource).toContain('const additive = e.ctrlKey || e.metaKey;');
    expect(clipItemSource).toContain('const range = e.shiftKey;');
    expect(clipItemSource).toContain('selectClip(clip.id, { additive, range })');
  });

  it('el clip ofrece la alternativa táctil del Ctrl (pulsación larga)', () => {
    expect(clipItemSource).toContain('LONG_PRESS_MS');
    expect(clipItemSource).toContain("selectClip(clip.id, { additive: true })");
  });

  it('el clic que sigue a un arrastre o a una pulsación larga NO colapsa la selección', () => {
    const start = clipItemSource.indexOf('const handleClick');
    expect(start).toBeGreaterThan(-1);
    const clickHandler = clipItemSource.slice(start, start + 1200);
    expect(clickHandler).toContain('dragMovedRef.current');
    expect(clickHandler).toContain('longPressFiredRef.current');
  });

  it('el timeline tiene el rectángulo de arrastre y lo pinta de forma IMPERATIVA', () => {
    expect(timelineSource).toContain('data-testid="rubber-band"');
    // The band is painted with direct style writes: the React tree is NOT
    // re-rendered on every mouse move.
    expect(timelineSource).toContain('band.style.transform');
    expect(timelineSource).toContain('requestAnimationFrame(paintBand)');
    expect(timelineSource).not.toMatch(/const\s*\[\s*band[A-Za-z]*\s*,\s*setBand/);
  });

  it('el timeline ofrece "Seleccionar todo" y el atajo Ctrl+A', () => {
    expect(timelineSource).toContain('data-testid="select-all-clips"');
    expect(timelineSource).toContain('Seleccionar todo');
    expect(timelineSource).toContain('selectAllClips');
  });

  it('el Inspector muestra "N clips seleccionados" y el motivo de las operaciones bloqueadas', () => {
    expect(inspectorSource).toContain('clips seleccionados');
    expect(inspectorSource).toContain('data-testid="inspector-multi-selection-count"');
    expect(inspectorSource).toContain('data-testid="batch-speed-disabled-reason"');
    expect(inspectorSource).toContain('getBatchOperationAvailability');
    // The batch edits go through the batch actions of the store.
    expect(inspectorSource).toContain('setSelectedClipsVolume');
    expect(inspectorSource).toContain('setSelectedClipsOpacity');
    expect(inspectorSource).toContain('setSelectedClipsSpeed');
    expect(inspectorSource).toContain('setSelectedClipsMuted');
    expect(inspectorSource).toContain('deleteSelectedClips');
  });
});
