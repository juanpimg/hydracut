/**
 * suite-firefox.mjs — export with AUDIO in the timeline, in real Firefox.
 *
 *   FIREFOX-EXPORT-AUDIO-SETUP   the timeline holds video AND audio clips
 *                                (the bug only reproduces with audio) and the
 *                                project is short (the fallback records in
 *                                real time)
 *   FIREFOX-EXPORT-NO-ERROR      the export succeeds: no "No se pudo…" error
 *   FIREFOX-EXPORT-FILE-SIZE     a real file was produced (size > 0)
 *   FIREFOX-EXPORT-REAL-FORMAT   the file is WebM (what Firefox can record)
 *                                and, as requested MP4 differs, the modal says
 *                                so with the exact `buildExportResultMessage`
 *                                text (ExportModal.tsx)
 *   FIREFOX-EXPORT-STREAMS       the file carries a VIDEO and an AUDIO stream
 *                                (ffprobe)
 *
 * WHY FIREFOX (and why Chrome can never cover this):
 * A user reported that exporting a project WITH audio clips failed in
 * Firefox at 0 % with "MediaRecorder.start: An audio track cannot be
 * recorded: video/webm;codecs=vp8 indicates an unsupported codec". Root
 * cause: the fallback recorder picked its MIME with
 * `MediaRecorder.isTypeSupported()`, which in Firefox only validates the
 * VIDEO codec; with an audio track attached `start()` rejects it. Fixed by
 * probing the candidates for real (calling `start()`). In Chrome
 * `video/webm;codecs=vp8` starts fine even with audio, so a Chrome-only
 * suite can never catch a regression here.
 *
 * HOW IT READS THE FILE: downloads go through the browser download manager
 * (CDP in Chrome). Firefox under puppeteer speaks WebDriver BiDi, so instead
 * the suite intercepts the page's own `URL.createObjectURL` (installed with
 * `evaluateOnNewDocument` BEFORE the navigation) and keeps every Blob the
 * app creates. The blobs made before the export starts are the sample media;
 * the one created after is the exported file. Its bytes are transferred to
 * Node (base64) and inspected with ffprobe.
 *
 * Runs in its own Firefox (`requiresOwnBrowser`): `run-all.mjs` does not
 * launch Chrome for it, and when no Firefox binary is found the suite is
 * SKIPPED with a clear message (zero checks, never a FAIL).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  BASE_URL,
  DEFAULT_TIMEOUT,
  isFirefoxAvailable,
  isFfprobeAvailable,
  resolveFfprobePath,
  launchFirefox,
  resolveFirefoxPath,
  waitForAppReady,
  dismissWelcome,
  generateSampleMedia,
  openExportModal,
  clickButtonByText,
  safeEvaluate,
  navigateWithRetry,
  delay,
} from './browser-harness.mjs';

export const name = 'firefox';
export const title = 'Exportación con audio en Firefox (respaldo MediaRecorder)';

/** This suite brings its own browser: the runner must not launch Chrome for it. */
export const requiresOwnBrowser = true;

/** The fallback recorder captures in REAL time: keep the project this short. */
const MAX_PROJECT_SECONDS = 3;
/** Cap for the whole export (a 2 s project records ~2 s + mux overhead). */
const EXPORT_TIMEOUT_MS = 60_000;

/**
 * Installed with `evaluateOnNewDocument` before the navigation: records every
 * Blob the app turns into an object URL (sample media AND the export file).
 */
function installBlobCapture() {
  window.__firefoxExportBlobs = [];
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    try {
      if (obj instanceof Blob) window.__firefoxExportBlobs.push(obj);
    } catch {
      /* never break the app */
    }
    return orig(obj);
  };
}

/**
 * Mirror of `buildExportResultMessage` (src/components/export/ExportModal.tsx):
 * the REAL format derives from the produced blob MIME (mp4 wins over webm,
 * unknown falls back to what was requested) and a mismatch is spelled out.
 * If the production text ever drifts, this check fails on purpose: the modal
 * must never announce a format the file does not have.
 */
function expectedResultMessage(requestedFormat, actualMime) {
  const mime = actualMime ?? '';
  const actualFormat = mime.includes('mp4')
    ? 'mp4'
    : mime.includes('webm')
      ? 'webm'
      : requestedFormat;
  const isFormatMismatch = actualFormat !== requestedFormat;
  let message;
  if (!isFormatMismatch) {
    message =
      actualFormat === 'webm'
        ? 'Tu video WebM ha sido descargado automáticamente.'
        : 'Tu video MP4 ha sido descargado automáticamente.';
  } else if (requestedFormat === 'mp4') {
    message =
      'Has pedido MP4, pero este navegador no puede grabar MP4: ' +
      'se ha descargado un archivo WebM.';
  } else {
    message = 'Has pedido WebM, pero se ha descargado un archivo MP4.';
  }
  return { actualFormat, isFormatMismatch, message };
}

function ffprobeStreams(filePath) {
  const out = execFileSync(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,channels',
      '-of', 'json',
      filePath,
    ],
    { encoding: 'utf8', timeout: 30_000 }
  );
  return JSON.parse(out).streams || [];
}

export async function run({ report, baseUrl = BASE_URL }) {
  if (!isFirefoxAvailable()) {
    console.log(
      `  ⊘ Suite "firefox" omitida: no se encontró Firefox en "${resolveFirefoxPath()}". ` +
        `Instala Firefox o define HYDRA_FIREFOX_PATH (no es un fallo).`
    );
    return;
  }

  let browser = null;
  let context = null;
  const tmpFiles = [];
  try {
    browser = await launchFirefox({ headless: true });
    console.log(`  ${'Firefox lanzado para la suite de exportación con audio.'}`);

    context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.evaluateOnNewDocument(installBlobCapture);
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    page.setDefaultTimeout(DEFAULT_TIMEOUT);
    page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT);
    await navigateWithRetry(page, baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    await dismissWelcome(page);

    /* ---- 1. sample media (must include the AUDIO sample) ---- */
    const gen = await generateSampleMedia(page);
    const pool = await safeEvaluate(page, () => {
      const store = window.__projectStore;
      if (!store) return null;
      return store.getState().project.mediaPool.map((m) => ({ type: m.type, duration: m.duration }));
    });
    const hasAudioSample = Boolean(pool && pool.some((m) => m.type === 'audio'));

    /* ---- 2. video AND audio onto the timeline (the bug needs audio) ---- */
    const cards = await safeEvaluate(page, () =>
      Array.from(
        document.querySelectorAll('[role="button"][aria-label*="añadir a la línea de tiempo"]')
      ).map((c) => c.getAttribute('aria-label') || '')
    );
    const audioCardIndex = cards ? cards.findIndex((label) => /audio/i.test(label)) : -1;
    let timeline = null;
    if (cards && cards.length > 0 && audioCardIndex >= 0) {
      for (const index of [0, audioCardIndex]) {
        await safeEvaluate(page, (i) => {
          const list = Array.from(
            document.querySelectorAll('[role="button"][aria-label*="añadir a la línea de tiempo"]')
          );
          if (list[i]) list[i].click();
        }, index);
        await delay(400);
      }
      // The fallback records in real time: trim every clip so the project
      // stays short no matter how long the samples are.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        timeline = await safeEvaluate(page, () => {
          const store = window.__projectStore;
          if (!store) return null;
          for (const c of store.getState().project.clips) {
            if (c.duration > 2) store.getState().updateClip(c.id, { duration: 2 });
          }
          const clips = store.getState().project.clips;
          return {
            video: clips.filter((c) => c.type === 'video' || c.type === 'image').length,
            audio: clips.filter((c) => c.type === 'audio').length,
            duration: store.getState().project.duration,
          };
        });
        if (timeline && timeline.video >= 1 && timeline.audio >= 1) break;
        await delay(300);
      }
    }

    const setupOk = Boolean(
      hasAudioSample && timeline && timeline.video >= 1 && timeline.audio >= 1 &&
      typeof timeline.duration === 'number' && timeline.duration <= MAX_PROJECT_SECONDS
    );
    report.check(
      'FIREFOX-EXPORT-AUDIO-SETUP',
      'El timeline lleva vídeo Y audio (precondición del bug) y el proyecto es corto',
      setupOk,
      `muestras generadas en ${gen ? `${(gen.elapsedMs / 1000).toFixed(1)} s` : 'n/d'} ` +
        `(tipos: ${pool ? pool.map((m) => m.type).join(',') : 'n/d'}) | ` +
        `tarjetas de medios: ${cards ? cards.length : 'n/d'} (audio en índice ${audioCardIndex}) | ` +
        `timeline: vídeo=${timeline ? timeline.video : 'n/d'}, audio=${timeline ? timeline.audio : 'n/d'}, ` +
        `duración=${timeline ? timeline.duration : 'n/d'} s (máximo ${MAX_PROJECT_SECONDS} s, el respaldo graba en tiempo real)`,
      { details: { pool, cards, timeline } }
    );
    if (!setupOk) return;

    /* ---- 3. export (keep the requested MP4: the mismatch is the point) ---- */
    const blobsBefore = await safeEvaluate(page, () =>
      Array.isArray(window.__firefoxExportBlobs) ? window.__firefoxExportBlobs.length : 0
    );
    await openExportModal(page);
    const requestedFormat = await safeEvaluate(page, () => {
      const mp4 = document.querySelector('[data-testid="export-format-mp4"]');
      const webm = document.querySelector('[data-testid="export-format-webm"]');
      if (webm && webm.getAttribute('aria-pressed') === 'true') return 'webm';
      if (mp4 && mp4.getAttribute('aria-pressed') === 'true') return 'mp4';
      return 'mp4';
    });

    const started = Date.now();
    await clickButtonByText(page, 'Comenzar Exportación');
    let modalText = '';
    const deadline = Date.now() + EXPORT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      modalText = await safeEvaluate(page, () => {
        const modal = document.querySelector('div[role="dialog"][aria-label="Exportar video"]');
        if (!modal) return 'el modal se cerró';
        return modal.innerText.replace(/\s+/g, ' ').slice(0, 900);
      });
      if (/descargado/i.test(modalText || '') || /no se pudo/i.test(modalText || '')) break;
      await delay(500);
    }
    const elapsedMs = Date.now() - started;

    const succeeded = Boolean(
      modalText && /exportación exitosa/i.test(modalText) && !/no se pudo/i.test(modalText)
    );
    report.check(
      'FIREFOX-EXPORT-NO-ERROR',
      'La exportación con audio termina en éxito (sin "No se pudo…") en Firefox',
      succeeded,
      succeeded
        ? `¡Exportación exitosa! en ${(elapsedMs / 1000).toFixed(1)} s (proyecto de ${timeline.duration} s) | ` +
          `modal: "${(modalText || '').slice(0, 220)}…"`
        : `SIN ÉXITO tras ${(elapsedMs / 1000).toFixed(1)} s | modal: "${(modalText || 'n/d').slice(0, 300)}" ` +
          `(con el bug original aquí aparecía "No se pudo iniciar la grabación de respaldo: ` +
          `MediaRecorder.start: An audio track cannot be recorded: video/webm;codecs=vp8…")`,
      { details: { modalText, elapsedMs } }
    );
    if (!succeeded) return;

    /* ---- 4. the produced file ---- */
    const payload = await safeEvaluate(page, async (from) => {
      try {
        const list = window.__firefoxExportBlobs || [];
        const blob = list.slice(from).pop() || null;
        if (!blob) return null;
        const ab = await blob.arrayBuffer();
        const u8 = new Uint8Array(ab);
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < u8.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
        }
        return { type: blob.type, size: blob.size, base64: btoa(bin) };
      } catch {
        return null;
      }
    }, blobsBefore);

    let filePath = null;
    if (payload && payload.base64) {
      filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cut-firefox-')), 'export.bin');
      tmpFiles.push(path.dirname(filePath));
      fs.writeFileSync(filePath, Buffer.from(payload.base64, 'base64'));
    }

    report.check(
      'FIREFOX-EXPORT-FILE-SIZE',
      'La exportación produce un archivo real (tamaño > 0)',
      Boolean(payload && payload.size > 0 && /tamaño del archivo:/i.test(modalText || '')),
      payload
        ? `blob ${payload.type || '(sin MIME)'} de ${payload.size} bytes ` +
          `(${(payload.size / 1024).toFixed(0)} KB) | el modal informa "${(modalText.match(/Tamaño del archivo:[^."]*/) || ['n/d'])[0]}"`
        : `No se capturó ningún blob de exportación (blobs desde el índice ${blobsBefore}: ninguno)`,
      { details: { type: payload && payload.type, size: payload && payload.size } }
    );
    if (!payload || !filePath) return;

    /* ---- 5. the REAL format (Firefox cannot record MP4) ---- */
    const expected = expectedResultMessage(requestedFormat, payload.type || '');
    const formatOk = Boolean(
      expected.actualFormat === 'webm' &&
      (payload.type || '').includes('webm') &&
      (modalText || '').includes(expected.message)
    );
    report.check(
      'FIREFOX-EXPORT-REAL-FORMAT',
      'El fichero es WebM (lo que Firefox puede grabar) y el modal lo dice con el texto veraz',
      formatOk,
      `pedido=${requestedFormat}, MIME real=${payload.type} => formato real=${expected.actualFormat} ` +
        `(desajuste=${expected.isFormatMismatch}) | ` +
        `mensaje esperado de buildExportResultMessage: "${expected.message}" | ` +
        `el modal lo contiene=${(modalText || '').includes(expected.message)}`,
      { details: { requestedFormat, mime: payload.type, expected } }
    );

    /* ---- 6. video AND audio streams inside the file ---- */
    // Sin ffprobe no se puede inspeccionar el fichero: el check se omite
    // con un mensaje (no es un fallo), como la suite sin Firefox.
    if (!isFfprobeAvailable()) {
      console.log(
        `  ⊘ FIREFOX-EXPORT-STREAMS omitido: no se encontró ffprobe en "${resolveFfprobePath()}". ` +
          `Instala ffmpeg para verificar las pistas (no es un fallo).`
      );
    } else {
      let streams = null;
      let probeError = null;
      try {
        streams = ffprobeStreams(filePath);
      } catch (err) {
        probeError = err && err.message ? err.message : String(err);
      }
      const types = streams ? streams.map((s) => s.codec_type) : [];
      const streamsOk = Boolean(
        streams && types.includes('video') && types.includes('audio')
      );
      report.check(
        'FIREFOX-EXPORT-STREAMS',
        'El fichero exportado trae pista de vídeo Y pista de audio (ffprobe)',
        streamsOk,
        streams
          ? `streams: ${streams.map((s) => `${s.codec_type}=${s.codec_name}${s.width ? ` ${s.width}x${s.height}` : ''}${s.channels ? ` ${s.channels}ch` : ''}`).join(' | ')}`
          : `ffprobe falló: ${(probeError || 'n/d').slice(0, 300)}`,
        { details: { streams, probeError } }
      );
    }
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        /* ignore */
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        try {
          browser.process()?.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
    for (const dir of tmpFiles) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
