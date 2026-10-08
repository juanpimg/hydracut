import React from 'react';
import { Film, Type, Sliders, Plus } from 'lucide-react';
import { useUIStore, SidebarTab } from '../../store/useUIStore';
import { useProjectStore } from '../../store/useProjectStore';
import { MediaBin } from '../media/MediaBin';
import { ClipInspector } from '../inspector/ClipInspector';

export const Sidebar: React.FC = () => {
  const { activeTab, setActiveTab } = useUIStore();
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const addTextClip = useProjectStore((s) => s.addTextClip);

  const tabs: { id: SidebarTab; label: string; icon: React.ReactNode }[] = [
    { id: 'media', label: 'Medios', icon: <Film size={18} /> },
    { id: 'text', label: 'Texto', icon: <Type size={18} /> },
    { id: 'inspector', label: 'Inspector', icon: <Sliders size={18} /> },
  ];

  return (
    <aside className="w-80 h-full flex bg-dark-900 border-r border-dark-800 select-none z-20">
      {/* Mini Icon Strip on the far left */}
      <div className="w-14 bg-dark-950 border-r border-dark-800 flex flex-col items-center py-3 gap-3">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative p-2.5 rounded-xl transition flex flex-col items-center gap-1 ${
                isActive
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-dark-850'
              }`}
              title={tab.label}
            >
              {tab.icon}
              <span className="text-[10px] font-medium">{tab.label}</span>
              {tab.id === 'inspector' && selectedClipId && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              )}
            </button>
          );
        })}
      </div>

      {/* Main Subpanel */}
      <div className="flex-1 h-full overflow-hidden">
        {activeTab === 'media' && <MediaBin />}
        {activeTab === 'inspector' && <ClipInspector />}
        {activeTab === 'text' && (
          <div className="flex flex-col h-full bg-dark-900 p-4 select-none">
            <div className="flex items-center justify-between pb-3 mb-4 border-b border-dark-800">
              <div className="flex items-center gap-2 text-slate-200 font-semibold text-sm">
                <Type size={16} className="text-blue-400" />
                <span>Capas de Texto</span>
              </div>
            </div>

            <p className="text-xs text-slate-400 mb-4">
              Agrega títulos, subtítulos o rótulos superpuestos sobre tu video.
            </p>

            <div className="space-y-3">
              <button
                onClick={() => {
                  addTextClip('Título Principal');
                  setActiveTab('inspector');
                }}
                className="w-full p-3 bg-dark-850 hover:bg-dark-800 border border-dark-750 hover:border-blue-500/50 rounded-lg flex items-center justify-between text-left transition group"
              >
                <div>
                  <h4 className="text-sm font-bold text-white group-hover:text-blue-400">Título Grande</h4>
                  <p className="text-[11px] text-slate-400">Texto llamativo en negrita para aperturas</p>
                </div>
                <Plus size={16} className="text-slate-500 group-hover:text-blue-400" />
              </button>

              <button
                onClick={() => {
                  addTextClip('Subtítulo o descripción');
                  setActiveTab('inspector');
                }}
                className="w-full p-3 bg-dark-850 hover:bg-dark-800 border border-dark-750 hover:border-blue-500/50 rounded-lg flex items-center justify-between text-left transition group"
              >
                <div>
                  <h4 className="text-sm font-medium text-white group-hover:text-blue-400">Subtítulo / Rótulo</h4>
                  <p className="text-[11px] text-slate-400">Texto mediano para explicaciones o créditos</p>
                </div>
                <Plus size={16} className="text-slate-500 group-hover:text-blue-400" />
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
