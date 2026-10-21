import type { Clip, MediaItem, Track } from '../../types/project';
import { applySoloToTracks } from '../engine/AudioEngine';

/**
 * Exportar solo el audio a WAV (sin comprimir).
 *
 * La mezcla la hace `renderOfflineAudio` — EL MISMO render que usa el export
 * de vídeo (`src/core/export/webcodecsExporter.ts`), importado bajo demanda:
 * este módulo no copia ni una línea del render, solo codifica su PCM a un
 * contenedor RIFF/WAVE de 16 bits. Preview ≡ export por construcción: el
 * volumen general y el solo se aplican igual que en el export de vídeo.
 *
 * - `encodeWavData` es pura (probada byte a byte) y no toca el DOM.
 * - `exportAudioWav` mezcla con el solo aplicado y devuelve el `Blob` listo
 *   para descargar (`…_audio.wav`).
 */

/** Bits por muestra del WAV (PCM lineal de 16 bits). */
export const WAV_BITS_POR_MUESTRA = 16;

/** MIME del archivo producido. */
export const WAV_MIME = 'audio/wav';

/** Ritmo de muestreo del render offline (el del exportador de vídeo). */
export const WAV_RITMO_MUESTREO = 48000;

/** Escribe 4 caracteres ASCII en la vista. */
function escribirAscii(vista: DataView, pos: number, texto: string): void {
  for (let i = 0; i < texto.length; i++) {
    vista.setUint8(pos + i, texto.charCodeAt(i));
  }
}

/**
 * Codifica canales PCM flotantes (`-1..1`) a un RIFF/WAVE de 16 bits.
 *
 * - `canales`: un `Float32Array` por canal (el orden se conserva).
 * - `sampleRate`: el ritmo real del búfer (viaja en la cabecera).
 *
 * Las muestras fuera de rango se recortan a `[-1, 1]` antes de cuantizar
 * (positivas ×32767, negativas ×32768, redondeo al entero más cercano).
 * Los canales más cortos se rellenan con silencio.
 */
export function encodeWavData(canales: Float32Array[], sampleRate: number): ArrayBuffer {
  const numCanales = Math.max(1, canales.length);
  const ritmo =
    Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : WAV_RITMO_MUESTREO;
  let muestras = 0;
  for (const canal of canales) {
    if (canal && canal.length > muestras) muestras = canal.length;
  }
  const bytesDatos = muestras * numCanales * 2;
  const buffer = new ArrayBuffer(44 + bytesDatos);
  const vista = new DataView(buffer);

  escribirAscii(vista, 0, 'RIFF');
  vista.setUint32(4, 36 + bytesDatos, true);
  escribirAscii(vista, 8, 'WAVE');
  escribirAscii(vista, 12, 'fmt ');
  vista.setUint32(16, 16, true);
  vista.setUint16(20, 1, true);
  vista.setUint16(22, numCanales, true);
  vista.setUint32(24, ritmo, true);
  vista.setUint32(28, ritmo * numCanales * 2, true);
  vista.setUint16(32, numCanales * 2, true);
  vista.setUint16(34, WAV_BITS_POR_MUESTRA, true);
  escribirAscii(vista, 36, 'data');
  vista.setUint32(40, bytesDatos, true);

  let pos = 44;
  for (let i = 0; i < muestras; i++) {
    for (let ch = 0; ch < numCanales; ch++) {
      const canal = canales[ch];
      const muestra = canal && i < canal.length ? canal[i] : 0;
      const recortada = muestra > 1 ? 1 : muestra < -1 ? -1 : muestra;
      const entera = Math.round(recortada < 0 ? recortada * 32768 : recortada * 32767);
      vista.setInt16(pos, entera, true);
      pos += 2;
    }
  }
  return buffer;
}

/**
 * Tamaño estimado (bytes) del WAV para una duración: ritmo × canales × 2 B.
 * El modal lo muestra antes de exportar (orientativo; el real sale del blob).
 */
export function estimateWavBytes(
  durationSeconds: number,
  sampleRate: number = WAV_RITMO_MUESTREO,
  channels: number = 2
): number {
  const duracion = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  return Math.ceil(duracion * sampleRate) * Math.max(1, Math.round(channels)) * 2;
}

/**
 * Nombre del archivo de audio: la base del proyecto en minúsculas más el
 * sufijo `_audio.wav`. `rango` añade el sufijo del rango exportado delante
 * (`mi_proyecto_1-2_audio.wav`), como el vídeo.
 */
export function buildWavFileName(projectName: string, rango: string = ''): string {
  const crudo = typeof projectName === 'string' ? projectName : '';
  const base = crudo.toLowerCase().replace(/\s+/g, '_') || 'proyecto';
  const sufijo = typeof rango === 'string' ? rango : '';
  return `${base}${sufijo}_audio.wav`;
}

/** Parámetros de `exportAudioWav` (los mismos que el export de vídeo). */
export interface ExportAudioWavParams {
  /** Duración a renderizar (segundos). */
  duration: number;
  tracks: Track[];
  clips: Clip[];
  mediaPool: MediaItem[];
  /** Volumen general 0..1 (por defecto el persistido, como el vídeo). */
  masterVolume?: number;
  signal?: AbortSignal;
}

/**
 * Renderiza TODA la mezcla de audio a un WAV de 16 bits.
 *
 * - El solo se aplica ANTES de mezclar (`applySoloToTracks`: las pistas no
 *   solo llegan enmudecidas al render, la misma decisión del preview).
 * - El volumen general multiplica la mezcla (como el export de vídeo).
 * - El render y su presupuesto de memoria son los del exportador de vídeo
 *   (cargado bajo demanda: este chunk no trae `mp4-muxer`).
 *
 * Lanza un error en español cuando no hay nada que mezclar (el modal lo
 * muestra en su estado de error).
 */
export async function exportAudioWav(params: ExportAudioWavParams): Promise<Blob> {
  const { duration, tracks, clips, mediaPool, masterVolume, signal } = params;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('No hay nada que exportar. Añade un clip a la línea de tiempo.');
  }

  const { renderOfflineAudio, resolveExportMasterVolume } = await import('./webcodecsExporter');
  const pistasEfectivas = applySoloToTracks(tracks);
  const master = resolveExportMasterVolume(masterVolume);
  const mezclado = await renderOfflineAudio(
    duration,
    pistasEfectivas,
    clips,
    mediaPool,
    signal,
    master
  );
  if (!mezclado) {
    throw new Error('No hay audio que exportar: la mezcla está vacía o silenciada.');
  }

  const canales: Float32Array[] = [];
  for (let ch = 0; ch < mezclado.numberOfChannels; ch++) {
    canales.push(mezclado.getChannelData(ch));
  }
  return new Blob([encodeWavData(canales, mezclado.sampleRate)], { type: WAV_MIME });
}
