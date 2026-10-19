import React, { useRef, useState } from 'react';
import {
  UploadCloud,
  Sparkles,
  FolderOpen,
  Film,
  AlertCircle,
  Loader2,
  X,
  Trash2,
  Link2,
  RotateCcw,
} from 'lucide-react';
import { MediaItem, MediaType } from '../../types/project';
import { useProjectStore } from '../../store/useProjectStore';
import { generateVideoThumbnail, createPlaceholderThumbnail, generateFilmstrip, generatePlaceholderFilmstrip } from '../../core/utils/thumbnails';
import { extractWaveformPeaksFromBlob, generateSyntheticWaveform } from '../../core/utils/waveform';
import { saveMediaToOPFS } from '../../core/storage/opfsStorage';
import { createPresetMediaItems } from '../../core/utils/sampleMedia';
import { MediaItemCard } from './MediaItemCard';

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

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Hidden input used to pick the replacement file of a missing media (F3). */
  const relinkInputRef = useRef<HTMLInputElement>(null);
  /** Media id whose replacement file is being picked (F3). */
  const relinkTargetRef = useRef<string | null>(null);

  const missingMedia = mediaPool.filter((m) => m.status === 'missing' || m.status === 'error');

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
        `No se pudo revincular el archivo: revisa que sea un archivo de vídeo, audio o imagen válido.`
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

  return (
    <div className="flex flex-col h-full bg-dark-900 border-r border-dark-800 p-3 overflow-hidden select-none">
      {/* Header of Media Bin */}
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-dark-800">
        <div className="flex items-center gap-2 text-slate-200 font-semibold text-sm">
          <Film size={16} className="text-blue-400" />
          <span>Panel de Medios</span>
          <span className="text-xs text-slate-500 font-normal">({mediaPool.length})</span>
        </div>

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isProcessing}
          className="flex items-center gap-1.5 px-2.5 py-1 bg-dark-800 hover:bg-dark-750 text-slate-200 text-xs rounded border border-dark-700 transition"
        >
          <FolderOpen size={13} />
          <span>Importar</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
        />
      </div>

      {/* Instant Demo Generator Button */}
      <button
        onClick={handleGenerateSampleClips}
        disabled={isGeneratingSamples}
        className="mb-3 w-full flex items-center justify-center gap-2 py-2 px-3 bg-gradient-to-r from-blue-900/40 to-indigo-900/40 hover:from-blue-900/60 hover:to-indigo-900/60 border border-blue-500/30 rounded-lg text-blue-300 text-xs font-medium transition active:scale-98 shadow-sm"
      >
        {isGeneratingSamples ? (
          <>
            <Loader2 size={14} className="animate-spin text-blue-400" />
            <span>Generando clips de muestra en el navegador...</span>
          </>
        ) : (
          <>
            <Sparkles size={14} className="text-blue-400" />
            <span>Generar Clips de Prueba (1-Click)</span>
          </>
        )}
      </button>

      {/* Error alert */}
      {errorMessage && (
        <div role="alert" className="mb-2 p-2 bg-red-900/30 border border-red-700/50 rounded text-red-300 text-xs flex items-center gap-2">
          <AlertCircle size={14} />
          <span className="flex-1">{errorMessage}</span>
          <button
            onClick={() => setErrorMessage(null)}
            className="p-1 hover:bg-red-900/50 rounded transition"
            aria-label="Descartar error"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Drop Area & Media List */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex-1 overflow-y-auto rounded-lg transition border ${
          isDragging
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-dashed border-dark-750 hover:border-dark-700 bg-dark-950/50'
        } p-2`}
      >
        {isProcessing && (
          <div className="flex flex-col items-center justify-center py-6 text-slate-400 gap-2">
            <Loader2 size={24} className="animate-spin text-blue-500" />
            <span className="text-xs">Importando y extrayendo fotogramas...</span>
          </div>
        )}

        {mediaPool.length === 0 && !isProcessing ? (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex flex-col items-center justify-center h-full text-center p-4 text-slate-500 hover:text-slate-300 hover:border-blue-500/40 rounded-lg transition focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
          >
            <UploadCloud size={32} className="mb-2 text-slate-600 stroke-1" />
            <p className="text-xs font-medium text-slate-400">Arrastra videos, audios o fotos aquí</p>
            <p className="text-xs text-blue-400 font-semibold mt-1.5 underline underline-offset-2">o haz clic para importar</p>
            <p className="text-[11px] text-slate-600 mt-1">100% privado en tu navegador (OPFS local)</p>
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {mediaPool.map((item) => (
              <MediaItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>

      {/* F3 — Medios ausentes: the files are gone, the user can relink them. */}
      {missingMedia.length > 0 && (
        <div
          data-testid="missing-media-panel"
          className="mt-2 p-2 rounded-lg border border-rose-800/50 bg-rose-950/30"
        >
          <button
            onClick={() => setShowMissing((v) => !v)}
            className="w-full flex items-center gap-1.5 text-rose-200 text-[11px] font-semibold uppercase tracking-wider"
            aria-expanded={showMissing}
          >
            <Link2 size={12} />
            <span>Medios ausentes ({missingMedia.length})</span>
          </button>
          {showMissing && (
            <ul className="mt-1.5 space-y-1 max-h-32 overflow-y-auto">
              {missingMedia.map((item) => (
                <li
                  key={item.id}
                  data-testid={`missing-media-${item.id}`}
                  className="flex items-center gap-1.5 text-[11px] text-rose-100"
                >
                  <AlertCircle size={11} className="shrink-0" />
                  <span className="truncate flex-1" title={item.name}>
                    {item.name}
                  </span>
                  <button
                    onClick={() => handleRelinkClick(item.id)}
                    data-testid={`relink-media-${item.id}`}
                    className="shrink-0 px-1.5 py-0.5 rounded border border-rose-600/60 bg-rose-900/50 hover:bg-rose-800/60 text-rose-100 text-[10px] font-semibold flex items-center gap-1"
                    title={`Revincular ${item.name} con un archivo local`}
                    aria-label={`Revincular ${item.name}`}
                  >
                    <Link2 size={10} />
                    <span>Revincular</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* F2 — Papelera: the removed media can be restored or purged. */}
      {trash.length > 0 && (
        <div
          data-testid="trash-panel"
          className="mt-2 p-2 rounded-lg border border-dark-700 bg-dark-950/60"
        >
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowTrash((v) => !v)}
              className="flex-1 flex items-center gap-1.5 text-slate-300 text-[11px] font-semibold uppercase tracking-wider"
              aria-expanded={showTrash}
            >
              <Trash2 size={12} />
              <span>Papelera ({trash.length})</span>
            </button>
            <button
              onClick={handlePurgeTrash}
              data-testid="purge-trash"
              className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
                purgeArmed
                  ? 'bg-red-600 text-white border-red-500'
                  : 'border-dark-600 text-slate-400 hover:text-slate-200'
              }`}
              title={
                purgeArmed
                  ? 'Pulsa otra vez para borrar los archivos para siempre'
                  : 'Borrar los archivos de la papelera para siempre'
              }
            >
              {purgeArmed ? 'Confirmar' : 'Vaciar'}
            </button>
          </div>
          {showTrash && (
            <ul className="mt-1.5 space-y-1 max-h-32 overflow-y-auto">
              {trash.map((entry) => (
                <li
                  key={entry.media.id}
                  data-testid={`trash-entry-${entry.media.id}`}
                  className="flex items-center gap-1.5 text-[11px] text-slate-300"
                >
                  <span className="truncate flex-1" title={entry.media.name}>
                    {entry.media.name}
                  </span>
                  <span className="text-[10px] text-slate-500 shrink-0">
                    {entry.clips.length} clip(s)
                  </span>
                  <button
                    onClick={() => restoreFromTrash(entry.media.id)}
                    data-testid={`restore-media-${entry.media.id}`}
                    className="shrink-0 px-1.5 py-0.5 rounded border border-emerald-600/50 bg-emerald-900/40 hover:bg-emerald-800/50 text-emerald-200 text-[10px] font-semibold flex items-center gap-1"
                    title={`Restaurar ${entry.media.name} y sus clips`}
                    aria-label={`Restaurar ${entry.media.name}`}
                  >
                    <RotateCcw size={10} />
                    <span>Restaurar</span>
                  </button>
                  <button
                    onClick={() => purgeTrashedMedia(entry.media.id)}
                    data-testid={`purge-media-${entry.media.id}`}
                    className="shrink-0 p-1 rounded border border-red-800/60 bg-red-950/40 hover:bg-red-900/50 text-red-300"
                    title={`Borrar ${entry.media.name} para siempre`}
                    aria-label={`Borrar ${entry.media.name} para siempre`}
                  >
                    <Trash2 size={10} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

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
