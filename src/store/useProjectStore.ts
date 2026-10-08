import { create } from 'zustand';
import { AspectRatio, Clip, MediaItem, Project, Track, TrackType } from '../types/project';
import { autosaveProject } from '../core/storage/projectStorage';
import { calculateSnapping } from '../core/utils/math';
import { mediaSourcePool } from '../core/engine/MediaSourcePool';

export interface HistoryState {
  tracks: Track[];
  clips: Clip[];
}

export interface ProjectState {
  project: Project;
  selectedClipId: string | null;
  currentTime: number;
  isPlaying: boolean;
  zoom: number; // Pixels per second
  snapEnabled: boolean;
  snappingGuideTime: number | null;
  past: HistoryState[];
  future: HistoryState[];

  // Actions
  setProject: (project: Project) => void;
  setProjectName: (name: string) => void;
  setAspectRatio: (ratio: AspectRatio) => void;
  setCurrentTime: (time: number) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setZoom: (zoom: number) => void;
  toggleSnap: () => void;
  setSnappingGuideTime: (time: number | null) => void;
  selectClip: (clipId: string | null) => void;

  // Media
  addMediaItem: (item: MediaItem) => void;
  removeMediaItem: (mediaId: string) => void;

  // Tracks
  addTrack: (type: TrackType, name?: string) => void;
  removeTrack: (trackId: string) => void;
  deleteTrack: (trackId: string) => void;
  duplicateTrack: (trackId: string) => void;
  reorderTrack: (trackId: string, direction: 'up' | 'down') => void;
  moveTrack: (trackId: string, direction: 'up' | 'down') => void;
  toggleTrackMute: (trackId: string) => void;
  toggleTrackLock: (trackId: string) => void;
  toggleTrackVisibility: (trackId: string) => void;

  // Clips
  addClip: (clip: Clip) => void;
  addClipFromMedia: (media: MediaItem, trackId?: string, startTime?: number) => void;
  addTextClip: (text?: string, startTime?: number) => void;
  updateClip: (clipId: string, updates: Partial<Clip>) => void;
  removeClip: (clipId: string) => void;
  moveClip: (clipId: string, newStart: number, newTrackId?: string) => void;
  commitClipChange: () => void;
  trimClipStart: (clipId: string, newStart: number) => void;
  trimClipEnd: (clipId: string, newEnd: number) => void;
  splitClip: (clipId: string, splitTime?: number) => void;
  splitAtPlayhead: () => void;
  deleteSelectedClip: () => void;

  // Undo / Redo
  undo: () => void;
  redo: () => void;
  pushHistory: () => void;
  // Gesture-scoped history: call once when a drag/trim gesture starts;
  // commitClipChange() closes the gesture without pushing.
  historyGesturePending: boolean;
  beginClipGesture: () => void;

  // Project persistence
  recalculateDuration: () => void;
  resetProject: () => void;
  loadProject: (project: Project) => void;
}

const DEFAULT_TRACKS: Track[] = [
  { id: 'track_text_1', name: 'Texto T1', type: 'text', isMuted: false, isLocked: false, isVisible: true },
  { id: 'track_video_2', name: 'Video V2 (Superposición)', type: 'video', isMuted: false, isLocked: false, isVisible: true },
  { id: 'track_video_1', name: 'Video V1 (Principal)', type: 'video', isMuted: false, isLocked: false, isVisible: true },
  { id: 'track_audio_1', name: 'Audio A1', type: 'audio', isMuted: false, isLocked: false, isVisible: true },
];

const INITIAL_PROJECT: Project = {
  id: 'proj_' + Math.random().toString(36).substring(2, 9),
  name: 'Mi Proyecto de Video',
  aspectRatio: '16:9',
  resolution: { width: 1920, height: 1080 },
  fps: 30,
  tracks: DEFAULT_TRACKS,
  clips: [],
  mediaPool: [],
  duration: 30,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: INITIAL_PROJECT,
  selectedClipId: null,
  currentTime: 0,
  isPlaying: false,
  zoom: 60, // 60 px per second default
  snapEnabled: true,
  snappingGuideTime: null,
  past: [],
  future: [],
  historyGesturePending: false,

  beginClipGesture: () => {
    if (get().historyGesturePending) return;
    get().pushHistory();
    set({ historyGesturePending: true });
  },
  setProject: (project) => {
    set({ project });
    autosaveProject(project);
  },

  setProjectName: (name) => {
    set((state) => {
      const updated = { ...state.project, name, updatedAt: Date.now() };
      autosaveProject(updated);
      return { project: updated };
    });
  },

  setAspectRatio: (aspectRatio) => {
    set((state) => {
      let width = 1920;
      let height = 1080;
      if (aspectRatio === '9:16') {
        width = 1080;
        height = 1920;
      } else if (aspectRatio === '1:1') {
        width = 1080;
        height = 1080;
      }
      const updated: Project = {
        ...state.project,
        aspectRatio,
        resolution: { width, height },
        updatedAt: Date.now(),
      };
      autosaveProject(updated);
      return { project: updated };
    });
  },

  setCurrentTime: (currentTime) => set({ currentTime: Math.max(0, currentTime) }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setZoom: (zoom) => set({ zoom: Math.max(10, Math.min(250, zoom)) }),
  toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),
  setSnappingGuideTime: (snappingGuideTime) => set({ snappingGuideTime }),
  selectClip: (selectedClipId) => set({ selectedClipId }),

  pushHistory: () => {
    const { project, past } = get();
    const currentSnap: HistoryState = {
      tracks: JSON.parse(JSON.stringify(project.tracks)),
      clips: JSON.parse(JSON.stringify(project.clips)),
    };
    const newPast = [...past, currentSnap];
    if (newPast.length > 30) newPast.shift();
    set({ past: newPast, future: [] });
  },

  undo: () => {
    const { past, future, project } = get();
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    const newPast = past.slice(0, past.length - 1);
    const currentSnap: HistoryState = {
      tracks: JSON.parse(JSON.stringify(project.tracks)),
      clips: JSON.parse(JSON.stringify(project.clips)),
    };
    const updated: Project = {
      ...project,
      tracks: JSON.parse(JSON.stringify(previous.tracks)),
      clips: JSON.parse(JSON.stringify(previous.clips)),
      updatedAt: Date.now(),
    };
    set({ project: updated, past: newPast, future: [currentSnap, ...future], selectedClipId: null, historyGesturePending: false });
    get().recalculateDuration();
    autosaveProject(updated);
  },

  redo: () => {
    const { past, future, project } = get();
    if (future.length === 0) return;
    const next = future[0];
    const newFuture = future.slice(1);
    const currentSnap: HistoryState = {
      tracks: JSON.parse(JSON.stringify(project.tracks)),
      clips: JSON.parse(JSON.stringify(project.clips)),
    };
    const updated: Project = {
      ...project,
      tracks: JSON.parse(JSON.stringify(next.tracks)),
      clips: JSON.parse(JSON.stringify(next.clips)),
      updatedAt: Date.now(),
    };
    set({ project: updated, past: [...past, currentSnap], future: newFuture, historyGesturePending: false });
    get().recalculateDuration();
    autosaveProject(updated);
  },

  addMediaItem: (item) => {
    set((state) => {
      const updatedPool = [...state.project.mediaPool, item];
      const updated: Project = {
        ...state.project,
        mediaPool: updatedPool,
        updatedAt: Date.now(),
      };
      autosaveProject(updated);
      return { project: updated };
    });
  },

  removeMediaItem: (mediaId) => {
    get().pushHistory();
    set((state) => {
      const updatedPool = state.project.mediaPool.filter((m) => m.id !== mediaId);
      const updatedClips = state.project.clips.filter((c) => c.mediaId !== mediaId);
      const updated: Project = {
        ...state.project,
        mediaPool: updatedPool,
        clips: updatedClips,
        updatedAt: Date.now(),
      };
      autosaveProject(updated);
      return { project: updated };
    });
    get().recalculateDuration();
  },

  addTrack: (type, name) => {
    get().pushHistory();
    set((state) => {
      const index = state.project.tracks.filter((t) => t.type === type).length + 1;
      const trackName = name || `${type === 'video' ? 'Video' : type === 'audio' ? 'Audio' : 'Texto'} ${index}`;
      const newTrack: Track = {
        id: `track_${type}_${Date.now()}`,
        name: trackName,
        type,
        isMuted: false,
        isLocked: false,
        isVisible: true,
      };
      // Keep text tracks at the top, video tracks in the middle, and audio tracks at the bottom
      let newTracks = [...state.project.tracks];
      if (type === 'text') {
        newTracks.unshift(newTrack);
      } else if (type === 'video') {
        const firstAudioIdx = newTracks.findIndex((t) => t.type === 'audio');
        if (firstAudioIdx !== -1) {
          newTracks.splice(firstAudioIdx, 0, newTrack);
        } else {
          newTracks.push(newTrack);
        }
      } else {
        newTracks.push(newTrack);
      }
      const updated: Project = {
        ...state.project,
        tracks: newTracks,
        updatedAt: Date.now(),
      };
      autosaveProject(updated);
      return { project: updated };
    });
  },

  removeTrack: (trackId) => {
    get().pushHistory();
    set((state) => {
      const updatedTracks = state.project.tracks.filter((t) => t.id !== trackId);
      const updatedClips = state.project.clips.filter((c) => c.trackId !== trackId);
      const updated: Project = {
        ...state.project,
        tracks: updatedTracks,
        clips: updatedClips,
        updatedAt: Date.now(),
      };
      autosaveProject(updated);
      return { project: updated, selectedClipId: null };
    });
    get().recalculateDuration();
  },

  deleteTrack: (trackId) => {
    get().removeTrack(trackId);
  },

  duplicateTrack: (trackId) => {
    get().pushHistory();
    set((state) => {
      const sourceTrack = state.project.tracks.find((t) => t.id === trackId);
      if (!sourceTrack) return state;

      const trackIdx = state.project.tracks.findIndex((t) => t.id === trackId);
      const newTrackId = `track_${sourceTrack.type}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const newTrack: Track = {
        ...sourceTrack,
        id: newTrackId,
        name: `${sourceTrack.name} (Copia)`,
      };

      const newTracks = [...state.project.tracks];
      newTracks.splice(trackIdx + 1, 0, newTrack);

      const sourceClips = state.project.clips.filter((c) => c.trackId === trackId);
      const duplicatedClips: Clip[] = sourceClips.map((c) => ({
        ...JSON.parse(JSON.stringify(c)),
        id: `clip_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        trackId: newTrackId,
      }));

      const updated: Project = {
        ...state.project,
        tracks: newTracks,
        clips: [...state.project.clips, ...duplicatedClips],
        updatedAt: Date.now(),
      };
      autosaveProject(updated);
      return { project: updated };
    });
    get().recalculateDuration();
  },

  reorderTrack: (trackId, direction) => {
    const { project } = get();
    const currentIndex = project.tracks.findIndex((t) => t.id === trackId);
    if (currentIndex === -1) return;

    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= project.tracks.length) return;

    get().pushHistory();
    set((state) => {
      const tracks = [...state.project.tracks];
      const [movedTrack] = tracks.splice(currentIndex, 1);
      tracks.splice(targetIndex, 0, movedTrack);

      const updated: Project = {
        ...state.project,
        tracks,
        updatedAt: Date.now(),
      };
      autosaveProject(updated);
      return { project: updated };
    });
  },

  moveTrack: (trackId, direction) => {
    get().reorderTrack(trackId, direction);
  },

  toggleTrackMute: (trackId) => {
    set((state) => {
      const updatedTracks = state.project.tracks.map((t) =>
        t.id === trackId ? { ...t, isMuted: !t.isMuted } : t
      );
      const updated = { ...state.project, tracks: updatedTracks, updatedAt: Date.now() };
      autosaveProject(updated);
      return { project: updated };
    });
  },

  toggleTrackLock: (trackId) => {
    set((state) => {
      const updatedTracks = state.project.tracks.map((t) =>
        t.id === trackId ? { ...t, isLocked: !t.isLocked } : t
      );
      const updated = { ...state.project, tracks: updatedTracks, updatedAt: Date.now() };
      autosaveProject(updated);
      return { project: updated };
    });
  },

  toggleTrackVisibility: (trackId) => {
    set((state) => {
      const updatedTracks = state.project.tracks.map((t) =>
        t.id === trackId ? { ...t, isVisible: !t.isVisible } : t
      );
      const updated = { ...state.project, tracks: updatedTracks, updatedAt: Date.now() };
      autosaveProject(updated);
      return { project: updated };
    });
  },

  addClip: (clip) => {
    get().pushHistory();
    set((state) => {
      const updatedClips = [...state.project.clips, clip];
      const updated = { ...state.project, clips: updatedClips, updatedAt: Date.now() };
      autosaveProject(updated);
      return { project: updated, selectedClipId: clip.id };
    });
    get().recalculateDuration();
  },

  addClipFromMedia: (media, targetTrackId, startTime) => {
    const { project, currentTime } = get();
    // Find compatible track
    let track = targetTrackId ? project.tracks.find((t) => t.id === targetTrackId) : null;
    if (!track) {
      if (media.type === 'audio') {
        track = project.tracks.find((t) => t.type === 'audio');
      } else {
        track = project.tracks.find((t) => t.type === 'video');
      }
    }

    if (!track) return;

    const startPos = startTime !== undefined ? startTime : currentTime;
    const duration = media.duration > 0 ? media.duration : 5;

    const newClip: Clip = {
      id: 'clip_' + Math.random().toString(36).substring(2, 9),
      trackId: track.id,
      mediaId: media.id,
      name: media.name,
      type: media.type,
      start: Math.max(0, startPos),
      duration: duration,
      sourceStart: 0,
      sourceDuration: duration,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };

    get().addClip(newClip);
  },

  addTextClip: (text = 'Título Nuevo', startTime) => {
    const { project, currentTime } = get();
    let textTrack = project.tracks.find((t) => t.type === 'text');
    if (!textTrack) {
      get().addTrack('text', 'Pista de Texto');
      textTrack = get().project.tracks.find((t) => t.type === 'text');
    }
    if (!textTrack) return;

    const startPos = startTime !== undefined ? startTime : currentTime;

    const newClip: Clip = {
      id: 'clip_text_' + Math.random().toString(36).substring(2, 9),
      trackId: textTrack.id,
      mediaId: '',
      name: text,
      type: 'text',
      start: Math.max(0, startPos),
      duration: 5,
      sourceStart: 0,
      sourceDuration: 5,
      volume: 0,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: true,
      text: text,
      textStyle: {
        fontSize: 48,
        color: '#ffffff',
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        fontFamily: 'Inter, sans-serif',
        textAlign: 'center',
        fontWeight: 'bold',
        padding: 16,
        borderRadius: 8,
      },
    };

    get().addClip(newClip);
  },

  updateClip: (clipId, updates) => {
    set((state) => {
      const updatedClips = state.project.clips.map((c) =>
        c.id === clipId ? { ...c, ...updates } : c
      );
      const updated = { ...state.project, clips: updatedClips, updatedAt: Date.now() };
      autosaveProject(updated);
      return { project: updated };
    });
    get().recalculateDuration();
  },

  removeClip: (clipId) => {
    const clip = get().project.clips.find((c) => c.id === clipId);
    if (clip && get().project.tracks.find((t) => t.id === clip.trackId)?.isLocked) return;
    get().pushHistory();
    mediaSourcePool.releaseClip(clipId);
    set((state) => {
      const updatedClips = state.project.clips.filter((c) => c.id !== clipId);
      const updated = { ...state.project, clips: updatedClips, updatedAt: Date.now() };
      autosaveProject(updated);
      return {
        project: updated,
        selectedClipId: state.selectedClipId === clipId ? null : state.selectedClipId,
      };
    });
    get().recalculateDuration();
  },

  moveClip: (clipId, newStart, newTrackId) => {
    const { project, snapEnabled, currentTime, zoom } = get();
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) return;

    // Locked source track: positional edits are frozen entirely.
    const sourceTrack = project.tracks.find((t) => t.id === clip.trackId);
    if (sourceTrack?.isLocked) return;

    // Locked-track guard: never move a clip onto a locked track.
    // Keep the clip on its current track and only apply the time change.
    let effectiveTrackId = newTrackId || clip.trackId;
    if (newTrackId && newTrackId !== clip.trackId) {
      const target = project.tracks.find((t) => t.id === newTrackId);
      if (!target || target.isLocked) {
        effectiveTrackId = clip.trackId;
      }
    }

    // Calculate snapping with both start AND end:
    const snap = calculateSnapping(
      newStart,
      project.clips,
      clipId,
      currentTime,
      zoom,
      12,
      snapEnabled,
      clip.duration
    );

    const finalStart = Math.max(0, snap.snappedTime);
    const snapGuide = snap.didSnap && snap.snapTargetTime !== undefined ? snap.snapTargetTime : null;

    set((state) => {
      const updatedClips = state.project.clips.map((c) => {
        if (c.id === clipId) {
          return {
            ...c,
            start: finalStart,
            trackId: effectiveTrackId,
          };
        }
        return c;
      });
      const updated = { ...state.project, clips: updatedClips, updatedAt: Date.now() };
      return { project: updated, snappingGuideTime: snapGuide };
    });
  },

  commitClipChange: () => {
    get().recalculateDuration();
    autosaveProject(get().project);
    set({ snappingGuideTime: null, historyGesturePending: false });
  },

  trimClipStart: (clipId, newStart) => {
    const { project, snapEnabled, currentTime, zoom } = get();
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) return;
    if (project.tracks.find((t) => t.id === clip.trackId)?.isLocked) return;

    const snap = calculateSnapping(
      newStart,
      project.clips,
      clipId,
      currentTime,
      zoom,
      12,
      snapEnabled
    );
    const targetStart = Math.max(0, snap.snappedTime);
    const snapGuide = snap.didSnap && snap.snapTargetTime !== undefined ? snap.snapTargetTime : null;

    // End point remains unchanged
    const originalEnd = clip.start + clip.duration;
    if (targetStart >= originalEnd - 0.1) return; // Min 0.1s

    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    // Bound how far we can trim to the left: cannot go past source media start (sourceStart = 0)
    const maxDeltaLeft = -clip.sourceStart / speed;
    const minAllowedStart = Math.max(0, clip.start + maxDeltaLeft);
    const effectiveStart = Math.max(minAllowedStart, targetStart);

    if (effectiveStart >= originalEnd - 0.1) return;

    const delta = effectiveStart - clip.start;
    const newSourceStart = Math.max(0, clip.sourceStart + delta * speed);
    const newDuration = originalEnd - effectiveStart;

    set((state) => {
      const updatedClips = state.project.clips.map((c) =>
        c.id === clipId
          ? { ...c, start: effectiveStart, duration: newDuration, sourceStart: newSourceStart }
          : c
      );
      return { project: { ...state.project, clips: updatedClips }, snappingGuideTime: snapGuide };
    });
  },

  trimClipEnd: (clipId, newEnd) => {
    const { project, snapEnabled, currentTime, zoom } = get();
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) return;
    if (project.tracks.find((t) => t.id === clip.trackId)?.isLocked) return;

    const snap = calculateSnapping(
      newEnd,
      project.clips,
      clipId,
      currentTime,
      zoom,
      12,
      snapEnabled
    );
    const targetEnd = snap.snappedTime;
    const snapGuide = snap.didSnap && snap.snapTargetTime !== undefined ? snap.snapTargetTime : null;

    if (targetEnd <= clip.start + 0.1) return; // Min 0.1s

    let newDuration = targetEnd - clip.start;
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const maxDuration = (clip.sourceDuration - clip.sourceStart) / speed;
    if (newDuration > maxDuration && clip.type !== 'text') {
      newDuration = maxDuration;
    }

    set((state) => {
      const updatedClips = state.project.clips.map((c) =>
        c.id === clipId ? { ...c, duration: newDuration } : c
      );
      return { project: { ...state.project, clips: updatedClips }, snappingGuideTime: snapGuide };
    });
  },

  splitClip: (clipId, splitTime) => {
    const { project, currentTime } = get();
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) return;
    if (project.tracks.find((t) => t.id === clip.trackId)?.isLocked) return;

    const cutPoint = splitTime !== undefined ? splitTime : currentTime;
    const clipEnd = clip.start + clip.duration;

    // Check if cut point is inside clip with at least 0.05s buffer on each side
    if (cutPoint <= clip.start + 0.05 || cutPoint >= clipEnd - 0.05) {
      return;
    }

    get().pushHistory();

    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const firstDuration = cutPoint - clip.start;
    const secondDuration = clipEnd - cutPoint;
    const secondSourceStart = clip.sourceStart + firstDuration * speed;

    // Seamless transition splitting: clip 1 preserves In fade, clip 2 preserves Out fade
    const clip1Transition = clip.transition
      ? {
          ...clip.transition,
          fadeOutType: 'none' as const,
          fadeOutDuration: 0,
        }
      : undefined;

    const clip2Transition = clip.transition
      ? {
          ...clip.transition,
          fadeInType: 'none' as const,
          fadeInDuration: 0,
        }
      : undefined;

    // Modify original clip as first part
    const updatedClip1: Clip = {
      ...clip,
      duration: firstDuration,
      transition: clip1Transition,
    };

    // Create second clip
    const clip2Id = 'clip_' + Math.random().toString(36).substring(2, 9);
    const updatedClip2: Clip = {
      ...clip,
      id: clip2Id,
      name: `${clip.name} (parte 2)`,
      start: cutPoint,
      duration: secondDuration,
      sourceStart: secondSourceStart,
      transition: clip2Transition,
    };

    set((state) => {
      const updatedClips = state.project.clips.map((c) => (c.id === clipId ? updatedClip1 : c));
      updatedClips.push(updatedClip2);
      const updated = { ...state.project, clips: updatedClips, updatedAt: Date.now() };
      autosaveProject(updated);
      return { project: updated, selectedClipId: clip2Id };
    });
    get().recalculateDuration();
  },

  splitAtPlayhead: () => {
    const { project, currentTime, selectedClipId } = get();
    // 1. If a clip is selected and playhead is inside it, split that clip
    if (selectedClipId) {
      const sel = project.clips.find((c) => c.id === selectedClipId);
      if (sel && currentTime > sel.start + 0.05 && currentTime < sel.start + sel.duration - 0.05) {
        get().splitClip(selectedClipId, currentTime);
        return;
      }
    }

    // 2. Otherwise split the first unmuted/unlocked clip under playhead
    const targetClip = project.clips.find(
      (c) => currentTime > c.start + 0.05 && currentTime < c.start + c.duration - 0.05
    );
    if (targetClip) {
      get().splitClip(targetClip.id, currentTime);
    }
  },

  deleteSelectedClip: () => {
    const { selectedClipId } = get();
    if (selectedClipId) {
      get().removeClip(selectedClipId);
    }
  },

  recalculateDuration: () => {
    set((state) => {
      let maxEnd = 15; // Minimum 15 seconds
      for (const c of state.project.clips) {
        const end = c.start + c.duration;
        if (end > maxEnd) maxEnd = end;
      }
      // Add 5 seconds breathing room
      const totalDuration = Math.ceil(maxEnd + 5);
      if (state.project.duration === totalDuration) return {};
      const updated = { ...state.project, duration: totalDuration };
      return { project: updated };
    });
  },

  resetProject: () => {
    set({
      project: {
        ...INITIAL_PROJECT,
        id: 'proj_' + Math.random().toString(36).substring(2, 9),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      selectedClipId: null,
      currentTime: 0,
      isPlaying: false,
      past: [],
      future: [],
      historyGesturePending: false,
    });
    autosaveProject(get().project);
  },

  loadProject: (loadedProject) => {
    set({
      project: loadedProject,
      selectedClipId: null,
      currentTime: 0,
      isPlaying: false,
      past: [],
      future: [],
      historyGesturePending: false,
    });
    get().recalculateDuration();
    autosaveProject(loadedProject);
  },
}));
