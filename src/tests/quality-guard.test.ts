/**
 * Quality guard for the test suite itself.
 *
 * This file does not test the application: it tests the TESTS. It exists
 * because the project shipped "verification evidence" that proved nothing:
 * suites that re-implemented a production function locally and asserted the
 * local copy (see `challenger-stress-verification.test.ts`, which contained a
 * 58-line private copy of `MediaSourcePool.syncVideoTime`).
 *
 * Three invariants are enforced:
 *
 *  1. No orphan test files: every file under `src/tests/` declares at least
 *     one `describe()` block.
 *  2. Every production module under `src/core/`, `src/store/`,
 *     `src/components/`, `src/hooks/` (plus the composition root `src/App`)
 *     is not just imported but USED by at least one test file: the importer
 *     must reference the imported binding (or one of the module exports)
 *     outside its import statements AND contain at least one `expect()`.
 *     A bare `import '../core/engine/AudioEngine'` next to
 *     `expect(true).toBe(true)` no longer satisfies the guard.
 *     (`src/main.tsx` is the only exclusion and stays documented below: it
 *     executes `createRoot` at import time, so it cannot be loaded in node;
 *     its wiring is asserted by `viewer-clock-subscription.test.ts`.)
 *  3. No test file re-implements a production function:
 *     a) a locally defined function whose name matches a production export
 *        and that is NOT imported -> shadowing / copy-paste;
 *     b) a locally defined non-trivial function whose name CONTAINS a
 *        production export name (a rename that keeps the root, e.g.
 *        `syncVideoTimeLocal`) without importing it, sharing >= 3 numeric
 *        constants with a production function -> a renamed copy;
 *     c) a locally defined function whose body shares >= 4 distinctive
 *        numeric constants with a production function AND contains control
 *        flow (branches or loops) -> a copy of logic, whatever its name is.
 *        Straight-line fixture factories (`makeMedia` and friends share
 *        dimensions with production by necessity) are exempt: data is not
 *        logic.
 *
 * The checks are deliberately structural (no formatting assumptions) so they
 * stay cheap and do not become brittle. The numeric thresholds were measured
 * against the current suite: legit mock installers share at most 3 constants
 * with production (e.g. video dimensions in fakes) AND import the module
 * they mirror, so (b) exempts files that collaborate with the owner module.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ */
/* Filesystem helpers                                                   */
/* ------------------------------------------------------------------ */

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(TESTS_DIR, '..');
const ROOT_DIR = resolve(SRC_DIR, '..');

/** Recursively lists every file below `dir`. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** All vitest suites of the package (the browser harness is NOT a suite). */
const TEST_FILES = listFiles(TESTS_DIR)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

/** All production modules that must be covered by at least one test. */
const PRODUCTION_MODULE_DIRS = [
  join(SRC_DIR, 'core'),
  join(SRC_DIR, 'store'),
  join(SRC_DIR, 'components'),
  join(SRC_DIR, 'hooks'),
];
const PRODUCTION_MODULES = PRODUCTION_MODULE_DIRS.flatMap((dir) =>
  listFiles(dir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter((f) => !f.endsWith('.d.ts'))
    .map((f) => f.replace(/\.tsx?$/, ''))
).sort();

/**
 * Production modules at the `src/` root with the same requirement.
 * `src/main.tsx` is deliberately NOT here: it executes `createRoot` at
 * import time and cannot be loaded in node. Its wiring (createRoot + <App/>)
 * is asserted by `viewer-clock-subscription.test.ts` instead.
 */
const PRODUCTION_ROOT_MODULES = [join(SRC_DIR, 'App')];
const ALL_PRODUCTION_MODULES = [...PRODUCTION_MODULES, ...PRODUCTION_ROOT_MODULES].sort();

/**
 * Production modules without a direct unit test.
 * Keep this list short and justify every entry. It is currently empty: every
 * module is imported AND used by a test (see the `component-wiring` and
 * `thumbnails` suites for the components that used to be exempt).
 */
const MODULES_WITHOUT_TEST_ALLOWLIST: Array<{ module: string; reason: string }> = [];

/* ------------------------------------------------------------------ */
/* Source parsing helpers (formatting agnostic)                         */
/* ------------------------------------------------------------------ */

/** Removes comments and string literals so numbers can be compared safely. */
function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/** Returns the body of a block starting at the first `{` at/after `from`. */
function readBlock(source: string, from: number): string | null {
  let parens = 0;
  let firma = 0;
  let start = -1;
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (start < 0) {
      if (ch === '(') parens++;
      else if (ch === ')') parens = Math.max(0, parens - 1);
      else if (ch === '{') {
        // Una `{` dentro de los paréntesis pertenece a la FIRMA (anotación de
        // tipo objeto o valor por defecto), no al cuerpo: antes se tomaba por
        // apertura y el cuerpo quedaba truncado (`{ semilla: number }`).
        if (parens === 0 && firma === 0) {
          start = i;
          depth = 1;
        } else {
          firma++;
        }
      } else if (ch === '}') {
        if (firma > 0) firma--;
        else return null;
      } else if (ch === ';' && parens === 0 && firma === 0) {
        // Declaración sin cuerpo (sobrecarga): no hay bloque que leer.
        return null;
      }
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

interface LocalDefinition {
  name: string;
  body: string;
}

/** Named local definitions of a file (functions, arrow consts, classes). */
function findLocalDefinitions(source: string): LocalDefinition[] {
  const defs: LocalDefinition[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /(?:^|\n)\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g,
    /(?:^|\n)\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?function\b/g,
    /(?:^|\n)\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const body = readBlock(source, match.index + match[0].length - 1);
      if (body) defs.push({ name: match[1], body });
    }
  }
  return defs;
}

/** Names bound by the import statements of a file. */
function findImportedNames(source: string): Set<string> {
  const names = new Set<string>();
  const importRe = /import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    const clause = match[1];
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const alias = part.trim().split(/\s+as\s+/);
        const local = (alias[1] ?? alias[0]).trim();
        if (local) names.add(local);
      }
    }
    const bare = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+\w+/, '');
    for (const part of bare.split(',')) {
      const local = part.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) names.add(local);
    }
  }
  return names;
}

/** Every module specifier imported by a file (relative ones are resolved). */
function findImportedPaths(source: string, fromDir: string): string[] {
  const paths: string[] = [];
  // Static imports (`from '...'`) and dynamic ones (`await import('...')`).
  const importRe = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    const spec = match[1];
    if (!spec.startsWith('.')) continue;
    paths.push(resolve(fromDir, spec).replace(/\.(ts|tsx|js|mjs)$/, ''));
  }
  return paths;
}

/**
 * Local names bound to each imported production path by the static imports
 * of a file (`import X from`, `import { a, b as c } from`, `import * as ns
 * from`). Dynamic `import()` has no static binding: files that use it
 * destructure the module exports, which the usage check also accepts.
 */
function findStaticBindings(source: string, fromDir: string): Map<string, string[]> {
  const bindings = new Map<string, string[]>();
  const importRe = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    const spec = match[2];
    if (!spec.startsWith('.')) continue;
    const path = resolve(fromDir, spec).replace(/\.(ts|tsx|js|mjs)$/, '');
    const names: string[] = [];
    const clause = match[1];
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const alias = part.trim().split(/\s+as\s+/);
        const local = (alias[1] ?? alias[0]).trim();
        if (local) names.push(local);
      }
    }
    const bare = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+(\w+)/, '$1');
    for (const part of bare.split(',')) {
      const local = part.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) names.push(local);
    }
    bindings.set(path, [...(bindings.get(path) ?? []), ...names]);
  }
  return bindings;
}

/**
 * Source with every import statement (static and dynamic) blanked out, so a
 * name found afterwards is a REAL use, not the import itself.
 */
function stripImportStatements(source: string): string {
  return source
    .replace(/^[^\n]*\bfrom\s*['"][^'"]+['"]\s*;?[^\n]*$/gm, ' ')
    .replace(/^[^\n]*\bimport\s*\(/gm, ' ')
    .replace(/\bawait\s+import\s*\([^)]*\)/g, ' ')
    .replace(/\bimport\s*\([^)]*\)/g, ' ');
}

/** Distinctive numeric constants of a block (trivial integers are ignored). */
function numericSignature(body: string): Set<number> {
  const signature = new Set<number>();
  const re = /\b\d+(?:\.\d+)?\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const value = Number.parseFloat(match[0]);
    if (!Number.isFinite(value)) continue;
    // 0..9 are noise (loop counters, flags, channel indices).
    if (Number.isInteger(value) && value < 10) continue;
    signature.add(value);
  }
  return signature;
}

/** Production functions/methods with their numeric signature. */
interface ProductionFunction {
  file: string;
  name: string;
  signature: Set<number>;
}

function collectProductionFunctions(): ProductionFunction[] {
  const dirs = [
    join(SRC_DIR, 'core'),
    join(SRC_DIR, 'store'),
    join(SRC_DIR, 'components'),
    join(SRC_DIR, 'hooks'),
  ];
  const files = dirs.flatMap((dir) =>
    listFiles(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  );
  const functions: ProductionFunction[] = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const source = stripNoise(raw);
    // Top level functions, class methods and exported arrow consts.
    const patterns = [
      /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
      /(?:^|\n)\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;]+)?\{/g,
      /(?:^|\n)\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*\{/g,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        const body = readBlock(source, match.index + match[0].length - 1);
        if (!body) continue;
        functions.push({
          file: relative(ROOT_DIR, file),
          name: match[1],
          signature: numericSignature(body),
        });
      }
    }
  }
  return functions;
}

/** Production export names (functions, classes, exported consts). */
function collectProductionExportNames(): Map<string, string> {
  const dirs = [
    join(SRC_DIR, 'core'),
    join(SRC_DIR, 'store'),
    join(SRC_DIR, 'components'),
    join(SRC_DIR, 'hooks'),
  ];
  const files = dirs.flatMap((dir) =>
    listFiles(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  );
  const names = new Map<string, string>();
  const re = /^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      if (!names.has(match[1])) {
        names.set(match[1], relative(ROOT_DIR, file));
      }
    }
  }
  return names;
}

/**
 * Inverted export index: absolute module path -> its named exports. Used by
 * the usage check so files that load a module with a dynamic `import()` (and
 * destructure its exports) count as real users too.
 */
function collectProductionExportsByFile(): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  const dirs = [
    join(SRC_DIR, 'core'),
    join(SRC_DIR, 'store'),
    join(SRC_DIR, 'components'),
    join(SRC_DIR, 'hooks'),
  ];
  for (const dir of dirs) {
    for (const file of listFiles(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
      const key = file.replace(/\.tsx?$/, '');
      const source = readFileSync(file, 'utf8');
      const names: string[] = [];
      const re = /^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        names.push(match[1]);
      }
      // `export default Nombre;` at the end of the file.
      const def = /^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?$/gm;
      while ((match = def.exec(source)) !== null) {
        names.push(match[1]);
      }
      if (names.length > 0) byFile.set(key, names);
    }
  }
  // The composition root lives at `src/` level, outside the scanned dirs.
  const appSource = readFileSync(join(SRC_DIR, 'App.tsx'), 'utf8');
  const appNames: string[] = [];
  const appRe = /^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;
  let appMatch: RegExpExecArray | null;
  while ((appMatch = appRe.exec(appSource)) !== null) {
    appNames.push(appMatch[1]);
  }
  if (appNames.length > 0) byFile.set(join(SRC_DIR, 'App'), appNames);
  return byFile;
}

/* ------------------------------------------------------------------ */
/* The guard                                                            */
/* ------------------------------------------------------------------ */

describe('Test suite quality guard', () => {
  it('has a non-empty set of vitest suites to check', () => {
    expect(TEST_FILES.length).toBeGreaterThan(0);
  });

  it('has no orphan test file (every suite declares at least one describe)', () => {
    const orphans = TEST_FILES.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return !/\bdescribe\s*\(/.test(source);
    });
    expect(
      orphans.map((f) => relative(ROOT_DIR, f)),
      'These test files declare no describe() block: they are dead weight.'
    ).toEqual([]);
  });

  it('imports AND uses every production module from a test', () => {
    const exportsByFile = collectProductionExportsByFile();
    // module -> files that import it AND use it (see the header: a bare
    // import next to `expect(true)` does not count).
    const usedBy = new Map<string, string[]>();
    for (const file of TEST_FILES) {
      const raw = readFileSync(file, 'utf8');
      const source = stripNoise(raw);
      const hasExpect = /\bexpect\s*\(/.test(source);
      if (!hasExpect) continue;
      const body = stripImportStatements(source);
      const bindings = findStaticBindings(raw, dirname(file));
      const importedPaths = new Set([
        ...findImportedPaths(raw, dirname(file)),
        ...bindings.keys(),
      ]);
      for (const path of importedPaths) {
        const candidates = new Set<string>([
          ...(bindings.get(path) ?? []),
          ...(exportsByFile.get(path) ?? []),
        ]);
        // A `import * as ns` binding used as `ns.algo` also counts.
        const used = [...candidates].some((name) =>
          new RegExp(`\\b${name}\\b`).test(body)
        );
        if (used) {
          usedBy.set(path, [...(usedBy.get(path) ?? []), file]);
        }
      }
    }

    const allowlisted = new Set(
      MODULES_WITHOUT_TEST_ALLOWLIST.map((entry) =>
        resolve(ROOT_DIR, entry.module)
      )
    );

    const untested = ALL_PRODUCTION_MODULES.filter(
      (module) => !(usedBy.get(module)?.length) && !allowlisted.has(module)
    ).map((module) => relative(ROOT_DIR, module));

    expect(
      untested,
      'Production modules without any test USING them (importing is not ' +
        'enough: reference the import in an assertion). Add a test or ' +
        'document the exception in MODULES_WITHOUT_TEST_ALLOWLIST.'
    ).toEqual([]);
  });

  it('does not let a test file shadow a production export with a local copy', () => {
    const productionExports = collectProductionExportNames();
    const productionFunctions = collectProductionFunctions();
    const violations: string[] = [];

    for (const file of TEST_FILES) {
      const source = readFileSync(file, 'utf8');
      const imported = findImportedNames(source);
      for (const def of findLocalDefinitions(stripNoise(source))) {
        if (imported.has(def.name)) continue;
        const owner = productionExports.get(def.name);
        if (owner) {
          violations.push(
            `${relative(ROOT_DIR, file)}: local function "${def.name}" shadows ` +
              `the production export of ${owner}. Import it instead of copying it.`
          );
          continue;
        }
        // Renamed copy: the local name keeps a production export name as its
        // root (e.g. `syncVideoTimeLocal`), does NOT import it, has a
        // non-trivial body and shares >= 3 numeric constants with a
        // production function. Files that collaborate with the owner module
        // (they import the contained name) are exempt: mock installers mirror
        // production dimensions on purpose.
        if (def.body.length <= 300) continue;
        const lower = def.name.toLowerCase();
        for (const [prodName] of productionExports) {
          if (prodName.length < 8) continue;
          if (lower === prodName.toLowerCase()) continue;
          if (!lower.includes(prodName.toLowerCase())) continue;
          if (imported.has(prodName)) continue;
          const signature = numericSignature(def.body);
          if (signature.size < 3) continue;
          const copies = productionFunctions.some((fn) => {
            if (fn.signature.size < 3) return false;
            return [...signature].filter((n) => fn.signature.has(n)).length >= 3;
          });
          if (copies) {
            violations.push(
              `${relative(ROOT_DIR, file)}: local function "${def.name}" keeps ` +
                `the production export name "${prodName}" without importing it ` +
                `and shares >= 3 numeric constants with production code. It ` +
                `looks like a renamed copy: import it instead of copying it.`
            );
          }
          break;
        }
      }
    }

    expect(violations, 'Tautological test helpers detected').toEqual([]);
  });

  it('does not let a test file re-implement a production function', () => {
    const productionFunctions = collectProductionFunctions();
    const violations: string[] = [];

    for (const file of TEST_FILES) {
      const source = stripNoise(readFileSync(file, 'utf8'));
      for (const def of findLocalDefinitions(source)) {
        const signature = numericSignature(def.body);
        if (signature.size < 4) continue;
        // Fixture factories (`makeMedia`, params builders…) share dimension
        // constants with production by necessity but are straight-line data:
        // without control flow there is no re-implemented LOGIC to flag
        // (measured: every legit fixture scores 0 here, the historical
        // 58-line copy was all branches and loops).
        if (!/\b(if|for|while|switch|catch|case|throw)\b/.test(def.body)) continue;

        let best: { fn: ProductionFunction; shared: number[] } | null = null;
        for (const fn of productionFunctions) {
          if (fn.signature.size < 4) continue;
          const shared = [...signature].filter((n) => fn.signature.has(n));
          if (shared.length >= 4 && (!best || shared.length > best.shared.length)) {
            best = { fn, shared };
          }
        }

        if (best) {
          violations.push(
            `${relative(ROOT_DIR, file)}: local function "${def.name}" shares ` +
              `${best.shared.length} numeric constants with ${best.fn.file}:${best.fn.name} ` +
              `(${best.shared.join(', ')}). It looks like a copy of the production ` +
              `implementation: call the production code instead.`
          );
        }
      }
    }

    expect(violations, 'Re-implementations of production code detected').toEqual([]);
  });
});
