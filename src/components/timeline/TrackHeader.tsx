import React from 'react';
import { Film, Music, Type, Eye, EyeOff, Lock, Unlock, Volume2, VolumeX, Trash2 } from 'lucide-react';
import { Track } from '../../types/project';
import { useProjectStore } from '../../store/useProjectStore';

interface TrackHeaderProps {
  track: Track;
}

export const TrackHeader: React.FC<TrackHeaderProps> = ({ track }) => {
  const toggleTrackMute = useProjectStore((s) => s.toggleTrackMute);
  const toggleTrackLock = useProjectStore((s) => s.toggleTrackLock);
  const toggleTrackVisibility = useProjectStore((s) => s.toggleTrackVisibility);
  const removeTrack = useProjectStore((s) => s.removeTrack);
  const trackCount = useProjectStore((s) => s.project.tracks.length);

  const getIcon = () => {
    switch (track.type) {
      case 'video':
        return <Film size={14} className="text-blue-400" />;
      case 'audio':
        return <Music size={14} className="text-emerald-400" />;
      case 'text':
        return <Type size={14} className="text-purple-400" />;
    }
  };

  const canDelete = trackCount > 1;

  const getShortName = () => {
    const num = track.name.match(/\d+/)?.[0] || '1';
    return `${track.type[0].toUpperCase()}${num}`;
  };

  return (
    <div className="h-14 px-2 sm:px-3 bg-dark-900 border-b border-r border-dark-800 flex items-center justify-between select-none group">
      <div className="flex items-center gap-1.5 min-w-0">
        {getIcon()}
        <span className="text-xs font-semibold text-slate-300 truncate hidden md:inline" title={track.name}>
          {track.name}
        </span>
        <span className="text-[10px] font-mono font-bold text-slate-400 md:hidden">
          {getShortName()}
        </span>
      </div>

      {/* Action icons */}
      <div className="hidden md:flex items-center gap-1 opacity-70 group-hover:opacity-100 transition">
        {/* Visibility */}
        <button
          onClick={() => toggleTrackVisibility(track.id)}
          className={`p-1 rounded transition ${
            !track.isVisible ? 'text-amber-400 bg-amber-950/40' : 'text-slate-400 hover:text-white'
          }`}
          title={track.isVisible ? 'Ocultar pista' : 'Mostrar pista'}
        >
          {track.isVisible ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>

        {/* Mute (Audio / Video) */}
        {track.type !== 'text' && (
          <button
            onClick={() => toggleTrackMute(track.id)}
            className={`p-1 rounded transition ${
              track.isMuted ? 'text-red-400 bg-red-950/40' : 'text-slate-400 hover:text-white'
            }`}
            title={track.isMuted ? 'Activar audio' : 'Silenciar pista'}
          >
            {track.isMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
        )}

        {/* Lock */}
        <button
          onClick={() => toggleTrackLock(track.id)}
          className={`p-1 rounded transition ${
            track.isLocked ? 'text-amber-400 bg-amber-950/40' : 'text-slate-400 hover:text-white'
          }`}
          title={track.isLocked ? 'Desbloquear pista' : 'Bloquear pista'}
        >
          {track.isLocked ? <Lock size={13} /> : <Unlock size={13} />}
        </button>

        {/* Delete Track */}
        {canDelete && (
          <button
            onClick={() => removeTrack(track.id)}
            className="p-1 text-slate-500 hover:text-red-400 rounded transition opacity-0 group-hover:opacity-100"
            title="Eliminar pista"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
};
