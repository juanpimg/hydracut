/**
 * suite-export.mjs — export pipeline.
 *
 *   EXPORT-SCENARIO          with a single 5 s clip in the timeline, starting the
 *                            export downloads a real .mp4 file
 *   EXPORT-MP4-SIZE          the downloaded file is bigger than 10 KB
 *   EXPORT-MP4-CONTAINER     the file starts with a valid MP4 `ftyp` box and
 *                            contains a `moov` box
 *   EXPORT-BUNDLE-ORIGINS    neither the boot nor the export request anything
 *                            outside the origin of the app
 *   EXPORT-BUNDLE-EXPORTER   the exporter chunk is NOT requested before the
 *                            export and IS requested when it starts
 *
 * The export uses the cheapest preset available (720p + 30 FPS) and the wait
 * is capped so the suite can never hang.
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
  readExportSummary,
  setupDownloadCapture,
  clickButtonByText,
  readFileHead,
  evaluateWithRetry,
  safeEvaluate,
  waitForNetworkQuiescence,
  navCount,
  delay,
} from './browser-harness.mjs';

export const name = 'export';
export const title = 'Pipeline de exportación MP4';

const MIN_FILE_BYTES = 10 * 1024; // 10 KB
const EXPORT_TIMEOUT_MS = 60_000;
/** The scenario the suite pins down: a single 5 second clip in the timeline. */
const CLIP_SECONDS = 5;

/** The chunk of the exporter (it is loaded on demand, never with the app). */
const EXPORTER_CHUNK = /webcodecsExporter/i;

export async function run({ browser, report, baseUrl }) {
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cut-download-'));
  const { context, page } = await bootApp(browser, {
    width: 1440,
    height: 900,
    baseUrl,
  });

  try {
    /* ---------------------------------------------------------------- *
     * The request log of the WHOLE session (boot + export).
     * The page is reloaded with the cache disabled so the log covers a
     * complete boot of the app and not only the requests of the session.
     * ---------------------------------------------------------------- */
    const requested = [];
    page.on('request', (req) => {
      try {
        requested.push(req.url());
      } catch {
        /* the page may be closing */
      }
    });
    await page.setCacheEnabled(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await dismissWelcome(page);
    // The "lazy exporter chunk" check reads the request log of the whole
    // session: evaluate it at network quiescence, not after a fixed sleep
    // (a sleep can fire before the boot has finished and miss the very
    // request the check is looking for).
    await waitForNetworkQuiescence(() => requested.length, { quietMs: 1000, timeoutMs: 15_000 });

    const appOrigin = new URL(baseUrl).origin;
    const isForeign = (url) => {
      if (url.startsWith('data:') || url.startsWith('blob:')) return false;
      try {
        return new URL(url).origin !== appOrigin;
      } catch {
        return false;
      }
    };
    const foreignRequests = () => requested.filter(isForeign);
    const exporterRequests = () => requested.filter((url) => EXPORTER_CHUNK.test(url));

    /* ---------------------------------------------------------------- *
     * The exporter chunk must NOT be part of the initial bundle: it may
     * only be fetched when the user asks for an export.
     * ---------------------------------------------------------------- */
    const exporterBefore = exporterRequests();
    report.check(
      'EXPORT-BUNDLE-EXPORTER-LAZY',
      'El chunk del exportador no se pide durante el arranque',
      exporterBefore.length === 0,
      exporterBefore.length === 0
        ? `Ninguna petición coincide con el chunk del exportador durante el arranque (${requested.length} peticiones revisadas)`
        : `El chunk del exportador se pidió durante el arranque: ${JSON.stringify(exporterBefore)}`,
      { details: { exporterBefore, total: requested.length } }
    );

    const foreignBefore = foreignRequests();
    report.check(
      'EXPORT-BUNDLE-ORIGINS',
      'El arranque de la app no pide nada fuera de su propio origen',
      foreignBefore.length === 0,
      foreignBefore.length === 0
        ? `${requested.length} peticiones, todas de ${appOrigin} (sin Google Fonts ni ningún otro origen externo)`
        : `${foreignBefore.length} peticiones externas: ${JSON.stringify(foreignBefore.slice(0, 10))}`,
      { details: { total: requested.length, foreign: foreignBefore } }
    );

    const capture = await setupDownloadCapture(browser, context, downloadDir);

    await generateSampleMedia(page);
    await addFirstMediaToTimeline(page);
    // Pin the scenario to a single 5 s clip (the sample generator may produce
    // shorter clips, the export scenario is defined by the clip length).
    const clipDuration = await setFirstClipDuration(page, CLIP_SECONDS);

    // Exactly one clip must be in the timeline.
    await openExportModal(page);
    const summary = await readExportSummary(page);
    await closeExportModal(page);

    report.check(
      'EXPORT-SCENARIO',
      'El escenario es un único clip de 5 s en el timeline',
      summary?.clips === 1 && clipDuration === CLIP_SECONDS,
      `clips=${summary?.clips} | duración del clip=${clipDuration}s (esperado ${CLIP_SECONDS}s) | duración del proyecto=${summary?.duration}s | fotogramas=${summary?.totalFrames}`,
      { details: { summary, clipDuration } }
    );

    // Cheapest preset: 720p + 30 FPS.
    await openExportModal(page);
    await clickButtonByText(page, '720p HD', { exact: true });
    await clickButtonByText(page, '30 FPS', { exact: true });
    const dims = await evaluateWithRetry(page, () => {
      const modal = document.querySelector('div[role="dialog"][aria-label="Exportar video"]');
      if (!modal) return null;
      const walker = document.createTreeWalker(modal, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if ((node.nodeValue || '').includes('Dimensiones finales:')) {
          return node.parentElement ? node.parentElement.textContent.trim() : null;
        }
      }
      return null;
    });

    const started = Date.now();
    let file = null;
    let navs = 0;
    let modalState = null;

    // The export runs inside the page, so a Vite hot-reload aborts it. When
    // that happens the whole export is retried once.
    for (let attempt = 0; attempt < 2; attempt++) {
      const navBefore = navCount(page);
      await clickButtonByText(page, 'Comenzar Exportación');

      // Poll the download folder AND the modal state, so a failure reports
      // what the export was doing instead of just "nothing arrived".
      const deadline = Date.now() + EXPORT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        file = await capture.waitForFile({
          timeoutMs: 1500,
          match: (name) => name.toLowerCase().endsWith('.mp4'),
          minBytes: 1,
        });
        if (file) break;
        modalState = await safeEvaluate(page, () => {
          const modal = document.querySelector('div[role="dialog"][aria-label="Exportar video"]');
          if (!modal) return 'el modal se cerró';
          return modal.innerText.replace(/\s+/g, ' ').slice(0, 220);
        });
        await delay(400);
      }
      navs = navCount(page) - navBefore;
      if (file) break;
      if (navs === 0) break; // a real failure, not a reload
      // The page was reloaded mid-export: restore the scenario and retry.
      await generateSampleMedia(page);
      await addFirstMediaToTimeline(page);
      await setFirstClipDuration(page, CLIP_SECONDS);
      await openExportModal(page);
      await clickButtonByText(page, '720p HD', { exact: true });
      await clickButtonByText(page, '30 FPS', { exact: true });
    }
    const elapsedMs = Date.now() - started;

    if (!file) {
      report.check(
        'EXPORT-MP4-DOWNLOAD',
        'La exportación descarga un archivo .mp4',
        false,
        `No se descargó ningún .mp4 en ${EXPORT_TIMEOUT_MS} ms por intento (directorio: ${downloadDir})` +
          ` | recargas HMR durante la exportación: ${navs}` +
          ` | último estado del modal: ${modalState || 'n/d'}`
      );
      report.check('EXPORT-MP4-SIZE', 'El .mp4 descargado supera los 10 KB', false, 'Sin archivo descargado');
      report.check(
        'EXPORT-MP4-CONTAINER',
        'El .mp4 contiene las cajas ftyp/moov',
        false,
        'Sin archivo descargado'
      );
      return;
    }

    report.check(
      'EXPORT-MP4-DOWNLOAD',
      'La exportación descarga un archivo .mp4',
      true,
      `${file.name} (${file.size} bytes) descargado en ${(elapsedMs / 1000).toFixed(1)} s | ${dims || 'dimensiones desconocidas'} | clips=${summary?.clips} | duración del clip=${clipDuration}s | duración del proyecto=${summary?.duration}s`
    );

    report.check(
      'EXPORT-MP4-SIZE',
      'El .mp4 descargado supera los 10 KB',
      file.size > MIN_FILE_BYTES,
      `${file.size} bytes (mínimo exigido: ${MIN_FILE_BYTES})`
    );

    const head = readFileHead(file.filePath, 64);
    const hasFtyp = head.includes('ftyp');
    const full = fs.readFileSync(file.filePath);
    const hasMoov = full.includes(Buffer.from('moov'));
    const brand = (head.match(/ftyp([a-z0-9 ]{4})/i) || [])[1] || 'desconocida';

    report.check(
      'EXPORT-MP4-CONTAINER',
      'El .mp4 contiene las cajas ftyp/moov',
      hasFtyp && hasMoov,
      `ftyp=${hasFtyp} (marca "${brand.trim()}"), moov=${hasMoov}, cabecera="${head
        .replace(/[^\x20-\x7e]/g, '.')
        .slice(0, 32)}"`
    );

    /* ---------------------------------------------------------------- *
     * The exporter chunk: loaded ON DEMAND, and nothing outside the
     * origin of the app was requested during the export.
     * ---------------------------------------------------------------- */
    const exporterAfter = exporterRequests();
    report.check(
      'EXPORT-BUNDLE-EXPORTER-ONDEMAND',
      'El chunk del exportador se carga al exportar (no antes)',
      exporterAfter.length > 0,
      exporterAfter.length > 0
        ? `${exporterAfter.length} petición(es) del chunk del exportador: ${JSON.stringify(
            exporterAfter.slice(0, 4)
          )} (se cargó al abrir el modal / al exportar, nunca con el bundle inicial)`
        : `El chunk del exportador NO se pidió en ningún momento: el exportador no está en el bundle inicial`,
      { details: { exporterAfter, total: requested.length } }
    );

    const foreignAfter = foreignRequests();
    report.check(
      'EXPORT-BUNDLE-ORIGINS-EXPORT',
      'La exportación no pide nada fuera del origen de la app',
      foreignAfter.length === 0,
      foreignAfter.length === 0
        ? `${requested.length} peticiones (arranque + exportación), todas de ${appOrigin}`
        : `${foreignAfter.length} peticiones externas: ${JSON.stringify(foreignAfter.slice(0, 10))}`,
      { details: { total: requested.length, foreign: foreignAfter } }
    );

    // Give React a moment to render the "export finished" state, then close.
    await delay(500);
    try {
      await closeExportModal(page);
    } catch {
      /* the modal may already be in the "completed" state */
    }
  } finally {
    await context.close();
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}
