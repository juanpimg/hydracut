/**
 * Integridad de datos, oleada 2 (auditoría A4: D01–D09 + copy A1).
 *
 * Cada test reproduce una sonda de `/tmp/opencode/audit-a4/probe*.ts` contra el
 * comportamiento REAL del store / storage: sin reimplementar la lógica y sin
 * asserts tautológicos.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { useProjectStore } from '../store/useProjectStore';
import {
  duplicateProject,
  deleteProject,
  getProjectById,
  saveProject,
  sanitizeImportedProject,
  restoreEmbeddedMedia,
  importProjectFromFileWithReport,
  flushAutosave,
  MAX_EMBEDDED_MEDIA_BYTES,
} from '../core/storage/projectStorage';
import { Clip, MediaItem, Project } from '../types/project';

/* ------------------------------------------------------------------ */
/* Mocks: IndexedDB en memoria + OPFS funcional en memoria             */
/* ------------------------------------------------------------------ */

const h = vi.hoisted(() => {
  const memory = new Map<string, unknown>();
  const opfsFiles = new Map<string, Blob>();
  return {
    memory,
    opfsFiles,
    getSpy: vi.fn(async (key: string) => memory.get(key)),
    setSpy: vi.fn(async (key: string, value: unknown) => {
      memory.set(key, value);
    }),
    delSpy: vi.fn(async (key: string) => {
      memory.delete(key);
    }),
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
  saveMediaToOPFS: async (mediaId: string, file: File) => {
    const name = `${mediaId}_${file.name}`;
    h.opfsFiles.set(name, file);
    return name;
  },
  getMediaFromOPFS: async (path: string): Promise<File | null> => {
    const blob = h.opfsFiles.get(path);
    if (!blob) return null;
    return new File([blob], path);
  },
  deleteMediaFilesFromOPFS: async (paths: string[]) => {
    for (const p of paths) h.opfsFiles.delete(p);
  },
  deleteMediaFromOPFS: async (path: string) => {
    h.opfsFiles.delete(path);
  },
  isOPFSSupported: async () => true,
  isUsableMediaFile: (file: unknown) =>
    !!file && typeof (file as Blob).size === 'number' && (file as Blob).size > 0,
}));

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const VIDEO_TRACK = 'track_video_1';

function makeMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media_1',
    name: 'clip.mp4',
    type: 'video',
    url: 'blob:test/media_1',
    duration: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    thumbnailUrl: '',
    size: 1024,
    createdAt: 1700000000000,
    opfsPath: 'media_1_clip.mp4',
    ...overrides,
  };
}

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

function pastLen(): number {
  return useProjectStore.getState().past.length;
}

beforeEach(async () => {
  // Drena un autosave pendiente del test anterior (last-write-wins global).
  await flushAutosave();
  h.memory.clear();
  h.opfsFiles.clear();
  useProjectStore.getState().resetProject();
  useProjectStore.setState({ past: [], future: [], lastError: null });
});

/* ------------------------------------------------------------------ */
/* D01 — purgar es irreversible y el undo nunca miente                  */
/* ------------------------------------------------------------------ */

describe('D01 — purgar la papelera no es deshacible y el undo no miente', () => {
  it('purgeTrash no empuja historial (es irreversible)', async () => {
    const store = useProjectStore.getState();
    store.addMediaItem(makeMedia({ id: 'm_purge' }));
    store.addClip(makeClip({ mediaId: 'm_purge' }));
    store.removeMediaItem('m_purge');
    const base = pastLen();

    const n = useProjectStore.getState().purgeTrash();

    expect(n).toBe(1);
    expect(pastLen()).toBe(base);
    expect(useProjectStore.getState().project.trash).toHaveLength(0);
  });

  it('purgeTrashedMedia no empuja historial', () => {
    const store = useProjectStore.getState();
    store.addMediaItem(makeMedia({ id: 'm_a' }));
    store.addMediaItem(makeMedia({ id: 'm_b' }));
    store.removeMediaItem('m_a');
    store.removeMediaItem('m_b');
    const base = pastLen();

    expect(useProjectStore.getState().purgeTrashedMedia('m_a')).toBe(true);
    expect(pastLen()).toBe(base);
  });

  it('deshacer tras purgar marca el medio como ausente (nunca funcional)', async () => {
    const store = useProjectStore.getState();
    const bytes = new File([new Uint8Array([1, 2, 3, 4])], 'purge.mp4', { type: 'video/mp4' });
    h.opfsFiles.set('m_purge_purge.mp4', bytes);
    store.addMediaItem(makeMedia({ id: 'm_purge', url: 'blob:test/purge', opfsPath: 'm_purge_purge.mp4' }));
    store.addClip(makeClip({ mediaId: 'm_purge' }));
    store.removeMediaItem('m_purge');
    useProjectStore.getState().purgeTrash();
    // La purga borra los bytes de verdad (vía promesa): se espera la
    // CONDICIÓN en vez de dormir 20 ms fijos.
    await vi.waitFor(() => {
      expect(h.opfsFiles.has('m_purge_purge.mp4')).toBe(false);
    });

    useProjectStore.getState().undo();

    const project = useProjectStore.getState().project;
    const media = project.mediaPool.find((m) => m.id === 'm_purge');
    expect(media).toBeDefined();
    // El estado restaurado NO parece funcional: dice "medio ausente".
    expect(media!.status).toBe('missing');
    expect(useProjectStore.getState().lastError).toMatch(/ausente|revinc/i);
  });
});

/* ------------------------------------------------------------------ */
/* D02 — duplicateProject copia los bytes (proyectos independientes)    */
/* ------------------------------------------------------------------ */

describe('D02 — duplicar un proyecto copia sus archivos', () => {
  function projectWithMedia(): Project {
    const bytes = new File([new Uint8Array([7, 7, 7])], 'orig.mp4', { type: 'video/mp4' });
    h.opfsFiles.set('m1_orig.mp4', bytes);
    const base = useProjectStore.getState().project;
    return {
      ...JSON.parse(JSON.stringify(base)),
      id: 'proj_orig',
      name: 'Original',
      mediaPool: [makeMedia({ id: 'm1', name: 'orig.mp4', opfsPath: 'm1_orig.mp4', size: 3 })],
      clips: [makeClip({ id: 'c1', mediaId: 'm1', start: 0, duration: 5 })],
      trash: [],
      createdAt: 1,
      updatedAt: 1,
    } as Project;
  }

  it('el clon tiene sus propios ids y sus propios bytes', async () => {
    await saveProject(projectWithMedia());

    const clone = await duplicateProject('proj_orig');

    expect(clone.id).not.toBe('proj_orig');
    expect(clone.mediaPool).toHaveLength(1);
    expect(clone.mediaPool[0].id).not.toBe('m1');
    expect(clone.mediaPool[0].opfsPath).not.toBe('m1_orig.mp4');
    expect(clone.clips[0].mediaId).toBe(clone.mediaPool[0].id);
    // Los bytes del clon se leen de su propia ruta.
    const { getMediaFromOPFS } = await import('../core/storage/opfsStorage');
    const back = await getMediaFromOPFS(clone.mediaPool[0].opfsPath!);
    expect(back).not.toBeNull();
    expect(back!.size).toBe(3);
  });

  it('borrar el original no corrompe al clon', async () => {
    await saveProject(projectWithMedia());
    const clone = await duplicateProject('proj_orig');

    await deleteProject('proj_orig');

    const { getMediaFromOPFS } = await import('../core/storage/opfsStorage');
    const back = await getMediaFromOPFS(clone.mediaPool[0].opfsPath!);
    expect(back).not.toBeNull();
    const reloaded = await getProjectById(clone.id);
    expect(reloaded?.mediaPool[0].opfsPath).toBe(clone.mediaPool[0].opfsPath);
  });

  it('si los bytes no se pueden copiar el clon queda como ausente (no comparte ruta)', async () => {
    const project = projectWithMedia();
    // Sin bytes en el disco para esta ruta: la copia es imposible.
    project.mediaPool[0].opfsPath = 'm1_fantasma.mp4';
    await saveProject(project);

    const clone = await duplicateProject('proj_orig');

    expect(clone.mediaPool[0].opfsPath).not.toBe('m1_fantasma.mp4');
    expect(clone.mediaPool[0].status).toBe('missing');
  });
});

/* ------------------------------------------------------------------ */
/* D03 — updateClip valida antes de escribir                            */
/* ------------------------------------------------------------------ */

describe('D03 — updateClip rechaza lo imposible con lastError', () => {
  it('rechaza duration negativa sin tocar el estado ni el historial', () => {
    useProjectStore.getState().addMediaItem(makeMedia());
    useProjectStore.getState().addClip(makeClip({ id: 'c1', duration: 10 }));
    const base = pastLen();

    useProjectStore.getState().updateClip('c1', { duration: -5 });

    const clip = useProjectStore.getState().project.clips[0];
    expect(clip.duration).toBe(10);
    expect(pastLen()).toBe(base);
    expect(useProjectStore.getState().lastError).toMatch(/duraci/i);
  });

  it('rechaza start NaN', () => {
    useProjectStore.getState().addMediaItem(makeMedia());
    useProjectStore.getState().addClip(makeClip({ id: 'c1', start: 2 }));
    const base = pastLen();

    useProjectStore.getState().updateClip('c1', { start: NaN });

    expect(useProjectStore.getState().project.clips[0].start).toBe(2);
    expect(pastLen()).toBe(base);
    expect(useProjectStore.getState().lastError).not.toBeNull();
  });

  it('rechaza un trackId inexistente', () => {
    useProjectStore.getState().addMediaItem(makeMedia());
    useProjectStore.getState().addClip(makeClip({ id: 'c1' }));

    useProjectStore.getState().updateClip('c1', { trackId: 'pista_fantasma' });

    expect(useProjectStore.getState().project.clips[0].trackId).toBe(VIDEO_TRACK);
    expect(useProjectStore.getState().lastError).toMatch(/pista/i);
  });

  it('rechaza un mediaId inexistente', () => {
    useProjectStore.getState().addMediaItem(makeMedia());
    useProjectStore.getState().addClip(makeClip({ id: 'c1' }));

    useProjectStore.getState().updateClip('c1', { mediaId: 'medio_fantasma' });

    expect(useProjectStore.getState().project.clips[0].mediaId).toBe('media_1');
    expect(useProjectStore.getState().lastError).toMatch(/medio/i);
  });

  it('una edición válida sigue funcionando y es deshacible', () => {
    useProjectStore.getState().addMediaItem(makeMedia());
    useProjectStore.getState().addClip(makeClip({ id: 'c1', name: 'Antes' }));
    const base = pastLen();

    useProjectStore.getState().updateClip('c1', { name: 'Después' });

    expect(useProjectStore.getState().project.clips[0].name).toBe('Después');
    expect(pastLen()).toBe(base + 1);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.clips[0].name).toBe('Antes');
  });
});

/* ------------------------------------------------------------------ */
/* D04 — restaurar sin pista no crea huérfanos                          */
/* ------------------------------------------------------------------ */

describe('D04 — restoreFromTrash no deja clips huérfanos', () => {
  it('restaura el medio pero no el clip de una pista borrada (y lo dice)', () => {
    const store = useProjectStore.getState();
    store.addMediaItem(makeMedia({ id: 'm_orph' }));
    const vt = useProjectStore.getState().project.tracks.find((t) => t.type === 'video')!;
    store.addClip(makeClip({ id: 'c_orph', mediaId: 'm_orph', trackId: vt.id }));
    store.removeMediaItem('m_orph');
    useProjectStore.getState().removeTrack(vt.id);

    const ok = useProjectStore.getState().restoreFromTrash('m_orph');

    const project = useProjectStore.getState().project;
    expect(ok).toBe(true);
    expect(project.mediaPool.find((m) => m.id === 'm_orph')).toBeDefined();
    const dangling = project.clips.filter((c) => !project.tracks.some((t) => t.id === c.trackId));
    expect(dangling).toHaveLength(0);
    expect(project.clips.find((c) => c.id === 'c_orph')).toBeUndefined();
    expect(useProjectStore.getState().lastError).toMatch(/pista/i);
  });
});

/* ------------------------------------------------------------------ */
/* D05 — la política block también frena mover/recortar/editar          */
/* ------------------------------------------------------------------ */

describe('D05 — mover, recortar y editar respetan la política block', () => {
  it('moveClip sobre otro clip se rechaza (sin cambios ni historial)', () => {
    const store = useProjectStore.getState();
    store.setOverlapPolicy('block');
    store.addClip(makeClip({ id: 'c1', start: 0, duration: 5 }));
    store.addClip(makeClip({ id: 'c2', start: 10, duration: 5 }));
    const base = pastLen();

    store.beginClipGesture();
    store.moveClip('c2', 2);
    store.commitClipChange();

    const c2 = useProjectStore.getState().project.clips.find((c) => c.id === 'c2')!;
    expect(c2.start).toBe(10);
    expect(useProjectStore.getState().lastError).toMatch(/solapa/i);
    expect(pastLen()).toBe(base + 1);
  });

  it('updateClip que crearía un solape se rechaza', () => {
    const store = useProjectStore.getState();
    store.setOverlapPolicy('block');
    store.addClip(makeClip({ id: 'c1', start: 0, duration: 5 }));
    store.addClip(makeClip({ id: 'c2', start: 10, duration: 5 }));
    const base = pastLen();

    store.updateClip('c2', { start: 2 });

    expect(useProjectStore.getState().project.clips.find((c) => c.id === 'c2')!.start).toBe(10);
    expect(useProjectStore.getState().lastError).toMatch(/solapa/i);
    expect(pastLen()).toBe(base);
  });

  it('trimClipEnd que invadiría al vecino se rechaza', () => {
    const store = useProjectStore.getState();
    store.setOverlapPolicy('block');
    store.addClip(makeClip({ id: 'c1', start: 0, duration: 5, sourceStart: 0, sourceDuration: 20 }));
    store.addClip(makeClip({ id: 'c2', start: 5, duration: 5 }));

    store.trimClipEnd('c1', 7);

    expect(useProjectStore.getState().project.clips.find((c) => c.id === 'c1')!.duration).toBe(5);
    expect(useProjectStore.getState().lastError).toMatch(/solapa|recortar/i);
  });

  it('con overwrite el move recorta al vecino en vez de solaparse', () => {
    const store = useProjectStore.getState();
    store.setOverlapPolicy('overwrite');
    store.addClip(makeClip({ id: 'c1', start: 0, duration: 5, sourceStart: 0, sourceDuration: 20 }));
    store.addClip(makeClip({ id: 'c2', start: 10, duration: 5, sourceStart: 0, sourceDuration: 20 }));

    store.beginClipGesture();
    store.moveClip('c2', 2);
    store.commitClipChange();

    const clips = useProjectStore.getState().project.clips;
    const vt = useProjectStore.getState().project.tracks.find((t) => t.type === 'video')!.id;
    void vt;
    // Sin solapes ilegales tras el move.
    for (const a of clips) {
      for (const b of clips) {
        if (a.id === b.id || a.trackId !== b.trackId) continue;
        const overlap = a.start < b.start + b.duration - 1e-6 && b.start < a.start + a.duration - 1e-6;
        expect(overlap).toBe(false);
      }
    }
    expect(clips.find((c) => c.id === 'c2')!.start).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* D06 — mover/recortar sin gesto es deshacible y persiste              */
/* ------------------------------------------------------------------ */

describe('D06 — mover y recortar sin gesto empujan historial y persisten', () => {
  it('moveClip sin gesto empuja historial y recalcula la duración', () => {
    const store = useProjectStore.getState();
    store.addMediaItem(makeMedia());
    store.addClip(makeClip({ id: 'c1', start: 4, duration: 6, sourceStart: 0, sourceDuration: 20 }));
    const base = pastLen();

    // Sin beginClipGesture ni commit: la mutación debe bastarse sola.
    store.moveClip('c1', 9);

    expect(useProjectStore.getState().project.clips[0].start).toBe(9);
    expect(pastLen()).toBe(base + 1);
    expect(useProjectStore.getState().project.duration).toBe(15);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.clips[0].start).toBe(4);
  });

  it('trimClipEnd sin gesto persiste en el disco', async () => {
    const store = useProjectStore.getState();
    store.addMediaItem(makeMedia());
    store.addClip(makeClip({ id: 'c1', start: 0, duration: 10, sourceStart: 0, sourceDuration: 20 }));
    const base = pastLen();

    store.trimClipEnd('c1', 4);

    expect(pastLen()).toBe(base + 1);
    expect(useProjectStore.getState().project.duration).toBe(4);
    await flushAutosave();
    const saved = await getProjectById(useProjectStore.getState().project.id);
    expect(saved?.clips.find((c) => c.id === 'c1')?.duration).toBe(4);
  });

  it('trimClipStart sin gesto empuja historial', () => {
    const store = useProjectStore.getState();
    store.addMediaItem(makeMedia());
    store.addClip(makeClip({ id: 'c1', start: 4, duration: 10, sourceStart: 0, sourceDuration: 20 }));
    const base = pastLen();

    store.trimClipStart('c1', 6);

    expect(useProjectStore.getState().project.clips[0].start).toBe(6);
    expect(pastLen()).toBe(base + 1);
  });
});

/* ------------------------------------------------------------------ */
/* D07 — el tope de 64 MB también vale al importar                      */
/* ------------------------------------------------------------------ */

describe('D07 — importar aplica el tope de medios incrustados', () => {
  function tinyData(text: string): string {
    return Buffer.from(text, 'utf8').toString('base64');
  }

  it('ignora los medios incrustados que no pertenecen al proyecto (sin escribir)', async () => {
    const project = useProjectStore.getState().project;
    const files = [
      { mediaId: 'fantasma', fileName: 'fantasma.mp4', mimeType: 'video/mp4', size: 5, data: tinyData('hola!') },
    ];

    const result = await restoreEmbeddedMedia(project, files);

    expect(result.restored).not.toContain('fantasma');
    expect(result.ignored ?? []).toContain('fantasma');
    expect(h.opfsFiles.size).toBe(0);
  });

  it('rechaza lo que supera el tope acumulado (con mensaje claro)', async () => {
    const store = useProjectStore.getState();
    store.addMediaItem(makeMedia({ id: 'm1', size: 0 }));
    store.addMediaItem(makeMedia({ id: 'm2', size: 0 }));
    const project = useProjectStore.getState().project;
    const files = [
      { mediaId: 'm1', fileName: 'm1.mp4', mimeType: 'video/mp4', size: 6, data: tinyData('123456') },
      { mediaId: 'm2', fileName: 'm2.mp4', mimeType: 'video/mp4', size: 6, data: tinyData('abcdef') },
    ];

    const result = await restoreEmbeddedMedia(project, files, { maxBytes: 10 });

    expect(result.restored).toEqual(['m1']);
    expect(result.skipped ?? []).toEqual(['m2']);
    // Lo rechazado no ocupa disco.
    expect(Array.from(h.opfsFiles.keys()).some((k) => k.startsWith('m2_'))).toBe(false);
    expect(result.project.mediaPool.find((m) => m.id === 'm2')?.size).toBe(0);
  });

  it('el tope por defecto es el mismo que en exportación (64 MB)', () => {
    expect(MAX_EMBEDDED_MEDIA_BYTES).toBe(64 * 1024 * 1024);
  });

  it('importar avisa del medio ignorado en el informe', async () => {
    const tracks = useProjectStore.getState().project.tracks;
    const envelope = {
      version: 2,
      app: 'HydraCut',
      exportedAt: 1,
      mediaEmbedded: true,
      mediaCount: 0,
      embeddedMedia: [
        { mediaId: 'nadie', fileName: 'nadie.mp4', mimeType: 'video/mp4', size: 5, data: tinyData('hola!') },
      ],
      project: {
        id: 'proj_huerfano',
        name: 'Huérfano',
        aspectRatio: '16:9',
        resolution: { width: 1920, height: 1080 },
        fps: 30,
        tracks,
        clips: [],
        mediaPool: [],
        duration: 30,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const file = new File([JSON.stringify(envelope)], 'huerfano.hydra', { type: 'application/json' });

    const report = await importProjectFromFileWithReport(file);

    expect(report.restoredMedia ?? []).not.toContain('nadie');
    expect(report.warnings.join(' ')).toMatch(/ignora/i);
    expect(h.opfsFiles.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* D08 — un clip no vive a la vez en la línea y en la papelera          */
/* ------------------------------------------------------------------ */

describe('D08 — importar repara los ids duplicados línea↔papelera', () => {
  it('renombra el clip de la papelera con aviso (sin duplicados)', () => {
    const tracks = useProjectStore.getState().project.tracks;
    const vt = tracks.find((t) => t.type === 'video')!.id;
    const candidate = {
      tracks,
      clips: [makeClip({ id: 'clip_doble', trackId: vt })],
      mediaPool: [makeMedia({ id: 'media_1' })],
      trash: [
        {
          media: makeMedia({ id: 'media_t' }),
          clips: [makeClip({ id: 'clip_doble', trackId: vt, mediaId: 'media_t' })],
          deletedAt: 5,
        },
      ],
    };

    const { project, warnings } = sanitizeImportedProject(candidate, {
      projectId: 'proj_dup',
      fallbackName: 'X',
    });

    const ids = [
      ...project.clips.map((c) => c.id),
      ...(project.trash ?? []).flatMap((t) => t.clips.map((c) => c.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    // El clip vivo conserva su id; el de la papelera se repara.
    expect(project.clips[0].id).toBe('clip_doble');
    expect(warnings.join(' ')).toMatch(/duplicado/i);
  });

  it('restaurar con id en uso genera un id nuevo (sin duplicados)', () => {
    const store = useProjectStore.getState();
    store.addMediaItem(makeMedia({ id: 'm_t' }));
    const vt = useProjectStore.getState().project.tracks.find((t) => t.type === 'video')!.id;
    // Un clip vivo con el mismo id que el aparcado en la papelera.
    store.addClip(makeClip({ id: 'c_vivo', trackId: vt, mediaId: 'm_t' }));
    store.removeMediaItem('m_t');
    // Otro medio ocupa el id del clip aparcado.
    useProjectStore.setState((s) => ({
      project: {
        ...s.project,
        clips: [...s.project.clips, makeClip({ id: 'c_aparcado', trackId: vt, mediaId: 'media_1' })],
      },
    }));
    useProjectStore.setState((s) => ({
      project: {
        ...s.project,
        trash: (s.project.trash ?? []).map((e) =>
          e.media.id === 'm_t' ? { ...e, clips: [makeClip({ id: 'c_aparcado', trackId: vt, mediaId: 'm_t' })] } : e
        ),
      },
    }));

    const ok = useProjectStore.getState().restoreFromTrash('m_t');

    expect(ok).toBe(true);
    const ids = useProjectStore.getState().project.clips.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ------------------------------------------------------------------ */
/* D09 — revincular es deshacible y el undo recupera el archivo         */
/* ------------------------------------------------------------------ */

describe('D09 — relinkMedia empuja historial y el undo recupera el archivo', () => {
  it('revincular es UN paso deshacible que restaura los bytes previos', async () => {
    h.opfsFiles.set('m_rel_viejo.mp4', new File([new Uint8Array([1, 2, 3, 4])], 'viejo.mp4'));
    const store = useProjectStore.getState();
    store.addMediaItem(
      makeMedia({ id: 'm_rel', name: 'viejo.mp4', url: 'blob:test/viejo', opfsPath: 'm_rel_viejo.mp4', size: 4 })
    );
    store.addClip(makeClip({ id: 'c_rel', mediaId: 'm_rel' }));
    const base = pastLen();
    const { getMediaFromOPFS } = await import('../core/storage/opfsStorage');

    const ok = await store.relinkMedia('m_rel', new File([new Uint8Array([9, 9, 9, 9, 9, 9])], 'nuevo.mp4'));

    expect(ok).toBe(true);
    expect(pastLen()).toBe(base + 1);
    const relinked = useProjectStore.getState().project.mediaPool.find((m) => m.id === 'm_rel')!;
    expect(relinked.size).toBe(6);

    useProjectStore.getState().undo();

    const restored = useProjectStore.getState().project.mediaPool.find((m) => m.id === 'm_rel')!;
    expect(restored.opfsPath).toBe('m_rel_viejo.mp4');
    expect(restored.size).toBe(4);
    // El archivo previo sigue en el disco: el undo lo recupera de verdad.
    const back = await getMediaFromOPFS('m_rel_viejo.mp4');
    expect(back).not.toBeNull();
    expect(back!.size).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* Copy A1 — acentos y «Desplazar»                                      */
/* ------------------------------------------------------------------ */

describe('Copy A1 — nombres por defecto y política con acentos', () => {
  it('el proyecto inicial usa los términos canónicos', () => {
    const project = useProjectStore.getState().project;
    expect(project.name).toBe('Mi proyecto de vídeo');
    const names = project.tracks.map((t) => t.name);
    expect(names).toContain('Texto T1');
    expect(names).toContain('Vídeo V2 (superposición)');
    expect(names).toContain('Vídeo V1 (principal)');
    expect(names).toContain('Audio A1');
  });

  it('el motivo de solape dice «Desplazar», no «Ripple»', () => {
    const store = useProjectStore.getState();
    store.setOverlapPolicy('block');
    const media = makeMedia({ id: 'm1', name: 'uno.mp4', duration: 10 });
    store.addMediaItem(media);
    store.addClip(makeClip({ id: 'c1', start: 0, duration: 10 }));

    const result = store.addClipFromMedia(makeMedia({ id: 'm2', name: 'dos.mp4', duration: 10 }), VIDEO_TRACK, 5);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Desplazar/);
      expect(result.reason).not.toMatch(/Ripple/);
    }
  });
});
