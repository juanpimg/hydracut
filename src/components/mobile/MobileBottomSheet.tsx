import React, { useEffect, useId, useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { IconButton } from '../ui/IconButton';
import { X } from 'lucide-react';

interface MobileBottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

/** Píxeles de arrastre (o velocidad en px/ms) que cierran la hoja. */
const UMBRAL_CIERRE_PX = 90;
const UMBRAL_VELOCIDAD_PX_MS = 0.5;

/**
 * Hoja inferior del móvil (nunca paneles laterales): superficie plana
 * `overlay` con radio 8, sin gradientes ni desenfoques. Atrapa el foco y lo
 * devuelve al cerrar; `Esc` la cierra.
 *
 * H5 · El asa es un gesto de verdad: arrastrarla hacia abajo traslada la
 * hoja con el puntero (captura + `touch-action: none`) y al soltar cierra
 * si supera el umbral de distancia o de velocidad; si no, vuelve con la
 * transición del sistema (150 ms).
 */
export const MobileBottomSheet: React.FC<MobileBottomSheetProps> = ({
  isOpen,
  onClose,
  title,
  children
}) => {
  const titleId = useId();
  const contenidoRef = useRef<HTMLDivElement>(null);
  const arrastreRef = useRef<{ inicioY: number; actualY: number; inicioT: number; activo: boolean }>({
    inicioY: 0,
    actualY: 0,
    inicioT: 0,
    activo: false,
  });

  // UI-08: the sheet declared `role="dialog" aria-modal="true"` but never
  // moved the focus inside, never trapped it and never restored it.
  const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, { onEscape: onClose });

  // Lock body scroll while open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Al reabrir, la hoja vuelve sin traslación residual del gesto anterior.
  useEffect(() => {
    if (isOpen && contenidoRef.current) {
      contenidoRef.current.style.transform = '';
      contenidoRef.current.style.transition = '';
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const pintarTraslacion = (dy: number) => {
    const hoja = contenidoRef.current;
    if (!hoja) return;
    hoja.style.transition = 'none';
    hoja.style.transform = `translateY(${Math.max(0, dy)}px)`;
  };

  const alSoltarAsa = () => {
    const hoja = contenidoRef.current;
    const arrastre = arrastreRef.current;
    if (!hoja || !arrastre.activo) return;
    arrastre.activo = false;
    const dy = arrastre.actualY - arrastre.inicioY;
    const dt = Math.max(1, Date.now() - arrastre.inicioT);
    const velocidad = dy / dt;
    if (dy >= UMBRAL_CIERRE_PX || velocidad >= UMBRAL_VELOCIDAD_PX_MS) {
      onClose();
      return;
    }
    hoja.style.transition = '';
    hoja.style.transform = '';
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="mobile-bottom-sheet"
      className="fixed inset-0 z-50 flex flex-col justify-end focus:outline-none"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 transition-opacity"
        onClick={onClose}
      />

      {/* Sheet Content */}
      <div
        ref={contenidoRef}
        data-sheet-content="true"
        className="relative bg-overlay border-t border-border rounded-t-lg shadow-overlay flex flex-col max-h-[60dvh] h-[52dvh] z-10 overflow-hidden pb-[env(safe-area-inset-bottom)]"
      >
        {/* Asa de arrastre: gesto real (puntero + velocidad), no decoración. */}
        <div
          className="w-full flex justify-center items-center pt-2 pb-1 min-h-[44px] touch-none cursor-grab active:cursor-grabbing"
          data-testid="sheet-drag-handle"
          role="button"
          tabIndex={0}
          aria-label="Arrastrar hacia abajo para cerrar"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            arrastreRef.current = {
              inicioY: e.clientY,
              actualY: e.clientY,
              inicioT: Date.now(),
              activo: true,
            };
          }}
          onPointerMove={(e) => {
            if (!arrastreRef.current.activo) return;
            arrastreRef.current.actualY = e.clientY;
            pintarTraslacion(e.clientY - arrastreRef.current.inicioY);
          }}
          onPointerUp={alSoltarAsa}
          onPointerCancel={alSoltarAsa}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onClose();
            }
          }}
        >
          <div aria-hidden="true" className="w-10 h-1 bg-border rounded-sm" />
        </div>

        {/* Sheet Header */}
        <div className="flex items-center justify-between px-4 py-1 border-b border-border-subtle shrink-0">
          <h3 id={titleId} className="text-title text-text-1">
            {title}
          </h3>
          <IconButton
            size="md"
            onClick={onClose}
            aria-label="Cerrar"
            title="Cerrar"
            className="min-h-[44px] min-w-[44px]"
          >
            <X size={17} />
          </IconButton>
        </div>

        {/* Sheet Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {children}
        </div>
      </div>
    </div>
  );
};
