import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { 
  RotateCcw, 
  RotateCw, 
  Sparkles, 
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

/** Width of the aspect-ratio menu, in px (kept in sync with `min-w-[130px]`). */
const ASPECT_MENU_WIDTH = 150;
/** Height of the aspect-ratio menu, in px (3 items × 44 px + padding). */
const ASPECT_MENU_HEIGHT = 142;

export const MobileHeader: React.FC = () => {
  const projectName = useProjectStore((s) => s.project.name);
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const setAspectRatio = useProjectStore((s) => s.setAspectRatio);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const canUndo = useProjectStore((s) => s.past.length > 0);
  const canRedo = useProjectStore((s) => s.future.length > 0);

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
    { id: '9:16', label: '9:16 Shorts/Reels', icon: <Smartphone size={14} /> },
    { id: '16:9', label: '16:9 Panorámico', icon: <Tv size={14} /> },
    { id: '1:1', label: '1:1 Cuadrado', icon: <Square size={14} /> },
  ];

  const handleAspectChange = (id: AspectRatio) => {
    setAspectRatio(id);
    closeAspectMenu(true);
    announce(`Relación de aspecto ${id}`);
  };

  return (
    // UI-04: `min-h-12` (instead of a fixed `h-12`) so that the safe-area
    // padding grows the bar instead of squeezing its content to 1 px.
    <header className="min-h-12 bg-dark-950/95 border-b border-dark-800/80 px-1.5 sm:px-3 flex items-center justify-between gap-1 z-30 select-none shrink-0 pt-[env(safe-area-inset-top)] overflow-x-auto no-scrollbar">
      {/* Left: Brand logo & Editable Name & Projects button */}
      <div className="flex items-center gap-1 min-w-0 shrink">
        <a 
          href="/" 
          className="w-9 h-9 min-w-[36px] min-h-[36px] rounded-lg bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white font-black text-xs shadow-md shrink-0 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title="Ir a HydraApps Hub"
          aria-label="Ir al hub de HydraApps"
        >
          H
        </a>
        <button
          onClick={() => setProjectsModalOpen(true)}
          className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-300 hover:text-white active:scale-95 transition shrink-0 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title="Mis Proyectos"
          aria-label="Mis Proyectos"
        >
          <FolderKanban size={18} className="text-cyan-400" />
        </button>
        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          aria-label="Nombre del proyecto"
          className="bg-transparent text-white font-semibold text-base sm:text-xs px-1 py-0.5 rounded outline-none focus:bg-dark-850 w-16 min-w-0 min-[400px]:w-28 truncate focus-visible:ring-2 focus-visible:ring-cyan-500"
          title="Renombrar proyecto"
        />
      </div>

      {/* Middle: Aspect Ratio Switcher & Undo/Redo */}
      <div className="flex items-center gap-1 shrink-0">
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
            className="flex items-center gap-1 px-2 min-h-[44px] bg-dark-850 hover:bg-dark-800 text-slate-300 rounded-md text-[11px] font-mono border border-dark-750 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Cambiar relación de aspecto"
          >
            {aspectRatio === '9:16' && <Smartphone size={12} className="text-cyan-400" />}
            {aspectRatio === '16:9' && <Tv size={12} className="text-cyan-400" />}
            {aspectRatio === '1:1' && <Square size={12} className="text-cyan-400" />}
            <span className="hidden min-[400px]:inline">{aspectRatio}</span>
          </button>
        </div>

        {/* Undo / Redo */}
        <div className="flex items-center bg-dark-850 rounded-md border border-dark-750 p-0.5">
          <button
            onClick={undo}
            disabled={!canUndo}
            aria-label="Deshacer"
            className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded active:scale-90 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none ${
              canUndo ? 'text-slate-200' : 'text-slate-600'
            }`}
            title="Deshacer"
          >
            <RotateCcw size={15} />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            aria-label="Rehacer"
            className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded active:scale-90 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none ${
              canRedo ? 'text-slate-200' : 'text-slate-600'
            }`}
            title="Rehacer"
          >
            <RotateCw size={15} />
          </button>
        </div>
      </div>

      {/* Right: Export Button */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={() => setShortcutsModalOpen(true)}
          aria-label="Atajos de teclado"
          className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-400 hover:text-slate-200 active:scale-90 transition hidden min-[400px]:flex focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title="Atajos"
        >
          <HelpCircle size={15} />
        </button>

        {/* Guía de inicio: reabre la bienvenida a propósito. */}
        <button
          onClick={() => setWelcomeOpen(true)}
          aria-label="Abrir guía de inicio"
          className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-400 hover:text-slate-200 active:scale-90 transition hidden min-[400px]:flex focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title="Guía de inicio"
          data-testid="mobile-guide-button"
        >
          <BookOpen size={15} />
        </button>

        <button
          onClick={() => setExportModalOpen(true)}
          aria-label="Exportar vídeo"
          className="flex items-center gap-1 px-2 min-[400px]:px-3 min-h-[44px] bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold text-xs rounded-lg shadow-md shadow-cyan-500/20 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:outline-none shrink-0"
        >
          <Sparkles size={12} className="animate-pulse" />
          <span className="hidden min-[400px]:inline">Exportar</span>
        </button>
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
              className="fixed z-[90] min-w-[130px] max-w-[calc(100vw-1rem)] overflow-y-auto bg-dark-900 border border-dark-750 shadow-xl rounded-lg p-1 flex flex-col gap-1 animate-scaleUp"
            >
              {aspectRatios.map((item) => (
                <button
                  key={item.id}
                  role="menuitemradio"
                  aria-checked={aspectRatio === item.id}
                  onClick={() => handleAspectChange(item.id)}
                  className={`flex items-center gap-2 px-2.5 min-h-[44px] rounded text-xs font-medium transition text-left focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none ${
                    aspectRatio === item.id
                      ? 'bg-cyan-500/20 text-cyan-300 font-bold'
                      : 'text-slate-300 hover:bg-dark-800'
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
