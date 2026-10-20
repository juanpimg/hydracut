/**
 * suite-layout.mjs — responsive / layout invariants.
 *
 * For every supported viewport (and for deviceScaleFactor 1 and 3) we assert:
 *   LAYOUT-<w>x<h>@<dsf>-errors    the app boots with 0 uncaught exceptions and
 *                                  0 console errors
 *   LAYOUT-<w>x<h>@<dsf>-overflow  no horizontal overflow on <html>
 *   LAYOUT-<w>x<h>@<dsf>-canvas   the preview <canvas> has a non-zero CSS size
 *
 * And the RENDER SCALE contract (the regression guard of the KI-02 fix):
 *   LAYOUT-<w>x<h>@<dsf>-pixels    the backing store never rasterises more than
 *                                 the project resolution, and never more than
 *                                 the KI-02 pixel budget (1 300 000 px)
 *                                 unless the display itself needs more
 *   LAYOUT-<w>x<h>@<dsf>-crisp     the backing store covers the device pixels of
 *                                 the painted box (HiDPI crispness)
 *   LAYOUT-<w>x<h>@<dsf>-aspect    the backing store keeps the project aspect
 *                                 ratio (the preview is never stretched)
 *   LAYOUT-<w>x<h>@<dsf>-resize    after a `setViewport()` the backing store
 *                                 changes AND re-fits (the ResizeObserver path)
 *   LAYOUT-<id>-preview-height    the landscape preview keeps >= 150 px of
 *                                 visible height (and no horizontal overflow)
 *
 * Plus the scenarios that need a clip / a mobile shell:
 *   LAYOUT-PAINT-ASPECT          the painted-pixel bounding box of the canvas
 *                                 has the aspect ratio of the project (± 1 %)
 *   LAYOUT-MOBILE-SPLIT          the mobile "Dividir" button is disabled with
 *                                 an empty timeline and enabled when the
 *                                 playhead is inside a clip
 *   LAYOUT-BUNDLE-ORIGINS        a full page load requests NOTHING outside
 *                                 the origin of the app (no Google Fonts)
 *   LAYOUT-BUNDLE-EXPORTER       the exporter chunk is NOT requested during
 *                                 the boot (it is loaded on demand)
 *
 * Every viewport runs in its own incognito browser context, so the cases are
 * completely independent of each other and of the execution order.
 */

import {
  bootApp,
  navCount,
  evaluateWithRetry,
  safeEvaluate,
  generateSampleMedia,
  addFirstMediaToTimeline,
  waitForNetworkQuiescence,
  delay,
} from './browser-harness.mjs';

export const name = 'layout';
export const title = 'Layout responsive (6 viewports x 2 devicePixelRatio) + contrato de render';

export const VIEWPORTS = [
  { width: 1440, height: 900, label: 'desktop 1440x900' },
  { width: 768, height: 1024, label: 'tablet 768x1024' },
  { width: 390, height: 844, label: 'mobile 390x844' },
  { width: 320, height: 568, label: 'mobile-xs 320x568' },
  { width: 844, height: 390, label: 'landscape 844x390' },
  { width: 568, height: 320, label: 'landscape-xs 568x320' },
];

export const DEVICE_SCALE_FACTORS = [1, 3];

/**
 * The pixel ceiling documented for the preview (`MAX_PREVIEW_PIXELS`).
 * It is a FLOOR for the budget, not a hard ceiling: a HiDPI display that needs
 * more device pixels than the budget must not be blurred (see the unit test
 * "keeps the pixel ceiling from blurring a HiDPI preview").
 */
const MAX_PREVIEW_PIXELS = 1_300_000;

/**
 * Tolerance of the "crispness" check: the backing store is rounded DOWN to
 * even numbers (H.264 friendly), which can cost up to ~1.5 % of the pixels.
 */
const CRISP_TOLERANCE = 0.98;

/** Maximum relative error of the aspect ratio of the preview. */
const ASPECT_TOLERANCE = 0.01;

/** The background colour the compositor paints (`#0a0a0c`). */
const BACKGROUND = { r: 0x0a, g: 0x0a, b: 0x0c };
/**
 * Where every viewport is resized to (the ResizeObserver check).
 *
 * The targets stay inside the SAME shell (desktop / mobile) so the check
 * exercises the refit and not a remount, and they shrink the preview box
 * enough for the fit to CHANGE: at devicePixelRatio 3 the preview is clamped
 * to the project resolution (1920x1080) as long as the box is wider than
 * 640 CSS px, so a small target is the only way to prove the refit.
 */
const RESIZE_TARGETS = {
  '1440x900': { width: 800, height: 600 },
  '768x1024': { width: 800, height: 600 },
  '390x844': { width: 360, height: 740 },
  '320x568': { width: 360, height: 640 },
  '844x390': { width: 800, height: 360 },
  '568x320': { width: 640, height: 300 },
};

/** The viewports whose preview must keep >= 150 px of visible height. */
const LANDSCAPE_VIEWPORTS = new Set(['844x390', '568x320']);

/**
 * Measures everything the layout checks need in a single round-trip.
 *
 * The canvas is selected through the monitor box (`div.shadow-2xl > canvas`):
 * it is the preview canvas, and it is the ONLY canvas of the preview (the
 * timeline draws its waveforms on other canvases).
 */
async function measure(page) {
  return evaluateWithRetry(page, () => {
    const canvas =
      document.querySelector('div.shadow-2xl canvas') || document.querySelector('canvas');
    const rect = canvas ? canvas.getBoundingClientRect() : null;
    const de = document.documentElement;
    const style = canvas ? getComputedStyle(canvas) : null;
    const store = window.__projectStore;
    const resolution =
      store && store.getState()
        ? store.getState().project.resolution
        : { width: 1920, height: 1080 };

    const cssWidth = rect ? rect.width : 0;
    const cssHeight = rect ? rect.height : 0;
    const backingWidth = canvas ? canvas.width : 0;
    const backingHeight = canvas ? canvas.height : 0;
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    const objectFit = style ? style.objectFit : 'fill';

    // The box the painted content really occupies inside the canvas element
    // (`object-fit` letterboxes the frame inside the element box).
    let paintedWidth = cssWidth;
    let paintedHeight = cssHeight;
    if (backingWidth > 0 && backingHeight > 0) {
      if (objectFit === 'contain') {
        const s = Math.min(cssWidth / backingWidth, cssHeight / backingHeight);
        paintedWidth = backingWidth * s;
        paintedHeight = backingHeight * s;
      } else if (objectFit === 'scale-down') {
        const s = Math.min(1, Math.min(cssWidth / backingWidth, cssHeight / backingHeight));
        paintedWidth = backingWidth * s;
        paintedHeight = backingHeight * s;
      } else if (objectFit === 'cover') {
        const s = Math.max(cssWidth / backingWidth, cssHeight / backingHeight);
        paintedWidth = backingWidth * s;
        paintedHeight = backingHeight * s;
      }
    }

    return {
      mounted: Boolean(canvas),
      overflowX: de.scrollWidth - de.clientWidth,
      bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
      canvasCssWidth: cssWidth,
      canvasCssHeight: cssHeight,
      canvasBackingWidth: backingWidth,
      canvasBackingHeight: backingHeight,
      clientWidth: de.clientWidth,
      scrollWidth: de.scrollWidth,
      dpr,
      objectFit,
      paintedWidth,
      paintedHeight,
      projectWidth: resolution.width,
      projectHeight: resolution.height,
      projectPixels: resolution.width * resolution.height,
      backingPixels: backingWidth * backingHeight,
      devicePixels: cssWidth * dpr * (cssHeight * dpr),
    };
  });
}

/** Waits until the preview canvas exists (the mobile preview is lazy). */
async function waitForPreviewCanvas(page, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await safeEvaluate(
      page,
      () => Boolean(document.querySelector('div.shadow-2xl canvas'))
    );
    if (found) return true;
    await delay(100);
  }
  return false;
}

/**
 * Reads the bounding box of the PAINTED pixels of the preview canvas
 * (everything that is not the background colour).
 */
async function measurePaintedBox(page, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluateWithRetry(page, (bg) => {
      const canvas = document.querySelector('div.shadow-2xl canvas');
      if (!canvas) return null;
      const w = canvas.width;
      const h = canvas.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      let data;
      try {
        data = ctx.getImageData(0, 0, w, h).data;
      } catch (err) {
        return { error: `getImageData falló: ${err && err.message}` };
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -1;
      let maxY = -1;
      let painted = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (
            Math.abs(data[i] - bg.r) > 6 ||
            Math.abs(data[i + 1] - bg.g) > 6 ||
            Math.abs(data[i + 2] - bg.b) > 6
          ) {
            painted++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (painted === 0) {
        return { w, h, painted: 0, total: w * h, bbox: null };
      }
      return {
        w,
        h,
        painted,
        total: w * h,
        bbox: {
          minX,
          minY,
          maxX,
          maxY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        },
      };
    }, BACKGROUND);
    if (last && last.painted > 0) return last;
    await delay(250);
  }
  return last;
}

/* ------------------------------------------------------------------ *
 * 1. The viewport matrix                                              *
 * ------------------------------------------------------------------ */
async function runViewportMatrix({ browser, report, baseUrl }) {
  for (const vp of VIEWPORTS) {
    for (const dsf of DEVICE_SCALE_FACTORS) {
      const id = `${vp.width}x${vp.height}@${dsf}`;
      const { context, page, diagnostics } = await bootApp(browser, {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: dsf,
        baseUrl,
      });

      try {
        await waitForPreviewCanvas(page);

        // Give React one more frame to settle (StrictMode double-render) and
        // re-measure if the Vite dev server hot-reloaded the page meanwhile.
        let m = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          const navBefore = navCount(page);
          await delay(350);
          m = await measure(page);
          if (m && navCount(page) === navBefore) break;
        }

        report.check(
          `LAYOUT-${id}-errors`,
          `Sin errores en ${vp.label} @${dsf}x`,
          diagnostics.pageErrors.length === 0 && diagnostics.consoleErrors.length === 0,
          m.mounted
            ? `0 excepciones y 0 errores de consola` +
                (diagnostics.consoleErrors.length || diagnostics.pageErrors.length
                  ? ` | pageerror: ${JSON.stringify(diagnostics.pageErrors)} | console: ${JSON.stringify(diagnostics.consoleErrors)}`
                  : '')
            : `La app no montó el lienzo de vista previa | pageerror: ${JSON.stringify(diagnostics.pageErrors)}`,
          { details: { pageErrors: diagnostics.pageErrors, consoleErrors: diagnostics.consoleErrors } }
        );

        report.check(
          `LAYOUT-${id}-overflow`,
          `Sin desbordamiento horizontal en ${vp.label} @${dsf}x`,
          m.overflowX === 0,
          `documentElement.scrollWidth - clientWidth = ${m.overflowX} (scrollWidth=${m.scrollWidth}, clientWidth=${m.clientWidth}, body=${m.bodyOverflowX})`,
          { details: m }
        );

        report.check(
          `LAYOUT-${id}-canvas`,
          `Lienzo de vista previa visible en ${vp.label} @${dsf}x`,
          m.canvasCssWidth > 0 && m.canvasCssHeight > 0,
          `CSS ${m.canvasCssWidth.toFixed(1)}x${m.canvasCssHeight.toFixed(1)} px | backing store ${m.canvasBackingWidth}x${m.canvasBackingHeight}`,
          { details: m }
        );

        /* --- the render scale contract --- */

        // The budget of the preview: the KI-02 ceiling, but never below what
        // the display really needs (a HiDPI screen must not be blurred).
        const budget = Math.max(
          MAX_PREVIEW_PIXELS,
          Math.min(m.devicePixels, m.projectPixels)
        );
        const withinProject = m.backingPixels <= m.projectPixels;
        const withinBudget = m.backingPixels <= budget;

        report.check(
          `LAYOUT-${id}-pixels`,
          `El backing store no rasteriza más de lo permitido en ${vp.label} @${dsf}x`,
          withinProject && withinBudget,
          `backing ${m.canvasBackingWidth}x${m.canvasBackingHeight} = ${m.backingPixels} px | ` +
            `resolución del proyecto ${m.projectWidth}x${m.projectHeight} = ${m.projectPixels} px | ` +
            `presupuesto = max(${MAX_PREVIEW_PIXELS}, min(display ${Math.round(m.devicePixels)} px, proyecto ${m.projectPixels} px)) = ${Math.round(budget)} px` +
            (m.devicePixels > MAX_PREVIEW_PIXELS
              ? ` | el display necesita ${Math.round(m.devicePixels)} px de dispositivo (por encima del presupuesto de ${MAX_PREVIEW_PIXELS} px): se rasteriza a la resolución del proyecto, no por encima`
              : ''),
          { details: m }
        );

        const paintedDevicePixels = m.paintedWidth * m.paintedHeight * m.dpr;
        report.check(
          `LAYOUT-${id}-crisp`,
          `El backing store cubre los píxeles del display en ${vp.label} @${dsf}x`,
          m.backingPixels >= paintedDevicePixels * CRISP_TOLERANCE,
          `backing ${m.canvasBackingWidth}x${m.canvasBackingHeight} = ${m.backingPixels} px | ` +
            `caja pintada ${m.paintedWidth.toFixed(1)}x${m.paintedHeight.toFixed(1)} CSS px (object-fit: ${m.objectFit}) x${m.dpr} = ${Math.round(paintedDevicePixels)} px | ` +
            `margen ${(m.backingPixels / Math.max(1, paintedDevicePixels) - 1).toFixed(4)}`,
          { details: m }
        );

        const projectAspect = m.projectWidth / m.projectHeight;
        const backingAspect = m.canvasBackingHeight > 0 ? m.canvasBackingWidth / m.canvasBackingHeight : 0;
        const aspectError =
          projectAspect > 0 ? Math.abs(backingAspect - projectAspect) / projectAspect : 1;
        report.check(
          `LAYOUT-${id}-aspect`,
          `El backing store conserva la proporción del proyecto en ${vp.label} @${dsf}x`,
          aspectError <= ASPECT_TOLERANCE,
          `backing ${m.canvasBackingWidth}x${m.canvasBackingHeight} = ${backingAspect.toFixed(5)} | proyecto ${m.projectWidth}x${m.projectHeight} = ${projectAspect.toFixed(5)} | error ${(aspectError * 100).toFixed(3)} % (máximo ${ASPECT_TOLERANCE * 100} %)`,
          { details: { aspectError, backingAspect, projectAspect } }
        );

        /* --- the refit after a resize --- */

        const target = RESIZE_TARGETS[`${vp.width}x${vp.height}`];
        const before = { w: m.canvasBackingWidth, h: m.canvasBackingHeight };
        await page.setViewport({
          width: target.width,
          height: target.height,
          deviceScaleFactor: dsf,
        });

        // The refit is asynchronous (ResizeObserver -> layout -> paint): poll
        // until the backing store is a VALID, different one and then let the
        // layout settle before the final measurement.
        let after = null;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          await delay(200);
          const candidate = await measure(page);
          if (
            candidate &&
            candidate.canvasBackingWidth > 0 &&
            candidate.canvasBackingHeight > 0 &&
            (candidate.canvasBackingWidth !== before.w ||
              candidate.canvasBackingHeight !== before.h)
          ) {
            await delay(300);
            const settled = await measure(page);
            after =
              settled && settled.canvasBackingWidth > 0 ? settled : candidate;
            break;
          }
        }
        after = after || (await measure(page));

        const changed =
          after &&
          after.canvasBackingWidth > 0 &&
          (after.canvasBackingWidth !== before.w ||
            after.canvasBackingHeight !== before.h);
        const afterBudget = Math.max(
          MAX_PREVIEW_PIXELS,
          Math.min(after.devicePixels, after.projectPixels)
        );
        const afterPainted = after.paintedWidth * after.paintedHeight * after.dpr;
        const afterAspect =
          after.projectWidth > 0
            ? Math.abs(
                after.canvasBackingWidth / after.canvasBackingHeight -
                  after.projectWidth / after.projectHeight
              ) / (after.projectWidth / after.projectHeight)
            : 1;

        report.check(
          `LAYOUT-${id}-resize`,
          `El backing store se reajusta al cambiar el tamaño de la ventana en ${vp.label} @${dsf}x`,
          Boolean(
            changed &&
              after.backingPixels <= after.projectPixels &&
              after.backingPixels <= afterBudget &&
              after.backingPixels >= afterPainted * CRISP_TOLERANCE &&
              afterAspect <= ASPECT_TOLERANCE
          ),
          `antes ${before.w}x${before.h} -> despues ${after.canvasBackingWidth}x${after.canvasBackingHeight} ` +
            `en ${target.width}x${target.height} | presupuesto ${Math.round(afterBudget)} px, ` +
            `pixeles pintados ${Math.round(afterPainted)} px, error de proporcion ${(afterAspect * 100).toFixed(3)} %` +
            (changed
              ? ''
              : ' | el backing store NO se reajustó (o quedó sin dimensionar)'),
          { details: { before, after, target } }
        );

        /* --- the minimum visible height of the landscape preview --- */

        if (LANDSCAPE_VIEWPORTS.has(`${vp.width}x${vp.height}`)) {
          report.check(
            `LAYOUT-${id}-preview-height`,
            `El lienzo conserva >= 150 px de alto visible en ${vp.label} @${dsf}x`,
            m.canvasCssHeight >= 150 && m.scrollWidth <= m.clientWidth,
            `alto visible del lienzo = ${m.canvasCssHeight.toFixed(1)} px (mínimo 150) | ` +
              `documentElement.scrollWidth (${m.scrollWidth}) <= clientWidth (${m.clientWidth})`,
            { details: m }
          );
        }
      } finally {
        await context.close();
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. The painted pixels (a clip in the timeline)                       *
 * ------------------------------------------------------------------ */
async function runPaintedAspect({ browser, report, baseUrl }) {
  const { context, page } = await bootApp(browser, {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    baseUrl,
  });
  try {
    await generateSampleMedia(page);
    await addFirstMediaToTimeline(page);
    await delay(800);

    const box = await measurePaintedBox(page);
    const project = await evaluateWithRetry(page, () => {
      const store = window.__projectStore;
      if (!store) return null;
      const r = store.getState().project.resolution;
      return { width: r.width, height: r.height };
    });

    if (!box || !box.bbox) {
      report.check(
        'LAYOUT-PAINT-ASPECT',
        'La caja de los píxeles pintados conserva la proporción del proyecto',
        false,
        `No se pudo medir la caja pintada (píxeles no-background: ${box ? box.painted : 'n/d'})`
      );
      return;
    }

    const projectAspect = project.width / project.height;
    const paintedAspect = box.bbox.width / box.bbox.height;
    const error = Math.abs(paintedAspect - projectAspect) / projectAspect;

    report.check(
      'LAYOUT-PAINT-ASPECT',
      'La caja de los píxeles pintados conserva la proporción del proyecto',
      error <= ASPECT_TOLERANCE,
      `caja pintada ${box.bbox.width}x${box.bbox.height} = ${paintedAspect.toFixed(5)} | ` +
        `proyecto ${project.width}x${project.height} = ${projectAspect.toFixed(5)} | ` +
        `error ${(error * 100).toFixed(3)} % (máximo ${ASPECT_TOLERANCE * 100} %) | ` +
        `píxeles pintados ${box.painted} de ${box.total} del backing store ${box.w}x${box.h}`,
      { details: { box, project } }
    );
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ *
 * 3. The mobile "Dividir" button                                       *
 * ------------------------------------------------------------------ */
async function runMobileSplit({ browser, report, baseUrl }) {
  const { context, page } = await bootApp(browser, {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    baseUrl,
  });
  try {
    // 3.1 — mobile shell, empty timeline: the button must be disabled.
    await waitForPreviewCanvas(page);
    const empty = await evaluateWithRetry(page, () => {
      const button = document.querySelector('button[aria-label="Dividir clip en el cabezal"]');
      return button
        ? { found: true, disabled: button.disabled }
        : { found: false, disabled: null };
    });

    // 3.2 — a clip in the timeline and the playhead inside it. The sample
    // media is generated from the desktop shell (the media bin lives in the
    // sidebar) and the app swaps the layout on the resize.
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await delay(700);
    await generateSampleMedia(page);
    await addFirstMediaToTimeline(page);
    const clip = await evaluateWithRetry(page, () => {
      const store = window.__projectStore;
      if (!store) return null;
      const c = store.getState().project.clips[0];
      return c ? { start: c.start, duration: c.duration } : null;
    });

    // Back to the mobile shell.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
    await waitForPreviewCanvas(page);
    await delay(800);

    const atStart = await evaluateWithRetry(page, () => {
      const button = document.querySelector('button[aria-label="Dividir clip en el cabezal"]');
      return {
        found: Boolean(button),
        disabled: button ? button.disabled : null,
        time: window.__masterClock ? window.__masterClock.getTime() : null,
      };
    });

    const target = clip ? clip.start + Math.min(1, clip.duration / 2) : 1;
    await evaluateWithRetry(page, (t) => {
      if (window.__masterClock) window.__masterClock.seek(t);
    }, target);
    // The mobile shell re-renders after the resize AND the seek lands
    // asynchronously: a single read after a fixed sleep can observe the
    // button (or the clock) before they settle. Poll until the clock reports
    // the target time and the button is present.
    let inside = null;
    {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        inside = await evaluateWithRetry(page, () => {
          const button = document.querySelector('button[aria-label="Dividir clip en el cabezal"]');
          return {
            found: Boolean(button),
            disabled: button ? button.disabled : null,
            time: window.__masterClock ? window.__masterClock.getTime() : null,
          };
        });
        if (
          inside && inside.found && typeof inside.time === 'number' &&
          Math.abs(inside.time - target) < 0.2
        ) {
          break;
        }
        await delay(150);
      }
    }

    report.check(
      'LAYOUT-MOBILE-SPLIT',
      'El botón "Dividir" se habilita sólo cuando el cabezal está dentro de un clip',
      Boolean(
        empty.found &&
          empty.disabled === true &&
          inside.found &&
          inside.disabled === false &&
          clip
      ),
      `timeline vacío (390x844): found=${empty.found}, disabled=${empty.disabled} | ` +
        `clip [${clip ? clip.start : '?'}..${clip ? clip.start + clip.duration : '?'}] | ` +
        `cabezal en ${atStart.time}: disabled=${atStart.disabled} | ` +
        `cabezal en ${inside.time}: disabled=${inside.disabled}`,
      { details: { empty, atStart, inside, clip } }
    );
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ *
 * 4. The bundle: no foreign origins, no eager exporter                 *
 * ------------------------------------------------------------------ */
async function runBundle({ browser, report, baseUrl }) {
  const { context, page } = await bootApp(browser, {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    baseUrl,
  });
  try {
    const requested = [];
    page.on('request', (req) => {
      try {
        requested.push(req.url());
      } catch {
        /* the page may be closing */
      }
    });

    // A full page load with the cache disabled: every resource is really
    // fetched, so a foreign request cannot hide behind the HTTP cache.
    // The request log is evaluated at network quiescence, not after a fixed
    // sleep: a sleep can fire before the boot has finished (missing a late
    // foreign request = a check that passes vacuously) or too early on a
    // loaded machine.
    await page.setCacheEnabled(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForNetworkQuiescence(() => requested.length, { quietMs: 1500, timeoutMs: 20_000 });

    const appOrigin = new URL(baseUrl).origin;
    const isForeign = (url) => {
      if (url.startsWith('data:') || url.startsWith('blob:')) return false;
      try {
        return new URL(url).origin !== appOrigin;
      } catch {
        return false;
      }
    };
    const foreign = requested.filter(isForeign);
    const exporter = requested.filter((url) => /webcodecsExporter/i.test(url));

    report.check(
      'LAYOUT-BUNDLE-ORIGINS',
      'La carga de la app no pide nada fuera de su propio origen',
      foreign.length === 0,
      foreign.length === 0
        ? `${requested.length} peticiones, todas de ${appOrigin} (sin Google Fonts ni ningún otro origen externo)`
        : `${foreign.length} peticiones externas: ${JSON.stringify(foreign.slice(0, 10))}`,
      { details: { total: requested.length, foreign } }
    );

    report.check(
      'LAYOUT-BUNDLE-EXPORTER',
      'El chunk del exportador NO se pide durante el arranque',
      exporter.length === 0,
      exporter.length === 0
        ? `Ninguna petición coincide con el chunk del exportador durante el arranque (${requested.length} peticiones revisadas)`
        : `El chunk del exportador se pidió durante el arranque: ${JSON.stringify(exporter)}`,
      { details: { exporter, total: requested.length } }
    );
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */

export async function run(ctx) {
  await runViewportMatrix(ctx);
  await runPaintedAspect(ctx);
  await runMobileSplit(ctx);
  await runBundle(ctx);
}
