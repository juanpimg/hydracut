/**
 * suite-playback.mjs — playback, undo/redo and persistence.
 *
 *   PLAYBACK-UNDO-REDO    Ctrl+Z removes the clip, Ctrl+Y restores it
 *                         (measured through the Export modal's
 *                          "Clips en el timeline: N" counter)
 *   PLAYBACK-SPACE        Space starts playback (timecode advances) and a
 *                         second Space stops it (timecode freezes)
 *   PLAYBACK-PERSISTENCE  a page reload restores the media pool and the timeline
 *
 * Each case runs in its own incognito browser context.
 */

import {
  bootApp,
  waitForAppReady,
  dismissWelcome,
  generateSampleMedia,
  addFirstMediaToTimeline,
  readClipCountViaExportModal,
  readMediaPoolCount,
  readTimecode,
  safeEvaluate,
  blurActiveElement,
  navCount,
  waitForPersistedProject,
  delay,
} from './browser-harness.mjs';

export const name = 'playback';
export const title = 'Reproducción, deshacer/rehacer y persistencia';

/** Reads the playback state from the MasterClock singleton exposed on window. */
async function readIsPlaying(page) {
  const value = await safeEvaluate(page, () => {
    const clock = window.__masterClock;
    if (!clock || typeof clock.getIsPlaying !== 'function') return null;
    return clock.getIsPlaying();
  });
  return typeof value === 'boolean' ? value : null;
}

async function pressCtrl(page, key) {
  // The app ignores the global shortcuts while an input has the focus.
  await blurActiveElement(page);
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
  await delay(250);
}

/* ------------------------------------------------------------------ */
/* 1. Undo / Redo                                                      */
/* ------------------------------------------------------------------ */
async function caseUndoRedo({ browser, report, baseUrl }) {
  const { context, page } = await bootApp(browser, {
    width: 1440,
    height: 900,
    baseUrl,
  });
  try {
    let before = null;
    let afterUndo = null;
    let afterRedo = null;
    let navs = 0;

    // The Vite dev server can hot-reload the page while the scenario runs
    // (which restores the clip from the autosave and would mask the undo).
    for (let attempt = 0; attempt < 3; attempt++) {
      const navBefore = navCount(page);
      await generateSampleMedia(page);
      await addFirstMediaToTimeline(page);

      before = await readClipCountViaExportModal(page);
      await pressCtrl(page, 'KeyZ');
      afterUndo = await readClipCountViaExportModal(page);
      await pressCtrl(page, 'KeyY');
      afterRedo = await readClipCountViaExportModal(page);
      navs = navCount(page) - navBefore;

      if (before === 1 && afterUndo === 0 && afterRedo === 1) break;
      if (navs === 0) break; // a real failure, not a reload
    }

    const ok = before === 1 && afterUndo === 0 && afterRedo === 1;

    report.check(
      'PLAYBACK-UNDO-REDO',
      'Ctrl+Z elimina el clip y Ctrl+Y lo restaura',
      ok,
      `Clips en el timeline: ${before} -> Ctrl+Z -> ${afterUndo} -> Ctrl+Y -> ${afterRedo}` +
        (ok ? '' : ` | esperado 1 -> 0 -> 1 | recargas HMR durante el escenario: ${navs}`),
      { details: { before, afterUndo, afterRedo, navs } }
    );
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* 2. Space starts / stops playback                                    */
/* ------------------------------------------------------------------ */
async function caseSpacePlayback({ browser, report, baseUrl }) {
  const { context, page } = await bootApp(browser, {
    width: 1440,
    height: 900,
    baseUrl,
  });
  try {
    const t0 = await readTimecode(page);
    await blurActiveElement(page);
    await page.keyboard.press('Space');

    // The timecode must advance within ~2 s.
    let t1 = t0;
    let playing = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      await delay(80);
      t1 = await readTimecode(page);
      playing = await readIsPlaying(page);
      if (t1 && t0 && t1 !== t0) break;
    }
    const advanced = Boolean(t0 && t1 && t1 !== t0);

    report.check(
      'PLAYBACK-SPACE-START',
      'La barra espaciadora inicia la reproducción (el timecode avanza)',
      advanced,
      `timecode ${t0} -> ${t1} tras pulsar Espacio (masterClock.isPlaying=${playing})`,
      { details: { t0, t1, playing } }
    );

    // Second Space must stop it: the timecode stays stable.
    await page.keyboard.press('Space');
    await delay(500);
    const t2 = await readTimecode(page);
    const playingAfter = await readIsPlaying(page);
    await delay(800);
    const t3 = await readTimecode(page);
    const stable = Boolean(t2 && t3 && t2 === t3);

    report.check(
      'PLAYBACK-SPACE-STOP',
      'La segunda barra espaciadora detiene la reproducción (timecode estable)',
      stable,
      `timecode tras parar: ${t2} -> ${t3} (debe ser idéntico) | masterClock.isPlaying=${playingAfter}`,
      { details: { t2, t3, playingAfter } }
    );
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* 3. Persistence across a reload                                      */
/* ------------------------------------------------------------------ */
async function casePersistence({ browser, report, baseUrl }) {
  const { context, page } = await bootApp(browser, {
    width: 1440,
    height: 900,
    baseUrl,
  });
  try {
    await generateSampleMedia(page);
    await addFirstMediaToTimeline(page);
    const mediaBefore = await readMediaPoolCount(page);
    const clipsBefore = await readClipCountViaExportModal(page);

    // Only reload once the autosave has really been written to IndexedDB,
    // otherwise the test would measure a race instead of the persistence.
    const persisted = await waitForPersistedProject(page, {
      minClips: 1,
      minMedia: mediaBefore || 1,
      timeoutMs: 20_000,
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    // The welcome screen comes back on every load -> dismiss it again.
    await dismissWelcome(page);
    await delay(1000);

    const mediaAfter = await readMediaPoolCount(page);
    const clipsAfter = await readClipCountViaExportModal(page);

    const ok = mediaBefore > 0 && mediaAfter === mediaBefore && clipsAfter > 0;

    report.check(
      'PLAYBACK-PERSISTENCE',
      'Tras recargar se restauran el panel de medios y el timeline',
      ok,
      `Medios: ${mediaBefore} -> ${mediaAfter} | Clips: ${clipsBefore} -> ${clipsAfter} | persistido en IndexedDB: medios=${persisted.media}, clips=${persisted.clips}`,
      { details: { mediaBefore, mediaAfter, clipsBefore, clipsAfter, persisted } }
    );
  } finally {
    await context.close();
  }
}

export async function run(ctx) {
  await caseUndoRedo(ctx);
  await caseSpacePlayback(ctx);
  await casePersistence(ctx);
}
