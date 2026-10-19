import React, { Suspense, lazy, useEffect } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { PreviewPlayer } from '../player/PreviewPlayer';
import { PlayerControls } from '../player/PlayerControls';
import { Timeline } from '../timeline/Timeline';
import { ShortcutsModal } from '../modals/ShortcutsModal';
import { ProjectsModal } from '../modals/ProjectsModal';
import { WelcomeModal } from '../modals/WelcomeModal';
import { MobileCapCutLayout } from '../mobile/MobileCapCutLayout';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useProjectStore } from '../../store/useProjectStore';
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

export const MainLayout: React.FC = () => {
  const splitAtPlayhead = useProjectStore((s) => s.splitAtPlayhead);
  const deleteSelectedClip = useProjectStore((s) => s.deleteSelectedClip);
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
      // Ignore if user is typing in an input, textarea or select
      const activeTag = document.activeElement?.tagName.toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
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

      // Delete or Backspace: Delete selected clip
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelectedClip();
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
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [splitAtPlayhead, deleteSelectedClip, undo, redo, fps]);

  const isMobile = useIsMobile(768);

  if (isMobile) {
    return <MobileCapCutLayout />;
  }

  return (
    // UI-05: `h-screen` (100vh) is the *large* viewport: on iPad/Safari the
    // browser chrome covered the bottom timeline. The inline `100dvh` wins
    // wherever it is supported and the class stays as the fallback.
    <div
      className="flex flex-col h-screen w-screen overflow-hidden bg-dark-950 text-slate-100 select-none"
      style={{ height: '100dvh' }}
    >
      {/* Top Header */}
      <Header />

      {/* Center Stage: Sidebar + Monitor */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Tools & Media Bin */}
        <Sidebar />

        {/* Center: Video Preview & Controls */}
        <div className="flex-1 flex flex-col bg-dark-950 overflow-hidden">
          <PreviewPlayer />
          <PlayerControls />
        </div>
      </div>

      {/* Bottom: Multitrack Interactive Timeline */}
      <div
        className="h-60 sm:h-64 md:h-72 max-h-[40vh] w-full min-w-0 shrink-0"
        style={{ maxHeight: '40dvh' }}
      >
        <Timeline />
      </div>

      {/* Modals */}
      {isExportModalOpen && (
        <Suspense fallback={null}>
          <ExportModal />
        </Suspense>
      )}
      <ShortcutsModal />
      <ProjectsModal />
      <WelcomeModal />

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
