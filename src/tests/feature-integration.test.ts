/**
 * Integración de la ola (W-H): los cabos sueltos entre el store y la UI.
 *
 * El store ya sabe hacer estas cosas (`pendingExportRange`,
 * `resolveDeleteKind`, `sanitizeMarkers`), pero partes de la UI no los
 * alcanzaban. Cada bloque guarda la costura en el nivel más barato:
 * lo puro con el comportamiento real y lo React con su fuente (mismo
 * patrón que `shortcuts.test.ts`: no hay jsdom instalado).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

import { useProjectStore, resolveDeleteKind } from '../store/useProjectStore';
import { sanitizeImportedProject } from '../core/storage/projectStorage';
import { consumePendingExportRange } from '../components/export/ExportModal';

const SRC = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const MAIN_LAYOUT = () => SRC('../components/layout/MainLayout.tsx');
const SHORTCUTS_MODAL = () => SRC('../components/modals/ShortcutsModal.tsx');
const EXPORT_MODAL = () => SRC('../components/export/ExportModal.tsx');

beforeEach(() => {
  useProjectStore.getState().resetProject();
});

/* ------------------------------------------------------------------ */
/* 1. El diálogo de exportación consume el rango pendiente             */
/* ------------------------------------------------------------------ */

describe('1. ExportModal consume pendingExportRange (puente de marcadores)', () => {
  it('consumePendingExportRange convierte el par E/S en un rango personalizado', () => {
    expect(consumePendingExportRange({ start: 2, end: 9 })).toEqual({
      mode: 'custom',
      start: 2,
      end: 9,
    });
  });

  it('consumePendingExportRange devuelve null sin rango completo u ordenado', () => {
    expect(consumePendingExportRange({ start: null, end: null })).toBeNull();
    expect(consumePendingExportRange({ start: 2, end: null })).toBeNull();
    expect(consumePendingExportRange({ start: null, end: 9 })).toBeNull();
    expect(consumePendingExportRange({ start: 5, end: 5 })).toBeNull();
    expect(consumePendingExportRange({ start: 9, end: 2 })).toBeNull();
    expect(consumePendingExportRange({ start: Number.NaN, end: 9 })).toBeNull();
  });

  it('el puente store → diálogo funciona: par de marcadores que el modal entiende', () => {
    const a = useProjectStore.getState().addMarker(2);
    const b = useProjectStore.getState().addMarker(9);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(
      useProjectStore.getState().applyMarkerPairToExportRange(a!.id, b!.id)
    ).toBe(true);
    const pendiente = useProjectStore.getState().pendingExportRange;
    expect(pendiente).toEqual({ start: 2, end: 9 });
    expect(consumePendingExportRange(pendiente)).toEqual({
      mode: 'custom',
      start: 2,
      end: 9,
    });
  });

  it('el modal lee pendingExportRange, lo limpia y ofrece «Desde marcador»', () => {
    const source = EXPORT_MODAL();
    expect(source).toContain('pendingExportRange');
    expect(source).toContain('clearPendingExportRange');
    expect(source).toContain('export-range-from-markers');
    expect(source).toContain('Desde marcador');
  });
});

/* ------------------------------------------------------------------ */
/* 2. Mayús+Supr llega a rippleDeleteClip vía resolveDeleteKind        */
/* ------------------------------------------------------------------ */

describe('2. MainLayout decide el borrado con resolveDeleteKind', () => {
  it('Mayús+Supr/Retroceso es ripple, Supr solo es simple, otra tecla es null', () => {
    expect(resolveDeleteKind({ key: 'Delete', shiftKey: true })).toBe('ripple');
    expect(resolveDeleteKind({ key: 'Backspace', shiftKey: true })).toBe('ripple');
    expect(resolveDeleteKind({ key: 'Delete' })).toBe('plain');
    expect(resolveDeleteKind({ key: 'Backspace', shiftKey: false })).toBe('plain');
    expect(resolveDeleteKind({ key: 'm', shiftKey: true })).toBeNull();
  });

  it('MainLayout usa resolveDeleteKind (no su propio criterio) y alcanza rippleDeleteClip', () => {
    const source = MAIN_LAYOUT();
    expect(source).toContain('resolveDeleteKind');
    expect(source).toContain('rippleDeleteClip');
    // El criterio propio antiguo debe desaparecer.
    expect(source).not.toContain("e.key === 'Delete' || e.key === 'Backspace'");
  });
});

/* ------------------------------------------------------------------ */
/* 2b. ShortcutsModal documenta los atajos nuevos                      */
/* ------------------------------------------------------------------ */

describe('2b. ShortcutsModal lista los atajos nuevos en español', () => {
  it('el modal lista Mayús+Supr/Retroceso (cerrar hueco)', () => {
    const source = SHORTCUTS_MODAL();
    expect(source).toContain('Mayús + Supr');
    expect(source).toContain('cerrar el hueco');
  });

  it('el modal lista M (marcador)', () => {
    const source = SHORTCUTS_MODAL();
    expect(source).toContain('Añadir marcador en el cabezal');
  });

  it('el modal lista Ctrl+G (ir a timecode)', () => {
    const source = SHORTCUTS_MODAL();
    expect(source).toContain('Ctrl + G');
    expect(source).toContain('Ir al timecode');
  });

  it('el modal lista Q/W (recortar al cabezal)', () => {
    const source = SHORTCUTS_MODAL();
    expect(source).toContain('Recortar el inicio del clip al cabezal');
    expect(source).toContain('Recortar el final del clip al cabezal');
  });

  it('el modal lista G (áreas seguras)', () => {
    const source = SHORTCUTS_MODAL();
    expect(source).toContain('áreas seguras');
  });
});

/* ------------------------------------------------------------------ */
/* 3. La importación sanea los marcadores                              */
/* ------------------------------------------------------------------ */

describe('3. sanitizeImportedProject sanea los marcadores', () => {
  const pista = {
    id: 't1',
    name: 'Vídeo V1',
    type: 'video' as const,
    isMuted: false,
    isLocked: false,
    isVisible: true,
  };

  it('tiempos inválidos fuera, ids reparados y duplicados renombrados', () => {
    const { project, warnings } = sanitizeImportedProject(
      {
        tracks: [pista],
        clips: [],
        fps: 30,
        markers: [
          { id: 'fuera', time: -2, name: 'Negativo' },
          { id: 'dup', time: 1, name: 'A' },
          { id: 'dup', time: 2, name: 'B' },
          { id: '', time: 1.5, name: '   ' },
          'basura',
          null,
        ] as unknown as [],
      },
      { projectId: 'p1', fallbackName: 'Importado' }
    );

    const marcadores = project.markers ?? [];
    // El tiempo negativo y la basura no entran; los duplicados se reparan.
    expect(marcadores).toHaveLength(3);
    expect(marcadores.every((m) => Number.isFinite(m.time) && m.time >= 0)).toBe(true);
    expect(marcadores.every((m) => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
    expect(new Set(marcadores.map((m) => m.id)).size).toBe(3);
    expect(marcadores.every((m) => m.name.trim().length > 0)).toBe(true);
    // Orden cronológico de la regla.
    expect(marcadores.map((m) => m.time)).toEqual(
      [...marcadores.map((m) => m.time)].sort((x, y) => x - y)
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('sin marcadores el proyecto importado queda sin marcadores y sin avisos de más', () => {
    const { project } = sanitizeImportedProject(
      { tracks: [pista], clips: [], fps: 30 },
      { projectId: 'p1', fallbackName: 'Importado' }
    );
    expect(project.markers ?? []).toEqual([]);
  });
});
