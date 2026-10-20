/**
 * Regression tests for the F7 (clipboard) and F10 (export presets + export
 * range) features.
 *
 * F7  internal clipboard: `copyClips` / `pasteClips` / `duplicateClips` live
 *     in the store, honour the overlap policy (F1) and the track type
 *     compatibility (S-12/B-04), and are wired to Ctrl+C / Ctrl+V / Ctrl+D.
 * F10 export presets (one click sets resolution + fps + bitrate + aspect
 *     ratio, the vertical one produces a REAL 1080×1920 file) and the export
 *     range (in/out markers rendered by the exporter).
 *
 * Every test asserts the REAL production behaviour: no re-implementation of
 * the logic under test and no tautological asserts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  useProjectStore,
  deepCopyClip,
  hasInternalOverlap,
  DEFAULT_OVERLAP_POLICY,
} from '../store/useProjectStore';
import {
  EXPORT_PRESETS,
  buildRangeExportClips,
  computeExportDimensions,
  findActivePreset,
  formatExportRange,
  formatExportTimecode,
  isExportRangeValid,
  resolveExportRange,
} from '../components/export/ExportModal';
import { isTextEntryTarget, resolveClipboardShortcut } from '../components/layout/MainLayout';
import { Clip } from '../types/project';

/* ------------------------------------------------------------------ */
/* Mocks: in-memory IndexedDB + a fake OPFS                            */
/* ------------------------------------------------------------------ */

const h = vi.hoisted(() => {
  const memory = new Map<string, any>();
  return {
    memory,
    getSpy: vi.fn(async (key: string) => memory.get(key)),
    setSpy: vi.fn(async (key: string, value: any) => {
      memory.set(key, value);
    }),
    delSpy: vi.fn(async (key: string) => {
      memory.delete(key);
    }),
    deleteMediaFiles: vi.fn(async (_items: any, _mode: any) => undefined),
    saveMediaToOPFS: vi.fn(async (mediaId: string, file: File) => `${mediaId}_${file.name}`),
    getMediaFromOPFS: vi.fn(async (_path: string): Promise<File | null> => null),
    deleteMediaFilesFromOPFS: vi.fn(async (_paths: string[]) => undefined),
  };
});

vi.mock('idb-keyval', () => ({
  get: (key: string) => h.getSpy(key),
  set: (key: string, value: any) => h.setSpy(key, value),
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
  deleteMediaFromOPFS: async () => undefined,
  isOPFSSupported: async () => false,
  isUsableMediaFile: (file: any) => !!file && typeof file.size === 'number' && file.size > 0,
}));

vi.mock('../core/storage/projectStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/storage/projectStorage')>();
  return {
    ...actual,
    deleteMediaFiles: (items: any, mode: any) => h.deleteMediaFiles(items, mode),
  };
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const VIDEO_TRACK = 'track_video_1';
const VIDEO_TRACK_2 = 'track_video_2';
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

/** Adds a clip to the timeline (directly, without touching the media pool). */
function addClip(clip: Clip): string {
  useProjectStore.getState().addClip(clip);
  return clip.id;
}

beforeEach(() => {
  useProjectStore.getState().resetProject();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* F7 — the internal clipboard                                         */
/* ------------------------------------------------------------------ */

describe('F7 — copiar, pegar y duplicar clips', () => {
  it('copyClips guarda una COPIA PROFUNDA: editar el original no toca el portapapeles', () => {
    const store = useProjectStore.getState();
    const clipId = addClip(makeClip({ id: 'clip_a', name: 'Original' }));

    expect(store.copyClips([clipId])).toBe(1);
    expect(useProjectStore.getState().clipboard).toHaveLength(1);

    // The original is edited AFTER the copy.
    useProjectStore.getState().updateClip(clipId, { name: 'Renombrado', duration: 4 });

    const entry = useProjectStore.getState().clipboard[0];
    expect(entry.clip.name).toBe('Original');
    expect(entry.clip.duration).toBe(10);
    // And it is NOT the live object (mutating it cannot break the timeline).
    expect(entry.clip).not.toBe(useProjectStore.getState().project.clips[0]);
  });

  it('copyClips de un id inexistente no copia nada', () => {
    expect(useProjectStore.getState().copyClips(['clip_inexistente'])).toBe(0);
    expect(useProjectStore.getState().clipboard).toHaveLength(0);
  });

  it('pasteClips crea clips con ids NUEVOS y devuelve sus ids', () => {
    const store = useProjectStore.getState();
    const clipId = addClip(makeClip({ id: 'clip_a' }));
    store.copyClips([clipId]);

    const pasted = useProjectStore.getState().pasteClips(VIDEO_TRACK, 20);

    expect(pasted).toHaveLength(1);
    expect(pasted[0]).not.toBe(clipId);
    const clips = useProjectStore.getState().project.clips;
    expect(clips).toHaveLength(2);
    expect(clips.find((c) => c.id === pasted[0])!.start).toBe(20);
    // The ids of the project are unique.
    expect(new Set(clips.map((c) => c.id)).size).toBe(clips.length);
  });

  it('pasteClips conserva el medio, el volumen y la posición relativa del grupo', () => {
    const store = useProjectStore.getState();
    const first = addClip(makeClip({ id: 'clip_a', start: 0, duration: 5, volume: 0.5 }));
    const second = addClip(
      makeClip({ id: 'clip_b', start: 8, duration: 4, mediaId: 'media_2', name: 'Segundo' })
    );
    store.copyClips([first, second]);

    const pasted = useProjectStore.getState().pasteClips(VIDEO_TRACK, 30);

    expect(pasted).toHaveLength(2);
    const clips = useProjectStore.getState().project.clips;
    const copyA = clips.find((c) => c.id === pasted[0])!;
    const copyB = clips.find((c) => c.id === pasted[1])!;
    // The distance between the two copied clips is preserved (8 s).
    expect(copyB.start - copyA.start).toBe(8);
    expect(copyA.volume).toBe(0.5);
    expect(copyB.mediaId).toBe('media_2');
    expect(copyB.name).toBe('Segundo');
  });

  it('pasteClips NO pega un clip de vídeo en una pista de audio', () => {
    const store = useProjectStore.getState();
    const clipId = addClip(makeClip({ id: 'clip_a' }));
    store.copyClips([clipId]);

    const pasted = useProjectStore.getState().pasteClips(AUDIO_TRACK, 20);

    expect(pasted).toEqual([]);
    expect(useProjectStore.getState().project.clips).toHaveLength(1);
    // The refusal explains WHY (never a silent no-op).
    expect(useProjectStore.getState().lastError).toMatch(/no se puede pegar/i);
  });

  it('pasteClips con la política "block" rechaza el solape y explica el motivo', () => {
    const store = useProjectStore.getState();
    expect(DEFAULT_OVERLAP_POLICY).toBe('block');
    const clipId = addClip(makeClip({ id: 'clip_a' }));
    store.copyClips([clipId]);

    // The paste lands exactly on top of the original.
    const pasted = useProjectStore.getState().pasteClips(VIDEO_TRACK, 0);

    expect(pasted).toEqual([]);
    expect(useProjectStore.getState().project.clips).toHaveLength(1);
    expect(useProjectStore.getState().lastError).toMatch(/solapa/i);
  });

  it('pasteClips con la política "overwrite" recorta el clip que solapa', () => {
    const store = useProjectStore.getState();
    store.setOverlapPolicy('overwrite');
    const clipId = addClip(makeClip({ id: 'clip_a', start: 0, duration: 10 }));
    store.copyClips([clipId]);

    const pasted = useProjectStore.getState().pasteClips(VIDEO_TRACK, 5);
    expect(pasted).toHaveLength(1);

    const clips = useProjectStore.getState().project.clips;
    const trimmed = clips.find((c) => c.id === clipId)!;
    const inserted = clips.find((c) => c.id === pasted[0])!;
    expect(trimmed.start).toBe(0);
    expect(trimmed.duration).toBe(5);
    expect(inserted.start).toBe(5);
    expect(inserted.duration).toBe(10);
  });

  it('pasteClips con la política "ripple" desplaza los clips posteriores', () => {
    const store = useProjectStore.getState();
    store.setOverlapPolicy('ripple');
    const clipId = addClip(makeClip({ id: 'clip_a', start: 0, duration: 10 }));
    const later = addClip(makeClip({ id: 'clip_b', start: 20, duration: 5 }));
    store.copyClips([clipId]);

    const pasted = useProjectStore.getState().pasteClips(VIDEO_TRACK, 5);
    expect(pasted).toHaveLength(1);

    const clips = useProjectStore.getState().project.clips;
    const moved = clips.find((c) => c.id === later)!;
    expect(moved.start).toBe(30);
    expect(moved.duration).toBe(5);
  });

  it('sin posición explícita el pegado cae fuera de la región copiada', () => {
    const store = useProjectStore.getState();
    const clipId = addClip(makeClip({ id: 'clip_a', start: 0, duration: 10 }));
    store.copyClips([clipId]);
    // The playhead sits INSIDE the copied region.
    useProjectStore.getState().setCurrentTime(2);

    const pasted = useProjectStore.getState().pasteClips();

    expect(pasted).toHaveLength(1);
    const copy = useProjectStore.getState().project.clips.find((c) => c.id === pasted[0])!;
    // Right after the copied region (it can never collide with its source).
    expect(copy.start).toBe(10);
  });

  it('el pegado es deshacible y el clip pegado queda seleccionado', () => {
    const store = useProjectStore.getState();
    const clipId = addClip(makeClip({ id: 'clip_a' }));
    store.copyClips([clipId]);
    const pasted = useProjectStore.getState().pasteClips(VIDEO_TRACK, 20);

    // The pasted clip is selected so the user can move it right away.
    expect(useProjectStore.getState().selectedClipId).toBe(pasted[0]);

    useProjectStore.getState().undo();

    const clips = useProjectStore.getState().project.clips;
    expect(clips).toHaveLength(1);
    expect(clips.find((c) => c.id === pasted[0])).toBeUndefined();
  });

  it('duplicateClips crea una copia justo detrás del original con un id nuevo', () => {
    const clipId = addClip(makeClip({ id: 'clip_a', start: 0, duration: 10 }));

    const duplicated = useProjectStore.getState().duplicateClips([clipId]);

    expect(duplicated).toHaveLength(1);
    expect(duplicated[0]).not.toBe(clipId);
    const clips = useProjectStore.getState().project.clips;
    const copy = clips.find((c) => c.id === duplicated[0])!;
    expect(copy.start).toBe(10);
    expect(copy.duration).toBe(10);
    expect(copy.trackId).toBe(VIDEO_TRACK);
  });

  it('duplicateClips NO modifica el portapapeles', () => {
    const store = useProjectStore.getState();
    const clipId = addClip(makeClip({ id: 'clip_a' }));
    store.copyClips([clipId]);
    const before = useProjectStore.getState().clipboard;

    useProjectStore.getState().duplicateClips([clipId]);

    expect(useProjectStore.getState().clipboard).toBe(before);
    expect(useProjectStore.getState().clipboard).toHaveLength(1);
  });

  it('duplicateClips es deshacible', () => {
    const clipId = addClip(makeClip({ id: 'clip_a' }));
    useProjectStore.getState().duplicateClips([clipId]);
    expect(useProjectStore.getState().project.clips).toHaveLength(2);

    useProjectStore.getState().undo();

    expect(useProjectStore.getState().project.clips).toHaveLength(1);
  });

  it('los helpers puros del portapapeles detectan el solape interno del grupo', () => {
    const overlapping = [makeClip({ id: 'a', start: 0 }), makeClip({ id: 'b', start: 5 })];
    const disjoint = [makeClip({ id: 'a', start: 0 }), makeClip({ id: 'b', start: 10 })];
    expect(hasInternalOverlap(overlapping)).toBe(true);
    expect(hasInternalOverlap(disjoint)).toBe(false);

    // The deep copy is a REAL copy (no shared references).
    const source = makeClip();
    const copy = deepCopyClip(source);
    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
  });

  it('un portapapeles con clips que se solapan entre sí NO se pega', () => {
    const store = useProjectStore.getState();
    // Two clips of DIFFERENT tracks that overlap in time.
    const first = addClip(makeClip({ id: 'clip_a', trackId: VIDEO_TRACK, start: 0, duration: 10 }));
    const second = addClip(makeClip({ id: 'clip_b', trackId: VIDEO_TRACK_2, start: 5, duration: 10 }));
    store.copyClips([first, second]);

    const pasted = useProjectStore.getState().pasteClips(VIDEO_TRACK, 40);

    expect(pasted).toEqual([]);
    expect(useProjectStore.getState().project.clips).toHaveLength(2);
    expect(useProjectStore.getState().lastError).toMatch(/solapan entre sí/i);
  });

  it('pegar en una pista BLOQUEADA se rechaza y no crea ningún clip', () => {
    const store = useProjectStore.getState();
    store.toggleTrackLock(VIDEO_TRACK);
    const clipId = addClip(makeClip({ id: 'clip_a' }));
    useProjectStore.getState().copyClips([clipId]);

    const pasted = useProjectStore.getState().pasteClips(VIDEO_TRACK, 30);

    expect(pasted).toEqual([]);
    expect(useProjectStore.getState().project.clips).toHaveLength(1);
    // The refusal explains WHY (in Spanish).
    expect(useProjectStore.getState().lastError).toMatch(/bloqueada/i);
  });

  it('duplicar en una pista BLOQUEADA se rechaza y no crea ningún clip', () => {
    const store = useProjectStore.getState();
    store.toggleTrackLock(VIDEO_TRACK);
    const clipId = addClip(makeClip({ id: 'clip_a' }));

    const duplicated = useProjectStore.getState().duplicateClips([clipId]);

    expect(duplicated).toEqual([]);
    expect(useProjectStore.getState().project.clips).toHaveLength(1);
    expect(useProjectStore.getState().lastError).toMatch(/bloqueada/i);
  });

  it('el rechazo del pegado nombra el clip en conflicto y su rango de tiempo', () => {
    const store = useProjectStore.getState();
    const clipId = addClip(
      makeClip({ id: 'clip_a', name: 'Intro.mp4', start: 0, duration: 10 })
    );
    store.copyClips([clipId]);

    // The paste lands exactly on top of the original.
    expect(useProjectStore.getState().pasteClips(VIDEO_TRACK, 0)).toEqual([]);

    const error = useProjectStore.getState().lastError!;
    expect(error).toMatch(/no se puede pegar/i);
    // The conflicting clip is named…
    expect(error).toContain('Intro.mp4');
    // …and so is its time range (00:00–00:10).
    expect(error).toMatch(/00:00\s*[–-]\s*00:10/);
  });

  it('el pegado es deshacible Y el rehacer lo restaura', () => {
    const store = useProjectStore.getState();
    const clipId = addClip(makeClip({ id: 'clip_a' }));
    store.copyClips([clipId]);
    const pasted = useProjectStore.getState().pasteClips(VIDEO_TRACK, 20);
    expect(pasted).toHaveLength(1);

    // One undo removes the pasted clip.
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.clips).toHaveLength(1);
    expect(
      useProjectStore.getState().project.clips.find((c) => c.id === pasted[0])
    ).toBeUndefined();

    // One redo brings it back.
    useProjectStore.getState().redo();
    const clips = useProjectStore.getState().project.clips;
    expect(clips).toHaveLength(2);
    expect(clips.find((c) => c.id === pasted[0])).toBeDefined();
  });

  it('pegar NO modifica el portapapeles', () => {
    const store = useProjectStore.getState();
    const clipId = addClip(makeClip({ id: 'clip_a' }));
    store.copyClips([clipId]);
    const before = useProjectStore.getState().clipboard;

    useProjectStore.getState().pasteClips(VIDEO_TRACK, 30);

    expect(useProjectStore.getState().clipboard).toBe(before);
    expect(useProjectStore.getState().clipboard).toHaveLength(1);
  });

  it('el portapapeles no comparte los objetos anidados con el clip vivo', () => {
    const store = useProjectStore.getState();
    const clipId = addClip(
      makeClip({
        id: 'clip_a',
        type: 'text',
        text: 'Hola',
        textStyle: { fontSize: 48, color: '#ffffff' } as never,
      })
    );
    store.copyClips([clipId]);

    const entry = useProjectStore.getState().clipboard[0];
    const live = useProjectStore.getState().project.clips[0];

    // The nested object is a COPY: mutating it cannot break the timeline.
    expect(entry.clip.textStyle).not.toBe(live.textStyle);
    (entry.clip.textStyle as { fontSize: number }).fontSize = 999;
    expect((live.textStyle as { fontSize: number }).fontSize).toBe(48);
  });

  it('un grupo disperso se pega SIN falsos rechazos (el solape se mira clip a clip)', () => {
    const store = useProjectStore.getState();
    // A group copied from two tracks that are far apart: the bounding box of
    // the group is huge, but the clips themselves fit in the free space.
    const first = addClip(makeClip({ id: 'clip_a', trackId: VIDEO_TRACK, start: 0, duration: 5 }));
    const second = addClip(makeClip({ id: 'clip_b', trackId: VIDEO_TRACK_2, start: 100, duration: 5 }));
    // A clip that lives INSIDE the bounding box of the group (but outside
    // the two copied clips).
    addClip(makeClip({ id: 'clip_mid', trackId: VIDEO_TRACK, start: 250, duration: 5 }));
    store.copyClips([first, second]);

    const pasted = useProjectStore.getState().pasteClips(VIDEO_TRACK, 200);

    expect(pasted).toHaveLength(2);
    const clips = useProjectStore.getState().project.clips;
    const copyA = clips.find((c) => c.id === pasted[0])!;
    const copyB = clips.find((c) => c.id === pasted[1])!;
    expect(copyA.start).toBe(200);
    expect(copyB.start).toBe(300);
    expect(useProjectStore.getState().lastError).toBeNull();
  });

  it('duplicateClips NUNCA crea un solape ilegal (ninguna política)', () => {    for (const policy of ['block', 'overwrite', 'ripple'] as const) {
      useProjectStore.getState().resetProject();
      useProjectStore.getState().setOverlapPolicy(policy);

      // A long clip and a SHORT one right after it: the copy of the long
      // clip lands on top of the short one.
      const long = addClip(makeClip({ id: 'clip_a', start: 0, duration: 10 }));
      const short = addClip(makeClip({ id: 'clip_b', start: 12, duration: 1 }));

      const duplicated = useProjectStore.getState().duplicateClips([long, short]);
      expect(duplicated).toHaveLength(2);

      const clips = useProjectStore.getState().project.clips;
      const onTrack = clips
        .filter((c) => c.trackId === VIDEO_TRACK)
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < onTrack.length; i++) {
        const previous = onTrack[i - 1];
        const current = onTrack[i];
        expect(
          current.start,
          `solape ilegal con la política "${policy}": ${previous.id} [${previous.start},${
            previous.start + previous.duration
          }) y ${current.id} [${current.start},${current.start + current.duration}]`
        ).toBeGreaterThanOrEqual(previous.start + previous.duration - 1e-6);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* F7 — keyboard shortcuts                                             */
/* ------------------------------------------------------------------ */

describe('F7 — los atajos de teclado del portapapeles', () => {
  it('Ctrl/Cmd + C, V y D se reconocen como atajos del portapapeles', () => {
    expect(resolveClipboardShortcut({ key: 'c', ctrlKey: true })).toBe('copy');
    expect(resolveClipboardShortcut({ key: 'C', metaKey: true })).toBe('copy');
    expect(resolveClipboardShortcut({ key: 'v', ctrlKey: true })).toBe('paste');
    expect(resolveClipboardShortcut({ key: 'V', metaKey: true })).toBe('paste');
    expect(resolveClipboardShortcut({ key: 'd', ctrlKey: true })).toBe('duplicate');
    expect(resolveClipboardShortcut({ key: 'D', metaKey: true })).toBe('duplicate');
  });

  it('las demás teclas NO se interpretan como atajos del portapapeles', () => {
    expect(resolveClipboardShortcut({ key: 'c' })).toBeNull();
    expect(resolveClipboardShortcut({ key: 'z', ctrlKey: true })).toBeNull();
    expect(resolveClipboardShortcut({ key: 'v', ctrlKey: true, altKey: true })).toBeNull();
  });

  it('el portapapeles del sistema NO se secuestra en un campo de texto', () => {
    const input = { tagName: 'INPUT', isContentEditable: false } as unknown as HTMLElement;
    const textarea = { tagName: 'TEXTAREA', isContentEditable: false } as unknown as HTMLElement;
    const editable = {
      tagName: 'DIV',
      isContentEditable: true,
      getAttribute: () => 'true',
    } as unknown as HTMLElement;
    const canvas = {
      tagName: 'CANVAS',
      isContentEditable: false,
      getAttribute: () => null,
    } as unknown as HTMLElement;

    expect(isTextEntryTarget(input)).toBe(true);
    expect(isTextEntryTarget(textarea)).toBe(true);
    expect(isTextEntryTarget(editable)).toBe(true);
    expect(isTextEntryTarget(canvas)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });

  it('MainLayout cablea los atajos y respeta el portapapeles del sistema', () => {
    const source = readFileSync(
      new URL('../components/layout/MainLayout.tsx', import.meta.url),
      'utf8'
    );
    expect(source).toContain('resolveClipboardShortcut');
    expect(source).toContain('isTextEntryTarget');
    expect(source).toMatch(/copyClips\(/);
    expect(source).toMatch(/pasteClips\(/);
    expect(source).toMatch(/duplicateClips\(/);
    // The system clipboard must survive: the text entry guard comes first.
    expect(source.indexOf('isTextEntryTarget')).toBeLessThan(
      source.indexOf('resolveClipboardShortcut(e)')
    );
  });

  it('el clip seleccionado expone las acciones de portapapeles en español', () => {
    const source = readFileSync(
      new URL('../components/timeline/ClipItem.tsx', import.meta.url),
      'utf8'
    );
    expect(source).toContain('clip-clipboard-actions');
    expect(source).toContain('Copiar');
    expect(source).toContain('Pegar');
    expect(source).toContain('Duplicar');
  });

  it('las acciones de portapapeles se muestran con su etiqueta (táctiles)', () => {
    const source = readFileSync(
      new URL('../components/timeline/ClipItem.tsx', import.meta.url),
      'utf8'
    );
    // The actions are a visible row (not a right-click menu) and they are
    // rendered as soon as the clip is selected.
    expect(source).toMatch(/isSelected\s*&&\s*\(/);
    expect(source).toContain('showClipboardLabels');
    // A touch target that can really be hit with a finger.
    expect(source).toMatch(/min-h-\[2\dpx\]/);
  });

  it('el rechazo del store se MUESTRA al usuario (no es un no-op silencioso)', () => {
    const source = readFileSync(
      new URL('../components/layout/MainLayout.tsx', import.meta.url),
      'utf8'
    );
    // The banner renders `lastError` (the refusal of the last action)…
    expect(source).toContain('store-error-banner');
    expect(source).toContain('s.lastError');
    // …and it is mounted in BOTH layouts (desktop and mobile).
    const bannerUsages = source.split('<StoreErrorBanner />').length - 1;
    expect(bannerUsages).toBeGreaterThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ */
/* F10 — export presets                                                */
/* ------------------------------------------------------------------ */

describe('F10 — los preajustes de exportación', () => {
  it('existen los cuatro preajustes con sus valores', () => {
    const byId = new Map(EXPORT_PRESETS.map((preset) => [preset.id, preset]));
    expect(byId.size).toBe(EXPORT_PRESETS.length);

    const web = byId.get('web-720p')!;
    expect(web.resolution).toBe('720p');
    expect(web.fps).toBe(30);
    expect(web.bitrateMbps).toBe(6);
    expect(computeExportDimensions(web.resolution, web.aspectRatio)).toEqual({
      width: 1280,
      height: 720,
    });

    const social = byId.get('social-1080p')!;
    expect(social.resolution).toBe('1080p');
    expect(social.fps).toBe(30);
    expect(social.bitrateMbps).toBe(8);
    expect(computeExportDimensions(social.resolution, social.aspectRatio)).toEqual({
      width: 1920,
      height: 1080,
    });

    const vertical = byId.get('vertical-9x16')!;
    expect(vertical.aspectRatio).toBe('9:16');
    expect(vertical.fps).toBe(30);
    expect(vertical.bitrateMbps).toBe(8);

    const high = byId.get('high-quality-1080p60')!;
    expect(high.fps).toBe(60);
    expect(high.bitrateMbps).toBe(12);
  });

  it('el preajuste vertical produce un archivo REALMENTE vertical (1080×1920)', () => {
    const vertical = EXPORT_PRESETS.find((preset) => preset.aspectRatio === '9:16')!;
    expect(vertical).toBeDefined();

    const dims = computeExportDimensions(vertical.resolution, vertical.aspectRatio);
    expect(dims.width).toBe(1080);
    expect(dims.height).toBe(1920);
    // The vertical file is taller than wide (a landscape export is not).
    expect(dims.height).toBeGreaterThan(dims.width);
    // The hardware encoders need even dimensions.
    expect(dims.width % 2).toBe(0);
    expect(dims.height % 2).toBe(0);
  });

  it('el preajuste activo se deselecciona cuando los controles dejan de coincidir', () => {
    const settings = {
      resolution: '1080p' as const,
      fps: 30,
      bitrateMbps: 8,
      aspectRatio: '16:9' as const,
    };
    expect(findActivePreset(settings)?.id).toBe('social-1080p');

    // Moving the bitrate slider: the preset no longer matches.
    expect(findActivePreset({ ...settings, bitrateMbps: 12 })).toBeNull();
    // Moving the fps button: the preset no longer matches either.
    expect(findActivePreset({ ...settings, fps: 60 })).toBeNull();
    // The vertical preset only matches a 9:16 project.
    expect(findActivePreset({ ...settings, aspectRatio: '9:16' })?.id).toBe('vertical-9x16');
  });

  it('el modal muestra los preajustes y aplica el aspect ratio del EXPORTE', () => {
    const source = readFileSync(
      new URL('../components/export/ExportModal.tsx', import.meta.url),
      'utf8'
    );
    expect(source).toContain('export-presets');
    expect(source).toContain('EXPORT_PRESETS');
    // The aspect ratio of the exported file belongs to the modal.
    expect(source).toContain('exportAspectRatio');
  });

  it('el preajuste vertical NO reformatea el proyecto (solo el archivo exportado)', () => {
    const source = readFileSync(
      new URL('../components/export/ExportModal.tsx', import.meta.url),
      'utf8'
    );
    // The export dialog must NOT rewrite (and persist) the project of the
    // user: it only changes the shape of the exported file.
    expect(source).not.toMatch(/setAspectRatio\(/);

    // …but the exported file IS really vertical.
    const vertical = EXPORT_PRESETS.find((preset) => preset.id === 'vertical-9x16')!;
    expect(computeExportDimensions(vertical.resolution, vertical.aspectRatio)).toEqual({
      width: 1080,
      height: 1920,
    });
  });
});

/* ------------------------------------------------------------------ */
/* F10 — export range                                                  */
/* ------------------------------------------------------------------ */

describe('F10 — el rango de exportación', () => {
  it('sin rango se exporta el proyecto COMPLETO (comportamiento por defecto)', () => {
    expect(resolveExportRange({ mode: 'full', start: null, end: null }, 30)).toBeNull();
    expect(isExportRangeValid({ mode: 'full', start: null, end: null })).toBe(true);
  });

  it('un rango personalizado necesita entrada Y salida', () => {
    expect(isExportRangeValid({ mode: 'custom', start: 5, end: null })).toBe(false);
    expect(isExportRangeValid({ mode: 'custom', start: null, end: 12 })).toBe(false);
    expect(isExportRangeValid({ mode: 'custom', start: 12, end: 5 })).toBe(false);
    expect(isExportRangeValid({ mode: 'custom', start: 5, end: 12 })).toBe(true);
    // An invalid range never resolves: the export stays blocked.
    expect(resolveExportRange({ mode: 'custom', start: 5, end: null }, 30)).toBeNull();
  });

  it('el rango resuelto define la duración y los fotogramas del rango', () => {
    const range = resolveExportRange({ mode: 'custom', start: 5, end: 12 }, 30)!;
    expect(range).not.toBeNull();
    expect(range.start).toBe(5);
    expect(range.end).toBe(12);
    expect(range.duration).toBe(7);
    // The frame count of the modal follows the range, not the project.
    expect(Math.round(range.duration * 30)).toBe(210);
  });

  it('el rango se recorta a la duración real del proyecto', () => {
    const range = resolveExportRange({ mode: 'custom', start: 2, end: 30 }, 10)!;
    expect(range.end).toBe(10);
    expect(range.duration).toBe(8);
  });

  it('los clips se rebasan al rango: los que no lo tocan se descartan', () => {
    const clips = [
      makeClip({ id: 'a', start: 0, duration: 10 }),
      makeClip({ id: 'b', start: 10, duration: 4, sourceStart: 2 }),
      makeClip({ id: 'c', start: 30, duration: 5 }),
    ];
    const rebased = buildRangeExportClips(clips, 5, 12);

    expect(rebased).toHaveLength(2);
    // The clip that crosses the in point is trimmed and moved.
    expect(rebased[0].id).toBe('a');
    expect(rebased[0].start).toBe(0);
    expect(rebased[0].duration).toBe(5);
    // Its source window follows the material (5 s into the source).
    expect(rebased[0].sourceStart).toBe(5);
    // The clip that crosses the out point is trimmed too.
    expect(rebased[1].id).toBe('b');
    expect(rebased[1].start).toBe(5);
    expect(rebased[1].duration).toBe(2);
    expect(rebased[1].sourceStart).toBe(2);
  });

  it('la velocidad del clip se respeta al rebasar el rango', () => {
    const clips = [makeClip({ id: 'a', start: 0, duration: 10, speed: 2, sourceStart: 0 })];
    const rebased = buildRangeExportClips(clips, 4, 8);
    expect(rebased).toHaveLength(1);
    expect(rebased[0].start).toBe(0);
    expect(rebased[0].duration).toBe(4);
    // 4 s of timeline at 2x = 8 s of source.
    expect(rebased[0].sourceStart).toBe(8);
  });

  it('la etiqueta del rango es explícita', () => {
    const range = resolveExportRange({ mode: 'custom', start: 5, end: 12 }, 30)!;
    expect(formatExportRange(range)).toBe('Exportando 00:00:05 → 00:00:12 (7 s)');
    expect(formatExportTimecode(0)).toBe('00:00:00');
    expect(formatExportTimecode(3725)).toBe('01:02:05');
  });

  it('el modal exporta el rango (duración y clips rebasados) y no el proyecto entero', () => {
    const source = readFileSync(
      new URL('../components/export/ExportModal.tsx', import.meta.url),
      'utf8'
    );
    expect(source).toContain('buildRangeExportClips');
    expect(source).toContain('resolveExportRange');
    // The exporter receives the range duration and the re-based clips.
    expect(source).toMatch(/duration: exportDuration/);
    expect(source).toMatch(/clips: exportClips/);
    // The markers are set from the playhead.
    expect(source).toContain('export-range-mark-in');
    expect(source).toContain('export-range-mark-out');
  });
});
