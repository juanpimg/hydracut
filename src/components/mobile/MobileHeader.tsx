import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Download,
  Smartphone,
  Tv,
  Square,
  HelpCircle,
  BookOpen,
  FolderKanban
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import { AspectRatio } from '../../types/project';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import { moveFocusWithin } from '../../hooks/useFocusTrap';
import { announce } from '../layout/liveRegion';
import { Button } from '../ui/Button';

/** Width of the aspect-ratio menu, in px (kept in sync with `min-w-[130px]`). */
const ASPECT_MENU_WIDTH = 150;
/** Height of the aspect-ratio menu, in px (3 items × 44 px + padding). */
const ASPECT_MENU_HEIGHT = 142;

/**
 * Barra de la app en móvil (48 px, blancos de 44 px en todos los anchos):
 * marca · proyecto · aspecto · Exportar siempre visible a la derecha.
 * Deshacer/rehacer viven en la tira inferior para dejar sitio al nombre.
 *
 * Superficies planas con hairlines de 1 px, sin gradientes ni brillos. La
 * marca es el mismo distintivo plano del escritorio (`Header.tsx`): un
 * cuadrado con borde de 1 px y la letra H, sin gradiente.
 */
export const MobileHeader: React.FC = () => {
  const projectName = useProjectStore((s) => s.project.name);
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const setAspectRatio = useProjectStore((s) => s.setAspectRatio);

  const { setExportModalOpen, setShortcutsModalOpen, setProjectsModalOpen, setWelcomeOpen } = useUIStore();
  const [showAspectMenu, setShowAspectMenu] = useState(false);

  const aspectBtnRef = useRef<HTMLButtonElement>(null);
  const aspectMenuRef = useRef<HTMLDivElement>(null);

  const { position: aspectMenuPosition, update: updateAspectMenuPosition } = useAnchoredMenu(
    showAspectMenu,
    aspectBtnRef,
    {
      menuWidth: ASPECT_MENU_WIDTH,
      menuHeight: ASPECT_MENU_HEIGHT,
      align: 'center',
      preferredPlacement: 'bottom',
      gap: 6,
      padding: 8,
    }
  );

  const closeAspectMenu = useCallback((restoreFocus = true) => {
    setShowAspectMenu(false);
    if (restoreFocus) aspectBtnRef.current?.focus();
  }, []);

  const toggleAspectMenu = useCallback(() => {
    updateAspectMenuPosition();
    setShowAspectMenu((open) => !open);
  }, [updateAspectMenuPosition]);

  // Close the aspect dropdown on Escape and navigate it with the arrow keys
  useEffect(() => {
    if (!showAspectMenu) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeAspectMenu(true);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocusWithin(aspectMenuRef.current, '[role="menuitemradio"]', e.key === 'ArrowDown' ? 'next' : 'prev');
      }
    };
    window.addEventListener('keydown', onKey);

    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => {
            moveFocusWithin(aspectMenuRef.current, '[role="menuitemradio"]', 'first');
          })
        : null;
    if (raf === null) moveFocusWithin(aspectMenuRef.current, '[role="menuitemradio"]', 'first');

    return () => {
      window.removeEventListener('keydown', onKey);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [showAspectMenu, closeAspectMenu]);

  const aspectRatios: { id: AspectRatio; label: string; icon: React.ReactNode }[] = [
    { id: '9:16', label: '9:16 Vertical', icon: <Smartphone size={14} /> },
    { id: '16:9', label: '16:9 Panorámico', icon: <Tv size={14} /> },
    { id: '1:1', label: '1:1 Cuadrado', icon: <Square size={14} /> },
  ];

  const handleAspectChange = (id: AspectRatio) => {
    setAspectRatio(id);
    closeAspectMenu(true);
    announce(`Relación de aspecto ${id}`);
  };

  return (
    // Sin scroll ni fijados internos: la barra encaja en 320 px sin que nada
    // se pinte encima de nada (F1). El nombre siempre está visible y es
    // flexible con ellipsis. C1: cada blanco mide 44 px reales en todos los
    // anchos (sin compactar a 36/32 ni a 22–28 en apaisado); deshacer/rehacer
    // viven en la tira inferior, así el nombre conserva sitio a 320 px. Sin
    // `sticky` no hay superposición posible; con `overflow-hidden` el
    // documento nunca gana scroll horizontal por la cabecera.
    <header className="min-h-12 bg-panel border-b border-border-subtle px-1 flex items-center gap-0.5 z-30 select-none shrink-0 pt-[env(safe-area-inset-top)] overflow-hidden">
      {/* Marca plana y proyectos: siempre visibles, 44 px táctiles. */}
      <a
        href="/"
        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-border bg-raised px-2 shrink-0 transition hover:bg-overlay focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        title="Volver al Hub"
        aria-label="Volver al Hub"
      >
        {/* Marca plana: el mismo distintivo del escritorio, sin gradiente ni brillo. */}
        <span
          aria-hidden="true"
          className="flex h-5 w-5 items-center justify-center rounded-sm border border-border bg-panel text-[11px] font-black text-text-1"
        >
          H
        </span>
      </a>
      <button
        onClick={() => setProjectsModalOpen(true)}
        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-text-2 hover:text-text-1 active:scale-95 transition shrink-0 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        title="Proyectos"
        aria-label="Abrir proyectos"
      >
        <FolderKanban size={18} />
      </button>
      {/* Nombre del proyecto: flexible con ellipsis y sin mínimo que lo deje
          en «Mi …» a 320 px (M8); el campo mide 44 px de alto (C1). */}
      <div className="flex flex-1 min-w-0 items-center">
        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          aria-label="Nombre del proyecto"
          className="bg-transparent text-text-1 font-semibold text-sm px-1 py-0.5 rounded outline-none focus:bg-raised w-full min-w-0 min-h-[44px] truncate focus-visible:ring-2 focus-visible:ring-accent"
          title="Renombrar proyecto"
        />
      </div>

      {/* Relación de aspecto: siempre visible (M8); solo-icono bajo 400 px,
          con 44 px de alto y el área de golpe de la primitiva. */}
      <div className="shrink-0">
        {/* Aspect Ratio Button & Dropdown (portaled: the header is clipped in
            landscape, audit UI-03) */}
        <div className="relative">
          <button
            ref={aspectBtnRef}
            onClick={toggleAspectMenu}
            aria-expanded={showAspectMenu}
            aria-haspopup="true"
            aria-controls="mobile-aspect-menu"
            aria-label={`Relación de aspecto: ${aspectRatio}. Cambiar`}
            data-testid="mobile-aspect-button"
            className="flex items-center gap-1 px-2 min-h-[44px] bg-raised hover:bg-overlay text-text-2 rounded text-[11px] font-mono border border-border active:scale-95 transition focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            title="Cambiar relación de aspecto"
          >
            {aspectRatio === '9:16' && <Smartphone size={12} aria-hidden="true" />}
            {aspectRatio === '16:9' && <Tv size={12} aria-hidden="true" />}
            {aspectRatio === '1:1' && <Square size={12} aria-hidden="true" />}
            <span className="hidden min-[400px]:inline">{aspectRatio}</span>
          </button>
        </div>
      </div>

      {/* Deshacer/rehacer viven en la tira inferior (C1): así la cabecera
          deja sitio al nombre a 320 px sin compactar ningún blanco. */}

      {/* Derecha: ayuda, guía y exportar (siempre visibles, sin fijados:
          nada se pinta encima de nada). */}
      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        <button
          onClick={() => setShortcutsModalOpen(true)}
          aria-label="Atajos de teclado"
          className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-text-2 hover:text-text-1 active:scale-90 transition hidden min-[560px]:flex focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          title="Atajos de teclado"
        >
          <HelpCircle size={15} />
        </button>

        {/* Guía de inicio: reabre la bienvenida a propósito. */}
        <button
          onClick={() => setWelcomeOpen(true)}
          aria-label="Abrir guía de inicio"
          className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-text-2 hover:text-text-1 active:scale-90 transition hidden min-[560px]:flex focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          title="Guía de inicio"
          data-testid="mobile-guide-button"
        >
          <BookOpen size={15} />
        </button>

        {/* Exportar: etiqueta visible siempre, sin icono pulsante.
            Altura real de 44 px en todos los anchos (C1): se compacta el
            relleno, nunca la altura. */}
        <Button
          variant="primary"
          size="lg"
          icon={<Download size={14} aria-hidden="true" />}
          onClick={() => setExportModalOpen(true)}
          aria-label="Abrir modal de exportación de vídeo"
          title="Exportar vídeo"
          data-testid="export-open-button"
          className="min-h-[44px] shrink-0 font-bold max-[559px]:px-3 max-[559px]:text-body"
        >
          Exportar
        </Button>
      </div>

      {/* The aspect menu lives in a portal: in landscape the header wrapper has
          `overflow: hidden` and used to clip it completely (audit UI-03). */}
      {showAspectMenu &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[80]"
              onClick={() => closeAspectMenu(false)}
              aria-hidden="true"
              data-testid="mobile-aspect-backdrop"
            />
            <div
              ref={aspectMenuRef}
              id="mobile-aspect-menu"
              role="menu"
              aria-label="Relación de aspecto"
              data-testid="mobile-aspect-menu"
              style={{
                top: `${aspectMenuPosition?.top ?? 0}px`,
                left: `${aspectMenuPosition?.left ?? 0}px`,
                maxHeight: aspectMenuPosition ? `${aspectMenuPosition.maxHeight}px` : undefined,
              }}
              className="fixed z-[90] min-w-[130px] max-w-[calc(100vw-1rem)] overflow-y-auto bg-overlay border border-border shadow-overlay rounded-lg p-1 flex flex-col gap-1"
            >
              {aspectRatios.map((item) => (
                <button
                  key={item.id}
                  role="menuitemradio"
                  aria-checked={aspectRatio === item.id}
                  onClick={() => handleAspectChange(item.id)}
                  className={`flex items-center gap-2 px-2.5 min-h-[44px] rounded text-xs font-medium transition text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                    aspectRatio === item.id
                      ? 'bg-accent-soft text-accent font-bold'
                      : 'text-text-2 hover:bg-raised'
                  }`}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </header>
  );
};
