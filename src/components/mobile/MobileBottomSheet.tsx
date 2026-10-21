import React, { useEffect, useId } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { IconButton } from '../ui/IconButton';
import { X } from 'lucide-react';

interface MobileBottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

/**
 * Hoja inferior del móvil (nunca paneles laterales): superficie plana
 * `overlay` con radio 8, sin gradientes ni desenfoques. Atrapa el foco y lo
 * devuelve al cerrar; `Esc` la cierra.
 */
export const MobileBottomSheet: React.FC<MobileBottomSheetProps> = ({
  isOpen,
  onClose,
  title,
  children
}) => {
  const titleId = useId();

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

  if (!isOpen) return null;

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
        data-sheet-content="true"
        className="relative bg-overlay border-t border-border rounded-t-lg shadow-overlay flex flex-col max-h-[60dvh] h-[52dvh] z-10 overflow-hidden pb-[env(safe-area-inset-bottom)]"
      >
        {/* Drag handle */}
        <div className="w-full flex justify-center pt-2 pb-1">
          <div className="w-10 h-1 bg-border rounded-sm" />
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
