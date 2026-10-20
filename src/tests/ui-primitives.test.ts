/**
 * Primitivas UI de la ola U0: tokens + familia de componentes.
 *
 * Sin jsdom (patrón del resto de suites): las primitivas se importan para
 * afirmar su existencia real, y el cableado con el sistema (tokens, CSS
 * base, ausencia de anti-patrones) se afirma sobre la fuente.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as primitivas from '../components/ui/index';

function fuente(rutaRelativa: string): string {
  return readFileSync(new URL(rutaRelativa, import.meta.url), 'utf8');
}

function minusculas(texto: string): string {
  return texto.toLowerCase();
}

/* ------------------------------------------------------------------ */
/* 1 — Cada componente exportado existe y es un componente real         */
/* ------------------------------------------------------------------ */

const COMPONENTES_ESPERADOS = [
  'Button',
  'IconButton',
  'SegmentedControl',
  'Slider',
  'Toggle',
  'Checkbox',
  'Select',
  'Input',
  'Panel',
  'Section',
  'Badge',
  'Tooltip',
  'Toast',
  'ToastHost',
  'useToasts',
  'Dialog',
  'Menu',
  'MenuItem',
  'MenuSeparador',
  'Field',
] as const;

describe('U0 · el barril exporta toda la familia de primitivas', () => {
  for (const nombre of COMPONENTES_ESPERADOS) {
    it(`${nombre} existe y es un componente o un hook`, () => {
      const valor: unknown = (primitivas as Record<string, unknown>)[nombre];
      expect(valor, `${nombre} debe estar exportado desde components/ui`).toBeDefined();
      // Componente función, forwardRef/memo (objeto con $$typeof) o hook.
      const esFuncion = typeof valor === 'function';
      const esEnvoltorioReact =
        typeof valor === 'object' &&
        valor !== null &&
        '$$typeof' in (valor as Record<string, unknown>);
      expect(esFuncion || esEnvoltorioReact).toBe(true);
    });
  }

  it('no falta ningún fichero de primitiva en el barril', () => {
    const dir = fileURLToPath(new URL('../components/ui/', import.meta.url));
    const ficheros = readdirSync(dir).filter(
      (f) => f.endsWith('.tsx') && f !== 'index.ts'
    );
    const indice = fuente('../components/ui/index.ts');
    for (const fichero of ficheros) {
      const nombre = fichero.replace(/\.tsx$/, '');
      expect(indice).toContain(`./${nombre}`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2 — La paleta de tailwind.config.js es EXACTAMENTE la de DESIGN.md  */
/* ------------------------------------------------------------------ */

const HEX_ESPERADOS = [
  // Superficies.
  '#0d1117', // app
  '#161b22', // panel
  '#1f242e', // raised
  '#262d38', // overlay
  '#21262d', // border-subtle
  '#30363d', // border
  // Texto.
  '#f0f3f6', // text-1
  '#9aa4b2', // text-2
  '#636c76', // text-3
  // Acento único.
  '#22d3ee', // accent
  '#0891b2', // accent-fill
  // Semánticos.
  '#f85149', // danger
  '#d29922', // warning
  '#3fb950', // success
  // Tintes de clip.
  '#1f6feb', // clip-video
  '#238636', // clip-audio
  '#8957e5', // clip-text
  '#9e6a03', // clip-fx
];

describe('U0 · tokens de tailwind.config.js clavados a DESIGN.md', () => {
  const config = minusculas(fuente('../../tailwind.config.js'));

  it('contiene cada hex de DESIGN.md', () => {
    for (const hex of HEX_ESPERADOS) {
      expect(config, `falta el token ${hex}`).toContain(hex);
    }
    // El acento suave en su forma rgba.
    expect(config).toContain('rgba(34,211,238,.12)');
  });

  it('no contiene ningún otro hex (la paleta no deriva)', () => {
    const encontrados = new Set<string>();
    for (const m of config.matchAll(/#[0-9a-f]{3,8}\b/g)) {
      encontrados.add(m[0]);
    }
    expect(Array.from(encontrados).sort()).toEqual([...HEX_ESPERADOS].sort());
  });

  it('la escala muerta de acento azul ya no existe', () => {
    expect(config).not.toContain('#3b82f6');
    expect(config).not.toContain('#2563eb');
    expect(config).not.toContain('accent.hover');
    expect(config).not.toContain('accent.purple');
    expect(config).not.toContain('accent.emerald');
    expect(config).not.toContain('accent.rose');
    expect(config).not.toContain('accent.amber');
  });

  it('el alias dark-* sigue resolviendo a los tokens nuevos', () => {
    for (const clave of ['950', '900', '850', '800', '750', '700', '600', '500']) {
      expect(config).toContain(`${clave}:`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3 — Anti-patrones inalcanzables desde el config                      */
/* ------------------------------------------------------------------ */

describe('U0 · radios y sombras capados en el config', () => {
  const config = minusculas(fuente('../../tailwind.config.js'));

  it('rounded-2xl/3xl están capados a 12 px', () => {
    expect(config).toContain("'2xl': '12px'");
    expect(config).toContain("'3xl': '12px'");
    expect(config).not.toContain('1rem');
    expect(config).not.toContain('1.5rem');
  });

  it('la escala de radios del sistema existe (4/6/8, máx. 12)', () => {
    expect(config).toContain("sm: '4px'");
    expect(config).toContain("md: '6px'");
    expect(config).toContain("lg: '8px'");
    expect(config).toContain("xl: '12px'");
  });

  it('hay exactamente una sombra de overlay y ninguna de color', () => {
    const inicio = config.indexOf('boxshadow:');
    expect(inicio, 'el config debe declarar boxshadow').toBeGreaterThan(-1);
    // El bloque de sombras termina donde empieza el siguiente (transiciones).
    const fin = config.indexOf('transitionduration:', inicio);
    const bloque = config.slice(inicio, fin > inicio ? fin : undefined);
    const sombras = [...bloque.matchAll(/rgba\(([^)]+)\)/g)].map((m) => m[0]);
    // Todas las sombras usan el mismo negro neutro al 50 %.
    expect(sombras.length).toBeGreaterThan(0);
    for (const sombra of sombras) {
      expect(sombra).toBe('rgba(0,0,0,.5)');
    }
    expect(bloque).toContain('overlay:');
    expect(bloque).toContain('0 8px 24px rgba(0,0,0,.5)');
  });

  it('la escala tipográfica de DESIGN.md existe', () => {
    for (const token of ['caption', 'body-sm', 'body:', 'body-lg', 'title', 'timecode']) {
      expect(config, `falta el token tipográfico ${token}`).toContain(token);
    }
    expect(config).toContain('11px');
    expect(config).toContain('13px');
    expect(config).toContain('15px');
  });

  it('150 ms es la duración de transición por defecto', () => {
    expect(config).toContain("default: '150ms'");
  });
});

/* ------------------------------------------------------------------ */
/* 4 — src/index.css: chrome del navegador tematizado                   */
/* ------------------------------------------------------------------ */

describe('U0 · index.css tematiza el chrome del navegador', () => {
  const css = fuente('../index.css');

  it('define scrollbars tematizadas (webkit + firefox)', () => {
    expect(css).toContain('::-webkit-scrollbar');
    expect(css).toContain('::-webkit-scrollbar-thumb');
    expect(css).toContain('scrollbar-color');
    expect(css).toContain('scrollbar-width');
  });

  it('define la selección con el acento y el caret tematizado', () => {
    expect(css).toContain('::selection');
    expect(css).toContain('caret-color');
  });

  it('define la regla global de :focus-visible (anillo de 2 px)', () => {
    expect(css).toContain(':focus-visible');
    expect(css).toContain('2px');
  });

  it('expone las utilidades .tabular, .panel-scroll y conserva las base', () => {
    expect(css).toContain('.tabular');
    expect(css).toContain('tabular-nums');
    expect(css).toContain('.panel-scroll');
    expect(css).toContain('.no-select');
    expect(css).toContain('.no-scrollbar');
  });

  it('el body usa los tokens (bg-app, text-text-1) y antialiasing', () => {
    expect(css).toContain('bg-app');
    expect(css).toContain('text-text-1');
    expect(css).toContain('-webkit-font-smoothing: antialiased');
  });
});

/* ------------------------------------------------------------------ */
/* 5 — Guardia de fuente: cero anti-patrones en components/ui/         */
/* ------------------------------------------------------------------ */

const PATRONES_PROHIBIDOS = [
  'gradient-to-',
  'backdrop-blur',
  'rounded-2xl',
  'rounded-3xl',
];

describe('U0 · ninguna primitiva trae color hardcodeado ni anti-patrones', () => {
  const dir = fileURLToPath(new URL('../components/ui/', import.meta.url));
  const ficheros = readdirSync(dir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));

  it('hay primitivas que guardar', () => {
    expect(ficheros.length).toBeGreaterThan(10);
  });

  for (const patron of PATRONES_PROHIBIDOS) {
    it(`ningún fichero contiene «${patron}»`, () => {
      for (const fichero of ficheros) {
        const contenido = readFileSync(new URL(`../components/ui/${fichero}`, import.meta.url), 'utf8');
        expect(contenido, `${fichero} contiene ${patron}`).not.toContain(patron);
      }
    });
  }

  it('ningún fichero contiene un literal hex', () => {
    for (const fichero of ficheros) {
      const contenido = readFileSync(new URL(`../components/ui/${fichero}`, import.meta.url), 'utf8');
      expect(contenido, `${fichero} hardcodea un color`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it('rounded-full solo existe en la pastilla del Toggle', () => {
    for (const fichero of ficheros) {
      if (fichero === 'Toggle.tsx') continue;
      const contenido = readFileSync(new URL(`../components/ui/${fichero}`, import.meta.url), 'utf8');
      expect(contenido, `${fichero} usa rounded-full`).not.toContain('rounded-full');
    }
    const toggle = readFileSync(new URL('../components/ui/Toggle.tsx', import.meta.url), 'utf8');
    expect(toggle).toContain('rounded-full');
  });
});
