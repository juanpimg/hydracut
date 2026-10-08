import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Film,
  Music,
  Type,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Volume2,
  VolumeX,
  MoreVertical,
  Copy,
  ArrowUp,
  ArrowDown,
  Trash2,
} from 'lucide-react';
import { Track } from '../../types/project';
import { useProjectStore } from '../../store/useProjectStore';

interface TrackHeaderProps {
  track: Track;
  index?: number;
}

export const TrackHeader: React.FC<TrackHeaderProps> = ({ track, index }) => {
  const toggleTrackMute = useProjectStore((s) => s.toggleTrackMute);
  const toggleTrackLock = useProjectStore((s) => s.toggleTrackLock);
  const toggleTrackVisibility = useProjectStore((s) => s.toggleTrackVisibility);
  const removeTrack = useProjectStore((s) => s.removeTrack);
  const duplicateTrack = useProjectStore((s) => s.duplicateTrack);
  const reorderTrack = useProjectStore((s) => s.reorderTrack);
  const tracks = useProjectStore((s) => s.project.tracks);

  const [menuOpen, setMenuOpen] = useState(false);
  const [popoverCoords, setPopoverCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const trackIndex = typeof index === 'number' ? index : tracks.findIndex((t) => t.id === track.id);
  const canDelete = tracks.length > 1;
  const canMoveUp = trackIndex > 0;
  const canMoveDown = trackIndex !== -1 && trackIndex < tracks.length - 1;

  // Track badge configurations and colors
  const getBadgeConfig = () => {
    switch (track.type) {
      case 'video':
        return {
          icon: <Film size={11} className="text-blue-400 shrink-0" />,
          style: 'bg-blue-500/15 border-blue-500/30 text-blue-400',
        };
      case 'audio':
        return {
          icon: <Music size={11} className="text-emerald-400 shrink-0" />,
          style: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400',
        };
      case 'text':
        return {
          icon: <Type size={11} className="text-purple-400 shrink-0" />,
          style: 'bg-purple-500/15 border-purple-500/30 text-purple-400',
        };
    }
  };

  const getShortName = () => {
    const num = track.name.match(/\d+/)?.[0] || '1';
    return `${track.type[0].toUpperCase()}${num}`;
  };

  const badgeConfig = getBadgeConfig();

  // Handle menu opening and position calculation
  const handleToggleMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!menuOpen && menuBtnRef.current) {
      const rect = menuBtnRef.current.getBoundingClientRect();
      const menuWidth = 180;
      const menuHeight = 190;
      let left = rect.right + 6;
      if (left + menuWidth > window.innerWidth) {
        left = Math.max(8, rect.left - menuWidth - 4);
      }
      let top = rect.top;
      if (top + menuHeight > window.innerHeight) {
        top = Math.max(8, window.innerHeight - menuHeight - 12);
      }
      setPopoverCoords({ top, left });
      setMenuOpen(true);
    } else {
      setMenuOpen(false);
    }
  };

  // Close menu on Escape
  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [menuOpen]);

  // Touch hitbox button base styling (44px height guaranteed; width 28px real
  // + 4px pseudo expansion each side. Gap between buttons absorbs the expansion
  // so neighboring hit areas overlap by at most ~4px instead of ~14px.)
  const buttonBaseClass =
    "relative flex items-center justify-center rounded-md transition active:scale-95 touch-manipulation h-11 min-h-[44px] w-7 min-w-[28px] after:absolute after:-inset-1 after:content-['']";

  return (
    <div
      data-testid={`track-header-${track.id}`}
      className="h-14 px-1.5 sm:px-2 md:px-3 bg-dark-900 border-b border-r border-dark-800 flex items-center justify-between select-none group"
    >
      {/* 1. Track Badge & Full Name */}
      <div className="flex items-center gap-1 min-w-0 flex-1 pr-1 overflow-hidden">
        <span
          data-testid={`track-badge-${track.id}`}
          className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] sm:text-[10px] font-mono font-bold border shrink-0 max-w-[56px] sm:max-w-none truncate ${badgeConfig.style}`}
          title={track.name}
        >
          <span className="hidden min-[420px]:inline-flex shrink-0">{badgeConfig.icon}</span>
          <span className="truncate">{getShortName()}</span>
        </span>
        <span className="text-xs font-semibold text-slate-300 truncate hidden md:inline" title={track.name}>
          {track.name}
        </span>
      </div>

      {/* 2. Direct Touch Action Buttons */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Visibility (Eye) */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleTrackVisibility(track.id);
          }}
          className={`${buttonBaseClass} ${
            !track.isVisible
              ? 'text-amber-400 bg-amber-950/50 border border-amber-500/30'
              : 'text-slate-400 hover:text-white'
          }`}
          title={track.isVisible ? 'Ocultar pista' : 'Mostrar pista'}
          aria-label={track.isVisible ? 'Ocultar pista' : 'Mostrar pista'}
        >
          {track.isVisible ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>

        {/* Mute (Audio / Video) */}
        {track.type !== 'text' ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleTrackMute(track.id);
            }}
            className={`${buttonBaseClass} ${
              track.isMuted
                ? 'text-red-400 bg-red-950/50 border border-red-500/30'
                : 'text-slate-400 hover:text-white'
            }`}
            title={track.isMuted ? 'Activar audio' : 'Silenciar pista'}
            aria-label={track.isMuted ? 'Activar audio' : 'Silenciar pista'}
          >
            {track.isMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
        ) : (
          /* Placeholder invisible to preserve columnar grid alignment */
          <div className="w-7 min-w-[28px] h-11 min-h-[44px]" aria-hidden="true" />
        )}

        {/* Lock */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleTrackLock(track.id);
          }}
          className={`${buttonBaseClass} ${
            track.isLocked
              ? 'text-amber-400 bg-amber-950/50 border border-amber-500/30'
              : 'text-slate-400 hover:text-white'
          }`}
          title={track.isLocked ? 'Desbloquear pista' : 'Bloquear pista'}
          aria-label={track.isLocked ? 'Desbloquear pista' : 'Bloquear pista'}
        >
          {track.isLocked ? <Lock size={13} /> : <Unlock size={13} />}
        </button>

        {/* Quick action menu button '...' */}
        <button
          ref={menuBtnRef}
          type="button"
          onClick={handleToggleMenu}
          data-testid={`track-menu-btn-${track.id}`}
          className={`${buttonBaseClass} ${
            menuOpen
              ? 'text-cyan-400 bg-cyan-950/50 border border-cyan-500/30'
              : 'text-slate-400 hover:text-white'
          }`}
          title="Opciones de pista"
          aria-label="Opciones de pista"
          aria-haspopup="true"
          aria-expanded={menuOpen}
        >
          <MoreVertical size={14} />
        </button>
      </div>

      {/* 3. Popover Menu (Mounted via Portal into document.body to avoid parent overflow clipping) */}
      {menuOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 z-50">
            {/* Click-outside backdrop */}
            <div
              className="fixed inset-0 bg-black/25 backdrop-blur-[0.5px]"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
              }}
            />

            {/* Menu Popover Container */}
            <div
              role="menu"
              aria-label="Opciones de pista"
              data-testid={`track-menu-${track.id}`}
              style={{ top: `${popoverCoords.top}px`, left: `${popoverCoords.left}px` }}
              className="fixed z-[60] w-44 max-h-[70vh] overflow-y-auto bg-dark-900 border border-dark-750 rounded-lg shadow-2xl py-1 px-1 text-slate-200 text-xs flex flex-col gap-0.5 animate-scaleUp"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-2.5 py-1.5 border-b border-dark-800 text-[10px] font-mono font-bold text-slate-400 flex items-center justify-between">
                <span className="truncate">{track.name}</span>
                <span className="uppercase text-[9px] text-slate-500 ml-1 shrink-0">{track.type}</span>
              </div>

              {/* Duplicar pista */}
              <button
                role="menuitem"
                title="Duplicar pista"
                aria-label="Duplicar pista"
                data-testid={`track-menu-duplicate-${track.id}`}
                onClick={() => {
                  duplicateTrack(track.id);
                  setMenuOpen(false);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-2.5 rounded-md hover:bg-dark-800 active:bg-dark-750 text-slate-200 hover:text-white transition text-left min-h-[40px] touch-manipulation"
              >
                <Copy size={14} className="text-cyan-400 shrink-0" />
                <span className="truncate">Duplicar pista</span>
              </button>

              {/* Subir pista */}
              <button
                role="menuitem"
                title="Subir pista"
                aria-label="Subir pista"
                data-testid={`track-menu-up-${track.id}`}
                disabled={!canMoveUp}
                onClick={() => {
                  reorderTrack(track.id, 'up');
                  setMenuOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-2.5 py-2.5 rounded-md transition text-left min-h-[40px] touch-manipulation ${
                  canMoveUp
                    ? 'hover:bg-dark-800 active:bg-dark-750 text-slate-200 hover:text-white'
                    : 'opacity-40 cursor-not-allowed text-slate-500'
                }`}
              >
                <ArrowUp size={14} className="text-blue-400 shrink-0" />
                <span className="truncate">Subir pista</span>
              </button>

              {/* Bajar pista */}
              <button
                role="menuitem"
                title="Bajar pista"
                aria-label="Bajar pista"
                data-testid={`track-menu-down-${track.id}`}
                disabled={!canMoveDown}
                onClick={() => {
                  reorderTrack(track.id, 'down');
                  setMenuOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-2.5 py-2.5 rounded-md transition text-left min-h-[40px] touch-manipulation ${
                  canMoveDown
                    ? 'hover:bg-dark-800 active:bg-dark-750 text-slate-200 hover:text-white'
                    : 'opacity-40 cursor-not-allowed text-slate-500'
                }`}
              >
                <ArrowDown size={14} className="text-blue-400 shrink-0" />
                <span className="truncate">Bajar pista</span>
              </button>

              {/* Divider & Delete */}
              {canDelete && (
                <>
                  <div className="my-0.5 border-t border-dark-800" />
                  <button
                    role="menuitem"
                    title="Eliminar pista"
                    aria-label="Eliminar pista"
                    data-testid={`track-menu-delete-${track.id}`}
                    onClick={() => {
                      removeTrack(track.id);
                      setMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-2.5 rounded-md hover:bg-red-950/40 active:bg-red-950/60 text-red-400 hover:text-red-300 transition text-left min-h-[40px] touch-manipulation"
                  >
                    <Trash2 size={14} className="text-red-400 shrink-0" />
                    <span className="truncate">Eliminar pista</span>
                  </button>
                </>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
