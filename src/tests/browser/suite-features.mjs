/**
 * suite-features.mjs — the features that are NOT covered by the other suites.
 *
 *   CLIPBOARD-SHORTCUT-COPY-PASTE  Ctrl+C / Ctrl+V / Ctrl+Z / Ctrl+D on the
 *                                 selected clip (the internal clipboard, F7)
 *   CLIPBOARD-TEXT-ENTRY          Ctrl+C inside an <input> does NOT hijack
 *                                 the system clipboard
 *   CLIPBOARD-REFUSAL-VISIBLE     a paste on a locked track shows a VISIBLE
 *                                 refusal ("… está bloqueada …")
 *   CLIPBOARD-ACTIONS-TOUCH       the copy/paste/duplicate buttons of the
 *                                 selected clip are labelled in Spanish and
 *                                 have a tap target of at least 26 px
 *
 *   EXPORT-PRESET-VERTICAL        the vertical preset exports a real
 *                                 1080x1920 file and does NOT reformat the
 *                                 project
 *   EXPORT-PRESET-DESELECT        moving the bitrate deselects the presets
 *   EXPORT-RANGE-LABEL            the in/out markers produce a range summary
 *                                 (and a duration/frame count of the RANGE)
 *   EXPORT-RANGE-MP4-DURATION     the downloaded MP4 lasts exactly the range
 *
 *   COLOR-SECTION                 the colour section of the inspector exists
 *                                 and is fully labelled in Spanish
 *   COLOR-PRESET-PIXELS           the B/N preset really greys the preview
 *                                 (max channel spread) and "Restablecer color"
 *                                 restores the original histogram
 *
 *   PLAYBACK-SPEED-PREVIEW-RATE   speed 2x reaches the pooled media element
 *                                 (playbackRate = 2, preservesPitch = true)
 *   PLAYBACK-SPEED-PERSIST        speed + preservePitch survive a reload
 *
 *   STORAGE-QUOTA-PANEL           the storage panel agrees with
 *                                 navigator.storage.estimate()
 *   STORAGE-PURGE-TRASH           emptying the trash really deletes the OPFS
 *                                 bytes (two taps)
 *
 * Every case reuses the sample media generated ONCE per browser context (the
 * generation takes ~2,4 s) and runs in its own incognito context.
 *
 * The Vite dev server reloads the page whenever a source file changes (and
 * when it re-optimises its dependencies). A reload wipes the IN-MEMORY state
 * of the app (the internal clipboard, the selection, the patches a test
 * installs…), so every scenario is re-run from scratch when a navigation is
 * detected in the middle of it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bootApp,
  waitForAppReady,
  dismissWelcome,
  generateSampleMedia,
  addFirstMediaToTimeline,
  setFirstClipDuration,
  openExportModal,
  closeExportModal,
  setupDownloadCapture,
  clickButtonByText,
  safeEvaluate,
  blurActiveElement,
  readMediaPoolCount,
  waitForPersistedProject,
  reloadWithRetry,
  readMp4VideoTrackSize,
  readMp4MovieDuration,
  navCount,
  delay,
} from './browser-harness.mjs';

export const name = 'features';
export const title =
  'Portapapeles interno, preajustes de exportación, filtros de color, velocidad y almacenamiento';

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Background colour painted by the compositor (outside the video frame). */
const BACKGROUND = { r: 0x0a, g: 0x0a, b: 0x0c };

/** The colour presets the inspector must offer (in this order). */
const EXPECTED_COLOR_PRESETS = [
  'Original',
  'Cálido',
  'Frío',
  'B/N',
  'Sepia',
  'Cine',
  'Vívido',
];

/** The Spanish aria-labels of the six colour sliders. */
const EXPECTED_COLOR_SLIDERS = [
  'Brillo del clip',
  'Contraste del clip',
  'Saturación del clip',
  'Temperatura del clip',
  'Blanco y negro del clip',
  'Sepia del clip',
];

/**
 * Runs a scenario and re-runs it when the dev server reloaded the page in
 * the middle of it (a reload wipes the in-memory state of the app).
 *
 * The scenario returns `{ reloaded, checks }`: the checks are only reported
 * when the scenario finished WITHOUT a navigation. `expected` lists the
 * checks the scenario owes: if every attempt was aborted by a reload, they
 * are reported as failures (never silently skipped).
 */
async function runScenario(scenario, { attempts = 3, expected = [] } = {}) {
  let outcome = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    outcome = await scenario(attempt);
    if (!outcome.reloaded) break;
    await delay(400);
  }
  if (outcome && Array.isArray(outcome.checks)) {
    const reported = new Set(outcome.checks.map((c) => c.id));
    for (const item of expected) {
      if (reported.has(item.id)) continue;
      outcome.checks.push({
        id: item.id,
        title: item.title,
        ok: false,
        message:
          `El servidor de desarrollo recargó la página las ${attempts} veces: ` +
          `el escenario no pudo completarse.`,
      });
    }
  }
  return outcome;
}

/**
 * Presses a Ctrl combination.
 *
 * `blur` blurs the focused element first (the app ignores the global
 * shortcuts while an <input> has the focus); the text-entry scenario needs
 * the opposite, so it passes `blur: false`.
 */
async function pressCtrl(page, key, { blur = true } = {}) {
  if (blur) await blurActiveElement(page);
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
  await delay(250);
}

/** Reads the interesting parts of the project store. */
async function readStoreState(page) {
  return safeEvaluate(page, () => {
    const store = window.__projectStore;
    if (!store) return null;
    const s = store.getState();
    return {
      clipCount: s.project.clips.length,
      selectedClipId: s.selectedClipId,
      clipboardLength: s.clipboard.length,
      lastError: s.lastError,
      aspectRatio: s.project.aspectRatio,
      projectDuration: s.project.duration,
      trashLength: (s.project.trash ?? []).length,
      clips: s.project.clips.map((c) => ({
        id: c.id,
        start: c.start,
        duration: c.duration,
        trackId: c.trackId,
        speed: c.speed ?? null,
        preservePitch: c.preservePitch ?? null,
        filters: c.filters ? JSON.parse(JSON.stringify(c.filters)) : null,
      })),
    };
  });
}

/**
 * Clicks the first clip of the timeline and waits until it is selected.
 * Returns the id of the selected clip.
 */
async function selectFirstClip(page, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const clicked = await safeEvaluate(page, () => {
      const clip = document.querySelector('[role="button"][aria-label^="Clip "]');
      if (!clip) return false;
      clip.click();
      return true;
    });
    if (clicked) {
      const selected = await safeEvaluate(page, () => {
        const store = window.__projectStore;
        return store ? store.getState().selectedClipId : null;
      });
      if (selected) return selected;
    }
    await delay(150);
  }
  throw new Error('No se pudo seleccionar ningún clip del timeline');
}

/**
 * Reads the pixels of the preview canvas.
 *
 * Returns `{ painted, total, maxSpread, hist }` where `maxSpread` is the
 * biggest difference between the channels of a painted pixel (0 = grey) and
 * `hist` is a coarse (16 buckets x 3 channels) histogram of the painted
 * pixels.
 */
function readPreviewPixels(bg) {
  const canvas = document.querySelector('div.shadow-2xl canvas');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return null;
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch (err) {
    return { error: `getImageData falló: ${err && err.message}` };
  }
  let painted = 0;
  let maxSpread = 0;
  const hist = new Array(48).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (
      Math.abs(r - bg.r) <= 6 &&
      Math.abs(g - bg.g) <= 6 &&
      Math.abs(b - bg.b) <= 6
    ) {
      continue; // background
    }
    painted++;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (spread > maxSpread) maxSpread = spread;
    hist[Math.min(15, r >> 4)]++;
    hist[16 + Math.min(15, g >> 4)]++;
    hist[32 + Math.min(15, b >> 4)]++;
  }
  return { painted, total: w * h, maxSpread, hist };
}

/**
 * Reads the preview pixels until two consecutive readings are IDENTICAL
 * (the frame is stable) and something is actually painted.
 */
async function measureStablePreview(page, { timeout = 12_000, minPainted = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let previous = null;
  let last = null;
  while (Date.now() < deadline) {
    const current = await safeEvaluate(page, readPreviewPixels, BACKGROUND);
    last = current;
    if (
      current &&
      !current.error &&
      current.painted >= minPainted &&
      previous &&
      previous.maxSpread === current.maxSpread &&
      JSON.stringify(previous.hist) === JSON.stringify(current.hist)
    ) {
      return current;
    }
    previous = current;
    await delay(300);
  }
  return last;
}

/** Distance between two histograms (0 = identical, 1 = totally different). */
function histogramDistance(a, b) {
  if (!a || !b) return 1;
  let diff = 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    diff += Math.abs(a[i] - b[i]);
    total += a[i] + b[i];
  }
  return total > 0 ? diff / total : 0;
}

/** Waits until the store's `currentTime` is (approximately) `time`. */
async function seekTo(page, time, timeout = 5000) {
  await safeEvaluate(page, (t) => {
    if (window.__masterClock) window.__masterClock.seek(t);
  }, time);
  const deadline = Date.now() + timeout;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await safeEvaluate(page, () => {
      const store = window.__projectStore;
      return store ? store.getState().currentTime : null;
    });
    if (typeof seen === 'number' && Math.abs(seen - time) < 0.05) return seen;
    await delay(100);
  }
  return seen;
}

/**
 * Reads the pooled media element of a clip (the one the preview plays).
 *
 * The pool is exposed by the app on `window.__mediaSourcePool`; its map of
 * video elements is keyed by `<mediaId>_<clipId>`.
 */
async function readPoolElement(page, clipId) {
  return safeEvaluate(page, (cid) => {
    const poolRef = window.__mediaSourcePool;
    if (!poolRef) return { error: 'la app no expone window.__mediaSourcePool' };
    const map = poolRef.videoElements;
    if (!map || typeof map.entries !== 'function') {
      return { error: 'el pool no expone el mapa de elementos de vídeo' };
    }
    const entries = Array.from(map.entries());
    const found = entries.find(([key]) => key.endsWith(`_${cid}`));
    if (!found) return { found: false, keys: entries.map(([k]) => k) };
    const el = found[1];
    return {
      found: true,
      key: found[0],
      playbackRate: el.playbackRate,
      preservesPitch: el.preservesPitch,
      readyState: el.readyState,
    };
  }, clipId);
}

/** Polls the pooled element until `predicate` accepts it (or the time runs out). */
async function waitForPoolElement(page, clipId, predicate, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await readPoolElement(page, clipId);
    if (last && predicate(last)) return last;
    await delay(150);
  }
  return last;
}

/** Sets the value of a React controlled <select> (the native setter bypasses React). */
async function selectOption(page, testid, value) {
  return safeEvaluate(
    page,
    (id, val) => {
      const select = document.querySelector(`[data-testid="${id}"]`);
      if (!select || select.tagName !== 'SELECT') return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value'
      ).set;
      setter.call(select, val);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value === val;
    },
    testid,
    value
  );
}

/** Moves a React controlled <input type="range"> to `value`. */
async function setRangeValue(page, testid, value) {
  return safeEvaluate(
    page,
    (id, val) => {
      const input =
        document.querySelector(`[data-testid="${id}"]`) ||
        document.querySelector(`input[aria-label="${id}"]`);
      if (!input) return null;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(input, String(val));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value;
    },
    testid,
    value
  );
}

/** Parses "72,0 KB" into bytes (the Spanish format of the app). */
function parseStorageBytes(text) {
  const match = String(text ?? '').match(/([\d.,]+)\s*(B|KB|MB|GB|TB)/);
  if (!match) return null;
  const value = Number(match[1].replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return value * (units[match[2]] ?? 1);
}

/* ------------------------------------------------------------------ *
 * 1. The internal clipboard (F7)
 * ------------------------------------------------------------------ */
async function caseClipboard({ browser, report, baseUrl }) {
  const outcome = await runScenario(async () => {
    const { context, page } = await bootApp(browser, { width: 1440, height: 900, baseUrl });
    try {
      const navBefore = navCount(page);
      const checks = [];

      await generateSampleMedia(page);
      await addFirstMediaToTimeline(page);
      // A wide clip (5 s x 60 px/s = 300 px) shows the Spanish labels of the
      // action row instead of the bare icons.
      await setFirstClipDuration(page, 5);
      const originalId = await selectFirstClip(page);

      /* --- CLIPBOARD-ACTIONS-TOUCH ---------------------------------- */
      const actions = await safeEvaluate(page, () => {
        const group = document.querySelector('[data-testid="clip-clipboard-actions"]');
        if (!group) return null;
        const read = (sel) => {
          const btn = group.querySelector(sel);
          if (!btn) return null;
          const rect = btn.getBoundingClientRect();
          return {
            ariaLabel: (btn.getAttribute('aria-label') || '').trim(),
            title: (btn.getAttribute('title') || '').trim(),
            visibleText: (btn.textContent || '').trim(),
            width: rect.width,
            height: rect.height,
          };
        };
        return {
          copy: read('[data-testid="clip-copy-button"]'),
          paste: read('[data-testid="clip-paste-button"]'),
          duplicate: read('[data-testid="clip-duplicate-button"]'),
        };
      });

      const expected = [
        ['copy', 'Copiar'],
        ['paste', 'Pegar'],
        ['duplicate', 'Duplicar'],
      ];
      const actionProblems = [];
      for (const [key, word] of expected) {
        const btn = actions && actions[key];
        if (!btn) {
          actionProblems.push(`falta el botón «${word}»`);
          continue;
        }
        if (!btn.ariaLabel.includes(word) && !btn.title.includes(word)) {
          actionProblems.push(`«${word}» sin etiqueta accesible (aria-label="${btn.ariaLabel}")`);
        }
        if (btn.visibleText !== word) {
          actionProblems.push(`«${word}» sin texto visible ("${btn.visibleText}")`);
        }
        if (!(btn.height >= 26)) {
          actionProblems.push(`«${word}» con un área táctil de ${btn.height.toFixed(1)} px (< 26)`);
        }
      }

      checks.push({
        id: 'CLIPBOARD-ACTIONS-TOUCH',
        title: 'El clip seleccionado ofrece Copiar / Pegar / Duplicar con un área táctil >= 26 px',
        ok: Boolean(actions) && actionProblems.length === 0,
        message: actions
          ? [
              `copiar=${actions.copy ? `${actions.copy.visibleText} (${actions.copy.width.toFixed(0)}x${actions.copy.height.toFixed(0)} px)` : 'n/d'}`,
              `pegar=${actions.paste ? `${actions.paste.visibleText} (${actions.paste.width.toFixed(0)}x${actions.paste.height.toFixed(0)} px)` : 'n/d'}`,
              `duplicar=${actions.duplicate ? `${actions.duplicate.visibleText} (${actions.duplicate.width.toFixed(0)}x${actions.duplicate.height.toFixed(0)} px)` : 'n/d'}`,
            ].join(' | ') +
            (actionProblems.length ? ` | PROBLEMAS: ${actionProblems.join('; ')}` : '')
          : 'No se encontró la fila de acciones del portapapeles ([data-testid="clip-clipboard-actions"])',
        details: { actions, actionProblems },
      });

      /* --- CLIPBOARD-SHORTCUT-COPY-PASTE ----------------------------- */
      const before = await readStoreState(page);
      await pressCtrl(page, 'KeyC');
      const afterCopy = await readStoreState(page);
      await pressCtrl(page, 'KeyV');
      const afterPaste = await readStoreState(page);
      await pressCtrl(page, 'KeyZ');
      const afterUndo = await readStoreState(page);
      // The undo may clear the selection (the store resets it), so the user
      // has to pick the clip again before duplicating it.
      await selectFirstClip(page);
      await pressCtrl(page, 'KeyD');
      const afterDuplicate = await readStoreState(page);

      const pastedId = afterPaste && afterPaste.selectedClipId;
      const pastedIsNew =
        Boolean(pastedId) &&
        pastedId !== originalId &&
        Boolean(afterPaste && afterPaste.clips.some((c) => c.id === pastedId));

      const shortcutsOk =
        before &&
        before.clipCount === 1 &&
        afterCopy &&
        afterCopy.clipboardLength === 1 &&
        afterPaste &&
        afterPaste.clipCount === before.clipCount + 1 &&
        pastedIsNew &&
        afterUndo &&
        afterUndo.clipCount === before.clipCount &&
        afterDuplicate &&
        afterDuplicate.clipCount === before.clipCount + 1;

      checks.push({
        id: 'CLIPBOARD-SHORTCUT-COPY-PASTE',
        title: 'Ctrl+C copia, Ctrl+V pega (y selecciona), Ctrl+Z deshace y Ctrl+D duplica',
        ok: Boolean(shortcutsOk),
        message:
          `clips ${before?.clipCount} -> copiar (portapapeles=${afterCopy?.clipboardLength}) -> ` +
          `pegar (clips=${afterPaste?.clipCount}, seleccionado=${pastedId}, es nuevo=${pastedIsNew}) -> ` +
          `deshacer (clips=${afterUndo?.clipCount}) -> duplicar (clips=${afterDuplicate?.clipCount})`,
        details: { before, afterCopy, afterPaste, afterUndo, afterDuplicate },
      });

      /* --- CLIPBOARD-TEXT-ENTRY -------------------------------------- */
      const beforeText = await readStoreState(page);
      const focused = await safeEvaluate(page, () => {
        const input = document.querySelector('input[aria-label="Nombre del proyecto"]');
        if (!input) return false;
        input.focus();
        return document.activeElement === input;
      });
      await pressCtrl(page, 'KeyC', { blur: false });
      const afterText = await readStoreState(page);

      checks.push({
        id: 'CLIPBOARD-TEXT-ENTRY',
        title: 'Ctrl+C dentro de un <input> no secuestra el portapapeles del sistema',
        ok: Boolean(
          focused &&
            beforeText &&
            beforeText.clipboardLength > 0 &&
            afterText &&
            afterText.clipboardLength === beforeText.clipboardLength
        ),
        message:
          `el input del nombre del proyecto tenía el foco=${focused} | ` +
          `portapapeles interno ${beforeText?.clipboardLength} -> ${afterText?.clipboardLength} ` +
          `(no debe cambiar mientras se escribe)`,
        details: {
          focused,
          before: beforeText?.clipboardLength,
          after: afterText?.clipboardLength,
        },
      });

      /* --- CLIPBOARD-REFUSAL-VISIBLE --------------------------------- */
      const trackId = afterText?.clips?.[0]?.trackId ?? null;
      const locked = await safeEvaluate(page, (tid) => {
        if (!tid) return false;
        const btn = document.querySelector(
          `[data-testid="track-header-${tid}"] button[aria-label="Bloquear pista"]`
        );
        if (!btn) return false;
        btn.click();
        return true;
      }, trackId);

      // Wait until the track is really locked.
      let trackLocked = false;
      for (let i = 0; i < 40 && !trackLocked; i++) {
        trackLocked = await safeEvaluate(page, (tid) => {
          const store = window.__projectStore;
          if (!store || !tid) return false;
          const track = store.getState().project.tracks.find((t) => t.id === tid);
          return Boolean(track && track.isLocked);
        }, trackId);
        if (!trackLocked) await delay(100);
      }

      const pasteClicked = await safeEvaluate(page, () => {
        const btn = document.querySelector('[data-testid="clip-paste-button"]');
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      });

      // Wait until the refusal banner shows up.
      let banner = null;
      for (let i = 0; i < 40; i++) {
        banner = await safeEvaluate(page, () => {
          const el = document.querySelector('[data-testid="store-last-error"]');
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            text: (el.textContent || '').trim(),
            width: rect.width,
            height: rect.height,
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
          };
        });
        if (banner) break;
        await delay(100);
      }

      const visible = Boolean(
        banner &&
          banner.display !== 'none' &&
          banner.visibility !== 'hidden' &&
          banner.opacity !== '0' &&
          banner.width > 0 &&
          banner.height > 0
      );

      checks.push({
        id: 'CLIPBOARD-REFUSAL-VISIBLE',
        title: 'Pegar sobre una pista bloqueada muestra un aviso visible con «bloqueada»',
        ok: Boolean(
          locked &&
            trackLocked &&
            pasteClicked &&
            visible &&
            banner.text.includes('bloqueada')
        ),
        message:
          `pista bloqueada=${trackLocked} | clic en «Pegar»=${pasteClicked} | ` +
          `aviso visible=${visible} (${banner ? `${banner.width.toFixed(0)}x${banner.height.toFixed(0)} px, display=${banner.display}, visibility=${banner.visibility}` : 'n/d'}) | ` +
          `texto: "${banner ? banner.text : 'n/d'}"`,
        details: { locked, trackLocked, pasteClicked, banner },
      });

      return { reloaded: navCount(page) !== navBefore, checks };
    } finally {
      await context.close();
    }
  });

  for (const check of outcome.checks) {
    report.check(check.id, check.title, check.ok, check.message, check.details);
  }
}

/* ------------------------------------------------------------------ *
 * 2. The colour filters (F9)
 * ------------------------------------------------------------------ */
async function caseColor({ browser, report, baseUrl }) {
  const outcome = await runScenario(async () => {
    const { context, page } = await bootApp(browser, { width: 1440, height: 900, baseUrl });
    try {
      const navBefore = navCount(page);
      const checks = [];

      await generateSampleMedia(page);
      await addFirstMediaToTimeline(page);
      const clipId = await selectFirstClip(page);

      /* --- COLOR-SECTION -------------------------------------------- */
      const section = await safeEvaluate(page, () => {
        const el = document.querySelector('[data-testid="inspector-color-section"]');
        const select = document.querySelector('[data-testid="clip-color-preset"]');
        const sliders = Array.from(
          document.querySelectorAll('[data-testid^="clip-color-"]')
        ).filter((n) => n.tagName === 'INPUT' && n.type === 'range');
        return {
          hasSection: Boolean(el),
          sectionText: el ? (el.innerText || '').slice(0, 200) : null,
          selectPresent: Boolean(select),
          selectDisabled: select ? select.disabled : null,
          options: select
            ? Array.from(select.options).map((o) => (o.textContent || '').trim())
            : [],
          sliderLabels: sliders.map((s) => (s.getAttribute('aria-label') || '').trim()),
          sliderCount: sliders.length,
        };
      });

      const missingOptions = EXPECTED_COLOR_PRESETS.filter(
        (label) => !section.options.includes(label)
      );
      const missingSliders = EXPECTED_COLOR_SLIDERS.filter(
        (label) => !section.sliderLabels.includes(label)
      );

      checks.push({
        id: 'COLOR-SECTION',
        title:
          'La sección de color del Inspector ofrece los 7 preajustes y 6 deslizadores en español',
        ok: Boolean(
          section.hasSection &&
            section.selectPresent &&
            section.selectDisabled === false &&
            missingOptions.length === 0 &&
            missingSliders.length === 0 &&
            section.sliderCount === EXPECTED_COLOR_SLIDERS.length
        ),
        message:
          `sección=${section.hasSection} | select presente=${section.selectPresent}, deshabilitado=${section.selectDisabled} | ` +
          `preajustes=[${section.options.join(', ')}] | ` +
          `deslizadores (${section.sliderCount})=[${section.sliderLabels.join(' | ')}]` +
          (missingOptions.length ? ` | FALTAN preajustes: ${missingOptions.join(', ')}` : '') +
          (missingSliders.length ? ` | FALTAN deslizadores: ${missingSliders.join(', ')}` : ''),
        details: section,
      });

      /* --- COLOR-PRESET-PIXELS -------------------------------------- */
      const before = await measureStablePreview(page);
      const selected = await selectOption(page, 'clip-color-preset', 'blackWhite');

      // Wait until the store really holds the B/N filters.
      let filtersApplied = null;
      for (let i = 0; i < 40; i++) {
        filtersApplied = await safeEvaluate(page, (cid) => {
          const store = window.__projectStore;
          if (!store) return null;
          const clip = store.getState().project.clips.find((c) => c.id === cid);
          return clip ? clip.filters ?? null : null;
        }, clipId);
        if (filtersApplied && filtersApplied.grayscale === 1) break;
        await delay(100);
      }

      const after = await measureStablePreview(page);

      // "Restablecer color" must bring the original pixels back.
      const resetClicked = await safeEvaluate(page, () => {
        const btn = document.querySelector('[data-testid="clip-color-reset"]');
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      });
      let filtersCleared = null;
      for (let i = 0; i < 40; i++) {
        filtersCleared = await safeEvaluate(page, (cid) => {
          const store = window.__projectStore;
          if (!store) return null;
          const clip = store.getState().project.clips.find((c) => c.id === cid);
          return clip ? clip.filters ?? null : null;
        }, clipId);
        if (!filtersCleared) break;
        await delay(100);
      }
      const reset = await measureStablePreview(page);

      const distance = histogramDistance(before && before.hist, reset && reset.hist);
      const paintedEnough = Boolean(
        before && before.painted >= 500 && after && after.painted >= 500
      );

      checks.push({
        id: 'COLOR-PRESET-PIXELS',
        title:
          'El preajuste B/N envegrece el preview y «Restablecer color» devuelve el histograma original',
        ok: Boolean(
          selected &&
            paintedEnough &&
            before.maxSpread > 2 &&
            after.maxSpread <= 2 &&
            resetClicked &&
            filtersCleared === null &&
            distance <= 0.01
        ),
        message:
          `píxeles pintados: antes=${before?.painted}, B/N=${after?.painted}, restaurado=${reset?.painted} | ` +
          `dispersión máxima de canal: antes=${before?.maxSpread} (> 2), B/N=${after?.maxSpread} (<= 2) | ` +
          `filtros aplicados=${JSON.stringify(filtersApplied)} | ` +
          `distancia entre los histogramas (antes vs restaurado)=${distance.toFixed(5)} (<= 0.01)`,
        details: { before, after, reset, distance, filtersApplied, filtersCleared },
      });

      return { reloaded: navCount(page) !== navBefore, checks };
    } finally {
      await context.close();
    }
  });

  for (const check of outcome.checks) {
    report.check(check.id, check.title, check.ok, check.message, check.details);
  }
}

/* ------------------------------------------------------------------ *
 * 3. The speed and the pitch (F4)
 * ------------------------------------------------------------------ */
async function caseSpeed({ browser, report, baseUrl }) {
  const outcome = await runScenario(async () => {
    const { context, page } = await bootApp(browser, { width: 1440, height: 900, baseUrl });
    try {
      const navBefore = navCount(page);
      const checks = [];

      await generateSampleMedia(page);
      await addFirstMediaToTimeline(page);
      const clipId = await selectFirstClip(page);

      /* --- the speed through the Inspector ("2x") ------------------- */
      const speedClicked = await safeEvaluate(page, () => {
        const btn = Array.from(document.querySelectorAll('button')).find(
          (b) => (b.textContent || '').trim() === '2x'
        );
        if (!btn) return false;
        btn.click();
        return true;
      });

      // The pitch checkbox: two clicks leave it explicitly checked
      // (`preservePitch === true` instead of "undefined").
      const pitchToggled = await safeEvaluate(page, () => {
        const box = document.querySelector('[data-testid="clip-preserve-pitch"]');
        if (!box) return false;
        box.click();
        box.click();
        return true;
      });

      let clipState = null;
      for (let i = 0; i < 60; i++) {
        clipState = await safeEvaluate(page, (cid) => {
          const store = window.__projectStore;
          if (!store) return null;
          const clip = store.getState().project.clips.find((c) => c.id === cid);
          return clip
            ? { speed: clip.speed ?? null, preservePitch: clip.preservePitch ?? null }
            : null;
        }, clipId);
        if (clipState && clipState.speed === 2 && clipState.preservePitch === true) break;
        await delay(100);
      }

      /* --- the pooled media element --------------------------------- */
      const pool = await waitForPoolElement(
        page,
        clipId,
        (p) => p.found && Math.abs((p.playbackRate ?? 0) - 2) < 0.001
      );

      /*
       * The pitch policy must be APPLIED by the app, not just inherited from
       * the browser default (`preservesPitch` is `true` in Chrome out of the
       * box): with the policy off the pooled element has to report `false`.
       */
      await safeEvaluate(page, (cid) => {
        const store = window.__projectStore;
        if (!store) return;
        store.getState().updateClip(cid, { preservePitch: false });
      }, clipId);
      const poolWithoutPitch = await waitForPoolElement(
        page,
        clipId,
        (p) => p.found && p.preservesPitch === false
      );
      await safeEvaluate(page, (cid) => {
        const store = window.__projectStore;
        if (!store) return;
        store.getState().updateClip(cid, { preservePitch: true });
      }, clipId);
      const poolWithPitch = await waitForPoolElement(
        page,
        clipId,
        (p) => p.found && p.preservesPitch === true
      );

      checks.push({
        id: 'PLAYBACK-SPEED-PREVIEW-RATE',
        title: 'Con speed=2 el elemento del pool reproduce a 2x y preserva el tono',
        ok: Boolean(
          speedClicked &&
            clipState &&
            clipState.speed === 2 &&
            pool &&
            pool.found &&
            Math.abs(pool.playbackRate - 2) < 0.001 &&
            pool.preservesPitch === true &&
            poolWithoutPitch &&
            poolWithoutPitch.preservesPitch === false &&
            poolWithPitch &&
            poolWithPitch.preservesPitch === true
        ),
        message:
          `clip: speed=${clipState?.speed}, preservePitch=${clipState?.preservePitch} | ` +
          `elemento del pool "${pool?.key ?? 'n/d'}": playbackRate=${pool?.playbackRate}, ` +
          `preservesPitch=${pool?.preservesPitch}, readyState=${pool?.readyState} | ` +
          `la politica se aplica de verdad: preservePitch=false -> preservesPitch=${poolWithoutPitch?.preservesPitch}, ` +
          `preservePitch=true -> preservesPitch=${poolWithPitch?.preservesPitch}` +
          (pool && pool.error ? ` | ${pool.error}` : ''),
        details: { clipState, pool, poolWithoutPitch, poolWithPitch },
      });

      /* --- PLAYBACK-SPEED-PERSIST ----------------------------------- */
      const mediaBefore = await readMediaPoolCount(page);
      await waitForPersistedProject(page, {
        minClips: 1,
        minMedia: mediaBefore || 1,
        timeoutMs: 20_000,
      });

      await reloadWithRetry(page);
      await waitForAppReady(page);
      await dismissWelcome(page);
      await delay(1200);

      const persisted = await safeEvaluate(page, () => {
        const store = window.__projectStore;
        if (!store) return null;
        return store.getState().project.clips.map((c) => ({
          id: c.id,
          speed: c.speed ?? null,
          preservePitch: c.preservePitch ?? null,
        }));
      });

      const survived = Boolean(
        persisted && persisted.some((c) => c.speed === 2 && c.preservePitch === true)
      );

      checks.push({
        id: 'PLAYBACK-SPEED-PERSIST',
        title: 'Tras recargar, el clip conserva su velocidad (2x) y su política de tono',
        ok: survived,
        message:
          `clips tras recargar: ${JSON.stringify(persisted)} | ` +
          `se esperaba un clip con speed=2 y preservePitch=true`,
        details: { persisted, pitchToggled },
      });

      return { reloaded: navCount(page) !== navBefore, checks };
    } finally {
      await context.close();
    }
  });

  for (const check of outcome.checks) {
    report.check(check.id, check.title, check.ok, check.message, check.details);
  }
}

/* ------------------------------------------------------------------ *
 * 4. The export presets and the export range (F10)
 * ------------------------------------------------------------------ */
async function caseExport({ browser, report, baseUrl }) {
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cut-features-'));
  try {
    const outcome = await runScenario(async () => {
      const { context, page } = await bootApp(browser, { width: 1440, height: 900, baseUrl });
      try {
        const navBefore = navCount(page);
        const checks = [];

        // A previous attempt may have left a file in the download folder.
        for (const name of fs.readdirSync(downloadDir)) {
          fs.rmSync(path.join(downloadDir, name), { force: true });
        }

        const capture = await setupDownloadCapture(browser, context, downloadDir);
        await generateSampleMedia(page);
        await addFirstMediaToTimeline(page);
        // A 3 s project: the export range (1 s -> 2 s) is clearly shorter.
        await setFirstClipDuration(page, 3);
        const projectDuration = await safeEvaluate(page, () => {
          const store = window.__projectStore;
          return store ? store.getState().project.duration : null;
        });

        await openExportModal(page);

        /* --- EXPORT-PRESET-VERTICAL (the modal part) ---------------- */
        const presetClicked = await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="export-preset-vertical-9x16"]');
          if (!btn) return false;
          btn.click();
          return true;
        });
        await delay(400);

        const presetState = await safeEvaluate(page, () => {
          const modal = document.querySelector('div[role="dialog"][aria-label="Exportar video"]');
          const btn = document.querySelector('[data-testid="export-preset-vertical-9x16"]');
          const text = modal ? modal.innerText : '';
          const store = window.__projectStore;
          return {
            pressed: btn ? btn.getAttribute('aria-pressed') : null,
            hasDims: /1080\s*x\s*1920\s*\(9:16\)/.test(text),
            dimsLine: (text.match(/Dimensiones finales:[^\n]*/) || [null])[0],
            projectAspectRatio: store ? store.getState().project.aspectRatio : null,
            projectResolution: store ? store.getState().project.resolution : null,
            allPresets: Array.from(
              document.querySelectorAll('[data-testid^="export-preset-"]')
            ).map((b) => ({
              id: b.getAttribute('data-testid'),
              pressed: b.getAttribute('aria-pressed'),
            })),
          };
        });

        /* --- EXPORT-PRESET-DESELECT ---------------------------------- */
        const bitrateBefore = await safeEvaluate(page, () => {
          const input = document.querySelector(
            'input[aria-label="Tasa de bits en megabits por segundo"]'
          );
          return input ? input.value : null;
        });
        const bitrateAfter = await setRangeValue(
          page,
          'Tasa de bits en megabits por segundo',
          Number(bitrateBefore || 8) + 3
        );
        await delay(400);
        const presetsAfterMove = await safeEvaluate(page, () =>
          Array.from(document.querySelectorAll('[data-testid^="export-preset-"]')).map((b) => ({
            id: b.getAttribute('data-testid'),
            pressed: b.getAttribute('aria-pressed'),
          }))
        );
        const stillPressed = presetsAfterMove.filter((p) => p.pressed === 'true');

        checks.push({
          id: 'EXPORT-PRESET-DESELECT',
          title: 'Al mover el deslizador de bitrate ningún preajuste sigue marcado',
          ok: Boolean(
            bitrateBefore !== null &&
              bitrateAfter !== null &&
              bitrateAfter !== bitrateBefore &&
              stillPressed.length === 0
          ),
          message:
            `bitrate ${bitrateBefore} -> ${bitrateAfter} Mbps | ` +
            `preajustes marcados: ${JSON.stringify(stillPressed)} (debe estar vacío)`,
          details: { bitrateBefore, bitrateAfter, presetsAfterMove },
        });

        /* --- EXPORT-RANGE-LABEL -------------------------------------- */
        // Restore the vertical preset for the export.
        await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="export-preset-vertical-9x16"]');
          if (btn) btn.click();
        });
        await delay(200);

        await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="export-range-custom"]');
          if (btn) btn.click();
        });
        await delay(200);

        const inTime = await seekTo(page, 1);
        await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="export-range-mark-in"]');
          if (btn) btn.click();
        });
        await delay(200);
        const outTime = await seekTo(page, 2);
        await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="export-range-mark-out"]');
          if (btn) btn.click();
        });
        await delay(300);

        const rangeState = await safeEvaluate(page, () => {
          const modal = document.querySelector('div[role="dialog"][aria-label="Exportar video"]');
          const summary = document.querySelector('[data-testid="export-range-summary"]');
          const rows = modal
            ? Array.from(modal.querySelectorAll('div.flex.justify-between')).map((row) => ({
                label: (row.children[0]?.textContent || '').trim(),
                value: (row.children[1]?.textContent || '').trim(),
              }))
            : [];
          const pick = (prefix) => {
            const row = rows.find((r) => r.label.startsWith(prefix));
            return row ? row.value : null;
          };
          return {
            summary: summary ? (summary.textContent || '').trim() : null,
            durationText: pick('Duración de exportación'),
            framesText: pick('Total de fotogramas'),
            rangeText: pick('Rango de exportación'),
            rows,
          };
        });

        // Formato frame-accurate HH:MM:SS:FF (W-17 cambió el formato a
        // Math.floor -> Math.round(seconds*fps) con cuadros).
        const summaryOk = Boolean(
          rangeState.summary &&
            /^Exportando \d{2}:\d{2}:\d{2}:\d{2} → \d{2}:\d{2}:\d{2}:\d{2} \(\d+(?:\.\d+)? s\)$/.test(
              rangeState.summary
            )
        );
        const durationNumber = rangeState.durationText
          ? Number((rangeState.durationText.match(/-?\d+(?:\.\d+)?/) || [null])[0])
          : null;
        const framesNumber = rangeState.framesText
          ? Number((rangeState.framesText.match(/\d+/) || [null])[0])
          : null;

        checks.push({
          id: 'EXPORT-RANGE-LABEL',
          title:
            'Los marcadores de entrada/salida producen un resumen de rango (y duración/fotogramas del rango)',
          ok: Boolean(
            summaryOk &&
              durationNumber === 1 &&
              framesNumber === 30 &&
              projectDuration !== null &&
              durationNumber !== projectDuration
          ),
          message:
            `resumen="${rangeState.summary}" | duración de exportación=${rangeState.durationText} (el proyecto dura ${projectDuration} s) | ` +
            `fotogramas=${rangeState.framesText} | fila de rango=${rangeState.rangeText} | ` +
            `cabezal: entrada=${inTime} s, salida=${outTime} s`,
          details: { rangeState, projectDuration, inTime, outTime },
        });

        /* --- the export itself -------------------------------------- */
        let file = null;
        let modalState = null;
        let reloadedDuringExport = false;
        const started = Date.now();
        await clickButtonByText(page, 'Comenzar Exportación');
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          file = await capture.waitForFile({
            timeoutMs: 1500,
            match: (name) => name.toLowerCase().endsWith('.mp4'),
            minBytes: 1024,
          });
          if (file) break;
          // A reload of the dev server aborts the export: the scenario is
          // re-run from scratch instead of waiting for the timeout.
          if (navCount(page) !== navBefore) {
            reloadedDuringExport = true;
            break;
          }
          modalState = await safeEvaluate(page, () => {
            const modal = document.querySelector('div[role="dialog"][aria-label="Exportar video"]');
            if (!modal) return 'el modal se cerró';
            return modal.innerText.replace(/\s+/g, ' ').slice(0, 220);
          });
          await delay(400);
        }
        const elapsedMs = Date.now() - started;

        if (reloadedDuringExport) {
          return { reloaded: true, checks: [] };
        }

        if (!file) {
          checks.push({
            id: 'EXPORT-PRESET-VERTICAL',
            title:
              'El preajuste vertical exporta un MP4 de 1080x1920 sin reformatar el proyecto',
            ok: false,
            message: `No se descargó ningún .mp4 en 90 s | último estado del modal: ${modalState || 'n/d'}`,
          });
          checks.push({
            id: 'EXPORT-RANGE-MP4-DURATION',
            title: 'El MP4 descargado dura exactamente el rango de exportación',
            ok: false,
            message: 'Sin archivo descargado',
          });
          return { reloaded: navCount(page) !== navBefore, checks };
        }

        const trackSize = readMp4VideoTrackSize(file.filePath);
        const movie = readMp4MovieDuration(file.filePath);

        checks.push({
          id: 'EXPORT-PRESET-VERTICAL',
          title:
            'El preajuste vertical exporta un MP4 de 1080x1920 sin reformatar el proyecto',
          ok: Boolean(
            presetClicked &&
              presetState.pressed === 'true' &&
              presetState.hasDims &&
              presetState.projectAspectRatio === '16:9' &&
              trackSize &&
              Math.round(trackSize.width) === 1080 &&
              Math.round(trackSize.height) === 1920
          ),
          message:
            `preajuste vertical: aria-pressed=${presetState.pressed} | "${presetState.dimsLine}" | ` +
            `aspectRatio del proyecto=${presetState.projectAspectRatio} (resolución ${presetState.projectResolution?.width}x${presetState.projectResolution?.height}) | ` +
            `tkhd del MP4 descargado (${file.name}, ${file.size} bytes, ${(elapsedMs / 1000).toFixed(1)} s): ` +
            `${trackSize ? `${Math.round(trackSize.width)}x${Math.round(trackSize.height)}` : 'n/d'}`,
          details: { presetState, trackSize, file: file.name, size: file.size },
        });

        checks.push({
          id: 'EXPORT-RANGE-MP4-DURATION',
          title: 'El MP4 descargado dura exactamente el rango de exportación (no el proyecto)',
          ok: Boolean(
            movie &&
              Math.abs(movie.seconds - 1) <= 0.2 &&
              projectDuration !== null &&
              Math.abs(movie.seconds - projectDuration) > 0.5
          ),
          message:
            `mvhd del MP4: ${movie ? `${movie.duration}/${movie.timescale} = ${movie.seconds.toFixed(3)} s` : 'n/d'} | ` +
            `el rango exportado dura 1 s y el proyecto ${projectDuration} s`,
          details: { movie, projectDuration },
        });

        /* --- KNOWN DEFECT: the range timecodes are truncated -------- */
        /*
         * `formatExportTimecode()` floors the seconds, so a marker placed at
         * 0,9 s is shown as "00:00:00" and one at 1,1 s as "00:00:01": the
         * summary then contradicts the duration it displays ("00:00:00 →
         * 00:00:01 (0.2 s)"). It is reported as an INFORMATIONAL check (it
         * does not break the build) until the defect is fixed.
         */
        try {
          await closeExportModal(page);
        } catch {
          /* the modal may already be closed */
        }
        await delay(300);
        await openExportModal(page);
        await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="export-range-custom"]');
          if (btn) btn.click();
        });
        await delay(200);
        await seekTo(page, 0.9);
        await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="export-range-mark-in"]');
          if (btn) btn.click();
        });
        await delay(200);
        await seekTo(page, 1.1);
        await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="export-range-mark-out"]');
          if (btn) btn.click();
        });
        await delay(300);

        const fractional = await safeEvaluate(page, () => {
          const modal = document.querySelector('div[role="dialog"][aria-label="Exportar video"]');
          const summary = document.querySelector('[data-testid="export-range-summary"]');
          const rows = modal
            ? Array.from(modal.querySelectorAll('div.flex.justify-between')).map((row) => ({
                label: (row.children[0]?.textContent || '').trim(),
                value: (row.children[1]?.textContent || '').trim(),
              }))
            : [];
          const pick = (prefix) => {
            const row = rows.find((r) => r.label.startsWith(prefix));
            return row ? row.value : null;
          };
          return {
            summary: summary ? (summary.textContent || '').trim() : null,
            durationText: pick('Duración de exportación'),
            rangeText: pick('Rango de exportación'),
          };
        });

        // The defect reproduces when the displayed timecodes hide the
        // fractional part of the marked range.
        const truncated = Boolean(
          fractional.summary &&
            /00:00:0\d → 00:00:0\d/.test(fractional.summary) &&
            !fractional.summary.includes('0,9') &&
            !fractional.summary.includes('1,1')
        );

        const knownResult = {
          id: 'EXPORT-RANGE-TIMECODE',
          title:
            'Los marcadores con decimales del rango se muestran truncados (00:00:00 → 00:00:01 (0,2 s))',
          ok: truncated,
          message: truncated
            ? `DEFECTO CONFIRMADO: los marcadores 0,9 s → 1,1 s se muestran como "${fractional.summary}" ` +
              `(duración=${fractional.durationText}, fila de rango=${fractional.rangeText}). ` +
              `El tiempo real del rango no aparece en la interfaz.`
            : `El defecto NO se reproduce: "${fractional.summary}" (duración=${fractional.durationText}).`,
          details: fractional,
        };

        return { reloaded: navCount(page) !== navBefore, checks, known: knownResult };
      } finally {
        await context.close();
      }
    }, {
      expected: [
        {
          id: 'EXPORT-PRESET-VERTICAL',
          title:
            'El preajuste vertical exporta un MP4 de 1080x1920 sin reformatar el proyecto',
        },
        {
          id: 'EXPORT-RANGE-MP4-DURATION',
          title: 'El MP4 descargado dura exactamente el rango de exportación (no el proyecto)',
        },
      ],
    });

    for (const check of outcome.checks) {
      report.check(check.id, check.title, check.ok, check.message, check.details);
    }
    if (outcome.known) {
      report.known(
        outcome.known.id,
        outcome.known.title,
        outcome.known.ok,
        outcome.known.message,
        outcome.known.details
      );
    }
  } finally {
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * 5. The storage manager (F1/F2)
 * ------------------------------------------------------------------ */
async function caseStorage({ browser, report, baseUrl }) {
  const outcome = await runScenario(async () => {
    const { context, page } = await bootApp(browser, { width: 1440, height: 900, baseUrl });
    try {
      const navBefore = navCount(page);
      const checks = [];

      await generateSampleMedia(page);

      /* --- STORAGE-QUOTA-PANEL -------------------------------------- */
      await safeEvaluate(page, () => {
        const btn = document.querySelector('[data-testid="storage-panel-toggle"]');
        if (btn) btn.click();
      });

      let quota = null;
      for (let i = 0; i < 40; i++) {
        quota = await safeEvaluate(page, () => {
          const text = document.querySelector('[data-testid="storage-quota-text"]');
          const percent = document.querySelector('[data-testid="storage-quota-percent"]');
          if (!text) return null;
          return {
            text: (text.textContent || '').trim(),
            percent: percent ? (percent.textContent || '').trim() : null,
          };
        });
        if (quota && quota.text && quota.text !== 'Espacio usado: no disponible') break;
        await delay(150);
      }

      const estimate = await safeEvaluate(page, async () => {
        if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return null;
        const e = await navigator.storage.estimate();
        return { usage: Number(e.usage) || 0, quota: Number(e.quota) || 0 };
      });

      const displayedPercent =
        quota && quota.percent
          ? Number((quota.percent.match(/-?\d+(?:\.\d+)?/) || [null])[0])
          : null;
      const expectedPercent =
        estimate && estimate.quota > 0
          ? Math.min(100, Math.round((estimate.usage / estimate.quota) * 1000) / 10)
          : null;
      const percentOk =
        displayedPercent !== null &&
        expectedPercent !== null &&
        Math.abs(displayedPercent - expectedPercent) <= 1;

      // The text itself must agree with the estimate ("72,0 KB de 10,0 GB").
      const parts = quota && quota.text ? quota.text.split(/\s+de\s+/) : [];
      const shownUsage = parts.length === 2 ? parseStorageBytes(parts[0]) : null;
      const shownQuota = parts.length === 2 ? parseStorageBytes(parts[1]) : null;
      const usageOk =
        shownUsage !== null &&
        estimate !== null &&
        Math.abs(shownUsage - estimate.usage) <= Math.max(1024 * 1024, estimate.usage * 0.1);
      const quotaOk =
        shownQuota !== null &&
        estimate !== null &&
        estimate.quota > 0 &&
        Math.abs(shownQuota - estimate.quota) / estimate.quota <= 0.05;

      checks.push({
        id: 'STORAGE-QUOTA-PANEL',
        title: 'El panel de almacenamiento muestra la cuota real del navegador',
        ok: Boolean(
          quota &&
            quota.text &&
            quota.text !== 'Espacio usado: no disponible' &&
            / de /.test(quota.text) &&
            percentOk &&
            usageOk &&
            quotaOk &&
            estimate
        ),
        message:
          `texto="${quota?.text}" (uso=${shownUsage} B, cuota=${shownQuota} B) | ` +
          `porcentaje mostrado=${quota?.percent} % | ` +
          `navigator.storage.estimate(): uso=${estimate?.usage} B, cuota=${estimate?.quota} B ` +
          `=> ${expectedPercent} % | diferencia=${displayedPercent !== null && expectedPercent !== null ? Math.abs(displayedPercent - expectedPercent).toFixed(2) : 'n/d'} puntos`,
        details: {
          quota,
          estimate,
          expectedPercent,
          displayedPercent,
          shownUsage,
          shownQuota,
        },
      });

      /* --- STORAGE-PURGE-TRASH -------------------------------------- */
      const importedName = 'importado-hydra.webm';
      const importResult = await safeEvaluate(page, async (name) => {
        const store = window.__projectStore;
        if (!store) return { ok: false, reason: 'la app no expone el store' };
        const media = store.getState().project.mediaPool.find((m) => m.type === 'video');
        if (!media) return { ok: false, reason: 'no hay ningún medio de vídeo para reimportar' };
        let blob;
        try {
          blob = await (await fetch(media.url)).blob();
        } catch (err) {
          return { ok: false, reason: `no se pudo leer el medio: ${err && err.message}` };
        }
        const file = new File([blob], name, { type: blob.type || 'video/webm' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const target = document.querySelector('[role="button"][aria-label*="pulsa para añadir"]');
        if (!target) return { ok: false, reason: 'no se encontró la zona de medios' };
        target.dispatchEvent(
          new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
        );
        return { ok: true, size: file.size };
      }, importedName);

      // Wait until the imported media shows up in the pool.
      let importedId = null;
      for (let i = 0; i < 80; i++) {
        importedId = await safeEvaluate(page, (name) => {
          const store = window.__projectStore;
          if (!store) return null;
          const item = store.getState().project.mediaPool.find((m) => m.name === name);
          return item ? item.id : null;
        }, importedName);
        if (importedId) break;
        await delay(200);
      }

      const countOpfsFiles = async () =>
        safeEvaluate(page, async () => {
          try {
            if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
              return { error: 'OPFS no disponible' };
            }
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle('media');
            let count = 0;
            for await (const entry of dir.values()) {
              if (entry.kind === 'file') count++;
            }
            return { count };
          } catch (err) {
            return { error: `OPFS: ${err && err.message}` };
          }
        });

      const opfsWithMedia = await countOpfsFiles();

      // Move the imported media to the trash (the bytes stay in OPFS).
      const trashed = await safeEvaluate(page, (name) => {
        const btn = document.querySelector(`button[aria-label="Mover ${name} a la papelera"]`);
        if (!btn) return false;
        btn.click();
        return true;
      }, importedName);

      let trashState = null;
      for (let i = 0; i < 40; i++) {
        trashState = await readStoreState(page);
        if (trashState && trashState.trashLength === 1) break;
        await delay(100);
      }

      const opfsInTrash = await countOpfsFiles();

      // Two taps on the purge action: the first one arms it, the second one
      // destroys the bytes for good.
      const firstTap = await safeEvaluate(page, () => {
        const btn = document.querySelector('[data-testid="purge-trash"]');
        if (!btn) return false;
        btn.click();
        return true;
      });
      await delay(300);
      const armed = await safeEvaluate(page, () => {
        const btn = document.querySelector('[data-testid="purge-trash"]');
        return btn ? (btn.textContent || '').trim() : null;
      });
      const secondTap = await safeEvaluate(page, () => {
        const btn = document.querySelector('[data-testid="purge-trash"]');
        if (!btn) return false;
        btn.click();
        return true;
      });

      // Wait until the trash is empty AND the OPFS file is really gone.
      let after = null;
      let opfsAfter = null;
      for (let i = 0; i < 80; i++) {
        after = await readStoreState(page);
        opfsAfter = await countOpfsFiles();
        if (
          after &&
          after.trashLength === 0 &&
          opfsAfter &&
          typeof opfsAfter.count === 'number' &&
          opfsWithMedia &&
          typeof opfsWithMedia.count === 'number' &&
          opfsAfter.count < opfsWithMedia.count
        ) {
          break;
        }
        await delay(150);
      }

      const trashPanelGone = await safeEvaluate(
        page,
        () => !document.querySelector('[data-testid="trash-panel"]')
      );

      checks.push({
        id: 'STORAGE-PURGE-TRASH',
        title: 'Vaciar la papelera borra de verdad los archivos de OPFS',
        ok: Boolean(
          importResult.ok &&
            importedId &&
            trashed &&
            trashState &&
            trashState.trashLength === 1 &&
            firstTap &&
            armed === 'Confirmar' &&
            secondTap &&
            after &&
            after.trashLength === 0 &&
            trashPanelGone &&
            opfsWithMedia &&
            typeof opfsWithMedia.count === 'number' &&
            opfsWithMedia.count >= 1 &&
            opfsAfter &&
            typeof opfsAfter.count === 'number' &&
            opfsAfter.count < opfsWithMedia.count
        ),
        message:
          `importación: ${importResult.ok ? `OK (${importResult.size} bytes)` : `FALLÓ: ${importResult.reason}`} | ` +
          `archivos en OPFS: tras importar=${opfsWithMedia?.count ?? opfsWithMedia?.error}, ` +
          `con el medio en la papelera=${opfsInTrash?.count ?? opfsInTrash?.error}, ` +
          `tras vaciar=${opfsAfter?.count ?? opfsAfter?.error} | ` +
          `papelera: 1 -> ${after?.trashLength} (panel oculto=${trashPanelGone}) | ` +
          `primer toque=${firstTap} (estado "${armed}"), segundo toque=${secondTap}`,
        details: { importResult, importedId, opfsWithMedia, opfsInTrash, opfsAfter, armed },
      });

      return { reloaded: navCount(page) !== navBefore, checks };
    } finally {
      await context.close();
    }
  });

  for (const check of outcome.checks) {
    report.check(check.id, check.title, check.ok, check.message, check.details);
  }
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 6. Multi-selección (F6) + timecode frame-accurate del rango
 *
 *   MULTISELECT-CTRL-CLICK   Ctrl+clic suma a la selección (2 clips,
 *                            un solo primario, aria-pressed en ambos)
 *   MULTISELECT-SHIFT-CLICK  Mayús+clic selecciona el rango de la pista
 *                            y nunca cruza de pista
 *   MULTISELECT-RUBBER-BAND  la goma selecciona lo que toca, el clic en
 *                            vacío limpia y la rueda sigue con scroll/zoom
 *   MULTISELECT-BATCH-VOLUME el volumen en lote toca los 3 clips y un
 *                            solo Ctrl+Z lo revierte
 *   MULTISELECT-INSPECTOR    "N clips seleccionados" + velocidad mixta
 *                            deshabilitada con su motivo visible
 *   MULTISELECT-DELETE       Supr borra 2 clips y un solo Ctrl+Z los trae
 *   TIMECODE-FRAME-ACCURATE  el resumen usa HH:MM:SS:FF y la duración
 *                            concuerda con los tiempos mostrados
 *
 * Un solo contexto, una sola generación de muestras y un timeline
 * determinista (A,B,C en Video V1 · D en Video V2 · T texto): rápido.
 * ------------------------------------------------------------------ */

/**
 * Los 7 checks que el escenario debe (usado cuando una recarga del dev
 * server aborta el escenario: entonces se reportan como fallos, nunca se
 * omiten en silencio).
 */
const MULTISELECT_EXPECTED = [
  { id: 'MULTISELECT-CTRL-CLICK', title: 'Ctrl+clic suma clips a la selección' },
  { id: 'MULTISELECT-SHIFT-CLICK', title: 'Mayús+clic selecciona el rango sin cruzar de pista' },
  { id: 'MULTISELECT-RUBBER-BAND', title: 'La goma elástica selecciona lo que toca' },
  { id: 'MULTISELECT-BATCH-VOLUME', title: 'El volumen en lote se deshace con un solo Ctrl+Z' },
  { id: 'MULTISELECT-INSPECTOR', title: 'El Inspector informa de la multi-selección' },
  { id: 'MULTISELECT-DELETE', title: 'Supr borra la selección y Ctrl+Z la devuelve' },
  { id: 'TIMECODE-FRAME-ACCURATE', title: 'El resumen del rango es frame-accurate' },
];

async function caseMultiSelect({ browser, report, baseUrl }) {
  const outcome = await runScenario(async () => {
    const { context, page } = await bootApp(browser, { width: 1440, height: 900, baseUrl });
    try {
      const navBefore = navCount(page);
      const checks = [];
      const decide = (id, title, ok, message, details) =>
        checks.push({ id, title, ok: Boolean(ok), message, details });

      /** Lee la selección del store + los atributos DOM de cada clip. */
      const readSel = () => safeEvaluate(page, () => {
        const store = window.__projectStore;
        if (!store) return null;
        const st = store.getState();
        const dom = {};
        for (const c of st.project.clips) {
          const el = document.querySelector(`[data-clip-id="${c.id}"]`);
          dom[c.id] = el
            ? {
              selected: el.getAttribute('data-selected'),
              primary: el.getAttribute('data-primary'),
              pressed: el.getAttribute('aria-pressed'),
            }
            : null;
        }
        return {
          ids: [...st.selectedClipIds],
          primary: st.selectedClipId,
          past: st.past.length,
          clips: st.project.clips.map((c) => ({
            id: c.id,
            trackId: c.trackId,
            start: c.start,
            duration: c.duration,
            type: c.type,
            volume: c.volume ?? 1,
          })),
          dom,
        };
      });

      /** Clic real sobre un clip con los modificadores que recibe la app. */
      const clickClip = async (clipId, { ctrl = false, shift = false } = {}) => {
        // El clip puede tardar un instante en montarse (rehidratación tras
        // una recarga): se espera a que exista antes de clicar.
        let found = false;
        for (let i = 0; i < 40 && !found; i++) {
          found = await safeEvaluate(
            page,
            (id, mod) => {
              const el = document.querySelector(`[data-clip-id="${id}"]`);
              if (!el) return false;
              el.dispatchEvent(
                new MouseEvent('click', {
                  bubbles: true,
                  cancelable: true,
                  ctrlKey: mod.ctrl,
                  shiftKey: mod.shift,
                })
              );
              return true;
            },
            clipId,
            { ctrl, shift }
          );
          if (!found) await delay(150);
        }
        if (!found) throw new Error(`el clip ${JSON.stringify(clipId)} no está en el DOM`);
        await delay(250);
      };

      await generateSampleMedia(page);

      /* --- timeline determinista ------------------------------------ */
      const setup = await safeEvaluate(page, () => {
        const store = window.__projectStore;
        if (!store) return { ok: false, reason: 'la app no expone window.__projectStore' };
        const video =
          store.getState().project.mediaPool.find((m) => m.type === 'video') ||
          store.getState().project.mediaPool.find((m) => m.type === 'image');
        if (!video) return { ok: false, reason: 'el pool no tiene ningún medio de vídeo/imagen' };
        const ids = {};
        const plan = [
          ['A', 'track_video_1', 5],
          ['B', 'track_video_1', 15],
          ['C', 'track_video_1', 25],
          ['D', 'track_video_2', 16],
        ];
        for (const [key, trackId, start] of plan) {
          const r = store.getState().addClipFromMedia(video, trackId, start);
          if (!r.ok) return { ok: false, reason: `no se pudo colocar el clip ${key}: ${r.reason}` };
          ids[key] = r.clipId;
        }
        store.getState().addTextClip('Texto lote', 35);
        const text = store.getState().project.clips.find((c) => c.type === 'text');
        if (!text) return { ok: false, reason: 'no se pudo crear el clip de texto' };
        ids.T = text.id;
        return { ok: true, ids };
      });

      if (!setup || !setup.ok) {
        const msg = `No se pudo preparar el timeline: ${setup ? setup.reason : 'sin respuesta del store'}`;
        for (const item of MULTISELECT_EXPECTED) {
          decide(item.id, item.title, false, msg);
        }
        return { reloaded: navCount(page) !== navBefore, checks };
      }
      const { A, B, C, D, T } = setup.ids;
      const idList = { A, B, C, D, T };
      const badIds = Object.entries(idList).filter(([, v]) => typeof v !== 'string' || !v);
      if (badIds.length > 0) {
        const msg =
          `El setup devolvió ids inválidos (${JSON.stringify(setup.ids)}): ` +
          `cada clip debe tener un id de texto (quizá el servidor recargó otro trabajo en curso).`;
        for (const item of MULTISELECT_EXPECTED) {
          decide(item.id, item.title, false, msg, { setupIds: setup.ids });
        }
        return { reloaded: navCount(page) !== navBefore, checks };
      }

      try {
      /* --- 1. MULTISELECT-CTRL-CLICK -------------------------------- */
      await safeEvaluate(page, () => window.__projectStore.getState().clearSelection());
      await delay(150);
      await clickClip(A);
      await clickClip(B, { ctrl: true });
      const s1 = await readSel(page);
      const s1Ok = Boolean(
        s1 &&
        s1.ids.length === 2 &&
        s1.ids.includes(A) &&
        s1.ids.includes(B) &&
        s1.primary === A &&
        s1.dom[A] && s1.dom[B] &&
        s1.dom[A].selected === 'true' &&
        s1.dom[B].selected === 'true' &&
        s1.dom[A].pressed === 'true' &&
        s1.dom[B].pressed === 'true' &&
        [s1.dom[A].primary, s1.dom[B].primary].filter((v) => v === 'true').length === 1
      );
      decide(
        'MULTISELECT-CTRL-CLICK',
        'Ctrl+clic suma a la selección (2 clips, un solo primario, aria-pressed)',
        s1Ok,
        `selección=[${s1 ? s1.ids.length : 'n/d'}] primario=${s1?.primary} | ` +
        `A: data-selected=${s1?.dom[A]?.selected} data-primary=${s1?.dom[A]?.primary} aria-pressed=${s1?.dom[A]?.pressed} | ` +
        `B: data-selected=${s1?.dom[B]?.selected} data-primary=${s1?.dom[B]?.primary} aria-pressed=${s1?.dom[B]?.pressed}`,
        { setup: setup.ids, selection: s1 }
      );

      /* --- 2. MULTISELECT-SHIFT-CLICK ------------------------------- */
      await clickClip(A);
      await clickClip(C, { shift: true });
      const s2a = await readSel(page);
      const phaseSameTrack = Boolean(
        s2a && s2a.ids.length === 3 &&
        s2a.ids.includes(A) && s2a.ids.includes(B) && s2a.ids.includes(C) &&
        s2a.primary === A
      );
      // En otra pista el rango está vacío: el clic deja SOLO ese clip (la
      // selección anterior no sobrevive ni se mezcla entre pistas).
      await clickClip(A);
      await clickClip(D, { shift: true });
      const s2b = await readSel(page);
      const phaseCrossTrack = Boolean(
        s2b && s2b.ids.length === 1 && s2b.ids[0] === D &&
        !s2b.ids.includes(A) && !s2b.ids.includes(B) && !s2b.ids.includes(C)
      );
      decide(
        'MULTISELECT-SHIFT-CLICK',
        'Mayús+clic selecciona el rango de la pista (3) y nunca cruza de pista',
        phaseSameTrack && phaseCrossTrack,
        `misma pista A→C: [${s2a ? s2a.ids.length : 'n/d'}] primario=${s2a?.primary} (esperado 3, primario=A) | ` +
        `otra pista A→D: [${s2b ? s2b.ids.join(',') : 'n/d'}] (esperado solo D, sin A/B/C)`,
        { sameTrack: s2a, crossTrack: s2b }
      );

      /* --- 3. MULTISELECT-RUBBER-BAND ------------------------------- */
      await safeEvaluate(page, () => {
        const store = window.__projectStore;
        if (store) store.getState().clearSelection();
        const lane = document.querySelector('[data-track-id="track_video_1"]');
        const container = lane ? lane.closest('div.overflow-auto') : null;
        if (container) container.scrollLeft = 150;
      });
      await delay(300);
      const geom = await safeEvaluate(page, () => {
        const lane = document.querySelector('[data-track-id="track_video_1"]');
        const container = lane ? lane.closest('div.overflow-auto') : null;
        if (!lane || !container) return null;
        const rect = (el) => {
          const b = el.getBoundingClientRect();
          return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
        };
        const clips = {};
        for (const el of document.querySelectorAll('[data-clip-id]')) {
          clips[el.getAttribute('data-clip-id')] = rect(el);
        }
        return { lane: rect(lane), container: rect(container), clips };
      });

      let bandVisible = false;
      let bandBox = null;
      let selectedAfterBand = null;
      let touchedIds = null;
      let emptyClickCleared = false;
      let zoomGrew = false;
      let rulerScrolled = false;
      let wheelDetail = null;
      if (geom && geom.clips[A] && geom.clips[B]) {
        const y = (geom.lane.top + geom.lane.bottom) / 2;
        const x0 = Math.max(geom.container.left + 5, geom.clips[A].left - 20);
        let x1 = geom.clips[B].right + 10;
        if (x1 > geom.container.right - 5) x1 = geom.container.right - 5;
        await page.mouse.move(x0, y);
        await page.mouse.down();
        await page.mouse.move(x1, y, { steps: 15 });
        await delay(400);
        const band = await safeEvaluate(page, () => {
          const el = document.querySelector('[data-testid="rubber-band"]');
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { display: getComputedStyle(el).display, width: b.width, height: b.height };
        });
        bandBox = band;
        bandVisible = Boolean(band && band.display !== 'none' && band.width > 10);
        await page.mouse.up();
        await delay(300);
        selectedAfterBand = await readSel(page);
        // Intersección esperada calculada en Node desde los rects medidos.
        const lo = Math.min(x0, x1);
        const hi = Math.max(x0, x1);
        touchedIds = Object.entries(geom.clips)
          .filter(([, r]) => r.left < hi && r.right > lo && r.top < y && r.bottom > y)
          .map(([id]) => id)
          .sort();
        // Clic en el hueco entre A y B: debe vaciar la selección.
        const gx = (geom.clips[A].right + geom.clips[B].left) / 2;
        if (gx > geom.container.left + 5 && gx < geom.container.right - 5) {
          await page.mouse.click(gx, y);
          await delay(300);
          const afterClick = await readSel(page);
          emptyClickCleared = Boolean(afterClick && afterClick.ids.length === 0);
        }
        // La rueda no está secuestrada: Ctrl+rueda = zoom, rueda sobre la
        // regla = scroll horizontal.
        wheelDetail = await safeEvaluate(page, () => {
          const lane = document.querySelector('[data-track-id="track_video_1"]');
          const container = lane ? lane.closest('div.overflow-auto') : null;
          const ruler = document.querySelector('[data-testid="time-ruler"]');
          const store = window.__projectStore;
          if (!lane || !container || !ruler || !store) return null;
          const z0 = store.getState().zoom;
          const s0 = container.scrollLeft;
          container.dispatchEvent(
            new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
          );
          const z1 = store.getState().zoom;
          ruler.dispatchEvent(
            new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true })
          );
          return { z0, z1, s0, s1: container.scrollLeft, maxScroll: container.scrollWidth - container.clientWidth };
        });
        zoomGrew = Boolean(wheelDetail && wheelDetail.z1 > wheelDetail.z0);
        rulerScrolled = Boolean(
          wheelDetail && wheelDetail.maxScroll > 0 && wheelDetail.s1 > wheelDetail.s0
        );
      }
      const touchedSorted = touchedIds ? [...touchedIds].sort() : null;
      const selSorted = selectedAfterBand ? [...selectedAfterBand.ids].sort() : null;
      const exactMatch = Boolean(
        touchedSorted && selSorted &&
        JSON.stringify(touchedSorted) === JSON.stringify(selSorted)
      );
      const nonVacuous = Boolean(
        touchedSorted && touchedSorted.length === 2 &&
        touchedSorted.includes(A) && touchedSorted.includes(B)
      );
      decide(
        'MULTISELECT-RUBBER-BAND',
        'La goma selecciona lo que toca, el clic en vacío limpia y la rueda sigue viva',
        bandVisible && exactMatch && nonVacuous && emptyClickCleared && zoomGrew && rulerScrolled,
        `goma visible durante el arrastre=${bandVisible} (${JSON.stringify(bandBox)}) | ` +
        `tocados=[${touchedSorted ? touchedSorted.join(',') : 'n/d'}] seleccionados=[${selSorted ? selSorted.join(',') : 'n/d'}] ` +
        `exactos=${exactMatch} (A y B, 2 clips=${nonVacuous}) | ` +
        `clic en vacío limpia=${emptyClickCleared} | ` +
        `zoom ${wheelDetail?.z0}→${wheelDetail?.z1} (crece=${zoomGrew}) | ` +
        `scroll regla ${wheelDetail?.s0}→${wheelDetail?.s1} (avanza=${rulerScrolled})`,
        { geom, bandBox, touched: touchedSorted, selected: selSorted, wheel: wheelDetail }
      );

      /* --- 4. MULTISELECT-BATCH-VOLUME ------------------------------ */
      await safeEvaluate(
        page,
        (ids) => window.__projectStore.getState().selectClips(ids),
        [A, B, C]
      );
      await delay(300);
      const beforeVol = await readSel(page);
      const sliderSet = await setRangeValue(page, 'batch-volume', 0.5);
      await delay(400);
      const afterVol = await readSel(page);
      const vols = (s) => [A, B, C].map((id) => s.clips.find((c) => c.id === id)?.volume);
      const allHalf = Boolean(afterVol && vols(afterVol).every((v) => v === 0.5));
      const oneEntry = Boolean(
        beforeVol && afterVol && afterVol.past - beforeVol.past === 1
      );
      await pressCtrl(page, 'KeyZ');
      await delay(400);
      const undoneVol = await readSel(page);
      const volsBack = Boolean(
        undoneVol && beforeVol &&
        [A, B, C].every((id) => {
          const prev = beforeVol.clips.find((c) => c.id === id)?.volume;
          const now = undoneVol.clips.find((c) => c.id === id)?.volume;
          return prev === now;
        })
      );
      decide(
        'MULTISELECT-BATCH-VOLUME',
        'El volumen en lote pone los 3 clips a 0.5 y un solo Ctrl+Z lo revierte',
        sliderSet !== null && allHalf && oneEntry && volsBack,
        `slider batch-volume=${sliderSet} | volúmenes ${JSON.stringify(beforeVol ? vols(beforeVol) : null)} -> ` +
        `${JSON.stringify(afterVol ? vols(afterVol) : null)} (los 3 a 0.5=${allHalf}) | ` +
        `entradas de historial +${afterVol && beforeVol ? afterVol.past - beforeVol.past : 'n/d'} (una=${oneEntry}) | ` +
        `tras Ctrl+Z: ${JSON.stringify(undoneVol ? vols(undoneVol) : null)} (de vuelta=${volsBack})`,
        { before: vols(beforeVol), after: vols(afterVol), undone: undoneVol ? vols(undoneVol) : null }
      );

      /* --- 5. MULTISELECT-INSPECTOR --------------------------------- */
      await safeEvaluate(
        page,
        (ids) => window.__projectStore.getState().selectClips(ids),
        [A, B, C]
      );
      await delay(300);
      const countText = await safeEvaluate(page, () => {
        const el = document.querySelector('[data-testid="inspector-multi-selection-count"]');
        return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : null;
      });
      const countOk = Boolean(countText && /3 clips seleccionados/.test(countText));
      // Texto + vídeo: la velocidad en lote no tiene sentido (el texto no
      // tiene material de origen) y el motivo debe verse.
      await safeEvaluate(
        page,
        (ids) => window.__projectStore.getState().selectClips(ids),
        [T, A]
      );
      await delay(300);
      const speedState = await safeEvaluate(page, () => {
        const input = document.querySelector('[data-testid="batch-speed"]');
        const reason = document.querySelector('[data-testid="batch-speed-disabled-reason"]');
        if (!input) return null;
        let visible = false;
        if (reason) {
          const b = reason.getBoundingClientRect();
          const cs = getComputedStyle(reason);
          visible = cs.display !== 'none' && b.width > 0 && b.height > 0;
        }
        return {
          disabled: input.disabled,
          reason: reason ? (reason.textContent || '').trim().replace(/\s+/g, ' ') : null,
          reasonVisible: visible,
        };
      });
      const speedOk = Boolean(
        speedState && speedState.disabled === true &&
        speedState.reasonVisible && speedState.reason &&
        /velocidad/i.test(speedState.reason)
      );
      decide(
        'MULTISELECT-INSPECTOR',
        'El Inspector muestra "N clips seleccionados" y la velocidad mixta queda deshabilitada con motivo',
        countOk && speedOk,
        `contador="${countText}" (esperado "3 clips seleccionados"=${countOk}) | ` +
        `batch-speed deshabilitado=${speedState?.disabled}, motivo visible=${speedState?.reasonVisible}: ` +
        `"${speedState?.reason ?? 'n/d'}"`,
        { countText, speedState }
      );

      /* --- 6. MULTISELECT-DELETE ------------------------------------ */
      await safeEvaluate(
        page,
        (ids) => window.__projectStore.getState().selectClips(ids),
        [A, B]
      );
      await delay(300);
      const beforeDel = await readSel(page);
      const clipsBefore = beforeDel ? beforeDel.clips.length : null;
      await blurActiveElement(page);
      await page.keyboard.press('Delete');
      await delay(500);
      const afterDel = await readSel(page);
      const gone = Boolean(
        afterDel && !afterDel.clips.some((c) => c.id === A) && !afterDel.clips.some((c) => c.id === B) &&
        clipsBefore !== null && afterDel.clips.length === clipsBefore - 2
      );
      const delOneEntry = Boolean(
        beforeDel && afterDel && afterDel.past - beforeDel.past === 1
      );
      await pressCtrl(page, 'KeyZ');
      await delay(500);
      const undoneDel = await readSel(page);
      const back = Boolean(
        undoneDel && undoneDel.clips.some((c) => c.id === A) && undoneDel.clips.some((c) => c.id === B) &&
        clipsBefore !== null && undoneDel.clips.length === clipsBefore
      );
      decide(
        'MULTISELECT-DELETE',
        'Supr borra los 2 clips seleccionados y un solo Ctrl+Z los devuelve',
        gone && delOneEntry && back,
        `clips ${clipsBefore} -> ${afterDel?.clips.length} (A y B fuera=${gone}) | ` +
        `entradas de historial +${afterDel && beforeDel ? afterDel.past - beforeDel.past : 'n/d'} (una=${delOneEntry}) | ` +
        `tras Ctrl+Z: ${undoneDel?.clips.length} clips (A y B de vuelta=${back})`,
        { clipsBefore, after: afterDel?.clips.length, undone: undoneDel?.clips.length }
      );

      /* --- 7. TIMECODE-FRAME-ACCURATE ------------------------------- */
      let rangeSummary = null;
      let rangeFps = null;
      try {
        await openExportModal(page);
        await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="export-range-custom"]');
          if (btn) btn.click();
        });
        await delay(200);
        await seekTo(page, 1);
        await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="export-range-mark-in"]');
          if (btn) btn.click();
        });
        await delay(200);
        await seekTo(page, 2);
        await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="export-range-mark-out"]');
          if (btn) btn.click();
        });
        await delay(300);
        const range = await safeEvaluate(page, () => {
          const el = document.querySelector('[data-testid="export-range-summary"]');
          const store = window.__projectStore;
          return {
            summary: el ? (el.textContent || '').trim() : null,
            fps: store ? store.getState().project.fps : null,
          };
        });
        rangeSummary = range?.summary ?? null;
        rangeFps = range?.fps ?? null;
      } finally {
        await closeExportModal(page).catch(() => {});
      }
      const m = rangeSummary
        ? rangeSummary.match(
          /^Exportando (\d{2}):(\d{2}):(\d{2}):(\d{2}) → (\d{2}):(\d{2}):(\d{2}):(\d{2}) \((-?\d+(?:\.\d+)?) s\)$/
        )
        : null;
      let agree = false;
      if (m && rangeFps === 30) {
        const toSec = (h, mi, s, f) => Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(f) / rangeFps;
        const shown = toSec(m[1], m[2], m[3], m[4]);
        const shownEnd = toSec(m[5], m[6], m[7], m[8]);
        agree = Math.abs(shownEnd - shown - Number(m[9])) < 0.05;
      }
      const exactExample = rangeSummary === 'Exportando 00:00:01:00 → 00:00:02:00 (1 s)';
      decide(
        'TIMECODE-FRAME-ACCURATE',
        'El resumen del rango usa HH:MM:SS:FF y la duración concuerda con los tiempos',
        Boolean(m) && rangeFps === 30 && exactExample && agree,
        `resumen="${rangeSummary}" (fps=${rangeFps}) | formato HH:MM:SS:FF=${Boolean(m)} | ` +
        `ejemplo exacto 1 s→2 s=${exactExample} | tiempos↔duración concuerdan=${agree}`,
        { rangeSummary, rangeFps }
      );
      } catch (err) {
        // Un fallo de infraestructura (una recarga a mitad del escenario, un
        // DOM que aún no rehidrató…) nunca debe tumbar la suite entera: los
        // checks pendientes se reportan como fallos honestos.
        const detail = err && err.message ? err.message : String(err);
        for (const item of MULTISELECT_EXPECTED) {
          if (checks.some((c) => c.id === item.id)) continue;
          decide(item.id, item.title, false, `El escenario no pudo completarse: ${detail}`);
        }
      }

      return { reloaded: navCount(page) !== navBefore, checks };
    } finally {
      await context.close();
    }
  }, { expected: MULTISELECT_EXPECTED });

  for (const check of outcome.checks) {
    report.check(check.id, check.title, check.ok, check.message, check.details);
  }
}

/* ------------------------------------------------------------------ */

export async function run(ctx) {
  await caseClipboard(ctx);
  await caseColor(ctx);
  await caseSpeed(ctx);
  await caseExport(ctx);
  await caseStorage(ctx);
  await caseMultiSelect(ctx);
}
