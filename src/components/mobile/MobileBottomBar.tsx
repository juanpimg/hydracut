import React, { useEffect, useRef } from 'react';
import { 
  FolderPlus, 
  Type, 
  Music, 
  Scissors, 
  Gauge, 
  Volume2, 
  Sparkles, 
  Trash2, 
  Eye, 
  Sliders,
  X
} from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { masterClock } from '../../core/engine/MasterClock';

export type MobileSheetType =
  | 'media'
  | 'audio'
  | 'text'
  | 'speed'
  | 'volume'
  | 'transition'
  | 'opacity'
  | 'inspector'
  | null;

interface MobileBottomBarProps {
  onOpenSheet: (sheet: MobileSheetType) => void;
}

interface MobileSplitButtonProps {
  mode: 'clip' | 'global';
  onSplit: () => void;
}

export const MobileSplitButton: React.FC<MobileSplitButtonProps> = ({ mode, onSplit }) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const clips = useProjectStore((s) => s.project.clips);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;

  const canSplitNow = () => {
    const t = masterClock.getTime();
    return clipsRef.current.some(
      (c) => t > c.start + 0.05 && t < c.start + c.duration - 0.05
    );
  };

  useEffect(() => {
    const updateState = (t: number) => {
      if (!buttonRef.current) return;
      const can = clipsRef.current.some(
        (c) => t > c.start + 0.05 && t < c.start + c.duration - 0.05
      );
      if (buttonRef.current.disabled !== !can) {
        buttonRef.current.disabled = !can;
        buttonRef.current.setAttribute(
          'aria-label',
          mode === 'clip'
            ? (can ? 'Dividir clip' : 'Dividir clip (no disponible: coloca el cabezal dentro de un clip)')
            : (can ? 'Dividir en cabezal' : 'Dividir en cabezal (no disponible: coloca el cabezal dentro de un clip)')
        );
      }
    };

    updateState(masterClock.getTime());
    let lastCheck = 0;
    const unsubTime = masterClock.subscribeTime((t) => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!masterClock.getIsPlaying() || now - lastCheck >= 200) {
        lastCheck = now;
        updateState(t);
      }
    });

    const unsubState = masterClock.subscribeState((playing) => {
      if (!playing) {
        updateState(masterClock.getTime());
      }
    });

    return () => {
      unsubTime();
      unsubState();
    };
  }, [clips, mode]);

  if (mode === 'clip') {
    return (
      <button
        ref={buttonRef}
        onClick={onSplit}
        disabled={!canSplitNow()}
        className="flex flex-col items-center justify-center w-14 h-12 rounded-xl text-cyan-400 hover:text-cyan-300 active:bg-dark-850 active:scale-95 transition disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
        title="Dividir clip"
        aria-label={canSplitNow() ? 'Dividir clip' : 'Dividir clip (no disponible: coloca el cabezal dentro de un clip)'}
      >
        <Scissors size={18} />
        <span className="text-[10px] mt-0.5 font-bold">Dividir</span>
      </button>
    );
  }

  return (
    <button
      ref={buttonRef}
      onClick={onSplit}
      disabled={!canSplitNow()}
      className="flex flex-col items-center justify-center w-16 h-12 rounded-xl text-slate-200 hover:text-white active:bg-dark-850 active:scale-95 transition disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
      title="Dividir en cabezal"
      aria-label={canSplitNow() ? 'Dividir en cabezal' : 'Dividir en cabezal (no disponible: coloca el cabezal dentro de un clip)'}
    >
      <div className="w-6 h-6 rounded-lg bg-amber-500/20 border border-amber-500/30 flex items-center justify-center text-amber-400">
        <Scissors size={15} />
      </div>
      <span className="text-[10px] mt-1 font-medium text-slate-300">Dividir</span>
    </button>
  );
};

export const MobileBottomBar: React.FC<MobileBottomBarProps> = ({ onOpenSheet }) => {
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const selectClip = useProjectStore((s) => s.selectClip);
  const splitAtPlayhead = useProjectStore((s) => s.splitAtPlayhead);
  const deleteSelectedClip = useProjectStore((s) => s.deleteSelectedClip);

  const hasSelectedClip = !!selectedClipId;

  const handleDelete = () => {
    if (confirm('¿Eliminar el clip seleccionado? Puedes deshacer esta acción.')) {
      deleteSelectedClip();
    }
  };

  return (
    // UI-04: `min-h-16` (instead of a fixed `h-16`) so the safe-area padding
    // grows the bar instead of squeezing its content.
    <nav className="min-h-16 bg-dark-950/95 border-t border-dark-800/80 px-2 flex items-center justify-between z-30 select-none shrink-0 pb-[env(safe-area-inset-bottom)] overflow-x-auto no-scrollbar">
      {hasSelectedClip ? (
        /* MODE 2: CLIP SELECTED ACTIONS (CapCut Clip Toolbar) */
        <div className="flex items-center gap-1 w-full min-w-max justify-around py-1">
          {/* Deselect / Back */}
          <button
            onClick={() => selectClip(null)}
            className="flex flex-col items-center justify-center w-14 h-12 rounded-xl text-slate-400 hover:text-white active:bg-dark-850 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Deseleccionar"
            aria-label="Deseleccionar clip y volver a la barra principal"
          >
            <X size={18} />
            <span className="text-[10px] mt-0.5 font-medium">Volver</span>
          </button>

          {/* Clip properties (transform, mute, text…) — audit UI-17 */}
          <button
            onClick={() => onOpenSheet('inspector')}
            className="flex flex-col items-center justify-center w-14 h-12 rounded-xl text-slate-200 hover:text-white active:bg-dark-850 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Propiedades del clip"
            aria-label="Propiedades del clip seleccionado"
            data-testid="mobile-clip-properties"
          >
            <Sliders size={18} className="text-blue-400" />
            <span className="text-[10px] mt-0.5 font-medium">Ajustes</span>
          </button>

          {/* Split (Dividir) */}
          <MobileSplitButton mode="clip" onSplit={splitAtPlayhead} />

          {/* Speed (Velocidad) */}
          <button
            onClick={() => onOpenSheet('speed')}
            className="flex flex-col items-center justify-center w-14 h-12 rounded-xl text-slate-200 hover:text-white active:bg-dark-850 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Velocidad"
            aria-label="Velocidad del clip"
          >
            <Gauge size={18} className="text-amber-400" />
            <span className="text-[10px] mt-0.5 font-medium">Velocidad</span>
          </button>

          {/* Volume (Volumen) */}
          <button
            onClick={() => onOpenSheet('volume')}
            className="flex flex-col items-center justify-center w-14 h-12 rounded-xl text-slate-200 hover:text-white active:bg-dark-850 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Volumen"
            aria-label="Volumen del clip"
          >
            <Volume2 size={18} className="text-emerald-400" />
            <span className="text-[10px] mt-0.5 font-medium">Volumen</span>
          </button>

          {/* Transition / Animation */}
          <button
            onClick={() => onOpenSheet('transition')}
            className="flex flex-col items-center justify-center w-14 h-12 rounded-xl text-slate-200 hover:text-white active:bg-dark-850 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Transiciones"
            aria-label="Animaciones y transiciones"
          >
            <Sparkles size={18} className="text-blue-400" />
            <span className="text-[10px] mt-0.5 font-medium">Animación</span>
          </button>

          {/* Opacity */}
          <button
            onClick={() => onOpenSheet('opacity')}
            className="flex flex-col items-center justify-center w-14 h-12 rounded-xl text-slate-200 hover:text-white active:bg-dark-850 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Opacidad"
            aria-label="Opacidad del clip"
          >
            <Eye size={18} className="text-purple-400" />
            <span className="text-[10px] mt-0.5 font-medium">Opacidad</span>
          </button>

          {/* Delete (Eliminar) */}
          <button
            onClick={handleDelete}
            className="flex flex-col items-center justify-center w-14 h-12 rounded-xl text-red-400 hover:text-red-300 active:bg-dark-850 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:outline-none"
            title="Eliminar clip"
            aria-label="Eliminar clip seleccionado"
          >
            <Trash2 size={18} />
            <span className="text-[10px] mt-0.5 font-medium">Eliminar</span>
          </button>
        </div>
      ) : (
        /* MODE 1: GLOBAL ACTIONS (CapCut Main Toolbar) */
        <div className="flex items-center gap-2 w-full justify-around py-1">
          {/* Add Media */}
          <button
            onClick={() => onOpenSheet('media')}
            className="flex flex-col items-center justify-center w-16 h-12 rounded-xl text-slate-200 hover:text-white active:bg-dark-850 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Añadir Medios"
            aria-label="Abrir biblioteca de medios"
          >
            <div className="w-6 h-6 rounded-lg bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <FolderPlus size={15} />
            </div>
            <span className="text-[10px] mt-1 font-medium text-slate-300">Medios</span>
          </button>

          {/* Add Text */}
          <button
            onClick={() => onOpenSheet('text')}
            className="flex flex-col items-center justify-center w-16 h-12 rounded-xl text-slate-200 hover:text-white active:bg-dark-850 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Texto"
            aria-label="Añadir capa de texto"
          >
            <div className="w-6 h-6 rounded-lg bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-400">
              <Type size={15} />
            </div>
            <span className="text-[10px] mt-1 font-medium text-slate-300">Texto</span>
          </button>

          {/* Audio — opens the audio specific sheet (audit UI-19: it used to
              open exactly the same sheet as "Medios") */}
          <button
            onClick={() => onOpenSheet('audio')}
            className="flex flex-col items-center justify-center w-16 h-12 rounded-xl text-slate-200 hover:text-white active:bg-dark-850 active:scale-95 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            title="Audio"
            aria-label="Abrir panel de audio"
            data-testid="mobile-audio-button"
          >
            <div className="w-6 h-6 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Music size={15} />
            </div>
            <span className="text-[10px] mt-1 font-medium text-slate-300">Audio</span>
          </button>

          {/* Quick Split at Playhead */}
          <MobileSplitButton mode="global" onSplit={splitAtPlayhead} />
        </div>
      )}
    </nav>
  );
};
