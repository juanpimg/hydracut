import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore } from '../store/useProjectStore';
import { Clip } from '../types/project';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  const store = useProjectStore.getState();
  return {
    id: 'gesture_clip',
    trackId: store.project.tracks[0].id,
    mediaId: 'm1',
    name: 'Gesture Clip',
    type: 'video',
    start: 4,
    duration: 6,
    sourceStart: 0,
    sourceDuration: 20,
    volume: 1,
    opacity: 1,
    scale: 1,
    positionX: 0,
    positionY: 0,
    muted: false,
    ...overrides,
  };
}

describe('Clip gesture history (drag/trim undo)', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('un gesto de move completo (begin → moves → commit) se deshace con un solo undo', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip());

    // Simulate ClipItem gesture: snapshot once, then many per-pixel moves
    useProjectStore.getState().beginClipGesture();
    useProjectStore.getState().moveClip('gesture_clip', 5);
    useProjectStore.getState().moveClip('gesture_clip', 6);
    useProjectStore.getState().moveClip('gesture_clip', 7);
    useProjectStore.getState().commitClipChange();

    expect(useProjectStore.getState().project.clips[0].start).toBe(7);

    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.clips[0].start).toBe(4);
  });

  it('beginClipGesture solo toma un snapshot aunque se llame varias veces', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip());
    const pastBefore = useProjectStore.getState().past.length;

    useProjectStore.getState().beginClipGesture();
    useProjectStore.getState().beginClipGesture();
    useProjectStore.getState().beginClipGesture();

    expect(useProjectStore.getState().past.length).toBe(pastBefore + 1);
  });

  it('trim con gesto se deshace restaurando start/duration/sourceStart', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 4, duration: 10, sourceStart: 2 }));

    useProjectStore.getState().beginClipGesture();
    useProjectStore.getState().trimClipStart('gesture_clip', 6);
    useProjectStore.getState().commitClipChange();

    const trimmed = useProjectStore.getState().project.clips[0];
    expect(trimmed.start).toBe(6);

    useProjectStore.getState().undo();
    const restored = useProjectStore.getState().project.clips[0];
    expect(restored.start).toBe(4);
    expect(restored.duration).toBe(10);
    expect(restored.sourceStart).toBe(2);
  });

  it('commit sin gesto previo no rompe el historial', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip());
    const pastLen = useProjectStore.getState().past.length;
    useProjectStore.getState().commitClipChange();
    expect(useProjectStore.getState().past.length).toBe(pastLen);
    expect(useProjectStore.getState().historyGesturePending).toBe(false);
  });

  it('moveClip nunca mueve un clip a una pista bloqueada', () => {
    const store = useProjectStore.getState();
    const tracks = store.project.tracks;
    const source = tracks[0];
    const lockedTarget = tracks[1];
    useProjectStore.setState({
      project: {
        ...store.project,
        tracks: store.project.tracks.map((t) =>
          t.id === lockedTarget.id ? { ...t, isLocked: true } : t
        ),
      },
    });

    store.addClip(makeClip({ trackId: source.id, start: 4 }));
    useProjectStore.getState().moveClip('gesture_clip', 9, lockedTarget.id);

    const clip = useProjectStore.getState().project.clips[0];
    expect(clip.trackId).toBe(source.id);
    expect(clip.start).toBe(9);
  });

  it('moveClip sí permite cambiar a una pista desbloqueada compatible', () => {
    const store = useProjectStore.getState();
    const tracks = store.project.tracks;
    const videoTracks = tracks.filter((t) => t.type === 'video');
    expect(videoTracks.length).toBeGreaterThanOrEqual(2);
    const [a, b] = videoTracks;

    store.addClip(makeClip({ trackId: a.id, start: 4 }));
    useProjectStore.getState().moveClip('gesture_clip', 9, b.id);

    const clip = useProjectStore.getState().project.clips[0];
    expect(clip.trackId).toBe(b.id);
    expect(clip.start).toBe(9);
  });

  it('moveClip bloqueado en origen: no muta nada en pista bloqueada', () => {
    const store = useProjectStore.getState();
    const tracks = store.project.tracks;
    const locked = tracks[0];
    useProjectStore.setState({
      project: {
        ...store.project,
        tracks: store.project.tracks.map((t) =>
          t.id === locked.id ? { ...t, isLocked: true } : t
        ),
      },
    });

    store.addClip(makeClip({ trackId: locked.id, start: 4, duration: 6 }));
    useProjectStore.getState().moveClip('gesture_clip', 9, locked.id);
    useProjectStore.getState().trimClipStart('gesture_clip', 5);
    useProjectStore.getState().trimClipEnd('gesture_clip', 8);
    useProjectStore.getState().splitClip('gesture_clip', 6);
    useProjectStore.getState().removeClip('gesture_clip');

    const after = useProjectStore.getState().project.clips[0];
    expect(after.start).toBe(4);
    expect(after.duration).toBe(6);
    expect(useProjectStore.getState().project.clips.length).toBe(1);
  });

  it('undo a mitad de gesto resetea el flag para no perder el siguiente snapshot', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip());

    useProjectStore.getState().beginClipGesture();
    expect(useProjectStore.getState().historyGesturePending).toBe(true);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().historyGesturePending).toBe(false);

    // El siguiente gesto vuelve a tomar snapshot con normalidad
    useProjectStore.getState().beginClipGesture();
    useProjectStore.getState().moveClip('gesture_clip', 8);
    useProjectStore.getState().commitClipChange();
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.clips[0].start).toBe(4);
  });
});
