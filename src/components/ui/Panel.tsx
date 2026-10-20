import type { ReactNode } from 'react';

export interface PanelProps {
  /** Cabecera de panel en estilo `caption` (mayúsculas, en español). */
  caption?: string;
  /** Acciones a la derecha de la cabecera. */
  actions?: ReactNode;
  /** Contenido del panel. */
  children: ReactNode;
  /** Clases extra (solo layout: el fondo y el borde los fija el sistema). */
  className?: string;
}

/**
 * Panel: fondo `panel` + borde inferior `border-subtle`, con fila de
 * cabecera `caption` opcional. El bloque de construcción de bins y la
 * línea de tiempo.
 */
export function Panel({ caption, actions, children, className = '' }: PanelProps) {
  return (
    <section className={`border-b border-border-subtle bg-panel ${className}`}>
      {caption && (
        <header className="flex h-8 items-center justify-between gap-2 px-3">
          <h2 className="truncate text-caption uppercase tracking-wider text-text-2 select-none">
            {caption}
          </h2>
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
