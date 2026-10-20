import type { ReactNode } from 'react';

export interface FieldProps {
  /** Etiqueta del control (en español). */
  etiqueta: string;
  /** Control (Input, Select, Slider…). */
  children: ReactNode;
  /** Pista opcional bajo el control (unidades, formato esperado…). */
  pista?: string;
  /** Id del control para vincular la etiqueta. */
  htmlFor?: string;
  /** Marca el campo como obligatorio (asterisco + `aria-required` visual). */
  requerido?: boolean;
}

/**
 * Fila de formulario del inspector: etiqueta + control + pista opcional.
 * Regla: la etiqueta SIEMPRE nombra al control (nunca un placeholder solo).
 */
export function Field({ etiqueta, children, pista, htmlFor, requerido = false }: FieldProps) {
  const idPista = pista && htmlFor ? `${htmlFor}-pista` : undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-body-sm text-text-2 select-none">
        {etiqueta}
        {requerido && (
          <span aria-hidden="true" className="ml-0.5 text-danger">
            *
          </span>
        )}
      </label>
      {children}
      {pista && (
        <p id={idPista} className="text-body-sm text-text-3">
          {pista}
        </p>
      )}
    </div>
  );
}
