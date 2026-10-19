/**
 * Pure geometry helpers for anchored (popover) menus.
 *
 * Why this exists: three different menus in the app were rendered inside an
 * ancestor with `overflow: hidden` / `overflow-x: auto`, so CSS clipped them to
 * 0–1 px and they became physically unclickable (audit UI-01, UI-02, UI-03).
 * The fix is to render those menus in a portal on `document.body` and position
 * them with `position: fixed`. The positioning math lives here, free of React
 * and of the DOM, so it can be unit tested in the node environment.
 */

export interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export type MenuAlignment = 'start' | 'center' | 'end';
export type MenuPlacement = 'bottom' | 'top';

export interface AnchoredMenuOptions {
  /** Space between the anchor and the menu, in px. */
  gap?: number;
  /** Minimum distance kept between the menu and the viewport edges, in px. */
  padding?: number;
  /** Horizontal alignment of the menu against the anchor. */
  align?: MenuAlignment;
  /** Preferred vertical placement; flipped automatically when it does not fit. */
  preferredPlacement?: MenuPlacement;
}

export interface AnchoredMenuPosition {
  /** `top` offset for a `position: fixed` menu. */
  top: number;
  /** `left` offset for a `position: fixed` menu. */
  left: number;
  /** Vertical placement actually used. */
  placement: MenuPlacement;
  /** Space available for the menu; the menu must scroll when it is smaller. */
  maxHeight: number;
}

/** Clamps `value` into the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Computes where an anchored menu has to be rendered so that it is always
 * inside the viewport and never covered by the anchor.
 *
 * The returned `maxHeight` is the room actually available for the menu: when
 * the menu is taller, it must be rendered with `overflow-y: auto` instead of
 * being clipped by the viewport.
 */
export function computeAnchoredMenuPosition(
  anchor: AnchorRect,
  menu: Size,
  viewport: Viewport,
  options: AnchoredMenuOptions = {}
): AnchoredMenuPosition {
  const gap = options.gap ?? 4;
  const padding = options.padding ?? 8;
  const align: MenuAlignment = options.align ?? 'end';
  const preferred: MenuPlacement = options.preferredPlacement ?? 'bottom';

  // --- horizontal ---------------------------------------------------
  let left: number;
  if (align === 'start') left = anchor.left;
  else if (align === 'center') left = anchor.left + anchor.width / 2 - menu.width / 2;
  else left = anchor.right - menu.width;

  left = clamp(left, padding, Math.max(padding, viewport.width - menu.width - padding));

  // --- vertical -----------------------------------------------------
  const spaceBelow = viewport.height - anchor.bottom - gap - padding;
  const spaceAbove = anchor.top - gap - padding;
  const fitsBelow = spaceBelow >= menu.height;
  const fitsAbove = spaceAbove >= menu.height;

  let placement: MenuPlacement;
  if (preferred === 'top' && fitsAbove) placement = 'top';
  else if (fitsBelow) placement = 'bottom';
  else if (fitsAbove) placement = 'top';
  else placement = spaceBelow >= spaceAbove ? 'bottom' : 'top';

  const available = Math.max(0, placement === 'bottom' ? spaceBelow : spaceAbove);
  const height = Math.min(menu.height, available);

  let top = placement === 'bottom' ? anchor.bottom + gap : anchor.top - gap - height;
  top = clamp(top, padding, Math.max(padding, viewport.height - height - padding));

  return { top, left, placement, maxHeight: available };
}

/**
 * Converts a `DOMRect` (or any rect-like object) into the plain shape used by
 * {@link computeAnchoredMenuPosition}.
 */
export function toAnchorRect(rect: {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}): AnchorRect {
  return {
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}
