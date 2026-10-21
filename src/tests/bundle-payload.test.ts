import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createNewProject,
  duplicateProject,
  exportProjectToFile,
  getLastImportReport,
  importProjectFromFile,
  parseEmbeddedMedia,
  planMediaEmbedding,
  sanitizeImportedProject,
  serializeProjectForExport,
} from '../core/storage/projectStorage';
/**
 * El guardián de calidad (`quality-guard.test.ts`) exige que cada módulo de
 * producción sea USADO por un test: se importa el módulo pesado y se
 * referencia en una aserción de paridad (misma entrada, misma salida).
 */
import {
  duplicateProject as duplicarPesado,
  exportProjectToJson as exportarJsonPesado,
} from '../core/storage/projectStorageHeavy';

/**
 * División del payload inicial (W-M).
 *
 * Fija los tres límites del split sin cambiar comportamiento:
 * 1. la vista móvil no la paga el escritorio (`React.lazy` en `MainLayout`),
 * 2. el inspector vive en su propio chunk con un esqueleto de la misma caja,
 * 3. lo pesado de `projectStorage` (exportar/importar/duplicar) se descarga
 *    bajo demanda con la MISMA firma asíncrona.
 *
 * Patrón de aserciones de fuentes como `ui-polish.test.ts`: el texto del
 * módulo es el contrato del límite del chunk.
 */
const aqui = dirname(fileURLToPath(import.meta.url));
const fuente = (relativa: string): string =>
  readFileSync(join(aqui, '..', relativa), 'utf8');

describe('payload inicial · la vista móvil es un chunk diferido', () => {
  const mainLayout = fuente('components/layout/MainLayout.tsx');

  it('MainLayout carga MobileCapCutLayout con React.lazy', () => {
    expect(mainLayout).toContain("lazy(() => import('../mobile/MobileCapCutLayout'))");
  });

  it('MainLayout ya no importa la vista móvil de forma estática', () => {
    expect(mainLayout).not.toContain("from '../mobile/MobileCapCutLayout'");
  });

  it('la rama móvil envuelve el lazy en Suspense con ranura estable', () => {
    expect(mainLayout).toContain('MobileLayoutFallback');
    expect(mainLayout).toContain('<Suspense fallback={<MobileLayoutFallback />}>');
  });

  it('MobileCapCutLayout expone la exportación por defecto que pide React.lazy', () => {
    expect(fuente('components/mobile/MobileCapCutLayout.tsx')).toContain(
      'export default MobileCapCutLayout'
    );
  });
});

describe('payload inicial · el inspector es un chunk diferido', () => {
  const panel = fuente('components/inspector/InspectorPanel.tsx');

  it('InspectorPanel carga ClipInspector con React.lazy', () => {
    expect(panel).toContain("lazy(() => import('./ClipInspector'))");
  });

  it('InspectorPanel ya no importa el inspector de forma estática', () => {
    expect(panel).not.toContain("from './ClipInspector'");
  });

  it('el esqueleto ocupa exactamente la misma caja que el inspector real', () => {
    // La raíz del esqueleto clona la del ClipInspector real: sin
    // desbordamiento horizontal y sin mover la altura del visor.
    expect(panel).toContain('flex h-full min-h-0 flex-col overflow-y-auto bg-panel select-none');
    expect(panel).toContain('aria-hidden="true"');
  });

  it('la columna del inspector sigue siendo de 300 px con su estado vacío', () => {
    expect(panel).toContain('w-[300px]');
    expect(panel).toContain('inspector-empty');
  });

  it('el chunk del inspector se precalienta tras el primer pintado', () => {
    expect(panel).toContain("import('./ClipInspector')");
    expect(panel).toContain('void import');
  });

  it('ClipInspector expone la exportación por defecto que pide React.lazy', () => {
    expect(fuente('components/inspector/ClipInspector.tsx')).toContain(
      'export default ClipInspector'
    );
  });
});

describe('payload inicial · projectStorage pesado bajo demanda', () => {
  const ligero = fuente('core/storage/projectStorage.ts');
  const pesado = fuente('core/storage/projectStorageHeavy.ts');

  it('el módulo ligero delega con import() dinámico', () => {
    expect(ligero).toContain("import('./projectStorageHeavy')");
  });

  it('las implementaciones pesadas viven solo en el módulo pesado', () => {
    // La vía sin medios (`triggerProjectDownload`) es síncrona y queda en el
    // ligero a propósito: aquí se comprueba la parte pesada de verdad (cada
    // envoltorio del ligero solo delega al chunk bajo demanda).
    const bloqueDe = (fuente: string, firma: string): string => {
      const inicio = fuente.indexOf(firma);
      expect(inicio).toBeGreaterThan(-1);
      const fin = fuente.indexOf('\n}\n', inicio);
      expect(fin).toBeGreaterThan(inicio);
      return fuente.slice(inicio, fin);
    };
    for (const firma of [
      'export async function duplicateProject(',
      'export async function collectEmbeddedMedia(',
      'export async function restoreEmbeddedMedia(',
      'export async function importProjectFromFileWithReport(',
    ]) {
      expect(bloqueDe(pesado, firma)).not.toContain('projectStorageHeavy');
      expect(bloqueDe(ligero, firma)).toContain('projectStorageHeavy');
    }
    expect(ligero).not.toContain('exportWithEmbeddedMedia');
    expect(pesado).toContain('exportProjectWithEmbeddedMedia');
  });

  it('la API síncrona y pura sigue en el módulo ligero', () => {
    expect(parseEmbeddedMedia([])).toEqual([]);
    expect(planMediaEmbedding({ mediaPool: [], trash: [] } as never).skipped).toBe('no-media');
    const project = { mediaPool: [] } as never;
    expect(serializeProjectForExport(project).version).toBe(1);
    const saneado = sanitizeImportedProject(
      {
        tracks: [{ id: 't1', name: 'V1', type: 'video', isMuted: false, isLocked: false, isVisible: true }],
        clips: [],
      },
      { projectId: 'p', fallbackName: 'x' }
    );
    expect(saneado.project.tracks).toHaveLength(1);
  });

  it('exportProjectToFile sin medios resuelve el mismo sobre sin-medios', async () => {
    const project = await createNewProject('Demo');
    const resultado = await exportProjectToFile(project, 'hydra');
    expect(resultado.mediaEmbedded).toBe(false);
    expect(resultado.fileName).toBe('demo-sin-medios.hydra');
    expect(resultado.skipped).toBe('no-media');
  });

  it('duplicateProject de un id inexistente rechaza igual que antes', async () => {
    await expect(duplicateProject('proj_inexistente')).rejects.toThrow(
      'Proyecto no encontrado para duplicar'
    );
  });

  it('importProjectFromFile con JSON inválido rechaza igual que antes', async () => {
    const corrupto = new File(['{no json'], 'roto.hydra', { type: 'application/json' });
    await expect(importProjectFromFile(corrupto)).rejects.toThrow(
      'El archivo no contiene un formato JSON válido.'
    );
  });

  it('getLastImportReport sigue expuesto desde el módulo ligero', () => {
    expect(getLastImportReport()).toBeNull();
  });

  it('el módulo pesado responde igual que el ligero (paridad del split)', async () => {
    expect(typeof exportarJsonPesado).toBe('function');
    const project = await createNewProject('Paridad');
    const directo = await exportarJsonPesado(project);
    expect(directo.mediaEmbedded).toBe(false);
    expect(directo.fileName).toBe('paridad-sin-medios.json');
    await expect(duplicarPesado('proj_inexistente')).rejects.toThrow(
      'Proyecto no encontrado para duplicar'
    );
  });
});
