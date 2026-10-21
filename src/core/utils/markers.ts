/**
 * P0-6 + P0-11 · Lógica pura de la ronda "Terminar un proyecto".
 *
 * Este módulo es 100 % puro (sin DOM, sin estado): los marcadores de la línea
 * de tiempo y el campo numérico de timecode. El store (`useProjectStore`), la
 * regla (`TimeRuler`), la barra (`TimelineToolbar`) y el diálogo de
 * exportación lo usan, así que no pueden divergir entre sí.
 *
 * - Marcadores: crear, sanear (importación), ordenar y convertir un par en
 *   rango de exportación.
 * - Timecode: `parseTimecodeInput` entiende lo que el usuario teclea en el
 *   campo "Ir al timecode" (`HH:MM:SS:FF`, `HH:MM:SS`, `MM:SS` o segundos
 *   con punto o coma) y devuelve segundos o `null` (nunca `NaN` al estado).
 */

import type { TimelineMarker } from '../../types/project';
import { quantizeToFrame } from './time';

/** Número máximo de marcadores por proyecto (tope anti-abuso al importar). */
export const MAX_MARKERS = 200;

/**
 * Paleta de marcadores (hex válidos, visibles sobre el panel oscuro).
 * Se asigna en round-robin al crear (`Marcador 1` → el primero, …).
 */
export const MARKER_COLORS: ReadonlyArray<string> = [
  '#f59e0b',
  '#38bdf8',
  '#f43f5e',
  '#4ade80',
  '#a855f7',
];

/** Id de un marcador nuevo (único para la línea de tiempo). */
export function createMarkerId(): string {
  return 'marker_' + Math.random().toString(36).substring(2, 9);
}

/** Nombre por defecto en español (`Marcador 1`, `Marcador 2`, …). */
export function defaultMarkerName(index: number): string {
  const safe = Number.isFinite(index) && index > 0 ? Math.floor(index) : 1;
  return `Marcador ${safe}`;
}

/** True cuando `color` es un hex `#rrggbb` válido. */
export function isValidMarkerColor(color: unknown): color is string {
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color);
}

/**
 * Ordena los marcadores por tiempo (y por id para desempatar): el orden de
 * la lista y de la regla es siempre el cronológico.
 */
export function sortMarkersByTime(markers: TimelineMarker[]): TimelineMarker[] {
  return [...markers].sort((a, b) =>
    a.time !== b.time ? a.time - b.time : a.id.localeCompare(b.id)
  );
}

export interface SanitizeMarkersResult {
  markers: TimelineMarker[];
  warnings: string[];
}

/**
 * Sanea los marcadores de un proyecto importado (archivo no confiable).
 *
 * - Lo que no es lista se descarta sin romper (proyecto sin marcadores).
 * - Tiempos no finitos o negativos: se descartan (con aviso).
 * - Nombres vacíos: `Marcador N`. Colores inválidos: se quitan (con aviso).
 * - Ids duplicados o ausentes: se reparan (con aviso).
 * - Más de `MAX_MARKERS`: se recorta (con aviso).
 * - El resultado sale ordenado por tiempo y cuantizado a frames del proyecto.
 */
export function sanitizeMarkers(raw: unknown, fps: number): SanitizeMarkersResult {
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { markers: [], warnings };
  if (!Array.isArray(raw)) {
    warnings.push('Los marcadores no eran una lista válida: se han descartado.');
    return { markers: [], warnings };
  }

  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const seen = new Set<string>();
  const markers: TimelineMarker[] = [];
  // Los nombres por defecto se asignan DESPUÉS de ordenar: `Marcador 1` es
  // siempre el más temprano de la lista.
  const unnamed = new Set<string>();
  let dropped = 0;

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Partial<TimelineMarker> | null;
    if (!item || typeof item !== 'object') {
      dropped += 1;
      continue;
    }
    const time = Number(item.time);
    if (!Number.isFinite(time) || time < 0) {
      dropped += 1;
      warnings.push(
        `Marcador "${typeof item.name === 'string' && item.name ? item.name : item.id ?? i}": tiempo no válido y se descartó.`
      );
      continue;
    }
    let id = typeof item.id === 'string' && item.id.length > 0 ? item.id : createMarkerId();
    if (seen.has(id)) {
      const renamed = `${id}_${Math.random().toString(36).substring(2, 6)}`;
      warnings.push(`Marcador duplicado "${id}": se renombró a "${renamed}".`);
      id = renamed;
    }
    seen.add(id);
    const hasName = typeof item.name === 'string' && item.name.trim().length > 0;
    const name = hasName ? (item.name as string).trim().slice(0, 60) : '';
    if (!hasName) unnamed.add(id);
    const marker: TimelineMarker = {
      id,
      time: quantizeToFrame(Math.max(0, time), safeFps),
      name,
    };
    if (item.color !== undefined) {
      if (isValidMarkerColor(item.color)) marker.color = item.color;
      else warnings.push(`Marcador "${name}": color no válido y se quitó.`);
    }
    markers.push(marker);
  }

  if (dropped > 0 && warnings.length === 0) {
    warnings.push(`${dropped} marcador${dropped === 1 ? '' : 'es'} no válido${dropped === 1 ? '' : 's'}: se ${dropped === 1 ? 'descartó' : 'descartaron'}.`);
  }

  const sorted = sortMarkersByTime(markers);
  for (let i = 0; i < sorted.length; i++) {
    if (unnamed.has(sorted[i].id) || sorted[i].name.length === 0) {
      sorted[i] = { ...sorted[i], name: defaultMarkerName(i + 1) };
    }
  }
  if (sorted.length > MAX_MARKERS) {
    warnings.push(
      `El proyecto traía más de ${MAX_MARKERS} marcadores: se conservaron los ${MAX_MARKERS} primeros.`
    );
    return { markers: sorted.slice(0, MAX_MARKERS), warnings };
  }
  return { markers: sorted, warnings };
}

/**
 * Convierte un par de marcadores en rango de exportación ordenado.
 *
 * Devuelve `null` cuando no hay rango (mismo tiempo): el diálogo debe seguir
 * en "Todo el proyecto" en vez de exportar 0 s.
 */
export function markerPairToRange(
  a: TimelineMarker,
  b: TimelineMarker
): { start: number; end: number } | null {
  if (!a || !b) return null;
  if (!Number.isFinite(a.time) || !Number.isFinite(b.time)) return null;
  if (a.time === b.time) return null;
  return { start: Math.min(a.time, b.time), end: Math.max(a.time, b.time) };
}

/* ------------------------------------------------------------------ */
/* Ir al timecode (P0-11)                                               */
/* ------------------------------------------------------------------ */

/**
 * Entiende lo que el usuario teclea en el campo "Ir al timecode".
 *
 * Formatos (siempre en español decimal: la coma vale como punto):
 * - segundos: `75.5`, `75,5`, `5`;
 * - `MM:SS` (`01:30` → 90 s);
 * - `HH:MM:SS` (`00:01:30` → 90 s);
 * - `HH:MM:SS:FF` (`00:01:00:15` a 30 fps → 60,5 s).
 *
 * `fps` valida el componente de fotogramas (`FF < fps`). Devuelve segundos
 * o `null` cuando la entrada no es válida (nunca `NaN` al estado).
 */
export function parseTimecodeInput(raw: string, fps: number): number | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(',', '.');
  if (text.length === 0) return null;

  const safeFps = Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 30;
  const fail = (): null => null;

  // Segundos sueltos (sin dos puntos): deben ser no negativos y finitos.
  if (!text.includes(':')) {
    if (!/^\d+(\.\d+)?$/.test(text)) return fail();
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds < 0) return fail();
    return seconds;
  }

  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 4) return fail();
  // Cada parte es un número no negativo (`SS` admite decimales).
  if (parts.some((p) => p.length === 0 || !/^\d+(\.\d+)?$/.test(p))) return fail();
  const values = parts.map(Number);
  if (values.some((v) => !Number.isFinite(v) || v < 0)) return fail();

  if (parts.length === 2) {
    const [mm, ss] = values;
    if (mm >= 60 || ss >= 60) return fail();
    return mm * 60 + ss;
  }
  if (parts.length === 3) {
    const [hh, mm, ss] = values;
    if (mm >= 60 || ss >= 60) return fail();
    return hh * 3600 + mm * 60 + ss;
  }
  const [hh, mm, ss, ff] = values;
  if (mm >= 60 || ss >= 60) return fail();
  if (!Number.isInteger(ff) || ff < 0 || ff >= safeFps) return fail();
  return hh * 3600 + mm * 60 + ss + ff / safeFps;
}
