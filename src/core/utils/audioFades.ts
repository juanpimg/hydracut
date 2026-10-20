/**
 * Fundidos de audio por clip (fade in / fade out) — ÚNICA fuente de verdad.
 *
 * Un clip puede subir y bajar de volumen a lo largo de su duración (una música
 * que entra al inicio y sale al final, una voz que emerge tras la intro). El
 * volumen constante por clip (`clip.volume`) no puede expresar eso: estos
 * fundidos multiplican la ganancia con una envolvente 0..1 evaluada en el
 * tiempo dentro del clip.
 *
 * Quién usa este módulo (para que no diverjan, como ya pasó con la velocidad
 * F4 y con el crossfade F5):
 * - el preview (`AudioEngine` → `previewClipFadeGain`, evaluado por frame),
 * - el export (`webcodecsExporter` → `buildAudioFadeAutomation`, programado
 *   en el `GainNode` offline dedicado a los fundidos),
 * - el store (`updateClip` / `setAudioFade` → `clampClipAudioFades`),
 * - el Inspector (dura­ciones + curvas + constantes por defecto).
 *
 * Curvas (ecuaciones):
 * - `linear`:     rampa simple. Entrada `g(p) = p`, salida `g(p) = 1 - p`.
 * - `equalPower` (POR DEFECTO): `g(p) = sin(p · π/2)` en la entrada y su
 *   espejo en la salida (`sin((1-p) · π/2) = cos(p · π/2)`). La POTENCIA se
 *   mantiene constante a lo largo de la rampa (`sin² + cos² = 1`): no hay el
 *   bache de sonoridad del fundido lineal en el punto medio (el lineal cae a
 *   0.5 de ganancia = 0.25 de potencia, −6 dB). Es la curva sensata para un
 *   fundido musical y la que usan los NLE por defecto; `linear` queda como la
 *   rampa simple y predecible.
 *   En ambas, `p` es el progreso recortado a [0, 1] dentro de la región.
 *
 * Dónde vive cada invariante:
 * - Cuantización a frames y recorte a la duración del clip: SOLO en la
 *   escritura (`clampAudioFadeDuration` / `clampClipAudioFades`, con los fps
 *   reales del proyecto que aporta el store). El motor (60 Hz) y el export
 *   NO recuantizan: tratan los valores guardados como autoritativos y solo
 *   los recortan (`min`) y reescalan si `in + out` supera la duración (un
 *   trim puede acortar el clip por debajo del fundido guardado). Así el
 *   preview y el export acuerdan la envolvente bit a bit sin necesitar los
 *   fps en el camino caliente.
 * - Camino caliente (`audioFadeEnvelopeGain`, `previewClipFadeGain`): SOLO
 *   aritmética escalar, cero asignaciones (contrato de `07-perf-resources`:
 *   `updateAudio` no asigna `Map`s ni objetos por frame; ver el test de cero
 *   asignaciones de las suites de playback).
 * - Camino frío (`buildAudioFadeAutomation`, `clampClipAudioFades`): puede
 *   asignar (una vez por edición / por export, nunca por frame).
 */

import type { AudioFade, AudioFadeCurve, Clip } from '../../types/project';
import { quantizeToFrame } from './time';

/** Curva aplicada cuando el clip no declara ninguna (`curve` ausente). */
export const DEFAULT_AUDIO_FADE_CURVE: AudioFadeCurve = 'equalPower';

/** Duración ofrecida al crear un fundido desde la UI (segundos). */
export const AUDIO_FADE_DEFAULT_DURATION = 0.5;

/**
 * Segmentos lineales por región de fundido en la automatización del export.
 *
 * La envolvente `equalPower` es curva, pero el `GainNode` offline solo recibe
 * `setValueAtTime` / `linearRampToValueAtTime` (compatibles con todos los
 * motores y con los dobles de test): con 64 segmentos el error de la
 * aproximación lineal queda por debajo de 1e-4 (−80 dB, inaudible e
 * invisible en el acuerdo preview/export). La curva `linear` es exacta con
 * cualquier número de segmentos (colineales).
 */
export const AUDIO_FADE_AUTOMATION_SEGMENTS = 64;

function clamp01(p: number): number {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/** Duración (s) de un frame del proyecto; `fps` degenerados → 30. */
export function audioFadeFrameDuration(fps: number): number {
  const safe = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return 1 / safe;
}

/**
 * Normaliza una curva declarada: `'linear'` se respeta, todo lo demás
 * (`undefined`, basura de un proyecto importado a mano) es el defecto.
 * Sin asignaciones: seguro en el camino caliente.
 */
export function normalizeAudioFadeCurve(curve: AudioFadeCurve | undefined): AudioFadeCurve {
  return curve === 'linear' ? 'linear' : DEFAULT_AUDIO_FADE_CURVE;
}

/**
 * Ganancia de la curva para un progreso `p` en [0, 1] (0 = silencio, 1 = nivel).
 * - `linear`:     `p`
 * - `equalPower`: `sin(p · π/2)` (a `p = 0.5` vale √2/2 ≈ 0.7071: la potencia
 *   es 0.5, la mitad, sin bache).
 * Sirve para la entrada; la salida usa el progreso espejado (`1 - p`), que es
 * exactamente `cos(p · π/2)` en potencia igual. Sin asignaciones.
 */
export function audioFadeCurveGain(progress: number, curve: AudioFadeCurve): number {
  const p = clamp01(progress);
  if (curve === 'linear') return p;
  return Math.sin((p * Math.PI) / 2);
}

/** Sanea una duración guardada: finita y > 0, si no 0 (= sin fundido). */
function sanitizedFadeDuration(duration: unknown): number {
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/**
 * Factor de reescala cuando `in + out` supera la duración del clip.
 * Ambas regiones se encogen proporcionalmente (la misma regla que los
 * fundidos de borde del exportador): el fundido nunca pisa fuera del clip.
 * Escalar puro, sin asignaciones.
 */
export function fadeDurationScale(
  fadeInDuration: number,
  fadeOutDuration: number,
  clipDuration: number
): number {
  const total = fadeInDuration + fadeOutDuration;
  if (!(total > 0) || !Number.isFinite(clipDuration) || clipDuration <= 0) return 1;
  if (total <= clipDuration) return 1;
  return clipDuration / total;
}

/**
 * Envolvente del fundido en `timeInClip` segundos dentro del clip (0 = su
 * inicio). Devuelve el multiplicador 0..1 que se aplica a la ganancia.
 *
 * Camino caliente: SOLO aritmética escalar (sin objetos, sin arrays, sin
 * clausuras). Las duraciones de entrada ya vienen saneadas por el llamante;
 * aquí solo se recortan al clip y se reescalan si suman más que él.
 */
export function audioFadeEnvelopeGain(
  timeInClip: number,
  clipDuration: number,
  fadeInDuration: number,
  fadeInCurve: AudioFadeCurve,
  fadeOutDuration: number,
  fadeOutCurve: AudioFadeCurve
): number {
  if (!Number.isFinite(timeInClip) || !Number.isFinite(clipDuration) || clipDuration <= 0) return 1;
  if (timeInClip < 0 || timeInClip > clipDuration) return 1;
  const rawIn = sanitizedFadeDuration(fadeInDuration);
  const rawOut = sanitizedFadeDuration(fadeOutDuration);
  if (rawIn <= 0 && rawOut <= 0) return 1;

  const scale = fadeDurationScale(
    Math.min(rawIn, clipDuration),
    Math.min(rawOut, clipDuration),
    clipDuration
  );
  const effectiveIn = Math.min(rawIn, clipDuration) * scale;
  const effectiveOut = Math.min(rawOut, clipDuration) * scale;

  let multiplier = 1;
  if (effectiveIn > 0 && timeInClip < effectiveIn) {
    multiplier *= audioFadeCurveGain(timeInClip / effectiveIn, fadeInCurve);
  }
  if (effectiveOut > 0 && timeInClip > clipDuration - effectiveOut) {
    multiplier *= audioFadeCurveGain(
      (clipDuration - timeInClip) / effectiveOut,
      fadeOutCurve
    );
  }
  return Math.max(0, multiplier);
}

/** Lo mínimo del clip que necesita la envolvente (el motor pasa el clip entero). */
export type FadedClip = Pick<Clip, 'start' | 'duration' | 'audioFadeIn' | 'audioFadeOut'>;

/**
 * Ganancia del fundido de un clip en un tiempo ABSOLUTO de timeline.
 * Es lo que el `AudioEngine` evalúa por frame: delega en
 * `audioFadeEnvelopeGain` sin asignar nada. Los tests la comparan con la
 * envolvente del export en los mismos instantes (acuerdo preview/export).
 */
export function previewClipFadeGain(clip: FadedClip, time: number): number {
  const fadeIn = clip.audioFadeIn;
  const fadeOut = clip.audioFadeOut;
  const inDuration = fadeIn ? sanitizedFadeDuration(fadeIn.duration) : 0;
  const outDuration = fadeOut ? sanitizedFadeDuration(fadeOut.duration) : 0;
  if (inDuration <= 0 && outDuration <= 0) return 1;
  return audioFadeEnvelopeGain(
    time - clip.start,
    clip.duration,
    inDuration,
    normalizeAudioFadeCurve(fadeIn?.curve),
    outDuration,
    normalizeAudioFadeCurve(fadeOut?.curve)
  );
}

/* ------------------------------------------------------------------ */
/* Escritura: cuantización a frames y recorte (el store, camino frío)  */
/* ------------------------------------------------------------------ */

/**
 * Cuantiza una duración pedida al frame más cercano del proyecto.
 * Devuelve 0 cuando no es una duración útil (no finita, ≤ 0, o menor que
 * medio frame: el llamante debe tratarlo como "sin fundido").
 */
export function quantizeAudioFadeDuration(duration: number, fps: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const quantized = quantizeToFrame(duration, safeFps);
  if (quantized < 1 / safeFps / 2) return 0;
  return quantized;
}

/**
 * Cuantiza una duración pedida a frames y la recorta a la duración del clip.
 * Un fundido no puede ser más largo que su clip. Devuelve 0 cuando no cabe
 * ni un frame (el llamante debe rechazarlo con un motivo).
 */
export function clampAudioFadeDuration(
  requested: number,
  clipDuration: number,
  fps: number
): number {
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  if (!Number.isFinite(clipDuration) || clipDuration <= 0) return 0;
  const quantized = quantizeAudioFadeDuration(Math.min(requested, clipDuration), fps);
  return Math.min(quantized, clipDuration);
}

/** Resultado de recortar los fundidos de un clip a su duración. */
export interface ClampedClipAudioFades {
  /** Fundido de entrada efectivo (`undefined` = sin fundido). */
  fadeIn?: AudioFade;
  /** Fundido de salida efectivo (`undefined` = sin fundido). */
  fadeOut?: AudioFade;
  /** `true` cuando algo se recortó, se descartó o se corrigió. */
  clamped: boolean;
  /** Motivo en español listo para mostrar (`null` si no se tocó nada). */
  reason: string | null;
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0,00 s';
  return `${seconds.toFixed(2).replace('.', ',')} s`;
}

/**
 * Recorta los fundidos pedidos a lo que el clip admite (camino frío: el
 * store lo llama al editar, nunca por frame).
 *
 * - Cada duración se cuantiza al frame del proyecto y se recorta a la
 *   duración del clip.
 * - Si `in + out` supera el clip, ambas se encogen proporcionalmente.
 * - Una duración no útil (≤ 0, no finita) elimina ese fundido; `undefined`
 *   de entrada sigue siendo `undefined` (limpiar no es recortar).
 * - Una curva desconocida vuelve al defecto (`equalPower`).
 */
export function clampClipAudioFades(
  fadeIn: AudioFade | undefined,
  fadeOut: AudioFade | undefined,
  clipDuration: number,
  fps: number
): ClampedClipAudioFades {
  const reasons: string[] = [];

  const sanitizeOne = (
    fade: AudioFade | undefined,
    label: string
  ): { duration: number; curve: AudioFadeCurve } | undefined => {
    if (fade === undefined) return undefined;
    const raw = fade.duration;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      reasons.push(
        `El fundido de ${label} no es una duración válida y se ha eliminado.`
      );
      return undefined;
    }
    const clampedDuration = clampAudioFadeDuration(raw, clipDuration, fps);
    if (clampedDuration <= 0) {
      reasons.push(
        `El fundido de ${label} (${formatSeconds(raw)}) no cabe en el clip ` +
          `(${formatSeconds(clipDuration)}): se ha eliminado.`
      );
      return undefined;
    }
    if (clampedDuration < raw) {
      reasons.push(
        `El fundido de ${label} (${formatSeconds(raw)}) supera la duración del clip ` +
          `(${formatSeconds(clipDuration)}): se ha recortado a ${formatSeconds(clampedDuration)}.`
      );
    }
    const curve = normalizeAudioFadeCurve(fade.curve);
    if (fade.curve !== undefined && fade.curve !== curve) {
      reasons.push(
        `La curva del fundido de ${label} no es válida y se ha usado la curva por defecto (potencia igual).`
      );
    }
    return { duration: clampedDuration, curve };
  };

  let nextIn = sanitizeOne(fadeIn, 'entrada');
  let nextOut = sanitizeOne(fadeOut, 'salida');

  // Ambas regiones juntas no pueden superar el clip: se encogen en proporción
  // (la misma regla que los fundidos de borde del exportador).
  if (nextIn && nextOut && clipDuration > 0) {
    const total = nextIn.duration + nextOut.duration;
    if (total > clipDuration) {
      const scale = clipDuration / total;
      const scaledIn = quantizeAudioFadeDuration(nextIn.duration * scale, fps);
      const scaledOut = quantizeAudioFadeDuration(nextOut.duration * scale, fps);
      nextIn = scaledIn > 0 ? { duration: scaledIn, curve: nextIn.curve } : undefined;
      nextOut = scaledOut > 0 ? { duration: scaledOut, curve: nextOut.curve } : undefined;
      reasons.push(
        `Los fundidos de entrada y salida juntos (${formatSeconds(total)}) superan la duración ` +
          `del clip (${formatSeconds(clipDuration)}): se han encogido en proporción.`
      );
    }
  }

  const result: ClampedClipAudioFades = {
    clamped: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join(' ') : null,
  };
  if (nextIn !== undefined) result.fadeIn = nextIn;
  if (nextOut !== undefined) result.fadeOut = nextOut;
  return result;
}

/* ------------------------------------------------------------------ */
/* Export: automatización del GainNode offline (camino frío)           */
/* ------------------------------------------------------------------ */

/** Un evento de automatización de la envolvente (tiempos absolutos). */
export interface AudioFadeGainEvent {
  type: 'set' | 'linearRamp';
  /** Tiempo absoluto (segundos de timeline). */
  time: number;
  /** Multiplicador 0..1 de la envolvente (SIN el volumen del clip). */
  value: number;
}

/**
 * Automatización de la envolvente de fundidos de UN clip para el export.
 *
 * Muestrea `audioFadeEnvelopeGain` — LA MISMA función que evalúa el preview
 * por frame — en los bordes de `AUDIO_FADE_AUTOMATION_SEGMENTS` segmentos por
 * región, así que la envolvente programada en el `GainNode` offline y la del
 * preview acuerdan en todo instante (el test de acuerdo lo comprueba
 * barriendo el clip).
 *
 * Devuelve `[]` cuando el clip no tiene ningún fundido efectivo: el llamante
 * mantiene entonces el camino histórico (un solo `GainNode` con su
 * automatización de siempre), de modo que un export SIN fundidos se comporta
 * exactamente igual que hoy.
 */
export function buildAudioFadeAutomation(
  clip: Pick<
    Clip,
    'start' | 'duration' | 'volume' | 'audioFadeIn' | 'audioFadeOut'
  >
): AudioFadeGainEvent[] {
  const duration = clip.duration;
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const rawIn = clip.audioFadeIn ? sanitizedFadeDuration(clip.audioFadeIn.duration) : 0;
  const rawOut = clip.audioFadeOut ? sanitizedFadeDuration(clip.audioFadeOut.duration) : 0;
  if (rawIn <= 0 && rawOut <= 0) return [];
  // Las MISMAS cuatro líneas que `audioFadeEnvelopeGain` (ver ese comentario):
  // recorte al clip + reescala proporcional, SIN recuantizar (los valores
  // guardados ya vienen en frames del proyecto desde el store).
  const scale = fadeDurationScale(
    Math.min(rawIn, duration),
    Math.min(rawOut, duration),
    duration
  );
  const effectiveIn = Math.min(rawIn, duration) * scale;
  const effectiveOut = Math.min(rawOut, duration) * scale;
  if (effectiveIn <= 0 && effectiveOut <= 0) return [];

  const inCurve = normalizeAudioFadeCurve(clip.audioFadeIn?.curve);
  const outCurve = normalizeAudioFadeCurve(clip.audioFadeOut?.curve);
  const start = clip.start;
  const sample = (timeInClip: number): number =>
    audioFadeEnvelopeGain(timeInClip, duration, rawIn, inCurve, rawOut, outCurve);

  const events: AudioFadeGainEvent[] = [];
  events.push({ type: 'set', time: start, value: sample(0) });

  let regionEnd = start;
  if (effectiveIn > 0) {
    const inEnd = start + effectiveIn;
    for (let i = 1; i <= AUDIO_FADE_AUTOMATION_SEGMENTS; i++) {
      const t = start + (effectiveIn * i) / AUDIO_FADE_AUTOMATION_SEGMENTS;
      events.push({ type: 'linearRamp', time: t, value: sample(t - start) });
    }
    regionEnd = inEnd;
  }

  if (effectiveOut > 0) {
    const outStart = start + duration - effectiveOut;
    if (outStart > regionEnd) {
      events.push({ type: 'set', time: outStart, value: 1 });
    }
    for (let i = 1; i <= AUDIO_FADE_AUTOMATION_SEGMENTS; i++) {
      const t = outStart + (effectiveOut * i) / AUDIO_FADE_AUTOMATION_SEGMENTS;
      events.push({ type: 'linearRamp', time: t, value: sample(t - start) });
    }
  }

  return events;
}
