import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createNewProject,
  saveProject,
  getProjectById,
  listProjects,
  deleteProject,
  importProjectFromFile,
  serializeProjectForExport,
  PROJECT_PREFIX,
} from '../core/storage/projectStorage';

const memoryStore = new Map<string, any>();

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => memoryStore.get(key)),
  set: vi.fn(async (key: string, val: any) => {
    memoryStore.set(key, val);
  }),
  del: vi.fn(async (key: string) => {
    memoryStore.delete(key);
  }),
}));

vi.mock('../core/storage/opfsStorage', () => ({
  getMediaFromOPFS: vi.fn(async () => null),
  saveMediaToOPFS: vi.fn(async () => 'saved_file'),
}));

describe('projectStorage hardening (HydraCut loops)', () => {
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

  it('createNewProject genera track IDs únicos entre proyectos', async () => {
    const a = await createNewProject('A');
    const b = await createNewProject('B');
    const idsA = new Set(a.tracks.map((t) => t.id));
    const idsB = new Set(b.tracks.map((t) => t.id));
    expect(idsA.size).toBe(a.tracks.length);
    expect(idsB.size).toBe(b.tracks.length);
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }
  });

  it('importProjectFromFile no sobrescribe un proyecto existente con el mismo id', async () => {
    const original = await createNewProject('Original');
    original.name = 'Original-vivo';
    await saveProject(original);

    const envelope = serializeProjectForExport({
      ...original,
      name: 'Importado-mismo-id',
    });
    const file = new File([JSON.stringify(envelope)], 'dup.hydra', {
      type: 'application/json',
    });
    const imported = await importProjectFromFile(file);

    expect(imported.id).not.toBe(original.id);
    const kept = await getProjectById(original.id);
    expect(kept?.name).toBe('Original-vivo');
    expect(imported.name).toBe('Importado-mismo-id');
  });

  it('deleteProject deja como activo el más reciente (orden updatedAt)', async () => {
    const p1 = await createNewProject('P1');
    await new Promise((r) => setTimeout(r, 12));
    const p2 = await createNewProject('P2');
    await new Promise((r) => setTimeout(r, 12));
    const p3 = await createNewProject('P3');

    // El activo tras crear es p3; borramos p3 y debe quedar el más reciente (p2)
    await deleteProject(p3.id);
    const { getActiveProjectId } = await import('../core/storage/projectStorage');
    // p1/p2 existen; manipulamos updatedAt para forzar orden: p1 más nuevo
    const r1 = await getProjectById(p1.id);
    if (r1) {
      r1.updatedAt = Date.now() + 5000;
      await saveProject(r1);
    }
    // Borramos p2 -> el activo debe pasar a p1 (el más reciente)
    await deleteProject(p2.id);
    const active = await getActiveProjectId();
    expect(active).toBe(p1.id);
    const list = await listProjects();
    expect(list.map((p) => p.id)).toContain(p1.id);
  });

  it('saveProject persiste el documento bajo hydra_project_<id>', async () => {
    const p = await createNewProject('Roundtrip');
    const raw = memoryStore.get(`${PROJECT_PREFIX}${p.id}`);
    expect(raw).toBeDefined();
    expect(raw.id).toBe(p.id);
  });
});
