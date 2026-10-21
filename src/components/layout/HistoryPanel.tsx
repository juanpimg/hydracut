/**
 * W-G · Historial visible de deshacer/rehacer.
 *
 * Vista de SOLO LECTURA del historial del store: lee `past` / `future` y
 * salta con los `undo()` / `redo()` existentes (en bucle, sin tocar el
 * store). Nunca es una segunda fuente de verdad: no copia estados, no
 * reordena nada, no inventa etiquetas internas.
 *
 * Las etiquetas son humanas («Añadir clip», no el nombre de la acción) y se
 * infieren por diferencia entre instantáneas consecutivas
 * (`describeHistoryChange`, pura y probada en `guides-history.test.ts`).
 *
 * NOTA PARA EL DUEÑO DEL STORE (`src/store/useProjectStore.ts`): cuando el
 * store exponga etiquetas reales y salto directo, este panel debe usarlos.
 * API pedida (ver el informe): `historyLabels: string[]` y
 * `jumpToHistoryIndex(indice: number) => void`.
 */
import React, { useMemo, useRef, useState } from 'react';
import { History } from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import type { Clip, MediaItem, Track, TrashEntry } from '../../types/project';
import { IconButton } from '../ui/IconButton';
import { Menu, MenuItem, MenuSeparador } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { announce } from './liveRegion';

/** Instantánea mínima para describir un cambio (subconjunto de `HistoryState`). */
export interface HistorySnapshot {
  tracks: Track[];
  clips: Clip[];
  mediaPool: MediaItem[];
  trash?: TrashEntry[];
  selectedClipIds?: string[];
}

export type HistoryEntryKind = 'pasado' | 'actual' | 'futuro';

export interface HistoryEntry {
  /** Valor de `past.length` al que corresponde este estado (objetivo del salto). */
  indice: number;
  etiqueta: string;
  tipo: HistoryEntryKind;
}

export interface HistoryJumpPlan {
  undos: number;
  redos: number;
}

function porId<T extends { id: string }>(lista: T[]): Map<string, T> {
  return new Map(lista.map((e) => [e.id, e]));
}

function igualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Etiqueta del cambio de UN clip (misma id, alguna propiedad distinta). */
function etiquetaCambioDeClip(antes: Clip, despues: Clip): string | null {
  if (antes.volume !== despues.volume) return 'Cambiar volumen';
  if (antes.opacity !== despues.opacity) return 'Cambiar opacidad';
  if (antes.speed !== despues.speed || antes.preservePitch !== despues.preservePitch) {
    return 'Cambiar velocidad';
  }
  if (antes.muted !== despues.muted) {
    return despues.muted ? 'Silenciar clip' : 'Activar sonido del clip';
  }
  if (antes.start !== despues.start || antes.trackId !== despues.trackId) return 'Mover clip';
  if (
    antes.duration !== despues.duration ||
    antes.sourceStart !== despues.sourceStart ||
    antes.sourceDuration !== despues.sourceDuration
  ) {
    return 'Recortar clip';
  }
  if (antes.text !== despues.text) return 'Editar texto';
  if (!igualJson(antes.textStyle, despues.textStyle) || !igualJson(antes.words, despues.words)) {
    return 'Cambiar estilo de texto';
  }
  if (!igualJson(antes.keyframes, despues.keyframes)) return 'Editar keyframes';
  if (!igualJson(antes.audioFadeIn, despues.audioFadeIn) || !igualJson(antes.audioFadeOut, despues.audioFadeOut)) {
    return 'Cambiar fundido de audio';
  }
  if (!igualJson(antes.audioEffects, despues.audioEffects)) return 'Cambiar efectos de audio';
  if (!igualJson(antes.transition, despues.transition)) return 'Cambiar fundido';
  if (!igualJson(antes.filters, despues.filters)) return 'Cambiar color';
  if (antes.name !== despues.name) return 'Renombrar clip';
  if (antes.mediaId !== despues.mediaId) return 'Revincular medio';
  return null;
}

/** Un clip dividido en dos contiguos que cubren el mismo tramo. */
function esDivision(antes: Clip, a: Clip, b: Clip): boolean {
  const margen = 1e-6;
  const [primero, segundo] = a.start <= b.start ? [a, b] : [b, a];
  return (
    primero.trackId === antes.trackId &&
    segundo.trackId === antes.trackId &&
    Math.abs(primero.start - antes.start) < margen &&
    Math.abs(primero.start + primero.duration - segundo.start) < margen &&
    Math.abs(segundo.start + segundo.duration - (antes.start + antes.duration)) < margen
  );
}

function describirClips(antes: HistorySnapshot, despues: HistorySnapshot): string | null {
  const mapaAntes = porId(antes.clips);
  const mapaDespues = porId(despues.clips);
  const anadidos = despues.clips.filter((c) => !mapaAntes.has(c.id));
  const borrados = antes.clips.filter((c) => !mapaDespues.has(c.id));

  if (anadidos.length === 1 && borrados.length === 2 && esDivision(borrados[0], anadidos[0], anadidos[1])) {
    return 'Dividir clip';
  }
  // Caso simétrico (orden de borrados no garantizado).
  if (anadidos.length === 2 && borrados.length === 1 && esDivision(borrados[0], anadidos[0], anadidos[1])) {
    return 'Dividir clip';
  }
  if (anadidos.length > 0 && borrados.length === 0) {
    return anadidos.length === 1 ? 'Añadir clip' : `Añadir ${anadidos.length} clips`;
  }
  if (borrados.length > 0 && anadidos.length === 0) {
    return borrados.length === 1 ? 'Borrar clip' : `Borrar ${borrados.length} clips`;
  }
  if (anadidos.length > 0 || borrados.length > 0) return 'Editar clips';

  const etiquetas = new Map<string, number>();
  for (const clipAntes of antes.clips) {
    const clipDespues = mapaDespues.get(clipAntes.id);
    if (!clipDespues) continue;
    const etiqueta = etiquetaCambioDeClip(clipAntes, clipDespues);
    if (etiqueta) etiquetas.set(etiqueta, (etiquetas.get(etiqueta) ?? 0) + 1);
  }
  if (etiquetas.size === 0) return null;
  if (etiquetas.size === 1) {
    const [etiqueta, n] = [...etiquetas.entries()][0];
    return n === 1 ? etiqueta : `${etiqueta} (${n} clips)`;
  }
  return 'Editar clips';
}

function describirPistas(antes: HistorySnapshot, despues: HistorySnapshot): string | null {
  const mapaAntes = porId(antes.tracks);
  const mapaDespues = porId(despues.tracks);
  const anadidas = despues.tracks.filter((t) => !mapaAntes.has(t.id));
  const borradas = antes.tracks.filter((t) => !mapaDespues.has(t.id));
  if (anadidas.length > 0 && borradas.length === 0) {
    return anadidas.length === 1 ? 'Añadir pista' : `Añadir ${anadidas.length} pistas`;
  }
  if (borradas.length > 0 && anadidas.length === 0) {
    return borradas.length === 1 ? 'Eliminar pista' : `Eliminar ${borradas.length} pistas`;
  }
  if (anadidas.length > 0 || borradas.length > 0) return 'Editar pistas';
  // Mismo conjunto: ¿cambió el orden?
  const ordenAntes = antes.tracks.map((t) => t.id).join(',');
  const ordenDespues = despues.tracks.map((t) => t.id).join(',');
  for (const pistaAntes of antes.tracks) {
    const pistaDespues = mapaDespues.get(pistaAntes.id);
    if (!pistaDespues) continue;
    if (pistaAntes.isMuted !== pistaDespues.isMuted) {
      return pistaDespues.isMuted ? 'Silenciar pista' : 'Activar sonido de pista';
    }
    if (pistaAntes.isLocked !== pistaDespues.isLocked) {
      return pistaDespues.isLocked ? 'Bloquear pista' : 'Desbloquear pista';
    }
    if (pistaAntes.isVisible !== pistaDespues.isVisible) {
      return pistaDespues.isVisible ? 'Mostrar pista' : 'Ocultar pista';
    }
    if (pistaAntes.role !== pistaDespues.role) return 'Cambiar rol de pista';
    if (pistaAntes.name !== pistaDespues.name) return 'Renombrar pista';
  }
  if (ordenAntes !== ordenDespues) return 'Reordenar pistas';
  return null;
}

function describirMedios(antes: HistorySnapshot, despues: HistorySnapshot): string | null {
  const poolAntes = new Set(antes.mediaPool.map((m) => m.id));
  const poolDespues = new Set(despues.mediaPool.map((m) => m.id));
  const papeleraAntes = new Set((antes.trash ?? []).map((e) => e.media.id));
  const papeleraDespues = new Set((despues.trash ?? []).map((e) => e.media.id));

  const alPool = [...poolDespues].filter((id) => !poolAntes.has(id));
  const delPool = [...poolAntes].filter((id) => !poolDespues.has(id));
  const aPapelera = [...papeleraDespues].filter((id) => !papeleraAntes.has(id));
  const dePapelera = [...papeleraAntes].filter((id) => !papeleraDespues.has(id));

  const movidosAPapelera = delPool.filter((id) => aPapelera.includes(id));
  const restaurados = alPool.filter((id) => dePapelera.includes(id));

  if (movidosAPapelera.length > 0 && alPool.length === movidosAPapelera.length && dePapelera.length === 0) {
    return movidosAPapelera.length === 1 ? 'Mover medio a la papelera' : 'Mover medios a la papelera';
  }
  if (restaurados.length > 0 && delPool.length === 0 && aPapelera.length === 0) {
    return restaurados.length === 1 ? 'Restaurar medio' : 'Restaurar medios';
  }
  if (alPool.length > 0 && delPool.length === 0) {
    return alPool.length === 1 ? 'Importar medio' : `Importar ${alPool.length} medios`;
  }
  if (dePapelera.length > 0 && alPool.length === 0) return 'Vaciar papelera';

  // Mismo conjunto pero cambió el estado de algún medio (ausente, error…).
  const mapaAntes = porId(antes.mediaPool);
  for (const medioDespues of despues.mediaPool) {
    const medioAntes = mapaAntes.get(medioDespues.id);
    if (medioAntes && medioAntes.status !== medioDespues.status) {
      return medioDespues.status === 'missing' || medioDespues.status === 'error'
        ? 'Marcar medio ausente'
        : 'Actualizar medio';
    }
  }
  if (alPool.length > 0 || delPool.length > 0 || aPapelera.length > 0 || dePapelera.length > 0) {
    return 'Editar medios';
  }
  return null;
}

/**
 * Etiqueta humana del paso `antes → después` (pura, sin el store).
 * `antes === null` es el fondo del historial (estado inicial).
 */
export function describeHistoryChange(antes: HistorySnapshot | null, despues: HistorySnapshot): string {
  if (antes === null) return 'Estado inicial';
  return (
    describirClips(antes, despues) ??
    describirPistas(antes, despues) ??
    describirMedios(antes, despues) ??
    'Sin cambios'
  );
}

/**
 * Plan de salto con la API existente: cuántos `undo()` / `redo()` hacen falta
 * para pasar de `pastLength` a `targetPastLength`. El objetivo se recorta a
 * `[0, pastLength + futureLength]`.
 */
export function planHistoryJump(
  pastLength: number,
  targetPastLength: number,
  futureLength: number = 0
): HistoryJumpPlan {
  const total = Math.max(0, pastLength + Math.max(0, futureLength));
  const objetivo = Math.min(total, Math.max(0, targetPastLength));
  if (objetivo <= pastLength) return { undos: pastLength - objetivo, redos: 0 };
  return { undos: 0, redos: objetivo - pastLength };
}

/**
 * Lista cronológica pasado → actual → futuro. Cada entrada lleva el
 * `past.length` al que corresponde (el objetivo del salto) y su etiqueta
 * (la acción que llevó a ese estado).
 */
export function buildHistoryEntries(
  past: HistorySnapshot[],
  current: HistorySnapshot,
  future: HistorySnapshot[]
): HistoryEntry[] {
  const entradas: HistoryEntry[] = past.map((estado, i) => ({
    indice: i,
    etiqueta: i === 0 ? 'Estado inicial' : describeHistoryChange(past[i - 1], estado),
    tipo: 'pasado' as HistoryEntryKind,
  }));
  const anterior = past.length > 0 ? past[past.length - 1] : null;
  entradas.push({
    indice: past.length,
    etiqueta: anterior ? describeHistoryChange(anterior, current) : 'Estado inicial',
    tipo: 'actual',
  });
  let previo: HistorySnapshot = current;
  future.forEach((estado, j) => {
    entradas.push({
      indice: past.length + 1 + j,
      etiqueta: describeHistoryChange(previo, estado),
      tipo: 'futuro',
    });
    previo = estado;
  });
  return entradas;
}

/**
 * Botón del historial para la barra de la app: abre el menú con la pila
 * (pasado → actual → futuro) y salta al estado elegido. Teclado completo
 * vía `Menu` (flechas / Inicio / Fin / `Esc`).
 */
export const HistorialCambios: React.FC = () => {
  const pasado = useProjectStore((s) => s.past);
  const futuro = useProjectStore((s) => s.future);
  const proyecto = useProjectStore((s) => s.project);
  const [abierto, setAbierto] = useState(false);
  const anclaRef = useRef<HTMLButtonElement>(null);

  const entradas = useMemo(
    () => buildHistoryEntries(pasado, proyecto, futuro),
    [pasado, proyecto, futuro]
  );

  const etiquetaBoton = `Historial de cambios (${pasado.length} para deshacer, ${futuro.length} para rehacer)`;

  const saltarA = (entrada: HistoryEntry) => {
    const { undos, redos } = planHistoryJump(pasado.length, entrada.indice, futuro.length);
    const estado = useProjectStore.getState();
    for (let i = 0; i < undos; i++) estado.undo();
    for (let i = 0; i < redos; i++) estado.redo();
    announce(`Historial: ${entrada.etiqueta}`);
  };

  return (
    <>
      <Tooltip content={etiquetaBoton}>
        <IconButton
          ref={anclaRef}
          size="sm"
          onClick={() => setAbierto((v) => !v)}
          aria-label={etiquetaBoton}
          title={etiquetaBoton}
          aria-expanded={abierto}
          aria-haspopup="menu"
        >
          <History size={14} aria-hidden="true" />
        </IconButton>
      </Tooltip>
      <Menu
        ancla={anclaRef}
        abierto={abierto}
        onCerrar={() => setAbierto(false)}
        ariaLabel="Historial de cambios"
        anchoMinimo={248}
      >
        <div className="px-2.5 pt-1.5 pb-1 select-none">
          <p className="text-body font-semibold text-text-1">Historial</p>
          <p className="text-body-sm text-text-2">
            {pasado.length} para deshacer · {futuro.length} para rehacer
          </p>
        </div>
        <MenuSeparador />
        <div className="max-h-64 overflow-y-auto p-1 pt-0">
          {entradas.length <= 1 && pasado.length === 0 && futuro.length === 0 ? (
            <MenuItem disabled>Sin cambios todavía</MenuItem>
          ) : (
            entradas.map((entrada) =>
              entrada.tipo === 'actual' ? (
                <MenuItem key={entrada.indice} disabled aria-current="true" atajo="actual">
                  {entrada.etiqueta}
                </MenuItem>
              ) : (
                <MenuItem
                  key={`${entrada.tipo}-${entrada.indice}`}
                  onClick={() => saltarA(entrada)}
                  atajo={entrada.tipo === 'futuro' ? 'rehacer' : undefined}
                >
                  {entrada.etiqueta}
                </MenuItem>
              )
            )
          )}
        </div>
      </Menu>
    </>
  );
};
