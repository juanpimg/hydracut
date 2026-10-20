import type { ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  /** Valor de la opción. */
  value: T;
  /** Etiqueta visible (en español). */
  label: string;
  /** Icono opcional delante de la etiqueta. */
  icon?: ReactNode;
  /** Deshabilita solo esta opción. */
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** Opciones mutuamente excluyentes (de 1 a 4). */
  options: Array<SegmentedOption<T>>;
  /** Opción seleccionada. */
  value: T;
  /** Cambio de selección. */
  onChange: (value: T) => void;
  /** Etiqueta accesible del grupo (p. ej. «Relación de aspecto»). */
  ariaLabel: string;
  /** Nombre del grupo de radios nativos. */
  name?: string;
  /** Deshabilita el grupo entero. */
  disabled?: boolean;
}

/**
 * Sustituto de los grupos de botones llenos (formato, resolución, fps,
 * rango). Cada opción es un radio nativo: una opción = un `aria-checked`
 * dentro de un `radiogroup`, con teclado gratuito (flechas, Tab).
 * Regla: la opción activa usa `accent-soft` + `text-accent`, nunca un
 * relleno sólido de acento.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  name,
  disabled = false,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className="inline-flex items-center gap-1 rounded bg-panel border border-border-subtle p-1"
    >
      {options.map((option) => {
        const checked = option.value === value;
        const optionDisabled = disabled || option.disabled;
        return (
          <label
            key={option.value}
            className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded px-2.5 text-body-sm transition select-none ${optionDisabled ? 'cursor-not-allowed opacity-40' : ''}`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              disabled={optionDisabled}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className={`inline-flex h-full items-center gap-1.5 rounded px-2.5 -mx-2.5 transition ${checked ? 'bg-accent-soft text-accent font-medium' : 'text-text-2'} ${optionDisabled ? '' : 'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent peer-focus-visible:outline-offset-1'} ${checked || optionDisabled ? '' : 'hover:text-text-1'}`}
            >
              {option.icon}
              {option.label}
            </span>
          </label>
        );
      })}
    </div>
  );
}
