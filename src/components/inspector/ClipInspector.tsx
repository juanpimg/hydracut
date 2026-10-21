import {
  Trash2,
  Volume2,
  VolumeX,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Sliders,
  CheckSquare,
  AlertTriangle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Section } from '../ui/Section';
import { Slider } from '../ui/Slider';
import { Badge } from '../ui/Badge';
import { Clip, AudioFadeCurve, ClipColorFilters, LyricAnimationPreset, OverlapPolicy, TrackRole, TransitionType } from '../../types/project';
import {
  DEFAULT_OVERLAP_POLICY,
  getBatchOperationAvailability,
  orderClipsByTimeline,
  useProjectStore,
} from '../../store/useProjectStore';
import { formatDuration } from '../../core/utils/time';
import {
  TEXT_PRESETS,
  matchTextPreset,
} from '../../core/utils/textPresets';
import {
  COLOR_FILTER_PRESETS,
  COLOR_FILTER_PRESET_ORDER,
  COLOR_FILTER_UNSUPPORTED_MESSAGE,
  getCanvasFilterSupport,
  matchColorFilterPreset,
  type ColorFilterKey,
  type ColorFilterPresetId,
} from '../../core/utils/colorFilters';
import {
  CROSSFADE_DEFAULT_DURATION,
  crossfadeFrameDuration,
  describeCrossfadeForClip,
} from '../../core/utils/crossfade';
import {
  AUDIO_FADE_DEFAULT_DURATION,
  DEFAULT_AUDIO_FADE_CURVE,
  audioFadeFrameDuration,
} from '../../core/utils/audioFades';
import { evaluateKeyframes } from '../../core/utils/keyframes';
import { FADE_IN_OPTIONS, FADE_OUT_OPTIONS } from '../../core/utils/transitionOptions';
import {
  BIQUAD_FILTER_UNSUPPORTED_MESSAGE,
  EQ_DB_MAX,
  EQ_DB_MIN,
  STEREO_PANNER_UNSUPPORTED_MESSAGE,
  TRACK_ROLE_LABELS,
  getBiquadFilterSupport,
  getStereoPannerSupport,
} from '../../core/utils/audioEffects';
import { formatearDuracion } from '../../utils/formato';

/**
 * The six sliders of the "Color" section (F9).
 *
 * They live at module level (not inside the component) so that rendering the
 * inspector never allocates them again.
 */
const COLOR_SLIDERS: ReadonlyArray<{
  key: ColorFilterKey;
  label: string;
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
  neutral: number;
  format: (value: number) => string;
}> = [
  {
    key: 'brightness',
    label: 'Brillo',
    ariaLabel: 'Brillo del clip',
    min: 0,
    max: 2,
    step: 0.01,
    neutral: 1,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'contrast',
    label: 'Contraste',
    ariaLabel: 'Contraste del clip',
    min: 0,
    max: 2,
    step: 0.01,
    neutral: 1,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'saturation',
    label: 'Saturación',
    ariaLabel: 'Saturación del clip',
    min: 0,
    max: 2,
    step: 0.01,
    neutral: 1,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'temperature',
    label: 'Temperatura',
    ariaLabel: 'Temperatura del clip',
    min: -1,
    max: 1,
    step: 0.01,
    neutral: 0,
    format: (v) =>
      v > 0.01 ? `Cálido ${Math.round(v * 100)}%` : v < -0.01 ? `Frío ${Math.round(-v * 100)}%` : 'Neutra',
  },
  {
    key: 'grayscale',
    label: 'Blanco y negro',
    ariaLabel: 'Blanco y negro del clip',
    min: 0,
    max: 1,
    step: 0.01,
    neutral: 0,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'sepia',
    label: 'Sepia',
    ariaLabel: 'Sepia del clip',
    min: 0,
    max: 1,
    step: 0.01,
    neutral: 0,
    format: (v) => `${Math.round(v * 100)}%`,
  },
];

/**
 * Las tres bandas de la sección "Efectos de audio".
 *
 * A nivel de módulo (no dentro del componente) para no reasignarlas en cada
 * render, igual que `COLOR_SLIDERS`.
 */
const EQ_SLIDERS: ReadonlyArray<{
  key: 'low' | 'mid' | 'high';
  label: string;
  ariaLabel: string;
  hint: string;
}> = [
  {
    key: 'low',
    label: 'Graves',
    ariaLabel: 'Ecualizador de graves del clip',
    hint: 'Realza o atenúa los graves (lowshelf a 320 Hz).',
  },
  {
    key: 'mid',
    label: 'Medios',
    ariaLabel: 'Ecualizador de medios del clip',
    hint: 'Realza o atenúa los medios (peaking a 1000 Hz).',
  },
  {
    key: 'high',
    label: 'Agudos',
    ariaLabel: 'Ecualizador de agudos del clip',
    hint: 'Realza o atenúa los agudos (highshelf a 3200 Hz).',
  },
];

/** Human readable description of every overlap policy (F1). */
export const OVERLAP_POLICY_LABELS: Record<OverlapPolicy, { label: string; hint: string }> = {
  block: {
    label: 'Bloquear',
    hint: 'No se inserta un clip si el destino ya está ocupado: te avisa del conflicto.',
  },
  overwrite: {
    label: 'Sobrescribir',
    hint: 'El clip nuevo recorta la parte solapada del clip existente.',
  },
  ripple: {
    label: 'Desplazar',
    hint: 'Los clips posteriores de la pista se desplazan para hacer sitio.',
  },
};

/**
 * F6 · Value shared by EVERY clip of a selection.
 *
 * `null` means the selection is MIXED (the clips do not share the value): the
 * control then shows the value of the primary clip and the "mixto" hint.
 */
function commonValue<T>(clips: Clip[], read: (clip: Clip) => T): T | null {
  if (clips.length === 0) return null;
  const first = read(clips[0]);
  return clips.every((clip) => read(clip) === first) ? first : null;
}

/**
 * F6 · Panel shown when MORE THAN ONE clip is selected.
 *
 * Every edit is applied to the WHOLE selection (one undoable step). The
 * operations that do not make sense for a mixed selection (the speed of a
 * text clip, the opacity of an audio clip…) are DISABLED with a reason: they
 * are never applied "to some of the clips".
 */const MultiSelectionPanel: React.FC<{ clips: Clip[] }> = ({ clips }) => {
  const setSelectedClipsVolume = useProjectStore((s) => s.setSelectedClipsVolume);
  const setSelectedClipsOpacity = useProjectStore((s) => s.setSelectedClipsOpacity);
  const setSelectedClipsSpeed = useProjectStore((s) => s.setSelectedClipsSpeed);
  const setSelectedClipsMuted = useProjectStore((s) => s.setSelectedClipsMuted);
  const deleteSelectedClips = useProjectStore((s) => s.deleteSelectedClips);

  const count = clips.length;
  const trackNames = Array.from(new Set(clips.map((c) => c.trackId)));

  const volumeOp = getBatchOperationAvailability(clips, 'volume');
  const opacityOp = getBatchOperationAvailability(clips, 'opacity');
  const speedOp = getBatchOperationAvailability(clips, 'speed');
  const mutedOp = getBatchOperationAvailability(clips, 'muted');

  const sharedVolume = commonValue(clips, (c) => c.volume ?? 1);
  const sharedOpacity = commonValue(clips, (c) => c.opacity ?? 1);
  const sharedSpeed = commonValue(clips, (c) => c.speed ?? 1);
  const sharedMuted = commonValue(clips, (c) => c.muted === true);

  const primary = clips[0];
  const volumeValue = sharedVolume ?? primary.volume ?? 1;
  const opacityValue = sharedOpacity ?? primary.opacity ?? 1;
  const speedValue = sharedSpeed ?? primary.speed ?? 1;
  const mutedValue = sharedMuted ?? primary.muted === true;

  return (
    <div data-testid="inspector-multi-selection">
      {/* Cabecera de lote (la única cabecera «Inspector» es la del panel). */}
      <div className="flex items-center justify-between border-b border-border-subtle px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <CheckSquare size={16} className="text-text-2" />
          <span className="text-sm font-semibold text-text-1">Selección múltiple</span>
        </div>
        <button
          onClick={() => {
            if (confirm(`¿Eliminar los ${count} clips seleccionados? Puedes deshacerlo con Ctrl+Z.`)) {
              deleteSelectedClips();
            }
          }}
          className="p-1.5 text-danger hover:text-danger hover:bg-danger/10 rounded transition"
          title={`Eliminar ${count} clips (Supr)`}
          aria-label={`Eliminar los ${count} clips seleccionados`}
        >
          <Trash2 size={15} />
        </button>
      </div>

      {/* F6 · The count of the selection (the user MUST know it is a batch). */}
      <div
        data-testid="inspector-multi-selection-count"
        className="mx-3 mt-3 flex items-center gap-2 rounded border border-border-subtle bg-raised p-2.5 text-xs"
      >
        <CheckSquare size={14} className="shrink-0 text-accent" />
        <span className="font-semibold text-text-1">
          {count} clips seleccionados
        </span>
      </div>

      {/* Summary */}
      <div className="mx-3 space-y-1 rounded border border-border-subtle bg-raised p-2.5 text-xs">
        <div className="flex justify-between text-text-2">
          <span>Clips:</span>
          <span className="font-medium text-text-1">{count}</span>
        </div>
        <div className="flex justify-between text-text-2">
          <span>Pistas:</span>
          <span className="font-medium text-accent">{trackNames.length}</span>
        </div>
        <p className="pt-1 text-[10px] leading-snug text-text-3">
          Las ediciones de este panel se aplican a TODOS los clips seleccionados en un solo paso
          (se deshacen con una sola vez de Ctrl+Z).
        </p>
      </div>

      {/* BATCH · Volume + mute */}
      <Section
        titulo="Audio"
        alRestablecer={() => {
          setSelectedClipsVolume(1);
          setSelectedClipsMuted(false);
        }}
        etiquetaRestablecer="Restablecer el audio de los clips seleccionados"
      >
        <div>
          <div className="mb-1 flex justify-between text-xs text-text-2">
            <span>Volumen:</span>
            <span className="font-mono text-text-1">
              {sharedVolume === null ? 'Mixto' : `${Math.round(sharedVolume * 100)}%`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={volumeValue}
              disabled={!volumeOp.enabled}
              data-testid="batch-volume"
              aria-label="Volumen de los clips seleccionados"
              onChange={(e) => setSelectedClipsVolume(parseFloat(e.target.value))}
              className="h-1.5 flex-1 cursor-pointer rounded bg-overlay accent-accent disabled:cursor-not-allowed disabled:opacity-40"
            />
            <button
              onClick={() => setSelectedClipsMuted(!mutedValue)}
              disabled={!mutedOp.enabled}
              data-testid="batch-mute"
              aria-label={mutedValue ? 'Activar sonido de los clips seleccionados' : 'Silenciar los clips seleccionados'}
              className={`rounded p-1.5 transition disabled:opacity-40 ${
                mutedValue
                  ? 'border border-danger/50 bg-danger/15 text-danger'
                  : 'bg-raised text-text-2 hover:text-text-1'
              }`}
              title={mutedValue ? 'Activar sonido' : 'Silenciar los clips seleccionados'}
            >
              {mutedValue ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
          </div>
          {(!volumeOp.enabled || !mutedOp.enabled) && (
            <p
              role="status"
              data-testid="batch-audio-disabled-reason"
              className="mt-1 rounded border border-warning/40 bg-warning/10 p-2 text-[10px] leading-snug text-warning"
            >
              {volumeOp.reason ?? mutedOp.reason}
            </p>
          )}
        </div>
      </Section>

      {/* BATCH · Opacity */}
      <Section
        titulo="Opacidad"
        alRestablecer={() => setSelectedClipsOpacity(1)}
        etiquetaRestablecer="Restablecer la opacidad de los clips seleccionados"
      >
        <div>
          <div className="mb-1 flex justify-between text-xs text-text-2">
            <span>Opacidad:</span>
            <span className="font-mono text-text-1">
              {sharedOpacity === null ? 'Mixto' : `${Math.round(sharedOpacity * 100)}%`}
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={opacityValue}
            disabled={!opacityOp.enabled}
            data-testid="batch-opacity"
            aria-label="Opacidad de los clips seleccionados"
            onChange={(e) => setSelectedClipsOpacity(parseFloat(e.target.value))}
            className="h-1.5 w-full cursor-pointer rounded bg-overlay accent-accent disabled:cursor-not-allowed disabled:opacity-40"
          />
          {!opacityOp.enabled && (
            <p
              role="status"
              data-testid="batch-opacity-disabled-reason"
              className="mt-1 rounded border border-warning/40 bg-warning/10 p-2 text-[10px] leading-snug text-warning"
            >
              {opacityOp.reason}
            </p>
          )}
        </div>
      </Section>

      {/* BATCH · Speed */}
      <Section
        titulo="Velocidad"
        alRestablecer={() => setSelectedClipsSpeed(1)}
        etiquetaRestablecer="Restablecer la velocidad de los clips seleccionados"
      >
        <div className="space-y-2 rounded border border-border-subtle bg-raised p-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-2">Velocidad:</span>
            <span className="font-mono font-semibold text-accent">
              {sharedSpeed === null ? 'Mixto' : `${sharedSpeed}x`}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {[0.5, 1, 1.5, 2].map((spd) => (
              <button
                key={spd}
                disabled={!speedOp.enabled}
                onClick={() => setSelectedClipsSpeed(spd)}
                aria-label={`Aplicar una velocidad de ${spd}x a los clips seleccionados`}
                className={`rounded border py-1 font-mono text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  sharedSpeed === spd
                    ? 'border-accent-fill bg-accent-fill font-bold text-white'
                    : 'border-border bg-panel text-text-2 hover:bg-raised hover:text-text-1'
                }`}
              >
                {spd}x
              </button>
            ))}
          </div>
          <input
            type="range"
            min="0.25"
            max="4"
            step="0.25"
            value={speedValue}
            disabled={!speedOp.enabled}
            data-testid="batch-speed"
            aria-label="Velocidad de los clips seleccionados"
            onChange={(e) => setSelectedClipsSpeed(parseFloat(e.target.value))}
            className="h-1.5 w-full cursor-pointer rounded bg-overlay accent-accent disabled:cursor-not-allowed disabled:opacity-40"
          />
          {!speedOp.enabled && (
            <p
              role="status"
              data-testid="batch-speed-disabled-reason"
              className="rounded border border-warning/40 bg-warning/10 p-2 text-[10px] leading-snug text-warning"
            >
              {speedOp.reason}
            </p>
          )}
        </div>
      </Section>
    </div>
  );
};

export const ClipInspector: React.FC = () => {
  const clip = useProjectStore((s) => s.project.clips.find((c) => c.id === s.selectedClipId));
  const selectedClipIds = useProjectStore((s) => s.selectedClipIds);
  const project = useProjectStore((s) => s.project);
  const track = useProjectStore((s) => s.project.tracks.find((t) => t.id === clip?.trackId));
  const updateClip = useProjectStore((s) => s.updateClip);
  const removeClip = useProjectStore((s) => s.removeClip);
  const mediaPool = useProjectStore((s) => s.project.mediaPool);
  const overlapPolicy = useProjectStore((s) => s.project.overlapPolicy ?? DEFAULT_OVERLAP_POLICY);
  const setOverlapPolicy = useProjectStore((s) => s.setOverlapPolicy);
  const projectFps = useProjectStore((s) => s.project.fps);
  const currentTime = useProjectStore((s) => s.currentTime);
  const addKeyframe = useProjectStore((s) => s.addKeyframe);
  const removeKeyframe = useProjectStore((s) => s.removeKeyframe);
  const updateKeyframe = useProjectStore((s) => s.updateKeyframe);
  const clearKeyframes = useProjectStore((s) => s.clearKeyframes);
  const applyTextPreset = useProjectStore((s) => s.applyTextPreset);
  const createCrossfade = useProjectStore((s) => s.createCrossfade);
  const removeCrossfade = useProjectStore((s) => s.removeCrossfade);
  const setCrossfadeDuration = useProjectStore((s) => s.setCrossfadeDuration);
  const setTrackRole = useProjectStore((s) => s.setTrackRole);

  /**
   * F9 · Does the browser support `ctx.filter`?
   *
   * `null` = still unknown (the probe runs on mount). The controls stay
   * disabled until the answer is known, so the user never gets a control
   * that silently does nothing.
   */
  const [filterSupport, setFilterSupport] = useState<boolean | null>(null);
  useEffect(() => {
    setFilterSupport(getCanvasFilterSupport());
  }, []);
  const colorFiltersEnabled = filterSupport === true;

  /**
   * Efectos de audio: ¿soporta el navegador el paneo estéreo y la EQ?
   *
   * `null` = aún sin saber (la sonda corre al montar). Los controles quedan
   * desactivados hasta saber la respuesta, igual que los filtros de color:
   * un control que no hace nada en silencio no es aceptable.
   */
  const [pannerSupport, setPannerSupport] = useState<boolean | null>(null);
  const [biquadSupport, setBiquadSupport] = useState<boolean | null>(null);
  useEffect(() => {
    setPannerSupport(getStereoPannerSupport());
    setBiquadSupport(getBiquadFilterSupport());
  }, []);
  const panEnabled = pannerSupport === true;
  const eqEnabled = biquadSupport === true;

  /**
   * F8 · Keyframe seleccionado para editar (tiempo relativo al clip).
   *
   * Mientras hay uno seleccionado, los deslizadores de transformación editan
   * ESE keyframe (vía `updateKeyframe`) en vez del valor fijo del clip. Se
   * limpia al cambiar de clip.
   */
  const [selectedKeyframeT, setSelectedKeyframeT] = useState<number | null>(null);
  useEffect(() => {
    setSelectedKeyframeT(null);
    // Solo al cambiar de clip.
  }, [clip?.id]);

  /**
   * F5 · Disponibilidad del fundido de cruce para el clip seleccionado.
   *
   * La MISMA lógica pura que valida el store (`describeCrossfadeForClip`),
   * así que el motivo por el que el control está deshabilitado es siempre el
   * motivo por el que el store rechazaría la operación.
   */
  const crossfadeInfo = useMemo(
    () =>
      describeCrossfadeForClip(
        project.clips,
        project.tracks,
        clip?.id ?? '',
        projectFps ?? 30
      ),
    [project.clips, project.tracks, clip?.id, projectFps]
  );

  /**
   * F5 · Duración deseada para CREAR el fundido (el fundido activo se edita
   * directamente con su duración real). Se reinicia al cambiar de clip.
   */
  const [desiredCrossfade, setDesiredCrossfade] = useState(CROSSFADE_DEFAULT_DURATION);
  useEffect(() => {
    setDesiredCrossfade(
      crossfadeInfo.currentDuration > 0
        ? crossfadeInfo.currentDuration
        : Math.min(
            CROSSFADE_DEFAULT_DURATION,
            crossfadeInfo.maxDuration > 0 ? crossfadeInfo.maxDuration : CROSSFADE_DEFAULT_DURATION
          )
    );
    // Solo al cambiar de clip: la duración real manda mientras se arrastra.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id]);

  /**
   * F6 · The clips of the current selection, in timeline order.
   *
   * It is memoised (the store must NOT be asked for a fresh array on every
   * render: zustand would see a new reference and re-render forever).
   */
  const selectedClips = useMemo(() => {
    const selected = new Set(selectedClipIds);
    return orderClipsByTimeline(
      project.clips.filter((c) => selected.has(c.id)),
      project.tracks
    );
  }, [project.clips, project.tracks, selectedClipIds]);

  const policySection = (
    <div className="mt-auto space-y-2 px-3 pt-3 pb-3" data-testid="overlap-policy-section">
      <div className="text-caption font-medium tracking-wider text-text-2 uppercase">
        <span>Política de solapamiento</span>
      </div>
      <div className="space-y-2 rounded border border-border-subtle bg-raised p-2.5">
        <label htmlFor="overlap-policy-select" className="block text-[11px] text-text-2">
          Qué pasa al insertar un clip donde ya hay contenido:
        </label>
        <select
          id="overlap-policy-select"
          data-testid="overlap-policy-select"
          value={overlapPolicy}
          onChange={(e) => setOverlapPolicy(e.target.value as OverlapPolicy)}
          className="w-full rounded border border-border bg-panel p-1.5 text-xs text-text-1"
        >
          <option value="block">Bloquear (recomendado)</option>
          <option value="overwrite">Sobrescribir</option>
          <option value="ripple">Desplazar</option>
        </select>
        <p className="text-[10px] leading-snug text-text-3" data-testid="overlap-policy-hint">
          {OVERLAP_POLICY_LABELS[overlapPolicy]?.hint ?? ''}
        </p>
      </div>
    </div>
  );

  /**
   * F6 · More than one clip: the Inspector works in BATCH mode ("N clips
   * seleccionados") and every edit is applied to the whole selection.
   */
  if (selectedClips.length > 1) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-panel select-none">
        <MultiSelectionPanel clips={selectedClips} />
        {policySection}
      </div>
    );
  }

  if (!clip) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-panel select-none">
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center select-none">
          <Sliders size={32} className="mb-2 text-text-3" strokeWidth={1} />
          <p className="text-xs font-semibold text-text-1">Ningún clip seleccionado</p>
          <p className="mt-1 text-[11px] text-text-2">
            Selecciona un clip de la línea de tiempo para editarlo.
          </p>
        </div>
        {policySection}
      </div>
    );
  }
  const isVideoOrImage = clip.type === 'video' || clip.type === 'image';
  const hasAudio = clip.type === 'video' || clip.type === 'audio';
  const isText = clip.type === 'text';

  /**
   * F8 · Keyframes del clip y selección actual.
   *
   * `selectedKeyframe` es el keyframe que los deslizadores de transformación
   * están editando (`null` = editan el valor fijo del clip). Si el keyframe
   * desaparece (p. ej. lo borra un deshacer), la selección deja de apuntar.
   */
  const clipKeyframes = clip.keyframes ?? [];
  const selectedKeyframe =
    selectedKeyframeT !== null
      ? clipKeyframes.find((k) => k.t === selectedKeyframeT) ?? null
      : null;
  // Valores que muestran los deslizadores: los EFECTIVOS en el keyframe
  // seleccionado (con herencia de las propiedades ausentes) o los fijos.
  const keyframeEff = selectedKeyframe ? evaluateKeyframes(clip, selectedKeyframe.t) : null;
  const effScale = keyframeEff?.scale ?? clip.scale ?? 1;
  const effOpacity = keyframeEff?.opacity ?? clip.opacity ?? 1;
  const effX = keyframeEff?.x ?? clip.positionX ?? 0;
  const effY = keyframeEff?.y ?? clip.positionY ?? 0;
  // Instante del cabezal relativo al clip (para crear el keyframe).
  const playheadLocalT = currentTime - clip.start;
  const playheadInsideClip = playheadLocalT >= 0 && playheadLocalT <= clip.duration;

  // F9: the preset that matches the current filters (`null` = a custom
  // combination of the sliders).
  const selectedColorPreset = matchColorFilterPreset(clip.filters);

  // F3: the media of the selected clip is not usable.
  const clipMedia = clip.mediaId ? mediaPool.find((m) => m.id === clip.mediaId) : undefined;
  const mediaUnavailable = !isText && (!clipMedia || clipMedia.status === 'missing');
  const mediaBroken = !isText && !mediaUnavailable && clipMedia?.status === 'error';

  const fontOptions = [
    { label: 'Inter (Sans-serif)', value: 'Inter, sans-serif' },
    { label: 'Montserrat (Display Bold)', value: 'Montserrat, sans-serif' },
    { label: 'Bebas Neue (Condensed)', value: '"Bebas Neue", sans-serif' },
    { label: 'Oswald (Condensed Display)', value: 'Oswald, sans-serif' },
    { label: 'JetBrains Mono', value: 'JetBrains Mono, monospace' },
    { label: 'Georgia (Serif)', value: 'Georgia, serif' },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-panel select-none">
      {/* Fila del clip: subtítulo con su nombre (la única cabecera
          «Inspector» es la del panel). */}
      <div className="mb-0 flex items-center justify-between border-b border-border-subtle px-3 pt-3 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <Sliders size={16} className="shrink-0 text-text-2" />
          <span className="truncate text-sm font-semibold text-text-1" title={clip.name}>
            {clip.name}
          </span>
        </div>
        <button
          onClick={() => {
            if (confirm(`¿Eliminar el clip "${clip.name}"? Puedes deshacerlo con Ctrl+Z.`)) {
              removeClip(clip.id);
            }
          }}
          className="rounded p-1.5 text-danger transition hover:bg-danger/10"
          title="Eliminar clip (Supr)"
          aria-label={`Eliminar clip ${clip.name}`}
        >
          <Trash2 size={15} />
        </button>
      </div>

      {/* Clip Summary Card */}
      <div className="mx-3 mt-3 mb-0 space-y-1 rounded border border-border-subtle bg-raised p-2.5 text-xs">
        <div className="flex justify-between text-text-2">
          <span>Nombre:</span>
          <span className="max-w-[160px] truncate font-medium text-text-1">{clip.name}</span>
        </div>
        <div className="flex justify-between text-text-2">
          <span>Pista:</span>
          <span className="font-medium text-accent">{track?.name || 'Desconocida'}</span>
        </div>
        <div className="flex justify-between text-text-2">
          <span>Duración:</span>
          <span className="font-mono text-text-1">{formatDuration(clip.duration)}</span>
        </div>
      </div>

      {/* F3: the media of this clip is not available (B-14). */}
      {(mediaUnavailable || mediaBroken) && (
        <div
          data-testid="inspector-missing-media"
          role="alert"
          className="mx-3 mt-3 flex items-start gap-2 rounded border border-danger/50 bg-danger/10 p-2 text-[11px] text-text-1"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
          <span>
            {mediaUnavailable
              ? 'Este medio no está disponible: el clip se ve negro y sin sonido. Revínculalo desde Medios.'
              : 'Este medio no se puede decodificar. Revínculalo desde Medios.'}
          </span>
        </div>
      )}

      {/* TEXT PROPERTIES */}
      {isText && (
        <Section titulo="Texto">

          <div>
            <label htmlFor={`clip-text-${clip.id}`} className="mb-1 block text-[11px] text-text-2">Texto:</label>
            <textarea
              id={`clip-text-${clip.id}`}
              value={clip.text || ''}
              onChange={(e) => updateClip(clip.id, { text: e.target.value, name: e.target.value.slice(0, 20) || 'Texto' })}
              rows={3}
              className="w-full resize-none rounded border border-border bg-raised p-2 text-xs font-medium text-text-1"
            />
          </div>

          {/* Font Family & Size */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={`clip-font-${clip.id}`} className="mb-1 block text-[11px] text-text-2">Tipografía:</label>
              <select
                id={`clip-font-${clip.id}`}
                value={clip.textStyle?.fontFamily || 'Inter, sans-serif'}
                onChange={(e) =>
                  updateClip(clip.id, {
                    textStyle: { ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }), fontFamily: e.target.value },
                  })
                }
                className="w-full rounded border border-border bg-raised p-1.5 text-xs text-text-1"
              >
                {fontOptions.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[11px] text-text-2 block mb-1">
                Tamaño: {clip.textStyle?.fontSize || 48} px
              </label>
              <input
                type="range"
                min="18"
                max="120"
                value={clip.textStyle?.fontSize || 48}
                onChange={(e) =>
                  updateClip(clip.id, {
                    textStyle: { ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }), fontSize: parseInt(e.target.value) },
                  })
                }
                className="w-full h-1.5 bg-overlay accent-accent rounded cursor-pointer mt-2"
              />
            </div>
          </div>

          {/* Text Color & Background */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[11px] text-text-2">Color del texto:</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={clip.textStyle?.color || '#ffffff'}
                  onChange={(e) =>
                    updateClip(clip.id, {
                      textStyle: { ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }), color: e.target.value },
                    })
                  }
                  className="h-7 w-7 cursor-pointer rounded border border-border bg-transparent"
                />
                <span className="font-mono text-xs text-text-2">{clip.textStyle?.color || '#ffffff'}</span>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-text-2">Fondo:</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={clip.textStyle?.backgroundColor && clip.textStyle.backgroundColor !== 'transparent' ? clip.textStyle.backgroundColor : '#000000'}
                  onChange={(e) =>
                    updateClip(clip.id, {
                      textStyle: { ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }), backgroundColor: e.target.value },
                    })
                  }
                  className="h-7 w-7 cursor-pointer rounded border border-border bg-transparent"
                />
                <button
                  onClick={() =>
                    updateClip(clip.id, {
                      textStyle: { ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }), backgroundColor: 'transparent' },
                    })
                  }
                  className="text-[10px] text-text-2 hover:text-white underline"
                >
                  Quitar fondo
                </button>
              </div>
            </div>
          </div>

          {/* Alignment */}
          <div>
            <label className="mb-1 block text-[11px] text-text-2">Alineación:</label>
            <div className="flex w-fit gap-1 rounded border border-border-subtle bg-raised p-1">
              {(['left', 'center', 'right'] as const).map((align) => (
                <button
                  key={align}
                  onClick={() =>
                    updateClip(clip.id, {
                      textStyle: { ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }), textAlign: align },
                    })
                  }
                  className={`p-1.5 rounded transition ${
                    clip.textStyle?.textAlign === align ? 'bg-accent-fill text-white' : 'text-text-2 hover:text-text-1'
                  }`}
                >
                  {align === 'left' && <AlignLeft size={14} />}
                  {align === 'center' && <AlignCenter size={14} />}
                  {align === 'right' && <AlignRight size={14} />}
                </button>
              ))}
            </div>
          </div>

          {/* Plantillas de títulos: un clic aplica un estilo completo y
              coherente (fusiona con el estilo actual, no borra el texto).
              Cada vista previa se pinta con el estilo REAL de la plantilla
              (familia, peso, colores y caja), no con un nombre. */}
          <div>
            <span id={`text-preset-label-${clip.id}`} className="mb-1 block text-[11px] text-text-2">
              Preajustes:
            </span>
            <div
              role="group"
              aria-labelledby={`text-preset-label-${clip.id}`}
              data-testid="text-preset-picker"
              className="grid grid-cols-2 gap-1.5"
            >
              {TEXT_PRESETS.map((preset) => {
                const isActive = matchTextPreset(clip.textStyle) === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    data-testid={`text-preset-${preset.id}`}
                    aria-label={`Aplicar preajuste ${preset.label}`}
                    aria-pressed={isActive}
                    title={`${preset.label} — ${preset.hint}`}
                    onClick={() => applyTextPreset(clip.id, preset.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        applyTextPreset(clip.id, preset.id);
                      }
                    }}
                    className={`rounded border p-1.5 text-left transition ${
                      isActive
                        ? 'border-accent bg-accent-soft'
                        : 'border-border bg-raised hover:border-text-3'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="block truncate px-1 py-1 text-center leading-tight"
                      style={{
                        fontFamily: preset.style.fontFamily,
                        fontWeight: preset.style.fontWeight,
                        fontSize: 15,
                        color: preset.style.color,
                        backgroundColor:
                          preset.style.backgroundColor === 'transparent'
                            ? '#0f172a'
                            : preset.style.backgroundColor,
                        borderRadius: preset.style.borderRadius ?? 4,
                      }}
                    >
                      Ag
                    </span>
                    <span className="mt-1 block truncate text-center text-[10px] font-medium text-text-2">
                      {preset.label}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[10px] leading-snug text-text-3">
              Aplicar un preajuste no borra el texto. Se deshace con Ctrl+Z.
            </p>
          </div>

          {/* Animación & Sincronización de Letras */}
          <div className="space-y-2 border-t border-border-subtle pt-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-semibold text-text-1">Animación:</label>
              {clip.words && clip.words.length > 0 && (
                <Badge variant="neutral">{clip.words.length} palabras sincronizadas</Badge>
              )}
            </div>
            <select
              value={clip.textStyle?.animationPreset || 'none'}
              onChange={(e) =>
                updateClip(clip.id, {
                  textStyle: {
                    ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }),
                    animationPreset: e.target.value as LyricAnimationPreset,
                  },
                })
              }
              className="w-full rounded border border-border bg-raised p-1.5 text-xs text-text-1"
            >
              <option value="none">Sin animación</option>
              <option value="karaoke-fill">Karaoke</option>
              <option value="word-bounce">Rebote</option>
              <option value="fade-phrase">Fundido</option>
            </select>

            {/* Color de resaltado si es Karaoke o Rebote */}
            {(clip.textStyle?.animationPreset === 'karaoke-fill' || clip.textStyle?.animationPreset === 'word-bounce') && (
              <div>
                <label className="mb-1 block text-[11px] text-text-2">Palabra activa:</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={clip.textStyle?.highlightColor || '#FACC15'}
                    onChange={(e) =>
                      updateClip(clip.id, {
                        textStyle: {
                          ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }),
                          highlightColor: e.target.value,
                        },
                      })
                    }
                    className="h-7 w-7 cursor-pointer rounded border border-border bg-transparent"
                  />
                  <div className="flex gap-1.5">
                    {['#FACC15', '#38BDF8', '#F43F5E', '#4ADE80', '#A855F7'].map((c) => (
                      <button
                        key={c}
                        onClick={() =>
                          updateClip(clip.id, {
                            textStyle: {
                              ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }),
                              highlightColor: c,
                            },
                          })
                        }
                        className="h-5 w-5 rounded border border-border transition"
                        style={{ backgroundColor: c }}
                        title={c}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* TRANSFORM & VISUALS */}
      {(isVideoOrImage || isText) && (
        <Section
          titulo="Transformación"
          alRestablecer={() => updateClip(clip.id, { scale: 1, opacity: 1, positionX: 0, positionY: 0 })}
          etiquetaRestablecer="Restablecer transformación"
        >

          {/* F8 · Cuando hay un keyframe seleccionado, estos controles lo
              editan a él (no el valor fijo): el aviso es obligatorio para no
              confundir ambas ediciones. */}
          {selectedKeyframe && (
            <p
              role="status"
              data-testid="keyframe-editing-notice"
              className="rounded border border-accent bg-accent-soft p-2 text-[11px] leading-snug text-text-1"
            >
              Editando el keyframe de {selectedKeyframe.t.toFixed(2)} s: los controles de
              abajo cambian este keyframe, no el valor fijo del clip.
            </p>
          )}

          {/* Escala (primitiva Slider: deslizador + número editan lo mismo) */}
          <Slider
            label="Escala:"
            value={Math.round(effScale * 100)}
            min={20}
            max={250}
            step={5}
            unit="%"
            testid="clip-scale"
            ariaLabel={selectedKeyframe ? `Escala del keyframe de ${selectedKeyframe.t.toFixed(2)} segundos` : 'Escala del clip'}
            onChange={(v) =>
              selectedKeyframe
                ? updateKeyframe(clip.id, selectedKeyframe.t, { scale: v / 100 })
                : updateClip(clip.id, { scale: v / 100 })
            }
          />

          {/* Opacidad (primitiva Slider) */}
          <Slider
            label="Opacidad:"
            value={Math.round(effOpacity * 100)}
            min={0}
            max={100}
            step={5}
            unit="%"
            testid="clip-opacity"
            ariaLabel={selectedKeyframe ? `Opacidad del keyframe de ${selectedKeyframe.t.toFixed(2)} segundos` : 'Opacidad del clip'}
            onChange={(v) =>
              selectedKeyframe
                ? updateKeyframe(clip.id, selectedKeyframe.t, { opacity: v / 100 })
                : updateClip(clip.id, { opacity: v / 100 })
            }
          />

          {/* Position X / Y */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="flex justify-between text-[11px] text-text-2 mb-1">
                <span>Posición X:</span>
                <span className="font-mono">{Math.round(effX)} px</span>
              </div>
              <input
                type="range"
                min="-500"
                max="500"
                step="5"
                value={effX}
                aria-label={selectedKeyframe ? `Posición horizontal X del keyframe de ${selectedKeyframe.t.toFixed(2)} segundos` : 'Posición horizontal X'}
                onChange={(e) =>
                  selectedKeyframe
                    ? updateKeyframe(clip.id, selectedKeyframe.t, { x: parseInt(e.target.value) })
                    : updateClip(clip.id, { positionX: parseInt(e.target.value) })
                }
                className="w-full h-1.5 bg-overlay accent-accent rounded cursor-pointer"
              />
            </div>
            <div>
              <div className="flex justify-between text-[11px] text-text-2 mb-1">
                <span>Posición Y:</span>
                <span className="font-mono">{Math.round(effY)} px</span>
              </div>
              <input
                type="range"
                min="-500"
                max="500"
                step="5"
                value={effY}
                aria-label={selectedKeyframe ? `Posición vertical Y del keyframe de ${selectedKeyframe.t.toFixed(2)} segundos` : 'Posición vertical Y'}
                onChange={(e) =>
                  selectedKeyframe
                    ? updateKeyframe(clip.id, selectedKeyframe.t, { y: parseInt(e.target.value) })
                    : updateClip(clip.id, { positionY: parseInt(e.target.value) })
                }
                className="w-full h-1.5 bg-overlay accent-accent rounded cursor-pointer"
              />
            </div>
          </div>

        </Section>
      )}

      {/* F8 · KEYFRAMES DE ANIMACIÓN.
          Arranca colapsada pero MONTADA (regla U7a: máx. 5 secciones
          expandidas; las avanzadas —keyframes y fundidos— arrancan
          cerradas y «Fundido de cruce» y «Audio» quedan abiertas porque
          la suite exige sus avisos visibles). */}
      {(isVideoOrImage || isText) && (
        <Section titulo="Keyframes de animación" abiertaPorDefecto={false}>
          <div data-testid="keyframe-section" className="space-y-2 rounded border border-border-subtle bg-raised p-2.5">
            <p className="text-[10px] leading-snug text-text-3">
              Anima la posición, la escala y la opacidad a lo largo del clip con
              interpolación lineal entre keyframes.
            </p>

            <button
              onClick={() => {
                if (addKeyframe(clip.id, playheadLocalT)) {
                  // Selecciona el keyframe más cercano al cabezal (el recién
                  // creado): el store lo cuantiza y lo recorta al clip.
                  const updated = useProjectStore
                    .getState()
                    .project.clips.find((c) => c.id === clip.id);
                  const kfs = updated?.keyframes ?? [];
                  let best: number | null = null;
                  let bestDist = Number.POSITIVE_INFINITY;
                  for (const k of kfs) {
                    const dist = Math.abs(k.t - playheadLocalT);
                    if (dist < bestDist) {
                      bestDist = dist;
                      best = k.t;
                    }
                  }
                  setSelectedKeyframeT(best);
                }
              }}
              data-testid="keyframe-add"
              aria-label="Añadir keyframe en el cabezal de reproducción"
              className="w-full text-center py-1.5 text-[11px] font-medium text-white bg-accent-fill hover:brightness-110 rounded border border-accent-fill transition"
            >
              Añadir keyframe
            </button>
            {!playheadInsideClip && (
              <p
                role="status"
                data-testid="keyframe-playhead-outside"
                className="text-[10px] leading-snug text-warning bg-warning/10 border border-warning/40 rounded p-2"
              >
                El cabezal está fuera de este clip: el keyframe se colocará en el
                borde más cercano.
              </p>
            )}

            {clipKeyframes.length > 0 ? (
              <>
                <div className="text-[11px] font-semibold text-text-2 pt-1">
                  Keyframes ({clipKeyframes.length})
                </div>
                <ul data-testid="keyframe-list" className="space-y-1.5">
                  {clipKeyframes.map((kf) => {
                    const isSelected = selectedKeyframe?.t === kf.t;
                    // Resumen con herencia: lo ausente muestra el valor efectivo
                    // en ese instante (no un cero).
                    const rowEff = evaluateKeyframes(clip, kf.t);
                    const defined: string[] = [];
                    if (kf.x !== undefined || kf.y !== undefined) {
                      defined.push(`pos ${Math.round(kf.x ?? rowEff.x)}, ${Math.round(kf.y ?? rowEff.y)}`);
                    }
                    if (kf.scale !== undefined) defined.push(`esc ${Math.round(kf.scale * 100)}%`);
                    if (kf.opacity !== undefined) defined.push(`op ${Math.round(kf.opacity * 100)}%`);
                    return (
                      <li
                        key={kf.t}
                        data-testid={`keyframe-item-${kf.t}`}
                        className={`flex items-center gap-1.5 rounded border p-1.5 ${
                          isSelected
                            ? 'bg-accent-soft border-accent'
                            : 'bg-panel border-border'
                        }`}
                      >
                        <button
                          onClick={() => setSelectedKeyframeT(isSelected ? null : kf.t)}
                          aria-label={
                            isSelected
                              ? `Dejar de editar el keyframe de ${kf.t.toFixed(2)} segundos`
                              : `Seleccionar keyframe de ${kf.t.toFixed(2)} segundos para editarlo`
                          }
                          aria-pressed={isSelected}
                          className={`flex-1 text-left text-[11px] rounded px-1 py-0.5 ${
                            isSelected ? 'text-accent font-semibold' : 'text-text-2 hover:text-white'
                          }`}
                        >
                          <span className="font-mono">{kf.t.toFixed(2)} s</span>
                          <span className="text-text-3"> · {defined.join(' · ') || 'vacío'}</span>
                        </button>
                        <button
                          onClick={() => {
                            if (selectedKeyframe?.t === kf.t) setSelectedKeyframeT(null);
                            removeKeyframe(clip.id, kf.t);
                          }}
                          data-testid="keyframe-remove"
                          aria-label={`Eliminar keyframe de ${kf.t.toFixed(2)} segundos`}
                          className="p-1.5 text-danger hover:text-danger hover:bg-danger/10 rounded transition"
                        >
                          <Trash2 size={13} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {selectedKeyframe && (
                  <button
                    onClick={() => setSelectedKeyframeT(null)}
                    data-testid="keyframe-deselect"
                    aria-label="Volver a editar los valores fijos del clip"
                    className="w-full text-center py-1.5 text-[11px] font-medium text-text-2 hover:text-white bg-raised hover:bg-raised rounded border border-border transition"
                  >
                    Volver a los valores fijos
                  </button>
                )}
                <button
                  onClick={() => {
                    if (confirm('¿Borrar todos los keyframes de este clip? Puedes deshacerlo con Ctrl+Z.')) {
                      setSelectedKeyframeT(null);
                      clearKeyframes(clip.id);
                    }
                  }}
                  data-testid="keyframe-clear"
                  aria-label="Borrar todos los keyframes del clip"
                  className="w-full text-center py-1.5 text-[11px] font-medium text-text-2 hover:text-white bg-raised hover:bg-raised rounded border border-border transition"
                >
                  Borrar keyframes
                </button>
              </>
            ) : (
              <p
                role="status"
                data-testid="keyframe-empty"
                className="text-[11px] leading-snug text-text-3"
              >
                Sin keyframes: el clip usa su transformación fija. Añade uno para
                animarlo.
              </p>
            )}
          </div>
        </Section>
      )}

      {/* F9 · COLOR FILTERS (términos aprobados: «Color» / «Preajuste»). */}
      {isVideoOrImage && (
        <Section titulo="Color">
          <div data-testid="inspector-color-section" className="space-y-2 rounded border border-border-subtle bg-raised p-2.5">
            {/* Preset */}
            <div>
              <label htmlFor={`clip-color-preset-${clip.id}`} className="text-[11px] text-text-2 block mb-1">
                Preajuste de color:
              </label>
              <select
                id={`clip-color-preset-${clip.id}`}
                data-testid="clip-color-preset"
                aria-label="Preajuste de color del clip"
                disabled={!colorFiltersEnabled}
                value={selectedColorPreset ?? 'custom'}
                onChange={(e) => {
                  const preset = COLOR_FILTER_PRESETS[e.target.value as ColorFilterPresetId];
                  if (!preset) return;
                  updateClip(clip.id, {
                    filters: preset.id === 'original' ? undefined : { ...preset.filters },
                  });
                }}
                className="w-full bg-panel border border-border text-text-1 text-xs rounded p-1.5 disabled:opacity-50"
              >
                {COLOR_FILTER_PRESET_ORDER.map((presetId) => (
                  <option key={presetId} value={presetId}>
                    {COLOR_FILTER_PRESETS[presetId].label}
                  </option>
                ))}
                {selectedColorPreset === null && <option value="custom">Personalizado</option>}
              </select>
            </div>

            {/* Filtros individuales (primitiva Slider, en porcentaje: el
                campo numérico muestra el mismo % que antes mostraba la
                etiqueta, y el `data-testid` lo lee la suite). */}
            {COLOR_SLIDERS.map((slider) => {
              const value = clip.filters?.[slider.key] ?? slider.neutral;
              return (
                <Slider
                  key={slider.key}
                  label={`${slider.label}:`}
                  value={Math.round(value * 100)}
                  min={Math.round(slider.min * 100)}
                  max={Math.round(slider.max * 100)}
                  step={1}
                  unit="%"
                  testid={`clip-color-${slider.key}`}
                  ariaLabel={slider.ariaLabel}
                  disabled={!colorFiltersEnabled}
                  onChange={(v) => {
                    const next: ClipColorFilters = { ...(clip.filters ?? {}) };
                    next[slider.key] = v / 100;
                    updateClip(clip.id, { filters: next });
                  }}
                />
              );
            })}

            {/* Reset colour */}
            <button
              onClick={() => updateClip(clip.id, { filters: undefined })}
              data-testid="clip-color-reset"
              aria-label="Restablecer los filtros de color del clip"
              disabled={!colorFiltersEnabled}
              className="w-full text-center py-1.5 text-[11px] font-medium text-text-2 hover:text-white bg-raised hover:bg-raised rounded border border-border transition disabled:opacity-50"
            >
              Restablecer color
            </button>
          </div>

          {/* The browser cannot filter: the controls are disabled AND the
              reason is explained (a silent no-op is not acceptable). */}
          {filterSupport === false && (
            <p
              role="status"
              data-testid="clip-color-unsupported"
              className="rounded border border-warning/40 bg-warning/10 p-2 text-[10px] leading-snug text-warning"
            >
              {COLOR_FILTER_UNSUPPORTED_MESSAGE}
            </p>
          )}
        </Section>
      )}

      {/* AUDIO PROPERTIES */}
      {hasAudio && (
        <Section titulo="Audio">

          {/* Volumen (primitiva Slider) + silencio */}
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Slider
                label="Volumen:"
                value={Math.round((clip.volume ?? 1) * 100)}
                min={0}
                max={200}
                step={5}
                unit="%"
                testid="clip-volume"
                ariaLabel="Volumen del clip"
                onChange={(v) => updateClip(clip.id, { volume: v / 100 })}
              />
            </div>
            <button
              onClick={() => updateClip(clip.id, { muted: !clip.muted })}
              aria-label={clip.muted ? 'Activar sonido del clip' : 'Silenciar clip'}
              className={`shrink-0 p-1.5 rounded transition ${
                clip.muted ? 'bg-danger/10 text-danger border border-danger/50' : 'bg-raised text-text-2 hover:text-white'
              }`}
              title={clip.muted ? 'Activar sonido del clip' : 'Silenciar clip'}
            >
              {clip.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
          </div>

          {/* FUNDIDOS DE AUDIO */}
          <div className="space-y-2 pt-1" data-testid="audio-fade-section">
            <div className="text-xs font-semibold text-text-2 uppercase tracking-wider flex items-center gap-1.5">
              <Volume2 size={13} className="text-text-3" />
              <span>Fundidos de audio</span>
            </div>
            <div className="bg-raised p-2.5 rounded-md border border-border-subtle space-y-3">
              <p className="text-[10px] leading-snug text-text-3">
                El volumen sube al inicio y baja al final del clip. La curva de potencia igual
                mantiene la sonoridad constante durante la rampa.
              </p>

              {/* Entrada */}
              <div>
                <div className="flex justify-between text-xs text-text-2 mb-1">
                  <label htmlFor={`audio-fade-in-${clip.id}`}>Fundido de entrada:</label>
                  <span className="font-mono text-text-1">
                    {(clip.audioFadeIn?.duration ?? 0).toFixed(2)} s
                  </span>
                </div>
                <input
                  id={`audio-fade-in-${clip.id}`}
                  type="range"
                  min="0"
                  max={Math.max(clip.duration, audioFadeFrameDuration(projectFps ?? 30))}
                  step={audioFadeFrameDuration(projectFps ?? 30)}
                  value={clip.audioFadeIn?.duration ?? 0}
                  data-testid="audio-fade-in-duration"
                  aria-label="Duración del fundido de entrada de audio"
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    updateClip(clip.id, {
                      audioFadeIn:
                        v <= 0
                          ? undefined
                          : { duration: v, curve: clip.audioFadeIn?.curve ?? DEFAULT_AUDIO_FADE_CURVE },
                    });
                  }}
                  className="w-full h-1.5 bg-overlay accent-accent rounded cursor-pointer"
                />
                <label htmlFor={`audio-fade-in-curve-${clip.id}`} className="text-[10px] text-text-3 block mt-1 mb-1">
                  Curva de entrada:
                </label>
                <select
                  id={`audio-fade-in-curve-${clip.id}`}
                  data-testid="audio-fade-in-curve"
                  aria-label="Curva del fundido de entrada de audio"
                  value={clip.audioFadeIn?.curve ?? DEFAULT_AUDIO_FADE_CURVE}
                  onChange={(e) => {
                    const curve = e.target.value as AudioFadeCurve;
                    updateClip(clip.id, {
                      audioFadeIn: {
                        duration:
                          (clip.audioFadeIn?.duration ?? 0) > 0
                            ? clip.audioFadeIn!.duration
                            : AUDIO_FADE_DEFAULT_DURATION,
                        curve,
                      },
                    });
                  }}
                  className="w-full bg-panel border border-border text-text-1 text-xs rounded p-1.5"
                >
                  <option value="equalPower">Potencia igual (recomendada)</option>
                  <option value="linear">Lineal</option>
                </select>
              </div>

              {/* Salida */}
              <div>
                <div className="flex justify-between text-xs text-text-2 mb-1">
                  <label htmlFor={`audio-fade-out-${clip.id}`}>Fundido de salida:</label>
                  <span className="font-mono text-text-1">
                    {(clip.audioFadeOut?.duration ?? 0).toFixed(2)} s
                  </span>
                </div>
                <input
                  id={`audio-fade-out-${clip.id}`}
                  type="range"
                  min="0"
                  max={Math.max(clip.duration, audioFadeFrameDuration(projectFps ?? 30))}
                  step={audioFadeFrameDuration(projectFps ?? 30)}
                  value={clip.audioFadeOut?.duration ?? 0}
                  data-testid="audio-fade-out-duration"
                  aria-label="Duración del fundido de salida de audio"
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    updateClip(clip.id, {
                      audioFadeOut:
                        v <= 0
                          ? undefined
                          : { duration: v, curve: clip.audioFadeOut?.curve ?? DEFAULT_AUDIO_FADE_CURVE },
                    });
                  }}
                  className="w-full h-1.5 bg-overlay accent-accent rounded cursor-pointer"
                />
                <label htmlFor={`audio-fade-out-curve-${clip.id}`} className="text-[10px] text-text-3 block mt-1 mb-1">
                  Curva de salida:
                </label>
                <select
                  id={`audio-fade-out-curve-${clip.id}`}
                  data-testid="audio-fade-out-curve"
                  aria-label="Curva del fundido de salida de audio"
                  value={clip.audioFadeOut?.curve ?? DEFAULT_AUDIO_FADE_CURVE}
                  onChange={(e) => {
                    const curve = e.target.value as AudioFadeCurve;
                    updateClip(clip.id, {
                      audioFadeOut: {
                        duration:
                          (clip.audioFadeOut?.duration ?? 0) > 0
                            ? clip.audioFadeOut!.duration
                            : AUDIO_FADE_DEFAULT_DURATION,
                        curve,
                      },
                    });
                  }}
                  className="w-full bg-panel border border-border text-text-1 text-xs rounded p-1.5"
                >
                  <option value="equalPower">Potencia igual (recomendada)</option>
                  <option value="linear">Lineal</option>
                </select>
              </div>

              {(clip.audioFadeIn || clip.audioFadeOut) && (
                <button
                  onClick={() => updateClip(clip.id, { audioFadeIn: undefined, audioFadeOut: undefined })}
                  data-testid="audio-fade-clear"
                  aria-label="Quitar fundidos de audio"
                  className="w-full text-center py-1.5 text-[11px] font-medium text-text-2 hover:text-white bg-raised hover:bg-raised rounded border border-border transition"
                >
                  Quitar fundidos
                </button>
              )}
            </div>
          </div>

          {/* EFECTOS DE AUDIO: paneo / EQ de 3 bandas / ducking */}
          <div className="space-y-2 pt-1" data-testid="audio-effects-section">
            <div className="text-xs font-semibold text-text-2 uppercase tracking-wider flex items-center gap-1.5">
              <Sliders size={13} className="text-text-3" />
              <span>Efectos de audio</span>
            </div>
            <div className="bg-raised p-2.5 rounded-md border border-border-subtle space-y-3">
              <p className="text-[10px] leading-snug text-text-3">
                El paneo coloca el clip en el campo estéreo y la EQ ajusta graves, medios y
                agudos. El ducking baja este clip automáticamente mientras hay voz en otra
                pista (la música baja cuando entra la voz).
              </p>

              {/* Paneo (primitiva Slider) */}
              <div>
                <Slider
                  label="Paneo:"
                  value={clip.audioEffects?.pan ?? 0}
                  min={-1}
                  max={1}
                  step={0.01}
                  testid="clip-audio-pan"
                  ariaLabel="Paneo estéreo del clip"
                  disabled={!panEnabled}
                  onChange={(v) =>
                    updateClip(clip.id, {
                      audioEffects: { ...(clip.audioEffects ?? {}), pan: v },
                    })
                  }
                />
                <p className="text-[10px] leading-snug text-text-3 mt-1">
                  −1 = izquierda, 0 = centro, +1 = derecha.
                </p>
              </div>
              {pannerSupport === false && (
                <p
                  role="status"
                  data-testid="clip-audio-pan-unsupported"
                  className="text-[10px] leading-snug text-warning bg-warning/10 border border-warning/40 rounded p-2"
                >
                  {STEREO_PANNER_UNSUPPORTED_MESSAGE}
                </p>
              )}

              {/* EQ de 3 bandas (primitiva Slider, en dB como antes) */}
              {EQ_SLIDERS.map((slider) => {
                const value = clip.audioEffects?.eq?.[slider.key] ?? 0;
                return (
                  <Slider
                    key={slider.key}
                    label={`${slider.label}:`}
                    value={value}
                    min={EQ_DB_MIN}
                    max={EQ_DB_MAX}
                    step={0.5}
                    unit="dB"
                    testid={`clip-audio-eq-${slider.key}`}
                    ariaLabel={slider.ariaLabel}
                    title={slider.hint}
                    disabled={!eqEnabled}
                    onChange={(v) =>
                      updateClip(clip.id, {
                        audioEffects: {
                          ...(clip.audioEffects ?? {}),
                          eq: {
                            ...(clip.audioEffects?.eq ?? {}),
                            [slider.key]: v,
                          },
                        },
                      })
                    }
                  />
                );
              })}
              {biquadSupport === false && (
                <p
                  role="status"
                  data-testid="clip-audio-eq-unsupported"
                  className="text-[10px] leading-snug text-warning bg-warning/10 border border-warning/40 rounded p-2"
                >
                  {BIQUAD_FILTER_UNSUPPORTED_MESSAGE}
                </p>
              )}

              {/* Ducking */}
              <label
                htmlFor={`audio-duck-${clip.id}`}
                className="flex items-center gap-2 cursor-pointer select-none"
              >
                <input
                  id={`audio-duck-${clip.id}`}
                  type="checkbox"
                  data-testid="clip-audio-duck"
                  checked={clip.audioEffects?.duck === true}
                  onChange={(e) =>
                    updateClip(clip.id, {
                      audioEffects: { ...(clip.audioEffects ?? {}), duck: e.target.checked },
                    })
                  }
                  aria-label="Atenuar este clip cuando haya diálogo en otra pista"
                  className="w-3.5 h-3.5 accent-accent rounded"
                />
                <span className="text-[11px] text-text-2 font-medium">
                  Ducking: bajar cuando entra la voz
                </span>
              </label>
              <p className="text-[10px] leading-snug text-text-3" data-testid="clip-audio-duck-hint">
                {clip.audioEffects?.duck === true
                  ? 'Este clip se atenúa 8 dB mientras se escucha una pista marcada como «Diálogo».'
                  : 'Actívalo para que este clip (normalmente música) se atenúe mientras se escucha una pista marcada como «Diálogo».'}
              </p>

              {/* Rol de la pista (gobierna el ducking) */}
              <div>
                <label htmlFor={`track-role-${clip.id}`} className="text-[11px] text-text-2 block mb-1">
                  Rol de la pista «{track?.name ?? 'Desconocida'}»:
                </label>
                <select
                  id={`track-role-${clip.id}`}
                  data-testid="track-role-select"
                  aria-label="Rol de la pista para el ducking"
                  value={track?.role ?? ''}
                  onChange={(e) => {
                    if (!track) return;
                    const value = e.target.value;
                    setTrackRole(track.id, value === '' ? undefined : (value as TrackRole));
                  }}
                  className="w-full bg-panel border border-border text-text-1 text-xs rounded p-1.5"
                >
                  <option value="">Sin rol</option>
                  <option value="dialogue">{TRACK_ROLE_LABELS.dialogue}</option>
                  <option value="music">{TRACK_ROLE_LABELS.music}</option>
                  <option value="sfx">{TRACK_ROLE_LABELS.sfx}</option>
                </select>
                <p className="text-[10px] leading-snug text-text-3 mt-1">
                  Una pista «Diálogo» atenúa los clips con ducking de las demás pistas.
                </p>
              </div>

              {(clip.audioEffects?.pan !== undefined ||
                clip.audioEffects?.eq !== undefined ||
                clip.audioEffects?.duck !== undefined) && (
                <button
                  onClick={() => updateClip(clip.id, { audioEffects: undefined })}
                  data-testid="clip-audio-effects-reset"
                  aria-label="Restablecer los efectos de audio del clip"
                  className="w-full text-center py-1.5 text-[11px] font-medium text-text-2 hover:text-white bg-raised hover:bg-raised rounded border border-border transition"
                >
                  Restablecer efectos de audio
                </button>
              )}
            </div>
          </div>
        </Section>
      )}

      {/* PLAYBACK SPEED CONTROL */}
      {(hasAudio || clip.type === 'video') && (
        <Section
          titulo="Velocidad"
          alRestablecer={() => updateClip(clip.id, { speed: 1, preservePitch: true })}
          etiquetaRestablecer="Restablecer la velocidad del clip"
        >

          <div className="bg-raised p-2.5 rounded-md border border-border-subtle space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-text-2">Velocidad:</span>
              <span className="font-mono text-accent font-semibold">{clip.speed || 1}x</span>
            </div>

            {/* Quick Speed Preset Buttons */}
            <div className="grid grid-cols-4 gap-1.5">
              {[0.5, 1, 1.5, 2].map((spd) => (
                <button
                  key={spd}
                  onClick={() => updateClip(clip.id, { speed: spd })}
                  className={`py-1 text-xs rounded border transition font-mono ${
                    (clip.speed || 1) === spd
                      ? 'border-accent-fill bg-accent-fill font-bold text-white'
                      : 'bg-panel text-text-2 border-border hover:bg-raised hover:text-white'
                  }`}
                >
                  {spd}x
                </button>
              ))}
            </div>

            {/* Continuous Speed Slider */}
            <div>
              <div className="flex justify-between text-[10px] text-text-3 mt-1 mb-1">
                <span>0.25x</span>
                <span>1x (Normal)</span>
                <span>4.0x</span>
              </div>
              <input
                type="range"
                min="0.25"
                max="4"
                step="0.25"
                aria-label="Velocidad del clip"
                value={clip.speed || 1}
                onChange={(e) => updateClip(clip.id, { speed: parseFloat(e.target.value) })}
                className="w-full h-1.5 bg-overlay accent-accent rounded cursor-pointer"
              />
            </div>

            {/* F4: pitch policy. The preview and the export MUST agree, so the
                choice is stored in the clip and resolved by `resolvePlayback()`. */}
            <label
              htmlFor={`clip-preserve-pitch-${clip.id}`}
              className="flex items-center gap-2 cursor-pointer select-none pt-1"
            >
              <input
                id={`clip-preserve-pitch-${clip.id}`}
                type="checkbox"
                data-testid="clip-preserve-pitch"
                checked={clip.preservePitch !== false}
                onChange={(e) => updateClip(clip.id, { preservePitch: e.target.checked })}
                className="w-3.5 h-3.5 accent-accent rounded"
              />
              <span className="text-[11px] text-text-2 font-medium">
                Preservar el tono (pitch)
              </span>
            </label>
            <p className="text-[10px] leading-snug text-text-3" data-testid="clip-preserve-pitch-hint">
              {clip.preservePitch === false
                ? 'El tono sube o baja con la velocidad (efecto "chipmunk"). El preview y el export se comportan igual.'
                : 'Al acelerar, la voz mantiene su tono original: el preview y el MP4 exportado suenan exactamente igual.'}
            </p>
          </div>
        </Section>
      )}

      {/* FUNDIDOS de entrada/salida (arranca colapsado pero montado: ver
          la regla en «Keyframes de animación»). */}
      <Section titulo="Fundidos" abiertaPorDefecto={false}>

        {/* Fade In */}
        <div className="bg-raised p-2.5 rounded-md border border-border-subtle space-y-2">
          <div className="flex justify-between items-center text-xs">
            <span className="font-medium text-text-1">Fundido de entrada:</span>
            <span className="text-[11px] font-mono text-text-2">
              {formatearDuracion(clip.transition?.fadeInDuration ?? 0)}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-text-2 block mb-1">Efecto:</label>
              <select
                value={clip.transition?.fadeInType || 'none'}
                onChange={(e) => {
                  const val = e.target.value as TransitionType;
                  const defaultDur = Math.min(0.8, Math.max(0.1, Number((clip.duration / 2).toFixed(1))));
                  updateClip(clip.id, {
                    transition: {
                      fadeInType: val,
                      fadeInDuration: clip.transition?.fadeInDuration || (val !== 'none' ? defaultDur : 0),
                      fadeOutType: clip.transition?.fadeOutType || 'none',
                      fadeOutDuration: clip.transition?.fadeOutDuration || 0,
                    },
                  });
                }}
                className="w-full bg-panel border border-border text-text-1 text-xs rounded p-1.5"
              >
                {FADE_IN_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[10px] text-text-2 block mb-1">Duración:</label>
              <input
                type="range"
                min="0.1"
                max={Math.min(5, Math.max(0.2, clip.duration / 2))}
                step="0.1"
                aria-label="Duración del fundido de entrada"
                disabled={!clip.transition?.fadeInType || clip.transition.fadeInType === 'none'}
                value={clip.transition?.fadeInDuration || 0.8}
                onChange={(e) =>
                  updateClip(clip.id, {
                    transition: {
                      fadeInType: clip.transition?.fadeInType || 'fade-black',
                      fadeInDuration: parseFloat(e.target.value),
                      fadeOutType: clip.transition?.fadeOutType || 'none',
                      fadeOutDuration: clip.transition?.fadeOutDuration || 0,
                    },
                  })
                }
                className="w-full h-1.5 bg-overlay accent-accent rounded cursor-pointer mt-2 disabled:opacity-40"
              />
            </div>
          </div>
        </div>

        {/* Fade Out */}
        <div className="bg-raised p-2.5 rounded-md border border-border-subtle space-y-2">
          <div className="flex justify-between items-center text-xs">
            <span className="font-medium text-text-1">Fundido de salida:</span>
            <span className="text-[11px] font-mono text-text-2">
              {formatearDuracion(clip.transition?.fadeOutDuration ?? 0)}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-text-2 block mb-1">Efecto:</label>
              <select
                value={clip.transition?.fadeOutType || 'none'}
                onChange={(e) => {
                  const val = e.target.value as TransitionType;
                  const defaultDur = Math.min(0.8, Math.max(0.1, Number((clip.duration / 2).toFixed(1))));
                  updateClip(clip.id, {
                    transition: {
                      fadeInType: clip.transition?.fadeInType || 'none',
                      fadeInDuration: clip.transition?.fadeInDuration || 0,
                      fadeOutType: val,
                      fadeOutDuration: clip.transition?.fadeOutDuration || (val !== 'none' ? defaultDur : 0),
                    },
                  });
                }}
                className="w-full bg-panel border border-border text-text-1 text-xs rounded p-1.5"
              >
                {FADE_OUT_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[10px] text-text-2 block mb-1">Duración:</label>
              <input
                type="range"
                min="0.1"
                max={Math.min(5, Math.max(0.2, clip.duration / 2))}
                step="0.1"
                aria-label="Duración del fundido de salida"
                disabled={!clip.transition?.fadeOutType || clip.transition.fadeOutType === 'none'}
                value={clip.transition?.fadeOutDuration || 0.8}
                onChange={(e) =>
                  updateClip(clip.id, {
                    transition: {
                      fadeInType: clip.transition?.fadeInType || 'none',
                      fadeInDuration: clip.transition?.fadeInDuration || 0,
                      fadeOutType: clip.transition?.fadeOutType || 'fade-black',
                      fadeOutDuration: parseFloat(e.target.value),
                    },
                  })
                }
                className="w-full h-1.5 bg-overlay accent-accent rounded cursor-pointer mt-2 disabled:opacity-40"
              />
            </div>
          </div>
        </div>
      </Section>

      {/* F5 · FUNDIDO DE CRUCE (arranca abierto: la suite de navegador
          exige sus avisos visibles con la pista bloqueada; con Keyframes y
          Fundidos cerrados el inspector ya cumple el máx. de 5). */}
      <Section titulo="Fundido de cruce">
        <div data-testid="crossfade-section">
        <div className="bg-raised p-2.5 rounded-md border border-border-subtle space-y-2">
          {crossfadeInfo.activePair && crossfadeInfo.neighbour ? (
            <>
              <p className="text-[11px] leading-snug text-text-2" data-testid="crossfade-active-label">
                {crossfadeInfo.neighbour.selectedRole === 'out' ? (
                  <>«{clip.name}» sale y «{crossfadeInfo.neighbour.name}» entra ({crossfadeInfo.currentDuration.toFixed(2)} s).</>
                ) : (
                  <>«{crossfadeInfo.neighbour.name}» sale y «{clip.name}» entra ({crossfadeInfo.currentDuration.toFixed(2)} s).</>
                )}
              </p>
              <div>
                <label htmlFor={`crossfade-duration-${clip.id}`} className="text-[11px] text-text-2 block mb-1">
                  Duración del fundido: {crossfadeInfo.currentDuration.toFixed(2)} s
                </label>
                <input
                  id={`crossfade-duration-${clip.id}`}
                  data-testid="crossfade-duration"
                  type="range"
                  min={Math.min(crossfadeFrameDuration(projectFps ?? 30), crossfadeInfo.currentDuration)}
                  max={Math.max(crossfadeInfo.maxDuration, crossfadeInfo.currentDuration)}
                  step={crossfadeFrameDuration(projectFps ?? 30)}
                  value={crossfadeInfo.currentDuration}
                  disabled={!crossfadeInfo.canCreate}
                  aria-label="Duración del fundido de cruce"
                  onChange={(e) => setCrossfadeDuration(clip.id, parseFloat(e.target.value))}
                  className="w-full h-1.5 bg-overlay accent-accent rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                />
              </div>
              <button
                onClick={() => removeCrossfade(clip.id)}
                disabled={!crossfadeInfo.canRemove}
                data-testid="crossfade-remove"
                aria-label="Eliminar fundido de cruce"
                className="w-full text-center py-1.5 text-[11px] font-medium text-text-2 hover:text-white bg-raised hover:bg-raised rounded border border-border transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Eliminar fundido
              </button>
              {!crossfadeInfo.canCreate && crossfadeInfo.createReason && (
                <p
                  role="status"
                  data-testid="crossfade-disabled-reason"
                  className="text-[10px] leading-snug text-warning bg-warning/10 border border-warning/40 rounded p-2"
                >
                  {crossfadeInfo.createReason}
                </p>
              )}
            </>
          ) : crossfadeInfo.neighbour ? (
            <>
              <p className="text-[11px] leading-snug text-text-2" data-testid="crossfade-neighbour-label">
                Vecino: «{crossfadeInfo.neighbour.name}» (
                {crossfadeInfo.neighbour.selectedRole === 'out' ? 'este clip sale' : 'este clip entra'}).
                Ambos se mezclarán durante el fundido.
              </p>
              <div>
                <label htmlFor={`crossfade-desired-duration-${clip.id}`} className="text-[11px] text-text-2 block mb-1">
                  Duración del fundido: {Math.min(Math.max(desiredCrossfade, crossfadeFrameDuration(projectFps ?? 30)), crossfadeInfo.maxDuration).toFixed(2)} s
                </label>
                <input
                  id={`crossfade-desired-duration-${clip.id}`}
                  data-testid="crossfade-desired-duration"
                  type="range"
                  min={crossfadeFrameDuration(projectFps ?? 30)}
                  max={crossfadeInfo.maxDuration}
                  step={crossfadeFrameDuration(projectFps ?? 30)}
                  value={Math.min(Math.max(desiredCrossfade, crossfadeFrameDuration(projectFps ?? 30)), crossfadeInfo.maxDuration)}
                  disabled={!crossfadeInfo.canCreate}
                  aria-label="Duración del fundido de cruce a crear"
                  onChange={(e) => setDesiredCrossfade(parseFloat(e.target.value))}
                  className="w-full h-1.5 bg-overlay accent-accent rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                />
              </div>
              <button
                onClick={() => {
                  const nb = crossfadeInfo.neighbour;
                  if (!nb) return;
                  const value = Math.min(
                    Math.max(desiredCrossfade, crossfadeFrameDuration(projectFps ?? 30)),
                    crossfadeInfo.maxDuration
                  );
                  if (nb.selectedRole === 'out') createCrossfade(clip.id, nb.id, value);
                  else createCrossfade(nb.id, clip.id, value);
                }}
                disabled={!crossfadeInfo.canCreate}
                data-testid="crossfade-create"
                aria-label="Crear fundido de cruce"
                className="w-full text-center py-1.5 text-[11px] font-medium text-white bg-accent-fill hover:brightness-110 rounded border border-accent-fill transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Crear fundido
              </button>
              {!crossfadeInfo.canCreate && crossfadeInfo.createReason && (
                <p
                  role="status"
                  data-testid="crossfade-disabled-reason"
                  className="text-[10px] leading-snug text-warning bg-warning/10 border border-warning/40 rounded p-2"
                >
                  {crossfadeInfo.createReason}
                </p>
              )}
            </>
          ) : crossfadeInfo.trackLocked ? (
            <>
              {/* La pista está bloqueada: como el resto de secciones del
                  Inspector, el control QUEDA VISIBLE pero deshabilitado y el
                  motivo se muestra al lado (un control que desaparece no
                  explica nada). */}
              <button
                disabled
                data-testid="crossfade-create"
                aria-label="Crear fundido de cruce"
                title={crossfadeInfo.createReason ?? 'La pista está bloqueada'}
                className="w-full text-center py-1.5 text-[11px] font-medium text-white bg-accent-fill hover:brightness-110 rounded border border-accent-fill transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Crear fundido
              </button>
              <p
                role="status"
                data-testid="crossfade-disabled-reason"
                className="text-[10px] leading-snug text-warning bg-warning/10 border border-warning/40 rounded p-2"
              >
                {crossfadeInfo.createReason ??
                  'La pista está bloqueada: desbloquéala para poder crear el fundido de cruce.'}
              </p>
            </>
          ) : (
            <p
              role="status"
              data-testid="crossfade-no-neighbour"
              className="text-[11px] leading-snug text-text-3"
            >
              {crossfadeInfo.createReason ?? 'Sin clip vecino para fundir.'}
            </p>
          )}
        </div>
        </div>
        </Section>

      {policySection}
    </div>
  );
};
