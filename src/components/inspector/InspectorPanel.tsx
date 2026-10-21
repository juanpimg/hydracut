import React, { Suspense, lazy, useEffect } from 'react';
import { Sliders } from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';

/**
 * División del bundle inicial: el inspector (~95 KB de fuentes) solo tiene
 * sentido con un clip seleccionado, así que vive en su propio chunk. En el
 * arranque sin selección ni siquiera se descarga.
 */
const ClipInspector = lazy(() => import('./ClipInspector'));

/**
 * Esqueleto del inspector: ocupa EXACTAMENTE la misma caja que el
 * `ClipInspector` real (misma raíz `flex h-full min-h-0 flex-col
 * overflow-y-auto`, misma cabecera con borde inferior, misma tarjeta de
 * resumen) para que la carga del chunk nunca desplace el layout: sin
 * desbordamiento horizontal, sin cambios en la altura del visor.
 *
 * Solo bloques pulsantes sin texto (`aria-hidden`): ningún lector de
 * pantalla anuncia contenido provisional y ninguna comprobación de
 * geometría puede ver una caja distinta.
 */
const ClipInspectorFallback: React.FC = () => (
  <div
    aria-hidden="true"
    className="flex h-full min-h-0 flex-col overflow-y-auto bg-panel select-none"
  >
    <div className="mb-0 flex items-center justify-between border-b border-border-subtle px-3 pt-3 pb-2">
      <div className="h-5 w-40 animate-pulse rounded bg-raised" />
      <div className="flex gap-0.5">
        <div className="h-6 w-6 animate-pulse rounded bg-raised" />
        <div className="h-6 w-6 animate-pulse rounded bg-raised" />
      </div>
    </div>
    <div className="mx-3 mt-3 space-y-2 rounded border border-border-subtle bg-raised p-2.5">
      <div className="h-4 w-full animate-pulse rounded bg-overlay" />
      <div className="h-4 w-3/4 animate-pulse rounded bg-overlay" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-overlay" />
    </div>
    <div className="mx-3 mt-3 h-24 rounded border border-border-subtle bg-raised p-2.5">
      <div className="h-4 w-1/2 animate-pulse rounded bg-overlay" />
    </div>
  </div>
);

/**
 * Columna derecha del Inspector (300 px, siempre presente).
 *
 * Aloja el `ClipInspector` cuando hay un clip seleccionado y un estado
 * vacío explícito cuando no lo hay: la columna nunca queda en blanco.
 */
export const InspectorPanel: React.FC = () => {
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const selectedClipIds = useProjectStore((s) => s.selectedClipIds);
  const hasSelection = selectedClipIds.length > 0 || selectedClipId !== null;

  /**
   * Precalentamiento del chunk del inspector tras el primer pintado: la
   * selección de un clip lo necesita de inmediato (la suite de navegador lo
   * interroga sin espera intermedia), así que se descarga en segundo plano
   * en cuanto el arranque lo permite. No forma parte del payload inicial:
   * el efecto corre después del pintado y React no lo espera.
   */
  useEffect(() => {
    void import('./ClipInspector');
  }, []);

  return (
    <aside
      data-testid="inspector-panel"
      aria-label="Inspector"
      className="flex h-full min-h-0 w-[300px] shrink-0 flex-col border-l border-border-subtle bg-panel select-none"
    >
      <div className="flex h-8 shrink-0 items-center border-b border-border-subtle px-3">
        <h2 className="truncate text-caption font-medium tracking-wider text-text-2 uppercase select-none">
          Inspector
        </h2>
      </div>
      <div className="min-h-0 flex-1">
        {hasSelection ? (
          <Suspense fallback={<ClipInspectorFallback />}>
            <ClipInspector />
          </Suspense>
        ) : (
          <div
            data-testid="inspector-empty"
            className="flex h-full flex-col items-center justify-center p-6 text-center"
          >
            <Sliders size={32} className="mb-2 text-text-3" strokeWidth={1} aria-hidden="true" />
            <p className="text-body-sm font-semibold text-text-1">Ningún clip seleccionado</p>
            <p className="mt-1 text-body-sm text-text-2">
              Selecciona un clip de la línea de tiempo para editarlo.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
};
