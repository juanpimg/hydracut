/**
 * Guardia UI-PC (auditoría audit2): contraste real de tokens, foco visible,
 * secciones del inspector, transporte a 1024 px, copy migrado, formateadores
 * compartidos y restos del aspecto anterior.
 *
 * Sin jsdom (patrón del resto de suites): el contraste se calcula de verdad
 * a partir de los hex de `tailwind.config.js` (WCAG 2.1, luminancia relativa)
 * y el cableado de los componentes se afirma sobre su fuente.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

function fuente(rutaRelativa: string): string {
  return readFileSync(new URL(rutaRelativa, import.meta.url), 'utf8');
}

/* ------------------------------------------------------------------ */
/* Contraste WCAG real sobre los tokens del config                      */
/* ------------------------------------------------------------------ */

/** Extrae el hex de un token del config (minúsculas, sin `#`). */
function hexDeToken(config: string, patron: RegExp): string {
  const coincidencia = config.match(patron);
  if (!coincidencia) throw new Error(`token no encontrado: ${patron}`);
  return coincidencia[1].toLowerCase();
}

function luminanciaRelativa(hex: string): number {
  const canal = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * canal(0) + 0.7152 * canal(2) + 0.0722 * canal(4);
}

/** Razón de contraste WCAG 2.1 entre dos hex (sin `#`, minúsculas). */
export function razonContraste(a: string, b: string): number {
  const [claro, oscuro] = [luminanciaRelativa(a), luminanciaRelativa(b)].sort(
    (x, y) => y - x
  );
  return (claro + 0.05) / (oscuro + 0.05);
}

const config = fuente('../../tailwind.config.js').toLowerCase();

describe('H4 · los pares de tokens prometidos alcanzan 4.5:1 de verdad', () => {
  const panel = hexDeToken(config, /panel:\s*'#([0-9a-f]{6})'/);
  const raised = hexDeToken(config, /raised:\s*'#([0-9a-f]{6})'/);
  const texto3 = hexDeToken(config, /3:\s*'#([0-9a-f]{6})'/);
  const relleno = hexDeToken(config, /fill:\s*'#([0-9a-f]{6})'/);

  it('text-3 sobre panel alcanza 4.5:1', () => {
    expect(razonContraste(texto3, panel)).toBeGreaterThanOrEqual(4.5);
  });

  it('text-3 sobre raised alcanza 4.5:1', () => {
    expect(razonContraste(texto3, raised)).toBeGreaterThanOrEqual(4.5);
  });

  it('blanco sobre accent-fill alcanza 4.5:1 (botón primario)', () => {
    expect(razonContraste('ffffff', relleno)).toBeGreaterThanOrEqual(4.5);
  });

  it('el alias dark-500 y la variable CSS usan el mismo text-3', () => {
    const css = fuente('../index.css').toLowerCase();
    expect(config).toContain(`500: '#${texto3}'`);
    expect(css).toContain(`--hc-text-3: #${texto3}`);
  });
});

/* ------------------------------------------------------------------ */
/* H3 · el inspector no anula el anillo de foco global                  */
/* ------------------------------------------------------------------ */

describe('H3 · ningún control del inspector anula el foco visible', () => {
  const inspector = fuente('../components/inspector/ClipInspector.tsx');

  it('no queda ningún `focus-visible:outline-none`', () => {
    expect(inspector).not.toContain('focus-visible:outline-none');
  });

  it('no queda ningún `outline-none` que tape el anillo global', () => {
    expect(inspector).not.toContain('outline-none');
  });
});

/* ------------------------------------------------------------------ */
/* H5 · como mucho 5 secciones expandidas, controles montados           */
/* ------------------------------------------------------------------ */

describe('H5 · el inspector abre como mucho 5 secciones', () => {
  const inspector = fuente('../components/inspector/ClipInspector.tsx');

  it('Keyframes y Fundidos arrancan colapsados (el resto, 5 en un clip de vídeo)', () => {
    const cerradas = Array.from(
      inspector.matchAll(/<Section titulo="([^"]+)" abiertaPorDefecto=\{false\}/g)
    ).map((m) => m[1]);
    expect(cerradas.sort()).toEqual(['Fundidos', 'Keyframes de animación']);
  });

  it('Fundido de cruce y Audio arrancan abiertos (la suite exige sus avisos visibles)', () => {
    expect(inspector).not.toMatch(/<Section titulo="Fundido de cruce" abiertaPorDefecto/);
    expect(inspector).not.toMatch(/<Section titulo="Audio" abiertaPorDefecto/);
  });

  it('las secciones colapsadas siguen montadas (hidden, sin desmontar)', () => {
    const seccion = fuente('../components/ui/Section.tsx');
    expect(seccion).toContain('hidden={!abierta}');
    expect(seccion).not.toContain('{abierta &&');
  });
});

/* ------------------------------------------------------------------ */
/* H2 · transporte correcto desde 1024 px                               */
/* ------------------------------------------------------------------ */

describe('H2 · el transporte no se solapa a 1024 px', () => {
  const controles = fuente('../components/player/PlayerControls.tsx');
  const deslizador = fuente('../components/ui/Slider.tsx');

  it('la barra usa una rejilla de 3 columnas que no puede solaparse', () => {
    expect(controles).toContain('grid');
    expect(controles).toContain('minmax(0,1fr)');
    expect(controles).not.toMatch(/justify-between/);
  });

  it('la etiqueta de volumen se oculta bajo lg (el control y su aria quedan)', () => {
    expect(controles).toContain('label="Volumen general"');
    expect(deslizador).toContain('labelHiddenBelowLg');
    expect(controles).toContain('labelHiddenBelowLg');
  });
});

/* ------------------------------------------------------------------ */
/* M1 · una sola cabecera «Inspector»                                   */
/* ------------------------------------------------------------------ */

describe('M1 · el panel del inspector tiene una sola cabecera', () => {
  it('el panel conserva la cabecera y el inspector ya no la duplica', () => {
    const panel = fuente('../components/inspector/InspectorPanel.tsx');
    const inspector = fuente('../components/inspector/ClipInspector.tsx');
    expect(panel).toContain('Inspector');
    expect(inspector).not.toContain('>Inspector<');
  });
});

/* ------------------------------------------------------------------ */
/* M4 · copy del diálogo de exportación (docs/copy.md U6)                */
/* ------------------------------------------------------------------ */

describe('M4 · el diálogo de exportación usa el copy aprobado', () => {
  const modal = fuente('../components/export/ExportModal.tsx');
  const cabecera = fuente('../components/layout/Header.tsx');

  it('el progreso usa «Exportación lista» (sin júbilo)', () => {
    expect(modal).toContain('Exportación lista');
  });

  it('el diálogo se nombra «Exportar vídeo» por labelledby', () => {
    expect(modal).toContain('aria-labelledby="export-dialog-title"');
    expect(modal).toContain('id="export-dialog-title"');
  });

  it('el cierre se llama «Cerrar» y la barra de progreso lleva acento', () => {
    expect(modal).toContain('aria-label="Cerrar"');
    expect(modal).toContain('aria-label="Progreso de exportación de vídeo"');
  });

  it('el resumen usa las etiquetas cortas aprobadas', () => {
    for (const etiqueta of ['>Duración:<', '>Fotogramas:<', '>Clips:<', '>Rango:<']) {
      expect(modal).toContain(etiqueta);
    }
  });

  it('el botón de exportar de la barra nombra la acción', () => {
    expect(cabecera).toContain('aria-label="Exportar vídeo"');
    expect(cabecera).not.toContain('Abrir modal de exportación');
  });
});

/* ------------------------------------------------------------------ */
/* M5 · «Color» / «Preajuste» (términos aprobados)                       */
/* ------------------------------------------------------------------ */

describe('M5 · la sección de color usa los términos aprobados', () => {
  const inspector = fuente('../components/inspector/ClipInspector.tsx');

  it('el título es «Color» y la etiqueta «Preajuste de color:»', () => {
    expect(inspector).toContain('titulo="Color"');
    expect(inspector).toContain('Preajuste de color:');
    expect(inspector).toContain('aria-label="Preajuste de color del clip"');
    expect(inspector).not.toContain('Color del Clip');
    expect(inspector).not.toContain('Preset de color');
  });
});

/* ------------------------------------------------------------------ */
/* M6 · el diálogo cabe en 560 px                                       */
/* ------------------------------------------------------------------ */

describe('M6 · el diálogo de exportación tiene cota y cabe', () => {
  const modal = fuente('../components/export/ExportModal.tsx');

  it('el panel lleva max-h 560 y el contenido puede desplazarse como red', () => {
    expect(modal).toContain('max-h-[min(560px,calc(100dvh-3rem))]');
    expect(modal).toContain('overflow-y-auto');
  });
});

/* ------------------------------------------------------------------ */
/* M7/M8 · un formateador compartido con coma decimal y espacio         */
/* ------------------------------------------------------------------ */

describe('M7/M8 · un formateador compartido para duraciones y tamaños', () => {
  it('el módulo compartido existe y usa coma decimal con espacio', async () => {
    const { formatearDuracion, formatearBytes, formatearBitrate } = await import(
      '../utils/formato'
    );
    expect(formatearDuracion(0.8)).toBe('0,8 s');
    expect(formatearDuracion(5)).toBe('5,0 s');
    expect(formatearBytes(1536)).toBe('1,5 KB');
    expect(formatearBitrate(8000, 10)).toBe('6,4 kbps');
  });

  it('el diálogo de exportar y la tarjeta usan el formateador compartido', () => {
    const modal = fuente('../components/export/ExportModal.tsx');
    const tarjeta = fuente('../components/media/MediaItemCard.tsx');
    const inspector = fuente('../components/inspector/ClipInspector.tsx');
    for (const origen of [modal, tarjeta]) {
      expect(origen).toContain('utils/formato');
    }
    expect(inspector).toContain('formatearDuracion');
    expect(inspector).not.toContain('.toFixed(1)}s');
  });

  it('la ETA deja aire antes de la unidad', async () => {
    const { formatExportEta } = await import('../components/export/ExportModal');
    expect(formatExportEta('rendering', 5)).toBe('~5 s');
  });
});

/* ------------------------------------------------------------------ */
/* M8 (caja de error) · L1 · L2                                         */
/* ------------------------------------------------------------------ */

describe('M8 · la caja de error de la tarjeta es compacta', () => {
  const tarjeta = fuente('../components/media/MediaItemCard.tsx');

  it('una línea con tooltip, manteniendo role=alert y testid', () => {
    expect(tarjeta).toContain('data-testid="media-card-refusal"');
    expect(tarjeta).toContain('role="alert"');
    expect(tarjeta).toContain('truncate');
    expect(tarjeta).toContain('title={refusal}');
  });
});

describe('L1/L2 · cajas internas con radio 6 y duración tabular', () => {
  it('el inspector no usa rounded-lg en sus cajas internas', () => {
    const inspector = fuente('../components/inspector/ClipInspector.tsx');
    expect(inspector).not.toContain('rounded-lg');
  });

  it('la insignia de duración de la tarjeta usa cifras tabulares', () => {
    const tarjeta = fuente('../components/media/MediaItemCard.tsx');
    const insignia = tarjeta.slice(
      tarjeta.indexOf('absolute right-0.5 bottom-0.5'),
      tarjeta.indexOf('absolute right-0.5 bottom-0.5') + 300
    );
    expect(insignia).toContain('tabular');
  });
});
