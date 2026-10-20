/**
 * run-all.mjs — runner for the HydraCut browser E2E suites.
 *
 *   node src/tests/browser/run-all.mjs [suite ...] [--headed] [--strict]
 *
 * - Boots (or reuses) the Vite dev server on 127.0.0.1:5199.
 * - Launches the system Chrome through puppeteer-core.
 * - Runs every requested suite and prints a per-check report + a summary.
 * - Exits with 1 when at least one real check failed, otherwise 0.
 * - Known-issue checks are informational: they never fail the run unless
 *   HYDRA_STRICT=1 (or --strict) is set.
 */

import {
  startDevServer,
  launchBrowser,
  createReporter,
  warmUp,
  DEFAULT_TIMEOUT,
} from './browser-harness.mjs';

import * as suiteLayout from './suite-layout.mjs';
import * as suitePlayback from './suite-playback.mjs';
import * as suiteExport from './suite-export.mjs';
import * as suiteKnownIssues from './suite-known-issues.mjs';
import * as suiteFeatures from './suite-features.mjs';
import * as suiteRecent from './suite-recent.mjs';
import * as suiteFirefox from './suite-firefox.mjs';

const SUITES = [
  { key: 'layout', mod: suiteLayout },
  { key: 'playback', mod: suitePlayback },
  { key: 'export', mod: suiteExport },
  { key: 'known-issues', mod: suiteKnownIssues },
  { key: 'features', mod: suiteFeatures },
  { key: 'recent', mod: suiteRecent },
  { key: 'firefox', mod: suiteFirefox },
];

/** Hard limit per suite: a hung suite must never hang the whole run. */
const SUITE_TIMEOUT_MS = 150_000;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function parseArgs(argv) {
  const flags = { suites: [], headed: false, strict: false };
  for (const arg of argv) {
    if (arg === '--headed') flags.headed = true;
    else if (arg === '--strict') flags.strict = true;
    else if (arg.startsWith('--')) continue;
    else flags.suites.push(arg);
  }
  return flags;
}

function printHeader(text) {
  const bar = '─'.repeat(Math.max(4, text.length + 4));
  console.log(`\n${C.cyan}${C.bold}${text}${C.reset} ${C.dim}${bar}${C.reset}`);
}

/** Rejects with a TimeoutError when `promise` takes longer than `ms`. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`La suite "${label}" superó el límite de ${Math.round(ms / 1000)} s`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function printCheck(result, strict) {
  let mark;
  let color;
  if (result.severity === 'info') {
    mark = result.ok ? '◆' : '◇';
    color = result.ok ? C.yellow : C.cyan;
  } else {
    mark = result.ok ? '✔' : '✖';
    color = result.ok ? C.green : C.red;
  }
  const kind = result.severity === 'info' ? (result.ok ? 'CONFIRMADO' : 'NO REPRODUCIDO') : result.ok ? 'PASS' : 'FAIL';
  console.log(
    `  ${color}${mark}${C.reset} ${C.bold}${result.id}${C.reset} ${C.dim}[${kind}]${C.reset} ${result.title}`
  );
  if (result.message) {
    console.log(`      ${C.dim}${result.message}${C.reset}`);
  }
  if (result.severity === 'info' && strict) {
    console.log(`      ${C.dim}(modo estricto: este resultado informational cuenta como fallo)${C.reset}`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const strict = flags.strict || process.env.HYDRA_STRICT === '1';

  const selected = flags.suites.length
    ? SUITES.filter((s) => flags.suites.includes(s.key) || flags.suites.includes(s.mod.name))
    : SUITES;

  if (selected.length === 0) {
    console.error(
      `Suites desconocidos. Disponibles: ${SUITES.map((s) => s.key).join(', ')}`
    );
    process.exit(2);
  }

  console.log(`${C.bold}HydraCut Studio — E2E en navegador real (Chrome + puppeteer-core)${C.reset}`);
  console.log(
    `${C.dim}Suites: ${selected.map((s) => s.key).join(', ')} | modo estricto: ${
      strict ? 'SÍ (HYDRA_STRICT=1)' : 'no'
    }${C.reset}`
  );

  const startedAt = Date.now();
  let server = null;
  let browser = null;
  const allResults = [];
  const suiteSummaries = [];
  let crashed = false;

  try {
    server = await startDevServer();
    console.log(
      `${C.dim}Servidor de desarrollo: ${server.url} (${
        server.reused ? 'reutilizado' : 'iniciado por el harness'
      })${C.reset}`
    );

    // Suites that bring their own browser (Firefox) never need Chrome: when
    // ONLY those are selected, Chrome is not launched at all (so
    // `run-all.mjs firefox` works on machines without Chrome, and the full
    // run never breaks on machines without Firefox — that suite skips
    // itself with a clear message instead of failing).
    const needsChrome = selected.some((s) => !s.mod.requiresOwnBrowser);
    if (needsChrome) {
      browser = await launchBrowser({ headless: !flags.headed });
      console.log(`${C.dim}Chrome lanzado. Timeout por defecto: ${DEFAULT_TIMEOUT} ms${C.reset}`);

      // Absorb the Vite dependency re-optimisation / first HMR reload so that the
      // real suites never see a surprise navigation.
      await warmUp(browser, { baseUrl: server.url });
      console.log(`${C.dim}Calentamiento del navegador completado.${C.reset}`);
    } else {
      console.log(`${C.dim}Sin suites de Chrome: no se lanza Chrome.${C.reset}`);
    }
    for (const suite of selected) {
      const report = createReporter(suite.key);
      const suiteStarted = Date.now();
      printHeader(`${suite.key} — ${suite.mod.title}`);

      try {
        await withTimeout(
          suite.mod.run({
            browser,
            report,
            baseUrl: server.url,
          }),
          SUITE_TIMEOUT_MS,
          suite.key
        );
      } catch (err) {
        crashed = true;
        const detail = err && err.message ? err.message : String(err);
        const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : '';
        report.fail(
          `${suite.key.toUpperCase()}-SUITE`,
          `La suite "${suite.key}" no pudo completarse`,
          `${detail}${stack ? `\n${stack}` : ''}`
        );
      }

      for (const result of report.results) {
        printCheck(result, strict);
      }

      const failed = report.results.filter(
        (r) => r.severity === 'error' && !r.ok
      ).length;
      const notReproduced = report.results.filter(
        (r) => r.severity === 'info' && !r.ok
      ).length;
      const elapsed = ((Date.now() - suiteStarted) / 1000).toFixed(1);

      suiteSummaries.push({
        key: suite.key,
        total: report.results.length,
        failed,
        notReproduced,
        elapsed,
      });
      allResults.push(...report.results);
    }
  } catch (err) {
    crashed = true;
    console.error(`\n${C.red}Fallo grave del harness: ${err && err.message ? err.message : err}${C.reset}`);
  } finally {
    if (browser) {
      try {
        // Never hang on shutdown: force the browser down after 15 s.
        await withTimeout(browser.close(), 15_000, 'browser.close');
      } catch {
        try {
          browser.process()?.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
    if (server) {
      try {
        await withTimeout(server.stop(), 15_000, 'server.stop');
      } catch {
        /* ignore */
      }
    }
  }

  const runtime = ((Date.now() - startedAt) / 1000).toFixed(1);
  const realFailures = allResults.filter((r) => r.severity === 'error' && !r.ok);
  const strictFailures = strict ? allResults.filter((r) => r.severity === 'info' && !r.ok) : [];
  const totalFailed = realFailures.length + strictFailures.length;

  console.log(`\n${C.bold}${'═'.repeat(64)}${C.reset}`);
  console.log(`${C.bold} RESUMEN / SUMMARY${C.reset}`);
  for (const s of suiteSummaries) {
    const status = s.failed > 0 ? `${C.red}${s.failed} FAIL${C.reset}` : `${C.green}0 FAIL${C.reset}`;
    const skipped = s.total === 0 ? ` ${C.yellow}(omitida)${C.reset}` : '';
    const info = s.notReproduced > 0 ? ` ${C.yellow}${s.notReproduced} no reproducidos${C.reset}` : '';
    console.log(
      `  ${s.key.padEnd(14)} ${String(s.total).padStart(3)} checks  ${status}${skipped}${info}  ${C.dim}${s.elapsed}s${C.reset}`
    );
  }
  console.log(`${C.dim}${'─'.repeat(64)}${C.reset}`);
  console.log(
    `  ${C.bold}TOTAL${C.reset}          ${String(allResults.length).padStart(3)} checks  ${
      realFailures.length === 0
        ? `${C.green}0 FAIL${C.reset}`
        : `${C.red}${realFailures.length} FAIL${C.reset}`
    }${strictFailures.length ? ` ${C.red}${strictFailures.length} INFO-FAIL${C.reset}` : ''}  ${C.dim}${runtime}s${C.reset}`
  );
  if (crashed) {
    console.log(`  ${C.red}El harness registró un error no controlado (suite incompleta).${C.reset}`);
  }

  if (realFailures.length) {
    console.log(`\n${C.red}${C.bold}Checks fallidos:${C.reset}`);
    for (const f of realFailures) {
      console.log(`  ${C.red}✖${C.reset} [${f.suite}] ${f.id} — ${f.title}`);
      if (f.message) console.log(`      ${C.dim}${f.message}${C.reset}`);
    }
  }
  if (strictFailures.length) {
    console.log(`\n${C.red}${C.bold}Defectos conocidos que ya NO se reproducen (modo estricto):${C.reset}`);
    for (const f of strictFailures) {
      console.log(`  ${C.red}◇${C.reset} [${f.suite}] ${f.id} — ${f.title}`);
      if (f.message) console.log(`      ${C.dim}${f.message}${C.reset}`);
    }
  }

  if (totalFailed > 0 || crashed) {
    if (crashed) {
      console.log(
        `\n${C.red}${C.bold}RESULTADO: FAIL (el harness falló y la ejecución está incompleta)${C.reset}`
      );
    } else {
      console.log(`\n${C.red}${C.bold}RESULTADO: FAIL (${totalFailed} checks)${C.reset}`);
    }
    process.exit(1);
  }
  console.log(`\n${C.green}${C.bold}RESULTADO: PASS${C.reset} (${runtime}s)`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${C.red}Fallo no controlado del runner: ${err && err.stack ? err.stack : err}${C.reset}`);
  process.exit(1);
});
