#!/usr/bin/env node
/**
 * Thin CLI wrapper for the HydraCut browser E2E suites.
 *
 *   node scripts/browser-test.mjs              -> runs every suite
 *   node scripts/browser-test.mjs layout       -> runs a single suite
 *   node scripts/browser-test.mjs firefox      -> runs only the Firefox export suite
 *   node scripts/browser-test.mjs --headed     -> shows the browser window
 *   node scripts/browser-test.mjs --strict     -> known-issue checks also fail
 *
 * Environment overrides:
 *   HYDRA_CHROME_PATH  path to the Chrome/Chromium binary
 *   HYDRA_FIREFOX_PATH path to the Firefox binary (only needed for the firefox suite;
 *                      without it the suite is skipped, never failed)
 *   HYDRA_DEV_PORT     port of the dev server (default 5199)
 *   HYDRA_STRICT=1     same as --strict
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, '..', 'src', 'tests', 'browser', 'run-all.mjs');

const args = process.argv.slice(2);
const unknown = args.filter((a) => a.startsWith('-') && !['--headed', '--strict'].includes(a));
if (unknown.length) {
  console.error(`Opción desconocida: ${unknown.join(', ')}`);
  console.error('Uso: node scripts/browser-test.mjs [suite] [--headed] [--strict]');
  process.exit(2);
}

const { spawn } = await import('node:child_process');

const child = spawn(process.execPath, [RUNNER, ...args], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`El runner terminó por señal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on('error', (err) => {
  console.error(`No se pudo lanzar el runner: ${err.message}`);
  process.exit(1);
});
