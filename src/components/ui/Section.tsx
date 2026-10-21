import { useState, type ReactNode } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';

export interface SectionProps {
  /** Título de la sección en estilo `caption` (en español). */
  titulo: string;
  /** Contenido de la sección. */
  children: ReactNode;
  /** Abierta al montar. Por defecto `true`. */
  abiertaPorDefecto?: boolean;
  /** Si se da, muestra el botón de reset de la sección. */
  alRestablecer?: () => void;
  /** Etiqueta accesible del botón de reset. */
  etiquetaRestablecer?: string;
}

/**
 * Bloque de construcción del inspector: cabecera `caption` colapsable +
 * botón de reset opcional por sección. Regla: máx. 5 secciones visibles en
 * el inspector (lo impone la ola U1, no este componente).
 *
 * La sección colapsada SIGUE MONTADA (contenido con `hidden`, no
 * desmontado): la suite de navegador lee los controles por `data-testid`
 * aunque la sección esté cerrada, y desmontar obligaría a abrirlo todo.
 */
export function Section({
  titulo,
  children,
  abiertaPorDefecto = true,
  alRestablecer,
  etiquetaRestablecer = 'Restablecer sección',
}: SectionProps) {
  const [abierta, setAbierta] = useState(abiertaPorDefecto);
  const idContenido = `seccion-${titulo}`;

  return (
    <section className="border-b border-border-subtle">
      <header className="flex h-8 items-center gap-1 px-3">
        <button
          type="button"
          aria-expanded={abierta}
          aria-controls={idContenido}
          onClick={() => setAbierta((anterior) => !anterior)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
        >
          <ChevronDown
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 text-text-3 transition ${abierta ? '' : '-rotate-90'}`}
          />
          <span className="truncate text-caption uppercase tracking-wider text-text-2 select-none">
            {titulo}
          </span>
        </button>
        {alRestablecer && (
          <button
            type="button"
            onClick={alRestablecer}
            title={etiquetaRestablecer}
            aria-label={etiquetaRestablecer}
            className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-text-3 transition hover:bg-raised hover:text-text-1"
          >
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        )}
      </header>
      {/* Montada pero colapsada: `hidden` la saca del layout y de la
          lectura visual, pero los controles siguen en el DOM (la suite los
          lee por `data-testid` con la sección cerrada). */}
      <div id={idContenido} hidden={!abierta} className="space-y-2 px-3 pb-3">
        {children}
      </div>
    </section>
  );
}
