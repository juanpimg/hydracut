import React, { useEffect, useId } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface MobileBottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

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
        className="fixed inset-0 bg-black/70 transition-opacity animate-fadeIn"
        onClick={onClose}
      />

      {/* Sheet Content */}
      <div 
        data-sheet-content="true"
        className="relative bg-dark-900 border-t border-dark-750 rounded-t-2xl shadow-2xl flex flex-col max-h-[60dvh] h-[52dvh] z-10 overflow-hidden pb-[env(safe-area-inset-bottom)] animate-slideUp"
      >
        {/* Drag handle pill */}
        <div className="w-full flex justify-center pt-2 pb-1">
          <div className="w-10 h-1 bg-dark-700 rounded-full" />
        </div>

        {/* Sheet Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-dark-800 shrink-0">
          <h3 id={titleId} className="text-sm font-bold text-white tracking-wide">
            {title}
          </h3>
          <button
            onClick={onClose}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-400 hover:text-white bg-dark-850 hover:bg-dark-800 rounded-full transition active:scale-95 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Cerrar"
            aria-label="Cerrar panel"
          >
            <X size={17} />
          </button>
        </div>

        {/* Sheet Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {children}
        </div>
      </div>
    </div>
  );
};
