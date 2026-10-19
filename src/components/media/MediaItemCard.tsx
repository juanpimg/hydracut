import React, { useState } from 'react';
import { Video, Music, Image as ImageIcon, Plus, Trash2, Clock, AlertTriangle } from 'lucide-react';
import { MediaItem } from '../../types/project';
import { formatDuration } from '../../core/utils/time';
import { useProjectStore } from '../../store/useProjectStore';

interface MediaItemCardProps {
  item: MediaItem;
}

export const MediaItemCard: React.FC<MediaItemCardProps> = ({ item }) => {
  const addClipFromMedia = useProjectStore((s) => s.addClipFromMedia);
  const removeMediaItem = useProjectStore((s) => s.removeMediaItem);
  /** Reason of the last refused insertion (F1): it must be visible, not silent. */
  const [refusal, setRefusal] = useState<string | null>(null);

  const getIcon = () => {
    switch (item.type) {
      case 'video':
        return <Video size={14} className="text-blue-400" />;
      case 'audio':
        return <Music size={14} className="text-emerald-400" />;
      case 'image':
        return <ImageIcon size={14} className="text-purple-400" />;
    }
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/json', JSON.stringify({ mediaId: item.id }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  /**
   * F1: the insertion can be refused (the overlap policy). The reason is
   * shown right here: a silent no-op looks like a broken app.
   */
  const handleAdd = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const result = addClipFromMedia(item);
    setRefusal(result.ok ? null : result.reason);
  };

  const isMissing = item.status === 'missing';
  const hasError = item.status === 'error';

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={() => handleAdd()}
      tabIndex={0}
      role="button"
      aria-label={`${item.name}: pulsa para añadir a la línea de tiempo`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleAdd();
        }
      }}
      className="group relative bg-dark-850 hover:bg-dark-800 border border-dark-750 hover:border-dark-600 rounded-lg p-2 flex flex-col gap-2 transition cursor-pointer select-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:outline-none"
    >
      {/* Thumbnail or Icon Box */}
      <div className="relative w-full aspect-video bg-dark-900 rounded overflow-hidden flex items-center justify-center border border-dark-750">
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt={item.name} className="w-full h-full object-cover" />
        ) : (
          <div className="flex flex-col items-center gap-1 text-slate-500">
            {getIcon()}
            <span className="text-[10px] uppercase font-semibold tracking-wider">{item.type}</span>
          </div>
        )}

        {/* F3: the media is not usable (its bytes are gone / it cannot be decoded). */}
        {(isMissing || hasError) && (
          <div
            data-testid="media-status-badge"
            className={`absolute inset-0 flex flex-col items-center justify-center gap-1 ${
              isMissing ? 'bg-rose-950/80' : 'bg-amber-950/80'
            }`}
            title={isMissing ? 'El archivo de este medio no está disponible' : 'El archivo de este medio no se puede decodificar'}
          >
            <AlertTriangle size={16} className={isMissing ? 'text-rose-300' : 'text-amber-300'} />
            <span className={`text-[9px] font-bold uppercase tracking-wide ${
              isMissing ? 'text-rose-200' : 'text-amber-200'
            }`}>
              {isMissing ? 'medio ausente' : 'error de medio'}
            </span>
          </div>
        )}

        {/* Duration badge */}
        {item.duration > 0 && (
          <div className="absolute bottom-1 right-1 bg-black/80 backdrop-blur-sm text-white text-[10px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1">
            <Clock size={9} />
            <span>{formatDuration(item.duration)}</span>
          </div>
        )}

        {/*
          Quick actions. On hover-capable devices they appear on hover; on
          touch devices (audit UI-23) there is no hover, so they stay visible
          in the corner of the thumbnail.
        */}
        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 transition flex items-center justify-center gap-2 [@media(hover:none)]:opacity-100 [@media(hover:none)]:bg-transparent [@media(hover:none)]:items-end [@media(hover:none)]:justify-end [@media(hover:none)]:p-1.5">
          <button
            onClick={(e) => handleAdd(e)}
            className="min-w-[36px] min-h-[36px] flex items-center justify-center p-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-md shadow-md transition focus-visible:ring-2 focus-visible:ring-white"
            title="Añadir a la línea de tiempo"
            aria-label={`Añadir ${item.name} a la línea de tiempo`}
          >
            <Plus size={16} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              // F2: the media goes to the trash (it can be restored), it is
              // NOT destroyed.
              removeMediaItem(item.id);
            }}
            className="min-w-[36px] min-h-[36px] flex items-center justify-center p-1.5 bg-red-600/80 hover:bg-red-500 text-white rounded-md shadow-md transition focus-visible:ring-2 focus-visible:ring-white"
            title="Mover a la papelera (se puede restaurar)"
            aria-label={`Mover ${item.name} a la papelera`}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5 min-w-0">
          {getIcon()}
          <span className="text-xs font-medium text-slate-300 truncate" title={item.name}>
            {item.name}
          </span>
        </div>

        {/*
          Always-visible "Añadir" button. It used to be `md: hidden`, so on a
          touch tablet (≥768 px) the only way to add media was a hover that
          does not exist on touch (audit UI-23): now it is shown on every
          device without hover, whatever the width.
        */}
        <button
          onClick={(e) => handleAdd(e)}
          className="hidden max-[767px]:flex [@media(hover:none)]:flex items-center gap-1 px-2 min-h-[36px] bg-blue-600/30 hover:bg-blue-600 text-blue-300 hover:text-white rounded border border-blue-500/30 text-[11px] font-semibold active:scale-95 transition shrink-0 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          title={`Añadir ${item.name}`}
          aria-label={`Añadir ${item.name} a la línea de tiempo`}
        >
          <Plus size={13} />
          <span>Añadir</span>
        </button>
      </div>

      {/* F1: the reason of a refused insertion (never a silent no-op). */}
      {refusal && (
        <p
          data-testid="media-card-refusal"
          role="alert"
          className="text-[10px] leading-tight text-rose-300 bg-rose-950/40 border border-rose-800/50 rounded px-1.5 py-1"
        >
          {refusal}
        </p>
      )}
    </div>
  );
};
