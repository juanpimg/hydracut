import { forwardRef, type ButtonHTMLAttributes } from 'react';

export interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  /** Estado latched. */
  pressed: boolean;
  /** Cambio de estado. */
  onChange: (pressed: boolean) => void;
  /** Etiqueta visible a la derecha (en español). */
  label?: string;
}

/**
 * Interruptor con estado activo persistente (`accent-soft` + pastilla de
 * acento). ÚNICO uso legítimo de `rounded-full` en el sistema: la pastilla
 * diminuta del toggle. Nativo por teclado (Espacio/Intro) vía `<button>`,
 * con `aria-checked`. Reenvía `ref`.
 */
export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { pressed, onChange, label, className = '', type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      role="switch"
      aria-checked={pressed}
      onClick={() => onChange(!pressed)}
      className={`inline-flex cursor-pointer items-center gap-2 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border px-0.5 transition ${pressed ? 'justify-end border-accent bg-accent-soft' : 'justify-start border-border bg-raised'}`}
      >
        <span
          className={`h-3.5 w-3.5 rounded-full transition ${pressed ? 'bg-accent' : 'bg-text-3'}`}
        />
      </span>
      {label && <span className="text-body-sm text-text-2 select-none">{label}</span>}
    </button>
  );
});
