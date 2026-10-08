import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createNewProject,
  saveProject,
  getProjectById,
  listProjects,
  renameProject,
  duplicateProject,
  deleteProject,
  autosaveProject,
  loadAutosavedProject,
  serializeProjectForExport,
  importProjectFromFile,
  exportProjectToFile,
  extractMetadata,
  ACTIVE_PROJECT_KEY,
  AUTOSAVE_KEY,
  PROJECTS_INDEX_KEY,
} from '../core/storage/projectStorage';
import { Project } from '../types/project';

// In-memory IndexedDB simulator for idb-keyval
const memoryStore = new Map<string, any>();

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => memoryStore.get(key)),
  set: vi.fn(async (key: string, val: any) => {
    memoryStore.set(key, val);
  }),
  del: vi.fn(async (key: string) => {
    memoryStore.delete(key);
  }),
  keys: vi.fn(async () => Array.from(memoryStore.keys())),
  clear: vi.fn(async () => {
    memoryStore.clear();
  }),
}));

vi.mock('../core/storage/opfsStorage', () => ({
  getMediaFromOPFS: vi.fn(async () => null),
  saveMediaToOPFS: vi.fn(async () => 'saved_file'),
}));

describe('Multi-Project Client-Side Persistence (projectStorage)', () => {
  beforeEach(() => {
    memoryStore.clear();
    vi.clearAllMocks();

    if (typeof globalThis.URL.createObjectURL === 'undefined') {
      globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    }
    if (typeof globalThis.URL.revokeObjectURL === 'undefined') {
      globalThis.URL.revokeObjectURL = vi.fn();
    }
  });

  it('createNewProject creates a valid project with default tracks and saves to storage', async () => {
    const project = await createNewProject('Mi Primer Video', '16:9');

    expect(project).toBeDefined();
    expect(project.id).toMatch(/^proj_/);
    expect(project.name).toBe('Mi Primer Video');
    expect(project.aspectRatio).toBe('16:9');
    expect(project.resolution).toEqual({ width: 1920, height: 1080 });
    expect(project.tracks.length).toBe(4);
    expect(project.tracks.map((t) => t.type)).toEqual(['text', 'video', 'video', 'audio']);
    expect(project.duration).toBe(30);

    // Verify it is saved in memoryStore
    expect(memoryStore.get(PROJECTS_INDEX_KEY)).toBeDefined();
    const list = await listProjects();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(project.id);
    expect(list[0].name).toBe('Mi Primer Video');
    expect(list[0].tracksCount).toBe(4);
    expect(list[0].clipsCount).toBe(0);
  });

  it('createNewProject handles 9:16 vertical and 1:1 square aspect ratios', async () => {
    const vertical = await createNewProject('Vertical Reel', '9:16');
    expect(vertical.resolution).toEqual({ width: 1080, height: 1920 });

    const square = await createNewProject('Square Post', '1:1');
    expect(square.resolution).toEqual({ width: 1080, height: 1080 });
  });

  it('saveProject and getProjectById round-trip successfully', async () => {
    const proj = await createNewProject('Proyecto Guardado');
    proj.clips.push({
      id: 'clip_test_1',
      trackId: proj.tracks[1].id,
      mediaId: 'media_1',
      name: 'Video Clip',
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
    });
    await saveProject(proj);

    const retrieved = await getProjectById(proj.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(proj.id);
    expect(retrieved?.clips.length).toBe(1);
    expect(retrieved?.clips[0].name).toBe('Video Clip');

    // Index must reflect updated clip count
    const list = await listProjects();
    expect(list[0].clipsCount).toBe(1);
  });

  it('getProjectById returns null for nonexistent id', async () => {
    const result = await getProjectById('proj_nonexistent_999');
    expect(result).toBeNull();
  });

  it('listProjects returns projects sorted by updatedAt descending', async () => {
    const p1 = await createNewProject('Proyecto 1');
    // Simulate elapsed time
    await new Promise((r) => setTimeout(r, 10));
    const p2 = await createNewProject('Proyecto 2');
    await new Promise((r) => setTimeout(r, 10));
    const p3 = await createNewProject('Proyecto 3');

    const list = await listProjects();
    expect(list.length).toBe(3);
    expect(list[0].id).toBe(p3.id);
    expect(list[1].id).toBe(p2.id);
    expect(list[2].id).toBe(p1.id);

    // Updating p1 should bring it to the top
    p1.updatedAt = Date.now() + 1000;
    await saveProject(p1);

    const reorderedList = await listProjects();
    expect(reorderedList[0].id).toBe(p1.id);
  });

  it('renameProject updates both project record and metadata index', async () => {
    const proj = await createNewProject('Nombre Antiguo');
    await renameProject(proj.id, 'Nombre Renovado');

    const updated = await getProjectById(proj.id);
    expect(updated?.name).toBe('Nombre Renovado');

    const list = await listProjects();
    expect(list.find((p) => p.id === proj.id)?.name).toBe('Nombre Renovado');
  });

  it('duplicateProject creates an independent clone with new IDs and (Copia) suffix', async () => {
    const original = await createNewProject('Video Original');
    original.clips.push({
      id: 'clip_orig_1',
      trackId: original.tracks[1].id,
      mediaId: 'm1',
      name: 'Clip Original',
      type: 'video',
      start: 2,
      duration: 8,
      sourceStart: 0,
      sourceDuration: 8,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    });
    await saveProject(original);

    const duplicate = await duplicateProject(original.id);

    expect(duplicate.id).not.toBe(original.id);
    expect(duplicate.name).toBe('Video Original (Copia)');
    expect(duplicate.tracks.length).toBe(original.tracks.length);
    expect(duplicate.clips.length).toBe(1);
    expect(duplicate.clips[0].id).not.toBe('clip_orig_1');
    expect(duplicate.clips[0].name).toBe('Clip Original');

    // Modifying duplicate does not affect original
    duplicate.name = 'Copia Modificada';
    await saveProject(duplicate);

    const refreshedOriginal = await getProjectById(original.id);
    expect(refreshedOriginal?.name).toBe('Video Original');

    const list = await listProjects();
    expect(list.length).toBe(2);
  });

  it('duplicateProject accepts a custom new name', async () => {
    const original = await createNewProject('Podcast Ep 1');
    const duplicate = await duplicateProject(original.id, 'Podcast Ep 2');

    expect(duplicate.name).toBe('Podcast Ep 2');
  });

  it('duplicateProject throws when project does not exist', async () => {
    await expect(duplicateProject('proj_inexistente')).rejects.toThrow();
  });

  it('deleteProject removes project from storage and metadata index', async () => {
    const p1 = await createNewProject('A Borrar');
    const p2 = await createNewProject('A Conservar');

    expect((await listProjects()).length).toBe(2);

    await deleteProject(p1.id);

    expect((await listProjects()).length).toBe(1);
    expect(await getProjectById(p1.id)).toBeNull();
    expect(await getProjectById(p2.id)).not.toBeNull();
  });

  it('autosaveProject updates legacy autosave key and active project', async () => {
    const proj = await createNewProject('Autosaved Video');
    proj.duration = 45;
    await autosaveProject(proj);

    const loaded = await loadAutosavedProject();
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(proj.id);
    expect(loaded?.duration).toBe(45);

    expect(memoryStore.get(AUTOSAVE_KEY)).toBeDefined();
    expect(memoryStore.get(ACTIVE_PROJECT_KEY)).toBe(proj.id);
  });

  it('loadAutosavedProject falls back to legacy autosave key if active ID is absent', async () => {
    const legacyProject: Project = {
      id: 'proj_legacy_1',
      name: 'Legacy Project',
      aspectRatio: '16:9',
      resolution: { width: 1920, height: 1080 },
      fps: 30,
      tracks: [{ id: 't1', name: 'V1', type: 'video', isMuted: false, isLocked: false, isVisible: true }],
      clips: [],
      mediaPool: [],
      duration: 30,
      createdAt: 1000,
      updatedAt: 1000,
    };
    memoryStore.set(AUTOSAVE_KEY, legacyProject);

    const loaded = await loadAutosavedProject();
    expect(loaded?.id).toBe('proj_legacy_1');
    expect(loaded?.name).toBe('Legacy Project');
  });

  it('serializeProjectForExport produces valid schema envelope', async () => {
    const proj = await createNewProject('Proyecto a Exportar');
    const envelope = serializeProjectForExport(proj);

    expect(envelope.version).toBe(1);
    expect(envelope.app).toBe('HydraCut');
    expect(typeof envelope.exportedAt).toBe('number');
    expect(envelope.project).toEqual(proj);
  });

  it('exportProjectToFile triggers download without error in document environment', async () => {
    const proj = await createNewProject('Proyecto Descargable');

    const appendChildSpy = vi.fn();
    const removeChildSpy = vi.fn();
    const clickSpy = vi.fn();

    const originalDocument = globalThis.document;
    // Mock minimal DOM
    globalThis.document = {
      createElement: vi.fn(() => ({
        href: '',
        download: '',
        click: clickSpy,
      })) as any,
      body: {
        appendChild: appendChildSpy,
        removeChild: removeChildSpy,
      } as any,
    } as any;

    try {
      exportProjectToFile(proj, 'hydra');
      expect(clickSpy).toHaveBeenCalled();
      expect(appendChildSpy).toHaveBeenCalled();
      expect(removeChildSpy).toHaveBeenCalled();
    } finally {
      globalThis.document = originalDocument;
    }
  });

  it('importProjectFromFile parses enveloped .hydra project file and persists to IndexedDB', async () => {
    const original = await createNewProject('Import Me Enveloped');
    const envelope = serializeProjectForExport(original);
    const jsonStr = JSON.stringify(envelope);

    const file = new File([jsonStr], 'video_test.hydra', { type: 'application/json' });
    const imported = await importProjectFromFile(file);

    expect(imported).toBeDefined();
    expect(imported.name).toBe('Import Me Enveloped');
    expect(imported.tracks.length).toBe(4);

    // Verify it is saved in IndexedDB
    const retrieved = await getProjectById(imported.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(imported.id);
  });

  it('importProjectFromFile parses raw Project JSON format (backward compatibility)', async () => {
    const rawProject: Project = {
      id: 'proj_raw_123',
      name: 'Raw Format Video',
      aspectRatio: '9:16',
      resolution: { width: 1080, height: 1920 },
      fps: 30,
      tracks: [
        { id: 't_raw', name: 'V1', type: 'video', isMuted: false, isLocked: false, isVisible: true },
      ],
      clips: [],
      mediaPool: [],
      duration: 15,
      createdAt: 2000,
      updatedAt: 2000,
    };
    const jsonStr = JSON.stringify(rawProject);

    const file = new File([jsonStr], 'raw_format.json', { type: 'application/json' });
    const imported = await importProjectFromFile(file);

    expect(imported.name).toBe('Raw Format Video');
    expect(imported.aspectRatio).toBe('9:16');
    expect(imported.tracks.length).toBe(1);

    const list = await listProjects();
    expect(list.some((p) => p.name === 'Raw Format Video')).toBe(true);
  });

  it('importProjectFromFile throws meaningful error on invalid JSON or corrupt schema', async () => {
    const corruptFile = new File(['{ invalid json content '], 'bad.json', { type: 'application/json' });
    await expect(importProjectFromFile(corruptFile)).rejects.toThrow('El archivo no contiene un formato JSON válido.');

    const missingTracksFile = new File([JSON.stringify({ name: 'No Tracks' })], 'incomplete.json', {
      type: 'application/json',
    });
    await expect(importProjectFromFile(missingTracksFile)).rejects.toThrow('Archivo de proyecto no válido');
  });

  it('extractMetadata correctly calculates track and clip counts', () => {
    const dummy: Project = {
      id: 'p_meta',
      name: 'Meta Project',
      aspectRatio: '1:1',
      resolution: { width: 1080, height: 1080 },
      fps: 30,
      tracks: [
        { id: 't1', name: 'T1', type: 'text', isMuted: false, isLocked: false, isVisible: true },
        { id: 't2', name: 'V1', type: 'video', isMuted: false, isLocked: false, isVisible: true },
      ],
      clips: [
        {
          id: 'c1',
          trackId: 't1',
          mediaId: '',
          name: 'Text Clip',
          type: 'text',
          start: 0,
          duration: 5,
          sourceStart: 0,
          sourceDuration: 5,
          volume: 0,
          opacity: 1,
          scale: 1,
          positionX: 0,
          positionY: 0,
          muted: true,
        },
      ],
      mediaPool: [],
      duration: 20,
      createdAt: 100,
      updatedAt: 200,
    };

    const meta = extractMetadata(dummy);
    expect(meta.id).toBe('p_meta');
    expect(meta.name).toBe('Meta Project');
    expect(meta.aspectRatio).toBe('1:1');
    expect(meta.tracksCount).toBe(2);
    expect(meta.clipsCount).toBe(1);
    expect(meta.duration).toBe(20);
    expect(meta.createdAt).toBe(100);
    expect(meta.updatedAt).toBe(200);
  });
});
