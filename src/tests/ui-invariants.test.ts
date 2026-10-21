/**
 * Guardas del rediseño (DESIGN.md normativo): una superficie por mensaje,
 * acciones dentro del clip, cero chrome decorativo y un solo acento.
 *
 * Sin jsdom (patrón del resto de suites): el cableado con el sistema de
 * diseño se afirma sobre la fuente real. Los patrones prohibidos llevan su
 * guion final (`gradient-to-`, no `gradiente`) para no cazar la prosa de
 * los comentarios, que habla de gradientes en español.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const componentesDir = join(aqui, '..', 'components');

/** Todos los ficheros de texto bajo `src/components/` (tsx, ts, css). */
function recorrerFuentes(dir: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const completa = join(dir, entrada);
    if (statSync(completa).isDirectory()) {
      salida.push(...recorrerFuentes(completa));
    } else if (/\.(tsx?|css)$/.test(entrada)) {
      salida.push(completa);
    }
  }
  return salida.sort();
}

function leerFuente(ruta: string): string {
  return readFileSync(ruta, 'utf8');
}

describe('rediseño · el visor no posee estado vacío', () => {
  it('ni el visor de escritorio ni el móvil renderizan la guía de vacío', () => {
    const escritorio = leerFuente(join(componentesDir, 'player/PreviewPlayer.tsx'));
    const movil = leerFuente(join(componentesDir, 'mobile/MobilePreviewPlayer.tsx'));
    for (const visor of [escritorio, movil]) {
      expect(visor).not.toContain('timeline-empty-state');
      expect(visor).not.toContain('Añade un clip para empezar a editar');
    }
    // La etiqueta accesible del lienzo sigue existiendo (no es la guía:
    // es el nombre del canvas, con y sin clips).
    expect(escritorio).toContain('Monitor vacío: importa medios para empezar');
    expect(movil).toContain('Monitor vacío: importa medios para empezar');
  });
});

describe('rediseño · la línea de tiempo posee el único estado vacío', () => {
  it('existe exactamente un estado vacío y vive en la línea de tiempo', () => {
    const duenos = recorrerFuentes(componentesDir).filter((ruta) =>
      leerFuente(ruta).includes('timeline-empty-state')
    );
    expect(duenos.map((ruta) => ruta.replace(componentesDir, ''))).toEqual([
      '/timeline/Timeline.tsx',
    ]);
    const linea = leerFuente(join(componentesDir, 'timeline/Timeline.tsx'));
    const veces = linea.split('data-testid="timeline-empty-state"').length - 1;
    expect(veces).toBe(1);
    expect(linea).toContain('Sin clips');
    expect(linea).toContain('Añade un medio');
  });
});

describe('rediseño · las acciones del clip viven dentro del clip', () => {
  it('la fila está anclada dentro de los bordes y recorta por dentro', () => {
    const clip = leerFuente(join(componentesDir, 'timeline/ClipItem.tsx'));
    // Anclada dentro (`inset-x-1`, pegada abajo), nunca flotando fuera.
    expect(clip).toContain('absolute inset-x-1 bottom-0.5');
    expect(clip).not.toContain('-translate-x-1/2');
    // El clip seleccionado abre su overflow para no recortar la fila…
    expect(clip).toContain("isInSelection ? 'overflow-visible' : 'overflow-hidden'");
    // …y la pastilla recorta por dentro lo que no quepa en un clip corto.
    expect(clip).toContain('max-w-full');
    expect(clip).toContain('overflow-hidden rounded border');
  });
});

describe('rediseño · cero chrome decorativo en los componentes', () => {
  const prohibidos = ['gradient-to-', 'backdrop-blur', 'rounded-2xl', 'rounded-3xl'];

  for (const patron of prohibidos) {
    it(`ningún componente contiene «${patron}»`, () => {
      for (const ruta of recorrerFuentes(componentesDir)) {
        expect(leerFuente(ruta), `${ruta} contiene ${patron}`).not.toContain(patron);
      }
    });
  }
});

describe('rediseño · un solo acento', () => {
  it('ningún componente usa chrome azul fuera de los tintes de clip', () => {
    for (const ruta of recorrerFuentes(componentesDir)) {
      const fuente = leerFuente(ruta);
      expect(fuente, `${ruta} usa text-blue-`).not.toContain('text-blue-');
      expect(fuente, `${ruta} usa bg-blue-`).not.toContain('bg-blue-');
    }
  });

  it('el acento único sigue cableado (accent, no azules de marca)', () => {
    const usaAcento = recorrerFuentes(componentesDir).some(
      (ruta) => leerFuente(ruta).includes('text-accent') || leerFuente(ruta).includes('bg-accent')
    );
    expect(usaAcento).toBe(true);
  });
});
