/**
 * Regression tests for the timeline/store hardening wave (W-1b).
 *
 * Every test asserts the REAL behaviour of `useProjectStore`; no
 * re-implementation of the logic under test and no tautological asserts.
 *
 * F1  KI-01 / S-06 / B-06  the project duration is the REAL extent of the
 *                          content (no 15 s floor, no +5 s padding)
 * F2  S-17                `duplicateTrack` validates before pushing history
 * F3  S-18                mute / lock / visibility are undoable
 * F4  S-19                NaN can never enter the timeline state
 * F5  S-22                `moveClip` refuses track-type incompatible moves
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  useProjectStore,
  DEFAULT_EMPTY_PROJECT_DURATION,
  MIN_PROJECT_DURATION,
} from '../store/useProjectStore';
import { Clip } from '../types/project';

const VIDEO_TRACK = 'track_video_1';
const OTHER_VIDEO_TRACK = 'track_video_2';
const AUDIO_TRACK = 'track_audio_1';
const TEXT_TRACK = 'track_text_1';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip_1',
    trackId: VIDEO_TRACK,
    mediaId: 'media_1',
    name: 'Clip',
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
    ...overrides,
  };
}

/** Reads the duration currently exposed by the store. */
function currentDuration(): number {
  return useProjectStore.getState().project.duration;
}

describe('F1 (KI-01 / S-06 / B-06) — la duración es el contenido real', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('un clip de 5 s produce una duración de 5 s (no de 20 s)', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 0, duration: 5 }));

    // Old behaviour: ceil(max(15, 5) + 5) = 20 -> a 15 s black tail.
    expect(currentDuration()).toBe(5);
  });

  it('un clip que acaba en 12.3 s produce una duración de 13 s', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 10, duration: 2.3 }));

    // `Math.ceil` keeps the frame count integral: 12.3 s -> 13 s.
    expect(currentDuration()).toBe(13);
  });

  it('al quitar todos los clips la duración vuelve al valor por defecto', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 0, duration: 5 }));
    expect(currentDuration()).toBe(5);

    useProjectStore.getState().removeClip('clip_1');

    expect(useProjectStore.getState().project.clips.length).toBe(0);
    expect(currentDuration()).toBe(DEFAULT_EMPTY_PROJECT_DURATION);
    expect(currentDuration()).toBe(30);
  });

  it('la duración es el extremo más lejano, no la suma de los clips', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ id: 'clip_a', start: 0, duration: 5 }));
    store.addClip(makeClip({ id: 'clip_b', start: 10, duration: 2.5 }));

    // 12.5 s of content -> 13 s, NOT 5 + 12.5 = 17.5 s.
    expect(currentDuration()).toBe(13);
  });

  it('un clip con duración 0 o negativa nunca produce una duración negativa', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 0, duration: 0 }));
    expect(Number.isFinite(currentDuration())).toBe(true);
    expect(currentDuration()).toBe(MIN_PROJECT_DURATION);

    useProjectStore.getState().removeClip('clip_1');
    store.addClip(makeClip({ start: 3, duration: -8 }));
    expect(Number.isFinite(currentDuration())).toBe(true);
    expect(currentDuration()).toBeGreaterThanOrEqual(MIN_PROJECT_DURATION);
  });

  it('el relleno final es opt-in (endPaddingSeconds), no una constante', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 0, duration: 5 }));
    expect(currentDuration()).toBe(5);

    useProjectStore.setState((s) => ({
      project: { ...s.project, endPaddingSeconds: 1 },
    }));
    useProjectStore.getState().recalculateDuration();

    expect(currentDuration()).toBe(6);
  });

  it('recortar el final del clip acorta la duración del proyecto', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 0, duration: 10, sourceStart: 0, sourceDuration: 20 }));
    expect(currentDuration()).toBe(10);

    // Real gesture flow: trim -> commit.
    useProjectStore.getState().trimClipEnd('clip_1', 4);
    useProjectStore.getState().commitClipChange();

    expect(currentDuration()).toBe(4);
  });

  it('editar la duración desde el inspector actualiza la duración del proyecto', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 0, duration: 10, sourceStart: 0, sourceDuration: 20 }));
    expect(currentDuration()).toBe(10);

    useProjectStore.getState().updateClip('clip_1', { duration: 3 });

    expect(currentDuration()).toBe(3);
  });

  it('undo y redo recalculan la duración (sin dejar una cola negra)', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 0, duration: 5 }));
    expect(currentDuration()).toBe(5);

    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.clips.length).toBe(0);
    expect(currentDuration()).toBe(DEFAULT_EMPTY_PROJECT_DURATION);

    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.clips.length).toBe(1);
    expect(currentDuration()).toBe(5);
  });

  it('la duración que se exporta es la misma que ve el usuario (sin +5 s)', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 0, duration: 5 }));

    // `project.duration` is THE single source consumed by the export modal and
    // by the exporter (frames = duration * fps).
    const project = useProjectStore.getState().project;
    expect(project.duration).toBe(5);
    expect(Math.round(project.duration * project.fps)).toBe(150);
    expect(project.duration).toBeLessThanOrEqual(5);
  });
});

describe('F2 (S-17) — duplicateTrack valida antes de empujar historial', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('duplicar una pista inexistente no crea una entrada fantasma de historial', () => {
    const store = useProjectStore.getState();
    const pastBefore = useProjectStore.getState().past.length;

    store.duplicateTrack('nonexistent_track_999');

    expect(useProjectStore.getState().past.length).toBe(pastBefore);
    expect(useProjectStore.getState().future.length).toBe(0);
  });

  it('duplicar una pista inexistente NO destruye el redo pendiente', () => {
    const store = useProjectStore.getState();
    store.addTrack('audio', 'Audio extra');
    useProjectStore.getState().undo();

    const futureBefore = useProjectStore.getState().future.length;
    expect(futureBefore).toBeGreaterThan(0);

    store.duplicateTrack('nonexistent_track_999');

    expect(useProjectStore.getState().future.length).toBe(futureBefore);
    // ...and the redo is still usable.
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.tracks.length).toBe(5);
  });
});

describe('F3 (S-18) — mute / lock / visibilidad son deshacibles', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('toggleTrackMute se puede deshacer', () => {
    const store = useProjectStore.getState();
    store.toggleTrackMute(VIDEO_TRACK);
    expect(useProjectStore.getState().project.tracks.find((t) => t.id === VIDEO_TRACK)!.isMuted).toBe(true);

    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.tracks.find((t) => t.id === VIDEO_TRACK)!.isMuted).toBe(false);
  });

  it('toggleTrackLock se puede deshacer', () => {
    const store = useProjectStore.getState();
    store.toggleTrackLock(VIDEO_TRACK);
    expect(useProjectStore.getState().project.tracks.find((t) => t.id === VIDEO_TRACK)!.isLocked).toBe(true);

    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.tracks.find((t) => t.id === VIDEO_TRACK)!.isLocked).toBe(false);
  });

  it('toggleTrackVisibility se puede deshacer', () => {
    const store = useProjectStore.getState();
    store.toggleTrackVisibility(VIDEO_TRACK);
    expect(useProjectStore.getState().project.tracks.find((t) => t.id === VIDEO_TRACK)!.isVisible).toBe(false);

    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.tracks.find((t) => t.id === VIDEO_TRACK)!.isVisible).toBe(true);
  });

  it('un mute no se pierde por un undo que no le pertenece', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 0, duration: 5 }));
    store.toggleTrackMute(VIDEO_TRACK);

    // The undo of the mute reverts the mute (that is the point: it is undoable)
    // and does not touch the clips.
    useProjectStore.getState().undo();
    const project = useProjectStore.getState().project;
    expect(project.tracks.find((t) => t.id === VIDEO_TRACK)!.isMuted).toBe(false);
    expect(project.clips.length).toBe(1);
  });

  it('alternar una pista inexistente no crea una entrada fantasma de historial', () => {
    const store = useProjectStore.getState();
    const pastBefore = useProjectStore.getState().past.length;

    store.toggleTrackMute('nonexistent_track_999');
    store.toggleTrackLock('nonexistent_track_999');
    store.toggleTrackVisibility('nonexistent_track_999');

    expect(useProjectStore.getState().past.length).toBe(pastBefore);
  });
});

describe('F4 (S-19) — NaN no puede entrar en el estado del timeline', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('setCurrentTime con NaN deja un tiempo finito', () => {
    const store = useProjectStore.getState();
    store.setCurrentTime(NaN);

    expect(Number.isFinite(useProjectStore.getState().currentTime)).toBe(true);
    expect(useProjectStore.getState().currentTime).toBe(0);
  });

  it('setCurrentTime con Infinity deja un tiempo finito', () => {
    const store = useProjectStore.getState();
    store.setCurrentTime(Infinity);

    expect(Number.isFinite(useProjectStore.getState().currentTime)).toBe(true);
    expect(useProjectStore.getState().currentTime).toBe(0);
  });

  it('moveClip con NaN no corrompe el clip', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 2, duration: 5 }));
    const before = useProjectStore.getState().project.clips[0].start;

    useProjectStore.getState().moveClip('clip_1', NaN);

    const clip = useProjectStore.getState().project.clips[0];
    expect(Number.isFinite(clip.start)).toBe(true);
    expect(clip.start).toBe(before);
  });

  it('trimClipStart / trimClipEnd con NaN no corrompen el clip', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 2, duration: 5, sourceStart: 0, sourceDuration: 20 }));

    useProjectStore.getState().trimClipStart('clip_1', NaN);
    useProjectStore.getState().trimClipEnd('clip_1', NaN);

    const clip = useProjectStore.getState().project.clips[0];
    expect(Number.isFinite(clip.start)).toBe(true);
    expect(Number.isFinite(clip.duration)).toBe(true);
    expect(clip.start).toBe(2);
    expect(clip.duration).toBe(5);
  });

  it('splitClip con NaN no parte el clip', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 0, duration: 10 }));

    useProjectStore.getState().splitClip('clip_1', NaN);

    const clips = useProjectStore.getState().project.clips;
    expect(clips.length).toBe(1);
    expect(Number.isFinite(clips[0].start)).toBe(true);
    expect(Number.isFinite(clips[0].duration)).toBe(true);
  });

  it('undo y redo limpian la guía de snapping', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ start: 0, duration: 5 }));
    store.setSnappingGuideTime(3.5);
    expect(useProjectStore.getState().snappingGuideTime).toBe(3.5);

    useProjectStore.getState().undo();
    expect(useProjectStore.getState().snappingGuideTime).toBeNull();

    store.setSnappingGuideTime(2.5);
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().snappingGuideTime).toBeNull();
  });
});

describe('F5 (S-22) — moveClip valida el tipo de pista', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('un clip de vídeo no puede acabar en una pista de audio', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ id: 'clip_v', trackId: VIDEO_TRACK, type: 'video', start: 0, duration: 5 }));

    useProjectStore.getState().moveClip('clip_v', 0, AUDIO_TRACK);

    const clip = useProjectStore.getState().project.clips[0];
    expect(clip.trackId).not.toBe(AUDIO_TRACK);
    const track = useProjectStore.getState().project.tracks.find((t) => t.id === clip.trackId);
    expect(track?.type).toBe('video');
    // The refusal is surfaced with a reason.
    expect(useProjectStore.getState().lastError).toBeTruthy();
  });

  it('un clip de audio no puede acabar en una pista de vídeo', () => {
    const store = useProjectStore.getState();
    store.addClip(
      makeClip({ id: 'clip_a', trackId: AUDIO_TRACK, type: 'audio', start: 0, duration: 5 })
    );

    useProjectStore.getState().moveClip('clip_a', 0, VIDEO_TRACK);

    const clip = useProjectStore.getState().project.clips[0];
    expect(clip.trackId).toBe(AUDIO_TRACK);
    expect(useProjectStore.getState().lastError).toBeTruthy();
  });

  it('un clip de texto no puede acabar en una pista de vídeo', () => {
    const store = useProjectStore.getState();
    store.addClip(
      makeClip({ id: 'clip_t', trackId: TEXT_TRACK, type: 'text', start: 0, duration: 5 })
    );

    useProjectStore.getState().moveClip('clip_t', 0, VIDEO_TRACK);

    const clip = useProjectStore.getState().project.clips[0];
    expect(clip.trackId).toBe(TEXT_TRACK);
    expect(useProjectStore.getState().lastError).toBeTruthy();
  });

  it('un clip de vídeo sí puede moverse a otra pista de vídeo', () => {
    const store = useProjectStore.getState();
    store.addClip(makeClip({ id: 'clip_v', trackId: VIDEO_TRACK, type: 'video', start: 0, duration: 5 }));

    useProjectStore.getState().moveClip('clip_v', 0, OTHER_VIDEO_TRACK);

    const clip = useProjectStore.getState().project.clips[0];
    expect(clip.trackId).toBe(OTHER_VIDEO_TRACK);
    expect(useProjectStore.getState().lastError).toBeNull();
  });
});
