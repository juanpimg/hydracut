import { describe, it, expect, beforeEach } from 'vitest';
import { formatTimecode, formatDuration, timeToPixels, pixelsToTime } from '../core/utils/time';
import { calculateSnapping } from '../core/utils/math';
import { useProjectStore } from '../store/useProjectStore';
import { Clip } from '../types/project';

describe('Time Utilities', () => {
  it('formats timecode correctly at 30fps', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00');
    expect(formatTimecode(1, 30)).toBe('00:00:01:00');
    expect(formatTimecode(1.5, 30)).toBe('00:00:01:15');
    expect(formatTimecode(65.1, 30)).toBe('00:01:05:03');
    expect(formatTimecode(3661, 30)).toBe('01:01:01:00');
  });

  it('formats duration string', () => {
    expect(formatDuration(5.2)).toBe('00:05.2');
    expect(formatDuration(65)).toBe('01:05.0');
    expect(formatDuration(3665)).toBe('01:01:05');
  });

  it('converts time to pixels and vice versa including negative deltas', () => {
    const zoom = 50; // 50px per second
    expect(timeToPixels(2, zoom)).toBe(100);
    expect(pixelsToTime(100, zoom)).toBe(2);
    expect(pixelsToTime(0, zoom)).toBe(0);
    expect(pixelsToTime(-50, zoom)).toBe(-1);
    expect(pixelsToTime(-100, zoom)).toBe(-2);
  });
});

describe('Magnetic Snapping', () => {
  const clips: Clip[] = [
    {
      id: 'c1',
      trackId: 't1',
      mediaId: 'm1',
      name: 'Clip 1',
      type: 'video',
      start: 2,
      duration: 4, // ends at 6
      sourceStart: 0,
      sourceDuration: 10,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    },
    {
      id: 'c2',
      trackId: 't1',
      mediaId: 'm2',
      name: 'Clip 2',
      type: 'video',
      start: 10,
      duration: 5, // ends at 15
      sourceStart: 0,
      sourceDuration: 10,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    },
  ];

  it('snaps to 0s within threshold', () => {
    const zoom = 100;
    // 0.05s is 5px, threshold is 10px (0.1s)
    const result = calculateSnapping(0.05, clips, null, 20, zoom, 10, true);
    expect(result.didSnap).toBe(true);
    expect(result.snappedTime).toBe(0);
  });

  it('snaps to clip start and end points', () => {
    const zoom = 100;
    // Target near clip 1 end (6.0s)
    const resultNearEnd = calculateSnapping(5.95, clips, null, 20, zoom, 10, true);
    expect(resultNearEnd.didSnap).toBe(true);
    expect(resultNearEnd.snappedTime).toBe(6);

    // Target near clip 2 start (10.0s)
    const resultNearStart = calculateSnapping(10.05, clips, null, 20, zoom, 10, true);
    expect(resultNearStart.didSnap).toBe(true);
    expect(resultNearStart.snappedTime).toBe(10);
  });

  it('snaps to playhead position', () => {
    const zoom = 100;
    const playheadTime = 7.5;
    const result = calculateSnapping(7.55, clips, null, playheadTime, zoom, 10, true);
    expect(result.didSnap).toBe(true);
    expect(result.snappedTime).toBe(7.5);
  });

  it('does not snap if outside threshold', () => {
    const zoom = 100;
    // 3.5s is far from 2s (start) and 6s (end)
    const result = calculateSnapping(3.5, clips, null, 20, zoom, 10, true);
    expect(result.didSnap).toBe(false);
    expect(result.snappedTime).toBe(3.5);
  });

  it('does not snap clip end to points less than clip duration', () => {
    const zoom = 100;
    const clipDuration = 5; // 5s duration
    // Snap points: 0, playhead (2s)
    // Target time is -3.05s so targetEndTime is 1.95s (close to playhead 2s).
    // Clip end cannot snap to 2s because clip start would have to be negative.
    const result = calculateSnapping(-3.05, clips, null, 2.0, zoom, 10, true, clipDuration);
    expect(result.snappedTime).toBe(0);
    expect(result.snapTargetTime).not.toBe(2.0);
  });
});

describe('Project Store Operations', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('adds clip and recalculates project duration', () => {
    const store = useProjectStore.getState();
    const clip: Clip = {
      id: 'test_clip_1',
      trackId: store.project.tracks[0].id,
      mediaId: 'm1',
      name: 'Test Clip',
      type: 'video',
      start: 5,
      duration: 20,
      sourceStart: 0,
      sourceDuration: 20,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };

    store.addClip(clip);

    const updated = useProjectStore.getState().project;
    expect(updated.clips.length).toBe(1);
    expect(updated.clips[0].id).toBe('test_clip_1');
    // Clip ends at 25s, duration should be at least 25+5 = 30
    expect(updated.duration).toBeGreaterThanOrEqual(30);
  });

  it('splits clip accurately into two parts', () => {
    const store = useProjectStore.getState();
    const clip: Clip = {
      id: 'split_clip',
      trackId: store.project.tracks[0].id,
      mediaId: 'm1',
      name: 'Original Clip',
      type: 'video',
      start: 2,
      duration: 10, // from 2 to 12
      sourceStart: 0,
      sourceDuration: 20,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };

    store.addClip(clip);
    // Split at time = 6s (4s into the clip)
    store.splitClip('split_clip', 6);

    const updatedClips = useProjectStore.getState().project.clips;
    expect(updatedClips.length).toBe(2);

    const part1 = updatedClips.find((c) => c.id === 'split_clip')!;
    const part2 = updatedClips.find((c) => c.id !== 'split_clip')!;

    expect(part1.start).toBe(2);
    expect(part1.duration).toBe(4); // 6 - 2

    expect(part2.start).toBe(6);
    expect(part2.duration).toBe(6); // 12 - 6
    expect(part2.sourceStart).toBe(4); // original sourceStart (0) + 4
  });

  it('trims clip start and end correctly', () => {
    const store = useProjectStore.getState();
    const clip: Clip = {
      id: 'trim_clip',
      trackId: store.project.tracks[0].id,
      mediaId: 'm1',
      name: 'Trim Clip',
      type: 'video',
      start: 4,
      duration: 10, // ends at 14
      sourceStart: 2,
      sourceDuration: 20,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };

    store.addClip(clip);

    // Trim start from 4 to 6
    store.trimClipStart('trim_clip', 6);
    let updatedClip = useProjectStore.getState().project.clips.find((c) => c.id === 'trim_clip')!;
    expect(updatedClip.start).toBe(6);
    expect(updatedClip.duration).toBe(8); // 14 - 6
    expect(updatedClip.sourceStart).toBe(4); // 2 + 2

    // Trim end from 14 to 12
    store.trimClipEnd('trim_clip', 12);
    updatedClip = useProjectStore.getState().project.clips.find((c) => c.id === 'trim_clip')!;
    expect(updatedClip.duration).toBe(6); // 12 - 6
  });

  it('undo and redo restore state', () => {
    const store = useProjectStore.getState();
    const clip: Clip = {
      id: 'undo_clip',
      trackId: store.project.tracks[0].id,
      mediaId: 'm1',
      name: 'Undo Clip',
      type: 'video',
      start: 0,
      duration: 5,
      sourceStart: 0,
      sourceDuration: 10,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };

    store.addClip(clip);
    expect(useProjectStore.getState().project.clips.length).toBe(1);

    useProjectStore.getState().removeClip('undo_clip');
    expect(useProjectStore.getState().project.clips.length).toBe(0);

    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.clips.length).toBe(1);

    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.clips.length).toBe(0);
  });

  it('allows moving clips to the left down to 0s and clamps properly', () => {
    const store = useProjectStore.getState();
    const clip: Clip = {
      id: 'move_left_clip',
      trackId: store.project.tracks[0].id,
      mediaId: 'm1',
      name: 'Move Left Clip',
      type: 'video',
      start: 8,
      duration: 4,
      sourceStart: 0,
      sourceDuration: 10,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };

    store.addClip(clip);
    expect(useProjectStore.getState().project.clips[0].start).toBe(8);

    // Move left from 8s to 3s
    store.moveClip('move_left_clip', 3);
    expect(useProjectStore.getState().project.clips[0].start).toBe(3);

    // Move left from 3s to 0s
    store.moveClip('move_left_clip', 0);
    expect(useProjectStore.getState().project.clips[0].start).toBe(0);

    // Move left past 0s (negative delta clamped to 0)
    store.moveClip('move_left_clip', -5);
    expect(useProjectStore.getState().project.clips[0].start).toBe(0);
  });

  it('bounds trimClipStart when trimming left so it does not exceed source media start', () => {
    const store = useProjectStore.getState();
    const clip: Clip = {
      id: 'trim_clip_1',
      trackId: store.project.tracks[0].id,
      mediaId: 'm1',
      name: 'Trim Clip',
      type: 'video',
      start: 5,
      duration: 5,
      sourceStart: 2, // only 2 seconds of source media before this clip
      sourceDuration: 10,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    };

    store.addClip(clip);

    // Trim left from 5 to 4 (delta = -1s, valid since sourceStart is 2s)
    store.trimClipStart('trim_clip_1', 4);
    let updated = useProjectStore.getState().project.clips.find((c) => c.id === 'trim_clip_1')!;
    expect(updated.start).toBe(4);
    expect(updated.sourceStart).toBe(1);
    expect(updated.duration).toBe(6);

    // Trim left past available sourceStart (e.g. to 1s; max allowed is start=3s with sourceStart=0s)
    store.trimClipStart('trim_clip_1', 1);
    updated = useProjectStore.getState().project.clips.find((c) => c.id === 'trim_clip_1')!;
    expect(updated.start).toBe(3);
    expect(updated.sourceStart).toBe(0);
    expect(updated.duration).toBe(7);
  });
});
