import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

/** Variante visual del botón. Regla: una familia por función, sin ad-hoc. */
export type ButtonVariant = 'ghost' | 'secondary' | 'primary' | 'danger';
/** Tamaño: 28 px en filas densas, 32 px por defecto, 36 px en transporte. */
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Variante visual. Por defecto `secondary`. */
  variant?: ButtonVariant;
  /** Tamaño del control. Por defecto `md` (32 px). */
  size?: ButtonSize;
  /** Icono a la izquierda de la etiqueta. */
  icon?: ReactNode;
  /** Estado de carga: muestra una rueda y bloquea el clic. */
  loading?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // Acción terciaria: solo texto, sin fondo hasta el hover.
  ghost: 'text-text-2 hover:bg-raised hover:text-text-1',
  // Acción por defecto: superficie elevada con borde de 1 px.
  secondary: 'bg-raised border border-border text-text-1 hover:bg-overlay',
  // Acción principal: relleno de acento (mismo tono, un peso menos).
  primary: 'bg-accent-fill text-white hover:brightness-110',
  // Acción destructiva: semántico de peligro, nunca decorativo.
  danger: 'bg-danger text-white hover:brightness-110',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-body-sm gap-1.5',
  md: 'h-8 px-3 text-body gap-2',
  lg: 'h-9 px-4 text-body-lg gap-2',
};

/**
 * Botón de la familia única de botones (radio 4, sin gradientes ni brillos).
 * Reenvía `ref` y propaga el resto de props al `<button>` nativo.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading = false, disabled, children, className = '', type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center rounded font-medium transition select-none disabled:opacity-40 disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
});
