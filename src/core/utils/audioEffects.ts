/**
 * Efectos de audio por clip (paneo / EQ de 3 bandas / ducking) — ÚNICA fuente
 * de verdad.
 *
 * Quién usa este módulo (para que no diverjan, como ya pasó con la velocidad
 * F4, el crossfade F5 y los fundidos de audio):
 * - el preview (`AudioEngine` → `resolveClipAudioChain` + `duckEnvelopeGain`,
 *   evaluados por frame),
 * - el export (`webcodecsExporter` → `resolveClipAudioChain` +
 *   `buildDuckAutomation`, programados en los nodos offline),
 * - el store (`updateClip` → `normalizeAudioEffects`),
 * - el Inspector (rangos, constantes y mensajes).
 *
 * Camino caliente (`resolvePan`, `resolveEqInto`, `duckEnvelopeGain`): SOLO
 * aritmética escalar, cero asignaciones (contrato de `07-perf-resources`:
 * `updateAudio` no asigna `Map`s ni objetos por frame). Camino frío
 * (`normalizeAudioEffects`, `computeDialogueIntervals`, `refreshDuckIndex`,
 * `buildDuckAutomation`): puede asignar (una vez por edición / por export,
 * nunca por frame).
 */

import type { Clip, ClipAudioEffects, ClipEqSettings, Track, TrackRole } from '../../types/project';

/* ------------------------------------------------------------------ */
/* Rangos                                                              */
/* ------------------------------------------------------------------ */

/** Paneo: -1 (izquierda) .. 1 (derecha), 0 = centro. */
export const PAN_MIN = -1;
export const PAN_MAX = 1;
export const PAN_NEUTRAL = 0;

/** EQ: dB por banda (grave / medio / agudo). */
export const EQ_DB_MIN = -12;
export const EQ_DB_MAX = 12;
export const EQ_DB_NEUTRAL = 0;

/** Frecuencias y Q de las tres bandas (fijas, como en un NLE básico). */
export const EQ_LOW_FREQUENCY = 320;
export const EQ_MID_FREQUENCY = 1000;
export const EQ_MID_Q = 1;
export const EQ_HIGH_FREQUENCY = 3200;

/* ------------------------------------------------------------------ */
/* Normalización (escritura + importación)                              */
/* ------------------------------------------------------------------ */

/** Recorta un paneo a [-1, 1]. Lo no finito es el centro. Sin asignaciones. */
export function clampPan(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return PAN_NEUTRAL;
  return Math.min(PAN_MAX, Math.max(PAN_MIN, parsed));
}

/** Recorta una banda de EQ a [-12, +12] dB. Lo no finito es 0 dB. Sin asignaciones. */
export function clampEqDb(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return EQ_DB_NEUTRAL;
  return Math.min(EQ_DB_MAX, Math.max(EQ_DB_MIN, parsed));
}

/**
 * Normaliza unos efectos de audio (posiblemente corruptos) para guardarlos.
 *
 * Recorta el paneo y cada banda a su rango y elimina lo neutral: un `pan: 0`,
 * una EQ a 0 dB y un `duck` falso desaparecen del objeto. Devuelve `undefined`
 * cuando no queda ningún efecto: el clip suena como hoy y el campo ni siquiera
 * se escribe (igual que `normalizeColorFilters`).
 *
 * Camino frío: puede asignar.
 */
export function normalizeAudioEffects(effects: unknown): ClipAudioEffects | undefined {
  if (!effects || typeof effects !== 'object') return undefined;
  const source = effects as Partial<ClipAudioEffects>;
  const out: ClipAudioEffects = {};
  let active = false;

  if (source.pan !== undefined && source.pan !== null) {
    const pan = clampPan(source.pan);
    if (pan !== PAN_NEUTRAL) {
      out.pan = pan;
      active = true;
    }
  }

  const rawEq = source.eq;
  if (rawEq && typeof rawEq === 'object') {
    const eqSource = rawEq as Partial<ClipEqSettings>;
    const eq: ClipEqSettings = {};
    let eqActive = false;
    (['low', 'mid', 'high'] as const).forEach((band) => {
      const raw = eqSource[band];
      if (raw === undefined || raw === null) return;
      const db = clampEqDb(raw);
      if (db !== EQ_DB_NEUTRAL) {
        eq[band] = db;
        eqActive = true;
      }
    });
    if (eqActive) {
      out.eq = eq;
      active = true;
    }
  }

  if (source.duck === true) {
    out.duck = true;
    active = true;
  }

  return active ? out : undefined;
}

/** `true` cuando los efectos no cambian el sonido (campo ausente o neutral). */
export function isNeutralAudioEffects(effects?: ClipAudioEffects | null): boolean {
  if (!effects) return true;
  if (effects.pan !== undefined && effects.pan !== null && clampPan(effects.pan) !== PAN_NEUTRAL) {
    return false;
  }
  const eq = effects.eq;
  if (eq && typeof eq === 'object') {
    for (const band of ['low', 'mid', 'high'] as const) {
      const raw = eq[band];
      if (raw === undefined || raw === null) continue;
      if (clampEqDb(raw) !== EQ_DB_NEUTRAL) return false;
    }
  }
  if (effects.duck === true) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Resolución (camino caliente: sin asignaciones)                       */
/* ------------------------------------------------------------------ */

/**
 * Paneo efectivo de un clip (-1..1).
 *
 * `pannerSupported = false` (Safari antiguo sin `StereoPannerNode`) degrada a
 * "sin paneo" (centro): el preview y el export acuerdan porque AMBOS pasan por
 * aquí. Sin asignaciones.
 */
export function resolvePan(
  effects: ClipAudioEffects | undefined,
  pannerSupported = true
): number {
  if (!pannerSupported) return PAN_NEUTRAL;
  if (!effects) return PAN_NEUTRAL;
  return clampPan(effects.pan);
}

/** EQ efectiva de un clip (siempre las tres bandas, 0 = neutral). */
export interface ResolvedEq {
  low: number;
  mid: number;
  high: number;
}

/**
 * Escribe la EQ efectiva en `out` (objeto reutilizable del llamante: cero
 * asignaciones en el camino caliente). `undefined` ausente = 0 dB.
 */
export function resolveEqInto(effects: ClipAudioEffects | undefined, out: ResolvedEq): void {
  const eq = effects?.eq;
  out.low = eq && typeof eq === 'object' ? clampEqDb(eq.low) : EQ_DB_NEUTRAL;
  out.mid = eq && typeof eq === 'object' ? clampEqDb(eq.mid) : EQ_DB_NEUTRAL;
  out.high = eq && typeof eq === 'object' ? clampEqDb(eq.high) : EQ_DB_NEUTRAL;
}

/** EQ efectiva de un clip (camino frío / tests: asigna el objeto). */
export function resolveEq(effects: ClipAudioEffects | undefined): ResolvedEq {
  const out: ResolvedEq = { low: 0, mid: 0, high: 0 };
  resolveEqInto(effects, out);
  return out;
}

/** Un filtro de la cadena de EQ (lo que el preview y el export programan). */
export interface EqFilterConfig {
  /** Banda (`low`/`mid`/`high`), para identificar el nodo. */
  band: 'low' | 'mid' | 'high';
  type: BiquadFilterType;
  frequency: number;
  /** Solo la banda media usa Q (peaking). */
  Q?: number;
  /** Ganancia en dB (ya recortada a ±12). */
  gain: number;
}

/**
 * La configuración de los tres `BiquadFilterNode` en serie (lowshelf /
 * peaking / highshelf). El preview y el export la derivan de AQUÍ, así que
 * los nodos de ambos caminos reciben los mismos números.
 */
export function resolveEqFilterConfig(effects: ClipAudioEffects | undefined): EqFilterConfig[] {
  const eq = resolveEq(effects);
  return [
    { band: 'low', type: 'lowshelf', frequency: EQ_LOW_FREQUENCY, gain: eq.low },
    { band: 'mid', type: 'peaking', frequency: EQ_MID_FREQUENCY, Q: EQ_MID_Q, gain: eq.mid },
    { band: 'high', type: 'highshelf', frequency: EQ_HIGH_FREQUENCY, gain: eq.high },
  ];
}

/** `true` cuando la EQ cambia el sonido (alguna banda ≠ 0 dB). */
export function hasActiveEq(effects: ClipAudioEffects | undefined): boolean {
  if (!effects?.eq || typeof effects.eq !== 'object') return false;
  return (
    clampEqDb(effects.eq.low) !== EQ_DB_NEUTRAL ||
    clampEqDb(effects.eq.mid) !== EQ_DB_NEUTRAL ||
    clampEqDb(effects.eq.high) !== EQ_DB_NEUTRAL
  );
}

/**
 * Todo lo que un camino de audio necesita de un clip: la ÚNICA función que el
 * preview y el export llaman para derivar los parámetros. El test de paridad
 * la compara en ambos caminos literalmente.
 */
export interface ResolvedClipAudioChain {
  /** Paneo -1..1 (0 cuando no hay soporte: ambos caminos degradan igual). */
  pan: number;
  /** EQ en dB por banda. */
  eq: ResolvedEq;
  /** El clip pide ducking (`duck: true`). */
  duck: boolean;
  /** `true` cuando el clip necesita nodos Web Audio (paneo, EQ o duck). */
  needsGraph: boolean;
}

export function resolveClipAudioChain(
  clip: Pick<Clip, 'audioEffects'>,
  support: { panner?: boolean; biquad?: boolean } = {}
): ResolvedClipAudioChain {
  const effects = clip.audioEffects;
  const panner = support.panner !== false;
  const biquad = support.biquad !== false;
  const pan = resolvePan(effects, panner);
  const eq = resolveEq(biquad ? effects : undefined);
  const duck = effects?.duck === true;
  const needsGraph =
    pan !== PAN_NEUTRAL ||
    eq.low !== EQ_DB_NEUTRAL ||
    eq.mid !== EQ_DB_NEUTRAL ||
    eq.high !== EQ_DB_NEUTRAL ||
    duck;
  return { pan, eq, duck, needsGraph };
}

/* ------------------------------------------------------------------ */
/* Ducking: la regla                                                   */
/* ------------------------------------------------------------------ */
/**
 * REGLA DE DUCKING (determinista y explícita):
 *
 * Un clip C con `audioEffects.duck === true` se atenúa `amountDb` dB mientras
 * haya voz audible en OTRA pista, donde "voz" = cualquier clip D tal que:
 * - D está en una pista con `role === 'dialogue'`,
 * - D está en OTRA pista distinta de la de C (`trackId` diferente: la música
 *   no se atenúa a sí misma),
 * - D es audible: tipo `audio`/`video`, no `muted`, `volume > 0` y su pista
 *   no está muteada.
 *
 * La atenuación entra con una rampa lineal de `attackSec` ANTES del inicio de
 * la voz y sale con una rampa lineal de `releaseSec` DESPUÉS de su fin; varias
 * voces solapadas se fusionan (gana la atenuación mayor, es decir, el mínimo).
 * Fuera de toda voz la ganancia es exactamente 1.
 *
 * La envolvente se calcula UNA VEZ por cambio (índice de intervalos de
 * diálogo, ver `refreshDuckIndex`) y se aplica como una ganancia: en el
 * preview multiplicando el volumen del elemento, en el export con un
 * `GainNode` dedicado con `buildDuckAutomation`.
 */

/** Convierte dB en ganancia lineal. Sin asignaciones. */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return Math.pow(10, db / 20);
}

/** Configuración del ducking (explícita y configurable). */
export interface DuckConfig {
  /** Atenuación en dB mientras hay voz (p.ej. 8). */
  amountDb: number;
  /** Rampa de entrada antes de la voz, en segundos. */
  attackSec: number;
  /** Rampa de salida después de la voz, en segundos. */
  releaseSec: number;
}

/** Ducking por defecto: −8 dB, ataque 0,15 s, salida 0,4 s. */
export const DEFAULT_DUCK_CONFIG: DuckConfig = {
  amountDb: 8,
  attackSec: 0.15,
  releaseSec: 0.4,
};

/** Sanea una configuración (valores no útiles → defecto). Sin asignaciones. */
export function normalizeDuckConfig(config?: Partial<DuckConfig> | null): DuckConfig {
  const amountDb =
    config && typeof config.amountDb === 'number' && Number.isFinite(config.amountDb) && config.amountDb >= 0
      ? config.amountDb
      : DEFAULT_DUCK_CONFIG.amountDb;
  const attackSec =
    config && typeof config.attackSec === 'number' && Number.isFinite(config.attackSec) && config.attackSec >= 0
      ? config.attackSec
      : DEFAULT_DUCK_CONFIG.attackSec;
  const releaseSec =
    config && typeof config.releaseSec === 'number' && Number.isFinite(config.releaseSec) && config.releaseSec >= 0
      ? config.releaseSec
      : DEFAULT_DUCK_CONFIG.releaseSec;
  return { amountDb, attackSec, releaseSec };
}

/** Ganancia lineal del ducking a plena atenuación (p.ej. −8 dB ≈ 0,3981). */
export function duckFullGain(config?: Partial<DuckConfig> | null): number {
  return dbToGain(-normalizeDuckConfig(config).amountDb);
}

/** Un intervalo de diálogo audible (tiempos absolutos de timeline). */
export interface DialogueInterval {
  start: number;
  end: number;
  /** Pista de la voz (el ducking nunca atenúa su propia pista). */
  trackId: string;
}

type DuckClipView = Pick<Clip, 'trackId' | 'type' | 'start' | 'duration' | 'muted' | 'volume'>;
type DuckTrackView = Pick<Track, 'id' | 'role' | 'isMuted'>;

/** `true` cuando el clip es voz audible (un intervalo de diálogo). */
export function isAudibleDialogue(
  clip: DuckClipView,
  track: DuckTrackView | undefined
): boolean {
  if (!track) return false;
  if (track.role !== 'dialogue') return false;
  if (track.isMuted) return false;
  if (clip.type !== 'audio' && clip.type !== 'video') return false;
  if (clip.muted) return false;
  const volume = typeof clip.volume === 'number' ? clip.volume : 1;
  if (!(volume > 0)) return false;
  if (!Number.isFinite(clip.start) || !Number.isFinite(clip.duration) || clip.duration <= 0) return false;
  return true;
}

/**
 * Calcula los intervalos de diálogo audibles, fusionados y ordenados.
 *
 * Camino frío: asigna (una vez por edición / por export, nunca por frame).
 * Los intervalos solapados o contiguos de CUALQUIER pista se fusionan en uno
 * (la pista se conserva solo cuando el intervalo fusionado viene de una sola
 * pista; si varias pistas aportan voz al mismo intervalo, `trackId` es `''`
 * y el ducking se aplica a todas las pistas con `duck: true`).
 */
export function computeDialogueIntervals(
  clips: DuckClipView[],
  tracks: DuckTrackView[]
): DialogueInterval[] {
  const trackMap = new Map<string, DuckTrackView>();
  for (const t of tracks) trackMap.set(t.id, t);

  const raw: DialogueInterval[] = [];
  for (const clip of clips) {
    const track = trackMap.get(clip.trackId);
    if (!isAudibleDialogue(clip, track)) continue;
    raw.push({ start: clip.start, end: clip.start + clip.duration, trackId: clip.trackId });
  }
  if (raw.length === 0) return [];
  raw.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: DialogueInterval[] = [];
  for (const current of raw) {
    const last = merged[merged.length - 1];
    if (last && current.start <= last.end) {
      // Solape (o contacto): se fusionan; si las pistas difieren, el
      // intervalo deja de pertenecer a una sola pista.
      if (current.end > last.end) last.end = current.end;
      if (last.trackId !== current.trackId) last.trackId = '';
    } else {
      merged.push({ start: current.start, end: current.end, trackId: current.trackId });
    }
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Ducking: índice en caché (el motor lo refresca una vez por cambio)  */
/* ------------------------------------------------------------------ */

/** Fila de la firma del índice: todo lo que puede cambiar el ducking. */
interface DuckIndexKey {
  id: string;
  trackId: string;
  start: number;
  duration: number;
  muted: boolean;
  volume: number;
  duck: boolean;
  type: string;
}

/** Fila de la firma de una pista: rol y mute. */
interface DuckTrackKey {
  id: string;
  role: string;
  muted: boolean;
}

/**
 * Caché reutilizable de los intervalos de diálogo.
 *
 * El motor la guarda como campo y llama a `refreshDuckIndex` en cada frame:
 * la reconstrucción ocurre SOLO cuando el contenido relevante cambia (mismo
 * patrón que `refreshCrossfadeIndex`: cero asignaciones cuando nada cambió).
 */
export interface DuckIndexCache {
  clipsRef: Clip[] | null;
  tracksRef: Track[] | null;
  clipKeys: DuckIndexKey[];
  trackKeys: DuckTrackKey[];
  intervals: DialogueInterval[];
}

/** Crea la caché vacía del índice (una por instancia del motor). */
export function createDuckIndexCache(): DuckIndexCache {
  return { clipsRef: null, tracksRef: null, clipKeys: [], trackKeys: [], intervals: [] };
}

function duckKeyOf(clip: Clip): DuckIndexKey {
  return {
    id: clip.id,
    trackId: clip.trackId,
    start: clip.start,
    duration: clip.duration,
    muted: clip.muted === true,
    volume: typeof clip.volume === 'number' && Number.isFinite(clip.volume) ? clip.volume : 1,
    duck: clip.audioEffects?.duck === true,
    type: clip.type,
  };
}

function duckTrackKeyOf(track: Track): DuckTrackKey {
  return { id: track.id, role: track.role ?? '', muted: track.isMuted === true };
}

/**
 * Actualiza la caché cuando los clips o las pistas cambian. Devuelve `true`
 * si el índice se reconstruyó.
 *
 * - Misma referencia de arrays → `false` sin tocar nada.
 * - Distinto array pero MISMO contenido relevante → `false` sin asignar nada.
 * - Contenido distinto → reconstruye (el único camino que asigna, solo al editar).
 */
export function refreshDuckIndex(
  cache: DuckIndexCache,
  clips: Clip[],
  tracks: Track[]
): boolean {
  if (clips === cache.clipsRef && tracks === cache.tracksRef) return false;

  let same =
    cache.clipKeys.length === clips.length && cache.trackKeys.length === tracks.length;
  if (same) {
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const key = cache.clipKeys[i];
      const duck = clip.audioEffects?.duck === true;
      const volume =
        typeof clip.volume === 'number' && Number.isFinite(clip.volume) ? clip.volume : 1;
      if (
        clip.id !== key.id ||
        clip.trackId !== key.trackId ||
        clip.start !== key.start ||
        clip.duration !== key.duration ||
        (clip.muted === true) !== key.muted ||
        volume !== key.volume ||
        duck !== key.duck ||
        clip.type !== key.type
      ) {
        same = false;
        break;
      }
    }
  }
  if (same) {
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const key = cache.trackKeys[i];
      if (
        track.id !== key.id ||
        (track.role ?? '') !== key.role ||
        (track.isMuted === true) !== key.muted
      ) {
        same = false;
        break;
      }
    }
  }
  if (same) {
    cache.clipsRef = clips;
    cache.tracksRef = tracks;
    return false;
  }

  const nextClipKeys: DuckIndexKey[] = new Array(clips.length);
  for (let i = 0; i < clips.length; i++) nextClipKeys[i] = duckKeyOf(clips[i]);
  const nextTrackKeys: DuckTrackKey[] = new Array(tracks.length);
  for (let i = 0; i < tracks.length; i++) nextTrackKeys[i] = duckTrackKeyOf(tracks[i]);
  cache.clipKeys = nextClipKeys;
  cache.trackKeys = nextTrackKeys;
  cache.clipsRef = clips;
  cache.tracksRef = tracks;
  cache.intervals = computeDialogueIntervals(clips, tracks);
  return true;
}

/* ------------------------------------------------------------------ */
/* Ducking: envolvente (camino caliente) + automatización (export)      */
/* ------------------------------------------------------------------ */

/**
 * Ganancia del ducking de un clip en un tiempo ABSOLUTO de timeline.
 *
 * Es lo que el `AudioEngine` evalúa por frame: aritmética escalar sobre los
 * intervalos en caché, sin asignaciones. `ownTrackId` excluye la voz de la
 * propia pista (la música no se atenúa a sí misma).
 */
export function duckEnvelopeGain(
  time: number,
  isDucked: boolean,
  ownTrackId: string,
  intervals: DialogueInterval[],
  config?: Partial<DuckConfig> | null
): number {
  if (!isDucked) return 1;
  if (!Number.isFinite(time) || intervals.length === 0) return 1;
  const { amountDb, attackSec, releaseSec } = normalizeDuckConfig(config);
  const full = dbToGain(-amountDb);
  let gain = 1;
  for (let i = 0; i < intervals.length; i++) {
    const iv = intervals[i];
    // La voz de la propia pista no atenúa (intervalos de una sola pista).
    if (iv.trackId !== '' && iv.trackId === ownTrackId) continue;
    if (time < iv.start - attackSec || time > iv.end + releaseSec) continue;
    let g = full;
    if (attackSec > 0 && time < iv.start) {
      const p = (time - (iv.start - attackSec)) / attackSec;
      g = 1 + (full - 1) * p;
    } else if (releaseSec > 0 && time > iv.end) {
      const p = (time - iv.end) / releaseSec;
      g = full + (1 - full) * p;
    }
    if (g < gain) gain = g;
    if (gain <= full) break;
  }
  return gain;
}

/** Un evento de automatización de la ganancia de ducking (tiempos absolutos). */
export interface DuckGainEvent {
  type: 'set' | 'linearRamp';
  /** Tiempo absoluto (segundos de timeline). */
  time: number;
  /** Multiplicador 0..1 de la envolvente (SIN el volumen del clip). */
  value: number;
}

/**
 * Automatización de la envolvente de ducking de UN clip para el export.
 *
 * Muestrea `duckEnvelopeGain` — LA MISMA función que evalúa el preview por
 * frame — en los quiebros de la envolvente (bordes de cada intervalo ±
 * ataque/salida, recortados al clip), así que la envolvente programada en el
 * `GainNode` offline y la del preview acuerdan en todo instante.
 *
 * Devuelve `[]` cuando el clip no pide ducking o no hay voz que lo atenúe: el
 * llamante mantiene entonces el camino histórico (sin nodo nuevo).
 */
export function buildDuckAutomation(
  clip: Pick<Clip, 'start' | 'duration' | 'trackId' | 'audioEffects'>,
  intervals: DialogueInterval[],
  config?: Partial<DuckConfig> | null
): DuckGainEvent[] {
  if (clip.audioEffects?.duck !== true) return [];
  if (!Number.isFinite(clip.duration) || clip.duration <= 0) return [];
  if (!Number.isFinite(clip.start)) return [];
  if (intervals.length === 0) return [];

  const start = clip.start;
  const end = clip.start + clip.duration;
  const kinkSet = new Set<number>([start, end]);
  const { attackSec, releaseSec } = normalizeDuckConfig(config);
  let touches = false;
  for (const iv of intervals) {
    if (iv.trackId !== '' && iv.trackId === clip.trackId) continue;
    const regionStart = iv.start - attackSec;
    const regionEnd = iv.end + releaseSec;
    if (regionEnd < start || regionStart > end) continue;
    touches = true;
    // Quiebros recortados al clip: la rampa que cae fuera no se programa.
    const points = [regionStart, iv.start, iv.end, regionEnd];
    for (const p of points) {
      if (p > start && p < end) kinkSet.add(p);
    }
  }
  if (!touches) return [];

  const kinks = [...kinkSet].sort((x, y) => x - y);
  const events: DuckGainEvent[] = [];
  for (let i = 0; i < kinks.length; i++) {
    const t = kinks[i];
    const value = duckEnvelopeGain(t, true, clip.trackId, intervals, config);
    events.push({ type: i === 0 ? 'set' : 'linearRamp', time: t, value });
  }
  return events;
}

/**
 * Evalúa una automatización de ducking en un instante (semántica Web Audio:
 * `set` salta, `linearRamp` interpola desde el evento anterior).
 *
 * Producción (la usa el test de paridad preview/export): la envolvente del
 * export se compara contra `duckEnvelopeGain` a través de esta función.
 */
export function evaluateDuckAutomation(events: DuckGainEvent[], t: number): number {
  if (events.length === 0) return 1;
  let prevTime = events[0].time;
  let prevValue = events[0].value;
  if (t <= prevTime) return prevValue;
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    if (t <= e.time) {
      if (e.type === 'set' || e.time === prevTime) return e.value;
      const p = (t - prevTime) / (e.time - prevTime);
      return prevValue + (e.value - prevValue) * p;
    }
    prevTime = e.time;
    prevValue = e.value;
  }
  return prevValue;
}

/* ------------------------------------------------------------------ */
/* Detección de soporte (mismo patrón que `ctx.filter` en colorFilters) */
/* ------------------------------------------------------------------ */

/**
 * Detecta si un contexto Web Audio soporta `StereoPannerNode`.
 *
 * No basta con que exista el constructor: en Safari antiguo falta
 * `createStereoPanner` y el paneo sería un no-op silencioso. Se comprueba el
 * método de fábrica del contexto.
 */
export function detectStereoPannerSupport(
  ctx?: Pick<AudioContext, 'createStereoPanner'> | null
): boolean {
  try {
    if (ctx) return typeof ctx.createStereoPanner === 'function';
    if (typeof OfflineAudioContext !== 'undefined') {
      const probe = new OfflineAudioContext(1, 1, 44100);
      const supported = typeof probe.createStereoPanner === 'function';
      void probe;
      return supported;
    }
    const AC =
      (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    const probe = new AC();
    const supported =
      typeof (probe as unknown as { createStereoPanner?: unknown }).createStereoPanner ===
      'function';
    try {
      void probe.close?.();
    } catch {
      // ignore
    }
    return supported;
  } catch {
    return false;
  }
}

let cachedPannerSupport: boolean | null = null;

/**
 * `true` cuando el navegador soporta `StereoPannerNode`.
 *
 * La sonda corre UNA VEZ (resultado en caché): el Inspector y el motor la
 * consultan en el camino caliente y crear un contexto no es gratis.
 */
export function getStereoPannerSupport(): boolean {
  if (cachedPannerSupport === null) {
    cachedPannerSupport = detectStereoPannerSupport();
  }
  return cachedPannerSupport;
}

/** Olvida la sonda en caché (tests / cambio de entorno). */
export function resetStereoPannerSupportCache(): void {
  cachedPannerSupport = null;
}

/**
 * Detecta si un contexto Web Audio soporta `BiquadFilterNode` (la EQ).
 * Prácticamente universal, pero se degrada igual que el paneo si falta.
 */
export function detectBiquadFilterSupport(
  ctx?: Pick<AudioContext, 'createBiquadFilter'> | null
): boolean {
  try {
    if (ctx) return typeof ctx.createBiquadFilter === 'function';
    if (typeof OfflineAudioContext !== 'undefined') {
      const probe = new OfflineAudioContext(1, 1, 44100);
      const supported = typeof probe.createBiquadFilter === 'function';
      void probe;
      return supported;
    }
    const AC =
      (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    const probe = new AC();
    const supported =
      typeof (probe as unknown as { createBiquadFilter?: unknown }).createBiquadFilter ===
      'function';
    try {
      void probe.close?.();
    } catch {
      // ignore
    }
    return supported;
  } catch {
    return false;
  }
}

let cachedBiquadSupport: boolean | null = null;

/** `true` cuando el navegador soporta `BiquadFilterNode` (sonda en caché). */
export function getBiquadFilterSupport(): boolean {
  if (cachedBiquadSupport === null) {
    cachedBiquadSupport = detectBiquadFilterSupport();
  }
  return cachedBiquadSupport;
}

/** Olvida la sonda en caché (tests / cambio de entorno). */
export function resetBiquadFilterSupportCache(): void {
  cachedBiquadSupport = null;
}

/** Mensaje en español cuando el navegador no soporta el paneo estéreo. */
export const STEREO_PANNER_UNSUPPORTED_MESSAGE =
  'Este navegador no soporta el paneo estéreo (StereoPannerNode no está disponible). ' +
  'El control está desactivado y el clip sonará en el centro: ' +
  'usa Chrome, Edge o Firefox actualizados.';

/** Mensaje en español cuando el navegador no soporta la EQ. */
export const BIQUAD_FILTER_UNSUPPORTED_MESSAGE =
  'Este navegador no soporta la ecualización (BiquadFilterNode no está disponible). ' +
  'Los controles están desactivados y el clip sonará sin EQ: ' +
  'usa Chrome, Edge o Firefox actualizados.';

/* ------------------------------------------------------------------ */
/* Roles de pista                                                      */
/* ------------------------------------------------------------------ */

/** Roles válidos de una pista (`undefined` = sin rol). */
export const TRACK_ROLES: ReadonlyArray<TrackRole> = ['dialogue', 'music', 'sfx'];

/** Etiquetas en español de los roles de pista (el Inspector las muestra). */
export const TRACK_ROLE_LABELS: Record<TrackRole, string> = {
  dialogue: 'Diálogo (voz)',
  music: 'Música',
  sfx: 'Efectos',
};

/** Normaliza un rol de pista: lo desconocido es "sin rol". */
export function normalizeTrackRole(role: unknown): TrackRole | undefined {
  return role === 'dialogue' || role === 'music' || role === 'sfx' ? role : undefined;
}
