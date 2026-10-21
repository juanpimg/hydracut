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

/**
 * Botón «Dividir» con estado imperativo.
 *
 * R5 (aislamiento de renders): el estado habilitado/deshabilitado se escribe
 * DIRECTO en el DOM (prop `disabled` + `aria-label`) desde la suscripción al
 * `masterClock`, sin ningún `setState` por tick y sin hooks de viewport (esta
 * barra se monta en un DOM simulado sin `matchMedia`: lo compacto es solo
 * CSS con `[@media(max-height:500px)]`, que nunca provoca un commit React).
 * `MobileBottomBar` confirma un solo commit durante 600 ticks de reproducción
 * simulada: no añadir aquí suscripciones al store que cambien durante la
 * reproducción.
 *
 * Contrato de etiquetas (fijado por tests):
 * - modo global: habilitado `Dividir en el cabezal` exacto; deshabilitado la
 *   misma base con el motivo (`…no disponible…`).
 * - modo clip: habilitado `Dividir en el cabezal`; deshabilitado
 *   `Sin clip bajo el cabezal`.
 */
export const MobileSplitButton: React.FC<MobileSplitButtonProps> = ({ mode, onSplit }) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const clips = useProjectStore((s) => s.project.clips);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;

  // Etiquetas fijadas por tests (R5 + LAYOUT-MOBILE-SPLIT): el modo global
  // usa la base `Dividir en cabezal` exacta en habilitado y con el motivo en
  // deshabilitado. El modo clip comparte la base en habilitado; en
  // deshabilitado da el motivo corto aprobado (`Sin clip bajo el cabezal`).
  const enabledLabel = 'Dividir en cabezal';
  const disabledLabel =
    mode === 'clip'
      ? 'Sin clip bajo el cabezal'
      : 'Dividir en cabezal (no disponible: coloca el cabezal dentro de un clip)';

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
          can ? enabledLabel : disabledLabel
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips, mode]);

  return (
    <button
      ref={buttonRef}
      onClick={onSplit}
      disabled={!canSplitNow()}
      className="flex flex-col items-center justify-center min-w-14 min-h-12 [@media(max-height:500px)]:min-h-10 px-2 rounded text-text-2 hover:text-text-1 hover:bg-raised active:bg-raised active:scale-95 transition disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      title={canSplitNow() ? enabledLabel : disabledLabel}
      aria-label={canSplitNow() ? enabledLabel : disabledLabel}
    >
      <Scissors size={20} aria-hidden="true" />
      <span className="text-caption mt-0.5 font-medium whitespace-nowrap [@media(max-height:500px)]:hidden">Dividir</span>
    </button>
  );
};

/** Etiqueta de la tira: caption legible, nunca truncada; solo icono en apaisado. */
const EtiquetaTira: React.FC<{ texto: string }> = ({ texto }) => (
  <span className="text-caption mt-0.5 font-medium whitespace-nowrap [@media(max-height:500px)]:hidden">
    {texto}
  </span>
);

/**
 * Tira de herramientas contextual (modelo CapCut): sin clip muestra las
 * herramientas globales (Medios / Texto / Audio / Dividir); con un clip
 * seleccionado muestra las del clip (Cerrar / Inspector / Dividir /
 * Velocidad / Volumen / Fundido / Opacidad / Eliminar).
 *
 * Tira neutra y plana: iconos de 20 px en un solo peso, sin baldosas de
 * colores. El rojo solo aparece en la acción destructiva (semántico, no
 * decoración) y el acento queda reservado al significado.
 */
export const MobileBottomBar: React.FC<MobileBottomBarProps> = ({ onOpenSheet }) => {
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const selectClip = useProjectStore((s) => s.selectClip);
  const splitAtPlayhead = useProjectStore((s) => s.splitAtPlayhead);
  const deleteSelectedClip = useProjectStore((s) => s.deleteSelectedClip);

  const hasSelectedClip = !!selectedClipId;

  const handleDelete = () => {
    if (confirm('¿Eliminar este clip? Puedes deshacerlo.')) {
      deleteSelectedClip();
    }
  };

  /** Botón de la tira: 44 px en vertical, 40 px solo-icono en apaisado. */
  const tiraBtn =
    'flex flex-col items-center justify-center min-w-14 min-h-12 [@media(max-height:500px)]:min-h-10 px-2 rounded text-text-2 hover:text-text-1 hover:bg-raised active:bg-raised active:scale-95 transition focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none';

  return (
    // `min-h-16` (en vez de un `h-16` fijo) para que el relleno del área
    // segura agrande la barra en lugar de comprimir su contenido.
    <nav
      aria-label={hasSelectedClip ? 'Herramientas del clip' : 'Herramientas'}
      className="min-h-16 [@media(max-height:500px)]:min-h-10 bg-panel border-t border-border-subtle px-2 flex items-center z-30 select-none shrink-0 pb-[env(safe-area-inset-bottom)] overflow-x-auto no-scrollbar"
    >
      {hasSelectedClip ? (
        /* MODO 2: acciones del clip seleccionado. `justify-start` (nunca
            `around`/`center`): con desborde el inicio queda anclado y el
            último útil asoma a medio ver — ese recorte es el affordance de
            scroll. Las etiquetas son `whitespace-nowrap`: nunca ellipsis. */
        <div className="flex items-center gap-1 w-full min-w-max justify-start py-1">
          {/* Quitar la selección */}
          <button
            onClick={() => selectClip(null)}
            className={tiraBtn}
            title="Quitar la selección"
            aria-label="Quitar la selección"
          >
            <X size={20} aria-hidden="true" />
            <EtiquetaTira texto="Cerrar" />
          </button>

          {/* Inspector del clip (transformación, silencio, texto…) */}
          <button
            onClick={() => onOpenSheet('inspector')}
            className={tiraBtn}
            title="Inspector"
            aria-label="Abrir el inspector"
            data-testid="mobile-clip-properties"
          >
            <Sliders size={20} aria-hidden="true" />
            <EtiquetaTira texto="Inspector" />
          </button>

          {/* Dividir */}
          <MobileSplitButton mode="clip" onSplit={splitAtPlayhead} />

          {/* Velocidad */}
          <button
            onClick={() => onOpenSheet('speed')}
            className={tiraBtn}
            title="Velocidad"
            aria-label="Velocidad del clip"
          >
            <Gauge size={20} aria-hidden="true" />
            <EtiquetaTira texto="Velocidad" />
          </button>

          {/* Volumen */}
          <button
            onClick={() => onOpenSheet('volume')}
            className={tiraBtn}
            title="Volumen"
            aria-label="Volumen del clip"
          >
            <Volume2 size={20} aria-hidden="true" />
            <EtiquetaTira texto="Volumen" />
          </button>

          {/* Fundidos */}
          <button
            onClick={() => onOpenSheet('transition')}
            className={tiraBtn}
            title="Fundidos"
            aria-label="Fundidos del clip"
          >
            <Sparkles size={20} aria-hidden="true" />
            <EtiquetaTira texto="Fundido" />
          </button>

          {/* Opacidad */}
          <button
            onClick={() => onOpenSheet('opacity')}
            className={tiraBtn}
            title="Opacidad"
            aria-label="Opacidad del clip"
          >
            <Eye size={20} aria-hidden="true" />
            <EtiquetaTira texto="Opacidad" />
          </button>

          {/* Eliminar */}
          <button
            onClick={handleDelete}
            className="flex flex-col items-center justify-center min-w-14 min-h-12 [@media(max-height:500px)]:min-h-10 px-2 rounded text-danger hover:bg-raised active:bg-raised active:scale-95 transition focus-visible:ring-2 focus-visible:ring-danger focus-visible:outline-none"
            title="Eliminar clip"
            aria-label="Eliminar clip seleccionado"
          >
            <Trash2 size={20} aria-hidden="true" />
            <EtiquetaTira texto="Eliminar" />
          </button>
        </div>
      ) : (
        /* MODO 1: acciones globales (mismo anclaje al inicio: el desborde
            asoma el último útil en vez de recortar una etiqueta). */
        <div className="flex items-center gap-2 w-full min-w-max justify-start py-1">
          {/* Medios */}
          <button
            onClick={() => onOpenSheet('media')}
            className={`${tiraBtn} min-w-16`}
            title="Añadir medios"
            aria-label="Abrir medios"
          >
            <FolderPlus size={20} aria-hidden="true" />
            <EtiquetaTira texto="Medios" />
          </button>

          {/* Texto */}
          <button
            onClick={() => onOpenSheet('text')}
            className={`${tiraBtn} min-w-16`}
            title="Texto"
            aria-label="Añadir texto"
          >
            <Type size={20} aria-hidden="true" />
            <EtiquetaTira texto="Texto" />
          </button>

          {/* Audio */}
          <button
            onClick={() => onOpenSheet('audio')}
            className={`${tiraBtn} min-w-16`}
            title="Audio"
            aria-label="Abrir audio"
            data-testid="mobile-audio-button"
          >
            <Music size={20} aria-hidden="true" />
            <EtiquetaTira texto="Audio" />
          </button>

          {/* Dividir en el cabezal */}
          <MobileSplitButton mode="global" onSplit={splitAtPlayhead} />
        </div>
      )}
    </nav>
  );
};
