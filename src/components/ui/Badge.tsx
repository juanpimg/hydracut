import type { ReactNode } from 'react';

/** Tono del badge. Regla: nunca decorativo, solo estado real. */
export type BadgeVariant = 'neutral' | 'accent' | 'danger' | 'warning' | 'success';

export interface BadgeProps {
  /** Tono. Por defecto `neutral`. */
  variant?: BadgeVariant;
  /** Contenido corto (una o dos palabras). */
  children: ReactNode;
  /** Clases extra (solo layout). */
  className?: string;
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: 'border border-border bg-raised text-text-2',
  accent: 'bg-accent-soft text-accent',
  danger: 'bg-danger/15 text-danger',
  warning: 'bg-warning/15 text-warning',
  success: 'bg-success/15 text-success',
};

/**
 * Insignia pequeña (20 px): nunca como color decorativo de estado rutinario.
 */
export function Badge({ variant = 'neutral', children, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center rounded px-1.5 text-caption font-medium whitespace-nowrap select-none ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
