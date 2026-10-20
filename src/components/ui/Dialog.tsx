import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export interface DialogProps {
  /** Título del diálogo (en español, estilo `title`). */
  titulo: string;
  /** Descripción corta opcional bajo el título. */
  descripcion?: string;
  /** Contenido (corto: el diálogo estándar NO lleva scroll interno). */
  children: ReactNode;
  /** Acciones al pie (botones). */
  acciones?: ReactNode;
  /** Cierre (`Esc`, ✕ y telón). */
  onCerrar: () => void;
  /** Anchura máxima. Por defecto 440 px (siempre ≤ 560 px de alto). */
  ancho?: number;
}

/**
 * Diálogo estándar: máx. 560 px de alto, SIN scroll interno, `Esc` para
 * cerrar, trampa de foco + restauración (vía `useFocusTrap`), telón
 * `bg-black/60`. Regla: corto, con una acción clara.
 */
export function Dialog({ titulo, descripcion, children, acciones, onCerrar, ancho = 440 }: DialogProps) {
  // Trampa de foco + `Esc` + restauración del foco al disparador.
  const contenedorRef = useFocusTrap<HTMLDivElement>(true, { onEscape: onCerrar });
  const idTitulo = 'dialogo-titulo';
  const idDescripcion = 'dialogo-descripcion';

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(evento) => {
        if (evento.target === evento.currentTarget) onCerrar();
      }}
    >
      <div
        ref={contenedorRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={idTitulo}
        aria-describedby={descripcion ? idDescripcion : undefined}
        tabIndex={-1}
        className="flex max-h-[560px] w-full flex-col gap-3 rounded-lg border border-border bg-raised p-4 shadow-overlay"
        style={{ maxWidth: ancho }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={idTitulo} className="text-title text-text-1">
              {titulo}
            </h2>
            {descripcion && (
              <p id={idDescripcion} className="mt-0.5 text-body-sm text-text-2">
                {descripcion}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar diálogo"
            className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-text-2 transition hover:bg-overlay hover:text-text-1"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        <div>{children}</div>
        {acciones && <div className="flex items-center justify-end gap-2">{acciones}</div>}
      </div>
    </div>,
    document.body
  );
}
