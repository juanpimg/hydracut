/**
 * W-32 · Import validation, trash normalisation, hook dependencies and
 * transition parity.
 *
 * Defect 1 — `transition` / `textStyle` / `words` were carried raw through
 * `sanitizeImportedProject`: a hand-edited file could inject an invalid
 * transition type, a negative/NaN duration, a negative font size or timings
 * outside the clip, straight into the compositor and the audio engine.
 *
 * Defect 2 — trash clips were rebuilt with a raw `...c` spread, so a
 * restored clip came back with unnormalised `keyframes` / `filters` /
 * `preservePitch` (plus raw transition / text / words).
 *
 * Defect 3 — `useIsMobile.ts` had two `react-hooks/exhaustive-deps`
 * warnings (effects closing over `checkIsMobile` / `check`): stale-closure
 * risk on the most important layout decision of the app.
 *
 * Defect 4 — the mobile transition picker missed the `slide-left` out and
 * the `wipe-right` in variants the desktop offers.
 *
 * Every `it` below either fails on the pre-fix code (raw carry, missing
 * options, lint warnings) or guards the fixed behaviour (byte-equality of
 * the valid case, wiring that must not change).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

import { sanitizeImportedProject } from '../core/storage/projectStorage';
import {
  VALID_TRANSITION_TYPES,
  sanitizeClipTextStyle,
  sanitizeClipTransition,
  sanitizeClipWords,
  sanitizeTransitionType,
} from '../core/utils/clipSanitize';
import {
  FADE_IN_OPTIONS,
  FADE_OUT_OPTIONS,
  TRANSITION_OPTIONS,
  assertTransitionOptionsParity,
} from '../core/utils/transitionOptions';
import {
  MOBILE_FADE_IN_OPTIONS,
  MOBILE_FADE_OUT_OPTIONS,
} from '../components/mobile/MobileCapCutLayout';
import type { Clip, MediaItem, Project, Track, TrashEntry } from '../types/project';

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* Fixtures (module-level data: no local production-like functions)     */
/* ------------------------------------------------------------------ */

const RES_1080P = { width: 1920, height: 1080 };

const TRACK_V1: Track = {
  id: 't1',
  name: 'V1',
  type: 'video',
  isMuted: false,
  isLocked: false,
  isVisible: true,
};

const BASE_CLIP: Clip = {
  id: 'c1',
  trackId: 't1',
  mediaId: 'm1',
  name: 'Clip',
  type: 'video',
  start: 0,
  duration: 4,
  sourceStart: 0,
  sourceDuration: 4,
  volume: 1,
  opacity: 1,
  scale: 1,
  positionX: 0,
  positionY: 0,
  muted: false,
};

const TRASH_MEDIA: MediaItem = {
  id: 'm9',
  name: 'm9.mp4',
  type: 'video',
  url: '',
  duration: 4,
  width: 0,
  height: 0,
  fps: 30,
  thumbnailUrl: '',
  size: 0,
  createdAt: 1,
};

function buildClip(overrides: Partial<Clip> = {}): Clip {
  return { ...BASE_CLIP, ...overrides };
}

function buildCandidate(clips: Clip[], trash: TrashEntry[] = []): Partial<Project> {
  return {
    id: 'p1',
    name: 'Import',
    aspectRatio: '16:9',
    resolution: { ...RES_1080P },
    fps: 30,
    tracks: [{ ...TRACK_V1 }],
    clips,
    mediaPool: [],
    trash,
  };
}

function buildTrashEntry(clip: Clip): TrashEntry {
  return { media: { ...TRASH_MEDIA }, clips: [clip], deletedAt: 1 };
}

function sanitizeClipsOf(candidate: Partial<Project>): Clip[] {
  return sanitizeImportedProject(candidate, { projectId: 'p1', fallbackName: 'Import' })
    .project.clips;
}

/* ------------------------------------------------------------------ */
/* Defect 1 — transition / textStyle / words are validated on import    */
/* ------------------------------------------------------------------ */

describe('defect 1 · transition is validated on import', () => {
  it('an unknown transition type falls back to none', () => {
    const [clip] = sanitizeClipsOf(
      buildCandidate([
        buildClip({
          transition: {
            fadeInType: 'explode' as any,
            fadeInDuration: 0.5,
            fadeOutType: 'none',
            fadeOutDuration: 0,
          },
        }),
      ])
    );
    expect(clip.transition?.fadeInType).toBe('none');
    expect(clip.transition?.fadeInDuration).toBe(0.5);
  });

  it('a negative fade duration becomes 0 instead of poisoning the compositor', () => {
    const [clip] = sanitizeClipsOf(
      buildCandidate([
        buildClip({
          transition: {
            fadeInType: 'fade-black',
            fadeInDuration: -999,
            fadeOutType: 'none',
            fadeOutDuration: 0,
          },
        }),
      ])
    );
    expect(clip.transition?.fadeInDuration).toBe(0);
  });

  it('a NaN fade duration becomes 0', () => {
    const [clip] = sanitizeClipsOf(
      buildCandidate([
        buildClip({
          transition: {
            fadeInType: 'fade-black',
            fadeInDuration: Number.NaN,
            fadeOutType: 'fade-white',
            fadeOutDuration: Number.NaN,
          },
        }),
      ])
    );
    expect(clip.transition?.fadeInDuration).toBe(0);
    expect(clip.transition?.fadeOutDuration).toBe(0);
  });

  it('fade durations are clamped to the clip duration', () => {
    const [clip] = sanitizeClipsOf(
      buildCandidate([
        buildClip({
          transition: {
            fadeInType: 'slide-left',
            fadeInDuration: 99,
            fadeOutType: 'none',
            fadeOutDuration: 0,
          },
        }),
      ])
    );
    expect(clip.transition?.fadeInDuration).toBeLessThanOrEqual(4);
    expect(clip.transition?.fadeInDuration).toBe(4);
  });

  it('in + out longer than the clip shrink instead of overflowing it', () => {
    const [clip] = sanitizeClipsOf(
      buildCandidate([
        buildClip({
          transition: {
            fadeInType: 'fade-black',
            fadeInDuration: 3,
            fadeOutType: 'fade-white',
            fadeOutDuration: 3,
          },
        }),
      ])
    );
    const total =
      (clip.transition?.fadeInDuration ?? 0) + (clip.transition?.fadeOutDuration ?? 0);
    expect(total).toBeLessThanOrEqual(4);
    expect(clip.transition?.fadeInDuration).toBeGreaterThan(0);
    expect(clip.transition?.fadeOutDuration).toBeGreaterThan(0);
  });

  it('crossfade markers are clamped to the clip and garbage is dropped', () => {
    const direct = sanitizeClipTransition(
      { fadeInType: 'none', fadeInDuration: 0, fadeOutType: 'none', fadeOutDuration: 0,
        crossfadeInDuration: 99, crossfadeOutDuration: -5 },
      4
    );
    expect(direct?.crossfadeInDuration).toBe(4);
    expect(direct?.crossfadeOutDuration).toBeUndefined();
    expect(sanitizeClipTransition(null, 4)).toBeUndefined();
    expect(sanitizeClipTransition('nope', 4)).toBeUndefined();
  });

  it('every valid TransitionType survives untouched', () => {
    for (const type of VALID_TRANSITION_TYPES) {
      expect(sanitizeTransitionType(type)).toBe(type);
    }
    expect(sanitizeTransitionType('explode')).toBe('none');
    expect(sanitizeTransitionType(undefined)).toBe('none');
  });
});

describe('defect 1 · textStyle is validated on import', () => {
  it('a negative font size is clamped to the readable minimum', () => {
    const [clip] = sanitizeClipsOf(
      buildCandidate([
        buildClip({
          textStyle: {
            fontSize: -50,
            color: '#ffffff',
            backgroundColor: 'transparent',
            fontFamily: 'Inter, sans-serif',
            textAlign: 'center',
            fontWeight: 'bold',
          },
        }),
      ])
    );
    expect(clip.textStyle?.fontSize).toBeGreaterThanOrEqual(8);
  });

  it('a NaN font size falls back to the creation size', () => {
    const [clip] = sanitizeClipsOf(
      buildCandidate([
        buildClip({
          textStyle: {
            fontSize: Number.NaN,
            color: '#ffffff',
            backgroundColor: 'transparent',
            fontFamily: 'Inter, sans-serif',
            textAlign: 'center',
            fontWeight: 'bold',
          },
        }),
      ])
    );
    expect(clip.textStyle?.fontSize).toBe(48);
  });

  it('non-string colours fall back to the defaults', () => {
    const style = sanitizeClipTextStyle({
      fontSize: 48,
      color: 12345,
      backgroundColor: null,
      fontFamily: 'Inter',
      textAlign: 'left',
      fontWeight: 'bold',
    });
    expect(style?.color).toBe('#ffffff');
    expect(style?.backgroundColor).toBe('transparent');
    expect(sanitizeClipTextStyle(undefined)).toBeUndefined();
    expect(sanitizeClipTextStyle(null)).toBeUndefined();
  });
});

describe('defect 1 · words are validated on import', () => {
  it('timings outside the clip are clamped inside it', () => {
    const [clip] = sanitizeClipsOf(
      buildCandidate([buildClip({ words: [{ word: 'hola', start: -5, end: 500 }] })])
    );
    expect(clip.words).toHaveLength(1);
    expect(clip.words?.[0].start).toBe(0);
    expect(clip.words?.[0].end).toBe(4);
  });

  it('entries with non-finite times are dropped, not carried', () => {
    const [clip] = sanitizeClipsOf(
      buildCandidate([buildClip({ words: [{ word: 'x', start: Number.NaN, end: 1 }] as any })])
    );
    expect(clip.words).toBeUndefined();
    expect(sanitizeClipWords('nope', 4)).toBeUndefined();
    expect(sanitizeClipWords([], 4)).toBeUndefined();
  });

  it('words come out sorted by start', () => {
    const [clip] = sanitizeClipsOf(
      buildCandidate([
        buildClip({
          words: [
            { word: 'b', start: 2, end: 3 },
            { word: 'a', start: 0, end: 1 },
          ],
        }),
      ])
    );
    expect(clip.words?.map((w) => w.word)).toEqual(['a', 'b']);
  });
});

describe('defect 1 · optional carry and backwards compatibility', () => {
  it('adds no transition/textStyle/words keys when the fields are absent', () => {
    const [clip] = sanitizeClipsOf(buildCandidate([buildClip()]));
    expect('transition' in clip).toBe(false);
    expect('textStyle' in clip).toBe(false);
    expect('words' in clip).toBe(false);
  });

  it('a valid clip imports byte-identically (older builds keep working)', () => {
    const input = buildClip({
      speed: 2,
      preservePitch: false,
      text: 'hola',
      words: [{ word: 'hola', start: 0, end: 1 }],
      transition: {
        fadeInType: 'fade-black',
        fadeInDuration: 0.5,
        fadeOutType: 'none',
        fadeOutDuration: 0,
      },
    });
    const [clip] = sanitizeClipsOf(buildCandidate([input]));
    const expected = {
      id: 'c1',
      trackId: 't1',
      mediaId: 'm1',
      name: 'Clip',
      type: 'video',
      start: 0,
      duration: 4,
      sourceStart: 0,
      sourceDuration: 4,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
      speed: 2,
      preservePitch: false,
      text: 'hola',
      words: [{ word: 'hola', start: 0, end: 1 }],
      transition: {
        fadeInType: 'fade-black',
        fadeInDuration: 0.5,
        fadeOutType: 'none',
        fadeOutDuration: 0,
      },
    };
    expect(JSON.stringify(clip)).toBe(JSON.stringify(expected));
  });
});

/* ------------------------------------------------------------------ */
/* Defect 2 — trash clips are normalised like main-path clips           */
/* ------------------------------------------------------------------ */

describe('defect 2 · trash clips come back normalised', () => {
  it('sorts and de-duplicates trash keyframes instead of keeping them raw', () => {
    const candidate = buildCandidate([], [
      buildTrashEntry(
        buildClip({
          id: 'ct1',
          keyframes: [
            { t: 2, opacity: 0.5 },
            { t: 1, opacity: 0.2 },
            { t: 1, opacity: 0.9 },
          ],
        })
      ),
    ]);
    const trash = sanitizeImportedProject(candidate, {
      projectId: 'p1',
      fallbackName: 'Import',
    }).project.trash;
    expect(trash?.[0].clips[0].keyframes?.map((k) => k.t)).toEqual([1, 2]);
    expect(trash?.[0].clips[0].keyframes).toHaveLength(2);
  });

  it('clamps trash colour filters instead of keeping them raw', () => {
    const candidate = buildCandidate([], [
      buildTrashEntry(
        buildClip({ id: 'ct1', filters: { sepia: 5, brightness: 1.2 } as any })
      ),
    ]);
    const trash = sanitizeImportedProject(candidate, {
      projectId: 'p1',
      fallbackName: 'Import',
    }).project.trash;
    expect(trash?.[0].clips[0].filters?.sepia).toBe(1);
    expect(trash?.[0].clips[0].filters?.brightness).toBe(1.2);
  });

  it('drops garbage preservePitch from trash clips', () => {
    const candidate = buildCandidate([], [
      buildTrashEntry(buildClip({ id: 'ct1', preservePitch: 'yes' as any })),
    ]);
    const trash = sanitizeImportedProject(candidate, {
      projectId: 'p1',
      fallbackName: 'Import',
    }).project.trash;
    expect(trash?.[0].clips[0].preservePitch).toBeUndefined();
  });

  it('keeps a real preservePitch: false through the trash', () => {
    const candidate = buildCandidate([], [
      buildTrashEntry(buildClip({ id: 'ct1', preservePitch: false })),
    ]);
    const trash = sanitizeImportedProject(candidate, {
      projectId: 'p1',
      fallbackName: 'Import',
    }).project.trash;
    expect(trash?.[0].clips[0].preservePitch).toBe(false);
  });

  it('sanitises trash transition, textStyle and words', () => {
    const candidate = buildCandidate([], [
      buildTrashEntry(
        buildClip({
          id: 'ct1',
          transition: {
            fadeInType: 'bogus' as any,
            fadeInDuration: -3,
            fadeOutType: 'none',
            fadeOutDuration: 0,
          },
          textStyle: {
            fontSize: -10,
            color: '#fff',
            backgroundColor: 'transparent',
            fontFamily: 'Inter',
            textAlign: 'center',
            fontWeight: 'bold',
          },
          words: [{ word: 'a', start: -2, end: 99 }],
        })
      ),
    ]);
    const trash = sanitizeImportedProject(candidate, {
      projectId: 'p1',
      fallbackName: 'Import',
    }).project.trash;
    const restored = trash?.[0].clips[0];
    expect(restored?.transition?.fadeInType).toBe('none');
    expect(restored?.transition?.fadeInDuration).toBe(0);
    expect(restored?.textStyle?.fontSize).toBeGreaterThanOrEqual(8);
    expect(restored?.words?.[0].start).toBe(0);
    expect(restored?.words?.[0].end).toBe(4);
  });

  it('drops a non-string trash text instead of carrying it raw', () => {
    const candidate = buildCandidate([], [
      buildTrashEntry(buildClip({ id: 'ct1', text: 42 as any })),
    ]);
    const trash = sanitizeImportedProject(candidate, {
      projectId: 'p1',
      fallbackName: 'Import',
    }).project.trash;
    expect(trash?.[0].clips[0].text).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Defect 3 — hook dependencies without stale closures                  */
/* ------------------------------------------------------------------ */

describe('defect 3 · useIsMobile has no stale-closure dependencies', () => {
  it('passes react-hooks/exhaustive-deps with zero warnings', () => {
    const source = readFileSync(join(here, '..', 'hooks/useIsMobile.ts'), 'utf8');
    const linter = new Linter();
    const messages = linter.verify(
      source,
      [
        {
          files: ['**/*.ts'],
          languageOptions: {
            parser: tsParser,
            ecmaVersion: 'latest',
            sourceType: 'module',
          },
          plugins: { 'react-hooks': reactHooks },
          rules: { 'react-hooks/exhaustive-deps': 'error' },
        },
      ],
      'useIsMobile.ts'
    );
    expect(messages).toEqual([]);
  });

  it('does not silence the rule with an eslint-disable', () => {
    const source = readFileSync(join(here, '..', 'hooks/useIsMobile.ts'), 'utf8');
    expect(source).not.toMatch(/eslint-disable/);
  });

  it('still switches on resize and on media-query changes', () => {
    const source = readFileSync(join(here, '..', 'hooks/useIsMobile.ts'), 'utf8');
    expect(source).toContain("window.addEventListener('resize'");
    expect(source).toContain("window.removeEventListener('resize'");
    expect(source).toContain("addEventListener('change'");
    expect(source).toContain('isMobileViewport');
    expect(source).toContain('matchMedia');
  });
});

/* ------------------------------------------------------------------ */
/* Defect 4 — mobile/desktop transition parity                          */
/* ------------------------------------------------------------------ */

describe('defect 4 · mobile offers every desktop transition', () => {
  it('the shared module lists the five canonical transitions', () => {
    expect(TRANSITION_OPTIONS.map((o) => o.id)).toEqual([
      'none',
      'fade-black',
      'fade-white',
      'slide-left',
      'wipe-right',
    ]);
    expect(FADE_IN_OPTIONS).toEqual(TRANSITION_OPTIONS);
    expect(FADE_OUT_OPTIONS).toEqual(TRANSITION_OPTIONS);
  });

  it('the mobile fade-in picker covers the canonical set (wipe-right in)', () => {
    expect(MOBILE_FADE_IN_OPTIONS.map((o) => o.id)).toEqual(
      TRANSITION_OPTIONS.map((o) => o.id)
    );
    expect(MOBILE_FADE_IN_OPTIONS.map((o) => o.id)).toContain('wipe-right');
  });

  it('the mobile fade-out picker covers the canonical set (slide-left out)', () => {
    expect(MOBILE_FADE_OUT_OPTIONS.map((o) => o.id)).toEqual(
      TRANSITION_OPTIONS.map((o) => o.id)
    );
    expect(MOBILE_FADE_OUT_OPTIONS.map((o) => o.id)).toContain('slide-left');
  });

  it('the mobile lists match the shared module labels exactly', () => {
    expect([...MOBILE_FADE_IN_OPTIONS]).toEqual([...TRANSITION_OPTIONS]);
    expect([...MOBILE_FADE_OUT_OPTIONS]).toEqual([...TRANSITION_OPTIONS]);
    expect(() =>
      assertTransitionOptionsParity('MOBILE_FADE_IN_OPTIONS', MOBILE_FADE_IN_OPTIONS)
    ).not.toThrow();
    expect(() =>
      assertTransitionOptionsParity('MOBILE_FADE_OUT_OPTIONS', MOBILE_FADE_OUT_OPTIONS)
    ).not.toThrow();
  });
});
