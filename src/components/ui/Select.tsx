import { forwardRef, type SelectHTMLAttributes } from 'react';

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/**
 * Desplegable de 32 px: fondo `raised`, borde de 1 px, foco en acento
 * (anillo global). Reenvía `ref` y propaga el resto de props al nativo.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className = '', children, ...rest },
  ref
) {
  return (
    <select
      ref={ref}
      className={`h-8 w-full cursor-pointer rounded border border-border bg-raised px-2 text-body text-text-1 transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-40 [&>option]:bg-raised ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
});
