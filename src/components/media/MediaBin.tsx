import React, { useRef, useState } from 'react';
import { UploadCloud, Sparkles, FolderOpen, Film, AlertCircle, Loader2, X } from 'lucide-react';
import { MediaItem, MediaType } from '../../types/project';
import { useProjectStore } from '../../store/useProjectStore';
import { generateVideoThumbnail, createPlaceholderThumbnail, generateFilmstrip, generatePlaceholderFilmstrip } from '../../core/utils/thumbnails';
import { extractWaveformPeaksFromBlob, generateSyntheticWaveform } from '../../core/utils/waveform';
import { saveMediaToOPFS } from '../../core/storage/opfsStorage';
import { createPresetMediaItems } from '../../core/utils/sampleMedia';
import { MediaItemCard } from './MediaItemCard';

export const MediaBin: React.FC = () => {
  const mediaPool = useProjectStore((s) => s.project.mediaPool);
  const addMediaItem = useProjectStore((s) => s.addMediaItem);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isGeneratingSamples, setIsGeneratingSamples] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = async (file: File) => {
    let type: MediaType = 'video';
    if (file.type.startsWith('audio/')) type = 'audio';
    else if (file.type.startsWith('image/')) type = 'image';
    else if (!file.type.startsWith('video/')) return;

    const mediaId = 'media_' + Math.random().toString(36).substring(2, 9);
    const objectUrl = URL.createObjectURL(file);

    let opfsPath: string | undefined;
    try {
      opfsPath = await saveMediaToOPFS(mediaId, file);
    } catch (err) {
      console.warn('OPFS storage note:', err);
    }

    let duration = 5;
    let width = 1280;
    let height = 720;
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
        width = video.videoWidth || 1280;
        height = video.videoHeight || 720;
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
    </div>
  );
};
