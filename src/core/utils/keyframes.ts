/**
 * F8 · Keyframes de transform de un clip — ÚNICA fuente de verdad.
 *
 * Un clip puede mover su posición, su escala y su opacidad a lo largo de su
 * duración (un clip que cruza la pantalla, un zoom progresivo, un fundido).
 * Los valores estáticos (`positionX/Y`, `scale`, `opacity`) no pueden
 * expresar eso: estos keyframes los interpolan en el tiempo dentro del clip.
 *
 * Quién usa este módulo (para que no diverjan, como ya pasó con la velocidad
 * F4, el crossfade F5 y los fundidos de audio):
 * - el preview y el export (`Compositor` → `evaluateSortedKeyframesInto`,
 *   evaluado por frame a través del MISMO `Compositor`),
 * - el store (`addKeyframe` / `updateKeyframe` → `normalizeKeyframesForWrite`,
 *   `clampKeyframeTime`, `clampKeyframeProps`),
 * - el Inspector (los deslizadores editan el keyframe seleccionado).
 *
 * Regla de interpolación: LINEAL por pista de propiedad independiente.
 * Cada propiedad (`x`, `y`, `scale`, `opacity`) tiene su propia pista: se
 * interpola linealmente entre los dos keyframes ADYACENTES DE ESA PISTA que
 * rodean el instante (los keyframes que no definen la propiedad no existen
 * para ella). Por tanto:
 * - sin keyframes → la transformación estática del clip (como hoy);
 * - antes del primer keyframe que define la propiedad → su valor;
 * - después del último que la define → su valor (se mantiene);
 * - entre dos que la definen → interpolación lineal;
 * - si NINGÚN keyframe la define → el valor estático del clip;
 * - un keyframe que no define la propiedad NUNCA aporta un extremo
 *   indefinido (no hay caídas a 0 ni NaN: los extremos siempre son valores
 *   definidos o el estático).
 *
 * Dónde vive cada invariante:
 * - Cuantización a frames, acotado de valores y de tiempos, orden y
 *   unicidad: SOLO en la escritura (`normalizeKeyframesForWrite`,
 *   `clampKeyframeTime`, `clampKeyframeProps`, con los fps reales del
 *   proyecto que aporta el store). El motor (60 Hz) NO recuantiza: trata los
 *   valores guardados como autoritativos.
 * - Camino caliente (`evaluateSortedKeyframesInto`): SOLO aritmética escalar
 *   sobre el array ordenado, cero asignaciones (contrato de
 *   `07-perf-resources`: el `Compositor` no asigna por frame; el array
 *   ordenado se reconstruye SOLO cuando cambia la referencia de
 *   `clip.keyframes`, ver `prepareSortedKeyframes`).
 * - Camino frío (`normalizeKeyframesForWrite`, `prepareSortedKeyframes`,
 *   `evaluateKeyframes`): puede asignar (una vez por edición, nunca por
 *   frame).
 */

import type { Clip, ClipKeyframe } from '../../types/project';
import { quantizeToFrame } from './time';

/** Transformación resuelta en un instante (listo para dibujar). */
export interface ResolvedKeyframeTransform {
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

/** Parche de propiedades de un keyframe (todas opcionales). */
export type KeyframePatch = Pick<ClipKeyframe, 'x' | 'y' | 'scale' | 'opacity'>;

/** Rango admitido para la escala de un keyframe (el mismo que el estático). */
export const KEYFRAME_SCALE_MIN = 0.1;
export const KEYFRAME_SCALE_MAX = 3;

/** Tolerancia (segundos) al comparar tiempos de keyframes. */
const KEYFRAME_EPSILON = 1e-6;

let prepareBuildCount = 0;

/** Cuántas veces se ha reconstruido el array ordenado (tests de perf). */
export function getKeyframePrepareCount(): number {
  return prepareBuildCount;
}

/** Reinicia el contador de reconstrucciones (tests de perf). */
export function resetKeyframePrepareCount(): void {
  prepareBuildCount = 0;
}

/** Duración (s) de un frame del proyecto; `fps` degenerados → 30. */
export function keyframeFrameDuration(fps: number): number {
  const safe = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return 1 / safe;
}

/**
 * Cuantiza un tiempo (relativo al clip) al frame más cercano del proyecto.
 * Un tiempo no útil (no finito o negativo) es el inicio del clip (0).
 */
export function quantizeKeyframeTime(t: number, fps: number): number {
  if (!Number.isFinite(t) || t < 0) return 0;
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return quantizeToFrame(t, safeFps);
}

/**
 * Recorta un tiempo de keyframe a `[0, clipDuration]` y lo cuantiza a frames.
 */
export function clampKeyframeTime(t: number, clipDuration: number, fps: number): number {
  const duration = Number.isFinite(clipDuration) && clipDuration > 0 ? clipDuration : 0;
  const quantized = quantizeKeyframeTime(t, fps);
  if (quantized < 0) return 0;
  if (quantized > duration) return duration;
  return quantized;
}

function clampFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Sanea las propiedades de un keyframe (camino frío: el store al escribir).
 *
 * Solo sobreviven las claves FINITAS; la escala se acota a
 * `[KEYFRAME_SCALE_MIN, KEYFRAME_SCALE_MAX]` (siempre > 0) y la opacidad a
 * `[0, 1]`. Devuelve `{}` cuando no hay nada aprovechable (el llamante debe
 * tratarlo como "sin cambios").
 */
export function clampKeyframeProps(props: KeyframePatch | undefined | null): KeyframePatch {
  const out: KeyframePatch = {};
  if (!props || typeof props !== 'object') return out;
  if (typeof props.x === 'number' && Number.isFinite(props.x)) out.x = props.x;
  if (typeof props.y === 'number' && Number.isFinite(props.y)) out.y = props.y;
  if (typeof props.scale === 'number' && Number.isFinite(props.scale)) {
    out.scale = Math.min(KEYFRAME_SCALE_MAX, Math.max(KEYFRAME_SCALE_MIN, props.scale));
  }
  if (typeof props.opacity === 'number' && Number.isFinite(props.opacity)) {
    out.opacity = Math.min(1, Math.max(0, props.opacity));
  }
  return out;
}

/** `true` cuando el parche define al menos una propiedad. */
export function hasKeyframeProps(props: KeyframePatch): boolean {
  return (
    props.x !== undefined || props.y !== undefined || props.scale !== undefined || props.opacity !== undefined
  );
}

/** `true` cuando el clip tiene al menos un keyframe. */
export function hasKeyframes(
  clip: Pick<Clip, 'keyframes'> | null | undefined
): boolean {
  return !!clip && Array.isArray(clip.keyframes) && clip.keyframes.length > 0;
}

/** Lo mínimo del clip que necesita la evaluación (el motor pasa el entero). */
export type KeyframedClip = Pick<
  Clip,
  'positionX' | 'positionY' | 'scale' | 'opacity' | 'keyframes'
>;

/**
 * Transformación estática del clip (sin interpolar): los valores de hoy.
 *
 * Pasa los valores SIN recortar (un clip heredado puede traer una escala
 * fuera de rango y hoy se dibuja tal cual): solo los no finitos vuelven al
 * defecto. Camino caliente: escribe en `out`, no asigna.
 */
export function staticTransformInto(
  clip: Pick<Clip, 'positionX' | 'positionY' | 'scale' | 'opacity'>,
  out: ResolvedKeyframeTransform
): ResolvedKeyframeTransform {
  out.x = clampFinite(clip.positionX, 0);
  out.y = clampFinite(clip.positionY, 0);
  out.scale = clampFinite(clip.scale, 1);
  out.opacity = clampFinite(clip.opacity, 1);
  return out;
}

/** Versión asignante de `staticTransformInto` (camino frío). */
export function staticTransformOf(
  clip: Pick<Clip, 'positionX' | 'positionY' | 'scale' | 'opacity'>
): ResolvedKeyframeTransform {
  return {
    x: clampFinite(clip.positionX, 0),
    y: clampFinite(clip.positionY, 0),
    scale: clampFinite(clip.scale, 1),
    opacity: clampFinite(clip.opacity, 1),
  };
}

/**
 * Ordena los keyframes por `t`, fusiona los duplicados (las propiedades del
 * posterior ganan) y descarta los que no definen nada.
 *
 * Es la normalización que el `Compositor` cachea: SOLO se llama cuando cambia
 * la referencia de `clip.keyframes` (nunca por frame). Camino frío.
 */
export function prepareSortedKeyframes(
  keyframes: readonly ClipKeyframe[]
): ClipKeyframe[] {
  prepareBuildCount += 1;
  const sorted = [...keyframes].sort((a, b) => a.t - b.t);
  const out: ClipKeyframe[] = [];
  for (const kf of sorted) {
    if (!kf || typeof kf.t !== 'number' || !Number.isFinite(kf.t)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - kf.t) <= KEYFRAME_EPSILON) {
      // Mismo instante: fusión por propiedad (el posterior gana).
      const merged: ClipKeyframe = { t: last.t };
      if (kf.x !== undefined || last.x !== undefined) merged.x = kf.x !== undefined ? kf.x : last.x;
      if (kf.y !== undefined || last.y !== undefined) merged.y = kf.y !== undefined ? kf.y : last.y;
      if (kf.scale !== undefined || last.scale !== undefined) {
        merged.scale = kf.scale !== undefined ? kf.scale : last.scale;
      }
      if (kf.opacity !== undefined || last.opacity !== undefined) {
        merged.opacity = kf.opacity !== undefined ? kf.opacity : last.opacity;
      }
      out[out.length - 1] = merged;
      continue;
    }
    const clean: ClipKeyframe = { t: kf.t };
    if (kf.x !== undefined) clean.x = kf.x;
    if (kf.y !== undefined) clean.y = kf.y;
    if (kf.scale !== undefined) clean.scale = kf.scale;
    if (kf.opacity !== undefined) clean.opacity = kf.opacity;
    if (!hasKeyframeProps(clean)) continue;
    out.push(clean);
  }
  return out;
}

/**
 * Normaliza los keyframes para guardarlos en el store (camino frío).
 *
 * - Cada `t` se recorta a `[0, clipDuration]` y se cuantiza a frames;
 * - cada propiedad se acota (`clampKeyframeProps`);
 * - los duplicados del mismo instante se fusionan (el posterior gana);
 * - el resultado sale ordenado por `t`.
 *
 * Devuelve `undefined` cuando no queda ningún keyframe útil (el llamante
 * debe guardar "sin keyframes", no un array vacío).
 */
export function normalizeKeyframesForWrite(
  raw: readonly ClipKeyframe[] | undefined,
  fps: number,
  clipDuration: number
): ClipKeyframe[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const duration = Number.isFinite(clipDuration) && clipDuration > 0 ? clipDuration : 0;
  if (duration <= 0) return undefined;
  const cleaned: ClipKeyframe[] = [];
  for (const kf of raw) {
    if (!kf || typeof kf !== 'object') continue;
    const props = clampKeyframeProps(kf);
    if (!hasKeyframeProps(props)) continue;
    cleaned.push({ ...props, t: clampKeyframeTime(kf.t, duration, fps) });
  }
  if (cleaned.length === 0) return undefined;
  const sorted = prepareSortedKeyframes(cleaned);
  return sorted.length > 0 ? sorted : undefined;
}

type KeyframeProp = 'x' | 'y' | 'scale' | 'opacity';

/** Las cuatro pistas de propiedad (a nivel de módulo: iterar no asigna). */
const KEYFRAME_PROPS: ReadonlyArray<KeyframeProp> = ['x', 'y', 'scale', 'opacity'];

/**
 * Interpolación lineal de una pista entre sus definidores adyacentes.
 *
 * Camino caliente: SOLO aritmética escalar, cero asignaciones. `sorted` debe
 * venir de `prepareSortedKeyframes` (ordenado, sin duplicados). `fallback`
 * aporta el valor estático cuando ningún keyframe define la propiedad; puede
 * ser el MISMO objeto que `out` (cada propiedad se lee antes de escribirse).
 */
export function evaluateSortedKeyframesInto(
  sorted: readonly ClipKeyframe[],
  fallback: ResolvedKeyframeTransform,
  localTime: number,
  out: ResolvedKeyframeTransform
): ResolvedKeyframeTransform {
  const t = Number.isFinite(localTime) ? localTime : 0;
  for (const prop of KEYFRAME_PROPS) {
    let hasPrev = false;
    let prevT = 0;
    let prevV = 0;
    let hasNext = false;
    let nextT = 0;
    let nextV = 0;
    for (let i = 0; i < sorted.length; i++) {
      const v = sorted[i][prop];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const kt = sorted[i].t;
      if (kt <= t && (!hasPrev || kt >= prevT)) {
        hasPrev = true;
        prevT = kt;
        prevV = v;
      }
      if (kt >= t && (!hasNext || kt <= nextT)) {
        hasNext = true;
        nextT = kt;
        nextV = v;
      }
    }
    if (hasPrev && hasNext) {
      out[prop] =
        nextT > prevT ? prevV + ((nextV - prevV) * (t - prevT)) / (nextT - prevT) : prevV;
    } else if (hasPrev) {
      out[prop] = prevV;
    } else if (hasNext) {
      out[prop] = nextV;
    } else {
      out[prop] = fallback[prop];
    }
  }
  return out;
}

/**
 * Evalúa los keyframes de un clip en `localTime` (segundos relativos a su
 * inicio) escribiendo en `out` (cero asignaciones más allá de `out`).
 *
 * Sin keyframes → la transformación estática (el comportamiento de hoy).
 * Esta entrada tolera arrays sin ordenar (los ordena en una copia): es para
 * el camino frío (store, Inspector). El camino caliente del `Compositor` usa
 * `evaluateSortedKeyframesInto` con el array cacheado.
 */
export function evaluateKeyframesInto(
  clip: KeyframedClip,
  localTime: number,
  out: ResolvedKeyframeTransform
): ResolvedKeyframeTransform {
  staticTransformInto(clip, out);
  if (!hasKeyframes(clip)) return out;
  const sorted = prepareSortedKeyframes(clip.keyframes!);
  if (sorted.length === 0) return out;
  return evaluateSortedKeyframesInto(sorted, out, localTime, out);
}

/** Versión asignante de `evaluateKeyframesInto` (camino frío: tests, UI). */
export function evaluateKeyframes(
  clip: KeyframedClip,
  localTime: number
): ResolvedKeyframeTransform {
  return evaluateKeyframesInto(clip, localTime, { x: 0, y: 0, scale: 1, opacity: 1 });
}

/* ------------------------------------------------------------------ */
/* Reescrituras por trim / split (camino frío: el store al editar)     */
/* ------------------------------------------------------------------ */

/**
 * Desplaza los keyframes cuando se recorta el INICIO del clip (`trim start`).
 *
 * El `t` es relativo al inicio: al mover el inicio `deltaSeconds` hacia
 * delante, cada keyframe se mueve `t - delta` (cuantizado) y los que quedan
 * fuera de `[0, newDuration]` se descartan (su material ya no existe).
 * Devuelve `undefined` si no sobrevive ninguno.
 */
export function shiftKeyframesAfterTrimStart(
  keyframes: readonly ClipKeyframe[],
  deltaSeconds: number,
  newDuration: number,
  fps: number
): ClipKeyframe[] | undefined {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return undefined;
  const delta = Number.isFinite(deltaSeconds) ? deltaSeconds : 0;
  const shifted: ClipKeyframe[] = [];
  for (const kf of keyframes) {
    if (!kf || typeof kf.t !== 'number' || !Number.isFinite(kf.t)) continue;
    const t = quantizeKeyframeTime(kf.t - delta, fps);
    if (t < 0 || t > newDuration + KEYFRAME_EPSILON) continue;
    const clean: ClipKeyframe = { ...kf, t: Math.min(t, newDuration) };
    if (!hasKeyframeProps(clean)) continue;
    shifted.push(clean);
  }
  if (shifted.length === 0) return undefined;
  const sorted = prepareSortedKeyframes(shifted);
  return sorted.length > 0 ? sorted : undefined;
}

/**
 * Descarta los keyframes que quedan más allá de `newDuration` al recortar el
 * FINAL del clip. Devuelve `undefined` si no sobrevive ninguno.
 */
export function cropKeyframesToDuration(
  keyframes: readonly ClipKeyframe[],
  newDuration: number
): ClipKeyframe[] | undefined {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return undefined;
  const kept = keyframes.filter(
    (kf) => kf && typeof kf.t === 'number' && Number.isFinite(kf.t) && kf.t <= newDuration + KEYFRAME_EPSILON
  );
  if (kept.length === 0) return undefined;
  if (kept.length === keyframes.length) return [...keyframes];
  return kept;
}

/**
 * Reparte los keyframes al partir un clip en `cutLocal` (relativo al inicio).
 *
 * La primera mitad conserva los `t < cutLocal`; la segunda conserva los
 * `t >= cutLocal` desplazados `-cutLocal` (cuantizados). Devuelve
 * `[primera, segunda]` (`undefined` = esa mitad no hereda ninguno).
 */
export function splitKeyframesAt(
  keyframes: readonly ClipKeyframe[],
  cutLocal: number,
  fps: number
): [ClipKeyframe[] | undefined, ClipKeyframe[] | undefined] {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return [undefined, undefined];
  const cut = Number.isFinite(cutLocal) ? cutLocal : 0;
  const first: ClipKeyframe[] = [];
  const second: ClipKeyframe[] = [];
  for (const kf of keyframes) {
    if (!kf || typeof kf.t !== 'number' || !Number.isFinite(kf.t)) continue;
    if (kf.t < cut - KEYFRAME_EPSILON) {
      if (hasKeyframeProps(kf)) first.push({ ...kf });
    } else {
      const t = quantizeKeyframeTime(kf.t - cut, fps);
      if (hasKeyframeProps(kf)) second.push({ ...kf, t });
    }
  }
  return [
    first.length > 0 ? first : undefined,
    second.length > 0 ? second : undefined,
  ];
}
