import React, { useEffect } from 'react';
import { X, Keyboard } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';

export const ShortcutsModal: React.FC = () => {
  const { isShortcutsModalOpen, setShortcutsModalOpen } = useUIStore();

  // Close on Escape or backdrop click (effect before early-return: hooks order)
  useEffect(() => {
    if (!isShortcutsModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShortcutsModalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isShortcutsModalOpen, setShortcutsModalOpen]);

  if (!isShortcutsModalOpen) return null;

  const shortcuts = [
    { key: 'Espacio', desc: 'Reproducir / Pausar reproducción' },
    { key: 'S', desc: 'Cortar / Dividir clip en la posición del cabezal' },
    { key: 'Supr / Backspace', desc: 'Eliminar el clip seleccionado' },
    { key: '← / →', desc: 'Retroceder o avanzar 1 fotograma' },
    { key: 'Ctrl + Z', desc: 'Deshacer última acción' },
    { key: 'Ctrl + Shift + Z', desc: 'Rehacer acción' },
    { key: 'Ctrl + Y', desc: 'Rehacer acción' },
    { key: 'Ctrl + Rueda', desc: 'Zoom in / Zoom out en el timeline' },
    { key: 'Home', desc: 'Ir al inicio del timeline (00:00:00:00)' },
    { key: 'Esc', desc: 'Cerrar modal / Deseleccionar clip' },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Atajos de teclado"
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none animate-fadeIn"
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
            className="text-slate-400 hover:text-white p-1 rounded-lg transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
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
            className="px-4 py-1.5 bg-dark-800 hover:bg-dark-750 text-white text-xs rounded-lg transition"
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
};
