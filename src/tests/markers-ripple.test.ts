/**
 * Ronda "Terminar un proyecto" (P0-1 + P0-6 + P0-11 del audit A6):
 *
 * 1. Ripple delete (`rippleDeleteClip` + `Mayús+Supr`): borra el clip y cierra
 *    el hueco desplazando los clips posteriores de la MISMA pista, en UN solo
 *    paso deshacible, sin romper los fundidos de cruce deliberados.
 * 2. Marcadores (`M`): puntos nombrados en la regla de tiempo que sobreviven
 *    al guardado, participan en el historial y sirven para fijar el rango de
 *    exportación (vía `pendingExportRange`, que el diálogo de exportación lee).
 * 3. Ir al timecode (`Ctrl+G`) + recortar al cabezal (`Q`/`W`).
 *
 * Cada suite ejercita el código REAL de producción (helpers puros + acciones
 * del store + presencia del cableado en los ficheros que sí son de esta
 * worker). Las suites marcadas [FAILS-WITHOUT-FIX] solo existen tras el cambio.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  useProjectStore,
  planRippleDelete,
  resolveDeleteKind,
} from '../store/useProjectStore';
import {
  MAX_MARKERS,
  MARKER_COLORS,
  defaultMarkerName,
  markerPairToRange,
  parseTimecodeInput,
  sanitizeMarkers,
} from '../core/utils/markers';
import { masterClock } from '../core/engine/MasterClock';
import type { Clip, TimelineMarker } from '../types/project';

/* ------------------------------------------------------------------ */
/* Mocks: IndexedDB en memoria + OPFS falso (mismo patrón hermético    */
/* que la suite R1: la persistencia nunca toca un backend real)         */
/* ------------------------------------------------------------------ */

const h = vi.hoisted(() => {
  const memory = new Map<string, unknown>();
  return {
    memory,
    getSpy: vi.fn(async (key: string) => memory.get(key)),
    setSpy: vi.fn(async (key: string, value: unknown) => {
      memory.set(key, value);
    }),
    delSpy: vi.fn(async (key: string) => {
      memory.delete(key);
    }),
    deleteMediaFiles: vi.fn(async (_items: unknown, _mode: unknown) => undefined),
    saveMediaToOPFS: vi.fn(async (mediaId: string, file: File) => `${mediaId}_${file.name}`),
    getMediaFromOPFS: vi.fn(async (_path: string): Promise<File | null> => null),
    deleteMediaFilesFromOPFS: vi.fn(async (_paths: string[]) => undefined),
  };
});

vi.mock('idb-keyval', () => ({
  get: (key: string) => h.getSpy(key),
  set: (key: string, value: unknown) => h.setSpy(key, value),
  del: (key: string) => h.delSpy(key),
  keys: async () => Array.from(h.memory.keys()),
  clear: async () => {
    h.memory.clear();
  },
}));

vi.mock('../core/storage/opfsStorage', () => ({
  saveMediaToOPFS: (mediaId: string, file: File) => h.saveMediaToOPFS(mediaId, file),
  getMediaFromOPFS: (path: string) => h.getMediaFromOPFS(path),
  deleteMediaFilesFromOPFS: (paths: string[]) => h.deleteMediaFilesFromOPFS(paths),
}));

/* ------------------------------------------------------------------ */
/* Ayudas                                                              */
/* ------------------------------------------------------------------ */

const VIDEO_TRACK = 'track_video_1';
const AUDIO_TRACK = 'track_audio_1';

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
    sourceDuration: 60,
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

function trackClips(trackId: string): Clip[] {
  return useProjectStore
    .getState()
    .project.clips.filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start);
}

const SRC = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf-8');

beforeEach(() => {
  useProjectStore.getState().resetProject();
  useProjectStore.getState().clearLastError();
  masterClock.seek(0);
  useProjectStore.getState().setCurrentTime(0);
});

/* ------------------------------------------------------------------ */
/* 1. Ripple delete puro [FAILS-WITHOUT-FIX]                            */
/* ------------------------------------------------------------------ */

describe('1. planRippleDelete desplaza solo la pista del clip borrado', () => {
  it('los clips posteriores de la misma pista se adelantan la duración borrada', () => {
    const clips = [
      makeClip({ id: 'a', start: 0, duration: 4 }),
      makeClip({ id: 'b', start: 4, duration: 3 }),
      makeClip({ id: 'c', start: 7, duration: 5 }),
    ];
    const plan = planRippleDelete(clips, 'b');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.removedId).toBe('b');
    // `c` se adelanta 3 s: de 7 a 4 (toca a `a`, sin hueco ni solape).
    expect(plan.moved).toEqual([{ id: 'c', start: 4 }]);
    expect(plan.shift).toBe(3);
  });

  it('las demás pistas no se mueven', () => {
    const clips = [
      makeClip({ id: 'a', start: 0, duration: 4 }),
      makeClip({ id: 'b', start: 4, duration: 3 }),
      makeClip({ id: 'otro', trackId: AUDIO_TRACK, type: 'audio', start: 4, duration: 3 }),
    ];
    const plan = planRippleDelete(clips, 'b');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.moved).toEqual([]);
  });

  it('conserva los huecos previos (solo cierra el del clip borrado)', () => {
    const clips = [
      makeClip({ id: 'a', start: 0, duration: 4 }),
      makeClip({ id: 'b', start: 4, duration: 3 }),
      // Hueco deliberado de 2 s entre `b` y `c`.
      makeClip({ id: 'c', start: 9, duration: 5 }),
    ];
    const plan = planRippleDelete(clips, 'b');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // `c` pasa de 9 a 6: el hueco de 2 s sigue ahí.
    expect(plan.moved).toEqual([{ id: 'c', start: 6 }]);
  });

  it('un id desconocido se rechaza con motivo', () => {
    const plan = planRippleDelete([makeClip({ id: 'a' })], 'fantasma');
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain('No se encontró');
  });
});

describe('1b. planRippleDelete preserva los fundidos de cruce deliberados', () => {
  /** Par B-C fundido con 1 s de solape deliberado (B sale, C entra). */
  function crossfadedPair(): Clip[] {
    return [
      makeClip({ id: 'a', start: 0, duration: 4 }),
      makeClip({
        id: 'b',
        start: 4,
        duration: 4,
        transition: {
          fadeInType: 'none',
          fadeInDuration: 0,
          fadeOutType: 'none',
          fadeOutDuration: 0,
          crossfadeOutDuration: 1,
        },
      }),
      makeClip({
        id: 'c',
        start: 7,
        duration: 4,
        transition: {
          fadeInType: 'none',
          fadeInDuration: 0,
          fadeOutType: 'none',
          fadeOutDuration: 0,
          crossfadeInDuration: 1,
        },
      }),
    ];
  }

  it('borrar ANTES del par mueve a ambos juntos (el solape de 1 s sigue intacto)', () => {
    const plan = planRippleDelete(crossfadedPair(), 'a');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.moved).toEqual([
      { id: 'b', start: 0 },
      { id: 'c', start: 3 },
    ]);
    // El desplazamiento conserva el desplazamiento relativo: el solape
    // deliberado de 1 s entre `b` y `c` no se destruye.
    const movedB = 0;
    const movedC = 3;
    expect(movedC - movedB).toBe(3);
  });

  it('borrar la mitad saliente limpia el marcador huérfano del superviviente', () => {
    const plan = planRippleDelete(crossfadedPair(), 'b');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // `c` ocupaba [7, 11): su parte exclusiva empieza en 8, así que el hueco
    // real que deja `b` es 3 s y `c` cae en 4 (tocando a `a`, sin solape).
    expect(plan.moved).toEqual([{ id: 'c', start: 4 }]);
    // El marcador de entrada de `c` apuntaba a `b`: hay que limpiarlo para no
    // dejar un fundido fantasma.
    expect(plan.clearedCrossfade).toEqual([{ id: 'c', side: 'in' }]);
  });

  it('borrar la mitad entrante limpia el marcador de salida del anterior', () => {
    const plan = planRippleDelete(crossfadedPair(), 'c');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.moved).toEqual([]);
    expect(plan.clearedCrossfade).toEqual([{ id: 'b', side: 'out' }]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. rippleDeleteClip del store [FAILS-WITHOUT-FIX]                    */
/* ------------------------------------------------------------------ */

describe('2. rippleDeleteClip borra y cierra el hueco en un solo undo', () => {
  it('borra el clip, adelanta la pista y recalcula la duración', () => {
    addClip({ id: 'a', start: 0, duration: 4 });
    addClip({ id: 'b', start: 4, duration: 3 });
    addClip({ id: 'c', start: 7, duration: 5 });
    useProjectStore.getState().selectClip('b');

    const result = useProjectStore.getState().rippleDeleteClip('b');
    expect(result.ok).toBe(true);

    const clips = trackClips(VIDEO_TRACK);
    expect(clips.map((c) => c.id)).toEqual(['a', 'c']);
    expect(clips.find((c) => c.id === 'c')?.start).toBe(4);
    // Duración = ceil del alcance real (4 + 5 = 9), sin cola negra.
    expect(useProjectStore.getState().project.duration).toBe(9);
    // El clip borrado sale de la selección (sin ids colgando).
    expect(useProjectStore.getState().selectedClipIds).not.toContain('b');
  });

  it('es UN solo paso deshacible (un Ctrl+Z lo devuelve todo)', () => {
    addClip({ id: 'a', start: 0, duration: 4 });
    addClip({ id: 'b', start: 4, duration: 3 });
    addClip({ id: 'c', start: 7, duration: 5 });
    const depthBefore = useProjectStore.getState().past.length;

    useProjectStore.getState().rippleDeleteClip('b');
    expect(useProjectStore.getState().past.length).toBe(depthBefore + 1);

    useProjectStore.getState().undo();
    const clips = trackClips(VIDEO_TRACK);
    expect(clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(clips.find((c) => c.id === 'c')?.start).toBe(7);
  });

  it('en pista bloqueada se niega con motivo y sin tocar el historial', () => {
    addClip({ id: 'a', start: 0, duration: 4 });
    addClip({ id: 'b', start: 4, duration: 3 });
    const track = useProjectStore.getState().project.tracks.find((t) => t.id === VIDEO_TRACK);
    expect(track).toBeDefined();
    useProjectStore.getState().toggleTrackLock(VIDEO_TRACK);
    const depthAfterLock = useProjectStore.getState().past.length;

    const result = useProjectStore.getState().rippleDeleteClip('b');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('bloqueada');
    expect(trackClips(VIDEO_TRACK)).toHaveLength(2);
    expect(useProjectStore.getState().past.length).toBe(depthAfterLock);
    expect(useProjectStore.getState().lastError).toContain('bloqueada');
  });
});

/* ------------------------------------------------------------------ */
/* 3. Marcadores: puras [FAILS-WITHOUT-FIX]                             */
/* ------------------------------------------------------------------ */

describe('3. sanitizeMarkers sanea la entrada del proyecto importado', () => {
  it('ordena por tiempo, cuantiza al fotograma y nombra los vacíos', () => {
    const { markers } = sanitizeMarkers(
      [
        { id: 'b', time: 7.0001, name: '' },
        { id: 'a', time: 2, name: 'Estribillo' },
      ],
      30
    );
    expect(markers.map((m) => m.id)).toEqual(['a', 'b']);
    expect(markers[0].name).toBe('Estribillo');
    expect(markers[1].name).toBe('Marcador 2');
    expect(markers[1].time).toBeCloseTo(7, 5);
  });

  it('descarta tiempos no finitos y colores no válidos (con avisos)', () => {
    const { markers, warnings } = sanitizeMarkers(
      [
        { id: 'ok', time: 3, name: 'Vale', color: '#f59e0b' },
        { id: 'mal-tiempo', time: Number.NaN, name: 'Roto' },
        { id: 'mal-color', time: 5, name: 'Color', color: 'rojo' },
      ],
      30
    );
    expect(markers.map((m) => m.id)).toEqual(['ok', 'mal-color']);
    expect(markers.find((m) => m.id === 'mal-color')?.color).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('renombra ids duplicados y recorta al máximo', () => {
    const raw = Array.from({ length: MAX_MARKERS + 5 }, (_, i) => ({
      id: 'mismo',
      time: i,
      name: `M${i}`,
    }));
    const { markers, warnings } = sanitizeMarkers(raw, 30);
    expect(markers).toHaveLength(MAX_MARKERS);
    expect(new Set(markers.map((m) => m.id)).size).toBe(MAX_MARKERS);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('una entrada que no es lista se descarta sin romper', () => {
    expect(sanitizeMarkers(undefined, 30).markers).toEqual([]);
    expect(sanitizeMarkers('hola', 30).markers).toEqual([]);
  });
});

describe('3b. markerPairToRange ordena el par para el rango de exportación', () => {
  it('el par (fin, inicio) produce { start < end }', () => {
    const a: TimelineMarker = { id: 'a', time: 9, name: 'Fin' };
    const b: TimelineMarker = { id: 'b', time: 2, name: 'Inicio' };
    expect(markerPairToRange(a, b)).toEqual({ start: 2, end: 9 });
  });

  it('un par con el mismo tiempo no es un rango válido', () => {
    const a: TimelineMarker = { id: 'a', time: 4, name: 'A' };
    expect(markerPairToRange(a, { ...a, id: 'b' })).toBeNull();
  });
});

describe('3c. defaultMarkerName y paleta', () => {
  it('nombra en español y la paleta trae colores hex válidos', () => {
    expect(defaultMarkerName(1)).toBe('Marcador 1');
    expect(MARKER_COLORS.length).toBeGreaterThan(0);
    for (const color of MARKER_COLORS) {
      expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. Marcadores: acciones del store [FAILS-WITHOUT-FIX]                */
/* ------------------------------------------------------------------ */

describe('4. addMarker / removeMarker / renameMarker / jumpToMarker', () => {
  it('addMarker crea un marcador en el cabezal con nombre español', () => {
    useProjectStore.getState().setCurrentTime(5);
    const marker = useProjectStore.getState().addMarker();
    expect(marker).not.toBeNull();
    expect(marker?.time).toBe(5);
    expect(marker?.name).toBe('Marcador 1');
    expect(useProjectStore.getState().project.markers).toHaveLength(1);
  });

  it('addMarker cuantiza al fotograma del proyecto', () => {
    useProjectStore.getState().setCurrentTime(5.0123);
    const marker = useProjectStore.getState().addMarker();
    // A 30 fps el tiempo cae en un borde de fotograma exacto.
    expect(marker?.time).toBeCloseTo(Math.round(5.0123 * 30) / 30, 5);
  });

  it('los marcadores son deshacibles (undo los quita, redo los devuelve)', () => {
    useProjectStore.getState().addMarker(3);
    expect(useProjectStore.getState().project.markers).toHaveLength(1);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.markers ?? []).toHaveLength(0);
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.markers).toHaveLength(1);
  });

  it('removeMarker borra y es deshacible', () => {
    const marker = useProjectStore.getState().addMarker(3);
    expect(useProjectStore.getState().removeMarker(marker?.id ?? 'x')).toBe(true);
    expect(useProjectStore.getState().project.markers ?? []).toHaveLength(0);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.markers).toHaveLength(1);
  });

  it('removeMarker con id desconocido devuelve false', () => {
    expect(useProjectStore.getState().removeMarker('fantasma')).toBe(false);
  });

  it('renameMarker renombra y rechaza el nombre vacío', () => {
    const marker = useProjectStore.getState().addMarker(3);
    expect(useProjectStore.getState().renameMarker(marker?.id ?? 'x', '  Estribillo  ')).toBe(true);
    expect(useProjectStore.getState().project.markers?.[0].name).toBe('Estribillo');
    expect(useProjectStore.getState().renameMarker(marker?.id ?? 'x', '   ')).toBe(false);
    expect(useProjectStore.getState().project.markers?.[0].name).toBe('Estribillo');
  });

  it('jumpToMarker mueve el cabezal al marcador', () => {
    const marker = useProjectStore.getState().addMarker(7.5);
    useProjectStore.getState().setCurrentTime(0);
    expect(useProjectStore.getState().jumpToMarker(marker?.id ?? 'x')).toBe(true);
    expect(useProjectStore.getState().currentTime).toBeCloseTo(7.5, 5);
  });

  it('jumpToMarker con id desconocido devuelve false sin mover el cabezal', () => {
    useProjectStore.getState().setCurrentTime(1);
    expect(useProjectStore.getState().jumpToMarker('fantasma')).toBe(false);
    expect(useProjectStore.getState().currentTime).toBe(1);
  });

  it('loadProject conserva los marcadores del proyecto cargado', () => {
    useProjectStore.getState().addMarker(3);
    const saved = useProjectStore.getState().project;
    useProjectStore.getState().resetProject();
    expect(useProjectStore.getState().project.markers ?? []).toHaveLength(0);
    useProjectStore.getState().loadProject(JSON.parse(JSON.stringify(saved)));
    expect(useProjectStore.getState().project.markers).toHaveLength(1);
  });
});

describe('4b. pendingExportRange: el puente marcador → exportación', () => {
  it('applyMarkerPairToExportRange fija el rango ordenado entre dos marcadores', () => {
    const a = useProjectStore.getState().addMarker(9);
    const b = useProjectStore.getState().addMarker(2);
    expect(
      useProjectStore.getState().applyMarkerPairToExportRange(a?.id ?? 'x', b?.id ?? 'y')
    ).toBe(true);
    expect(useProjectStore.getState().pendingExportRange).toEqual({ start: 2, end: 9 });
  });

  it('setExportRangeEndpoint fija entrada y salida por separado', () => {
    useProjectStore.getState().setExportRangeEndpoint('start', 4);
    useProjectStore.getState().setExportRangeEndpoint('end', 6);
    expect(useProjectStore.getState().pendingExportRange).toEqual({ start: 4, end: 6 });
    useProjectStore.getState().clearPendingExportRange();
    expect(useProjectStore.getState().pendingExportRange).toEqual({ start: null, end: null });
  });
});

/* ------------------------------------------------------------------ */
/* 5. Ir al timecode + recortar al cabezal [FAILS-WITHOUT-FIX]          */
/* ------------------------------------------------------------------ */

describe('5. parseTimecodeInput entiende el campo numérico', () => {
  it('HH:MM:SS:FF a 30 fps', () => {
    expect(parseTimecodeInput('00:00:05:00', 30)).toBeCloseTo(5, 5);
    expect(parseTimecodeInput('00:01:00:15', 30)).toBeCloseTo(60.5, 5);
  });

  it('segundos sueltos con punto o coma', () => {
    expect(parseTimecodeInput('75.5', 30)).toBeCloseTo(75.5, 5);
    expect(parseTimecodeInput('75,5', 30)).toBeCloseTo(75.5, 5);
  });

  it('MM:SS y HH:MM:SS', () => {
    expect(parseTimecodeInput('01:30', 30)).toBeCloseTo(90, 5);
    expect(parseTimecodeInput('00:01:30', 30)).toBeCloseTo(90, 5);
  });

  it('lo no válido devuelve null (nunca NaN al estado)', () => {
    expect(parseTimecodeInput('', 30)).toBeNull();
    expect(parseTimecodeInput('hola', 30)).toBeNull();
    expect(parseTimecodeInput('00:00:61:00', 30)).toBeNull();
    expect(parseTimecodeInput('00:00:05:30', 30)).toBeNull();
    expect(parseTimecodeInput('-5', 30)).toBeNull();
  });
});

describe('5b. goToTimecode mueve el cabezal', () => {
  it('un tiempo válido mueve el cabezal', () => {
    expect(useProjectStore.getState().goToTimecode(12.5)).toBe(true);
    expect(useProjectStore.getState().currentTime).toBeCloseTo(12.5, 5);
  });

  it('un tiempo no finito se rechaza con motivo', () => {
    expect(useProjectStore.getState().goToTimecode(Number.NaN)).toBe(false);
    expect(useProjectStore.getState().lastError).toContain('timecode');
  });
});

describe('5c. trimClipHeadToPlayhead (Q) y trimClipTailToPlayhead (W)', () => {
  it('Q recorta el inicio al cabezal manteniendo la ventana de origen', () => {
    addClip({ id: 'a', start: 2, duration: 8, sourceStart: 10, sourceDuration: 60 });
    useProjectStore.getState().setCurrentTime(5);

    const result = useProjectStore.getState().trimClipHeadToPlayhead('a');
    expect(result.ok).toBe(true);
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'a');
    expect(clip?.start).toBeCloseTo(5, 5);
    expect(clip?.duration).toBeCloseTo(5, 5);
    // La ventana de origen avanza con el recorte (3 s a velocidad 1).
    expect(clip?.sourceStart).toBeCloseTo(13, 5);
  });

  it('W recorta el final al cabezal manteniendo el inicio y el origen', () => {
    addClip({ id: 'a', start: 2, duration: 8, sourceStart: 10, sourceDuration: 60 });
    useProjectStore.getState().setCurrentTime(6);

    const result = useProjectStore.getState().trimClipTailToPlayhead('a');
    expect(result.ok).toBe(true);
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'a');
    expect(clip?.start).toBeCloseTo(2, 5);
    expect(clip?.duration).toBeCloseTo(4, 5);
    expect(clip?.sourceStart).toBeCloseTo(10, 5);
  });

  it('ambos son UN solo paso deshacible', () => {
    addClip({ id: 'a', start: 2, duration: 8, sourceStart: 10, sourceDuration: 60 });
    const depthBefore = useProjectStore.getState().past.length;
    useProjectStore.getState().setCurrentTime(5);
    useProjectStore.getState().trimClipHeadToPlayhead('a');
    expect(useProjectStore.getState().past.length).toBe(depthBefore + 1);
    useProjectStore.getState().undo();
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'a');
    expect(clip?.start).toBeCloseTo(2, 5);
    expect(clip?.duration).toBeCloseTo(8, 5);
  });

  it('con el cabezal fuera del clip se niega con motivo (sin cambios)', () => {
    addClip({ id: 'a', start: 2, duration: 8, sourceStart: 10, sourceDuration: 60 });
    useProjectStore.getState().setCurrentTime(20);
    const head = useProjectStore.getState().trimClipHeadToPlayhead('a');
    expect(head.ok).toBe(false);
    const tail = useProjectStore.getState().trimClipTailToPlayhead('a');
    expect(tail.ok).toBe(false);
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === 'a');
    expect(clip?.start).toBeCloseTo(2, 5);
    expect(clip?.duration).toBeCloseTo(8, 5);
  });

  it('en pista bloqueada se niega con motivo', () => {
    addClip({ id: 'a', start: 2, duration: 8, sourceStart: 10, sourceDuration: 60 });
    useProjectStore.getState().toggleTrackLock(VIDEO_TRACK);
    useProjectStore.getState().setCurrentTime(5);
    const result = useProjectStore.getState().trimClipHeadToPlayhead('a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('bloqueada');
  });
});

/* ------------------------------------------------------------------ */
/* 6. Atajos y cableado UI (guardias de fuente)                         */
/* ------------------------------------------------------------------ */

describe('6. los atajos nuevos están cableados donde vive el borrado', () => {
  it('resolveDeleteKind distingue Mayús+Supr (ripple) del borrado simple', () => {
    expect(resolveDeleteKind({ key: 'Delete', shiftKey: true })).toBe('ripple');
    expect(resolveDeleteKind({ key: 'Backspace', shiftKey: true })).toBe('ripple');
    expect(resolveDeleteKind({ key: 'Delete', shiftKey: false })).toBe('plain');
    expect(resolveDeleteKind({ key: 'Backspace', shiftKey: false })).toBe('plain');
    expect(resolveDeleteKind({ key: 'a', shiftKey: true })).toBeNull();
  });

  it('Timeline.tsx maneja Mayús+Supr, M, Ctrl+G, Q y W', () => {
    const source = SRC('components/timeline/Timeline.tsx');
    expect(source).toContain('rippleDeleteClip');
    expect(source).toContain('addMarker');
    expect(source).toContain("'g'");
    expect(source).toContain("'q'");
    expect(source).toContain("'w'");
    expect(source).toContain('stopImmediatePropagation');
  });

  it('TimelineToolbar.tsx expone Cerrar hueco, timecode y marcadores en español', () => {
    const source = SRC('components/timeline/TimelineToolbar.tsx');
    expect(source).toContain('Cerrar hueco');
    expect(source).toContain('goto-timecode');
    expect(source).toContain('Marcadores');
    expect(source).toContain('Mayús+Supr');
  });

  it('TimeRuler.tsx pinta los marcadores sin cambiar la geometría', () => {
    const source = SRC('components/timeline/TimeRuler.tsx');
    expect(source).toContain('timeline-markers');
    // La capa es absoluta dentro de la regla (h-7 intacto, sin scroll nuevo).
    expect(source).toContain('absolute');
    expect(source).toMatch(/h-7/);
  });

  it('ClipInspector.tsx ofrece Cerrar hueco y recortar al cabezal (Q/W)', () => {
    const source = SRC('components/inspector/ClipInspector.tsx');
    // Caso oración (copy table): «Eliminar y cerrar hueco».
    expect(source.toLowerCase()).toContain('cerrar hueco');
    expect(source).toContain('trimClipHeadToPlayhead');
    expect(source).toContain('trimClipTailToPlayhead');
    expect(source).toContain('Mayús+Supr');
  });
});
