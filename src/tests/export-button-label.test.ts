/**
 * Etiqueta accesible del botón de exportar + CROSSFADE-LOCKED como check normal.
 *
 * 1) El botón de exportar existe en dos shells (escritorio y móvil) y ofrece
 *    MP4 y WebM: su nombre accesible no puede prometer un formato ni diferir
 *    entre shells. El canónico es «Exportar vídeo» (docs/copy.md U6, con
 *    acento) y ambos exponen `data-testid="export-open-button"` para que el
 *    harness no dependa de ninguna cadena legible (prefiere el testid y
 *    mantiene las etiquetas antiguas como último recurso). El móvil aún
 *    expone el nombre heredado («Abrir modal de exportación de vídeo»): su
 *    migración es del worker móvil (informe audit2); este suite la acepta
 *    como valor transitorio pero exige que el escritorio ya sea canónico.
 * 2) CROSSFADE-LOCKED ya no documenta un defecto: el Inspector mantiene
 *    «Crear fundido» visible y deshabilitado con la pista bloqueada, así que
 *    la suite afirma ese comportamiento como check normal (`report.check`),
 *    no como known-issue (`report.known`).
 *
 * Patrón de `ui-polish.test.ts`: lógica sobre la fuente, sin jsdom. Cada
 * test extrae los valores con regex y compara propiedades entre archivos, de
 * modo que falla si solo se cambia un shell o si se revierte la aserción.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

function sourceOf(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

/** Todos los `aria-label="…"` de una fuente. */
function ariaLabelsOf(source: string): string[] {
  return Array.from(source.matchAll(/aria-label="([^"]*)"/g)).map((m) => m[1]);
}

/** El nombre accesible del botón de exportar: el único con «exportar». */
function exportAccessibleName(source: string): string | null {
  const found = ariaLabelsOf(source).filter((l) =>
    l.toLowerCase().includes('exportar') || l.toLowerCase().includes('exportación')
  );
  return found.length === 1 ? found[0] : null;
}

/** Nombre heredado del botón (previo a docs/copy.md U6): solo transitorio. */
const NOMBRE_HEREDADO = 'Abrir modal de exportación de vídeo';

describe('botón de exportar: nombre accesible único y agnóstico al formato', () => {
  it('el escritorio nombra la acción («Exportar vídeo», con acento, sin MP4)', () => {
    const header = sourceOf('../components/layout/Header.tsx');
    expect(exportAccessibleName(header)).toBe('Exportar vídeo');
    expect(header).not.toContain('video MP4');
    // Ningún nombre accesible del header promete un formato.
    for (const label of ariaLabelsOf(header)) {
      expect(label).not.toContain('MP4');
    }
  });

  it('el móvil usa el MISMO nombre accesible que el escritorio (o el heredado, en migración)', () => {
    const header = sourceOf('../components/layout/Header.tsx');
    const mobile = sourceOf('../components/mobile/MobileHeader.tsx');
    // En cuanto el worker móvil aplique docs/copy.md U6, el móvil coincide
    // con el escritorio; mientras tanto se acepta el heredado.
    expect([exportAccessibleName(header), NOMBRE_HEREDADO]).toContain(
      exportAccessibleName(mobile)
    );
    for (const label of ariaLabelsOf(mobile)) {
      expect(label).not.toContain('MP4');
    }
  });

  it('la etiqueta visible sigue en español con acento y sin prometer formato', () => {
    const header = sourceOf('../components/layout/Header.tsx');
    expect(header).toContain('Exportar vídeo');
    expect(header).not.toContain('>MP4<');
  });

  it('ambos shells exponen el testid y el harness lo prefiere (la etiqueta antigua sigue como recurso)', () => {
    const header = sourceOf('../components/layout/Header.tsx');
    const mobile = sourceOf('../components/mobile/MobileHeader.tsx');
    for (const source of [header, mobile]) {
      expect(source).toContain('data-testid="export-open-button"');
    }
    const harness = sourceOf('./browser/browser-harness.mjs');
    // El selector principal es un alias del testid (no de una cadena legible).
    expect(harness).toContain('export const EXPORT_BUTTON_SELECTOR = EXPORT_BUTTON_TESTID_SELECTOR');
    const testidSelector = harness.match(/export const EXPORT_BUTTON_TESTID_SELECTOR = '([^']*)'/);
    expect(testidSelector).not.toBeNull();
    expect(testidSelector?.[1]).toContain('[data-testid="export-open-button"]');
    // Compatibilidad: la etiqueta nueva y la antigua siguen cableadas como
    // recurso en `openExportModal` (páginas con el bundle anterior).
    expect(harness).toContain('EXPORT_BUTTON_LABEL_SELECTOR');
    expect(harness).toContain('EXPORT_BUTTON_LEGACY_SELECTOR');
    expect(harness).toContain('Abrir modal de exportación de video MP4');
    const openModal = harness.slice(harness.indexOf('export async function openExportModal'));
    expect(openModal).toContain('EXPORT_BUTTON_LEGACY_SELECTOR');
  });
});

describe('CROSSFADE-LOCKED: check normal del comportamiento correcto', () => {
  it('afirma botón presente + deshabilitado + motivo, no su desaparición', () => {
    const recent = sourceOf('./browser/suite-recent.mjs');
    expect(recent).toContain(
      'lockState.createPresent && lockState.createDisabled === true && reasonOk'
    );
    expect(recent).not.toContain('!lockState.createPresent');
    expect(recent).not.toContain('DESAPARECE');
  });

  it('ya no usa el mecanismo de known-issue para este escenario', () => {
    const recent = sourceOf('./browser/suite-recent.mjs');
    expect(recent).not.toContain('report.known');
    expect(recent).toContain('report.check(k.id, k.title, k.ok, k.message, k.details)');
    // El escenario de pista bloqueada se sigue verificando (no se debilitó).
    expect(recent).toContain("id: 'CROSSFADE-LOCKED'");
    expect(recent).toContain('Bloquear pista');
  });
});
