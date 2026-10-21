import React, { useState } from 'react';
import { Image as ImageIcon, Music, Plus, Trash2, Video } from 'lucide-react';
import { MediaItem } from '../../types/project';
import { formatDuration } from '../../core/utils/time';
import { formatearBytes } from '../../utils/formato';
import { useProjectStore } from '../../store/useProjectStore';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';

interface MediaItemCardProps {
  item: MediaItem;
  /**
   * Abre el flujo de revinculado del medio. Lo ofrece el bin de escritorio;
   * la hoja móvil no lo tiene, así que es opcional y la tarjeta sigue
   * funcionando sin él (misma firma que usa `MediaBin`).
   */
  onRevincular?: (mediaId: string) => void;
}

/**
 * Fila del bin (U3): miniatura 16:9 fija (con la duración como insignia de
 * esquina, nunca recortada) + nombre en 2 líneas + tamaño + UNA acción de
 * añadir. La fila entera añade al pulsar; el borrado es un
 * icono discreto en la fila (nunca sobre la miniatura) que mueve a la
 * papelera —recuperable—, no un menú con confirmación: el borrado en un clic
 * es el contrato que espera la suite de navegador (KI-05) y el copy vigente
 * («Mover a la papelera (se puede restaurar)»).
 *
 * El nombre manda sobre las acciones: las acciones viven en una capa
 * superpuesta que solo aparece al hover/foco (ancho reservado cero, el texto
 * usa todo el ancho y «Audio Chime Acústico» cabe en 2 líneas). Solo en
 * puntero grueso (`pointer: coarse`, táctil real) siguen fijas en la fila a
 * 44 px —`hover: none` no sirve como señal (el Chrome sin cabeza de la
 * suite informa `hover: none` con viewport de escritorio). Nada importante
 * queda recortado.
 */
export const MediaItemCard: React.FC<MediaItemCardProps> = ({ item, onRevincular }) => {
  const addClipFromMedia = useProjectStore((s) => s.addClipFromMedia);
  const removeMediaItem = useProjectStore((s) => s.removeMediaItem);
  /** Motivo del último rechazo de inserción (F1): visible, nunca silencioso. */
  const [refusal, setRefusal] = useState<string | null>(null);

  const getIcon = () => {
    switch (item.type) {
      case 'video':
        return <Video size={14} className="text-text-3" aria-hidden="true" />;
      case 'audio':
        return <Music size={14} className="text-text-3" aria-hidden="true" />;
      case 'image':
        return <ImageIcon size={14} className="text-text-3" aria-hidden="true" />;
    }
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/json', JSON.stringify({ mediaId: item.id }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  /**
   * F1: la inserción puede rechazarse (política de solapamiento). El motivo se
   * enseña aquí mismo: un no-op silencioso parece una app rota.
   */
  const handleAdd = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const result = addClipFromMedia(item);
    setRefusal(result.ok ? null : result.reason);
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    // F2: el medio va a la papelera (se puede restaurar), NO se destruye.
    removeMediaItem(item.id);
  };

  const isMissing = item.status === 'missing';
  const hasError = item.status === 'error';
  const isUnavailable = isMissing || hasError;

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={() => handleAdd()}
      tabIndex={0}
      role="button"
      aria-label={`${item.name}: añadir a la línea de tiempo`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleAdd();
        }
      }}
      className="group relative flex w-full max-w-full cursor-pointer select-none items-center gap-2 rounded-md border border-border-subtle bg-panel px-2 py-1.5 text-left transition hover:border-border hover:bg-raised"
    >
      {/* Miniatura 16:9 fija (64×36): nunca lleva acciones encima. La
          duración vive aquí como insignia de esquina (monoespaciado): en la
          fila ya no se recorta con ellipsis. */}
      <div className="relative flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded border border-border-subtle bg-app">
        {item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt=""
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          getIcon()
        )}
        {item.duration > 0 && (
          <span
            title={`Duración: ${formatDuration(item.duration)}`}
            className="absolute right-0.5 bottom-0.5 rounded bg-black/70 px-1 font-mono text-timecode tabular text-text-1"
          >
            {formatDuration(item.duration)}
          </span>
        )}
      </div>

      {/* Nombre (hasta 2 líneas, completo en `title`) + tamaño + estado. */}
      <div className="min-w-0 flex-1">
        <p
          className="line-clamp-2 break-words text-body font-medium leading-snug text-text-1"
          title={item.name}
        >
          {item.name}
        </p>
        {item.size > 0 && (
          <p className="mt-0.5 whitespace-nowrap text-body-sm text-text-2">
            <span
              data-testid={`media-size-${item.id}`}
              title="Espacio que ocupa en este navegador"
            >
              {formatearBytes(item.size)}
            </span>
          </p>
        )}

        {/* Estado ausente/error: insignia + revinculado, nunca solo miniatura rota. */}
        {isUnavailable && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span
              data-testid="media-status-badge"
              title={
                isMissing
                  ? 'Este medio no está disponible'
                  : 'Este medio no se puede decodificar'
              }
            >
              <Badge variant={isMissing ? 'danger' : 'warning'}>
                {isMissing ? 'medio ausente' : 'error de medio'}
              </Badge>
            </span>
            {onRevincular && (
              <Button
                size="sm"
                variant="secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  onRevincular?.(item.id);
                }}
                title={`Revincular ${item.name} con un archivo local`}
                aria-label={`Revincular ${item.name}`}
              >
                Revincular
              </Button>
            )}
          </div>
        )}

        {/* F1: el motivo de un rechazo de inserción (nunca un no-op
            silencioso). Caja compacta de una línea con el motivo completo en
            el tooltip: el bloque de 6 líneas rompía el ritmo del bin. */}
        {refusal && (
          <p
            data-testid="media-card-refusal"
            role="alert"
            title={refusal}
            className="mt-1 truncate rounded border border-danger/40 bg-danger/10 px-1.5 py-1 text-[10px] leading-tight text-danger"
          >
            {refusal}
          </p>
        )}
      </div>

      {/* La ÚNICA acción de añadir + la papelera: capa superpuesta a la
          derecha que solo se muestra al hover/foco (no reserva ancho: el
          nombre usa toda la fila y llega a 2 líneas). Con puntero grueso
          (`pointer: coarse`) siguen fijas en la fila a 44 px. El clic por JS
          de la suite (KI-05) funciona igual oculta o visible. */}
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded border border-border-subtle bg-panel px-1 py-0.5 opacity-0 shadow-overlay transition group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:static [@media(pointer:coarse)]:translate-y-0 [@media(pointer:coarse)]:border-transparent [@media(pointer:coarse)]:bg-transparent [@media(pointer:coarse)]:px-0 [@media(pointer:coarse)]:py-0 [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:shadow-none">
        <IconButton
          size="sm"
          aria-label={`Añadir ${item.name} a la línea de tiempo`}
          title="Añadir a la línea de tiempo"
          onClick={(e) => handleAdd(e)}
          className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
        >
          <Plus size={16} />
        </IconButton>
        <IconButton
          size="sm"
          aria-label={`Mover ${item.name} a la papelera`}
          title="Mover a la papelera (se puede restaurar)"
          onClick={handleRemove}
          className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
        >
          <Trash2 size={16} />
        </IconButton>
      </div>
    </div>
  );
};
