/**
 * W-C · Defectos móviles de la auditoría audit2 (02-ui-movil.md).
 *
 * Sin jsdom (patrón del resto de suites): la lógica pura se importa y se
 * ejecuta, y el cableado de los componentes se afirma sobre su fuente real.
 * Cada bloque falla sin su cambio. La medición en píxeles reales (navegador
 * con puntero grueso) vive en el informe: aquí quedan las guardas de fuente
 * que impiden la regresión.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  debeMostrarBanda,
} from '../components/mobile/MobileCapCutLayout';
import { NOMBRE_TIPO_PISTA } from '../components/timeline/TrackHeader';

function fuente(rutaRelativa: string): string {
  return readFileSync(new URL(rutaRelativa, import.meta.url), 'utf8');
}

/* ------------------------------------------------------------------ */
/* C1/C2/C3 · variante táctil en las primitivas compartidas             */
/* ------------------------------------------------------------------ */

describe('móvil · Button e IconButton expanden el área de golpe con puntero grueso', () => {
  it('ambas primitivas declaran la regla coarse con un ::after de 44 px', () => {
    for (const ruta of ['../components/ui/Button.tsx', '../components/ui/IconButton.tsx']) {
      const codigo = fuente(ruta);
      expect(codigo).toContain('pointer:coarse');
      expect(codigo).toContain('after:absolute');
      expect(codigo).toContain("after:content-['']");
      // El ::after cubre al menos 44 px en cada eje (el glifo no crece).
      expect(codigo).toMatch(/after:(min-h-\[44px\]|-inset-[3-9])/);
      expect(codigo).toMatch(/after:(min-w-\[44px\]|-inset-[3-9])/);
    }
  });

  it('el tamaño visual denso no cambia (el escritorio no crece)', () => {
    expect(fuente('../components/ui/IconButton.tsx')).toContain("sm: 'h-7 w-7'");
    expect(fuente('../components/ui/Button.tsx')).toContain("sm: 'h-7");
    expect(fuente('../components/ui/IconButton.tsx')).toContain('<button');
    expect(fuente('../components/ui/Button.tsx')).toContain('<button');
  });
});

/* ------------------------------------------------------------------ */
/* C1 · cabecera móvil con blancos reales de 44 px                      */
/* ------------------------------------------------------------------ */

describe('móvil C1 · la cabecera no compacta sus blancos bajo 44 px', () => {
  it('Exportar no se compacta a 32 px y cada blanco mide 44 px', () => {
    const cabecera = fuente('../components/mobile/MobileHeader.tsx');
    expect(cabecera).not.toContain('max-[559px]:h-8');
    expect(cabecera).not.toContain('max-[559px]:min-h-0');
    expect(cabecera).toContain('min-h-[44px]');
    // Sin compactaciones apaisadas a 22–28 px: la barra mide lo mismo siempre.
    expect(cabecera).not.toContain('min-h-8');
    expect(cabecera).not.toContain('[&_button]:h-7');
  });

  it('deshacer/rehacer viven en la tira, no en la cabecera (dan sitio al nombre)', () => {
    const cabecera = fuente('../components/mobile/MobileHeader.tsx');
    expect(cabecera).not.toContain('aria-label="Deshacer"');
    expect(cabecera).not.toContain('aria-label="Rehacer"');
    expect(cabecera).not.toContain('RotateCcw');
    expect(cabecera).not.toContain('(s) => s.undo');
    const tira = fuente('../components/mobile/MobileBottomBar.tsx');
    expect(tira).toContain('Deshacer');
    expect(tira).toContain('Rehacer');
  });
});

/* ------------------------------------------------------------------ */
/* M8 · aspecto alcanzable a 320 px y nombre con sitio                  */
/* ------------------------------------------------------------------ */

describe('móvil M8 · el aspecto no desaparece a 320 px y el nombre respira', () => {
  it('el botón de aspecto siempre se renderiza (solo-icono en estrecho)', () => {
    const cabecera = fuente('../components/mobile/MobileHeader.tsx');
    expect(cabecera).toContain('data-testid="mobile-aspect-button"');
    expect(cabecera).not.toContain('hidden min-[360px]:block');
  });

  it('el nombre es flexible sin un mínimo que lo deje en «Mi …»', () => {
    const cabecera = fuente('../components/mobile/MobileHeader.tsx');
    expect(cabecera).not.toContain('min-w-[48px]');
    expect(cabecera).toContain('min-w-0');
  });
});

/* ------------------------------------------------------------------ */
/* C2 · controles de pista + nombre canónico del tipo                   */
/* ------------------------------------------------------------------ */

describe('móvil C2 · la cabecera de pista usa nombres canónicos', () => {
  it('el tipo se muestra en español canónico (Vídeo/Audio/Texto)', () => {
    expect(NOMBRE_TIPO_PISTA).toEqual({ video: 'Vídeo', audio: 'Audio', text: 'Texto' });
    const pista = fuente('../components/timeline/TrackHeader.tsx');
    expect(pista).toContain('NOMBRE_TIPO_PISTA');
    expect(pista).not.toContain('{track.type}');
  });
});

/* ------------------------------------------------------------------ */
/* C4 · apaisado rescatado: conmutador + transporte apilado             */
/* ------------------------------------------------------------------ */

describe('móvil C4 · el apaisado conmuta Visor ⇄ Línea de tiempo', () => {
  it('debeMostrarBanda decide qué banda se monta en cada vista', () => {
    // En vertical siempre se ven las dos bandas (sin conmutador).
    expect(debeMostrarBanda(false, 'visor', 'visor')).toBe(true);
    expect(debeMostrarBanda(false, 'visor', 'linea')).toBe(true);
    expect(debeMostrarBanda(false, 'linea', 'visor')).toBe(true);
    expect(debeMostrarBanda(false, 'linea', 'linea')).toBe(true);
    // En apaisado solo la vista elegida ocupa la pantalla.
    expect(debeMostrarBanda(true, 'visor', 'visor')).toBe(true);
    expect(debeMostrarBanda(true, 'visor', 'linea')).toBe(false);
    expect(debeMostrarBanda(true, 'linea', 'visor')).toBe(false);
    expect(debeMostrarBanda(true, 'linea', 'linea')).toBe(true);
  });

  it('la banda apaisada de la línea de tiempo mide al menos 120 px (no 76)', () => {
    const maquetacion = fuente('../components/mobile/MobileCapCutLayout.tsx');
    expect(maquetacion).not.toContain('h-[76px]');
    expect(maquetacion).toContain('min-h-[120px]');
    expect(maquetacion).toContain('vistaPaisaje');
  });

  it('el transporte no flota sobre el vídeo en apaisado', () => {
    const visor = fuente('../components/mobile/MobilePreviewPlayer.tsx');
    expect(visor).not.toContain('absolute bottom-0');
    expect(visor).not.toContain('bg-black/70');
  });

  it('la tira conserva sus etiquetas en apaisado (nunca 8 iconos mudos)', () => {
    const tira = fuente('../components/mobile/MobileBottomBar.tsx');
    expect(tira).not.toContain('[@media(max-height:500px)]:hidden');
  });
});

/* ------------------------------------------------------------------ */
/* H1 · una sola puerta para Dividir en móvil                           */
/* ------------------------------------------------------------------ */

describe('móvil H1 · Dividir vive solo en la tira', () => {
  it('el transporte ya no duplica Dividir (la tira manda)', () => {
    const visor = fuente('../components/mobile/MobilePreviewPlayer.tsx');
    expect(visor).not.toContain('Dividir clip en el cabezal');
    expect(visor).not.toContain('>Dividir<');
  });

  it('las tijeras de la toolbar se ocultan con puntero grueso (el escritorio las conserva)', () => {
    const barra = fuente('../components/timeline/TimelineToolbar.tsx');
    expect(barra).toContain('pointer:coarse');
    expect(barra).toContain('Dividir en el cabezal (S)');
  });

  it('la tira conserva su puerta contextual con el aria fijado', () => {
    const tira = fuente('../components/mobile/MobileBottomBar.tsx');
    expect(tira).toContain('MobileSplitButton');
    expect(tira).toContain('Dividir en cabezal');
  });

  it('la suite de navegador sigue al botón de la tira (no al del transporte)', () => {
    const suite = fuente('./browser/suite-layout.mjs');
    expect(suite).not.toContain('button[aria-label="Dividir clip en el cabezal"]');
    expect(suite).toContain('Dividir en cabezal');
  });
});

/* ------------------------------------------------------------------ */
/* H4 · borrar con el diálogo propio, nunca confirm() nativo            */
/* ------------------------------------------------------------------ */

describe('móvil H4 · eliminar pide confirmación en el idioma de la app', () => {
  it('la tira móvil no usa confirm() nativo', () => {
    const tira = fuente('../components/mobile/MobileBottomBar.tsx');
    // Llamada real (`confirm('…')`), no la mención en comentarios/prosa.
    expect(tira).not.toMatch(/[^`A-Za-z]confirm\(['"`)]/);
  });

  it('el borrado usa el Dialog propio con la destructiva en danger', () => {
    const tira = fuente('../components/mobile/MobileBottomBar.tsx');
    expect(tira).toContain("from '../ui/Dialog'");
    expect(tira).toContain('<Dialog');
    expect(tira).toContain('¿Eliminar este clip?');
    expect(tira).toContain('Puedes deshacerlo.');
    expect(tira).toContain('variant="danger"');
  });
});

/* ------------------------------------------------------------------ */
/* H5 · el asa de la hoja es un gesto de verdad                         */
/* ------------------------------------------------------------------ */

describe('móvil H5 · el asa de la hoja se arrastra para cerrar', () => {
  it('el asa captura el puntero y traslada la hoja (o no es un asa)', () => {
    const hoja = fuente('../components/mobile/MobileBottomSheet.tsx');
    expect(hoja).toContain('onPointerDown');
    expect(hoja).toContain('setPointerCapture');
    expect(hoja).toContain('translateY');
    expect(hoja).toContain('onClose');
  });
});

/* ------------------------------------------------------------------ */
/* H6 · el cambio a herramientas del clip se lee                        */
/* ------------------------------------------------------------------ */

describe('móvil H6 · la tira de clip dice qué clip edita', () => {
  it('la tira muestra el nombre del clip y anima el cambio en ≤ 150 ms', () => {
    const tira = fuente('../components/mobile/MobileBottomBar.tsx');
    expect(tira).toContain('Clip:');
    expect(tira).toContain('fadeIn_150ms');
  });
});

/* ------------------------------------------------------------------ */
/* M2 · verbos táctiles en el estado vacío                               */
/* ------------------------------------------------------------------ */

describe('móvil M2 · el estado vacío habla de tocar, no de arrastrar', () => {
  it('sin verbos de ratón ni «carril», con acción por toque', () => {
    const linea = fuente('../components/timeline/Timeline.tsx');
    expect(linea).not.toContain('Arrastra un medio');
    expect(linea).not.toContain('carril');
    expect(linea).toContain('Añade un clip para empezar a editar');
    // La acción por toque existe: el botón abre el camino sin arrastrar.
    expect(linea).toContain('Añade un medio');
    expect(linea).toContain('handleAnadirPrimerMedio');
  });
});

/* ------------------------------------------------------------------ */
/* M10 · ayuda táctil en las asas de recorte                            */
/* ------------------------------------------------------------------ */

describe('móvil M10 · las asas de recorte no hablan del teclado', () => {
  it('los titles usan el verbo arrastrar en ambas asas', () => {
    const clip = fuente('../components/timeline/ClipItem.tsx');
    expect(clip).toContain('Arrastra para recortar el inicio');
    expect(clip).toContain('Arrastra para recortar el final');
    expect(clip).not.toContain('flechas del teclado');
  });
});
