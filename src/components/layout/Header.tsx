import React from 'react';
import {
  RotateCcw,
  RotateCw,
  HelpCircle,
  BookOpen,
  Smartphone,
  Tv,
  Square,
  Download,
  FolderKanban,
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import { AspectRatio } from '../../types/project';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Tooltip } from '../ui/Tooltip';
import { HistorialCambios } from './HistoryPanel';

/**
 * Barra de la app (40 px): marca · proyecto · relación de aspecto ·
 * deshacer/rehacer · Exportar a la derecha.
 *
 * Superficies planas con hairlines de 1 px, sin gradientes ni brillos. El
 * botón de exportar va al extremo derecho (posición universal) y su etiqueta
 * visible no promete un formato (se elige en el diálogo).
 */
export const Header: React.FC = () => {
  const projectName = useProjectStore((s) => s.project.name);
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio);
  const project = useProjectStore((s) => s.project);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const setAspectRatio = useProjectStore((s) => s.setAspectRatio);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const canUndo = useProjectStore((s) => s.past.length > 0);
  const canRedo = useProjectStore((s) => s.future.length > 0);

  // UI-29: suscripción a los campos individuales, no a todo el store.
  const setExportModalOpen = useUIStore((s) => s.setExportModalOpen);
  const setShortcutsModalOpen = useUIStore((s) => s.setShortcutsModalOpen);
  const setProjectsModalOpen = useUIStore((s) => s.setProjectsModalOpen);
  const setWelcomeOpen = useUIStore((s) => s.setWelcomeOpen);

  return (
    <header className="flex h-10 min-w-0 items-center justify-between gap-2 overflow-x-auto border-b border-border-subtle bg-panel px-3 no-scrollbar select-none">
      {/* Izquierda: marca y proyecto */}
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => {
            const hasWork = project.clips.length > 0;
            if (
              !hasWork ||
              confirm('¿Volver al Hub? El proyecto queda guardado en este navegador.')
            ) {
              window.location.href = '/';
            }
          }}
          className="flex h-8 items-center gap-2 rounded border border-border bg-raised px-2 text-sm font-bold text-text-1 transition hover:bg-overlay"
          title="Volver al Hub"
          aria-label="Volver al Hub"
        >
          {/* Marca plana: cuadrado con borde de 1 px, sin gradiente ni brillo. */}
          <span
            aria-hidden="true"
            className="flex h-5 w-5 items-center justify-center rounded-sm border border-border bg-panel text-[11px] font-black text-text-1"
          >
            H
          </span>
          <span className="hidden tracking-tight sm:inline">
            Hydra<span className="text-accent">Cut</span>
          </span>
          <span className="hidden rounded-sm border border-border px-1 py-0.5 font-mono text-[9px] font-semibold tracking-wider text-text-3 uppercase md:inline">
            Studio
          </span>
        </button>

        <div aria-hidden="true" className="h-5 w-px shrink-0 bg-border-subtle" />

        <button
          onClick={() => setProjectsModalOpen(true)}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded border border-border bg-raised px-2.5 text-xs font-semibold text-text-1 transition hover:bg-overlay"
          title="Abrir proyectos"
          aria-label="Abrir proyectos"
        >
          <FolderKanban size={15} className="text-text-2" aria-hidden="true" />
          <span className="hidden sm:inline">Proyectos</span>
        </button>

        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          aria-label="Nombre del proyecto"
          className="w-32 truncate rounded border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-text-2 transition outline-none hover:bg-raised focus:border-border focus:bg-raised focus:text-text-1 sm:w-44 sm:text-body md:w-52"
          title="Renombrar proyecto"
        />
      </div>

      {/* Centro: relación de aspecto y deshacer/rehacer */}
      <div className="mx-2 flex shrink-0 items-center gap-2">
        <SegmentedControl<AspectRatio>
          ariaLabel="Relación de aspecto del proyecto"
          name="relacion-aspecto"
          value={aspectRatio}
          onChange={setAspectRatio}
          options={[
            { value: '16:9', label: '16:9', icon: <Tv size={14} aria-hidden="true" /> },
            { value: '9:16', label: '9:16', icon: <Smartphone size={14} aria-hidden="true" /> },
            { value: '1:1', label: '1:1', icon: <Square size={14} aria-hidden="true" /> },
          ]}
        />

        <div aria-hidden="true" className="mx-0.5 hidden h-5 w-px shrink-0 bg-border-subtle sm:block" />

        <div className="flex items-center gap-1 rounded border border-border-subtle bg-panel p-1">
          <Tooltip content="Deshacer (Ctrl+Z)">
            <IconButton
              size="sm"
              onClick={undo}
              disabled={!canUndo}
              aria-label="Deshacer (Ctrl+Z)"
              title="Deshacer (Ctrl+Z)"
            >
              <RotateCcw size={14} aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <Tooltip content="Rehacer (Ctrl+Y)">
            <IconButton
              size="sm"
              onClick={redo}
              disabled={!canRedo}
              aria-label="Rehacer (Ctrl+Y)"
              title="Rehacer (Ctrl+Y)"
            >
              <RotateCw size={14} aria-hidden="true" />
            </IconButton>
          </Tooltip>
          {/* W-G · Historial visible: lista la pila con etiquetas humanas y
              salta a cualquier punto (solo lectura del `past`/`future`). */}
          <HistorialCambios />
        </div>
      </div>

      {/* Derecha: ayuda, guía y exportar (siempre al extremo derecho) */}
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip content="Atajos de teclado">
          <IconButton
            size="sm"
            onClick={() => setShortcutsModalOpen(true)}
            aria-label="Atajos de teclado"
            title="Atajos de teclado"
          >
            <HelpCircle size={16} aria-hidden="true" />
          </IconButton>
        </Tooltip>

        {/* Guía de inicio: reabre la bienvenida a propósito (es de primer
            arranque y ya no se muestra sola al recargar). */}
        <Tooltip content="Guía de inicio">
          <IconButton
            size="sm"
            onClick={() => setWelcomeOpen(true)}
            aria-label="Abrir guía de inicio"
            title="Guía de inicio"
            data-testid="header-guide-button"
          >
            <BookOpen size={16} aria-hidden="true" />
          </IconButton>
        </Tooltip>

        {/* Botón primario de exportar (la etiqueta no promete un formato). */}
        <Button
          variant="primary"
          size="sm"
          icon={<Download size={14} aria-hidden="true" />}
          onClick={() => setExportModalOpen(true)}
          aria-label="Exportar vídeo"
          title="Exportar vídeo"
          data-testid="export-open-button"
          className="ml-1 shrink-0 font-bold"
        >
          Exportar vídeo
        </Button>
      </div>
    </header>
  );
};
