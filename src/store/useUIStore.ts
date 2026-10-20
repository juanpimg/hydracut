import { create } from 'zustand';
import { hasSeenWelcome, markWelcomeSeen } from '../core/utils/appFlags';

/**
 * Pestañas del rail izquierdo.
 *
 * El Inspector ya no es una pestaña del rail (vive en su propia columna a la
 * derecha, como en los editores profesionales): `setActiveTab('inspector')`
 * es un no-op inofensivo para no romper a los llamadores antiguos
 * (`ClipItem` aún lo invoca al seleccionar un clip). La pestaña muerta
 * `'export'` se eliminó del tipo.
 */
export type SidebarTab = 'media' | 'text' | 'inspector';
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
  // Solo el visitante primerizo ve la bienvenida al arrancar: una vez
  // cerrada queda registrada (ver `src/core/utils/appFlags.ts`) y las
  // siguientes cargas entran directamente al editor. Sin almacenamiento
  // disponible se muestra (el valor seguro) sin lanzar.
  isWelcomeOpen: !hasSeenWelcome(),
  activeTool: 'select',
  isGeneratingSamples: false,

  setActiveTab: (activeTab) => {
    // El Inspector es una columna permanente a la derecha, no una pestaña:
    // esta llamada histórica no debe mover el panel izquierdo (antes
    // arrancaba el bin de medios al hacer clic en un clip).
    if (activeTab === 'inspector') return;
    set({ activeTab });
  },
  setExportModalOpen: (isExportModalOpen) => set({ isExportModalOpen }),
  setShortcutsModalOpen: (isShortcutsModalOpen) => set({ isShortcutsModalOpen }),
  setProjectsModalOpen: (isProjectsModalOpen) => set({ isProjectsModalOpen }),
  // Cerrar la bienvenida la marca como vista (persistente): la próxima
  // carga no la muestra. Reabrirla desde la "Guía de inicio" del header
  // sigue funcionando (solo pone el flag a `true`).
  setWelcomeOpen: (isWelcomeOpen) => {
    if (!isWelcomeOpen) markWelcomeSeen();
    set({ isWelcomeOpen });
  },
  setActiveTool: (activeTool) => set({ activeTool }),
  setIsGeneratingSamples: (isGeneratingSamples) => set({ isGeneratingSamples }),
}));
