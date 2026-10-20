import React from 'react';
import { X, Keyboard } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export const ShortcutsModal: React.FC = () => {
  const { isShortcutsModalOpen, setShortcutsModalOpen } = useUIStore();

  /**
   * UI-08: the modal declared `role="dialog" aria-modal="true"` but the focus
   * never entered it (it had only 2 tabbable elements) and was never restored
   * on close. The focus trap also owns the `Escape` key.
   */
  const dialogRef = useFocusTrap<HTMLDivElement>(isShortcutsModalOpen, {
    onEscape: () => setShortcutsModalOpen(false),
  });

  if (!isShortcutsModalOpen) return null;

  /**
   * The bindings below mirror the REAL handlers, in the same order the app
   * resolves them: clipboard copy/paste/duplicate (`resolveClipboardShortcut`
   * in `layout/MainLayout.tsx` → `copyClips` / `pasteClips` /
   * `duplicateClips` of the store) and select-all (`Ctrl+A` in
   * `timeline/Timeline.tsx` → `selectAllClips` of the store, same shortcut as
   * the "Seleccionar todo" button). Keep this list in sync with those files.
   */
  const shortcuts = [
    { key: 'Espacio', desc: 'Reproducir / Pausar reproducción' },
    { key: 'S', desc: 'Cortar / Dividir clip en la posición del cabezal' },
    { key: 'Supr / Backspace', desc: 'Eliminar el clip seleccionado' },
    { key: '← / →', desc: 'Retroceder o avanzar 1 fotograma' },
    { key: 'Ctrl + C', desc: 'Copiar los clips seleccionados' },
    { key: 'Ctrl + V', desc: 'Pegar los clips copiados' },
    { key: 'Ctrl + D', desc: 'Duplicar los clips seleccionados' },
    { key: 'Ctrl + A', desc: 'Seleccionar todos los clips' },
    { key: 'Ctrl + Z', desc: 'Deshacer última acción' },
    { key: 'Ctrl + Shift + Z', desc: 'Rehacer acción' },
    { key: 'Ctrl + Y', desc: 'Rehacer acción' },
    { key: 'Ctrl + Rueda', desc: 'Zoom in / Zoom out en el timeline' },
    { key: 'Home', desc: 'Ir al inicio del timeline (00:00:00:00)' },
    { key: 'Esc', desc: 'Cerrar modal / Deseleccionar clip' },
  ];

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Atajos de teclado"
      tabIndex={-1}
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none animate-fadeIn focus:outline-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) setShortcutsModalOpen(false);
      }}
    >
      <div className="bg-dark-900 border border-dark-800 rounded-xl w-full max-w-sm shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-dark-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Keyboard size={18} className="text-blue-400" />
            <h3 className="text-sm font-bold text-white">Atajos de Teclado</h3>
          </div>
          <button
            onClick={() => setShortcutsModalOpen(false)}
            aria-label="Cerrar modal de atajos"
            className="text-slate-400 hover:text-white min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          >
            <X size={18} />
          </button>
        </div>

        {/* Shortcuts list */}
        <div className="p-5 space-y-2.5">
          {shortcuts.map((sc, idx) => (
            <div key={idx} className="flex items-center justify-between text-xs">
              <span className="text-slate-400">{sc.desc}</span>
              <kbd className="px-2 py-1 bg-dark-950 border border-dark-750 rounded text-slate-200 font-mono text-[11px] shadow-sm">
                {sc.key}
              </kbd>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-dark-800 flex justify-end bg-dark-950">
          <button
            onClick={() => setShortcutsModalOpen(false)}
            className="px-4 py-1.5 min-h-[44px] bg-dark-800 hover:bg-dark-750 text-white text-xs rounded-lg transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Default export for `React.lazy` (bundle splitting): the modal is loaded
 * on demand instead of being part of the initial chunk. The named export
 * stays for direct imports.
 */
export default ShortcutsModal;
