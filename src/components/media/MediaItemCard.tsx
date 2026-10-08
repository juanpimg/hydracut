import React from 'react';
import { Video, Music, Image as ImageIcon, Plus, Trash2, Clock } from 'lucide-react';
import { MediaItem } from '../../types/project';
import { formatDuration } from '../../core/utils/time';
import { useProjectStore } from '../../store/useProjectStore';

interface MediaItemCardProps {
  item: MediaItem;
}

export const MediaItemCard: React.FC<MediaItemCardProps> = ({ item }) => {
  const { addClipFromMedia, removeMediaItem } = useProjectStore();

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

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      className="group relative bg-dark-850 hover:bg-dark-800 border border-dark-750 hover:border-dark-600 rounded-lg p-2 flex flex-col gap-2 transition cursor-grab active:cursor-grabbing select-none"
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

        {/* Duration badge */}
        {item.duration > 0 && (
          <div className="absolute bottom-1 right-1 bg-black/80 backdrop-blur-xs text-white text-[10px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1">
            <Clock size={9} />
            <span>{formatDuration(item.duration)}</span>
          </div>
        )}

        {/* Hover Quick Actions */}
        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-2">
          <button
            onClick={() => addClipFromMedia(item)}
            className="p-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-md shadow-md transition"
            title="Añadir a la línea de tiempo"
          >
            <Plus size={16} />
          </button>
          <button
            onClick={() => removeMediaItem(item.id)}
            className="p-1.5 bg-red-600/80 hover:bg-red-500 text-white rounded-md shadow-md transition"
            title="Eliminar archivo"
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
      </div>
    </div>
  );
};
