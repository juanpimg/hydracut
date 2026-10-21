/**
 * Guardas del rediseño (DESIGN.md normativo): una superficie por mensaje,
 * acciones dentro del clip, cero chrome decorativo y un solo acento.
 *
 * Sin jsdom (patrón del resto de suites): el cableado con el sistema de
 * diseño se afirma sobre la fuente real. Para no romper con refactors
 * legítimos, las reglas de maquetación se afirman por TOKENS (co-ocurrencia
 * de clases, sin orden ni cadena exacta) y el copy solo aparece como
 * prefijos o raíces de verbo en un único bloque explícito: lo que se guarda
 * es la REGLA (dónde vive el estado vacío, que la fila va anclada dentro del
 * clip, que no hay gradientes), no la implementación concreta.
 *
 * Los patrones prohibidos llevan su guion final (`gradient-to-`, no
 * `gradiente`) para no cazar la prosa de los comentarios, que habla de
 * gradientes en español.
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

/**
 * La fuente contiene TODOS los tokens (en cualquier orden y reparto entre
 * cadenas): una refactorización a `clsx`/constantes no rompe la guarda
 * mientras la regla visual siga cumpliéndose.
 */
function contieneTodos(fuente: string, tokens: string[], ruta: string): void {
  for (const token of tokens) {
    expect(fuente, `${ruta} debería contener el token «${token}»`).toContain(token);
  }
}

describe('rediseño · el visor no posee estado vacío', () => {
  it('ni el visor de escritorio ni el móvil renderizan la guía de vacío', () => {
    const escritorio = leerFuente(join(componentesDir, 'player/PreviewPlayer.tsx'));
    const movil = leerFuente(join(componentesDir, 'mobile/MobilePreviewPlayer.tsx'));
    for (const visor of [escritorio, movil]) {
      expect(visor).not.toContain('timeline-empty-state');
    }
    // La etiqueta accesible del lienzo sigue existiendo (no es la guía: es el
    // nombre del canvas, con y sin clips). Solo se fija el prefijo: el resto
    // del copy puede evolucionar sin romper la guarda.
    expect(escritorio).toContain('Monitor vacío');
    expect(movil).toContain('Monitor vacío');
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
  });

  it('el estado vacío es condicional (solo sin clips) y ofrece una acción', () => {
    const linea = leerFuente(join(componentesDir, 'timeline/Timeline.tsx'));
    const pos = linea.indexOf('data-testid="timeline-empty-state"');
    expect(pos).toBeGreaterThan(-1);
    // La regla: el bloque se renderiza bajo una condición de negación (solo
    // cuando NO hay clips), no siempre. Sin nombrar la variable: cualquier
    // `{!algo && (...testid...)}` vale.
    expect(linea.slice(0, pos)).toMatch(/\{\s*![\w.]+\s*&&[\s\S]{0,600}$/);
    // La regla: el vacío ofrece una acción (un botón real), no solo texto. Y
    // su copy invita a añadir (raíz del verbo, no la frase exacta).
    const bloque = linea.slice(pos, pos + 1200);
    expect(bloque).toContain('<Button');
    expect(bloque).toMatch(/Añad/);
  });
});

describe('rediseño · las acciones del clip viven dentro del clip', () => {
  it('la fila está anclada dentro de los bordes y recorta por dentro', () => {
    const clip = leerFuente(join(componentesDir, 'timeline/ClipItem.tsx'));
    // Anclada dentro (pegada abajo con margen lateral), nunca flotando fuera:
    // se exigen los tokens, no la cadena exacta ni su orden.
    contieneTodos(clip, ['absolute', 'inset-x-1', 'bottom-0.5'], 'ClipItem.tsx');
    expect(clip).not.toContain('-translate-x-1/2');
    // El clip seleccionado abre su overflow para no recortar la fila…
    contieneTodos(clip, ['overflow-visible', 'overflow-hidden'], 'ClipItem.tsx');
    // …y la pastilla recorta por dentro lo que no quepa en un clip corto.
    contieneTodos(clip, ['max-w-full', 'overflow-hidden', 'rounded', 'border'], 'ClipItem.tsx');
  });

  it('la fila se monta de verdad: el padre renderiza ClipItem', () => {
    // Sin esto, las cadenas anteriores pasarían con la fila invisible (muerta
    // en una rama o nunca montada por el padre).
    const carril = leerFuente(join(componentesDir, 'timeline/TrackLane.tsx'));
    expect(carril).toContain("from './ClipItem'");
    expect(carril).toContain('<ClipItem');
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
