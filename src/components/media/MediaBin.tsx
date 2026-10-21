import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  FolderOpen,
  AlertCircle,
  Loader2,
  Mic,
  Square,
  X,
  Trash2,
  Link2,
  RotateCcw,
  HardDrive,
  Download,
} from 'lucide-react';
import { MediaItem, MediaType } from '../../types/project';
import { useProjectStore } from '../../store/useProjectStore';
import { generateVideoThumbnail, createPlaceholderThumbnail, generateFilmstrip, generatePlaceholderFilmstrip } from '../../core/utils/thumbnails';
import { extractWaveformPeaksFromBlob, generateSyntheticWaveform } from '../../core/utils/waveform';
import { saveMediaToOPFS } from '../../core/storage/opfsStorage';
import { WAV_MIME } from '../../core/export/wavExporter';
import {
  VOZ_AVISO_MONITOR,
  VOZ_BASE_NOMBRE,
  VOZ_ETIQUETA_GRABAR,
  VOZ_MENSAJE_DENEGADA,
  VOZ_PICOS_CELDAS,
  calcularDuracionVoz,
  calcularPicosVoz,
  codificarWavVoz,
  construirMediaItemVoz,
  construirNombreArchivoVoz,
  crearIdVoz,
  formatearTiempoVoz,
  iniciarCapturaVoz,
  liberarMicrofono,
  mensajeErrorMicrofono,
  normalizarCanalesVoz,
  pedirMicrofono,
  siguienteNombreVoz,
  transicionGrabacion,
  type ClaseErrorMicrofono,
  type ControlCapturaVoz,
  type EstadoGrabacion,
} from '../../core/utils/recording';
import {
  MAX_EMBEDDED_MEDIA_BYTES,
  buildQuotaSnapshot,
  exportProjectToFile,
  formatStorageBytes,
  listProjects,
  readStorageEstimate,
  summarizeStorageUsage,
  type StorageQuotaSnapshot,
} from '../../core/storage/projectStorage';
import { createPresetMediaItems } from '../../core/utils/sampleMedia';
import { MediaItemCard } from './MediaItemCard';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';

/** Fallback dimensions used when the real size of a media file cannot be probed. */
export const FALLBACK_MEDIA_WIDTH = 1280;
export const FALLBACK_MEDIA_HEIGHT = 720;

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Reads the INTRINSIC dimensions of an image (B-03).
 *
 * Imported images used to be recorded as 1280x720 no matter what, which
 * stretched every photo in the preview and in the export.
 * Uses `createImageBitmap` when available and falls back to an `Image` element.
 * Returns `null` when the size cannot be determined.
 */
export async function probeImageDimensions(
  source: Blob,
  objectUrl: string
): Promise<ImageDimensions | null> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(source);
      const width = bitmap.width;
      const height = bitmap.height;
      if (typeof bitmap.close === 'function') bitmap.close();
      if (width > 0 && height > 0) return { width, height };
    }
  } catch {
    // Fall through to the <img> probe.
  }

  try {
    if (typeof Image === 'function') {
      return await new Promise<ImageDimensions | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
          const width = img.naturalWidth || img.width;
          const height = img.naturalHeight || img.height;
          resolve(width > 0 && height > 0 ? { width, height } : null);
        };
        img.onerror = () => resolve(null);
        img.src = objectUrl;
      });
    }
  } catch {
    // Ignore: the caller falls back to the default dimensions.
  }

  return null;
}

/**
 * Builds a `MediaItem` from an imported file, probing the real dimensions of
 * images so they are never distorted (B-03).
 * Returns `null` for unsupported file types.
 */
export async function buildMediaItemFromFile(
  file: File,
  mediaId: string = 'media_' + Math.random().toString(36).substring(2, 9)
): Promise<MediaItem | null> {
  let type: MediaType = 'video';
  if (file.type.startsWith('audio/')) type = 'audio';
  else if (file.type.startsWith('image/')) type = 'image';
  else if (!file.type.startsWith('video/')) return null;

  const objectUrl = URL.createObjectURL(file);

  let opfsPath: string | undefined;
  try {
    opfsPath = await saveMediaToOPFS(mediaId, file);
  } catch (err) {
    console.warn('OPFS storage note:', err);
  }

  let duration = 5;
  let width = FALLBACK_MEDIA_WIDTH;
  let height = FALLBACK_MEDIA_HEIGHT;
  let thumbnailUrl = '';
  let thumbnails: string[] | undefined;
  let waveformPeaks: number[] | undefined;

  if (type === 'video') {
    try {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.src = objectUrl;

      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('Formato de video no soportado'));
        setTimeout(() => resolve(), 3000);
      });

      duration = video.duration || 5;
      width = video.videoWidth || FALLBACK_MEDIA_WIDTH;
      height = video.videoHeight || FALLBACK_MEDIA_HEIGHT;
      thumbnailUrl = await generateVideoThumbnail(file, Math.min(1, duration / 2));
      const generatedThumbs = await generateFilmstrip(file, duration, 6).catch(() => []);
      thumbnails = generatedThumbs && generatedThumbs.length > 0 ? generatedThumbs : generatePlaceholderFilmstrip(6, '#3b82f6');
      const peaks = await extractWaveformPeaksFromBlob(file, 80).catch(() => []);
      waveformPeaks = peaks.length > 0 ? peaks : generateSyntheticWaveform(60);
    } catch {
      thumbnailUrl = createPlaceholderThumbnail('Video', '#3b82f6');
      thumbnails = generatePlaceholderFilmstrip(6, '#3b82f6');
    }
  } else if (type === 'audio') {
    try {
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      audio.src = objectUrl;
      await new Promise<void>((resolve) => {
        audio.onloadedmetadata = () => resolve();
        setTimeout(() => resolve(), 3000);
      });
      duration = audio.duration || 5;
      thumbnailUrl = createPlaceholderThumbnail('Audio', '#10b981');
      const peaks = await extractWaveformPeaksFromBlob(file, 80).catch(() => []);
      waveformPeaks = peaks.length > 0 ? peaks : generateSyntheticWaveform(80);
    } catch {
      thumbnailUrl = createPlaceholderThumbnail('Audio', '#10b981');
      waveformPeaks = generateSyntheticWaveform(80);
    }
  } else if (type === 'image') {
    thumbnailUrl = objectUrl;
    duration = 5;
    // B-03: store the REAL intrinsic size so the image keeps its aspect ratio.
    const dimensions = await probeImageDimensions(file, objectUrl);
    if (dimensions) {
      width = dimensions.width;
      height = dimensions.height;
    }
  }

  const item: MediaItem = {
    id: mediaId,
    name: file.name,
    type,
    url: objectUrl,
    duration,
    width,
    height,
    fps: 30,
    thumbnailUrl,
    thumbnails,
    waveformPeaks,
    size: file.size,
    createdAt: Date.now(),
    opfsPath,
  };

  return item;
}

/**
 * Props del control de voz en off (reutilizado por el bin y por la hoja
 * móvil de Audio: la misma UI, sin duplicar).
 */
export interface ControlVozEnOffProps {
  /** Versión compacta para la hoja móvil (objetivos táctiles de 44 px). */
  compacto?: boolean;
  /**
   * Abre el importador cuando el permiso falla. Lo da el bin; la hoja móvil
   * no lo tiene y enseña solo el texto (importar vive en Medios).
   */
  alImportar?: () => void;
}

/**
 * Voz en off local: graba la narración con el micrófono y la deja como un
 * medio de audio NORMAL en el pool (se añade a la línea de tiempo como
 * cualquier audio y sobrevive a la recarga vía OPFS).
 *
 * - La máquina (`inactiva → pidiendo → grabando → procesando → lista /
 *   denegada / error / cancelada`) vive en `src/core/utils/recording.ts`.
 * - El temporizador y el nivel se pintan sin estado por fotograma: el tiempo
 *   va por intervalo de 250 ms y el nivel escribe `transform` en el `ref`
 *   (como el medidor del master).
 * - El micrófono se suelta en TODOS los caminos: detener, descartar,
 *   desmontar y error (`liberarMicrofono`, idempotente).
 * - La monitorización está silenciada por construcción (la toma nunca suena
 *   por los altavoces), pero la vista previa SIGUE sonando: se avisa con
 *   `VOZ_AVISO_MONITOR` (auriculares o bajar el volumen general).
 */
export const ControlVozEnOff: React.FC<ControlVozEnOffProps> = ({
  compacto = false,
  alImportar,
}) => {
  const [estado, setEstado] = useState<EstadoGrabacion>('inactiva');
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [segundos, setSegundos] = useState(0);
  const [ultimaToma, setUltimaToma] = useState<string | null>(null);

  /** Espejo del estado para las continuaciones asíncronas (sin cierres rancios). */
  const estadoRef = useRef<EstadoGrabacion>('inactiva');
  const controlRef = useRef<ControlCapturaVoz | null>(null);
  /** Stream pedido pero aún sin grafo (permiso concedido tras cancelar). */
  const pendienteRef = useRef<MediaStream | null>(null);
  const intervaloRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const inicioRef = useRef(0);
  const barraRef = useRef<HTMLDivElement>(null);
  const abandonadoRef = useRef(false);
  const montadoRef = useRef(true);

  const fijarEstado = (siguiente: EstadoGrabacion): void => {
    estadoRef.current = siguiente;
    setEstado(siguiente);
  };

  const limpiarTemporizadores = useCallback((): void => {
    if (intervaloRef.current !== null) {
      clearInterval(intervaloRef.current);
      intervaloRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  /** Suelta todo lo abierto (grafo + permiso pendiente + temporizadores). */
  const soltarTodo = useCallback((): void => {
    const control = controlRef.current;
    controlRef.current = null;
    try {
      control?.liberar();
    } catch {
      // `liberar` nunca lanza: el micro se suelta igual.
    }
    const pendiente = pendienteRef.current;
    pendienteRef.current = null;
    liberarMicrofono(pendiente);
    limpiarTemporizadores();
  }, [limpiarTemporizadores]);

  // Al desmontar no puede quedar ni la captura ni el permiso abiertos (una
  // pista viva se ve como indicador de grabación para el usuario).
  useEffect(() => {
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
      abandonadoRef.current = true;
      soltarTodo();
    };
  }, [soltarTodo]);

  /**
   * Pide el permiso y arranca la captura. Si el permiso llega tarde (tras
   * cancelar o desmontar) el stream se suelta en el acto, sin grafo.
   */
  const pedir = useCallback((): void => {
    const siguiente = transicionGrabacion(estadoRef.current, 'pedir');
    if (!siguiente) return;
    abandonadoRef.current = false;
    setMensaje(null);
    setUltimaToma(null);
    fijarEstado(siguiente);
    void (async () => {
      let stream: MediaStream | null = null;
      try {
        stream = await pedirMicrofono();
      } catch (err) {
        if (!montadoRef.current || abandonadoRef.current) return;
        const causa = (err as Error & { cause?: unknown })?.cause as
          | ClaseErrorMicrofono
          | undefined;
        const evento =
          causa === 'denegada' ? 'denegada' : causa === 'no-disponible' ? 'no-disponible' : 'fallo';
        setMensaje((err as Error)?.message ?? mensajeErrorMicrofono('error'));
        fijarEstado(transicionGrabacion(estadoRef.current, evento) ?? 'error');
        return;
      }
      if (!montadoRef.current || abandonadoRef.current) {
        liberarMicrofono(stream);
        return;
      }
      pendienteRef.current = stream;
      let control: ControlCapturaVoz | null = null;
      try {
        control = iniciarCapturaVoz(stream);
      } catch (err) {
        pendienteRef.current = null;
        liberarMicrofono(stream);
        if (!montadoRef.current || abandonadoRef.current) return;
        setMensaje((err as Error)?.message ?? mensajeErrorMicrofono('error'));
        fijarEstado(transicionGrabacion(estadoRef.current, 'fallo') ?? 'error');
        return;
      }
      if (!montadoRef.current || abandonadoRef.current) {
        pendienteRef.current = null;
        control.liberar();
        return;
      }
      pendienteRef.current = null;
      controlRef.current = control;
      fijarEstado(transicionGrabacion(estadoRef.current, 'permitida') ?? 'grabando');
      inicioRef.current = Date.now();
      setSegundos(0);
      intervaloRef.current = window.setInterval(() => {
        setSegundos((Date.now() - inicioRef.current) / 1000);
      }, 250);
      const bucle = (): void => {
        rafRef.current = requestAnimationFrame(bucle);
        const barra = barraRef.current;
        if (!barra) return;
        const vivo = controlRef.current;
        if (!vivo) {
          barra.style.transform = 'scaleX(0)';
          return;
        }
        barra.style.transform = `scaleX(${vivo.leerNivel().toFixed(3)})`;
      };
      rafRef.current = requestAnimationFrame(bucle);
    })();
  }, []);

  /**
   * Detiene, codifica la toma a WAV y la guarda como un medio normal:
   * OPFS + `addMediaItem` (UN paso del historial, como importar).
   * El micrófono se suelta ANTES de procesar (la toma ya está en memoria).
   */
  const detenerYGuardar = useCallback((): void => {
    const control = controlRef.current;
    const siguiente = control ? transicionGrabacion(estadoRef.current, 'detener') : null;
    if (!control || !siguiente) return;
    const canales = control.recoger();
    const ritmo = control.ritmo;
    controlRef.current = null;
    pendienteRef.current = null;
    try {
      control.liberar();
    } catch {
      // Ignorado: la toma ya está en memoria y el micro se soltó igual.
    }
    limpiarTemporizadores();
    setMensaje(null);
    fijarEstado(siguiente);
    void (async () => {
      try {
        const normales = normalizarCanalesVoz(canales);
        const total = normales.reduce((max, canal) => Math.max(max, canal?.length ?? 0), 0);
        const duracion = calcularDuracionVoz(total, ritmo);
        // Lanza en español cuando la toma está vacía (no entra basura al pool).
        const blob = codificarWavVoz(normales, ritmo);
        const id = crearIdVoz();
        const nombres = useProjectStore.getState().project.mediaPool.map((m) => m.name);
        const nombre = siguienteNombreVoz(nombres);
        const archivo = new File([blob], construirNombreArchivoVoz(nombre), { type: WAV_MIME });
        let opfsPath: string | undefined;
        try {
          opfsPath = await saveMediaToOPFS(id, archivo);
        } catch (err) {
          console.warn('OPFS storage note:', err);
        }
        const url = URL.createObjectURL(archivo);
        let picos: number[] | undefined;
        try {
          const decodificados = await extractWaveformPeaksFromBlob(archivo, VOZ_PICOS_CELDAS);
          picos =
            decodificados.length > 0
              ? decodificados
              : calcularPicosVoz(normales[0] ?? new Float32Array(0), VOZ_PICOS_CELDAS);
        } catch {
          picos = calcularPicosVoz(normales[0] ?? new Float32Array(0), VOZ_PICOS_CELDAS);
        }
        let miniatura = '';
        try {
          miniatura = createPlaceholderThumbnail(VOZ_BASE_NOMBRE, '#10b981');
        } catch {
          miniatura = '';
        }
        const item = construirMediaItemVoz({
          id,
          nombre,
          blob: archivo,
          duracion,
          url,
          miniatura,
          picos,
          opfsPath,
        });
        useProjectStore.getState().addMediaItem(item);
        if (!montadoRef.current) return;
        setUltimaToma(nombre);
        fijarEstado(transicionGrabacion(estadoRef.current, 'guardada') ?? 'lista');
      } catch (err) {
        if (!montadoRef.current) return;
        setMensaje(err instanceof Error ? err.message : mensajeErrorMicrofono('error'));
        fijarEstado(transicionGrabacion(estadoRef.current, 'fallo') ?? 'error');
      }
    })();
  }, [limpiarTemporizadores]);

  /** Descarta la toma (el micro se suelta, nada entra al pool). */
  const cancelar = useCallback((): void => {
    const siguiente = transicionGrabacion(estadoRef.current, 'cancelar');
    if (!siguiente) return;
    abandonadoRef.current = true;
    soltarTodo();
    setMensaje('Toma descartada.');
    fijarEstado(siguiente);
  }, [soltarTodo]);

  /** Vuelve al reposo (cierra el aviso). */
  const descartar = useCallback((): void => {
    const siguiente = transicionGrabacion(estadoRef.current, 'descartar');
    if (!siguiente) return;
    setMensaje(null);
    setUltimaToma(null);
    setSegundos(0);
    fijarEstado(siguiente);
  }, []);

  /** Reintenta: vuelve al reposo y pide el permiso de nuevo. */
  const reintentar = useCallback((): void => {
    if (!transicionGrabacion(estadoRef.current, 'reintentar')) return;
    setMensaje(null);
    setUltimaToma(null);
    fijarEstado('inactiva');
    pedir();
  }, [pedir]);

  const tactil = compacto ? 'min-h-[44px]' : '';
  const esDenegada = mensaje === VOZ_MENSAJE_DENEGADA;

  // Reposo: solo el disparador (una puerta, como Importar).
  if (estado === 'inactiva') {
    return (
      <div data-testid="control-voz">
        <Button
          variant="secondary"
          size="sm"
          icon={<Mic size={14} aria-hidden="true" />}
          onClick={pedir}
          data-testid="voz-grabar"
          title={VOZ_ETIQUETA_GRABAR}
          aria-label={VOZ_ETIQUETA_GRABAR}
          className={`w-full ${tactil}`}
        >
          {VOZ_ETIQUETA_GRABAR}
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="control-voz" className="rounded border border-border-subtle bg-raised px-2 py-1.5">
      {/* Pidiendo: el navegador tiene la palabra (su diálogo de permiso). */}
      {estado === 'pidiendo' && (
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="shrink-0 animate-spin text-text-2" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-body-sm text-text-1">
            Pidiendo acceso al micrófono…
            <span className="block text-caption text-text-3">
              Acepta el permiso en el navegador para empezar.
            </span>
          </p>
          <Button variant="ghost" size="sm" onClick={cancelar} data-testid="voz-cancelar" className={tactil}>
            Cancelar
          </Button>
        </div>
      )}

      {/* Grabando: punto sobrio (sin parpadeo) + tiempo + nivel + acciones. */}
      {estado === 'grabando' && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-danger" />
            <p className="min-w-0 flex-1 truncate text-body-sm font-medium text-text-1">
              Grabando voz en off
            </p>
            <span
              role="timer"
              aria-label="Tiempo de grabación"
              data-testid="voz-tiempo"
              className="shrink-0 font-mono text-timecode tabular text-text-1"
            >
              {formatearTiempoVoz(segundos)}
            </span>
          </div>
          <div
            role="img"
            aria-label="Nivel de entrada"
            data-testid="voz-nivel"
            className="h-1 w-full overflow-hidden rounded bg-app"
          >
            <div
              ref={barraRef}
              className="h-full w-full origin-left bg-text-2"
              style={{ transform: 'scaleX(0)' }}
            />
          </div>
          <p className="text-caption leading-snug text-text-3">{VOZ_AVISO_MONITOR}</p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="primary"
              size="sm"
              icon={<Square size={13} aria-hidden="true" />}
              onClick={detenerYGuardar}
              data-testid="voz-detener"
              title="Detener y guardar la toma en Medios"
              aria-label="Detener y guardar la toma en Medios"
              className={`flex-1 ${tactil}`}
            >
              Detener
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={cancelar}
              data-testid="voz-descartar"
              title="Descartar la toma sin guardarla"
              aria-label="Descartar la toma sin guardarla"
              className={tactil}
            >
              Descartar
            </Button>
          </div>
        </div>
      )}

      {/* Procesando: la toma ya está en memoria, el micro ya está suelto. */}
      {estado === 'procesando' && (
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="shrink-0 animate-spin text-text-2" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-body-sm text-text-1">Guardando la toma…</p>
        </div>
      )}

      {/* Lista: la toma ya es un medio más (Badge de éxito, un hecho). */}
      {estado === 'lista' && (
        <div className="flex items-center gap-2">
          <Badge variant="success">Toma guardada</Badge>
          <p className="min-w-0 flex-1 truncate text-body-sm text-text-1" title={ultimaToma ?? ''}>
            {ultimaToma ? `«${ultimaToma}» está en Medios.` : 'La toma está en Medios.'}
          </p>
          <Button variant="ghost" size="sm" onClick={descartar} data-testid="voz-cerrar" className={tactil}>
            Cerrar
          </Button>
        </div>
      )}

      {/* Denegada o error: problema + recuperación (nunca solo el susto). */}
      {(estado === 'denegada' || estado === 'error') && (
        <div className="flex flex-col gap-1.5">
          <div role="alert" className="flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <p className="min-w-0 flex-1 break-words text-body-sm text-text-1">{mensaje}</p>
          </div>
          <div className="flex items-center gap-1.5">
            {esDenegada && alImportar && (
              <Button
                variant="secondary"
                size="sm"
                icon={<FolderOpen size={13} aria-hidden="true" />}
                onClick={alImportar}
                data-testid="voz-importar"
                title="Importar un archivo de audio en vez de grabar"
                aria-label="Importar un archivo de audio en vez de grabar"
                className={tactil}
              >
                Importar audio
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={reintentar} data-testid="voz-reintentar" className={tactil}>
              Reintentar
            </Button>
            <Button variant="ghost" size="sm" onClick={descartar} data-testid="voz-cerrar" className={tactil}>
              Cerrar
            </Button>
          </div>
        </div>
      )}

      {/* Cancelada: la toma se descartó, nada entró al pool. */}
      {estado === 'cancelada' && (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-body-sm text-text-2">{mensaje ?? 'Toma descartada.'}</p>
          <Button variant="secondary" size="sm" onClick={reintentar} data-testid="voz-regrabar" className={tactil}>
            Grabar de nuevo
          </Button>
          <IconButton
            size="sm"
            onClick={descartar}
            data-testid="voz-cerrar"
            aria-label="Cerrar aviso"
            title="Cerrar aviso"
          >
            <X size={13} />
          </IconButton>
        </div>
      )}
    </div>
  );
};

export const MediaBin: React.FC = () => {
  const mediaPool = useProjectStore((s) => s.project.mediaPool);
  const trash = useProjectStore((s) => s.project.trash ?? []);
  const addMediaItem = useProjectStore((s) => s.addMediaItem);
  const restoreFromTrash = useProjectStore((s) => s.restoreFromTrash);
  const purgeTrash = useProjectStore((s) => s.purgeTrash);
  const purgeTrashedMedia = useProjectStore((s) => s.purgeTrashedMedia);
  const relinkMedia = useProjectStore((s) => s.relinkMedia);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isGeneratingSamples, setIsGeneratingSamples] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** Shows/hides the "Medios ausentes" panel (F3). */
  const [showMissing, setShowMissing] = useState(true);
  /** Shows/hides the "Papelera" panel (F2). */
  const [showTrash, setShowTrash] = useState(true);
  /** True when the purge of the whole trash is armed (two step confirmation). */
  const [purgeArmed, setPurgeArmed] = useState(false);
  /* --- F1: gestor de almacenamiento ------------------------------- */
  /** Shows/hides the "Almacenamiento" panel. */
  const [showStorage, setShowStorage] = useState(false);
  /** Quota snapshot (null when the browser does not expose the estimate). */
  const [quota, setQuota] = useState<StorageQuotaSnapshot | null>(null);
  /** null = loading, false = the API is not available, true = it is. */
  const [quotaAvailable, setQuotaAvailable] = useState<boolean | null>(null);
  /** Number of projects saved in this browser. */
  const [projectCount, setProjectCount] = useState(0);
  /** Result of the last storage action (Spanish). */
  const [storageMessage, setStorageMessage] = useState<string | null>(null);
  /** True when the purge from the storage panel is armed. */
  const [storagePurgeArmed, setStoragePurgeArmed] = useState(false);
  /** True while the backup is being written. */
  const [isBackingUp, setIsBackingUp] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Hidden input used to pick the replacement file of a missing media (F3). */
  const relinkInputRef = useRef<HTMLInputElement>(null);
  /** Media id whose replacement file is being picked (F3). */
  const relinkTargetRef = useRef<string | null>(null);

  const missingMedia = mediaPool.filter((m) => m.status === 'missing' || m.status === 'error');

  /* ------------------------------------------------------------------ */
  /* F1 — Almacenamiento: cuota, proyectos, medios y papelera            */
  /* ------------------------------------------------------------------ */

  const storageSummary = summarizeStorageUsage(projectCount, { mediaPool, trash });

  /**
   * Reads the quota and the number of projects. It never throws: when the
   * Storage API is not available (private mode, old browser) the panel
   * degrades to "no disponible" instead of breaking the media bin.
   */
  const refreshStorage = useCallback(async () => {
    const estimate = await readStorageEstimate();
    if (estimate) {
      setQuota(buildQuotaSnapshot(estimate.usage, estimate.quota));
      setQuotaAvailable(true);
    } else {
      setQuota(null);
      setQuotaAvailable(false);
    }
    try {
      const projects = await listProjects();
      setProjectCount(Array.isArray(projects) ? projects.length : 0);
    } catch {
      setProjectCount(0);
    }
  }, []);

  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage, mediaPool.length, trash.length]);

  /**
   * F1: empties the trash for good (the OPFS blobs are deleted with it).
   * Two step confirmation: the first tap arms it, the second one deletes.
   */
  const handleStoragePurge = () => {
    if (trash.length === 0) return;
    if (!storagePurgeArmed) {
      setStoragePurgeArmed(true);
      return;
    }
    setStoragePurgeArmed(false);
    const purged = purgeTrash();
    setStorageMessage(
      purged === 1 ? 'Papelera vaciada: 1 medio borrado.' : `Papelera vaciada: ${purged} medios borrados.`
    );
    void refreshStorage();
  };

  /**
   * F2: writes a real backup (project + media bytes) of the current project.
   */
  const handleBackup = async () => {
    if (isBackingUp) return;
    setIsBackingUp(true);
    setStorageMessage(null);
    try {
      // The project is read on demand: the media bin does not have to
      // re-render on every edit of the timeline.
      const current = useProjectStore.getState().project;
      const outcome = await exportProjectToFile(current, 'hydra', { includeMedia: true });
      if (outcome.mediaEmbedded) {
        setStorageMessage(
          `Copia de seguridad creada con ${outcome.embeddedCount} medio(s) (${formatStorageBytes(outcome.encodedBytes)}): ${outcome.fileName}`
        );
      } else if (outcome.skipped === 'too-large') {
        setStorageMessage(
          `Los medios superan el límite de ${formatStorageBytes(MAX_EMBEDDED_MEDIA_BYTES)}: la copia se ha creado SIN los archivos multimedia (${outcome.fileName}).`
        );
      } else {
        setStorageMessage(
          `Copia de seguridad creada sin los archivos multimedia (${outcome.fileName}).`
        );
      }
    } catch (err) {
      setStorageMessage(
        `No se pudo crear la copia de seguridad: ${(err as Error).message ?? 'error desconocido'}`
      );
    } finally {
      setIsBackingUp(false);
    }
  };

  const processFile = async (file: File) => {
    const item = await buildMediaItemFromFile(file);
    if (!item) return;
    addMediaItem(item);
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsProcessing(true);
    setErrorMessage(null);

    try {
      for (let i = 0; i < files.length; i++) {
        await processFile(files[i]);
      }
    } catch (err) {
      setErrorMessage((err as Error).message || 'Error procesando archivos multimedia');
    } finally {
      setIsProcessing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    await handleFiles(e.dataTransfer.files);
  };

  const handleGenerateSampleClips = async () => {
    if (isGeneratingSamples) return;
    setIsGeneratingSamples(true);
    try {
      const sampleItems = await createPresetMediaItems();
      for (const item of sampleItems) {
        addMediaItem(item);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsGeneratingSamples(false);
    }
  };

  /**
   * F3: the user picks a replacement file for a media whose bytes are gone.
   * The media keeps its id, so its clips keep working.
   */
  const handleRelinkClick = (mediaId: string) => {
    relinkTargetRef.current = mediaId;
    relinkInputRef.current?.click();
  };

  const handleRelinkFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetId = relinkTargetRef.current;
    relinkTargetRef.current = null;
    if (relinkInputRef.current) relinkInputRef.current.value = '';
    if (!file || !targetId) return;
    setErrorMessage(null);
    const ok = await relinkMedia(targetId, file);
    if (!ok) {
      setErrorMessage(
        `No se pudo revincular: usa un archivo de vídeo, audio o imagen válido.`
      );
    }
  };

  /**
   * F2: the trash holds the media that left the project. It can be restored
   * (the bytes are still there) or purged for good.
   *
   * The purge is confirmed in two steps (no native dialog): the first click
   * arms it and the second one destroys the bytes for good.
   */
  const handlePurgeTrash = () => {
    if (!purgeArmed) {
      setPurgeArmed(true);
      return;
    }
    setPurgeArmed(false);
    purgeTrash();
  };

  /** Bytes totales de la papelera (se enseñan en su cabecera). */
  const trashBytes = trash.reduce((acc, entry) => acc + (entry.media.size || 0), 0);

  return (
    <div className="flex h-full select-none flex-col overflow-hidden bg-panel">
      {/* F2 — cabecera: «Medios» + conteo en caption, sin envoltorio. */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-3">
        <h2 className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-caption uppercase text-text-1">
          Medios <span className="font-normal text-text-3">({mediaPool.length})</span>
        </h2>

        <Button
          variant="secondary"
          size="sm"
          icon={<FolderOpen size={14} aria-hidden="true" />}
          onClick={() => fileInputRef.current?.click()}
          disabled={isProcessing}
        >
          Importar
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
        />
      </div>

      {/* Voz en off: grabar la narración sin salir de la app (una puerta,
          legible también dentro de la hoja móvil, que monta este mismo bin). */}
      <div className="shrink-0 border-b border-border-subtle px-3 py-2">
        <ControlVozEnOff alImportar={() => fileInputRef.current?.click()} />
      </div>

      {/* Aviso de error: problema + cierre, sin jerga. */}
      {errorMessage && (
        <div
          role="alert"
          className="mx-3 mt-2 flex shrink-0 items-center gap-2 rounded border border-danger/50 bg-danger/10 px-2 py-1.5 text-body-sm text-danger"
        >
          <AlertCircle size={14} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">{errorMessage}</span>
          <IconButton
            size="sm"
            aria-label="Cerrar aviso"
            title="Cerrar aviso"
            onClick={() => setErrorMessage(null)}
          >
            <X size={13} />
          </IconButton>
        </div>
      )}

      {/* F4 — lista desplazable (también zona de soltado: el soltado burbujea
          desde las filas). Titular + una acción en vacío, no tres tarjetas. */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`panel-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2 ${
          isDragging ? 'bg-accent-soft' : ''
        }`}
      >
        {isProcessing && (
          <div className="flex flex-col items-center justify-center gap-2 py-6 text-text-2">
            <Loader2 size={24} className="animate-spin text-accent" aria-hidden="true" />
            <span className="text-body-sm">Importando y extrayendo fotogramas...</span>
          </div>
        )}

        {mediaPool.length === 0 && !isProcessing ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-4 py-8 text-center">
            <p className="text-body font-medium text-text-1">Sin medios</p>
            <p className="text-body-sm text-text-2">Arrastra archivos o impórtalos</p>
            <Button
              variant="secondary"
              size="sm"
              icon={<FolderOpen size={14} aria-hidden="true" />}
              onClick={() => fileInputRef.current?.click()}
              className="mt-1"
            >
              Importar
            </Button>
            <p className="mt-1 text-caption text-text-3">Se guarda solo en este navegador</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {mediaPool.map((item) => (
              <li key={item.id} className="min-w-0">
                <MediaItemCard item={item} onRevincular={handleRelinkClick} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* F3 — Medios ausentes: los archivos se fueron, el usuario puede revincularlos. */}
      {missingMedia.length > 0 && (
        <div
          data-testid="missing-media-panel"
          className="shrink-0 border-t border-border-subtle px-3 py-2"
        >
          <button
            onClick={() => setShowMissing((v) => !v)}
            className="flex min-h-[28px] w-full items-center gap-1.5 text-left text-caption uppercase text-warning"
            aria-expanded={showMissing}
          >
            <Link2 size={12} aria-hidden="true" />
            <span className="truncate">Medios ausentes ({missingMedia.length})</span>
          </button>
          {showMissing && (
            <ul className="panel-scroll mt-1.5 max-h-32 space-y-1 overflow-y-auto">
              {missingMedia.map((item) => (
                <li
                  key={item.id}
                  data-testid={`missing-media-${item.id}`}
                  className="flex items-center gap-1.5 text-body-sm text-text-1"
                >
                  <AlertCircle size={12} className="shrink-0 text-warning" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate" title={item.name}>
                    {item.name}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleRelinkClick(item.id)}
                    data-testid={`relink-media-${item.id}`}
                    title={`Revincular ${item.name} con un archivo local`}
                    aria-label={`Revincular ${item.name}`}
                    icon={<Link2 size={12} aria-hidden="true" />}
                  >
                    Revincular
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* F2 — Papelera: qué hay, cuánto ocupa, restaurar y vaciar. */}
      {trash.length > 0 && (
        <div
          data-testid="trash-panel"
          className="shrink-0 border-t border-border-subtle px-3 py-2"
        >
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowTrash((v) => !v)}
              className="flex min-h-[28px] min-w-0 flex-1 items-center gap-1.5 text-left text-caption uppercase text-text-2"
              aria-expanded={showTrash}
            >
              <Trash2 size={12} aria-hidden="true" />
              <span className="truncate">
                Papelera ({trash.length}) · {formatStorageBytes(trashBytes)}
              </span>
            </button>
            <Button
              size="sm"
              variant={purgeArmed ? 'danger' : 'secondary'}
              onClick={handlePurgeTrash}
              data-testid="purge-trash"
              title={
                purgeArmed
                  ? 'Pulsa otra vez para borrar los archivos para siempre'
                  : 'Borrar los archivos de la papelera para siempre'
              }
            >
              {purgeArmed ? 'Confirmar' : 'Vaciar'}
            </Button>
          </div>
          {showTrash && (
            <ul className="panel-scroll mt-1.5 max-h-32 space-y-1 overflow-y-auto">
              {trash.map((entry) => (
                <li
                  key={entry.media.id}
                  data-testid={`trash-entry-${entry.media.id}`}
                  className="flex items-center gap-1.5 text-body-sm text-text-2"
                >
                  <span className="min-w-0 flex-1 truncate" title={entry.media.name}>
                    {entry.media.name}
                  </span>
                  <span className="shrink-0 text-caption text-text-3">
                    {entry.clips.length === 1 ? '1 clip' : `${entry.clips.length} clips`}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => restoreFromTrash(entry.media.id)}
                    data-testid={`restore-media-${entry.media.id}`}
                    title={`Restaurar ${entry.media.name} y sus clips`}
                    aria-label={`Restaurar ${entry.media.name}`}
                    icon={<RotateCcw size={12} aria-hidden="true" />}
                  >
                    Restaurar
                  </Button>
                  <IconButton
                    size="sm"
                    onClick={() => purgeTrashedMedia(entry.media.id)}
                    data-testid={`purge-media-${entry.media.id}`}
                    title={`Borrar ${entry.media.name} para siempre`}
                    aria-label={`Borrar ${entry.media.name} para siempre`}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* F2 — clips de prueba: acción secundaria tranquila al fondo, sin marketing. */}
      <div className="shrink-0 border-t border-border-subtle px-3 py-2">
        <Button
          variant="secondary"
          size="sm"
          icon={isGeneratingSamples ? undefined : <Sparkles size={14} aria-hidden="true" />}
          loading={isGeneratingSamples}
          onClick={handleGenerateSampleClips}
          data-testid="generate-sample-clips"
          className="w-full"
        >
          {isGeneratingSamples ? 'Generando clips…' : 'Generar clips de prueba'}
        </Button>
      </div>

      {/* F3 — Almacenamiento: fila compacta y tranquila (usado/total + barra
          fina + aviso solo cuando importa). Nunca rompe el panel si la API no
          está disponible (modo privado): enseña «no disponible». */}
      <div
        data-testid="storage-panel"
        className="shrink-0 border-t border-border-subtle px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const next = !showStorage;
              setShowStorage(next);
              if (next) void refreshStorage();
            }}
            data-testid="storage-panel-toggle"
            className="flex min-h-[28px] min-w-0 flex-1 items-center gap-1.5 text-left text-body-sm text-text-2"
            aria-expanded={showStorage}
            aria-label={`Almacenamiento: ${
              quota
                ? `${formatStorageBytes(quota.usage)} de ${formatStorageBytes(quota.quota)}`
                : 'espacio usado no disponible'
            }. Ver detalles.`}
            title="Ver el espacio usado y liberar almacenamiento"
          >
            <HardDrive size={14} className="shrink-0" aria-hidden="true" />
            <span data-testid="storage-quota-text" className="min-w-0 flex-1 truncate">
              {quota
                ? `${formatStorageBytes(quota.usage)} de ${formatStorageBytes(quota.quota)}`
                : 'Espacio usado: no disponible'}
            </span>
          </button>
          {quota && (
            <span
              data-testid="storage-quota-percent"
              className={`shrink-0 text-body-sm font-medium tabular ${
                quota.level === 'critical'
                  ? 'text-danger'
                  : quota.level === 'warning'
                    ? 'text-warning'
                    : 'text-text-2'
              }`}
            >
              {quota.percent} %
            </span>
          )}
        </div>
        <div
          role="progressbar"
          aria-label="Espacio de almacenamiento usado"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={quota ? Math.round(quota.percent) : 0}
          className="mt-1.5 h-1 w-full overflow-hidden rounded bg-raised"
        >
          <div
            data-testid="storage-quota-bar"
            className={`h-full ${
              quota?.level === 'critical'
                ? 'bg-danger'
                : quota?.level === 'warning'
                  ? 'bg-warning'
                  : 'bg-text-3'
            }`}
            style={{ width: `${quota ? Math.min(100, quota.percent) : 0}%` }}
          />
        </div>
        {quota?.message && (
          <p
            data-testid="storage-quota-warning"
            role="alert"
            className={`mt-1.5 rounded border px-1.5 py-1 text-body-sm leading-snug ${
              quota.level === 'critical'
                ? 'border-danger/40 bg-danger/10 text-danger'
                : 'border-warning/40 bg-warning/10 text-warning'
            }`}
          >
            {quota.message}
          </p>
        )}
        {quotaAvailable === false && (
          <p
            data-testid="storage-quota-unavailable"
            className="mt-1.5 text-body-sm leading-snug text-text-3"
          >
            Este navegador no permite consultar el espacio disponible (puede estar en modo privado).
          </p>
        )}

        {showStorage && (
          <div className="mt-2 space-y-2">
            {/* Proyectos, medios y papelera */}
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-body-sm">
              <div className="flex items-center justify-between gap-1">
                <dt className="text-text-3">Proyectos</dt>
                <dd data-testid="storage-projects-count" className="font-semibold text-text-1">
                  {storageSummary.projects}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-1">
                <dt className="text-text-3">Medios</dt>
                <dd data-testid="storage-media-count" className="font-semibold text-text-1">
                  {storageSummary.mediaItems}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-1">
                <dt className="text-text-3">Tamaño</dt>
                <dd data-testid="storage-media-size" className="font-semibold text-text-1">
                  {formatStorageBytes(storageSummary.mediaBytes)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-1">
                <dt className="text-text-3">Papelera</dt>
                <dd data-testid="storage-trash-size" className="font-semibold text-text-1">
                  {storageSummary.trashItems} · {formatStorageBytes(storageSummary.trashBytes)}
                </dd>
              </div>
            </dl>

            {/* Acciones: liberar espacio y copia de seguridad */}
            <Button
              variant={storagePurgeArmed ? 'danger' : 'secondary'}
              size="sm"
              icon={<Trash2 size={14} aria-hidden="true" />}
              onClick={handleStoragePurge}
              disabled={storageSummary.trashItems === 0}
              data-testid="storage-purge-trash"
              className="min-h-[36px] w-full"
              title={
                storagePurgeArmed
                  ? 'Pulsa otra vez para borrar los archivos de la papelera para siempre'
                  : 'Borrar los archivos de la papelera para siempre y liberar espacio'
              }
            >
              {storagePurgeArmed
                ? 'Confirmar: vaciar papelera'
                : `Vaciar papelera${storageSummary.trashItems > 0 ? ` (${storageSummary.trashItems})` : ''}`}
            </Button>

            <Button
              variant="secondary"
              size="sm"
              icon={isBackingUp ? undefined : <Download size={14} aria-hidden="true" />}
              loading={isBackingUp}
              onClick={handleBackup}
              data-testid="storage-backup"
              className="min-h-[36px] w-full"
              title="Crear una copia de seguridad del proyecto con sus archivos multimedia"
            >
              {isBackingUp ? 'Creando copia...' : 'Copia de seguridad (con medios)'}
            </Button>

            {storageMessage && (
              <p
                data-testid="storage-message"
                className="rounded border border-border-subtle bg-raised px-1.5 py-1 text-[10px] leading-tight text-text-2"
              >
                {storageMessage}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Hidden input used to pick the replacement file of a missing media (F3). */}
      <input
        ref={relinkInputRef}
        type="file"
        accept="video/*,audio/*,image/*"
        onChange={handleRelinkFile}
        data-testid="relink-media-input"
        className="hidden"
      />
    </div>
  );
};

/**
 * Default export for `React.lazy` (bundle splitting): the media bin (and its
 * exclusive `sampleMedia` dependency) is loaded on demand instead of being
 * part of the initial chunk. The named exports stay for direct imports and
 * unit tests.
 */
export default MediaBin;
