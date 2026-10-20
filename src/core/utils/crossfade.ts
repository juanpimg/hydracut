/**
 * F5 — Crossfade real entre clips (fundido de cruce).
 *
 * Las transiciones históricas son fundidos por clip (cada clip se funde a
 * negro en sus bordes). Un crossfade es otra cosa: DOS clips consecutivos de
 * la MISMA pista se solapan en una región compartida y ambas fuentes se
 * reproducen simultáneamente, mezcladas por una curva de ganancia.
 *
 * Este módulo es la ÚNICA fuente de verdad del crossfade y es 100 % puro
 * (sin DOM, sin estado): el preview (`Compositor`, `AudioEngine`), el export
 * (`webcodecsExporter`), el store y el Inspector lo usan, así que no pueden
 * divergir entre sí.
 *
 * Curva elegida: LINEAL (`out = 1 - p`, `in = p`).
 *
 * - El presupuesto de amplitud/alfa suma EXACTAMENTE 1 en todo punto
 *   (`out + in = 1`): el audio mezclado nunca supera el nivel de la fuente
 *   más fuerte (sin clipping sistemático) y el vídeo nunca se sobreexpone.
 * - Es el fundido cruzado clásico de los NLE (el fundido "dip to black" de
 *   los fundidos por clip es otro efecto y sigue intacto).
 * - La alternativa (equal-power: `cos`/`sin`) mantiene la sonoridad
 *   percibida pero suma amplitudes hasta √2 ≈ 1.41 en el punto medio: con
 *   dos fuentes calientes correladas recorta. Se rechaza deliberadamente.
 * - Sin trigonometría en el camino caliente (60 fps): una resta por frame.
 */

import type { Clip, Track } from '../../types/project';
import { quantizeToFrame } from './time';

/** Duración por defecto al crear un crossfade (segundos). */
export const CROSSFADE_DEFAULT_DURATION = 0.5;

/**
 * Tolerancia (segundos) al comparar un solape con las duraciones marcadas.
 * `createCrossfade` escribe posiciones exactas, pero un round-trip por JSON
 * o una cuantización a frame pueden mover un borde ~1 ulp.
 */
export const CROSSFADE_OVERLAP_TOLERANCE = 1e-4;

/** Ganancias lineales del crossfade para un progreso `p` en [0, 1]. */
export interface CrossfadeMix {
  /** Ganancia del clip saliente (1 → 0). */
  out: number;
  /** Ganancia del clip entrante (0 → 1). */
  in: number;
}

function clamp01(p: number): number {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/**
 * Mezcla del crossfade (versión objeto, para tests y UI).
 * Lineal: `out + in === 1` siempre.
 */
export function crossfadeMix(progress: number): CrossfadeMix {
  const p = clamp01(progress);
  return { out: 1 - p, in: p };
}

/**
 * Ganancia del clip SALIENTE (versión escalar, sin asignaciones).
 * Para el camino caliente (60 fps): no asigna ningún objeto.
 */
export function crossfadeOutGain(progress: number): number {
  return 1 - clamp01(progress);
}

/**
 * Ganancia del clip ENTRANTE (versión escalar, sin asignaciones).
 */
export function crossfadeInGain(progress: number): number {
  return clamp01(progress);
}

/** Duración de un frame del proyecto (segundos). */
export function crossfadeFrameDuration(fps: number): number {
  const safe = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return 1 / safe;
}

/**
 * Cuantiza una duración pedida a frames del proyecto y la recorta al
 * material disponible.
 *
 * - `requested` se cuantiza al frame más cercano (`quantizeToFrame`).
 * - El resultado nunca supera `maxAllowed` (el crossfade no puede ser más
 *   largo que el más corto de los dos clips).
 * - Devuelve 0 cuando ni siquiera cabe un frame (el llamante debe rechazar
 *   el crossfade con "material demasiado corto").
 */
export function clampCrossfadeDuration(
  requested: number,
  maxAllowed: number,
  fps: number
): number {
  const frame = crossfadeFrameDuration(fps);
  if (!Number.isFinite(requested) || !Number.isFinite(maxAllowed)) return 0;
  if (maxAllowed < frame) return 0;
  const quantized = quantizeToFrame(Math.max(0, Math.min(requested, maxAllowed)), fps);
  const clamped = Math.min(quantized, maxAllowed);
  // La cuantización puede redondear a 0 (p. ej. 0.001 s a 30 fps).
  if (clamped < frame / 2) return 0;
  return clamped;
}

/** Fin (exclusivo) de un clip en el timeline. */
export function crossfadeClipEnd(clip: Pick<Clip, 'start' | 'duration'>): number {
  return clip.start + clip.duration;
}

/**
 * Solape físico (segundos) entre dos clips. 0 cuando solo se tocan o hay
 * un hueco entre ellos.
 */
export function crossfadeOverlapDuration(
  a: Pick<Clip, 'start' | 'duration'>,
  b: Pick<Clip, 'start' | 'duration'>
): number {
  const overlap = Math.min(crossfadeClipEnd(a), crossfadeClipEnd(b)) - Math.max(a.start, b.start);
  return overlap > 0 ? overlap : 0;
}

/** Marcador de salida del clip (0 = sin crossfade de salida). */
export function getCrossfadeOutMarker(clip: Pick<Clip, 'transition'>): number {
  const v = clip.transition?.crossfadeOutDuration;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Marcador de entrada del clip (0 = sin crossfade de entrada). */
export function getCrossfadeInMarker(clip: Pick<Clip, 'transition'>): number {
  const v = clip.transition?.crossfadeInDuration;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * True cuando el solape entre `a` y `b` es un crossfade DELIBERADO y no un
 * solape ilegal.
 *
 * La distinción con la política de solapamiento (F1) es explícita:
 * - `findOverlappingClips` sigue informando de TODO solape físico (su
 *   contrato no cambia: dos clips que comparten tiempo se informan).
 * - Un solape solo es deliberado cuando los DOS clips lo declaran con sus
 *   marcadores (`crossfadeOutDuration` del anterior y `crossfadeInDuration`
 *   del posterior) Y el solape real coincide con ambos.
 *
 * Un clip insertado por error nunca lleva marcadores, así que un solape
 * ilegal no puede pasar por deliberado.
 */
export function isDeliberateCrossfadeOverlap(a: Clip, b: Clip): boolean {
  if (a.id === b.id) return false;
  if (a.trackId !== b.trackId) return false;
  const overlap = crossfadeOverlapDuration(a, b);
  if (overlap <= CROSSFADE_OVERLAP_TOLERANCE) return false;
  const earlier = a.start <= b.start ? a : b;
  const later = earlier === a ? b : a;
  const outMarker = getCrossfadeOutMarker(earlier);
  const inMarker = getCrossfadeInMarker(later);
  if (outMarker <= 0 || inMarker <= 0) return false;
  return (
    Math.abs(overlap - outMarker) <= CROSSFADE_OVERLAP_TOLERANCE &&
    Math.abs(overlap - inMarker) <= CROSSFADE_OVERLAP_TOLERANCE
  );
}

/** Papel de un clip dentro de su región de crossfade. */
export type CrossfadeRole = 'out' | 'in';

/**
 * Región de crossfade que afecta a un clip (cacheada por el motor).
 * `role: 'out'` = el clip es el anterior (su cola se funde);
 * `role: 'in'` = el clip es el posterior (su cabeza emerge).
 */
export interface CrossfadeSpan {
  /** Id del clip compañero del fundido. */
  partnerId: string;
  /** Inicio de la región compartida (segundos de timeline). */
  regionStart: number;
  /** Fin de la región compartida (segundos de timeline). */
  regionEnd: number;
  /** Duración de la región (`regionEnd - regionStart`). */
  duration: number;
  role: CrossfadeRole;
}

/**
 * Construye el índice de crossfades de una lista de clips.
 *
 * Pensado para llamarse UNA vez por cambio de clips (no por frame): vacía y
 * rellena el `target` reutilizable del llamante, sin devolver colecciones
 * nuevas. El camino caliente (60 fps) solo hace `Map.get` + aritmética.
 */
export function buildCrossfadeIndex(
  clips: Clip[],
  target: Map<string, CrossfadeSpan>
): void {  target.clear();
  const byTrack = new Map<string, Clip[]>();
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const group = byTrack.get(clip.trackId);
    if (group) group.push(clip);
    else byTrack.set(clip.trackId, [clip]);
  }
  for (const group of byTrack.values()) {
    group.sort((x, y) => x.start - y.start || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    for (let i = 0; i + 1 < group.length; i++) {
      const earlier = group[i];
      const later = group[i + 1];
      if (!isDeliberateCrossfadeOverlap(earlier, later)) continue;
      const regionStart = Math.max(earlier.start, later.start);
      const regionEnd = Math.min(crossfadeClipEnd(earlier), crossfadeClipEnd(later));
      const duration = Math.max(0, regionEnd - regionStart);
      if (duration <= 0) continue;
      target.set(earlier.id, {
        partnerId: later.id,
        regionStart,
        regionEnd,
        duration,
        role: 'out',
      });
      target.set(later.id, {
        partnerId: earlier.id,
        regionStart,
        regionEnd,
        duration,
        role: 'in',
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Caché del índice (camino caliente: cero asignaciones por frame)      */
/* ------------------------------------------------------------------ */

/**
 * Una fila de la firma de contenido del índice: todo lo que puede cambiar el
 * resultado de `buildCrossfadeIndex` (identidad, pista, geometría y
 * marcadores). Solo primitivos: comparar no asigna nada.
 */
interface CrossfadeIndexKey {
  id: string;
  trackId: string;
  start: number;
  duration: number;
  outM: number;
  inM: number;
}

/**
 * Caché reutilizable del índice de crossfades.
 *
 * El motor la guarda como campo y llama a `refreshCrossfadeIndex` en cada
 * frame: la reconstrucción ocurre SOLO cuando el contenido relevante cambia
 * (un frame con los mismos clips — aunque sea otro array — no asigna ni un
 * `Map`, como exige el contrato de cero asignaciones del `AudioEngine`).
 */
export interface CrossfadeIndexCache {
  clipsRef: Clip[] | null;
  keys: CrossfadeIndexKey[];
  spans: Map<string, CrossfadeSpan>;
}

/** Crea la caché vacía del índice (una por instancia del motor). */
export function createCrossfadeIndexCache(): CrossfadeIndexCache {
  return { clipsRef: null, keys: [], spans: new Map() };
}

/**
 * Actualiza la caché cuando los clips cambian. Devuelve `true` si el índice
 * se reconstruyó.
 *
 * - Misma referencia de array → `false` sin tocar nada (caso común: el store
 *   entrega el mismo array en cada frame hasta la próxima edición).
 * - Distinto array pero MISMO contenido relevante → `false` sin asignar
 *   nada (comparación campo a campo con salida temprana).
 * - Contenido distinto → reconstruye llaves e índice (el único camino que
 *   asigna, y solo ocurre al editar el timeline).
 */
export function refreshCrossfadeIndex(
  cache: CrossfadeIndexCache,
  clips: Clip[]
): boolean {
  if (clips === cache.clipsRef) return false;

  const keys = cache.keys;
  if (keys.length === clips.length) {
    let same = true;
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const key = keys[i];
      if (
        clip.id !== key.id ||
        clip.trackId !== key.trackId ||
        clip.start !== key.start ||
        clip.duration !== key.duration ||
        getCrossfadeOutMarker(clip) !== key.outM ||
        getCrossfadeInMarker(clip) !== key.inM
      ) {
        same = false;
        break;
      }
    }
    if (same) {
      cache.clipsRef = clips;
      return false;
    }
  }

  const nextKeys: CrossfadeIndexKey[] = new Array(clips.length);
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    nextKeys[i] = {
      id: clip.id,
      trackId: clip.trackId,
      start: clip.start,
      duration: clip.duration,
      outM: getCrossfadeOutMarker(clip),
      inM: getCrossfadeInMarker(clip),
    };
  }
  cache.keys = nextKeys;
  cache.clipsRef = clips;
  buildCrossfadeIndex(clips, cache.spans);
  return true;
}

/* ------------------------------------------------------------------ */
/* Planificación (store + Inspector comparten esta lógica)              */
/* ------------------------------------------------------------------ */

export interface PlanCrossfadeInput {
  clips: Clip[];
  tracks: Track[];
  /** Id del clip saliente (el anterior). */
  outgoingId: string;
  /** Id del clip entrante (el posterior). */
  incomingId: string;
  /** Duración pedida (segundos). No finita → la duración por defecto. */
  requestedDuration: number;
  /** Fps del proyecto (cuantización a frame). */
  fps: number;
}

export type PlanCrossfadeResult =
  | {
      ok: true;
      /** El clip anterior (no se mueve). */
      outClip: Clip;
      /** El clip posterior (se adelanta para crear el solape). */
      inClip: Clip;
      track: Track;
      /** Duración final (cuantizada a frame y recortada al material). */
      duration: number;
      /** Nuevo `start` del clip entrante (`outClip.end - duration`). */
      newIncomingStart: number;
    }
  | { ok: false; reason: string };

/**
 * Valida y planifica la creación de un crossfade entre dos clips.
 *
 * Puro y testeable: el store lo ejecuta y el Inspector lo usa para explicar
 * por qué el control está deshabilitado (mismo motivo en ambos).
 */
export function planCrossfade(input: PlanCrossfadeInput): PlanCrossfadeResult {
  const { clips, tracks, outgoingId, incomingId, fps } = input;
  let { requestedDuration } = input;

  const outClip = clips.find((c) => c.id === outgoingId);
  const inClip = clips.find((c) => c.id === incomingId);
  if (!outClip || !inClip) {
    return { ok: false, reason: 'No se encontró el clip para crear el fundido de cruce.' };
  }
  if (outClip.id === inClip.id) {
    return { ok: false, reason: 'Un clip no puede fundirse consigo mismo: elige dos clips consecutivos.' };
  }
  if (outClip.trackId !== inClip.trackId) {
    return {
      ok: false,
      reason: `«${outClip.name}» y «${inClip.name}» no están en la misma pista: el fundido de cruce solo une clips consecutivos de una misma pista.`,
    };
  }

  const track = tracks.find((t) => t.id === outClip.trackId);
  if (!track) {
    return { ok: false, reason: 'La pista de los clips ya no existe.' };
  }
  if (track.isLocked) {
    return {
      ok: false,
      reason: `La pista «${track.name}» está bloqueada: desbloquéala para poder crear el fundido de cruce.`,
    };
  }

  // Los clips deben ser consecutivos en la pista, con el saliente primero.
  const ordered = clips
    .filter((c) => c.trackId === outClip.trackId)
    .sort((x, y) => x.start - y.start || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const outIndex = ordered.findIndex((c) => c.id === outClip.id);
  const inIndex = ordered.findIndex((c) => c.id === inClip.id);
  if (outIndex === -1 || inIndex !== outIndex + 1) {
    return {
      ok: false,
      reason: `«${outClip.name}» y «${inClip.name}» no son consecutivos: el fundido de cruce solo une dos clips seguidos sin clips entre ellos.`,
    };
  }

  // Adyacencia: o se tocan, o YA forman un par de crossfade (reajuste de
  // la duración de un fundido existente).
  const outEnd = crossfadeClipEnd(outClip);
  const touching = Math.abs(inClip.start - outEnd) <= CROSSFADE_OVERLAP_TOLERANCE;
  const alreadyPaired = isDeliberateCrossfadeOverlap(outClip, inClip);
  if (!touching && !alreadyPaired) {
    return {
      ok: false,
      reason: `«${outClip.name}» y «${inClip.name}» no son adyacentes: júntalos en el timeline (sin hueco ni solape) para poder fundirlos.`,
    };
  }

  if (!Number.isFinite(requestedDuration) || requestedDuration <= 0) {
    requestedDuration = CROSSFADE_DEFAULT_DURATION;
  }
  const maxAllowed = Math.min(outClip.duration, inClip.duration);
  const duration = clampCrossfadeDuration(requestedDuration, maxAllowed, fps);
  if (duration <= 0) {
    return {
      ok: false,
      reason: `El material es demasiado corto para un fundido de cruce: el más corto de los dos clips dura menos de un fotograma útil. Usa clips más largos.`,
    };
  }

  return {
    ok: true,
    outClip,
    inClip,
    track,
    duration,
    newIncomingStart: Math.max(0, outEnd - duration),
  };
}

/* ------------------------------------------------------------------ */
/* Disponibilidad para el Inspector                                     */
/* ------------------------------------------------------------------ */

export interface CrossfadeNeighbour {
  id: string;
  name: string;
  /** Papel del clip SELECCIONADO si se crea el fundido con este vecino. */
  selectedRole: CrossfadeRole;
}

export interface CrossfadeAvailability {
  /** El clip seleccionado existe. */
  clipFound: boolean;
  /** La pista está bloqueada (todo deshabilitado). */
  trackLocked: boolean;
  /** Nombre de la pista (para los mensajes). */
  trackName: string | null;
  /** Par de crossfade ACTIVO que incluye al clip seleccionado, si lo hay. */
  activePair: { outId: string; inId: string; duration: number } | null;
  /** Vecino candidato para crear el fundido (null = no hay vecino útil). */
  neighbour: CrossfadeNeighbour | null;
  /** Duración actual del fundido activo (0 si no hay). */
  currentDuration: number;
  /** Duración máxima que admite el par (material más corto). */
  maxDuration: number;
  /** Se puede crear (o reajustar) el fundido ahora. */
  canCreate: boolean;
  /** Motivo en español cuando no se puede crear (`null` si se puede). */
  createReason: string | null;
  /** Se puede eliminar el fundido activo. */
  canRemove: boolean;
}

/**
 * Describe el estado del fundido de cruce para el clip seleccionado.
 *
 * El Inspector muestra esta información y deshabilita el control con el
 * motivo cuando el fundido no es posible (no adyacente, pista bloqueada,
 * material demasiado corto).
 */
export function describeCrossfadeForClip(
  clips: Clip[],
  tracks: Track[],
  clipId: string,
  fps: number
): CrossfadeAvailability {
  const frame = crossfadeFrameDuration(fps);
  const empty: CrossfadeAvailability = {
    clipFound: false,
    trackLocked: false,
    trackName: null,
    activePair: null,
    neighbour: null,
    currentDuration: 0,
    maxDuration: 0,
    canCreate: false,
    createReason: 'Selecciona un clip del timeline para crear un fundido de cruce.',
    canRemove: false,
  };

  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return empty;
  const track = tracks.find((t) => t.id === clip.trackId) ?? null;

  const base = {
    ...empty,
    clipFound: true,
    trackLocked: track?.isLocked === true,
    trackName: track?.name ?? null,
  };

  const ordered = clips
    .filter((c) => c.trackId === clip.trackId)
    .sort((x, y) => x.start - y.start || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const index = ordered.findIndex((c) => c.id === clip.id);
  const prev = index > 0 ? ordered[index - 1] : null;
  const next = index >= 0 && index + 1 < ordered.length ? ordered[index + 1] : null;

  // ¿El clip YA forma un par deliberado con su anterior o su posterior?
  const pairedPrev = prev && isDeliberateCrossfadeOverlap(prev, clip) ? prev : null;
  const pairedNext = next && isDeliberateCrossfadeOverlap(clip, next) ? next : null;
  const partner = pairedPrev ?? pairedNext;
  if (partner) {
    const outClip = pairedPrev ? partner : clip;
    const inClip = pairedPrev ? clip : partner;
    const duration = crossfadeOverlapDuration(outClip, inClip);
    const maxDuration = Math.min(outClip.duration, inClip.duration);
    const locked = track?.isLocked === true;
    return {
      ...base,
      activePair: { outId: outClip.id, inId: inClip.id, duration },
      neighbour: {
        id: partner.id,
        name: partner.name,
        selectedRole: pairedPrev ? 'in' : 'out',
      },
      currentDuration: duration,
      maxDuration,
      canCreate: !locked && maxDuration >= frame,
      createReason: locked
        ? `La pista «${track?.name ?? ''}» está bloqueada: desbloquéala para modificar el fundido de cruce.`
        : maxDuration >= frame
          ? null
          : 'El material es demasiado corto para modificar el fundido de cruce.',
      canRemove: !locked,
    };
  }

  if (track?.isLocked === true) {
    return {
      ...base,
      canCreate: false,
      createReason: `La pista «${track.name}» está bloqueada: desbloquéala para poder crear el fundido de cruce.`,
      canRemove: false,
    };
  }

  // Candidato: el posterior si se tocan, si no el anterior si se tocan.
  const touchesNext =
    next !== null && Math.abs(next.start - crossfadeClipEnd(clip)) <= CROSSFADE_OVERLAP_TOLERANCE;
  const touchesPrev =
    prev !== null && Math.abs(clip.start - crossfadeClipEnd(prev)) <= CROSSFADE_OVERLAP_TOLERANCE;
  const candidate = touchesNext ? next : touchesPrev ? prev : null;

  if (!candidate) {
    const hasNeighbour = prev !== null || next !== null;
    return {
      ...base,
      canCreate: false,
      createReason: hasNeighbour
        ? 'El clip vecino no es adyacente: júntalos en el timeline (sin hueco ni solape) para poder fundirlos.'
        : 'El clip no tiene ningún vecino en su pista: el fundido de cruce une dos clips consecutivos.',
      canRemove: false,
    };
  }

  const outClip = touchesNext ? clip : candidate;
  const inClip = touchesNext ? candidate : clip;
  const maxDuration = Math.min(outClip.duration, inClip.duration);
  if (maxDuration < frame) {
    return {
      ...base,
      neighbour: {
        id: candidate.id,
        name: candidate.name,
        selectedRole: touchesNext ? 'out' : 'in',
      },
      maxDuration,
      canCreate: false,
      createReason:
        'El material es demasiado corto para un fundido de cruce: el más corto de los dos clips dura menos de un fotograma útil.',
      canRemove: false,
    };
  }

  return {
    ...base,
    neighbour: {
      id: candidate.id,
      name: candidate.name,
      selectedRole: touchesNext ? 'out' : 'in',
    },
    maxDuration,
    canCreate: true,
    createReason: null,
    canRemove: false,
  };
}

/* ------------------------------------------------------------------ */
/* Automatización de audio del exportador                               */
/* ------------------------------------------------------------------ */

/**
 * Un evento de automatización de ganancia (tiempos absolutos de timeline).
 * El exportador los programa tal cual en el `GainNode` offline.
 */
export interface CrossfadeAudioEvent {
  type: 'set' | 'linearRamp';
  /** Tiempo absoluto (segundos de timeline). */
  time: number;
  /** Ganancia absoluta (volumen del clip ya aplicado). */
  value: number;
}

/**
 * Automatización de ganancia de UN clip que participa en un crossfade.
 *
 * Envuelve la región de cruce con rampas lineales de la MISMA curva que el
 * preview (`crossfadeOutGain`/`crossfadeInGain` evaluados en los bordes) y
 * conserva los fundidos de borde del clip fuera de la región:
 *
 * - clip saliente: la región es su cola `[end - d, end]` → rampa a 0.
 * - clip entrante: la región es su cabeza `[start, start + d]` → rampa de 0.
 *
 * Sin fundidos de borde la envolvente es EXACTAMENTE la del preview
 * (producto de lineales evaluado en los quiebros). Con fundido de borde la
 * envolvente se muestrea en los quiebros de ambas curvas (aproximación
 * lineal del producto, exacta en cada quiebro).
 */
export function buildCrossfadeAudioSchedule(
  clip: Clip,
  span: CrossfadeSpan
): CrossfadeAudioEvent[] {
  const baseVol = typeof clip.volume === 'number' && Number.isFinite(clip.volume) ? clip.volume : 1;
  const start = clip.start;
  const end = clip.start + clip.duration;
  const { regionStart: rs, regionEnd: re, role } = span;

  const transition = clip.transition;
  const fadeInType = transition?.fadeInType ?? 'none';
  const fadeOutType = transition?.fadeOutType ?? 'none';
  const fadeInDuration = transition?.fadeInDuration ?? 0;
  const fadeOutDuration = transition?.fadeOutDuration ?? 0;
  const totalFade = (fadeInDuration > 0 ? fadeInDuration : 0) + (fadeOutDuration > 0 ? fadeOutDuration : 0);
  const scale = totalFade > clip.duration && totalFade > 0 ? clip.duration / totalFade : 1;
  const effectiveIn = (fadeInDuration || 0) * scale;
  const effectiveOut = (fadeOutDuration || 0) * scale;
  const hasInFade = effectiveIn > 0 && (fadeInType === 'fade-black' || fadeInType === 'fade-white');
  const hasOutFade = effectiveOut > 0 && (fadeOutType === 'fade-black' || fadeOutType === 'fade-white');

  const edgeGain = (t: number): number => {
    let m = 1;
    if (hasInFade && effectiveIn > 0 && t >= start && t < start + effectiveIn) {
      m *= Math.max(0, (t - start) / effectiveIn);
    }
    if (hasOutFade && effectiveOut > 0 && t > end - effectiveOut && t <= end) {
      m *= Math.max(0, (end - t) / effectiveOut);
    }
    return m;
  };

  const duration = Math.max(1e-9, re - rs);
  const xfGain = (t: number): number => {
    const p = (t - rs) / duration;
    return role === 'out' ? crossfadeOutGain(p) : crossfadeInGain(p);
  };

  const kinkSet = new Set<number>([start, end, rs, re]);
  if (hasInFade) kinkSet.add(start + effectiveIn);
  if (hasOutFade) kinkSet.add(end - effectiveOut);
  const kinks = [...kinkSet].filter((t) => t >= start && t <= end).sort((x, y) => x - y);

  const events: CrossfadeAudioEvent[] = [];
  for (let i = 0; i < kinks.length; i++) {
    const t = kinks[i];
    // Fuera de la región el crossfade no atenúa (out: 1 antes de rs;
    // in: 1 después de re). Dentro, la curva lineal del preview.
    let xf = 1;
    if (t >= rs && t <= re) xf = xfGain(t);
    else if (role === 'in' && t < rs) xf = 0;
    else if (role === 'out' && t > re) xf = 0;
    const value = Math.max(0, baseVol * edgeGain(t) * xf);
    events.push({ type: i === 0 ? 'set' : 'linearRamp', time: t, value });
  }
  return events;
}
