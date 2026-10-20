import React, { useRef, useState } from 'react';
import { Track } from '../../types/project';
import { isTrackTypeCompatible, useProjectStore } from '../../store/useProjectStore';
import { ClipItem } from './ClipItem';
import { pixelsToTime } from '../../core/utils/time';

interface TrackLaneProps {
  track: Track;
  width: number;
}

export const TrackLane: React.FC<TrackLaneProps> = ({ track, width }) => {
  const allClips = useProjectStore((s) => s.project.clips);
  const mediaPool = useProjectStore((s) => s.project.mediaPool);
  const zoom = useProjectStore((s) => s.zoom);
  const addClipFromMedia = useProjectStore((s) => s.addClipFromMedia);
  const [isDragOver, setIsDragOver] = useState(false);
  /** F1: reason of the last refused drop (it must be visible in the UI). */
  const [refusal, setRefusal] = useState<string | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);

  const clips = allClips.filter((c) => c.trackId === track.id);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!track.isLocked) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (track.isLocked || !laneRef.current) return;

    try {
      const dataStr = e.dataTransfer.getData('application/json');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      if (!data.mediaId) return;

      const media = mediaPool.find((m) => m.id === data.mediaId);
      if (!media) return;

      const rect = laneRef.current.getBoundingClientRect();
      const dropX = e.clientX - rect.left;
      const dropTime = Math.max(0, pixelsToTime(dropX, zoom));

      // B-04 / S-12: never create a clip on a track that cannot render it
      // (e.g. a video dropped on the audio track would never be composited).
      // The store redirects the clip to the first compatible track instead.
      const targetTrackId = isTrackTypeCompatible(track.type, media.type) ? track.id : undefined;

      // F1: the insertion can be refused (overlap policy). The reason is
      // shown in the lane: a silent no-op looks like a broken app.
      const result = addClipFromMedia(media, targetTrackId, dropTime);
      setRefusal(result.ok ? null : result.reason);
    } catch (err) {
      console.warn('Failed to drop media:', err);
    }
  };

  return (
    <div
      ref={laneRef}
      data-track-id={track.id}
      data-track-type={track.type}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ width: `${width}px` }}
      className={`relative h-14 border-b transition select-none ${
        isDragOver
          ? 'border-accent bg-accent-soft'
          : track.isLocked
          ? 'border-border-subtle bg-app opacity-60'
          : 'border-border-subtle bg-panel/60 hover:bg-panel'
      }`}
    >
      {/* Sin rejilla decorativa: el carril es una superficie plana. */}

      {/* Track clips */}
      {clips.map((clip) => (
        <ClipItem key={clip.id} clip={clip} />
      ))}

      {/* F1: the reason of the last refused drop. */}
      {refusal && (
        <div
          data-testid="track-lane-refusal"
          role="alert"
          className="absolute left-2 top-1 z-30 max-w-[70%] text-[10px] leading-tight text-danger bg-danger/15 border border-danger/50 rounded px-1.5 py-1 pointer-events-none"
        >
          {refusal}
        </div>
      )}
    </div>
  );
};
