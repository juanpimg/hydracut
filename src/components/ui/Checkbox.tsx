import type { ButtonHTMLAttributes } from 'react';
import { Check } from 'lucide-react';

export interface CheckboxProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  /** Estado marcado. */
  checked: boolean;
  /** Cambio de estado. */
  onChange: (checked: boolean) => void;
  /** Nombre accesible. OBLIGATORIO cuando no hay etiqueta visible. */
  'aria-label'?: string;
  /** Etiqueta visible a la derecha (en español). */
  label?: string;
}

/**
 * Casilla de 16 px: acento cuando está marcada, nada de color fuera del
 * token. Botón nativo con `role="checkbox"` (teclado gratuito).
 */
export function Checkbox({ checked, onChange, label, className = '', ...rest }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`inline-flex cursor-pointer items-center gap-2 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${checked ? 'border-accent bg-accent' : 'border-border bg-raised'}`}
      >
        {checked && <Check className="h-3 w-3 text-app" strokeWidth={3} />}
      </span>
      {label && <span className="text-body-sm text-text-2 select-none">{label}</span>}
    </button>
  );
}
