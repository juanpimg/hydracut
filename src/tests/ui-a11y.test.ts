import { describe, it, expect } from 'vitest';
import {
  clamp,
  computeAnchoredMenuPosition,
  toAnchorRect,
  type AnchorRect,
} from '../components/layout/overlayGeometry';
import {
  resolveFocusTrapAction,
  resolveInitialFocusIndex,
  FOCUSABLE_SELECTOR,
} from '../hooks/useFocusTrap';
import { announce, subscribeLiveAnnouncements, getLastAnnouncement } from '../components/layout/liveRegion';
import { isMobileViewport } from '../hooks/useIsMobile';
import { canSplitAtTime } from '../components/timeline/TimelineToolbar';
import type { Clip } from '../types/project';

/**
 * Unit tests for the pure logic behind the UI/a11y fixes of wave O5.
 *
 * The DOM level guarantees (a menu that is really visible and clickable, a
 * modal that really traps the focus) can only be asserted in a real browser:
 * jsdom has no layout engine, so a clipped menu looks perfectly fine to it.
 * Those assertions belong to the browser suite (`npm run test:browser`).
 */

const anchor = (overrides: Partial<AnchorRect> = {}): AnchorRect => ({
  top: 100,
  left: 200,
  right: 260,
  bottom: 136,
  width: 60,
  height: 36,
  ...overrides,
});

describe('UI-01/02/03 · anchored menu geometry', () => {
  it('places the menu under the trigger when there is room', () => {
    const pos = computeAnchoredMenuPosition(
      anchor(),
      { width: 176, height: 142 },
      { width: 1440, height: 900 },
      { align: 'end', gap: 6, padding: 8 }
    );

    expect(pos.placement).toBe('bottom');
    expect(pos.top).toBe(142); // anchor.bottom + gap
    expect(pos.left).toBe(260 - 176); // right aligned with the trigger
    expect(pos.maxHeight).toBeGreaterThan(142);
  });

  it('flips the menu above the trigger when it does not fit below', () => {
    const pos = computeAnchoredMenuPosition(
      anchor({ top: 700, bottom: 736 }),
      { width: 176, height: 142 },
      { width: 1440, height: 768 },
      { align: 'end', gap: 6, padding: 8 }
    );

    expect(pos.placement).toBe('top');
    expect(pos.top).toBeLessThan(700);
    expect(pos.top + 142).toBeLessThanOrEqual(700);
  });

  it('never leaves the menu outside a 320 px wide viewport', () => {
    const pos = computeAnchoredMenuPosition(
      anchor({ left: 280, right: 316 }),
      { width: 176, height: 142 },
      { width: 320, height: 568 },
      { align: 'end', gap: 6, padding: 8 }
    );

    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.left + 176).toBeLessThanOrEqual(320 - 8);
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });

  it('centers the menu on the trigger when asked to', () => {
    const pos = computeAnchoredMenuPosition(
      anchor(),
      { width: 150, height: 100 },
      { width: 390, height: 844 },
      { align: 'center', gap: 6, padding: 8 }
    );

    expect(pos.left + 75).toBe(230); // anchor.left + anchor.width / 2
  });

  it('reports the room available so the menu scrolls instead of being clipped', () => {
    const pos = computeAnchoredMenuPosition(
      anchor({ top: 300, bottom: 336 }),
      { width: 176, height: 400 },
      { width: 1440, height: 568 },
      { align: 'end', gap: 6, padding: 8 }
    );

    // 218 px below and 286 px above: the menu does not fit either way, so it
    // is placed above and the caller has to scroll it inside the 286 px that
    // are really available (instead of being clipped by the viewport).
    expect(pos.placement).toBe('top');
    expect(pos.maxHeight).toBe(300 - 6 - 8);
    expect(pos.maxHeight).toBeLessThan(400);
  });

  it('clamps values into the requested range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
    expect(clamp(5, 10, 0)).toBe(10);
  });

  it('converts a DOMRect-like object into the anchor shape', () => {
    expect(toAnchorRect({ top: 1, left: 2, right: 3, bottom: 4, width: 1, height: 3 })).toEqual({
      top: 1,
      left: 2,
      right: 3,
      bottom: 4,
      width: 1,
      height: 3,
    });
  });
});

describe('UI-08 · focus trap key handling', () => {
  it('wraps Tab from the last element to the first one', () => {
    expect(resolveFocusTrapAction('Tab', false, 3, 2)).toEqual({ type: 'focus', index: 0 });
  });

  it('wraps Shift+Tab from the first element to the last one', () => {
    expect(resolveFocusTrapAction('Tab', true, 3, 0)).toEqual({ type: 'focus', index: 2 });
  });

  it('pulls the focus back when it escaped the dialog', () => {
    expect(resolveFocusTrapAction('Tab', false, 3, -1)).toEqual({ type: 'focus', index: 0 });
    expect(resolveFocusTrapAction('Tab', true, 3, -1)).toEqual({ type: 'focus', index: 2 });
  });

  it('keeps the focus on the container when the dialog has nothing focusable', () => {
    expect(resolveFocusTrapAction('Tab', false, 0, -1)).toEqual({ type: 'focus-container' });
  });

  it('lets the browser handle the keys that are not Tab', () => {
    expect(resolveFocusTrapAction('a', false, 3, 1)).toBeNull();
    expect(resolveFocusTrapAction('Escape', false, 3, 1)).toBeNull();
  });

  it('does not interfere with the focus inside the dialog', () => {
    expect(resolveFocusTrapAction('Tab', false, 3, 1)).toBeNull();
    expect(resolveFocusTrapAction('Tab', true, 3, 1)).toBeNull();
  });

  it('focuses the first focusable element when the dialog opens', () => {
    expect(resolveInitialFocusIndex(4)).toBe(0);
    expect(resolveInitialFocusIndex(0)).toBe(-1);
  });

  it('exposes a focusable selector that matches the usual controls', () => {
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('a[href]');
    expect(FOCUSABLE_SELECTOR).toContain('input:not([disabled]):not([type="hidden"])');
  });
});

describe('UI-16 · live region', () => {
  it('publishes the announcements to its subscribers', () => {
    const received: string[] = [];
    const unsubscribe = subscribeLiveAnnouncements((message) => received.push(message));

    announce('Pista de audio añadida');
    expect(received).toHaveLength(1);
    expect(received[0]).toBe('Pista de audio añadida');
    expect(getLastAnnouncement()).toBe('Pista de audio añadida');

    unsubscribe();
    announce('Otro mensaje');
    expect(received).toHaveLength(1);
  });

  it('ignores empty announcements', () => {
    const received: string[] = [];
    const unsubscribe = subscribeLiveAnnouncements((message) => received.push(message));
    announce('   ');
    expect(received).toHaveLength(0);
    unsubscribe();
  });

  it('changes the text when the same message is repeated so it is re-announced', () => {
    const received: string[] = [];
    const unsubscribe = subscribeLiveAnnouncements((message) => received.push(message));

    announce('Repetido');
    announce('Repetido');

    expect(received).toHaveLength(2);
    expect(received[0]).not.toBe(received[1]);
    unsubscribe();
  });
});

describe('UI-27 · split availability', () => {
  const clip = (start: number, duration: number): Clip =>
    ({
      id: 'c1',
      trackId: 't1',
      mediaId: 'm1',
      name: 'Clip 1',
      type: 'video',
      start,
      duration,
      sourceStart: 0,
      sourceDuration: duration,
      volume: 1,
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      muted: false,
    }) as Clip;

  it('allows splitting when the playhead is inside the clip', () => {
    expect(canSplitAtTime([clip(0, 5)], 2)).toBe(true);
  });

  it('refuses to split when the playhead is outside every clip', () => {
    expect(canSplitAtTime([clip(0, 5)], 7)).toBe(false);
    expect(canSplitAtTime([], 2)).toBe(false);
  });

  it('keeps the 50 ms safety margin of the store', () => {
    expect(canSplitAtTime([clip(0, 5)], 0.02)).toBe(false);
    expect(canSplitAtTime([clip(0, 5)], 4.99)).toBe(false);
  });
});

describe('UI-39 · viewport classification', () => {
  it('keeps the desktop layout on the desktop viewports', () => {
    expect(isMobileViewport(1440, 900)).toBe(false);
    expect(isMobileViewport(1024, 768)).toBe(false);
    expect(isMobileViewport(768, 1024)).toBe(false);
  });

  it('uses the compact shell on the phone viewports', () => {
    expect(isMobileViewport(390, 844)).toBe(true);
    expect(isMobileViewport(320, 568)).toBe(true);
  });

  it('uses the compact shell on the short (landscape) viewports', () => {
    expect(isMobileViewport(844, 390)).toBe(true);
    expect(isMobileViewport(568, 320)).toBe(true);
  });
});
