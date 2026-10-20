import React from 'react';
import { X, Keyboard } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { Button } from '../ui/Button';

interface Atajo {
  tecla: string;
  descripcion: string;
}

interface GrupoAtajos {
  titulo: string;
  atajos: Atajo[];
}

/**
 * Los atajos reflejan los manejadores REALES, en el mismo orden en que la
 * app los resuelve: portapapeles (`resolveClipboardShortcut` en
 * `layout/MainLayout.tsx` → `copyClips` / `pasteClips` / `duplicateClips`
 * del store) y seleccionar todo (`Ctrl+A` en `timeline/Timeline.tsx` →
 * `selectAllClips` del store, el mismo atajo que el botón «Seleccionar
 * todo»). Mantener esta lista sincronizada con esos ficheros.
 */
const GRUPOS: GrupoAtajos[] = [
  {
    titulo: 'Reproducción',
    atajos: [
      { tecla: 'Espacio', descripcion: 'Reproducir o pausar' },
      { tecla: '← / →', descripcion: 'Retroceder o avanzar 1 fotograma' },
      { tecla: 'Home', descripcion: 'Ir al inicio de la línea de tiempo' },
    ],
  },
  {
    titulo: 'Portapapeles y selección',
    atajos: [
      { tecla: 'Ctrl + C', descripcion: 'Copiar los clips seleccionados' },
      { tecla: 'Ctrl + V', descripcion: 'Pegar los clips copiados' },
      { tecla: 'Ctrl + D', descripcion: 'Duplicar los clips seleccionados' },
      { tecla: 'Ctrl + A', descripcion: 'Seleccionar todos los clips' },
    ],
  },
  {
    titulo: 'Edición',
    atajos: [
      { tecla: 'S', descripcion: 'Dividir el clip en el cabezal (S)' },
      { tecla: 'Supr / Backspace', descripcion: 'Eliminar el clip seleccionado' },
      { tecla: 'Ctrl + Z', descripcion: 'Deshacer última acción' },
      { tecla: 'Ctrl + Shift + Z', descripcion: 'Rehacer acción' },
      { tecla: 'Ctrl + Y', descripcion: 'Rehacer acción' },
    ],
  },
  {
    titulo: 'Vista y diálogo',
    atajos: [
      { tecla: 'Ctrl + Rueda', descripcion: 'Acercar o alejar la línea de tiempo' },
      { tecla: 'Esc', descripcion: 'Cerrar el diálogo o quitar la selección' },
    ],
  },
];

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

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Atajos de teclado"
      tabIndex={-1}
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 select-none focus:outline-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) setShortcutsModalOpen(false);
      }}
    >
      <div className="bg-raised border border-border rounded-lg w-full max-w-[560px] shadow-overlay overflow-hidden flex flex-col max-h-[560px]">
        {/* Cabecera */}
        <div className="px-3 py-2 border-b border-border-subtle flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Keyboard size={16} className="text-text-2" aria-hidden="true" />
            <h3 className="text-title text-text-1">Atajos de teclado</h3>
          </div>
          <button
            onClick={() => setShortcutsModalOpen(false)}
            aria-label="Cerrar"
            className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-text-2 transition hover:bg-overlay hover:text-text-1"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {/* Lista densa por áreas */}
        <div className="px-3 py-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
          {GRUPOS.map((grupo) => (
            <section key={grupo.titulo} aria-label={grupo.titulo}>
              <h4 className="text-caption uppercase tracking-wider text-text-3">
                {grupo.titulo}
              </h4>
              <ul className="flex flex-col">
                {grupo.atajos.map((atajo) => (
                  <li
                    key={atajo.tecla}
                    className="flex h-7 items-center justify-between gap-2 text-body-sm"
                  >
                    <span className="truncate text-text-2" title={atajo.descripcion}>{atajo.descripcion}</span>
                    <kbd className="tabular shrink-0 rounded border border-border bg-panel px-1.5 py-0.5 font-mono text-timecode text-text-1">
                      {atajo.tecla}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        {/* Pie */}
        <div className="px-3 py-2 border-t border-border-subtle flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShortcutsModalOpen(false)}
          >
            Cerrar
          </Button>
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
