import React, { useRef, useState } from 'react';
import { Track } from '../../types/project';
import { useProjectStore } from '../../store/useProjectStore';
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

      addClipFromMedia(media, track.id, dropTime);
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
      className={`relative h-14 border-b border-dark-800 transition ${
        isDragOver
          ? 'bg-blue-950/30'
          : track.isLocked
          ? 'bg-dark-950/60 opacity-60'
          : 'bg-dark-900/60 hover:bg-dark-900/90'
      } select-none`}
    >
      {/* Background guide lines */}
      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(to_right,#1f2229_1px,transparent_1px)] bg-[size:100px_100%]" />

      {/* Track clips */}
      {clips.map((clip) => (
        <ClipItem key={clip.id} clip={clip} />
      ))}
    </div>
  );
};
