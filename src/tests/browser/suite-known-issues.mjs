/**
 * suite-known-issues.mjs — the baseline of the defects that were reported.
 *
 * EVERY issue of the list is now FIXED, so this suite is the *regression
 * guard* of those fixes (not a list of open bugs any more):
 *
 *   - each issue is checked TWICE:
 *       1. a HARD check (`report.check`): the invariant of the fix. If the
 *          fix regresses, the run fails (it is a real check, not a note).
 *       2. a DOCUMENTED BASELINE (`report.known`): the exact numbers that
 *          are written down here. With HYDRA_STRICT=1 a drift of the
 *          documented value fails the run loudly: the baseline has to be
 *          updated (that is the point of the strict mode).
 *
 *   KI-01  the export duration floor (a 5 s clip used to export 20 s)
 *   KI-02  the preview canvas backing store is no longer fixed at 1920x1080
 *   KI-03  the landscape preview canvas visible height (was 139 px / 107 px)
 *   KI-04  the focus trap of the Projects modal
 *   KI-05  undo after deleting a media item restores the media
 *   KI-06  the sample generation does not block for ~10-14 s any more
 *   KI-07  the captureStream() track is stopped when the recorder stops
 */

import {
  bootApp,
  bootAppKeepWelcome,
  generateSampleMedia,
  addFirstMediaToTimeline,
  setFirstClipDuration,
  openExportModal,
  closeExportModal,
  readExportSummary,
  readMediaPoolCount,
  readClipCount,
  waitForAppReady,
  dismissWelcome,
  safeEvaluate,
  evaluateWithRetry,
  navCount,
  delay,
} from './browser-harness.mjs';

export const name = 'known-issues';
export const title =
  'Línea base de los defectos ya resueltos (checks duros + deriva en modo estricto)';

/** Scenario used by KI-01: a single 5 s clip in the timeline. */
const CLIP_SECONDS = 5;

/* ------------------------------------------------------------------ */
/* KI-01 — the export duration floor (RESOLVED)                       */
/* ------------------------------------------------------------------ */
async function ki01DurationFloor({ browser, report, baseUrl }) {
  const { context, page } = await bootApp(browser, { width: 1440, height: 900, baseUrl });
  try {
    await generateSampleMedia(page);
    await addFirstMediaToTimeline(page);
    const clipDuration = await setFirstClipDuration(page, CLIP_SECONDS);

    await openExportModal(page);
    const summary = await readExportSummary(page);
    await closeExportModal(page);

    const observed = summary?.duration ?? null;

    report.check(
      'KI-01',
      'KI-01 RESUELTO: la duración de exportación sigue a la duración del clip (sin mínimo de 20 s)',
      observed === CLIP_SECONDS && clipDuration === CLIP_SECONDS,
      `duración de exportación=${observed} s (el clip dura ${clipDuration} s) | ` +
        `la línea base antigua exigía 20 s`,
      { details: { observed, clipDuration } }
    );

    report.known(
      'KI-01-BASELINE',
      'KI-01 Línea base: 1 clip de 5 s => 5 s de exportación',
      observed === CLIP_SECONDS,
      observed === CLIP_SECONDS
        ? `LÍNEA BASE OK: "Duración de exportación: ${summary?.durationText}" (5 s, sin el mínimo de 20 s).`
        : `LA LÍNEA BASE DERIVÓ: la duración observada es ${observed} s ("${summary?.durationText}") con un clip de ${clipDuration} s (la línea base documentada es 5 s). Actualiza la documentación.`,
      { details: { observed, durationText: summary?.durationText, clipDuration } }
    );
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* KI-02 — the backing store adapts to the display (RESOLVED)         */
/* ------------------------------------------------------------------ */
async function ki02BackingStore({ browser, report, baseUrl }) {
  const samples = [
    { width: 1440, height: 900, label: '1440x900', expected: '850x478' },
    { width: 320, height: 568, label: '320x568', expected: '206x116' },
  ];
  const rows = [];
  for (const vp of samples) {
    const { context, page } = await bootApp(browser, {
      width: vp.width,
      height: vp.height,
      baseUrl,
    });
    try {
      const m = await evaluateWithRetry(page, () => {
        const canvas =
          document.querySelector('div.shadow-2xl canvas') || document.querySelector('canvas');
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        return {
          cssWidth: rect.width,
          cssHeight: rect.height,
          backingWidth: canvas.width,
          backingHeight: canvas.height,
        };
      });
      if (!m) throw new Error('No se encontró el lienzo de vista previa');
      const cssPixels = m.cssWidth * m.cssHeight;
      const backingPixels = m.backingWidth * m.backingHeight;
      rows.push({
        viewport: vp.label,
        ...m,
        ratio: cssPixels > 0 ? backingPixels / cssPixels : null,
      });
    } finally {
      await context.close();
    }
  }

  const ratioText = rows
    .map(
      (r) =>
        `${r.viewport}: ${r.backingWidth}x${r.backingHeight} sobre ${r.cssWidth.toFixed(0)}x${r.cssHeight.toFixed(0)} CSS = ${r.ratio.toFixed(1)}x`
    )
    .join(' | ');

  // The backing store must NOT be the fixed 1920x1080 any more and it must
  // stay inside the pixel budget of the preview.
  const notFixed = rows.every((r) => !(r.backingWidth === 1920 && r.backingHeight === 1080));
  const withinBudget = rows.every((r) => r.backingWidth * r.backingHeight <= 1_300_000);
  const mobile = rows.find((r) => r.viewport === '320x568');

  report.check(
    'KI-02',
    'KI-02 RESUELTO: el backing store del lienzo se ajusta al display (ya no es 1920x1080 fijo)',
    notFixed && withinBudget,
    `backing store: ${ratioText} | ` +
      `fijo en 1920x1080=${!notFixed} | dentro del presupuesto de 1 300 000 px=${withinBudget} | ` +
      `en 320x568 se rasterizan ${mobile ? (mobile.backingWidth * mobile.backingHeight) : 'n/d'} px ` +
      `frente a los ${(1920 * 1080).toLocaleString('es-ES')} px del proyecto`,
    { details: rows }
  );

  // Documented values, ±2 px: the backing store derives from the measured
  // CSS box snapped UP to even H.264-friendly numbers that cover the painted
  // box (raw 204.8x115.2 -> 206x116 on 320x568), so a 1 px layout wobble must
  // not fail strict mode. A real regression (296x166, let alone 1920x1080)
  // is far outside this band — same tolerance pattern as KI-03.
  const baselineOk =
    Math.abs(rows[0].backingWidth - 850) <= 2 &&
    Math.abs(rows[0].backingHeight - 478) <= 2 &&
    Math.abs(rows[1].backingWidth - 206) <= 2 &&
    Math.abs(rows[1].backingHeight - 116) <= 2;

  report.known(
    'KI-02-BASELINE',
    'KI-02 Línea base: 1440x900 -> 850x478 y 320x568 -> 206x116',
    baselineOk,
    baselineOk
      ? `LÍNEA BASE OK: ${ratioText} (el backing cubre la caja pintada con números pares, ya no rasteriza el proyecto).`
      : `LA LÍNEA BASE DERIVÓ: ${ratioText} (la línea base documentada es 850x478 en 1440x900 y 206x116 en 320x568: el backing cubre la caja pintada con números pares). Actualiza la documentación.`,
    { details: rows }
  );
}

/* ------------------------------------------------------------------ */
/* KI-03 — the landscape preview height (RESOLVED)                     */
/* ------------------------------------------------------------------ */
async function ki03LandscapeHeight({ browser, report, baseUrl }) {
  const targets = [
    { width: 844, height: 390, expected: 228 },
    { width: 568, height: 320, expected: 158 },
  ];
  const rows = [];
  for (const vp of targets) {
    const { context, page } = await bootApp(browser, {
      width: vp.width,
      height: vp.height,
      baseUrl,
    });
    try {
      const m = await evaluateWithRetry(page, () => {
        const canvas =
          document.querySelector('div.shadow-2xl canvas') || document.querySelector('canvas');
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        return { cssWidth: rect.width, cssHeight: rect.height };
      });
      if (!m) throw new Error('No se encontró el lienzo de vista previa');
      rows.push({ viewport: `${vp.width}x${vp.height}`, ...m, expected: vp.expected });
    } finally {
      await context.close();
    }
  }

  const tallEnough = rows.every((r) => r.cssHeight >= 150);

  report.check(
    'KI-03',
    'KI-03 RESUELTO: el lienzo en horizontal conserva >= 150 px de alto visible',
    tallEnough,
    rows.map((r) => `${r.viewport} -> ${r.cssHeight.toFixed(0)} px`).join(', ') +
      ` (el requisito es >= 150 px; la línea base antigua era 139 px / 107 px)`,
    { details: rows }
  );

  const baselineOk = rows.every((r) => Math.abs(r.cssHeight - r.expected) <= 2);

  report.known(
    'KI-03-BASELINE',
    'KI-03 Línea base: 844x390 -> 228 px y 568x320 -> 158 px',
    baselineOk,
    baselineOk
      ? `LÍNEA BASE OK: ${rows.map((r) => `${r.viewport} -> ${r.cssHeight.toFixed(0)} px`).join(', ')}.`
      : `LA LÍNEA BASE DERIVÓ: ${rows
          .map((r) => `${r.viewport} -> ${r.cssHeight.toFixed(0)} px (documentado ${r.expected})`)
          .join(', ')}. Actualiza la documentación.`,
    { details: rows }
  );
}

/* ------------------------------------------------------------------ */
/* KI-04 — the focus trap of the Projects modal (RESOLVED)             */
/* ------------------------------------------------------------------ */
async function ki04FocusTrap({ browser, report, baseUrl }) {
  const { context, page } = await bootAppKeepWelcome(browser, {
    width: 1440,
    height: 900,
    baseUrl,
  });
  try {
    // "Abrir o importar…" closes the welcome screen and opens the Projects modal.
    const welcomeOpen = await evaluateWithRetry(page, () => {
      const btn = document.querySelector('[data-testid="welcome-open"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!welcomeOpen) throw new Error('No se encontró el botón "Abrir o importar…" del welcome');
    const deadline = Date.now() + 10_000;
    let modalReady = false;
    while (Date.now() < deadline) {
      modalReady = await safeEvaluate(
        page,
        () => Boolean(document.querySelector('#projects-modal-title'))
      );
      if (modalReady) break;
      await delay(150);
    }
    if (!modalReady) throw new Error('El modal de Proyectos no se abrió');
    // The modal moves the focus inside itself asynchronously: poll until the
    // focus lands instead of reading once after a fixed sleep (on a loaded
    // machine a single read can catch the focus mid-flight and report a
    // trap escape that never happened).
    {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const inside = await safeEvaluate(
          page,
          () => {
            const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
            return dialogs.some((d) => d.contains(document.activeElement));
          }
        );
        if (inside) break;
        await delay(100);
      }
    }

    const state = await evaluateWithRetry(page, () => {
      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
      const active = document.activeElement;
      return {
        activeTag: active ? active.tagName : null,
        activeIsBody: active === document.body,
        activeInsideDialog: dialogs.some((d) => d.contains(active)),
        inertElements: document.querySelectorAll('[inert]').length,
        ariaHiddenBackground: Array.from(document.querySelectorAll('[aria-hidden="true"]')).filter(
          (el) => !dialogs.some((d) => d.contains(el))
        ).length,
      };
    });

    // Does Tab escape the modal? (a real focus trap must keep focus inside)
    let escaped = false;
    let escapedTo = null;
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      const inside = await evaluateWithRetry(page, () => {
        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
        const active = document.activeElement;
        return {
          inside: dialogs.some((d) => d.contains(active)),
          tag: active ? active.tagName : null,
          label:
            active?.getAttribute?.('aria-label') ||
            active?.getAttribute?.('data-testid') ||
            (active?.textContent || '').trim().slice(0, 40),
        };
      });
      if (!inside.inside) {
        escaped = true;
        escapedTo = `${inside.tag} "${inside.label}"`;
        break;
      }
    }

    report.check(
      'KI-04',
      'KI-04 RESUELTO: el foco no escapa del modal de Proyectos y el fondo queda inerte',
      !escaped && state.activeInsideDialog && state.inertElements > 0,
      `activeElement=${state.activeTag} (body=${state.activeIsBody}), dentro del diálogo=${state.activeInsideDialog}, ` +
        `elementos [inert]=${state.inertElements}, fondo aria-hidden=${state.ariaHiddenBackground}, ` +
        `el foco escapa con Tab=${escaped}${escapedTo ? ` hacia ${escapedTo}` : ''}`,
      { details: { ...state, focusEscaped: escaped, escapedTo } }
    );

    const baselineOk =
      !escaped &&
      state.activeInsideDialog &&
      state.activeTag === 'BUTTON' &&
      state.inertElements > 0 &&
      state.ariaHiddenBackground > 0;

    report.known(
      'KI-04-BASELINE',
      'KI-04 Línea base: foco dentro del diálogo, [inert] > 0 y fondo con aria-hidden',
      baselineOk,
      baselineOk
        ? `LÍNEA BASE OK: activeElement=${state.activeTag} dentro del diálogo, [inert]=${state.inertElements}, fondo aria-hidden=${state.ariaHiddenBackground}, el foco nunca escapó.`
        : `LA LÍNEA BASE DERIVÓ: activeElement=${state.activeTag} (dentro=${state.activeInsideDialog}), [inert]=${state.inertElements}, fondo aria-hidden=${state.ariaHiddenBackground}, el foco escapó=${escaped}. Actualiza la documentación.`,
      { details: { ...state, focusEscaped: escaped, escapedTo } }
    );
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* KI-05 — undo restores the media (RESOLVED)                         */
/* ------------------------------------------------------------------ */
async function ki05UndoMedia({ browser, report, baseUrl }) {
  const { context, page } = await bootApp(browser, { width: 1440, height: 900, baseUrl });
  try {
    await generateSampleMedia(page);
    await addFirstMediaToTimeline(page);

    const mediaBefore = await readMediaPoolCount(page);
    const clipsBefore = await readClipCount(page);

    // Delete the media item that owns the clip.
    // The button moved to the trash (F2): the selector accepts both labels
    // ("Eliminar …" / "Mover … a la papelera") so the check does not depend
    // on the wording of the button.
    const deleted = await safeEvaluate(page, () => {
      const card = document.querySelector('[role="button"][aria-label*="añadir a la línea de tiempo"]');
      const del = card
        ? card.querySelector(
            'button[aria-label*="papelera"], button[aria-label^="Eliminar"], button[title*="papelera"], button[title^="Eliminar"]'
          )
        : null;
      if (!del) return false;
      del.click();
      return true;
    });
    if (!deleted) throw new Error('No se encontró el botón de papelera de la tarjeta de medios');
    // The deletion flows through React + the store: poll until the pool
    // really shrinks instead of reading once after a fixed sleep.
    let mediaAfterDelete = null;
    {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        mediaAfterDelete = await readMediaPoolCount(page);
        if (mediaAfterDelete !== null && mediaAfterDelete === mediaBefore - 1) break;
        await delay(150);
      }
      mediaAfterDelete = await readMediaPoolCount(page);
    }
    const clipsAfterDelete = await readClipCount(page);

    // Undo.
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyZ');
    await page.keyboard.up('Control');
    // Same race in the other direction: the undo commit may land after the
    // sleep on a loaded machine, so wait for the pool to grow back.
    let mediaAfterUndo = null;
    {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        mediaAfterUndo = await readMediaPoolCount(page);
        if (mediaAfterUndo !== null && mediaAfterUndo === mediaBefore) break;
        await delay(150);
      }
      mediaAfterUndo = await readMediaPoolCount(page);
    }
    const clipsAfterUndo = await readClipCount(page);

    report.check(
      'KI-05',
      'KI-05 RESUELTO: deshacer tras borrar un medio restaura el medio y el clip',
      Boolean(
        deleted &&
          mediaBefore > 0 &&
          mediaAfterDelete === mediaBefore - 1 &&
          mediaAfterUndo === mediaBefore &&
          clipsAfterUndo === clipsBefore
      ),
      `medios ${mediaBefore} -> ${mediaAfterDelete} -> (deshacer) ${mediaAfterUndo} | ` +
        `clips ${clipsBefore} -> ${clipsAfterDelete} -> (deshacer) ${clipsAfterUndo}`,
      {
        details: {
          mediaBefore,
          mediaAfterDelete,
          mediaAfterUndo,
          clipsBefore,
          clipsAfterDelete,
          clipsAfterUndo,
        },
      }
    );

    const baselineOk =
      mediaBefore === 3 && mediaAfterDelete === 2 && mediaAfterUndo === 3 && clipsAfterUndo === 1;

    report.known(
      'KI-05-BASELINE',
      'KI-05 Línea base: medios 3 -> 2 -> 3 y clips 1 -> 0 -> 1',
      baselineOk,
      baselineOk
        ? `LÍNEA BASE OK: medios ${mediaBefore} -> ${mediaAfterDelete} -> ${mediaAfterUndo}; clips ${clipsBefore} -> ${clipsAfterDelete} -> ${clipsAfterUndo}.`
        : `LA LÍNEA BASE DERIVÓ: medios ${mediaBefore} -> ${mediaAfterDelete} -> ${mediaAfterUndo}; clips ${clipsBefore} -> ${clipsAfterDelete} -> ${clipsAfterUndo} (la línea base documentada es 3 -> 2 -> 3 y 1 -> 0 -> 1). Actualiza la documentación.`,
      {
        details: {
          mediaBefore,
          mediaAfterDelete,
          mediaAfterUndo,
          clipsBefore,
          clipsAfterDelete,
          clipsAfterUndo,
        },
      }
    );
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* KI-06 — the sample generation does not block (RESOLVED)             */
/* ------------------------------------------------------------------ */
async function ki06SampleGeneration({ browser, report, baseUrl }) {
  const { context, page } = await bootApp(browser, { width: 1440, height: 900, baseUrl });
  try {
    const started = Date.now();
    await evaluateWithRetry(page, () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.textContent || '').includes('Generar clips de prueba')
      );
      if (btn) btn.click();
      return Boolean(btn);
    });

    let sawProgressbar = false;
    let sawCancelButton = false;
    let sawBusyLabel = false;
    const deadline = Date.now() + 120_000;

    while (Date.now() < deadline) {
      const snapshot = await evaluateWithRetry(page, () => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const cancel = buttons.find((b) => /cancelar|cancel/i.test(b.textContent || ''));
        return {
          progressbars: document.querySelectorAll('[role="progressbar"]').length,
          hasCancel: Boolean(cancel),
          busy: Array.from(buttons).some((b) =>
            /Generando clips/i.test(b.textContent || '')
          ),
        };
      });
      if (snapshot.progressbars > 0) sawProgressbar = true;
      if (snapshot.hasCancel) sawCancelButton = true;
      if (snapshot.busy) sawBusyLabel = true;

      const count = await readMediaPoolCount(page);
      if (count && count > 0) break;
      await delay(200);
    }

    const elapsedMs = Date.now() - started;

    report.check(
      'KI-06',
      'KI-06 RESUELTO: la generación de muestras no bloquea la interfaz',
      elapsedMs < 5000,
      `${(elapsedMs / 1000).toFixed(1)} s de espera (el requisito es < 5 s; la línea base antigua era de 10-14 s) | ` +
        `barra de progreso=${sawProgressbar}, botón de cancelar=${sawCancelButton}, etiqueta de generación=${sawBusyLabel}`,
      { details: { elapsedMs, sawProgressbar, sawCancelButton, sawBusyLabel } }
    );

    const baselineOk = elapsedMs >= 1000 && elapsedMs <= 5000;

    report.known(
      'KI-06-BASELINE',
      'KI-06 Línea base: la generación tarda entre 1 s y 5 s (≈ 2,2 s)',
      baselineOk,
      baselineOk
        ? `LÍNEA BASE OK: ${(elapsedMs / 1000).toFixed(1)} s (la línea base documentada es ≈ 2,2 s, tolerada 1-5 s).`
        : `LA LÍNEA BASE DERIVÓ: ${(elapsedMs / 1000).toFixed(1)} s (la línea base documentada es ≈ 2,2 s, tolerada 1-5 s). Actualiza la documentación.`,
      { details: { elapsedMs, sawProgressbar, sawCancelButton, sawBusyLabel } }
    );
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* KI-07 — the captureStream() track is stopped (RESOLVED)            */
/* ------------------------------------------------------------------ */
async function ki07StreamTrack({ browser, report, baseUrl }) {
  const { context, page } = await bootApp(browser, { width: 1440, height: 900, baseUrl });
  try {
    // The check has to exercise the APP, not a replica of the old recipe:
    // `HTMLCanvasElement.prototype.captureStream` is intercepted and the
    // state of the tracks is read AFTER the app generated the samples.
    //
    // The Vite dev server reloads the page whenever a source file changes
    // (or when it re-optimises its dependencies): the reload wipes the patch
    // (and the in-memory state of the app). The scenario is therefore
    // repeated when a navigation is detected in the middle of it.
    const installPatch = () =>
      evaluateWithRetry(page, () => {
        window.__capturedStreams = [];
        const original = HTMLCanvasElement.prototype.captureStream;
        HTMLCanvasElement.prototype.captureStream = function (...args) {
          const stream = original.apply(this, args);
          try {
            window.__capturedStreams.push(stream);
          } catch {
            /* ignore */
          }
          return stream;
        };
        return true;
      });

    let result = null;
    let navs = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const navBefore = navCount(page);
      await installPatch();

      const poolBefore = (await readMediaPoolCount(page)) ?? 0;
      await evaluateWithRetry(page, () => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) =>
          (b.textContent || '').includes('Generar clips de prueba')
        );
        if (btn) btn.click();
        return Boolean(btn);
      });

      // The samples are really generated when the pool GROWS (after a reload
      // the pool is restored from the autosave, so "> 0" is not enough).
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const count = await readMediaPoolCount(page);
        if (count !== null && count > poolBefore) break;
        await delay(200);
      }

      result = await evaluateWithRetry(page, () => {
        const streams = window.__capturedStreams || [];
        return {
          count: streams.length,
          states: streams.map((s) => s.getTracks().map((t) => t.readyState)),
        };
      });
      navs = navCount(page) - navBefore;
      if (result && result.count > 0) break;
      if (navs === 0) break; // a real failure, not a reload
      // The page was reloaded in the middle of the scenario: patch again and
      // generate the samples once more.
      await waitForAppReady(page).catch(() => {});
      await dismissWelcome(page).catch(() => {});
    }

    const allTracks = (result?.states || []).flat();
    const stillLive = allTracks.filter((s) => s === 'live');
    const stopped = allTracks.length > 0 && stillLive.length === 0;

    report.check(
      'KI-07',
      'KI-07 RESUELTO: la pista de captureStream() se detiene al terminar la grabación',
      Boolean(stopped),
      result && result.count > 0
        ? `${result.count} flujo(s) capturado(s) por la app, readyState de las pistas: ${JSON.stringify(
            result.states
          )} | ${stillLive.length === 0 ? 'ninguna sigue "live"' : `${stillLive.length} siguen "live"`}` +
          (navs ? ` | recargas HMR durante el escenario: ${navs}` : '')
        : `la app no usó captureStream() en absoluto (el generador cayó en las tarjetas de color): no hay nada que comprobar` +
          (navs ? ` | recargas HMR durante el escenario: ${navs}` : ''),
      { details: result }
    );

    const baselineOk =
      result && result.count > 0 && allTracks.length > 0 && allTracks.every((s) => s === 'ended');

    report.known(
      'KI-07-BASELINE',
      'KI-07 Línea base: todas las pistas de captureStream() quedan en "ended"',
      baselineOk,
      baselineOk
        ? `LÍNEA BASE OK: readyState ${JSON.stringify(result.states)} (todas "ended" tras recorder.stop()).`
        : `LA LÍNEA BASE DERIVÓ: readyState ${JSON.stringify(result?.states)} (la línea base documentada es "ended" para todas las pistas). Actualiza la documentación.`,
      { details: result }
    );
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */

export async function run(ctx) {
  await ki01DurationFloor(ctx);
  await ki02BackingStore(ctx);
  await ki03LandscapeHeight(ctx);
  await ki04FocusTrap(ctx);
  await ki05UndoMedia(ctx);
  await ki06SampleGeneration(ctx);
  await ki07StreamTrack(ctx);
}
