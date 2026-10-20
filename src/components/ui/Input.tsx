import { forwardRef, type InputHTMLAttributes } from 'react';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/**
 * Campo de texto de 32 px: fondo `raised`, borde de 1 px, foco en acento
 * (anillo global). Reenvía `ref` y propaga el resto de props al nativo.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = '', type = 'text', ...rest },
  ref
) {
  return (
    <input
      ref={ref}
      type={type}
      className={`tabular h-8 w-full rounded border border-border bg-raised px-2 text-body text-text-1 transition placeholder:text-text-3 focus:border-accent disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...rest}
    />
  );
});
