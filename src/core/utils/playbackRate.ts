/**
 * F4 — Única fuente de verdad de la velocidad y del tono (pitch).
 *
 * Antes de este módulo la semántica de velocidad estaba triplicada:
 *  - el preview (`MediaSourcePool` / `AudioEngine`) escribía `playbackRate` en
 *    el elemento y además forzaba `preservesPitch = false` (chipmunk a 2x),
 *  - el export (`webcodecsExporter`) usaba `AudioBufferSourceNode.playbackRate`
 *    sin ninguna compensación de tono,
 *  - y el store/`Compositor` usaban el `speed` crudo sin acotar.
 *
 * Consecuencia: el preview y el MP4 exportado no coincidían ni en duración
 * ni en altura de tono, y el usuario no tenía ninguna forma de arreglarlo.
 *
 * `resolvePlayback()` es el contrato compartido por las TRES rutas:
 *
 *  - `rate`         → la velocidad efectiva (`playbackRate`).
 *  - `preservesPitch` → si el tono debe mantenerse en el tono original.
 *  - `detuneCents`  → la compensación en cents que cancela el desplazamiento
 *                     de tono que provoca `playbackRate` (0 si no se preserva).
 *
 * Razón de la fórmula: `AudioBufferSourceNode.playbackRate` multiplica la
 * frecuencia por `rate`. La nota musical `x` vale `1200 * log2(x)` cents, así
 * que sumar `detune = -1200 * log2(rate)` cancela EXACTAMENTE esa
 * multiplicación: el tempo cambia y el tono se queda igual. No es una
 * aproximación, es la compensación estándar (resample + detune).
 *
 * El preview usa la variante nativa del navegador (`preservesPitch`), que es
 * la misma idea pero con time-stretching de alta calidad: el resultado audible
 * coincide (mismo tono, mismo tempo) aunque el timbre no sea idéntico.
 */

/**
 * Límite inferior de `playbackRate`.
 * Chrome/Safari recortan por debajo de 0.0625 (E-19).
 */
export const MIN_PLAYBACK_RATE = 0.0625;

/**
 * Límite superior de `playbackRate` del editor (4x).
 * El Inspector solo ofrece 0.25x–4x; acotar aquí evita que un proyecto
 * importado a mano (el almacenamiento admite hasta 10) desincronice el
 * preview y el export.
 */
export const MAX_PLAYBACK_RATE = 4;

/**
 * Política de tono por defecto: PRESERVAR el tono.
 *
 * Es el comportamiento sensato de un editor de vídeo (una voz acelerada no
 * debe sonar como un chipmunk) y el que aplican las tres rutas de
 * reproducción hasta que el clip diga lo contrario.
 */
export const DEFAULT_PRESERVE_PITCH = true;

/** Datos de clip relevantes para la reproducción (no necesita el Clip entero). */
export interface PlaybackOptions {
  /** Factor de velocidad (`clip.speed`). */
  speed?: number;
  /** Si el tono debe conservarse. Por defecto SÍ (ver `resolvePlayback`). */
  preservePitch?: boolean;
}

/** Resultado de `resolvePlayback`: lo que cada ruta de reproducción aplica. */
export interface ResolvedPlayback {
  /** Velocidad efectiva (siempre dentro de [0.0625, 4]). */
  rate: number;
  /** Si el tono se preserva. */
  preservesPitch: boolean;
  /** Compensación de tono en cents (0 cuando no se preserva el tono). */
  detuneCents: number;
}

/**
 * Camino rápido del caso común (`speed === 1` con tono preservado, que es lo
 * que tiene la inmensa mayoría de los clips).
 *
 * Es UNA constante congelada y compartida: los llamantes del camino caliente
 * (60 Hz) solo la LEEN, nunca la mutan, así que no hay nada que asignar por
 * frame (~40–50 objetos/frame menos con 20 clips). No mutar el resultado de
 * `resolvePlayback()`.
 */
const DEFAULT_RESOLVED_PLAYBACK: ResolvedPlayback = Object.freeze({
  rate: 1,
  preservesPitch: true,
  detuneCents: 0,
});

/**
 * Resuelve la velocidad y la política de tono de un clip.
 *
 * - `rate = clamp(speed, 0.0625, 4)`.
 * - `preservesPitch` es `true` por defecto: preservar el tono es el
 *   comportamiento sensato de un editor de vídeo (una voz acelerada no debe
 *   sonar como un chipmunk). Solo se desactiva si el usuario lo pide
 *   explícitamente (`preservePitch: false`).
 * - `detuneCents = -1200 * log2(rate)` cuando se preserva el tono, 0 si no.
 *
 * Nota sobre velocidades degeneradas: un `speed` nulo, negativo o no finito se
 * trata como 1x (la convención que ya usa el resto del editor: la duración del
 * clip, el `sourceStart` y el recorte se calculan con `speed > 0 ? speed : 1`).
 * Sin esa guarda, un `speed = 0` congelaría el preview y lo dejaría sin
 * coherencia con la duración del clip.
 */
export function resolvePlayback(clip?: PlaybackOptions | null): ResolvedPlayback {
  // Camino rápido sin asignaciones: el caso común (sin clip, velocidad
  // ausente/degenerada/1x con tono preservado) es la constante compartida.
  if (clip == null) return DEFAULT_RESOLVED_PLAYBACK;
  const raw = clip.speed;
  if ((raw === undefined || raw === 1) && clip.preservePitch !== false) {
    return DEFAULT_RESOLVED_PLAYBACK;
  }
  const speed =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1;
  if (speed === 1 && clip.preservePitch !== false) return DEFAULT_RESOLVED_PLAYBACK;
  const rate = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, speed));
  const preservesPitch = clip.preservePitch !== false;
  // `-1200 * log2(1)` es `-0`: se normaliza a `0` para que la compensación de
  // una reproducción normal sea exactamente cero.
  const cents = -1200 * Math.log2(rate);
  const detuneCents = preservesPitch ? (cents === 0 ? 0 : cents) : 0;
  return { rate, preservesPitch, detuneCents };
}

/**
 * Factor de tono efectivo que produce una reproducción.
 *
 * `rate * 2^(detuneCents / 1200)`:
 *  - 1 → el tono es el del original (velocidad con tono preservado),
 *  - `rate` → el tono se desplaza con la velocidad (chipmunk a 2x).
 *
 * Sirve para comprobar numéricamente que el preview y el export coinciden.
 */
export function pitchFactorOf(playback: ResolvedPlayback): number {
  return playback.rate * Math.pow(2, playback.detuneCents / 1200);
}

/**
 * Escribe la política de tono en un elemento de medios.
 *
 * Usa la propiedad estándar `preservesPitch` y, cuando existen, las variantes
 * con prefijo histórico (`mozPreservesPitch` en Firefox antiguo,
 * `webkitPreservesPitch` en WebKit antiguo).
 */
export function applyPitchPolicyToElement(
  el: HTMLMediaElement | null | undefined,
  preservesPitch: boolean
): void {
  if (!el) return;
  try {
    el.preservesPitch = preservesPitch;
  } catch {
    // No soportado por este motor.
  }
  const legacy = el as unknown as {
    mozPreservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  try {
    if ('mozPreservesPitch' in legacy) legacy.mozPreservesPitch = preservesPitch;
    if ('webkitPreservesPitch' in legacy) legacy.webkitPreservesPitch = preservesPitch;
  } catch {
    // Ignorado: la variante con prefijo no es escribible.
  }
}

/**
 * Escribe la compensación de tono en un `AudioParam` (`detune`).
 *
 * Debe llamarse ANTES de `start()`: un `AudioBufferSourceNode` toma el valor
 * del `AudioParam` en el momento de arrancar.
 */
export function applyDetuneToParam(
  param: AudioParam | null | undefined,
  detuneCents: number
): void {
  if (!param) return;
  try {
    param.setValueAtTime(detuneCents, 0);
  } catch {
    try {
      param.value = detuneCents;
    } catch {
      // Ignorado: el motor no permite automatizar el param.
    }
  }
  try {
    // `setValueAtTime` programa el valor; `.value` fija el valor intrínseco.
    // Ambos se escriben para que el nodo use la compensación aunque el motor
    // no implemente la automatización.
    param.value = detuneCents;
  } catch {
    // Ignorado.
  }
}
