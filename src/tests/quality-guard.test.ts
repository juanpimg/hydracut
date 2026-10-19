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
 *  2. Every production module under `src/core/` and `src/store/` is imported
 *     by at least one test file (a short, justified allow-list is allowed).
 *  3. No test file re-implements a production function:
 *     a) a locally defined function whose name matches a production export
 *        and that is NOT imported -> shadowing / copy-paste;
 *     b) a locally defined function whose body shares >= 4 distinctive
 *        numeric constants with a production function -> a renamed copy.
 *
 * The checks are deliberately structural (no formatting assumptions) so they
 * stay cheap and do not become brittle.
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
const PRODUCTION_MODULE_DIRS = [join(SRC_DIR, 'core'), join(SRC_DIR, 'store')];
const PRODUCTION_MODULES = PRODUCTION_MODULE_DIRS.flatMap((dir) =>
  listFiles(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
).sort();

/**
 * Production modules without a direct unit test.
 * Keep this list short and justify every entry.
 */
const MODULES_WITHOUT_TEST_ALLOWLIST: Array<{ module: string; reason: string }> = [
  {
    module: 'src/core/utils/thumbnails',
    reason:
      'Genera DataURLs de miniaturas con Canvas/Image: no hay forma de '
      + 'comprobar su salida sin un navegador real. Queda cubierto por el '
      + 'harness de navegador (src/tests/browser/), no por vitest.',
  },
];

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
  const start = source.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
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

  it('imports every production module of src/core and src/store from a test', () => {
    const imported = new Set<string>();
    for (const file of TEST_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const path of findImportedPaths(source, dirname(file))) {
        imported.add(path);
      }
    }

    const allowlisted = new Set(
      MODULES_WITHOUT_TEST_ALLOWLIST.map((entry) =>
        resolve(ROOT_DIR, entry.module)
      )
    );

    const untested = PRODUCTION_MODULES.filter(
      (module) => !imported.has(module) && !allowlisted.has(module)
    ).map((module) => relative(ROOT_DIR, module));

    expect(
      untested,
      'Production modules without any test importing them. Add a test or ' +
        'document the exception in MODULES_WITHOUT_TEST_ALLOWLIST.'
    ).toEqual([]);
  });

  it('does not let a test file shadow a production export with a local copy', () => {
    const productionExports = collectProductionExportNames();
    const violations: string[] = [];

    for (const file of TEST_FILES) {
      const source = readFileSync(file, 'utf8');
      const imported = findImportedNames(source);
      for (const def of findLocalDefinitions(stripNoise(source))) {
        if (imported.has(def.name)) continue;
        const owner = productionExports.get(def.name);
        if (!owner) continue;
        violations.push(
          `${relative(ROOT_DIR, file)}: local function "${def.name}" shadows ` +
            `the production export of ${owner}. Import it instead of copying it.`
        );
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
