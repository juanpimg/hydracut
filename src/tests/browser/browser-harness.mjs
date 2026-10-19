/**
 * Shared helpers for the HydraCut browser E2E harness.
 *
 * This module owns EVERYTHING that touches Chrome / the dev server:
 *  - booting (or reusing) the Vite dev server on 127.0.0.1:5199
 *  - launching the system Chrome through puppeteer-core
 *  - creating isolated (incognito) browser contexts so every suite starts clean
 *  - collecting console errors / pageerrors
 *  - dismissing the WelcomeModal and reading app state from the DOM
 *  - capturing downloads through the CDP `Browser.setDownloadBehavior` command
 *
 * It is intentionally dependency free (only puppeteer-core, already a devDependency).
 *
 * IMPORTANT: the Vite dev server hot-reloads whenever a source file changes, so
 * a page can navigate in the middle of a test. Every DOM helper in this file is
 * therefore written as a *resilient polling loop* instead of a single
 * `waitForFunction`, so a concurrent HMR reload can never make a check lie.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the hydra-cut package root (src/tests/browser -> ../../..). */
export const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..');

export const CHROME_PATH = process.env.HYDRA_CHROME_PATH || '/usr/bin/google-chrome-stable';
export const DEV_HOST = process.env.HYDRA_DEV_HOST || '127.0.0.1';
export const DEV_PORT = Number(process.env.HYDRA_DEV_PORT || 5199);
export const BASE_URL = process.env.HYDRA_BASE_URL || `http://${DEV_HOST}:${DEV_PORT}/`;

/** Default timeout applied to every wait helper (30 s). */
export const DEFAULT_TIMEOUT = 30_000;

/** Chrome flags that are required for this sandboxed / headless environment. */
export const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
];

export const WELCOME_SELECTOR = '[data-testid="welcome-modal"]';
export const EXPORT_DIALOG_SELECTOR = 'div[role="dialog"][aria-label="Exportar video"]';
export const EXPORT_BUTTON_SELECTOR = 'button[aria-label="Abrir modal de exportación de video MP4"]';
export const EXPORT_CLOSE_SELECTOR = 'button[aria-label="Cerrar modal de exportación"]';
export const MEDIA_POOL_LABEL = 'Panel de Medios';

/* ------------------------------------------------------------------ *
 * Dev server
 * ------------------------------------------------------------------ */

/**
 * Returns true when something already answers on `url`.
 * Used to REUSE an already running dev server instead of spawning a second one.
 */
export async function isServerUp(url = BASE_URL, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Boots the Vite dev server, or reuses the one already listening on
 * 127.0.0.1:5199. Always returns a `stop()` that is safe to call.
 *
 * `--strictPort` is used so that Vite fails loudly instead of silently
 * hopping to another port when a concurrent process grabs 5199 first; in that
 * case the already running server is reused.
 */
export async function startDevServer({
  url = BASE_URL,
  host = DEV_HOST,
  port = DEV_PORT,
  timeoutMs = 90_000,
} = {}) {
  if (await isServerUp(url)) {
    return {
      url,
      reused: true,
      stop: async () => {},
    };
  }

  const child = spawn(
    'npm',
    ['run', 'dev', '--', '--host', host, '--port', String(port), '--strictPort'],
    {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    }
  );

  let output = '';
  child.stdout?.on('data', (d) => {
    output += d.toString();
  });
  child.stderr?.on('data', (d) => {
    output += d.toString();
  });

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp(url, 1000)) break;
    if (exited) {
      // Either the port was taken by another process (then it serves the very
      // same app and can be reused) or Vite failed to start.
      if (await isServerUp(url, 1000)) {
        return { url, reused: true, stop: async () => {} };
      }
      killGroup('SIGKILL');
      throw new Error(
        `El servidor de desarrollo terminó antes de arrancar:\n${output.slice(-2000)}`
      );
    }
    await delay(250);
  }

  if (!(await isServerUp(url, 1000))) {
    killGroup('SIGKILL');
    throw new Error(`El servidor de desarrollo no respondió en ${url}:\n${output.slice(-2000)}`);
  }

  const stop = async () => {
    if (exited) return;
    killGroup('SIGTERM');
    const until = Date.now() + 5000;
    while (!exited && Date.now() < until) {
      await delay(100);
    }
    if (!exited) {
      killGroup('SIGKILL');
      await delay(200);
    }
    // Last resort: the direct child (npm) may have been reaped already.
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };

  return { url, reused: false, stop };
}

/* ------------------------------------------------------------------ *
 * Browser
 * ------------------------------------------------------------------ */

/** Launches the system Chrome via puppeteer-core. */
export async function launchBrowser({ headless = true } = {}) {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    headless,
    args: CHROME_ARGS,
    defaultViewport: null,
    protocolTimeout: 180_000,
  });
}

/**
 * Collects console errors and uncaught page errors.
 * Network failures for third-party origins (Google Fonts) are reported separately
 * because they are environment noise, not application defects.
 */
export function attachDiagnostics(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const externalFailures = [];

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Failed to load resource|net::ERR_|ERR_NAME_NOT_RESOLVED/i.test(text)) {
      externalFailures.push(text);
      return;
    }
    consoleErrors.push(text);
  });

  page.on('pageerror', (err) => {
    pageErrors.push(err && err.message ? err.message : String(err));
  });

  return { consoleErrors, pageErrors, externalFailures };
}

/* Navigation bookkeeping: a HMR reload destroys the execution context. */
const navState = new WeakMap();

function navCounter(page) {
  let state = navState.get(page);
  if (!state) {
    state = { count: 0 };
    navState.set(page, state);
    page.on('framenavigated', (frame) => {
      try {
        if (frame === page.mainFrame()) state.count++;
      } catch {
        /* the page may be closing */
      }
    });
  }
  return state.count;
}

/** Number of main-frame navigations of the page (HMR reloads included). */
export function navCount(page) {
  return navCounter(page);
}

/** `page.evaluate` that never throws (returns `fallback` on navigation/teardown). */
export async function safeEvaluate(page, fn, ...args) {
  if (typeof fn !== 'function') {
    throw new TypeError('safeEvaluate(page, fn, ...args) necesita una función como segundo argumento');
  }
  try {
    return await page.evaluate(fn, ...args);
  } catch {
    return null;
  }
}

/**
 * `page.evaluate` with retries: the Vite dev server can hot-reload the page
 * (destroying the execution context) at any moment, so a failed evaluation is
 * retried after the app has been re-mounted.
 */
export async function evaluateWithRetry(page, fn, ...args) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(fn, ...args);
    } catch (err) {
      lastError = err;
      await waitForAppReady(page).catch(() => {});
      await delay(300);
    }
  }
  throw lastError;
}

/**
 * Creates a fresh incognito context + page with the requested viewport.
 * Every suite/case uses its own context, so state never leaks between cases.
 */
export async function openAppPage(browser, {
  width = 1440,
  height = 900,
  deviceScaleFactor = 1,
  baseUrl = BASE_URL,
  waitUntil = 'domcontentloaded',
} = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, deviceScaleFactor });
  page.setDefaultTimeout(DEFAULT_TIMEOUT);
  page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT);
  const diagnostics = attachDiagnostics(page);
  navCounter(page);
  await page.goto(baseUrl, { waitUntil, timeout: DEFAULT_TIMEOUT });
  return { context, page, diagnostics };
}

/** Waits until React has mounted the editor shell (root populated + a canvas present). */
export async function waitForAppReady(page, timeout = DEFAULT_TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await safeEvaluate(
      page,
      () => {
        const root = document.getElementById('root');
        return Boolean(root && root.children.length > 0) && Boolean(document.querySelector('canvas'));
      }
    );
    if (ready) return true;
    await delay(120);
  }
  throw new Error(`La app no montó en ${timeout} ms`);
}

/**
 * Closes the WelcomeModal. Throws when the modal stays on screen.
 */
export async function dismissWelcome(page, timeout = DEFAULT_TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await safeEvaluate(
      page,
      (sel) => {
        if (!document.querySelector(sel)) return 'absent';
        const btn = document.querySelector('[data-testid="welcome-continue"]');
        if (!btn) return 'no-button';
        btn.click();
        return 'clicked';
      },
      WELCOME_SELECTOR
    );
    if (state === 'absent') return false;
    if (state === 'clicked') {
      await delay(150);
      const stillThere = await safeEvaluate(
        page,
        (sel) => Boolean(document.querySelector(sel)),
        WELCOME_SELECTOR
      );
      if (!stillThere) return true;
    }
    await delay(200);
  }
  throw new Error('El modal de bienvenida no se pudo cerrar');
}

/** Full boot sequence used by most suites: open page, wait for React, dismiss welcome. */
export async function bootApp(browser, viewport = {}) {
  const opened = await openAppPage(browser, viewport);
  await waitForAppReady(opened.page);
  await dismissWelcome(opened.page);
  return opened;
}

/**
 * Opens the app WITHOUT dismissing the WelcomeModal (needed to reproduce
 * defects that only happen while the welcome screen is still open).
 */
export async function bootAppKeepWelcome(browser, viewport = {}) {
  const opened = await openAppPage(browser, viewport);
  await waitForAppReady(opened.page);
  return opened;
}

/**
 * Warms the dev server / browser up: the first page load of a Vite dev server
 * can trigger a dependency re-optimisation and a full reload. Doing it once up
 * front keeps the real suites free of surprise navigations.
 */
export async function warmUp(browser, { baseUrl = BASE_URL, settleMs = 3000 } = {}) {
  const { context, page } = await openAppPage(browser, { baseUrl });
  try {
    const deadline = Date.now() + 20_000;
    let last = navCounter(page);
    let stableFor = 0;
    while (Date.now() < deadline && stableFor < settleMs) {
      await delay(250);
      const now = navCounter(page);
      if (now !== last) {
        last = now;
        stableFor = 0;
        continue;
      }
      stableFor += 250;
    }
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

export async function bodyText(page) {
  const text = await safeEvaluate(page, () => document.body.innerText);
  return typeof text === 'string' ? text : '';
}

/** Extracts the first "HH:MM:SS:FF / ..." match from the visible text. */
export async function readTimecode(page) {
  const text = await bodyText(page);
  const match = text.match(/(\d\d:\d\d:\d\d:\d\d)\s*\//);
  return match ? match[1] : null;
}

/** Parses "HH:MM:SS:FF" into seconds (frames @ 30 fps). */
export function timecodeToSeconds(tc) {
  if (!tc) return null;
  const [h, m, s, f] = tc.split(':').map(Number);
  return h * 3600 + m * 60 + s + f / 30;
}

/** Reads the "Panel de Medios (N)" counter. Returns the number or null. */
export async function readMediaPoolCount(page) {
  const value = await safeEvaluate(page, (label) => {
    const m = document.body.innerText.match(
      new RegExp(label + '\\s*\\((\\d+)\\)')
    );
    return m ? Number(m[1]) : null;
  }, MEDIA_POOL_LABEL);
  return typeof value === 'number' ? value : null;
}

/** Opens the Export modal and waits for it to be visible. */
export async function openExportModal(page, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const opened = await safeEvaluate(
      page,
      (btnSel, dlgSel) => {
        const btn = document.querySelector(btnSel);
        if (!btn) return 'no-button';
        if (!document.querySelector(dlgSel)) btn.click();
        return Boolean(document.querySelector(dlgSel)) ? 'open' : 'clicked';
      },
      EXPORT_BUTTON_SELECTOR,
      EXPORT_DIALOG_SELECTOR
    );
    if (opened === 'open') return true;
    await delay(150);
  }
  throw new Error('No se pudo abrir el modal de exportación');
}

/** Closes the Export modal (via its close button) and waits until it is gone. */
export async function closeExportModal(page, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await safeEvaluate(
      page,
      (dlgSel, closeSel) => {
        if (!document.querySelector(dlgSel)) return 'closed';
        const btn = document.querySelector(closeSel);
        if (!btn) return 'no-button';
        btn.click();
        return 'clicked';
      },
      EXPORT_DIALOG_SELECTOR,
      EXPORT_CLOSE_SELECTOR
    );
    if (state === 'closed') return true;
    await delay(150);
  }
  throw new Error('No se pudo cerrar el modal de exportación');
}

/**
 * Reads the project summary block of the Export modal.
 * Returns { durationText, duration, totalFramesText, totalFrames, clipsText, clips }.
 */
export async function readExportSummary(page) {
  const raw = await safeEvaluate(page, (sel) => {
    const modal = document.querySelector(sel);
    if (!modal) return null;
    const rows = Array.from(modal.querySelectorAll('div.flex.justify-between'));
    const out = {};
    for (const row of rows) {
      const label = (row.children[0]?.textContent || '').trim();
      const value = (row.children[1]?.textContent || '').trim();
      if (label.startsWith('Duración de exportación')) out.durationText = value;
      else if (label.startsWith('Total de fotogramas')) out.totalFramesText = value;
      else if (label.startsWith('Clips en el timeline')) out.clipsText = value;
    }
    return out;
  }, EXPORT_DIALOG_SELECTOR);

  if (!raw) return null;
  const num = (v) => {
    if (v == null) return null;
    const m = String(v).match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  return {
    durationText: raw.durationText ?? null,
    duration: num(raw.durationText),
    totalFramesText: raw.totalFramesText ?? null,
    totalFrames: num(raw.totalFramesText),
    clipsText: raw.clipsText ?? null,
    clips: num(raw.clipsText),
  };
}

/** Convenience: number of clips currently in the timeline, read through the Export modal. */
export async function readClipCountViaExportModal(page) {
  await openExportModal(page);
  const summary = await readExportSummary(page);
  await closeExportModal(page);
  return summary ? summary.clips : null;
}

/* ------------------------------------------------------------------ *
 * Downloads
 * ------------------------------------------------------------------ */

/**
 * Enables downloads for a browser context through the CDP
 * `Browser.setDownloadBehavior` command and returns a watcher that resolves
 * with the downloaded file path.
 */
export async function setupDownloadCapture(browser, context, dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  const session = await browser.target().createCDPSession();
  const params = { behavior: 'allow', downloadPath: dirPath, eventsEnabled: true };

  let applied = false;
  try {
    await session.send('Browser.setDownloadBehavior', { ...params, browserContextId: context.id });
    applied = true;
  } catch {
    try {
      await session.send('Browser.setDownloadBehavior', params);
      applied = true;
    } catch {
      /* fall through: we still poll the directory */
    }
  }

  const events = [];
  try {
    session.on('Browser.downloadWillBegin', (e) => events.push({ type: 'begin', ...e }));
    session.on('Browser.downloadProgress', (e) => events.push({ type: 'progress', ...e }));
  } catch {
    /* events are optional */
  }

  return {
    dirPath,
    applied,
    events,
    session,
    /**
     * Waits until a file that is not a partial download shows up in `dirPath`.
     * Returns { filePath, name, size } or null on timeout.
     */
    async waitForFile({ timeoutMs = 120_000, match = () => true, minBytes = 0 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        let entries = [];
        try {
          entries = fs.readdirSync(dirPath);
        } catch {
          entries = [];
        }
        for (const name of entries) {
          if (name.endsWith('.crdownload') || name.endsWith('.tmp')) continue;
          const full = path.join(dirPath, name);
          let stat;
          try {
            stat = fs.statSync(full);
          } catch {
            continue;
          }
          if (!stat.isFile()) continue;
          if (stat.size < minBytes) continue;
          if (!match(name)) continue;
          return { filePath: full, name, size: stat.size };
        }
        await delay(250);
      }
      return null;
    },
  };
}

/* ------------------------------------------------------------------ *
 * App interaction helpers
 * ------------------------------------------------------------------ */

/** Clicks the first <button> whose trimmed text contains `text`. */
export async function clickButtonByText(page, text, { exact = false } = {}) {
  const clicked = await safeEvaluate(
    page,
    (t, isExact) => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find((b) => {
        const label = (b.textContent || '').trim();
        return isExact ? label === t : label.includes(t);
      });
      if (!btn) return false;
      btn.click();
      return true;
    },
    text,
    exact
  );
  if (!clicked) throw new Error(`No se encontró ningún botón con el texto "${text}"`);
  return true;
}

/** Waits until the "Panel de Medios (N)" counter reaches at least `min`. */
export async function waitForMediaPool(page, min = 1, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const count = await readMediaPoolCount(page);
    if (count !== null) {
      last = count;
      if (count >= min) return count;
    }
    await delay(200);
  }
  throw new Error(
    `El panel de medios no alcanzó ${min} elemento(s) en ${timeoutMs} ms (último valor: ${last})`
  );
}

/**
 * Clicks "Generar Clips de Prueba (1-Click)" and waits for the media pool to
 * grow. If the page is hot-reloaded in the middle of the generation the click
 * is retried (the Vite dev server reloads whenever a source file changes).
 * Returns { elapsedMs, mediaCount, attempts }.
 */
export async function generateSampleMedia(page, { timeoutMs = 120_000, retries = 3 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const navBefore = navCounter(page);
    const started = Date.now();
    try {
      await clickButtonByText(page, 'Generar Clips de Prueba');
    } catch (err) {
      lastError = err;
      await delay(500);
      continue;
    }
    const deadline = Date.now() + timeoutMs;
    let navigated = false;
    while (Date.now() < deadline) {
      const count = await readMediaPoolCount(page);
      if (count !== null && count > 0) {
        return { elapsedMs: Date.now() - started, mediaCount: count, attempts: attempt + 1 };
      }
      if (navCounter(page) !== navBefore) {
        navigated = true;
        break;
      }
      await delay(200);
    }
    lastError = new Error(
      navigated
        ? 'la página se recargó durante la generación de muestras'
        : `el panel de medios no creció en ${timeoutMs} ms`
    );
    if (navigated) {
      await waitForAppReady(page).catch(() => {});
      await dismissWelcome(page).catch(() => {});
    }
  }
  throw new Error(
    `No se pudieron generar los clips de muestra: ${lastError ? lastError.message : 'motivo desconocido'}`
  );
}

/**
 * Ensures the timeline holds at least one clip:
 *   1. makes sure the media pool is not empty (generating samples if needed),
 *   2. clicks the first media card,
 *   3. waits for the clip to appear.
 * Retries the whole flow when the Vite dev server hot-reloads the page in the
 * middle of the operation (which wipes the in-memory media pool).
 */
export async function addFirstMediaToTimeline(page, { attempts = 4 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const navBefore = navCounter(page);

    // Already there? (a previous attempt may have succeeded before a reload)
    const existing = await readClipCount(page);
    if (existing !== null && existing > 0) return true;

    let count = await readMediaPoolCount(page);
    if (count === null || count === 0) {
      try {
        await generateSampleMedia(page);
      } catch (err) {
        lastError = err;
      }
      count = await readMediaPoolCount(page);
    }

    const probe = await page
      .evaluate(() => {
        try {
          const cards = Array.from(document.querySelectorAll('[role="button"]'));
          const card = document.querySelector(
            '[role="button"][aria-label*="pulsa para añadir"]'
          );
          if (!card) {
            return {
              ok: false,
              reason: 'no-card',
              roleButtons: cards.length,
              labels: cards
                .map((c) => c.getAttribute('aria-label'))
                .filter(Boolean)
                .slice(0, 5),
            };
          }
          card.click();
          return { ok: true, roleButtons: cards.length, labels: cards
            .map((c) => c.getAttribute('aria-label'))
            .filter(Boolean)
            .slice(0, 6) };
        } catch (err) {
          return { ok: false, reason: `excepción: ${err && err.message}` };
        }
      })
      .catch((err) => ({ ok: false, reason: `navegación: ${err && err.message}` }));

    const added = Boolean(probe && probe.ok);

    const deadline = Date.now() + 15_000;
    let lastClips = 'n/d';
    let lastPersisted = 'n/d';
    while (Date.now() < deadline) {
      const clips = await readClipCount(page);
      lastClips = String(clips);
      if (clips !== null && clips > 0) return true;
      // The page may have been hot-reloaded: in that case the clip comes back
      // from the autosave, so give the app a moment to rehydrate it.
      const persisted = await readPersistedProject(page);
      lastPersisted = JSON.stringify(persisted);
      if (persisted && persisted.clips > 0) {
        await delay(500);
        const rehydrated = await readClipCount(page);
        if (rehydrated !== null && rehydrated > 0) return true;
      }
      await delay(200);
    }

    lastError = new Error(
      `${added ? 'el clip no apareció en el timeline' : 'no se encontró ninguna tarjeta de medios en el panel'}` +
        ` (motivo: ${probe ? probe.reason || 'desconocido' : 'sin respuesta'}, ` +
        `tarjetas con role=button: ${probe && probe.roleButtons !== undefined ? probe.roleButtons : '?'}, ` +
        `medios: ${count}, navegaciones: ${navCounter(page) - navBefore}, ` +
        `clips leídos: ${lastClips}, persistido: ${lastPersisted}, ` +
        `aria-labels: ${probe && probe.labels ? JSON.stringify(probe.labels) : 'n/d'})`
    );
    await waitForAppReady(page).catch(() => {});
    await dismissWelcome(page).catch(() => {});
  }
  throw new Error(
    `No se pudo añadir un clip al timeline: ${lastError ? lastError.message : 'motivo desconocido'}`
  );
}

/**
 * Removes the focus from any input/textarea/select.
 *
 * The app ignores the global keyboard shortcuts (Space, Ctrl+Z, …) while an
 * input has the focus, so the keyboard scenarios must blur it first.
 */
export async function blurActiveElement(page) {
  return safeEvaluate(page, () => {
    const active = document.activeElement;
    if (!active) return false;
    if (typeof active.blur === 'function') active.blur();
    return document.activeElement === document.body || document.activeElement === null;
  });
}

/** Number of clips in the timeline, read straight from the exposed zustand store. */
export async function readClipCount(page) {
  const value = await safeEvaluate(page, () => {
    const store = window.__projectStore;
    if (!store) return null;
    return store.getState().project.clips.length;
  });
  return typeof value === 'number' ? value : null;
}

/**
 * Stretches the first clip of the timeline to `seconds` (the equivalent of
 * dragging the right edge of the clip in the inspector). Used to pin down a
 * deterministic "single 5 second clip" scenario for the export suite.
 * Returns the new duration or null when it could not be applied.
 */
export async function setFirstClipDuration(page, seconds) {
  const value = await safeEvaluate(page, (s) => {
    const store = window.__projectStore;
    if (!store) return null;
    const clip = store.getState().project.clips[0];
    if (!clip) return null;
    store.getState().updateClip(clip.id, { duration: s });
    const updated = store.getState().project.clips.find((c) => c.id === clip.id);
    return updated ? updated.duration : null;
  }, seconds);
  return typeof value === 'number' ? value : null;
}

/** Reads the first `bytes` bytes of a file as a latin1 string (for MP4 box sniffing). */
export function readFileHead(filePath, bytes = 64) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------------------------------------------ *
 * Store access (debug helper – the app exposes its zustand stores on window)
 * ------------------------------------------------------------------ */

export async function readStoreSnapshot(page) {
  return safeEvaluate(page, () => {
    const store = window.__projectStore;
    if (!store) return null;
    const p = store.getState().project;
    return {
      clips: p.clips.length,
      media: p.mediaPool.length,
      duration: p.duration,
      tracks: p.tracks.length,
      canUndo: store.getState().past.length,
      canRedo: store.getState().future.length,
    };
  });
}

/**
 * Reads the project that is currently persisted in IndexedDB (idb-keyval store
 * "keyval-store" / "keyval").
 *
 * The storage layout is not hard-coded: the app may store the full project
 * under the autosave key or a pointer to `hydra_project_<id>`, so every record
 * that looks like a project is inspected and the most recent one wins.
 * Used to make the persistence test deterministic: we only reload the page
 * once the autosave has really been written.
 */
export async function readPersistedProject(page) {
  return safeEvaluate(page, async () => {
    try {
      if (typeof indexedDB.databases !== 'function') return null;
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === 'keyval-store')) return null;
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('keyval-store');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
      });
      try {
        if (!db.objectStoreNames.contains('keyval')) return null;
        const values = await new Promise((resolve, reject) => {
          const tx = db.transaction('keyval', 'readonly');
          const req = tx.objectStore('keyval').getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
        const projects = values
          .filter(
            (v) =>
              v &&
              typeof v === 'object' &&
              Array.isArray(v.clips) &&
              Array.isArray(v.mediaPool)
          )
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        const best = projects[0];
        if (!best) return null;
        return {
          clips: best.clips.length,
          media: best.mediaPool.length,
          duration: typeof best.duration === 'number' ? best.duration : null,
        };
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  });
}

/** Waits until the autosaved project in IndexedDB contains the expected content. */
export async function waitForPersistedProject(
  page,
  { minClips = 0, minMedia = 0, timeoutMs = 20_000 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const snapshot = await readPersistedProject(page);
    if (snapshot) {
      last = snapshot;
      if (snapshot.clips >= minClips && snapshot.media >= minMedia) return snapshot;
    }
    await delay(250);
  }
  throw new Error(
    `El proyecto no se persistió en IndexedDB en ${timeoutMs} ms (último estado: ${JSON.stringify(last)})`
  );
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

/**
 * Tiny check recorder.
 *
 * `severity: 'error'`  -> a real regression check: a failure breaks the build.
 * `severity: 'info'`   -> an informational / known-issue check: it is reported
 *                         but never breaks the build, UNLESS HYDRA_STRICT=1
 *                         (then a *not reproduced* known issue fails the run,
 *                          because the documented baseline no longer holds).
 */
export function createReporter(suiteName) {
  const results = [];
  const add = (severity, id, title, message, extra = {}) => {
    const entry = { suite: suiteName, id, title, severity, message, ...extra };
    results.push(entry);
    return entry;
  };
  return {
    suiteName,
    results,
    pass(id, title, message) {
      return add('error', id, title, message, { ok: true });
    },
    fail(id, title, message, extra = {}) {
      return add('error', id, title, message, { ok: false, ...extra });
    },
    /** Records a real check and decides pass/fail from `ok`. */
    check(id, title, ok, message, extra = {}) {
      return add('error', id, title, message, { ok: Boolean(ok), ...extra });
    },
    /**
     * Records a KNOWN-ISSUE check.
     * `ok === true`  -> the documented defect is still reproducible (CONFIRMED).
     * `ok === false` -> the defect did NOT reproduce (possibly already fixed).
     */
    known(id, title, ok, message, extra = {}) {
      return add('info', id, title, message, { ok: Boolean(ok), ...extra });
    },
  };
}

export { delay };
