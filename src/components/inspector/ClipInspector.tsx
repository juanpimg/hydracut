import { 
  Sliders, 
  Trash2, 
  Volume2, 
  VolumeX, 
  Type, 
  Maximize2, 
  AlignLeft, 
  AlignCenter, 
  AlignRight,
  Sparkles,
  Gauge,
  Layers,
  AlertTriangle
} from 'lucide-react';
import { OverlapPolicy, TransitionType } from '../../types/project';
import { DEFAULT_OVERLAP_POLICY, useProjectStore } from '../../store/useProjectStore';
import { formatDuration } from '../../core/utils/time';

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
    label: 'Ripple',
    hint: 'Los clips posteriores de la pista se desplazan para hacer sitio.',
  },
};

export const ClipInspector: React.FC = () => {
  const clip = useProjectStore((s) => s.project.clips.find((c) => c.id === s.selectedClipId));
  const track = useProjectStore((s) => s.project.tracks.find((t) => t.id === clip?.trackId));
  const updateClip = useProjectStore((s) => s.updateClip);
  const removeClip = useProjectStore((s) => s.removeClip);
  const mediaPool = useProjectStore((s) => s.project.mediaPool);
  const overlapPolicy = useProjectStore((s) => s.project.overlapPolicy ?? DEFAULT_OVERLAP_POLICY);
  const setOverlapPolicy = useProjectStore((s) => s.setOverlapPolicy);

  const policySection = (
    <div className="space-y-2 mt-auto pt-3 mb-1" data-testid="overlap-policy-section">
      <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
        <Layers size={13} className="text-blue-400" />
        <span>Política de Solapamiento</span>
      </div>
      <div className="bg-dark-950 p-2.5 rounded-lg border border-dark-800 space-y-2">
        <label htmlFor="overlap-policy-select" className="text-[11px] text-slate-400 block">
          Qué pasa al insertar un clip donde ya hay contenido:
        </label>
        <select
          id="overlap-policy-select"
          data-testid="overlap-policy-select"
          value={overlapPolicy}
          onChange={(e) => setOverlapPolicy(e.target.value as OverlapPolicy)}
          className="w-full bg-dark-900 border border-dark-750 text-slate-200 text-xs rounded p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <option value="block">Bloquear (recomendado)</option>
          <option value="overwrite">Sobrescribir</option>
          <option value="ripple">Ripple (desplazar)</option>
        </select>
        <p className="text-[10px] leading-snug text-slate-500" data-testid="overlap-policy-hint">
          {OVERLAP_POLICY_LABELS[overlapPolicy]?.hint ?? ''}
        </p>
      </div>
    </div>
  );

  if (!clip) {
    return (
      <div className="flex flex-col h-full bg-dark-900 border-r border-dark-800 p-3 overflow-y-auto select-none">
        <div className="flex flex-col items-center justify-center flex-1 p-6 text-center text-slate-400 select-none">
          <Sliders size={32} className="mb-2 text-slate-500 stroke-1" />
          <p className="text-xs font-semibold text-slate-200">Ningún clip seleccionado</p>
          <p className="text-[11px] text-slate-400 mt-1">
            Haz clic sobre un clip en el timeline para ajustar volumen, opacidad, tamaño o texto.
          </p>
        </div>
        {policySection}
      </div>
    );
  }

  const isVideoOrImage = clip.type === 'video' || clip.type === 'image';
  const hasAudio = clip.type === 'video' || clip.type === 'audio';
  const isText = clip.type === 'text';

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
    <div className="flex flex-col h-full bg-dark-900 border-r border-dark-800 p-3 overflow-y-auto select-none">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 mb-3 border-b border-dark-800">
        <div className="flex items-center gap-2">
          <Sliders size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-slate-200">Inspector de Clip</span>
        </div>
        <button
          onClick={() => {
            if (confirm(`¿Eliminar el clip "${clip.name}"? Puedes deshacerlo con Ctrl+Z.`)) {
              removeClip(clip.id);
            }
          }}
          className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-950/40 rounded transition"
          title="Eliminar clip (Supr)"
          aria-label={`Eliminar clip ${clip.name}`}
        >
          <Trash2 size={15} />
        </button>
      </div>

      {/* Clip Summary Card */}
      <div className="bg-dark-950 p-2.5 rounded-lg border border-dark-800 mb-3 space-y-1 text-xs">
        <div className="flex justify-between text-slate-400">
          <span>Nombre:</span>
          <span className="text-slate-200 font-medium truncate max-w-[160px]">{clip.name}</span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Pista:</span>
          <span className="text-blue-400 font-medium">{track?.name || 'Desconocida'}</span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Duración:</span>
          <span className="font-mono text-slate-300">{formatDuration(clip.duration)}</span>
        </div>
      </div>

      {/* F3: the media of this clip is not available (B-14). */}
      {(mediaUnavailable || mediaBroken) && (
        <div
          data-testid="inspector-missing-media"
          role="alert"
          className="mb-3 p-2 bg-rose-950/40 border border-rose-700/60 rounded text-rose-200 text-[11px] flex items-start gap-2"
        >
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>
            {mediaUnavailable
              ? 'El archivo de este medio no está disponible: el clip se ve negro y sin sonido. Revínculalo desde el panel de medios.'
              : 'El archivo de este medio no se puede decodificar. Revínculalo desde el panel de medios.'}
          </span>
        </div>
      )}

      {/* TEXT PROPERTIES */}
      {isText && (
        <div className="space-y-3 mb-4">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Type size={13} className="text-blue-400" />
            <span>Contenido y Estilo de Texto</span>
          </div>

          <div>
            <label htmlFor={`clip-text-${clip.id}`} className="text-[11px] text-slate-400 block mb-1">Texto:</label>
            <textarea
              id={`clip-text-${clip.id}`}
              value={clip.text || ''}
              onChange={(e) => updateClip(clip.id, { text: e.target.value, name: e.target.value.slice(0, 20) || 'Texto' })}
              rows={3}
              className="w-full bg-dark-950 border border-dark-750 focus:border-blue-500 text-slate-100 rounded p-2 text-xs outline-none resize-none font-medium focus-visible:ring-2 focus-visible:ring-blue-500"
            />
          </div>

          {/* Font Family & Size */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={`clip-font-${clip.id}`} className="text-[11px] text-slate-400 block mb-1">Tipografía:</label>
              <select
                id={`clip-font-${clip.id}`}
                value={clip.textStyle?.fontFamily || 'Inter, sans-serif'}
                onChange={(e) =>
                  updateClip(clip.id, {
                    textStyle: { ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }), fontFamily: e.target.value },
                  })
                }
                className="w-full bg-dark-950 border border-dark-750 text-slate-200 text-xs rounded p-1.5 outline-none"
              >
                {fontOptions.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[11px] text-slate-400 block mb-1">
                Tamaño: {clip.textStyle?.fontSize || 48}px
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
                className="w-full h-1.5 bg-dark-750 accent-blue-500 rounded cursor-pointer mt-2"
              />
            </div>
          </div>

          {/* Text Color & Background */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-slate-400 block mb-1">Color de Texto:</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={clip.textStyle?.color || '#ffffff'}
                  onChange={(e) =>
                    updateClip(clip.id, {
                      textStyle: { ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }), color: e.target.value },
                    })
                  }
                  className="w-7 h-7 rounded border border-dark-700 bg-transparent cursor-pointer"
                />
                <span className="text-xs font-mono text-slate-400">{clip.textStyle?.color || '#ffffff'}</span>
              </div>
            </div>

            <div>
              <label className="text-[11px] text-slate-400 block mb-1">Fondo de Texto:</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={clip.textStyle?.backgroundColor && clip.textStyle.backgroundColor !== 'transparent' ? clip.textStyle.backgroundColor : '#000000'}
                  onChange={(e) =>
                    updateClip(clip.id, {
                      textStyle: { ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }), backgroundColor: e.target.value },
                    })
                  }
                  className="w-7 h-7 rounded border border-dark-700 bg-transparent cursor-pointer"
                />
                <button
                  onClick={() =>
                    updateClip(clip.id, {
                      textStyle: { ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }), backgroundColor: 'transparent' },
                    })
                  }
                  className="text-[10px] text-slate-400 hover:text-white underline"
                >
                  Sin fondo
                </button>
              </div>
            </div>
          </div>

          {/* Alignment */}
          <div>
            <label className="text-[11px] text-slate-400 block mb-1">Alineación:</label>
            <div className="flex bg-dark-950 p-1 rounded border border-dark-800 gap-1 w-fit">
              {(['left', 'center', 'right'] as const).map((align) => (
                <button
                  key={align}
                  onClick={() =>
                    updateClip(clip.id, {
                      textStyle: { ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }), textAlign: align },
                    })
                  }
                  className={`p-1.5 rounded transition ${
                    clip.textStyle?.textAlign === align ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {align === 'left' && <AlignLeft size={14} />}
                  {align === 'center' && <AlignCenter size={14} />}
                  {align === 'right' && <AlignRight size={14} />}
                </button>
              ))}
            </div>
          </div>

          {/* Animación & Sincronización de Letras */}
          <div className="pt-2 border-t border-dark-800 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-semibold text-slate-300">Efecto de Animación:</label>
              {clip.words && clip.words.length > 0 && (
                <span className="text-[10px] bg-blue-900/60 text-blue-300 px-1.5 py-0.5 rounded border border-blue-700/50">
                  {clip.words.length} palabras sincronizadas
                </span>
              )}
            </div>
            <select
              value={clip.textStyle?.animationPreset || 'none'}
              onChange={(e) =>
                updateClip(clip.id, {
                  textStyle: {
                    ...(clip.textStyle || { fontSize: 48, color: '#ffffff', backgroundColor: 'transparent', fontFamily: 'Inter, sans-serif', textAlign: 'center', fontWeight: 'bold' }),
                    animationPreset: e.target.value as any,
                  },
                })
              }
              className="w-full bg-dark-950 border border-dark-750 text-slate-200 text-xs rounded p-1.5 outline-none"
            >
              <option value="none">Estático (Sin animación)</option>
              <option value="karaoke-fill">Karaoke Progresivo (Apple Music)</option>
              <option value="word-bounce">Rebote / Pop de Palabra (TikTok / Reels)</option>
              <option value="fade-phrase">Desvanecimiento Suave (Fade In / Out)</option>
            </select>

            {/* Color de Resaltado (Highlight) si es Karaoke o Bounce */}
            {(clip.textStyle?.animationPreset === 'karaoke-fill' || clip.textStyle?.animationPreset === 'word-bounce') && (
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">Color de Palabra Activa:</label>
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
                    className="w-7 h-7 rounded border border-dark-700 bg-transparent cursor-pointer"
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
                        className="w-5 h-5 rounded-full border border-dark-700 hover:scale-110 transition"
                        style={{ backgroundColor: c }}
                        title={c}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TRANSFORM & VISUALS */}
      {(isVideoOrImage || isText) && (
        <div className="space-y-3 mb-4">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Maximize2 size={13} className="text-blue-400" />
            <span>Transformación & Visibilidad</span>
          </div>

          {/* Scale */}
          <div>
            <div className="flex justify-between text-xs text-slate-400 mb-1">
              <span>Escala:</span>
              <span className="font-mono text-slate-200">{Math.round((clip.scale ?? 1) * 100)}%</span>
            </div>
            <input
              type="range"
              min="0.2"
              max="2.5"
              step="0.05"
              value={clip.scale ?? 1}
              aria-label="Escala del clip"
              onChange={(e) => updateClip(clip.id, { scale: parseFloat(e.target.value) })}
              className="w-full h-1.5 bg-dark-750 accent-cyan-400 rounded cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            />
          </div>

          {/* Opacity */}
          <div>
            <div className="flex justify-between text-xs text-slate-400 mb-1">
              <span>Opacidad:</span>
              <span className="font-mono text-slate-200">{Math.round((clip.opacity ?? 1) * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={clip.opacity ?? 1}
              aria-label="Opacidad del clip"
              onChange={(e) => updateClip(clip.id, { opacity: parseFloat(e.target.value) })}
              className="w-full h-1.5 bg-dark-750 accent-cyan-400 rounded cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            />
          </div>

          {/* Position X / Y */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                <span>Posición X:</span>
                <span className="font-mono">{clip.positionX || 0}px</span>
              </div>
              <input
                type="range"
                min="-500"
                max="500"
                step="5"
                value={clip.positionX || 0}
                aria-label="Posición horizontal X"
                onChange={(e) => updateClip(clip.id, { positionX: parseInt(e.target.value) })}
                className="w-full h-1.5 bg-dark-750 accent-cyan-400 rounded cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
              />
            </div>
            <div>
              <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                <span>Posición Y:</span>
                <span className="font-mono">{clip.positionY || 0}px</span>
              </div>
              <input
                type="range"
                min="-500"
                max="500"
                step="5"
                value={clip.positionY || 0}
                aria-label="Posición vertical Y"
                onChange={(e) => updateClip(clip.id, { positionY: parseInt(e.target.value) })}
                className="w-full h-1.5 bg-dark-750 accent-cyan-400 rounded cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
              />
            </div>
          </div>

          {/* Reset Transform Button */}
          <button
            onClick={() => updateClip(clip.id, { scale: 1, opacity: 1, positionX: 0, positionY: 0 })}
            className="w-full text-center py-1.5 text-[11px] font-medium text-slate-300 hover:text-white bg-dark-850 hover:bg-dark-800 rounded border border-dark-750 transition focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
          >
            Restablecer Transformación
          </button>
        </div>
      )}

      {/* AUDIO PROPERTIES */}
      {hasAudio && (
        <div className="space-y-3 mb-4">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Volume2 size={13} className="text-emerald-400" />
            <span>Audio del Clip</span>
          </div>

          {/* Volume */}
          <div>
            <div className="flex justify-between text-xs text-slate-400 mb-1">
              <span>Volumen:</span>
              <span className="font-mono text-slate-200">{Math.round((clip.volume ?? 1) * 100)}%</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={clip.volume ?? 1}
                aria-label="Volumen del clip"
                onChange={(e) => updateClip(clip.id, { volume: parseFloat(e.target.value) })}
                className="flex-1 h-1.5 bg-dark-750 accent-emerald-500 rounded cursor-pointer focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:outline-none"
              />
              <button
                onClick={() => updateClip(clip.id, { muted: !clip.muted })}
                aria-label={clip.muted ? 'Activar sonido del clip' : 'Silenciar clip'}
                className={`p-1.5 rounded transition focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:outline-none ${
                  clip.muted ? 'bg-rose-950/40 text-rose-300 border border-rose-800/50' : 'bg-dark-800 text-slate-300 hover:text-white'
                }`}
                title={clip.muted ? 'Clip silenciado' : 'Silenciar clip'}
              >
                {clip.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PLAYBACK SPEED CONTROL */}
      {(hasAudio || clip.type === 'video') && (
        <div className="space-y-3 mb-4">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Gauge size={13} className="text-blue-400" />
            <span>Velocidad de Reproducción</span>
          </div>

          <div className="bg-dark-950 p-2.5 rounded-lg border border-dark-800 space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-slate-400">Factor actual:</span>
              <span className="font-mono text-blue-400 font-semibold">{clip.speed || 1}x</span>
            </div>

            {/* Quick Speed Preset Buttons */}
            <div className="grid grid-cols-4 gap-1.5">
              {[0.5, 1, 1.5, 2].map((spd) => (
                <button
                  key={spd}
                  onClick={() => updateClip(clip.id, { speed: spd })}
                  className={`py-1 text-xs rounded border transition font-mono ${
                    (clip.speed || 1) === spd
                      ? 'bg-blue-600 text-white border-blue-500 font-bold shadow-sm'
                      : 'bg-dark-900 text-slate-300 border-dark-750 hover:bg-dark-850 hover:text-white'
                  }`}
                >
                  {spd}x
                </button>
              ))}
            </div>

            {/* Continuous Speed Slider */}
            <div>
              <div className="flex justify-between text-[10px] text-slate-500 mt-1 mb-1">
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
                className="w-full h-1.5 bg-dark-750 accent-blue-500 rounded cursor-pointer"
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
                className="w-3.5 h-3.5 accent-blue-500 rounded focus-visible:ring-2 focus-visible:ring-blue-500"
              />
              <span className="text-[11px] text-slate-300 font-medium">
                Preservar el tono (pitch)
              </span>
            </label>
            <p className="text-[10px] leading-snug text-slate-500" data-testid="clip-preserve-pitch-hint">
              {clip.preservePitch === false
                ? 'El tono sube o baja con la velocidad (efecto "chipmunk"). El preview y el export se comportan igual.'
                : 'Al acelerar, la voz mantiene su tono original: el preview y el MP4 exportado suenan exactamente igual.'}
            </p>
          </div>
        </div>
      )}

      {/* TRANSITIONS & FADES */}
      <div className="space-y-3 mb-4">
        <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
          <Sparkles size={13} className="text-amber-400" />
          <span>Transiciones y Fundidos</span>
        </div>

        {/* Fade In */}
        <div className="bg-dark-950 p-2.5 rounded-lg border border-dark-800 space-y-2">
          <div className="flex justify-between items-center text-xs">
            <span className="font-medium text-slate-300">Fundido de Entrada (In):</span>
            <span className="text-[11px] font-mono text-slate-400">
              {(clip.transition?.fadeInDuration ?? 0).toFixed(1)}s
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-slate-400 block mb-1">Efecto:</label>
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
                className="w-full bg-dark-900 border border-dark-750 text-slate-200 text-xs rounded p-1.5 outline-none"
              >
                <option value="none">Ninguno</option>
                <option value="fade-black">Fundido a Negro</option>
                <option value="fade-white">Fundido a Blanco</option>
                <option value="slide-left">Deslizar (Slide)</option>
                <option value="wipe-right">Cortina (Wipe)</option>
              </select>
            </div>

            <div>
              <label className="text-[10px] text-slate-400 block mb-1">Duración:</label>
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
                className="w-full h-1.5 bg-dark-750 accent-amber-500 rounded cursor-pointer mt-2 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Fade Out */}
        <div className="bg-dark-950 p-2.5 rounded-lg border border-dark-800 space-y-2">
          <div className="flex justify-between items-center text-xs">
            <span className="font-medium text-slate-300">Fundido de Salida (Out):</span>
            <span className="text-[11px] font-mono text-slate-400">
              {(clip.transition?.fadeOutDuration ?? 0).toFixed(1)}s
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-slate-400 block mb-1">Efecto:</label>
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
                className="w-full bg-dark-900 border border-dark-750 text-slate-200 text-xs rounded p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:outline-none"
              >
                <option value="none">Ninguno</option>
                <option value="fade-black">Fundido a Negro</option>
                <option value="fade-white">Fundido a Blanco</option>
                <option value="slide-left">Deslizar (Slide)</option>
                <option value="wipe-right">Cortina (Wipe)</option>
              </select>
            </div>

            <div>
              <label className="text-[10px] text-slate-400 block mb-1">Duración:</label>
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
                className="w-full h-1.5 bg-dark-750 accent-amber-500 rounded cursor-pointer mt-2 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:outline-none"
              />
            </div>
          </div>
        </div>
      </div>

      {policySection}
    </div>
  );
};
