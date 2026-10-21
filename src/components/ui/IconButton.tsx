import { forwardRef, type ButtonHTMLAttributes } from 'react';

/** Tamaño: 28 px en filas densas, 32 px por defecto. */
export type IconButtonSize = 'sm' | 'md';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Nombre accesible del botón. OBLIGATORIO: un icono solo nunca se explica. */
  'aria-label': string;
  /** Tamaño del control. Por defecto `md` (32 px). */
  size?: IconButtonSize;
  /** Estilo activo persistente (modo latched): fondo de acento suave. */
  active?: boolean;
}

const SIZE_CLASSES: Record<IconButtonSize, string> = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
};

/**
 * Botón solo-icono (radio 4, sin gradientes ni brillos).
 * Regla: siempre con `aria-label` + `title` (tooltip nativo); para el tooltip
 * con estilo y retardo de 400 ms, envolver con `Tooltip`.
 *
 * Táctil (C2): con puntero grueso un `::after` invisible expande el área de
 * golpe a 44 px como mínimo (`-inset-3` sobre el tamaño visual), sin mover
 * el trazado: el glifo y la caja visual no cambian en el escritorio.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ size = 'md', active = false, className = '', type = 'button', ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        aria-pressed={active || undefined}
        className={`relative inline-flex items-center justify-center rounded text-text-2 transition select-none disabled:opacity-40 disabled:cursor-not-allowed hover:bg-raised hover:text-text-1 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3 [@media(pointer:coarse)]:after:content-[''] ${active ? 'bg-accent-soft text-accent' : ''} ${SIZE_CLASSES[size]} ${className}`}
        {...rest}
      />
    );
  }
);
