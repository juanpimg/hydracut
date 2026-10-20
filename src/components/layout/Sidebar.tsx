import React, { Suspense, lazy, useRef } from 'react';
import { Film, Type, Plus } from 'lucide-react';
import { useUIStore, SidebarTab } from '../../store/useUIStore';
import { useProjectStore } from '../../store/useProjectStore';
import { Button } from '../ui/Button';

/**
 * Ranura de carga del bin: misma caja del panel (sin texto) para que la
 * carga del chunk nunca desplace el layout.
 */
const MediaBin = lazy(() => import('../media/MediaBin'));

const MediaBinFallback: React.FC = () => (
  <div
    aria-hidden="true"
    className="flex h-full flex-col overflow-hidden bg-panel p-3 select-none"
  >
    <div className="mb-3 h-5 w-32 animate-pulse rounded bg-raised" />
    <div className="mb-3 h-9 w-full animate-pulse rounded bg-raised" />
    <div className="flex-1 rounded border border-dashed border-border-subtle bg-app p-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="aspect-video animate-pulse rounded bg-raised" />
        <div className="aspect-video animate-pulse rounded bg-raised" />
        <div className="aspect-video animate-pulse rounded bg-raised" />
        <div className="aspect-video animate-pulse rounded bg-raised" />
      </div>
    </div>
  </div>
);

/** Pestañas del rail: solo lo que aporta medios (el Inspector vive a la derecha). */
type RailTab = Extract<SidebarTab, 'media' | 'text'>;

/**
 * Columna izquierda: rail de 48 px + panel de 264 px (bin o texto).
 * Superficies planas con hairlines de 1 px, sin gradientes ni brillos.
 */
export const Sidebar: React.FC = () => {
  // UI-29: suscripción a los campos individuales, no a todo el store.
  const activeTab = useUIStore((s) => s.activeTab);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const addTextClip = useProjectStore((s) => s.addTextClip);

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const tabs: { id: RailTab; label: string; icon: React.ReactNode }[] = [
    { id: 'media', label: 'Medios', icon: <Film size={18} aria-hidden="true" /> },
    { id: 'text', label: 'Texto', icon: <Type size={18} aria-hidden="true" /> },
  ];

  /** UI-14: la tablist tenía navegación por teclado con roving tabindex. */
  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = tabs.length;
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (index + 1) % count;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (index - 1 + count) % count;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    if (next < 0) return;

    e.preventDefault();
    setActiveTab(tabs[next].id);
    tabRefs.current[next]?.focus();
  };

  // `activeTab` nunca es 'inspector' (esa llamada es un no-op): el panel
  // muestra el bin salvo que la pestaña activa sea texto.
  const showingText = activeTab === 'text';
  const activeTabId = `sidebar-tab-${showingText ? 'text' : 'media'}`;

  return (
    <aside className="flex h-full min-h-0 select-none">
      {/* Rail de 48 px */}
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label="Panel lateral"
        className="flex w-12 shrink-0 flex-col items-center gap-2 border-r border-border-subtle bg-panel py-3"
      >
        {tabs.map((tab, index) => {
          const isActive = (showingText ? 'text' : 'media') === tab.id;
          return (
            <Button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              variant="ghost"
              role="tab"
              id={`sidebar-tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`sidebar-panel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
              title={tab.label}
              className={`flex !h-12 !w-11 !flex-col items-center justify-center !gap-0.5 !px-1 ${
                isActive ? 'bg-accent-soft text-accent' : ''
              }`}
            >
              {tab.icon}
              <span className="text-[10px] leading-tight font-medium">{tab.label}</span>
            </Button>
          );
        })}
      </div>

      {/* Panel de 264 px */}
      <div
        role="tabpanel"
        id={showingText ? 'sidebar-panel-text' : 'sidebar-panel-media'}
        aria-labelledby={activeTabId}
        tabIndex={0}
        className="h-full min-h-0 w-[264px] shrink-0 overflow-hidden border-r border-border-subtle bg-panel"
      >
        {!showingText && (
          <Suspense fallback={<MediaBinFallback />}>
            <MediaBin />
          </Suspense>
        )}
        {showingText && (
          <div className="flex h-full flex-col bg-panel p-3 select-none">
            <div className="mb-3 flex items-center gap-2 border-b border-border-subtle pb-3">
              <Type size={16} className="text-text-2" aria-hidden="true" />
              <h2 className="text-caption font-medium tracking-wider text-text-2 uppercase select-none">
                Texto
              </h2>
            </div>

            <p className="mb-3 text-body-sm text-text-2">
              Títulos y rótulos sobre el vídeo.
            </p>

            <div className="space-y-2">
              <Button
                variant="secondary"
                onClick={() => {
                  addTextClip('Título');
                }}
                aria-label="Añadir título a la línea de tiempo"
                className="!h-auto w-full !justify-between !p-3 text-left"
              >
                <span>
                  <span className="block text-body font-bold text-text-1">Título</span>
                  <span className="block text-body-sm text-text-2">
                    Texto grande en negrita para aperturas
                  </span>
                </span>
                <Plus size={16} className="shrink-0 text-text-3" aria-hidden="true" />
              </Button>

              <Button
                variant="secondary"
                onClick={() => {
                  addTextClip('Subtítulo');
                }}
                aria-label="Añadir subtítulo a la línea de tiempo"
                className="!h-auto w-full !justify-between !p-3 text-left"
              >
                <span>
                  <span className="block text-body font-medium text-text-1">Subtítulo</span>
                  <span className="block text-body-sm text-text-2">
                    Explicaciones o créditos
                  </span>
                </span>
                <Plus size={16} className="shrink-0 text-text-3" aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
