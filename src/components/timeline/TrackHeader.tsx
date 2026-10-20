import React, { useRef, useState } from 'react';
import {
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
import { Track, TrackType } from '../../types/project';
import { useProjectStore } from '../../store/useProjectStore';
import { IconButton } from '../ui/IconButton';
import { Badge } from '../ui/Badge';
import { Menu, MenuItem, MenuSeparador } from '../ui/Menu';

interface TrackHeaderProps {
  track: Track;
  index?: number;
}

/** F2 · El color del tipo es una marca de 2 px, no una pastilla. */
const MARCA_POR_TIPO: Record<TrackType, string> = {
  video: 'bg-clip-video',
  audio: 'bg-clip-audio',
  text: 'bg-clip-text',
};

export const TrackHeader: React.FC<TrackHeaderProps> = ({ track, index }) => {
  const toggleTrackMute = useProjectStore((s) => s.toggleTrackMute);
  const toggleTrackLock = useProjectStore((s) => s.toggleTrackLock);
  const toggleTrackVisibility = useProjectStore((s) => s.toggleTrackVisibility);
  const removeTrack = useProjectStore((s) => s.removeTrack);
  const duplicateTrack = useProjectStore((s) => s.duplicateTrack);
  const reorderTrack = useProjectStore((s) => s.reorderTrack);
  const tracks = useProjectStore((s) => s.project.tracks);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const trackIndex = typeof index === 'number' ? index : tracks.findIndex((t) => t.id === track.id);
  const canDelete = tracks.length > 1;
  const canMoveUp = trackIndex > 0;
  const canMoveDown = trackIndex !== -1 && trackIndex < tracks.length - 1;

  /** F2 · El mínimo legible es el código corto (V1/A1/T1), nunca un recorte a 3 letras. */
  const codigo = (() => {
    const num = track.name.match(/\d+/)?.[0] || '1';
    return `${track.type[0].toUpperCase()}${num}`;
  })();

  const tituloVisibilidad = track.isVisible ? 'Ocultar pista' : 'Mostrar pista';
  const tituloSonido = track.isMuted ? 'Activar sonido' : 'Silenciar pista';
  const tituloBloqueo = track.isLocked ? 'Desbloquear pista' : 'Bloquear pista';

  const devolverFoco = () => menuBtnRef.current?.focus();

  return (
    <div
      data-testid={`track-header-${track.id}`}
      className="h-14 px-2 bg-panel border-b border-r border-border-subtle flex flex-col justify-center gap-1 select-none overflow-hidden"
    >
      {/* Fila 1 · Marca de tipo + código + nombre real (el nombre completo vive en el title). */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span aria-hidden="true" className={`w-0.5 self-stretch rounded-sm ${MARCA_POR_TIPO[track.type]}`} />
        <Badge variant="neutral">
          <span className="font-mono">{codigo}</span>
        </Badge>
        <span className="text-body-sm font-medium text-text-1 truncate" title={track.name}>
          {track.name}
        </span>
      </div>

      {/*
        Fila 2 · Como mucho 3 micro-controles + el disparador del menú.
        Por debajo de 400 px solo quedan visibilidad y menú en línea; sonido y
        bloqueo se mudan al menú para no pintar sobre los carriles.
      */}
      <div className="flex items-center gap-0.5 shrink-0">
        <IconButton
          size="sm"
          aria-label={tituloVisibilidad}
          title={tituloVisibilidad}
          onClick={(e) => {
            e.stopPropagation();
            toggleTrackVisibility(track.id);
          }}
          className={track.isVisible ? '' : 'text-warning'}
        >
          {track.isVisible ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconButton>

        {track.type !== 'text' && (
          <IconButton
            size="sm"
            aria-label={tituloSonido}
            title={tituloSonido}
            onClick={(e) => {
              e.stopPropagation();
              toggleTrackMute(track.id);
            }}
            className={`hidden min-[400px]:inline-flex ${track.isMuted ? 'text-danger' : ''}`}
          >
            {track.isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </IconButton>
        )}

        <IconButton
          size="sm"
          aria-label={tituloBloqueo}
          title={tituloBloqueo}
          onClick={(e) => {
            e.stopPropagation();
            toggleTrackLock(track.id);
          }}
          className={`hidden min-[400px]:inline-flex ${track.isLocked ? 'text-warning' : ''}`}
        >
          {track.isLocked ? <Lock size={14} /> : <Unlock size={14} />}
        </IconButton>

        <IconButton
          ref={menuBtnRef}
          size="sm"
          aria-label="Opciones de pista"
          title="Opciones de pista"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          data-testid={`track-menu-btn-${track.id}`}
          active={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((open) => !open);
          }}
        >
          <MoreVertical size={14} />
        </IconButton>
      </div>

      {/* F2 · El menú de la pista es un Menu del sistema (portal, sin blur, sin goto casero). */}
      <Menu
        ancla={menuBtnRef}
        abierto={menuOpen}
        onCerrar={() => setMenuOpen(false)}
        ariaLabel="Opciones de pista"
      >
        <div className="px-2.5 py-1.5 text-caption text-text-2 flex items-center justify-between gap-2 uppercase">
          <span className="truncate normal-case text-body-sm text-text-1">{track.name}</span>
          <span className="shrink-0">{track.type}</span>
        </div>
        <MenuSeparador />

        {/* Sonido y bloqueo: solo donde están ocultos en línea (< 400 px). */}
        {track.type !== 'text' && (
          <MenuItem
            className="min-[400px]:hidden"
            icon={track.isMuted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
            data-testid={`track-menu-mute-${track.id}`}
            onClick={() => {
              toggleTrackMute(track.id);
              devolverFoco();
            }}
          >
            {tituloSonido}
          </MenuItem>
        )}
        <MenuItem
          className="min-[400px]:hidden"
          icon={track.isLocked ? <Lock size={14} aria-hidden="true" /> : <Unlock size={14} aria-hidden="true" />}
          data-testid={`track-menu-lock-${track.id}`}
          onClick={() => {
            toggleTrackLock(track.id);
            devolverFoco();
          }}
        >
          {tituloBloqueo}
        </MenuItem>

        <MenuItem
          icon={<Copy size={14} aria-hidden="true" />}
          data-testid={`track-menu-duplicate-${track.id}`}
          onClick={() => {
            duplicateTrack(track.id);
            devolverFoco();
          }}
        >
          Duplicar pista
        </MenuItem>
        <MenuItem
          icon={<ArrowUp size={14} aria-hidden="true" />}
          data-testid={`track-menu-up-${track.id}`}
          disabled={!canMoveUp}
          onClick={() => {
            reorderTrack(track.id, 'up');
            devolverFoco();
          }}
        >
          Subir pista
        </MenuItem>
        <MenuItem
          icon={<ArrowDown size={14} aria-hidden="true" />}
          data-testid={`track-menu-down-${track.id}`}
          disabled={!canMoveDown}
          onClick={() => {
            reorderTrack(track.id, 'down');
            devolverFoco();
          }}
        >
          Bajar pista
        </MenuItem>

        {canDelete && (
          <>
            <MenuSeparador />
            <MenuItem
              danger
              icon={<Trash2 size={14} aria-hidden="true" />}
              data-testid={`track-menu-delete-${track.id}`}
              onClick={() => {
                removeTrack(track.id);
                devolverFoco();
              }}
            >
              Eliminar pista
            </MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
};
