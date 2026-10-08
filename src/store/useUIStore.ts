import { create } from 'zustand';

export type SidebarTab = 'media' | 'text' | 'inspector' | 'export';
export type TimelineTool = 'select' | 'split';

export interface UIState {
  activeTab: SidebarTab;
  isExportModalOpen: boolean;
  isShortcutsModalOpen: boolean;
  isProjectsModalOpen: boolean;
  isWelcomeOpen: boolean;
  activeTool: TimelineTool;
  isGeneratingSamples: boolean;

  setActiveTab: (tab: SidebarTab) => void;
  setExportModalOpen: (open: boolean) => void;
  setShortcutsModalOpen: (open: boolean) => void;
  setProjectsModalOpen: (open: boolean) => void;
  setWelcomeOpen: (open: boolean) => void;
  setActiveTool: (tool: TimelineTool) => void;
  setIsGeneratingSamples: (generating: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeTab: 'media',
  isExportModalOpen: false,
  isShortcutsModalOpen: false,
  isProjectsModalOpen: false,
  isWelcomeOpen: true,
  activeTool: 'select',
  isGeneratingSamples: false,

  setActiveTab: (activeTab) => set({ activeTab }),
  setExportModalOpen: (isExportModalOpen) => set({ isExportModalOpen }),
  setShortcutsModalOpen: (isShortcutsModalOpen) => set({ isShortcutsModalOpen }),
  setProjectsModalOpen: (isProjectsModalOpen) => set({ isProjectsModalOpen }),
  setWelcomeOpen: (isWelcomeOpen) => set({ isWelcomeOpen }),
  setActiveTool: (activeTool) => set({ activeTool }),
  setIsGeneratingSamples: (isGeneratingSamples) => set({ isGeneratingSamples }),
}));
