/**
 * suite-recent.mjs — browser coverage for the features that landed recently
 * (crossfade F5, audio fades, audio effects, keyframes F8, colour export F9,
 * project round-trip with media).
 *
 *   CROSSFADE-PIXELS          a 0.5 s crossfade between two solid-colour image
 *                             clips blends ~50/50 in the middle of the overlap
 *                             (vs the static opaque rendering without it)
 *   CROSSFADE-LOCKED          with the track locked the create control is
 *                             disabled and the reason is visible
 *   AUDIO-FADE-PREVIEW        a 1 s linear fade-in drives the pooled media
 *                             element volume (≈0 at the start, ≈0.5 mid-fade)
 *   AUDIO-FADE-EXPORT         the exported MP4 audio is not flat: RMS of the
 *                             first 10 % is clearly lower than RMS of the middle
 *   COLOR-EXPORT-CARRIES-FILTER the B/N preset survives into the exported MP4
 *                             frame (desaturated vs the unfiltered preview)
 *   KEYFRAMES-MOVE            +200 X on a keyframe moves the painted text by
 *                             >= 50 px and the mid-time is the linear midpoint
 *   KEYFRAMES-EXPORT          the exported frames follow the animation
 *                             (monotonic X, same direction as the preview)
 *   AUDIO-EFFECTS-INSPECTOR   "Efectos de audio" section, pan/EQ/duck controls
 *                             with Spanish labels, track role selector
 *   AUDIO-EFFECTS-SUPPORT     without createStereoPanner the pan control is
 *                             disabled with the unsupported reason
 *   STORAGE-ROUNDTRIP-WITH-MEDIA export with media, wipe OPFS, re-import:
 *                             media plays again, no "-sin-medios" in the name
 *
 * No sample generation: every media is synthesised in Node (BMP/WAV) and
 * imported through the real OPFS path, so the bytes are deterministic. Only
 * ONE MP4 export is performed (2 s, 720p): it serves the audio, colour and
 * keyframe export checks at once (audio RMS + video frames via ffmpeg).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  bootApp,
  waitForAppReady,
  dismissWelcome,
  openExportModal,
  setupDownloadCapture,
  clickButtonByText,
  safeEvaluate,
  blurActiveElement,
  navCount,
  navigateWithRetry,
  waitForPersistedProject,
  readMp4VideoTrackSize,
  delay,
} from './browser-harness.mjs';

export const name = 'recent';
export const title = 'Crossfade, fundidos y efectos de audio, keyframes, color y round-trip';

const BACKGROUND = { r: 0x0a, g: 0x0a, b: 0x0c };
const SOLID_A = { r: 99, g: 102, b: 241 }; // indigo #6366f1
const SOLID_B = { r: 236, g: 72, b: 153 }; // pink #ec4899

/* ------------------------------------------------------------------ *
 * Node-side media synthesis (deterministic bytes, no MediaRecorder)
 * ------------------------------------------------------------------ */

/** 24-bit BMP (bottom-up, BGR). `px(x, y)` returns [r, g, b]. */
function makeBmp24(width, height, px) {
  const rowSize = width * 3;
  const data = Buffer.alloc(54 + rowSize * height);
  data.write('BM', 0);
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(width, 18);
  data.writeInt32LE(height, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  for (let y = 0; y < height; y++) {
    const row = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = px(x, y);
      const o = 54 + row * rowSize + x * 3;
      data[o] = b;
      data[o + 1] = g;
      data[o + 2] = r;
    }
  }
  return data;
}

/** 16-bit mono WAV. `fn(t)` returns a sample in [-1, 1]. */
function makeWav16(seconds, sampleRate, fn) {
  const n = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + n * 2, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, fn(i / sampleRate)));
    data.writeInt16LE(Math.round(s * 0x7fff), 44 + i * 2);
  }
  return data;
}

const BMP_W = 640;
const BMP_H = 360;
const WAV_SECONDS = 2;
const WAV_RATE = 44100;

function solidBmp(color) {
  return makeBmp24(BMP_W, BMP_H, () => [color.r, color.g, color.b]);
}

/** Vertical thirds R/G/B: maximally colourful (channel spread 255). */
function gradientBmp() {
  return makeBmp24(BMP_W, BMP_H, (x) => {
    const third = BMP_W / 3;
    if (x < third) return [255, 0, 0];
    if (x < 2 * third) return [0, 255, 0];
    return [0, 0, 255];
  });
}

function sineWav() {
  return makeWav16(WAV_SECONDS, WAV_RATE, (t) => 0.5 * Math.sin(2 * Math.PI * 440 * t));
}

/* ------------------------------------------------------------------ *
 * ffmpeg helpers (MP4 frame / audio introspection)
 * ------------------------------------------------------------------ */

function ffprobeStreams(filePath) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-of', 'json', filePath],
    { encoding: 'utf8', timeout: 30_000 }
  );
  return JSON.parse(out).streams || [];
}

/** Extracts one raw RGB24 frame at `seconds` into `outPath`. Returns {w,h}. */
function extractRawFrame(filePath, seconds, outPath, w, h) {
  execFileSync(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-ss', String(seconds),
      '-i', filePath,
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-s', `${w}x${h}`,
      outPath,
    ],
    { timeout: 30_000 }
  );
  return { w, h };
}

/** Extracts mono 44.1kHz s16le PCM into `outPath`. Returns the raw Buffer. */
function extractPcm(filePath, outPath) {
  execFileSync(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-i', filePath,
      '-vn', '-ac', '1', '-ar', '44100',
      '-f', 's16le', '-acodec', 'pcm_s16le',
      outPath,
    ],
    { timeout: 60_000 }
  );
  return fs.readFileSync(outPath);
}

/** Stats of raw RGB24 pixels excluding near-background ones. */
function rawFrameStats(buffer, w, h, bg = BACKGROUND, tol = 12) {
  let painted = 0;
  let sx = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let maxSpread = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const r = buffer[i];
      const g = buffer[i + 1];
      const b = buffer[i + 2];
      if (
        Math.abs(r - bg.r) <= tol &&
        Math.abs(g - bg.g) <= tol &&
        Math.abs(b - bg.b) <= tol
      ) {
        continue;
      }
      painted++;
      sx += x;
      sr += r;
      sg += g;
      sb += b;
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      if (spread > maxSpread) maxSpread = spread;
    }
  }
  if (!painted) return { painted };
  return {
    painted,
    cx: sx / painted,
    mean: { r: sr / painted, g: sg / painted, b: sb / painted },
    maxSpread,
  };
}

/** RMS of s16le PCM samples in [from, to) (sample indices). */
function rmsOfPcm(buffer, from, to) {
  const total = Math.floor(buffer.length / 2);
  const a = Math.max(0, from);
  const b = Math.min(total, to);
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) {
    const v = buffer.readInt16LE(i * 2) / 0x8000;
    sum += v * v;
  }
  return Math.sqrt(sum / (b - a));
}

/* ------------------------------------------------------------------ *
 * Shared in-page helpers (mirrors of suite-features, kept local)
 * ------------------------------------------------------------------ */

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

function readPreviewStats(bg, tol) {
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
  let sx = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let maxSpread = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (
        Math.abs(r - bg.r) <= tol &&
        Math.abs(g - bg.g) <= tol &&
        Math.abs(b - bg.b) <= tol
      ) {
        continue;
      }
      painted++;
      sx += x;
      sr += r;
      sg += g;
      sb += b;
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      if (spread > maxSpread) maxSpread = spread;
    }
  }
  if (!painted) return { painted, total: w * h };
  return {
    painted,
    total: w * h,
    cx: sx / painted,
    mean: { r: sr / painted, g: sg / painted, b: sb / painted },
    maxSpread,
  };
}

function statsKey(s) {
  if (!s || s.error || !s.painted) return null;
  return `${s.painted}|${s.cx.toFixed(1)}|${s.mean.r.toFixed(1)},${s.mean.g.toFixed(1)},${s.mean.b.toFixed(1)}|${s.maxSpread}`;
}

async function measureStablePreview(page, { timeout = 12_000, minPainted = 500, tol = 8 } = {}) {
  const deadline = Date.now() + timeout;
  let previous = null;
  let last = null;
  while (Date.now() < deadline) {
    const current = await safeEvaluate(page, readPreviewStats, BACKGROUND, tol);
    last = current;
    const key = statsKey(current);
    if (current && !current.error && current.painted >= minPainted && key && key === previous) {
      return current;
    }
    previous = key;
    await delay(250);
  }
  return last;
}

/**
 * Seeks to `t` and reads stable pixels, forcing repaints while waiting.
 *
 * A paused seek renders ONCE: an image that finishes decoding right after
 * keeps a stale cached frame on screen forever (the dirty-check skips
 * identical frames and nothing schedules a repaint on img.onload). Worse,
 * the stability detector then locks onto the stale frame (two identical
 * reads of the wrong content). So when the content is EXPECTED to differ
 * from `prevKey`, the seek is nudged by a frame every 350 ms (each nudge
 * forces a render) until the reading actually changes; only then does the
 * two-identical stabilization run. Pass `prevKey: null` when the content
 * is expected to be identical (no differ-wait, no wasted time).
 */
async function readPixelsAt(page, t, { prevKey = null, timeout = 10_000, minPainted = 500, tol = 8 } = {}) {
  await seekTo(page, t);
  if (prevKey) {
    const deadline = Date.now() + 2500;
    let i = 0;
    for (;;) {
      const current = await safeEvaluate(page, readPreviewStats, BACKGROUND, tol);
      const key = statsKey(current);
      if (key && key !== prevKey) break;
      if (Date.now() >= deadline) break;
      await delay(350);
      i++;
      await seekTo(page, t + (i % 2) * 0.034);
    }
    await seekTo(page, t);
  }
  return measureStablePreview(page, { timeout, minPainted, tol });
}

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

async function clickClip(page, clipId) {
  const clicked = await safeEvaluate(page, (id) => {
    const el = document.querySelector(`[data-clip-id="${id}"]`);
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, clipId);
  if (!clicked) throw new Error(`el clip ${clipId} no está en el DOM`);
  await delay(300);
}

function dist3(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/**
 * Imports deterministic test media through the REAL path (OPFS + object URL),
 * without MediaRecorder. Returns {id, duration, opfsPath}.
 */
async function importTestMedia(page, { name, mime, type, duration, width, height, base64 }) {
  return safeEvaluate(page, async (args) => {
    try {
      const stb = await import('/src/core/storage/opfsStorage.ts');
      const store = window.__projectStore;
      if (!store) return { ok: false, reason: 'la app no expone window.__projectStore' };
      const bytes = Uint8Array.from(atob(args.base64), (c) => c.charCodeAt(0));
      const file = new File([bytes], args.name, { type: args.mime });
      const mediaId = `media_test_${Math.random().toString(36).substring(2, 9)}`;
      let opfsPath;
      try {
        opfsPath = await stb.saveMediaToOPFS(mediaId, file);
      } catch (err) {
        return { ok: false, reason: `OPFS: ${err && err.message}` };
      }
      const url = URL.createObjectURL(file);
      const item = {
        id: mediaId,
        name: args.name,
        type: args.type,
        url,
        duration: args.duration,
        width: args.width,
        height: args.height,
        fps: 30,
        thumbnailUrl: args.type === 'image' ? url : '',
        size: file.size,
        createdAt: Date.now(),
        opfsPath,
      };
      store.getState().addMediaItem(item);
      return { ok: true, id: mediaId, duration: args.duration, opfsPath };
    } catch (err) {
      return { ok: false, reason: `excepción: ${err && err.message}` };
    }
  }, { name, mime, type, duration, width, height, base64 });
}

async function addClip(page, mediaId, trackId, start) {
  return safeEvaluate(page, (mid, tid, s) => {
    const store = window.__projectStore;
    if (!store) return { ok: false, reason: 'sin store' };
    const media = store.getState().project.mediaPool.find((m) => m.id === mid);
    if (!media) return { ok: false, reason: 'medio no encontrado' };
    return store.getState().addClipFromMedia(media, tid, s);
  }, mediaId, trackId, start);
}

/* ------------------------------------------------------------------ *
 * Expected check ids (for honest reporting after HMR reloads)
 * ------------------------------------------------------------------ */
const PREVIEW_EXPECTED = [
  { id: 'CROSSFADE-PIXELS', title: 'El fundido de cruce mezcla ambos clips en el solape' },
  { id: 'KEYFRAMES-MOVE', title: 'El keyframe mueve los píxeles con interpolación lineal' },
  { id: 'AUDIO-EFFECTS-INSPECTOR', title: 'La sección de efectos de audio está en español' },
  { id: 'AUDIO-FADE-PREVIEW', title: 'El fundido de audio gobierna el volumen del preview' },
];
const LOCKED_CHECK = {
  id: 'CROSSFADE-LOCKED',
  title: 'Con la pista bloqueada «Crear fundido» está deshabilitado y el motivo es visible',
};

const EXPORT_EXPECTED = [
  { id: 'AUDIO-FADE-EXPORT', title: 'El audio exportado respeta el fundido (RMS)' },
  { id: 'COLOR-EXPORT-CARRIES-FILTER', title: 'El fotograma exportado lleva el filtro B/N' },
  { id: 'KEYFRAMES-EXPORT', title: 'Los fotogramas exportados siguen la animación' },
];

/* ------------------------------------------------------------------ *
 * Case 1 — preview/DOM checks (one context, one boot, no generation)
 * ------------------------------------------------------------------ */
async function casePreview({ browser, report, baseUrl, assets }) {
  const outcome = await runScenario(async () => {
    const { context, page } = await bootApp(browser, { width: 1440, height: 900, baseUrl });
    try {
      const navBefore = navCount(page);
      const checks = [];
      const decide = (id, title, ok, message, details) =>
        checks.push({ id, title, ok: Boolean(ok), message, details });

      /* --- deterministic media ------------------------------------- */
      const imgA = await importTestMedia(page, {
        name: 'solido-indigo.bmp', mime: 'image/bmp', type: 'image',
        duration: 5, width: BMP_W, height: BMP_H, base64: assets.indigo,
      });
      const imgB = await importTestMedia(page, {
        name: 'solido-rosa.bmp', mime: 'image/bmp', type: 'image',
        duration: 5, width: BMP_W, height: BMP_H, base64: assets.pink,
      });
      const wav = await importTestMedia(page, {
        name: 'seno-440.wav', mime: 'audio/wav', type: 'audio',
        duration: WAV_SECONDS, width: 0, height: 0, base64: assets.wav,
      });
      if (!imgA.ok || !imgB.ok || !wav.ok) {
        const msg = `No se pudieron importar los medios de prueba: ${JSON.stringify({ imgA, imgB, wav })}`;
        for (const item of PREVIEW_EXPECTED) decide(item.id, item.title, false, msg);
        return { reloaded: navCount(page) !== navBefore, checks };
      }

      /* --- timeline: A[0,2) + B[2,4) adjacent on Video V1 ----------- */
      const rA = await addClip(page, imgA.id, 'track_video_1', 0);
      if (rA.ok) {
        await safeEvaluate(page, (id) => window.__projectStore.getState().updateClip(id, { duration: 2 }), rA.clipId);
      }
      const rB = await addClip(page, imgB.id, 'track_video_1', 2);
      if (rB.ok) {
        await safeEvaluate(page, (id) => window.__projectStore.getState().updateClip(id, { duration: 2 }), rB.clipId);
      }
      if (!rA.ok || !rB.ok) {
        const msg = `No se pudo preparar el timeline del crossfade: ${JSON.stringify({ rA, rB })}`;
        for (const item of PREVIEW_EXPECTED) decide(item.id, item.title, false, msg);
        return { reloaded: navCount(page) !== navBefore, checks };
      }
      const clipA = rA.clipId;
      const clipB = rB.clipId;
      await clickClip(page, clipA);

      /* --- CROSSFADE-LOCKED ---------------------------------------- */
      await safeEvaluate(page, () => {
        const btn = document.querySelector('[data-testid="track-header-track_video_1"] button[aria-label="Bloquear pista"]');
        if (btn) btn.click();
      });
      let locked = false;
      for (let i = 0; i < 40 && !locked; i++) {
        locked = await safeEvaluate(page, () => {
          const store = window.__projectStore;
          const t = store && store.getState().project.tracks.find((x) => x.id === 'track_video_1');
          return Boolean(t && t.isLocked);
        });
        if (!locked) await delay(100);
      }
      const lockState = await safeEvaluate(page, () => {
        const createBtn = document.querySelector('[data-testid="crossfade-create"]');
        const noNeighbour = document.querySelector('[data-testid="crossfade-no-neighbour"]');
        const reason = document.querySelector('[data-testid="crossfade-disabled-reason"]') || noNeighbour;
        let visible = false;
        if (reason) {
          const b = reason.getBoundingClientRect();
          const cs = getComputedStyle(reason);
          visible = cs.display !== 'none' && b.width > 0 && b.height > 0;
        }
        return {
          createPresent: Boolean(createBtn),
          createDisabled: createBtn ? createBtn.disabled : null,
          reasonKind: !reason ? null : reason.getAttribute('data-testid'),
          reason: reason ? (reason.textContent || '').trim().replace(/\s+/g, ' ') : null,
          reasonVisible: visible,
        };
      });
      // Spec: con la pista bloqueada el botón «Crear fundido» QUEDA VISIBLE
      // pero deshabilitado y el motivo se muestra (como el resto de secciones
      // del Inspector). Check normal de regresión: si el control desaparece o
      // queda habilitado con la pista bloqueada, la suite falla.
      const reasonOk = Boolean(
        lockState.reasonVisible && lockState.reason && /bloqueada/.test(lockState.reason)
      );
      const lockedCheck = {
        id: LOCKED_CHECK.id,
        title: LOCKED_CHECK.title,
        ok: Boolean(locked && lockState.createPresent && lockState.createDisabled === true && reasonOk),
        message:
          `con la pista bloqueada el botón «Crear fundido» queda visible y deshabilitado ` +
          `(presente=${lockState.createPresent}, deshabilitado=${lockState.createDisabled}) | ` +
          `motivo visible (${lockState.reasonKind}): "${lockState.reason ?? 'n/d'}"`,
        details: { locked, lockState },
      };
      // Unlock for the pixel scenario.
      await safeEvaluate(page, () => {
        const btn = document.querySelector('[data-testid="track-header-track_video_1"] button[aria-label="Desbloquear pista"]');
        if (btn) btn.click();
      });

      /* --- create the crossfade through the real button ------------- */
      const createClicked = await safeEvaluate(page, () => {
        const btn = document.querySelector('[data-testid="crossfade-create"]');
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      });
      let pair = null;
      for (let i = 0; i < 40; i++) {
        pair = await safeEvaluate(page, (ids) => {
          const store = window.__projectStore;
          if (!store) return null;
          const clips = store.getState().project.clips;
          const a = clips.find((c) => c.id === ids[0]);
          const b = clips.find((c) => c.id === ids[1]);
          return {
            out: a && a.transition ? a.transition.crossfadeOutDuration ?? null : null,
            inDur: b && b.transition ? b.transition.crossfadeInDuration ?? null : null,
            bStart: b ? b.start : null,
          };
        }, [clipA, clipB]);
        if (pair && Math.abs((pair.out ?? -1) - 0.5) < 1e-6) break;
        await delay(100);
      }
      const pairOk = Boolean(
        createClicked && pair &&
        Math.abs(pair.out - 0.5) < 1e-6 && Math.abs(pair.inDur - 0.5) < 1e-6 &&
        Math.abs(pair.bStart - 1.5) < 1e-6
      );

      /* --- CROSSFADE-PIXELS ----------------------------------------- */
      let pixelsMsg = '';
      let pixelsOk = false;
      let pixelsDetail = { pairOk, pair };
      if (pairOk) {
        const meanA = await readPixelsAt(page, 1.0);
        const meanB = await readPixelsAt(page, 3.0, { prevKey: statsKey(meanA) });
        const mixM = await readPixelsAt(page, 1.75, { prevKey: statsKey(meanB) });
        // Static rendering: remove the crossfade, the same instant is opaque A.
        await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="crossfade-remove"]');
          if (btn) btn.click();
        });
        await delay(400);
        const staticA = await readPixelsAt(page, 1.75, { prevKey: statsKey(mixM) });

        const dA = meanA && meanA.mean ? dist3(meanA.mean, SOLID_A) : null;
        const dB = meanB && meanB.mean ? dist3(meanB.mean, SOLID_B) : null;
        // The compositor draws out (alpha 1-p) then in (alpha p) over it:
        // middle == 0.5*in + 0.25*out + 0.25*bg.
        const expectedMix =
          meanA && meanA.mean && meanB && meanB.mean
            ? {
                r: 0.5 * meanB.mean.r + 0.25 * meanA.mean.r + 0.25 * BACKGROUND.r,
                g: 0.5 * meanB.mean.g + 0.25 * meanA.mean.g + 0.25 * BACKGROUND.g,
                b: 0.5 * meanB.mean.b + 0.25 * meanA.mean.b + 0.25 * BACKGROUND.b,
              }
            : null;
        const dMix = mixM && mixM.mean && expectedMix ? dist3(mixM.mean, expectedMix) : null;
        const dStatic = mixM && mixM.mean && staticA && staticA.mean ? dist3(mixM.mean, staticA.mean) : null;
        const dOutside = meanA && meanA.mean && staticA && staticA.mean ? dist3(meanA.mean, staticA.mean) : null;

        pixelsOk = Boolean(
          dA !== null && dA < 20 && dB !== null && dB < 20 &&
          dMix !== null && dMix < 35 && dStatic !== null && dStatic > 40 &&
          dOutside !== null && dOutside < 15
        );
        pixelsMsg =
          `fuera del solape: A=${dA !== null ? dA.toFixed(1) : 'n/d'} (< 20), B=${dB !== null ? dB.toFixed(1) : 'n/d'} (< 20) | ` +
          `en el medio del solape (1,75 s): distancia a la mezcla 50/50=${dMix !== null ? dMix.toFixed(1) : 'n/d'} (< 35) | ` +
          `distancia al render estático (sin fundido)=${dStatic !== null ? dStatic.toFixed(1) : 'n/d'} (> 40) | ` +
          `estático vs fuera del solape=${dOutside !== null ? dOutside.toFixed(1) : 'n/d'} (< 15)`;
        pixelsDetail = {
          pairOk, pair,
          meanA: meanA && meanA.mean, meanB: meanB && meanB.mean,
          mix: mixM && mixM.mean, expectedMix, static: staticA && staticA.mean,
          dA, dB, dMix, dStatic, dOutside,
        };
      } else {
        pixelsMsg = `No se pudo crear el fundido de 0,5 s con el botón real: ${JSON.stringify(pair)}`;
      }
      decide(
        'CROSSFADE-PIXELS',
        'El fundido de 0,5 s mezcla ambos clips en el solape (≈50/50 en el medio)',
        pixelsOk,
        pixelsMsg,
        pixelsDetail
      );

      /* --- KEYFRAMES-MOVE (text clip: deterministic pixels) --------- */
      // The video clips leave the timeline: at t=2,3 the pink clip would
      // paint underneath the text (but not at t=4, the exclusive end),
      // confounding the midpoint comparison.
      await safeEvaluate(page, (ids) => {
        const store = window.__projectStore;
        if (!store) return;
        for (const id of ids) store.getState().removeClip(id);
      }, [clipA, clipB]);
      const textId = await safeEvaluate(page, () => {
        const store = window.__projectStore;
        if (!store) return null;
        store.getState().addTextClip('KFX', 0);
        const clip = store.getState().project.clips.find((c) => c.type === 'text');
        return clip ? clip.id : null;
      });
      let moveOk = false;
      let moveMsg = '';
      let moveDetail = {};
      if (textId) {
        await clickClip(page, textId);
        const s2 = await readPixelsAt(page, 2);
        const s4 = await readPixelsAt(page, 4);
        const staticGap =
          s2 && s2.cx !== undefined && s4 && s4.cx !== undefined ? Math.abs(s2.cx - s4.cx) : null;

        // Keyframe at the playhead (t=2), move the playhead, second keyframe (t=4).
        await seekTo(page, 2);
        await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="keyframe-add"]');
          if (btn) btn.click();
        });
        await delay(400);
        await seekTo(page, 4);
        await safeEvaluate(page, () => {
          const btn = document.querySelector('[data-testid="keyframe-add"]');
          if (btn) btn.click();
        });
        await delay(400);
        // Select the t=4 keyframe and move its X by +200 through the slider.
        // Select the t=4 keyframe (without toggling it off when the
        // "add" button already left it selected) and move its X by +200.
        const kfSelected = await safeEvaluate(page, () => {
          const btns = Array.from(document.querySelectorAll('[data-testid="keyframe-section"] button'));
          const target = btns.find((b) =>
            (b.getAttribute('aria-label') || '').startsWith('Seleccionar keyframe de 4') ||
            (b.getAttribute('aria-label') || '').startsWith('Dejar de editar el keyframe de 4')
          );
          if (!target) return false;
          if (target.getAttribute('aria-pressed') !== 'true') target.click();
          return true;
        });
        const sliderLabel = await safeEvaluate(page, () => {
          const input = Array.from(document.querySelectorAll('input[type="range"]')).find((el) =>
            (el.getAttribute('aria-label') || '').startsWith('Posición horizontal X del keyframe')
          );
          return input ? input.getAttribute('aria-label') : null;
        });
        const sliderSet = sliderLabel ? await setRangeValue(page, sliderLabel, 200) : null;
        await delay(400);
        const kfState = await safeEvaluate(page, (id) => {
          const store = window.__projectStore;
          if (!store) return null;
          const clip = store.getState().project.clips.find((c) => c.id === id);
          const notice = document.querySelector('[data-testid="keyframe-editing-notice"]');
          return { keyframes: clip ? clip.keyframes ?? null : null, notice: Boolean(notice) };
        }, textId);

        const k2 = await readPixelsAt(page, 2);
        const k3 = await readPixelsAt(page, 3, { prevKey: statsKey(k2) });
        const k4 = await readPixelsAt(page, 4, { prevKey: statsKey(k3) });

        const shift =
          k4 && k4.cx !== undefined && s4 && s4.cx !== undefined ? k4.cx - s4.cx : null;
        const midExpected =
          k2 && k2.cx !== undefined && k4 && k4.cx !== undefined ? (k2.cx + k4.cx) / 2 : null;
        const midErr =
          midExpected !== null && k3 && k3.cx !== undefined ? Math.abs(k3.cx - midExpected) : null;

        moveOk = Boolean(
          staticGap !== null && staticGap < 20 &&
          kfSelected && sliderSet !== null && kfState && kfState.notice &&
          shift !== null && Math.abs(shift) >= 50 &&
          midErr !== null && midErr <= 30
        );
        moveMsg =
          `estático t=2 vs t=4: deriva=${staticGap !== null ? staticGap.toFixed(1) : 'n/d'} px (< 20) | ` +
          `keyframe t=4 seleccionado=${kfSelected}, slider X→200=${sliderSet}, aviso visible=${kfState && kfState.notice}, ` +
          `keyframes=${JSON.stringify(kfState && kfState.keyframes)} | ` +
          `cx: estático@t4=${s4 && s4.cx !== undefined ? s4.cx.toFixed(1) : 'n/d'}, ` +
          `kf@t2=${k2 && k2.cx !== undefined ? k2.cx.toFixed(1) : 'n/d'}, ` +
          `kf@t3=${k3 && k3.cx !== undefined ? k3.cx.toFixed(1) : 'n/d'}, ` +
          `kf@t4=${k4 && k4.cx !== undefined ? k4.cx.toFixed(1) : 'n/d'} | ` +
          `desplazamiento en t=4: ${shift !== null ? shift.toFixed(1) : 'n/d'} px (>= 50) | ` +
          `error de linealidad en t=3: ${midErr !== null ? midErr.toFixed(1) : 'n/d'} px (<= 30)`;
        moveDetail = { staticGap, kfSelected, sliderLabel, sliderSet, kfState, shift, midErr };
      } else {
        moveMsg = 'No se pudo crear el clip de texto para los keyframes.';
      }
      decide(
        'KEYFRAMES-MOVE',
        'El keyframe X+200 mueve los píxeles >= 50 px y el punto medio interpola lineal',
        moveOk,
        moveMsg,
        moveDetail
      );

      /* --- AUDIO-EFFECTS-INSPECTOR ---------------------------------- */
      const rAu = await addClip(page, wav.id, 'track_audio_1', 0);
      const audioClipId = rAu.ok ? rAu.clipId : null;
      if (audioClipId) await clickClip(page, audioClipId);
      const inspector = await safeEvaluate(page, () => {
        const section = document.querySelector('[data-testid="audio-effects-section"]');
        const text = (sel) => {
          const host = sel.closest('div');
          const label = host ? host.querySelector('label') : null;
          return label ? (label.textContent || '').trim() : null;
        };
        const pan = document.querySelector('[data-testid="clip-audio-pan"]');
        const eqLow = document.querySelector('[data-testid="clip-audio-eq-low"]');
        const eqMid = document.querySelector('[data-testid="clip-audio-eq-mid"]');
        const eqHigh = document.querySelector('[data-testid="clip-audio-eq-high"]');
        const duck = document.querySelector('[data-testid="clip-audio-duck"]');
        const role = document.querySelector('[data-testid="track-role-select"]');
        return {
          section: Boolean(section) && (section.textContent || '').includes('Efectos de audio'),
          pan: pan ? { label: text(pan), enabled: !pan.disabled } : null,
          eqLow: eqLow ? { label: text(eqLow), enabled: !eqLow.disabled } : null,
          eqMid: eqMid ? { label: text(eqMid), enabled: !eqMid.disabled } : null,
          eqHigh: eqHigh ? { label: text(eqHigh), enabled: !eqHigh.disabled } : null,
          duck: duck
            ? {
                enabled: !duck.disabled,
                label: ((duck.closest('label') || {}).textContent || '').trim().replace(/\s+/g, ' '),
              }
            : null,
          role: role
            ? {
                aria: role.getAttribute('aria-label'),
                options: Array.from(role.options).map((o) => (o.textContent || '').trim()),
              }
            : null,
        };
      });
      const inspectorOk = Boolean(
        audioClipId && inspector.section &&
        inspector.pan && inspector.pan.label === 'Paneo:' && inspector.pan.enabled &&
        inspector.eqLow && inspector.eqLow.label === 'Graves:' &&
        inspector.eqMid && inspector.eqMid.label === 'Medios:' &&
        inspector.eqHigh && inspector.eqHigh.label === 'Agudos:' &&
        inspector.duck && /Ducking/.test(inspector.duck.label || '') &&
        inspector.role && inspector.role.options.join('|') === 'Sin rol|Diálogo (voz)|Música|Efectos'
      );
      decide(
        'AUDIO-EFFECTS-INSPECTOR',
        'La sección «Efectos de audio» existe con paneo/EQ/ducking en español y selector de rol',
        inspectorOk,
        `sección=${inspector.section} | paneo="${inspector.pan && inspector.pan.label}" | ` +
          `EQ="${inspector.eqLow && inspector.eqLow.label}/${inspector.eqMid && inspector.eqMid.label}/${inspector.eqHigh && inspector.eqHigh.label}" | ` +
          `duck="${inspector.duck && inspector.duck.label}" | roles=[${inspector.role && inspector.role.options.join(', ')}]`,
        { audioClipId, inspector }
      );

      /* --- AUDIO-FADE-PREVIEW ---------------------------------------- */
      let fadeOk = false;
      let fadeMsg = '';
      let fadeDetail = {};
      if (audioClipId) {
        await setRangeValue(page, 'audio-fade-in-duration', 1);
        await selectOption(page, 'audio-fade-in-curve', 'linear');
        await delay(300);
        const fadeState = await safeEvaluate(page, (id) => {
          const store = window.__projectStore;
          if (!store) return null;
          const clip = store.getState().project.clips.find((c) => c.id === id);
          return clip ? { inDur: clip.audioFadeIn?.duration ?? null, curve: clip.audioFadeIn?.curve ?? null } : null;
        }, audioClipId);
        const fadeStored = Boolean(
          fadeState && Math.abs((fadeState.inDur ?? -1) - 1) < 1e-6 && fadeState.curve === 'linear'
        );

        // Play from the clip start and sample (master-clock time, element
        // volume). NOTE: the store's `currentTime` does not track playback,
        // so the poll reads `masterClock.getTime()` (the same clock the
        // engine renders with).
        await seekTo(page, 0);
        const mediaId = wav.id;
        await blurActiveElement(page);
        await page.keyboard.press('Space');
        const samples = [];
        const pollDeadline = Date.now() + 6000;
        while (Date.now() < pollDeadline) {
          const s = await safeEvaluate(page, (mid, cid) => {
            const pool = window.__mediaSourcePool;
            const map = pool && pool.audioElements;
            const el = map && typeof map.get === 'function' ? map.get(`${mid}_${cid}`) : null;
            const clock = window.__masterClock;
            return {
              t: clock && typeof clock.getTime === 'function' ? clock.getTime() : null,
              v: el ? el.volume : null,
              playing: clock && typeof clock.getIsPlaying === 'function' ? clock.getIsPlaying() : null,
            };
          }, mediaId, audioClipId);
          if (s && typeof s.t === 'number' && typeof s.v === 'number') samples.push(s);
          const lastT = samples.length ? samples[samples.length - 1].t : 0;
          if (lastT > 0.9) break;
          await delay(60);
        }
        await page.keyboard.press('Space');
        await delay(300);

        const near = (target) => samples.reduce((best, s) =>
          !best || Math.abs(s.t - target) < Math.abs(best.t - target) ? s : best, null);
        const vStart = near(0.05);
        const vMid = near(0.5);
        fadeOk = Boolean(
          fadeStored && vStart && vStart.v <= 0.12 && vMid && vMid.v >= 0.35 && vMid.v <= 0.65
        );
        fadeMsg =
          `fundido guardado (1 s, lineal)=${fadeStored} | ` +
          `volumen en t≈${vStart ? vStart.t.toFixed(2) : 'n/d'} s: ${vStart ? vStart.v.toFixed(3) : 'n/d'} (<= 0,12) | ` +
          `volumen en t≈${vMid ? vMid.t.toFixed(2) : 'n/d'} s: ${vMid ? vMid.v.toFixed(3) : 'n/d'} (≈0,5 lineal, NO 0,71: ` +
          `0,71 es sin(π/4), la curva equalPower; la lineal en el punto medio vale 0,5 por definición)`;
        fadeDetail = { fadeState, vStart, vMid, sampleCount: samples.length };
      } else {
        fadeMsg = 'Sin clip de audio para el fundido.';
      }
      decide(
        'AUDIO-FADE-PREVIEW',
        'El fundido de entrada (1 s, lineal) lleva el volumen del elemento de ≈0 a ≈0,5',
        fadeOk,
        fadeMsg,
        fadeDetail
      );

      return { reloaded: navCount(page) !== navBefore, checks, lockedCheck, context, page };
    } catch (err) {
      try {
        await context.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }, { expected: PREVIEW_EXPECTED });

  // The scenario keeps the context open on success (the support case reuses
  // the same origin storage on a second page). On reload-abort it is closed.
  if (outcome && outcome.reloaded && outcome.context) {
    try {
      await outcome.context.close();
    } catch {
      /* ignore */
    }
  }
  let live = outcome && outcome.context && outcome.page && !outcome.reloaded ? outcome : null;
  const checks = (outcome && outcome.checks) || [];
  for (const check of checks) {
    report.check(check.id, check.title, check.ok, check.message, check.details);
  }
  if (outcome && outcome.lockedCheck) {
    const k = outcome.lockedCheck;
    report.check(k.id, k.title, k.ok, k.message, k.details);
  } else {
    report.check(
      LOCKED_CHECK.id,
      LOCKED_CHECK.title,
      false,
      'El escenario no pudo completarse (recarga del dev server): el estado con la pista bloqueada no se evaluó.'
    );
  }
  return live;
}

/* ------------------------------------------------------------------ *
 * Case 2 — AUDIO-EFFECTS-SUPPORT (poisoned page, same context)
 * ------------------------------------------------------------------ */
async function caseSupport({ report, baseUrl, live }) {
  if (!live) {
    report.check(
      'AUDIO-EFFECTS-SUPPORT',
      'Sin StereoPanner el paneo queda deshabilitado con su motivo',
      false,
      'El escenario previo no dejó un contexto vivo (recarga del dev server).'
    );
    return;
  }
  const { context, page: page1 } = live;
  try {
    const navBefore = navCount(page1);
    // Make sure the project (with its audio clip) is on disk: the poisoned
    // page reloads the SAME project from the SAME origin storage.
    const mediaBefore = await safeEvaluate(page1, () => {
      const store = window.__projectStore;
      return store ? store.getState().project.mediaPool.length : 0;
    });
    await waitForPersistedProject(page1, {
      minClips: 1,
      minMedia: mediaBefore || 1,
      timeoutMs: 20_000,
    });
    const audioClipId = await safeEvaluate(page1, () => {
      const store = window.__projectStore;
      if (!store) return null;
      const clip = store.getState().project.clips.find((c) => c.type === 'audio');
      return clip ? clip.id : null;
    });

    const page2 = await context.newPage();
    await page2.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    page2.setDefaultTimeout(30_000);
    page2.setDefaultNavigationTimeout(30_000);
    await page2.evaluateOnNewDocument(() => {
      try {
        AudioContext.prototype.createStereoPanner = undefined;
      } catch {
        /* ignore */
      }
      try {
        OfflineAudioContext.prototype.createStereoPanner = undefined;
      } catch {
        /* ignore */
      }
    });
    await navigateWithRetry(page2, baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page2);
    await dismissWelcome(page2);
    await delay(800);

    if (audioClipId) {
      try {
        await clickClip(page2, audioClipId);
      } catch {
        /* the clip may need a moment to mount */
      }
    }
    let state = null;
    for (let i = 0; i < 40; i++) {
      state = await safeEvaluate(page2, () => {
        const pan = document.querySelector('[data-testid="clip-audio-pan"]');
        const reason = document.querySelector('[data-testid="clip-audio-pan-unsupported"]');
        let visible = false;
        if (reason) {
          const b = reason.getBoundingClientRect();
          const cs = getComputedStyle(reason);
          visible = cs.display !== 'none' && b.width > 0 && b.height > 0;
        }
        return {
          panPresent: Boolean(pan),
          panDisabled: pan ? pan.disabled : null,
          reason: reason ? (reason.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160) : null,
          reasonVisible: visible,
        };
      });
      if (state && state.panPresent) break;
      await delay(200);
    }

    const ok = Boolean(
      state && state.panPresent && state.panDisabled === true &&
      state.reasonVisible && state.reason && /paneo/i.test(state.reason)
    );
    report.check(
      'AUDIO-EFFECTS-SUPPORT',
      'Sin StereoPanner el paneo queda deshabilitado y explica el motivo',
      ok,
      `paneo presente=${state && state.panPresent}, deshabilitado=${state && state.panDisabled} | ` +
        `motivo visible=${state && state.reasonVisible}: "${state && state.reason ? `${state.reason.slice(0, 120)}…` : 'n/d'}"` +
        (navCount(page1) !== navBefore ? ' | (la página original se recargó durante el escenario)' : ''),
      { state, audioClipId }
    );
    try {
      await page2.close();
    } catch {
      /* ignore */
    }
  } finally {
    try {
      await context.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Case 3 — ONE export serving audio + colour + keyframes + round-trip
 * ------------------------------------------------------------------ */
async function caseExportRoundtrip({ browser, report, baseUrl, assets, workdir }) {
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cut-recent-'));
  const outcome = await runScenario(async () => {
    const { context, page } = await bootApp(browser, { width: 1440, height: 900, baseUrl });
    try {
      const navBefore = navCount(page);
      const checks = [];
      const decide = (id, title, ok, message, details) =>
        checks.push({ id, title, ok: Boolean(ok), message, details });

      const capture = await setupDownloadCapture(browser, context, downloadDir);
      for (const name of fs.readdirSync(downloadDir)) {
        fs.rmSync(path.join(downloadDir, name), { force: true });
      }

      /* --- media --------------------------------------------------- */
      const img = await importTestMedia(page, {
        name: 'bandas-rgb.bmp', mime: 'image/bmp', type: 'image',
        duration: 5, width: BMP_W, height: BMP_H, base64: assets.gradient,
      });
      const wav = await importTestMedia(page, {
        name: 'seno-440.wav', mime: 'audio/wav', type: 'audio',
        duration: WAV_SECONDS, width: 0, height: 0, base64: assets.wav,
      });
      if (!img.ok || !wav.ok) {
        const msg = `Sin medios de prueba: ${JSON.stringify({ img, wav })}`;
        for (const item of EXPORT_EXPECTED) decide(item.id, item.title, false, msg);
        decide('STORAGE-ROUNDTRIP-WITH-MEDIA', 'Round-trip con medios', false, msg);
        return { reloaded: navCount(page) !== navBefore, checks };
      }

      /* --- video clip: 2 s, scale 0.5, B/N, keyframes x 0 -> 200 --- */
      const rV = await addClip(page, img.id, 'track_video_1', 0);
      let videoClipId = rV.ok ? rV.clipId : null;
      if (videoClipId) {
        await safeEvaluate(page, (id) => {
          const store = window.__projectStore;
          store.getState().updateClip(id, { duration: 2, scale: 0.5 });
          store.getState().addKeyframe(id, 0, { x: 0 });
          store.getState().addKeyframe(id, 2, { x: 200 });
        }, videoClipId);
        await clickClip(page, videoClipId);
      }
      /* --- audio clip: 2 s with a 1 s linear fade-in ---------------- */
      const rA = await addClip(page, wav.id, 'track_audio_1', 0);
      const audioClipId = rA.ok ? rA.clipId : null;
      if (audioClipId) {
        await safeEvaluate(page, (id) => {
          window.__projectStore.getState().updateClip(id, {
            audioFadeIn: { duration: 1, curve: 'linear' },
          });
        }, audioClipId);
      }
      if (!videoClipId || !audioClipId) {
        const msg = `Sin clips para exportar: ${JSON.stringify({ rV, rA })}`;
        for (const item of EXPORT_EXPECTED) decide(item.id, item.title, false, msg);
        decide('STORAGE-ROUNDTRIP-WITH-MEDIA', 'Round-trip con medios', false, msg);
        return { reloaded: navCount(page) !== navBefore, checks };
      }

      /* --- unfiltered preview baseline + direction ------------------ */
      // The audio clip stole the selection when it was added: re-select the
      // video clip or the preset would land nowhere.
      await clickClip(page, videoClipId);
      const selOk = await safeEvaluate(page, (id) => {
        const store = window.__projectStore;
        return store ? store.getState().selectedClipId === id : false;
      }, videoClipId);
      const unfiltered = await readPixelsAt(page, 0.5);
      const unfilteredSpread = unfiltered && !unfiltered.error ? unfiltered.maxSpread : null;
      const presetOk = selOk && await selectOption(page, 'clip-color-preset', 'blackWhite');
      await delay(500);
      const filtersNow = await safeEvaluate(page, (id) => {
        const store = window.__projectStore;
        if (!store) return null;
        const clip = store.getState().project.clips.find((c) => c.id === id);
        return clip ? clip.filters ?? null : null;
      }, videoClipId);
      const filteredPreview = await readPixelsAt(page, 0.5, { prevKey: statsKey(unfiltered) });
      const filteredPreviewSpread = filteredPreview && !filteredPreview.error ? filteredPreview.maxSpread : null;
      const pv0 = await readPixelsAt(page, 0.3, { prevKey: statsKey(filteredPreview) });
      const pv1 = await readPixelsAt(page, 1.7, { prevKey: statsKey(pv0) });
      const previewDirUp = Boolean(
        pv0 && pv0.cx !== undefined && pv1 && pv1.cx !== undefined && pv1.cx > pv0.cx + 20
      );

      /* --- the export (cheapest preset, full 2 s range) ------------- */
      await openExportModal(page);
      await clickButtonByText(page, '720p HD', { exact: true });
      await clickButtonByText(page, '30 FPS', { exact: true });
      await clickButtonByText(page, 'Comenzar Exportación');
      let file = null;
      const exportDeadline = Date.now() + 90_000;
      while (Date.now() < exportDeadline) {
        file = await capture.waitForFile({
          timeoutMs: 1500,
          match: (n) => n.toLowerCase().endsWith('.mp4'),
          minBytes: 1024,
        });
        if (file) break;
        if (navCount(page) !== navBefore) {
          return { reloaded: true, checks: [] };
        }
        await delay(400);
      }
      if (!file) {
        const msg = 'La exportación no descargó ningún .mp4 en 90 s.';
        for (const item of EXPORT_EXPECTED) decide(item.id, item.title, false, msg);
        decide('STORAGE-ROUNDTRIP-WITH-MEDIA', 'Round-trip con medios', false, msg);
        return { reloaded: navCount(page) !== navBefore, checks };
      }

      const streams = ffprobeStreams(file.filePath);
      const videoStream = streams.find((s) => s.codec_type === 'video') || {};
      const audioStream = streams.find((s) => s.codec_type === 'audio') || null;
      const outW = Number(videoStream.width) || 1280;
      const outH = Number(videoStream.height) || 720;

      /* --- AUDIO-FADE-EXPORT: real rendered PCM --------------------- */
      let audioOk = false;
      let audioMsg = '';
      let audioDetail = {};
      if (audioStream) {
        const pcmPath = path.join(workdir, 'fade.pcm');
        const pcm = extractPcm(file.filePath, pcmPath);
        const total = Math.floor(pcm.length / 2);
        const rmsFirst = rmsOfPcm(pcm, 0, Math.floor(total * 0.1));
        const rmsMid = rmsOfPcm(pcm, Math.floor(total * 0.5), Math.floor(total * 0.7));
        audioOk = rmsFirst < 0.6 * rmsMid && rmsMid > 0.005;
        audioMsg =
          `pista de audio presente (${audioStream.codec_name}, ${audioStream.sample_rate} Hz) | ` +
          `RMS primer 10 %=${rmsFirst.toFixed(4)}, RMS tramo 50-70 %=${rmsMid.toFixed(4)} ` +
          `(primero < 0,6×medio=${(rmsFirst < 0.6 * rmsMid).toString()}, medio audible=${(rmsMid > 0.005).toString()})`;
        audioDetail = { rmsFirst, rmsMid, codec: audioStream.codec_name };
      } else {
        audioMsg = `El MP4 exportado NO trae pista de audio (streams: ${JSON.stringify(streams.map((s) => s.codec_type))}): el fundido no puede sonar.`;
        audioDetail = { streams: streams.map((s) => s.codec_type) };
      }
      decide(
        'AUDIO-FADE-EXPORT',
        'El audio del MP4 respeta el fundido de 1 s (el inicio suena claramente más bajo)',
        audioOk,
        audioMsg,
        audioDetail
      );

      /* --- video frames --------------------------------------------- */
      const frameTimes = [0.2, 1.0, 1.8];
      const frames = frameTimes.map((t, i) => {
        const rawPath = path.join(workdir, `frame${i}.raw`);
        extractRawFrame(file.filePath, t, rawPath, outW, outH);
        const raw = fs.readFileSync(rawPath);
        return { t, stats: rawFrameStats(raw, outW, outH) };
      });

      /* --- COLOR-EXPORT-CARRIES-FILTER ------------------------------- */
      const spreads = frames.map((f) => f.stats.maxSpread);
      const colorOk = Boolean(
        presetOk && filtersNow && filtersNow.grayscale === 1 &&
        unfilteredSpread !== null && unfilteredSpread > 100 &&
        spreads.every((s) => typeof s === 'number' && s <= 16)
      );
      decide(
        'COLOR-EXPORT-CARRIES-FILTER',
        'El preajuste B/N llega al MP4: el fotograma exportado está desaturado',
        colorOk,
        `preset aplicado por UI=${presetOk}, filtros en el store=${JSON.stringify(filtersNow)} | ` +
          `preview sin filtro: dispersión=${unfilteredSpread} (> 100) | ` +
          `preview con B/N: dispersión=${filteredPreviewSpread} | ` +
          `fotogramas exportados@${frameTimes.join('/')} s: dispersión=[${spreads.join(', ')}] (<= 16) | ` +
          `tkhd=${JSON.stringify(readMp4VideoTrackSize(file.filePath))}`,
        { presetOk, filtersNow, unfilteredSpread, filteredPreviewSpread, spreads }
      );

      /* --- KEYFRAMES-EXPORT ------------------------------------------ */
      const cxs = frames.map((f) => f.stats.cx);
      const mono = cxs.length === 3 && cxs[0] < cxs[1] && cxs[1] < cxs[2];
      const span = cxs.length === 3 ? cxs[2] - cxs[0] : null;
      const kfOk = Boolean(mono && span !== null && span >= 60 && previewDirUp);
      decide(
        'KEYFRAMES-EXPORT',
        'Los fotogramas exportados siguen la animación (X monótona, como el preview)',
        kfOk,
        `centroides X exportados@${frameTimes.join('/')} s: [${cxs.map((c) => (c !== undefined ? c.toFixed(0) : 'n/d')).join(', ')}] ` +
          `(monótonos=${mono}, recorrido=${span !== null ? span.toFixed(0) : 'n/d'} px >= 60) | ` +
          `preview en la misma dirección (0,3 s → 1,7 s)=${previewDirUp}`,
        { cxs, span, previewDirUp }
      );

      /* --- STORAGE-ROUNDTRIP-WITH-MEDIA ------------------------------- */
      try {
        await closeExportModalSafe(page);
      } catch {
        /* already closed */
      }
      let rtOk = false;
      let rtMsg = '';
      let rtDetail = {};
      const backupCapture = await setupDownloadCapture(browser, context, downloadDir);
      for (const name of fs.readdirSync(downloadDir)) {
        if (/\.hydra$/i.test(name)) fs.rmSync(path.join(downloadDir, name), { force: true });
      }
      // MediaBin (and its storage panel) only mounts while the "media" tab
      // of the sidebar is active.
      await safeEvaluate(page, () => {
        const tab = document.querySelector('#sidebar-tab-media');
        if (tab) tab.click();
      });
      let binMounted = false;
      for (let i = 0; i < 40 && !binMounted; i++) {
        binMounted = await safeEvaluate(page, () =>
          Boolean(document.querySelector('[data-testid="storage-panel-toggle"]'))
        );
        if (!binMounted) await delay(150);
      }
      if (!binMounted) {
        decide(
          'STORAGE-ROUNDTRIP-WITH-MEDIA',
          'La copia con medios se reimporta y los medios vuelven a reproducirse',
          false,
          'El panel de medios no se montó (la pestaña «Medios» no respondió).'
        );
        return { reloaded: navCount(page) !== navBefore, checks };
      }
      await safeEvaluate(page, () => {
        const btn = document.querySelector('[data-testid="storage-panel-toggle"]');
        if (btn) btn.click();
      });
      await delay(300);
      await safeEvaluate(page, () => {
        const btn = document.querySelector('[data-testid="storage-backup"]');
        if (btn) btn.click();
      });
      const hydra = await backupCapture.waitForFile({
        timeoutMs: 30_000,
        match: (n) => n.toLowerCase().endsWith('.hydra'),
        minBytes: 100,
      });
      if (!hydra) {
        rtMsg = 'La copia de seguridad no descargó ningún .hydra en 30 s.';
      } else {
        const nameOk = !/-sin-medios/i.test(hydra.name);
        const before = await safeEvaluate(page, () => {
          const store = window.__projectStore;
          if (!store) return null;
          return store.getState().project.mediaPool.map((m) => ({
            id: m.id,
            name: m.name,
            duration: m.duration,
            opfsPath: m.opfsPath || null,
          }));
        });
        // Delete every project media byte from OPFS (+ the IDB fallback).
        const wiped = await safeEvaluate(page, async () => {
          try {
            const store = window.__projectStore;
            if (!store) return { ok: false, reason: 'sin store' };
            const pool = store.getState().project.mediaPool;
            const names = pool.map((m) => m.opfsPath).filter(Boolean);
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle('media');
            const removed = [];
            for (const n of names) {
              try {
                await dir.removeEntry(n);
                removed.push(n);
              } catch {
                /* already gone */
              }
            }
            // IndexedDB fallback copies (`media_<name>` in keyval-store).
            try {
              const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open('keyval-store');
                req.onerror = () => reject(req.error);
                req.onsuccess = () => resolve(req.result);
              });
              try {
                if (db.objectStoreNames.contains('keyval')) {
                  await new Promise((resolve, reject) => {
                    const tx = db.transaction('keyval', 'readwrite');
                    for (const n of names) tx.objectStore('keyval').delete(`media_${n}`);
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                  });
                }
              } finally {
                db.close();
              }
            } catch {
              /* best effort */
            }
            return { ok: true, removed };
          } catch (err) {
            return { ok: false, reason: `${err && err.message}` };
          }
        });

        // Re-import the backup through the REAL file input of the modal.
        await clickButtonByText(page, 'Proyectos');
        await safeEvaluate(page, () => {
          const modal = document.querySelector('[data-testid="projects-modal"]');
          return Boolean(modal);
        });
        let importOk = false;
        let after = null;
        const input = await page.$('[data-testid="projects-modal"] input[type="file"]');
        if (input) {
          await input.uploadFile(hydra.filePath);
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            after = await safeEvaluate(page, async (prev) => {
              const store = window.__projectStore;
              if (!store) return null;
              const pool = store.getState().project.mediaPool;
              if (!pool || pool.length === 0) return null;
              const rows = [];
              for (const m of pool) {
                let loaded = false;
                let bytes = 0;
                try {
                  const res = await fetch(m.url);
                  loaded = res.ok;
                  if (res.ok) bytes = (await res.blob()).size;
                } catch {
                  loaded = false;
                }
                const want = (prev || []).find((p) => p.id === m.id);
                rows.push({
                  id: m.id,
                  urlOk: typeof m.url === 'string' && m.url.startsWith('blob:') && loaded,
                  bytes,
                  duration: m.duration,
                  durationOk: want ? m.duration === want.duration : null,
                  opfsPath: m.opfsPath || null,
                });
              }
              return rows;
            }, before);
            if (
              after && after.length > 0 &&
              after.every((r) => r.urlOk && r.durationOk && r.opfsPath)
            ) {
              importOk = true;
              break;
            }
            await delay(300);
          }
        }
        rtOk = Boolean(nameOk && wiped && wiped.ok && importOk);
        rtMsg =
          `copia "${hydra.name}" (${hydra.size} bytes): sin «-sin-medios»=${nameOk} | ` +
          `medios borrados de OPFS=${JSON.stringify(wiped && wiped.removed)} | ` +
          `tras reimportar: ${after ? after.map((r) => `${r.id}: blob=${r.urlOk} (${r.bytes} B), duración OK=${r.durationOk}`).join(' | ') : 'sin medios'}`;
        rtDetail = { file: hydra.name, size: hydra.size, before, wiped, after };
      }
      decide(
        'STORAGE-ROUNDTRIP-WITH-MEDIA',
        'La copia con medios se reimporta y los medios vuelven a reproducirse',
        rtOk,
        rtMsg,
        rtDetail
      );

      return { reloaded: navCount(page) !== navBefore, checks };
    } finally {
      await context.close();
    }
  }, {
    expected: [
      ...EXPORT_EXPECTED,
      { id: 'STORAGE-ROUNDTRIP-WITH-MEDIA', title: 'Round-trip con medios' },
    ],
  });

  for (const check of outcome.checks) {
    report.check(check.id, check.title, check.ok, check.message, check.details);
  }
}

async function closeExportModalSafe(page) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await safeEvaluate(
      page,
      () => {
        const dlg = document.querySelector('div[role="dialog"][aria-label="Exportar video"]');
        if (!dlg) return 'closed';
        const btn = document.querySelector('button[aria-label="Cerrar modal de exportación"]');
        if (!btn) return 'no-button';
        btn.click();
        return 'clicked';
      }
    );
    if (state === 'closed') return true;
    await delay(150);
  }
  return false;
}

/* ------------------------------------------------------------------ */

export async function run(ctx) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cut-recent-work-'));
  try {
    const assets = {
      indigo: solidBmp(SOLID_A).toString('base64'),
      pink: solidBmp(SOLID_B).toString('base64'),
      gradient: gradientBmp().toString('base64'),
      wav: sineWav().toString('base64'),
    };
    const live = await casePreview({ ...ctx, assets });
    await caseSupport({ ...ctx, live });
    await caseExportRoundtrip({ ...ctx, assets, workdir });
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}
