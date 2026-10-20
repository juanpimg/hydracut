import React from 'react';
import { Sliders } from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { ClipInspector } from './ClipInspector';

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
          <ClipInspector />
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
