import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface TooltipProps {
  /** Texto del tooltip (en español, 12 px). */
  content: string;
  /** Elemento que lo dispara (debe aceptar foco para el teclado). */
  children: ReactNode;
  /** Retardo de aparición en ms. Por defecto 400. */
  delay?: number;
  /** Lado preferido. Por defecto `top` (invierte si no cabe). */
  side?: 'top' | 'bottom';
}

/**
 * Tooltip en portal: fondo `overlay`, borde de 1 px, texto de 12 px,
 * retardo de 400 ms. Aparece con hover Y con foco (teclado), se oculta con
 * `Esc`. Regla: todo `IconButton` con icono ambiguo va envuelto en uno.
 */
export function Tooltip({ content, children, delay = 400, side = 'top' }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [posicion, setPosicion] = useState({ top: 0, left: 0, colocarArriba: side === 'top' });
  const disparadorRef = useRef<HTMLSpanElement>(null);
  const temporizador = useRef<number | null>(null);
  const id = useId();

  const cancelar = useCallback(() => {
    if (temporizador.current !== null) {
      window.clearTimeout(temporizador.current);
      temporizador.current = null;
    }
  }, []);

  const mostrarConRetardo = () => {
    cancelar();
    temporizador.current = window.setTimeout(() => {
      const ancla = disparadorRef.current?.getBoundingClientRect();
      if (!ancla) return;
      // Se mide tras montar: primero se muestra y el efecto recoloca.
      const colocarArriba =
        side === 'top' ? ancla.top >= 48 : window.innerHeight - ancla.bottom < 48;
      setPosicion({
        top: colocarArriba ? ancla.top : ancla.bottom,
        left: ancla.left + ancla.width / 2,
        colocarArriba,
      });
      setVisible(true);
    }, delay);
  };

  const ocultar = () => {
    cancelar();
    setVisible(false);
  };

  useEffect(() => cancelar, [cancelar]);

  useEffect(() => {
    if (!visible) return;
    const alPulsarEscape = (evento: KeyboardEvent) => {
      if (evento.key === 'Escape') {
        cancelar();
        setVisible(false);
      }
    };
    document.addEventListener('keydown', alPulsarEscape);
    return () => document.removeEventListener('keydown', alPulsarEscape);
  }, [visible, cancelar]);

  return (
    <>
      <span
        ref={disparadorRef}
        aria-describedby={visible ? id : undefined}
        onMouseEnter={mostrarConRetardo}
        onMouseLeave={ocultar}
        onFocus={mostrarConRetardo}
        onBlur={ocultar}
        className="inline-flex"
      >
        {children}
      </span>
      {visible &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            aria-hidden="true"
            className={`pointer-events-none fixed z-[200] max-w-56 -translate-x-1/2 rounded border border-border bg-overlay px-2 py-1 text-body-sm text-text-1 shadow-overlay ${posicion.colocarArriba ? '-translate-y-full -mt-1.5' : 'mt-1.5'}`}
            style={{ top: posicion.top, left: Math.max(72, posicion.left) }}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  );
}
