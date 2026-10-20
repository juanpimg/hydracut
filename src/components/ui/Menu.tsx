import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { moveFocusWithin } from '../../hooks/useFocusTrap';

/** Selector de los ítems navegables del menú. */
const ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Etiqueta (en español): nombra su acción («Dividir clip»). */
  children: ReactNode;
  /** Icono a la izquierda. */
  icon?: ReactNode;
  /** Atajo visible a la derecha (p. ej. «S»). */
  atajo?: string;
  /** Ítem destructivo (semántico de peligro). */
  danger?: boolean;
}

/**
 * Ítem de menú: 32 px, etiqueta obligatoria. El icono solo nunca basta.
 */
export function MenuItem({ children, icon, atajo, danger = false, className = '', type = 'button', ...rest }: MenuItemProps) {
  return (
    <button
      type={type}
      role="menuitem"
      className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded px-2.5 text-left text-body transition select-none disabled:cursor-not-allowed disabled:opacity-40 ${danger ? 'text-danger hover:bg-danger/15' : 'text-text-1 hover:bg-raised'} focus-visible:bg-raised ${className}`}
      {...rest}
    >
      {icon && <span aria-hidden="true" className="inline-flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {atajo && (
        <kbd aria-hidden="true" className="tabular shrink-0 font-mono text-timecode text-text-3">
          {atajo}
        </kbd>
      )}
    </button>
  );
}

export interface MenuProps {
  /** Ref del disparador: el menú se ancla bajo él y le devuelve el foco. */
  ancla: RefObject<HTMLElement>;
  /** Visibilidad. */
  abierto: boolean;
  /** Cierre (clic fuera, `Esc` o selección). */
  onCerrar: () => void;
  /** Ítems (`MenuItem`) y separadores (`MenuSeparador`). */
  children: ReactNode;
  /** Etiqueta accesible del menú. */
  ariaLabel: string;
  /** Anchura mínima. Por defecto 192 px. */
  anchoMinimo?: number;
}

/** Separador entre grupos de ítems. */
export function MenuSeparador() {
  return <div role="separator" aria-hidden="true" className="mx-2 my-1 border-t border-border-subtle" />;
}

/**
 * Menú en portal: fondo `overlay`, sombra única, clic-fuera + `Esc`,
 * navegación por teclado (flechas / Inicio / Fin / Intro). El foco entra al
 * primer ítem al abrir y vuelve al disparador al cerrar.
 */
export function Menu({ ancla, abierto, onCerrar, children, ariaLabel, anchoMinimo = 192 }: MenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [posicion, setPosicion] = useState({ top: 0, left: 0 });

  // Colocación: bajo el disparador, alineado al final; invierte si no cabe.
  useLayoutEffect(() => {
    if (!abierto) return;
    const rect = ancla.current?.getBoundingClientRect();
    if (!rect) return;
    const altoEstimado = 240;
    const cabeDebajo = rect.bottom + 8 + altoEstimado <= window.innerHeight;
    setPosicion({
      top: cabeDebajo ? rect.bottom + 4 : Math.max(8, rect.top - 8 - altoEstimado),
      left: Math.max(8, Math.min(rect.right - anchoMinimo, window.innerWidth - anchoMinimo - 8)),
    });
  }, [abierto, ancla, anchoMinimo]);

  // Foco inicial al primer ítem.
  useEffect(() => {
    if (!abierto) return;
    const temporizador = window.setTimeout(() => {
      moveFocusWithin(menuRef.current, ITEM_SELECTOR, 'first');
    }, 0);
    return () => window.clearTimeout(temporizador);
  }, [abierto]);

  // Clic-fuera + `Esc` (con devolución del foco al disparador).
  useEffect(() => {
    if (!abierto) return;
    const alPunteroAbajo = (evento: PointerEvent) => {
      const objetivo = evento.target as Node | null;
      if (menuRef.current?.contains(objetivo)) return;
      if (ancla.current?.contains(objetivo)) return;
      onCerrar();
    };
    const alTeclado = (evento: KeyboardEvent) => {
      if (evento.key === 'Escape') {
        evento.preventDefault();
        evento.stopPropagation();
        onCerrar();
        ancla.current?.focus?.();
        return;
      }
      if (!menuRef.current?.contains(document.activeElement)) return;
      if (evento.key === 'ArrowDown') {
        evento.preventDefault();
        moveFocusWithin(menuRef.current, ITEM_SELECTOR, 'next');
      } else if (evento.key === 'ArrowUp') {
        evento.preventDefault();
        moveFocusWithin(menuRef.current, ITEM_SELECTOR, 'prev');
      } else if (evento.key === 'Home') {
        evento.preventDefault();
        moveFocusWithin(menuRef.current, ITEM_SELECTOR, 'first');
      } else if (evento.key === 'End') {
        evento.preventDefault();
        moveFocusWithin(menuRef.current, ITEM_SELECTOR, 'last');
      }
    };
    document.addEventListener('pointerdown', alPunteroAbajo);
    document.addEventListener('keydown', alTeclado, true);
    return () => {
      document.removeEventListener('pointerdown', alPunteroAbajo);
      document.removeEventListener('keydown', alTeclado, true);
    };
  }, [abierto, ancla, onCerrar]);

  if (!abierto || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      className="fixed z-[250] rounded-md border border-border bg-overlay p-1 shadow-overlay"
      style={{ top: posicion.top, left: posicion.left, minWidth: anchoMinimo }}
      onClick={(evento) => {
        // Cierra al elegir un ítem (salvo que el ítem lo impida).
        if ((evento.target as HTMLElement).closest(ITEM_SELECTOR)) onCerrar();
      }}
    >
      {children}
    </div>,
    document.body
  );
}
