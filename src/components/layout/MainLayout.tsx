import React, { useEffect } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { PreviewPlayer } from '../player/PreviewPlayer';
import { PlayerControls } from '../player/PlayerControls';
import { Timeline } from '../timeline/Timeline';
import { ExportModal } from '../export/ExportModal';
import { ShortcutsModal } from '../modals/ShortcutsModal';
import { useProjectStore } from '../../store/useProjectStore';
import { masterClock } from '../../core/engine/MasterClock';
import { loadAutosavedProject, rehydrateProjectMedia } from '../../core/storage/projectStorage';

export const MainLayout: React.FC = () => {
  const { 
    splitAtPlayhead, 
    deleteSelectedClip, 
    undo, 
    redo, 
    project,
    loadProject 
  } = useProjectStore();

  // Load autosaved project on startup
  useEffect(() => {
    loadAutosavedProject().then(async (saved) => {
      if (saved && saved.clips && saved.tracks) {
        const rehydrated = await rehydrateProjectMedia(saved);
        loadProject(rehydrated);
      }
    });
  }, [loadProject]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input, textarea or select
      const activeTag = document.activeElement?.tagName.toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return;
      }

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
        masterClock.stepFrame(-1, project.fps);
        return;
      }

      // ArrowRight: Step forward 1 frame
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        masterClock.stepFrame(1, project.fps);
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
  }, [splitAtPlayhead, deleteSelectedClip, undo, redo, project.fps]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-dark-950 text-slate-100 select-none">
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
      <Timeline />

      {/* Modals */}
      <ExportModal />
      <ShortcutsModal />
    </div>
  );
};
