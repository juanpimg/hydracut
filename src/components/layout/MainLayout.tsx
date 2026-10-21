import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { InspectorPanel } from '../inspector/InspectorPanel';
import { PreviewPlayer } from '../player/PreviewPlayer';
import { PlayerControls } from '../player/PlayerControls';
import { Timeline } from '../timeline/Timeline';
import { WelcomeModal } from '../modals/WelcomeModal';
import { MobileCapCutLayout } from '../mobile/MobileCapCutLayout';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useProjectStore, resolveDeleteKind } from '../../store/useProjectStore';
import { useUIStore } from '../../store/useUIStore';
import { masterClock } from '../../core/engine/MasterClock';
import { loadAutosavedProject, rehydrateProjectMedia } from '../../core/storage/projectStorage';
import { useLiveAnnouncement, announce } from './liveRegion';

/**
 * F3 / B-10: the export modal (and with it the exporter and `mp4-muxer`) is
 * loaded ON DEMAND.
 *
 * The modal used to be part of the initial chunk even though it is useless
 * until the user exports something: ~5 KB gzip of dead weight on EVERY boot.
 * `React.lazy` splits it into its own chunk, which is only fetched when the
 * modal is opened for the first time.
 */
const ExportModal = lazy(() => import('../export/ExportModal'));

/**
 * Bundle audit: `ProjectsModal` (~31 KB of sources) and `ShortcutsModal`
 * are only needed when the user opens them, so they live in their own
 * chunks. Both return `null` while closed and render as fixed overlays, so
 * a `null` fallback can never shift the layout. `WelcomeModal` stays eager:
 * it is open on the first boot and the boot sequence dismisses it as soon
 * as it is present.
 */
const ProjectsModal = lazy(() => import('../modals/ProjectsModal'));
const ShortcutsModal = lazy(() => import('../modals/ShortcutsModal'));

/**
 * F7: the clipboard shortcut of a keyboard event.
 */
export type ClipboardShortcut = 'copy' | 'paste' | 'duplicate';

/**
 * True when the given element is a text entry (an `<input>`, a `<textarea>`, a
 * `<select>` or a `contenteditable` region).
 *
 * The clipboard shortcuts must NOT hijack the system clipboard while the user
 * is typing: `Ctrl+C` inside a text field has to copy the selected text.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element !== 'object') return false;
  const tag = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (element.isContentEditable === true) return true;
  const editable =
    typeof element.getAttribute === 'function' ? element.getAttribute('contenteditable') : null;
  return editable !== null && editable !== 'false';
}

/**
 * Resolves the clipboard shortcut (F7) of a keyboard event.
 *
 * Returns `null` when the event is not a clipboard shortcut (no modifier, an
 * `Alt` combination or an unknown key).
 */
export function resolveClipboardShortcut(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): ClipboardShortcut | null {
  if (!event.ctrlKey && !event.metaKey) return null;
  if (event.altKey) return null;
  switch (event.key.toLowerCase()) {
    case 'c':
      return 'copy';
    case 'v':
      return 'paste';
    case 'd':
      return 'duplicate';
    default:
      return null;
  }
}

/**
 * Resolves the clip ids a clipboard shortcut (F7) must operate on.
 *
 * The keyboard shortcuts operate on the WHOLE multi-selection
 * (`selectedClipIds`), falling back to the primary clip (`selectedClipId`)
 * when the selection is empty. A defensive copy is returned so callers can
 * never mutate the store array.
 */
export function resolveClipboardIds(
  selectedClipIds: string[],
  selectedClipId: string | null
): string[] {
  if (selectedClipIds.length > 0) return [...selectedClipIds];
  return selectedClipId ? [selectedClipId] : [];
}

/**
 * F7: the refusals of the store must be VISIBLE.
 *
 * The store publishes two failure signals:
 * - `lastError`: the last action was refused (a locked track, an illegal
 *   overlap, an incompatible track…). Without a banner the user only sees
 *   that "nothing happened", which is indistinguishable from a broken app
 *   (B-08).
 * - `storageError`: the project could NOT be written to the disk. The work is
 *   not safe and the user has to know it (S-08).
 *
 * The banner is rendered by `MainLayout` in BOTH layouts (desktop and
 * mobile), so a refusal is never invisible.
 */
export const StoreErrorBanner: React.FC = () => {
  const lastError = useProjectStore((s) => s.lastError);
  const storageError = useProjectStore((s) => s.storageError);
  const clearLastError = useProjectStore((s) => s.clearLastError);
  const clearStorageError = useProjectStore((s) => s.clearStorageError);

  if (!lastError && !storageError) return null;

  return (
    <div
      data-testid="store-error-banner"
      className="fixed top-16 right-3 z-[120] w-[min(26rem,calc(100vw-1.5rem))] space-y-2 select-none pointer-events-none"
    >
      {storageError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded border border-danger/60 bg-overlay px-3 py-2 text-[11px] leading-tight text-text-1"
        >
          <span className="flex-1">{storageError.message}</span>
          <button
            type="button"
            onClick={clearStorageError}
            aria-label="Cerrar aviso"
            className="pointer-events-auto shrink-0 rounded px-1 text-text-2 hover:text-text-1"
          >
            ✕
          </button>
        </div>
      )}
      {lastError && (
        <div
          role="alert"
          data-testid="store-last-error"
          className="flex items-start gap-2 rounded border border-warning/50 bg-overlay px-3 py-2 text-[11px] leading-tight text-text-1"
        >
          <span className="flex-1">{lastError}</span>
          <button
            type="button"
            onClick={clearLastError}
            aria-label="Cerrar aviso"
            className="pointer-events-auto shrink-0 rounded px-1 text-text-2 hover:text-text-1"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * Altura de la línea de tiempo: 280–360 px redimensionable, mínimo 200.
 *
 * Se guarda en `localStorage` (con resguardo ante modo privado) para que el
 * ajuste sobreviva a la recarga.
 */
const TIMELINE_HEIGHT_DEFAULT = 320;
const TIMELINE_HEIGHT_MIN = 200;
const TIMELINE_HEIGHT_MAX = 360;
const TIMELINE_HEIGHT_KEY = 'hydracut.timelineHeight';

function clampTimelineHeight(value: number): number {
  if (!Number.isFinite(value)) return TIMELINE_HEIGHT_DEFAULT;
  return Math.min(TIMELINE_HEIGHT_MAX, Math.max(TIMELINE_HEIGHT_MIN, value));
}

function readTimelineHeight(): number {
  try {
    const raw = window.localStorage.getItem(TIMELINE_HEIGHT_KEY);
    if (raw === null) return TIMELINE_HEIGHT_DEFAULT;
    return clampTimelineHeight(Number(raw));
  } catch {
    return TIMELINE_HEIGHT_DEFAULT;
  }
}

export const MainLayout: React.FC = () => {
  const splitAtPlayhead = useProjectStore((s) => s.splitAtPlayhead);
  const deleteSelectedClip = useProjectStore((s) => s.deleteSelectedClip);
  const rippleDeleteClip = useProjectStore((s) => s.rippleDeleteClip);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const fps = useProjectStore((s) => s.project.fps);
  const loadProject = useProjectStore((s) => s.loadProject);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const selectedClipName = useProjectStore((s) =>
    s.selectedClipId ? s.project.clips.find((c) => c.id === s.selectedClipId)?.name : undefined
  );

  const announcement = useLiveAnnouncement();

  /**
   * F3: the export modal is only mounted (and its chunk only fetched) when it
   * is actually open. The flag is subscribed to with a selector so the shell
   * does not re-render on every UI store change.
   */
  const isExportModalOpen = useUIStore((s) => s.isExportModalOpen);
  const isProjectsModalOpen = useUIStore((s) => s.isProjectsModalOpen);
  const isShortcutsModalOpen = useUIStore((s) => s.isShortcutsModalOpen);

  // Load autosaved project on startup
  useEffect(() => {
    loadAutosavedProject().then(async (saved) => {
      if (saved && saved.clips && saved.tracks) {
        const rehydrated = await rehydrateProjectMedia(saved);
        loadProject(rehydrated);
      }
    });
  }, [loadProject]);

  // UI-16: announce the selected clip to the screen readers.
  useEffect(() => {
    if (!selectedClipId) return;
    if (!selectedClipName) return;
    announce(`Clip seleccionado: ${selectedClipName}`);
  }, [selectedClipId, selectedClipName]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input, textarea, select or a
      // contenteditable region (the system clipboard must keep working there).
      if (isTextEntryTarget(document.activeElement)) {
        // Still allow Escape to blur out of fields
        if (e.key === 'Escape') {
          (document.activeElement as HTMLElement)?.blur();
        }
        return;
      }

      const ui = useUIStore.getState();
      const anyModalOpen =
        ui.isExportModalOpen || ui.isProjectsModalOpen || ui.isShortcutsModalOpen || ui.isWelcomeOpen;

      // Escape: ProjectsModal and ExportModal own their staged dismissal
      // (confirm steps / render guard) via their local handlers — only the
      // shortcuts modal is closed from here. Local overlays (track ⋮ menu,
      // aspect menu, bottom sheets) also own their Escape: if one is in the
      // DOM, let it close without also wiping tool/selection in the same press.
      if (e.key === 'Escape') {
        if (ui.isShortcutsModalOpen) ui.setShortcutsModalOpen(false);
        else if (!anyModalOpen) {
          const localOverlayOpen =
            typeof document !== 'undefined' &&
            !!document.querySelector('[role="menu"], [data-sheet-content="true"]');
          if (!localOverlayOpen) {
            if (ui.activeTool === 'split') ui.setActiveTool('select');
            else useProjectStore.getState().selectClip(null);
          }
        }
        return;
      }

      // Never trigger editing shortcuts while a modal is open
      if (anyModalOpen) return;

      // Space: Play / Pause
      if (e.code === 'Space') {
        e.preventDefault();
        masterClock.togglePlay();
        return;
      }

      // 'S' or 's': Split clip at playhead
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        splitAtPlayhead();
        return;
      }

      // P0-1 · Supr/Retroceso: el criterio vive en el store
      // (`resolveDeleteKind`): Mayús+Supr/Retroceso es ripple delete (borra y
      // cierra el hueco, como en Premiere/Resolve) y Supr solo es el borrado
      // simple de siempre.
      const claseBorrado = resolveDeleteKind(e);
      if (claseBorrado) {
        e.preventDefault();
        if (claseBorrado === 'ripple') {
          const id = useProjectStore.getState().selectedClipId;
          if (id) rippleDeleteClip(id);
        } else {
          deleteSelectedClip();
        }
        return;
      }

      // ArrowLeft: Step back 1 frame
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        masterClock.stepFrame(-1, fps);
        return;
      }

      // ArrowRight: Step forward 1 frame
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        masterClock.stepFrame(1, fps);
        return;
      }

      // Home: Seek to 0
      if (e.key === 'Home') {
        e.preventDefault();
        masterClock.seek(0);
        return;
      }

      // Ctrl + Z: Undo / Redo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }

      // Ctrl + Y: Redo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redo();
        return;
      }

      // F7: Ctrl/Cmd + C / V / D → copy / paste / duplicate the whole
      // multi-selection (falling back to the primary clip when it is empty).
      const clipboardShortcut = resolveClipboardShortcut(e);
      if (clipboardShortcut) {
        const state = useProjectStore.getState();
        const selectedIds = resolveClipboardIds(state.selectedClipIds, state.selectedClipId);
        let acted = false;

        if (clipboardShortcut === 'copy') {
          if (selectedIds.length === 0) return;
          const copied = state.copyClips(selectedIds);
          if (copied > 0) {
            acted = true;
            announce(
              copied === 1
                ? 'Clip copiado: usa Ctrl+V para pegarlo'
                : `${copied} clips copiados: usa Ctrl+V para pegarlos`
            );
          }
        } else if (clipboardShortcut === 'paste') {
          const pasted = state.pasteClips();
          if (pasted.length > 0) {
            acted = true;
            announce(pasted.length === 1 ? 'Clip pegado' : `${pasted.length} clips pegados`);
          }
        } else {
          const duplicated = state.duplicateClips(selectedIds);
          if (duplicated.length > 0) {
            acted = true;
            announce(
              duplicated.length === 1 ? 'Clip duplicado' : `${duplicated.length} clips duplicados`
            );
          }
        }

        // The default is only prevented when the shortcut really did
        // something: an empty internal clipboard must NOT hijack the system
        // clipboard of the browser.
        if (acted) e.preventDefault();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [splitAtPlayhead, deleteSelectedClip, rippleDeleteClip, undo, redo, fps]);

  const isMobile = useIsMobile(768);

  // Altura redimensionable de la línea de tiempo (solo escritorio).
  const [timelineHeight, setTimelineHeight] = useState<number>(() =>
    typeof window === 'undefined' ? TIMELINE_HEIGHT_DEFAULT : readTimelineHeight()
  );

  const applyTimelineHeight = useCallback((height: number) => {
    const clamped = clampTimelineHeight(height);
    setTimelineHeight(clamped);
    try {
      window.localStorage.setItem(TIMELINE_HEIGHT_KEY, String(clamped));
    } catch {
      /* modo privado: el ajuste vive solo en memoria */
    }
  }, []);

  // Arrastre del divisor: mover el ratón cambia la altura entre 200 y 360 px.
  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = timelineHeight;
      const onMove = (move: MouseEvent) => {
        applyTimelineHeight(startHeight + (startY - move.clientY));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [applyTimelineHeight, timelineHeight]
  );

  // Teclado en el divisor: flechas arriba/abajo en pasos de 8 px.
  const onResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        e.preventDefault();
        applyTimelineHeight(timelineHeight + 8);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        e.preventDefault();
        applyTimelineHeight(timelineHeight - 8);
      } else if (e.key === 'Home') {
        e.preventDefault();
        applyTimelineHeight(TIMELINE_HEIGHT_MAX);
      } else if (e.key === 'End') {
        e.preventDefault();
        applyTimelineHeight(TIMELINE_HEIGHT_MIN);
      }
    },
    [applyTimelineHeight, timelineHeight]
  );

  if (isMobile) {
    return (
      <>
        <MobileCapCutLayout />
        {/* F7: the refusals of the store are visible in the mobile layout too. */}
        <StoreErrorBanner />
      </>
    );
  }

  return (
    // UI-05: `h-screen` (100vh) is the *large* viewport: on iPad/Safari the
    // browser chrome covered the bottom timeline. The inline `100dvh` wins
    // wherever it is supported and the class stays as the fallback.
    <div
      className="flex flex-col h-screen w-screen overflow-hidden bg-app text-text-1 select-none"
      style={{ height: '100dvh' }}
    >
      {/* Barra de la app (40 px) */}
      <Header />

      {/* Centro: rail + panel | visor | inspector */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Izquierda: rail de 48 px + panel de 264 px */}
        <Sidebar />

        {/* Center: Video Preview & Controls */}
        <div className="flex-1 flex flex-col bg-app overflow-hidden min-w-0 min-h-0">
          <PreviewPlayer />
          <PlayerControls />
        </div>

        {/* Derecha: inspector permanente de 300 px */}
        <InspectorPanel />
      </div>

      {/* Bottom: Multitrack Interactive Timeline (redimensionable) */}
      <div
        className="relative w-full min-w-0 shrink-0"
        style={{ height: timelineHeight }}
        data-testid="timeline-shell"
      >
        {/* Divisor de arrastre en el borde superior */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Cambiar altura de la línea de tiempo"
          aria-valuemin={TIMELINE_HEIGHT_MIN}
          aria-valuemax={TIMELINE_HEIGHT_MAX}
          aria-valuenow={Math.round(timelineHeight)}
          title="Arrastrar para cambiar la altura de la línea de tiempo"
          tabIndex={0}
          data-testid="timeline-resize-handle"
          onMouseDown={onResizeMouseDown}
          onKeyDown={onResizeKeyDown}
          className="absolute -top-1 left-0 z-20 h-2 w-full cursor-ns-resize touch-none"
        />
        <Timeline />
      </div>

      {/* Modals */}
      {isExportModalOpen && (
        <Suspense fallback={null}>
          <ExportModal />
        </Suspense>
      )}
      {isShortcutsModalOpen && (
        <Suspense fallback={null}>
          <ShortcutsModal />
        </Suspense>
      )}
      {isProjectsModalOpen && (
        <Suspense fallback={null}>
          <ProjectsModal />
        </Suspense>
      )}
      <WelcomeModal />

      {/* F7: the refusals of the store (locked track, illegal overlap…) are
          shown to the user instead of failing silently. */}
      <StoreErrorBanner />

      {/*
        UI-16: the app had no `aria-live` region at all. This single polite
        region announces the status changes pushed with `announce(...)`.
      */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="live-region"
        className="sr-only"
      >
        {announcement.text}
      </div>
    </div>
  );
};
