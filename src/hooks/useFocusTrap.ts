import { useEffect, useRef, type RefObject } from 'react';

/**
 * Shared focus-management primitives for every overlay of the app
 * (ProjectsModal, WelcomeModal, ShortcutsModal and MobileBottomSheet).
 *
 * Audit UI-08: all four overlays declared `role="dialog" aria-modal="true"`
 * but never moved the focus inside, never trapped it and never restored it,
 * so `Tab` walked into the page behind the dialog and closing it dropped the
 * focus on `<body>`.
 *
 * The DOM-independent part of the logic lives in the exported pure helpers
 * below so it can be unit tested without a browser.
 */

/** Selector matching every element that can receive keyboard focus. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * What the focus trap has to do for a given key press.
 *
 * - `focus`         → move the focus to `focusables[index]`.
 * - `focus-container`→ there is nothing focusable inside: keep the focus on the
 *                     dialog container itself (and swallow the key).
 * - `null`          → let the browser handle the key normally.
 */
export type FocusTrapAction =
  | { type: 'focus'; index: number }
  | { type: 'focus-container' }
  | null;

/**
 * Pure decision function behind the `Tab` / `Shift+Tab` trap.
 *
 * @param key          the pressed key
 * @param shiftKey     whether `Shift` is held
 * @param focusableCount how many focusable elements the trap contains
 * @param activeIndex  index of the focused element inside the trap, or -1 when
 *                     the focus currently sits outside of it
 */
export function resolveFocusTrapAction(
  key: string,
  shiftKey: boolean,
  focusableCount: number,
  activeIndex: number
): FocusTrapAction {
  if (key !== 'Tab') return null;
  if (focusableCount <= 0) return { type: 'focus-container' };

  // The focus escaped the dialog (or nothing is focused): pull it back in.
  if (activeIndex < 0 || activeIndex >= focusableCount) {
    return { type: 'focus', index: shiftKey ? focusableCount - 1 : 0 };
  }

  const last = focusableCount - 1;
  if (shiftKey && activeIndex === 0) return { type: 'focus', index: last };
  if (!shiftKey && activeIndex === last) return { type: 'focus', index: 0 };
  return null;
}

/** True when the element is rendered and can be focused. */
export function isFocusableElement(el: Element): boolean {
  const html = el as HTMLElement;
  if (!html || html.hidden) return false;
  if (html.getAttribute?.('aria-hidden') === 'true') return false;
  if (typeof html.getClientRects === 'function') return html.getClientRects().length > 0;
  return true;
}

/** All the focusable elements inside `root`, in DOM order. */
export function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const found = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return found.filter(isFocusableElement);
}

/**
 * Index of the element that should receive the focus when a dialog opens.
 * `-1` means "focus the dialog container itself".
 */
export function resolveInitialFocusIndex(focusableCount: number): number {
  return focusableCount > 0 ? 0 : -1;
}

export interface FocusTrapOptions {
  /** Called when `Escape` is pressed inside the dialog. */
  onEscape?: () => void;
  /** Element that must receive the focus instead of the first focusable one. */
  initialFocus?: HTMLElement | null;
  /** Restore the focus to the element that opened the dialog. Default `true`. */
  restoreFocus?: boolean;
  /** Hide the rest of the app from assistive tech (`aria-hidden` + `inert`). Default `true`. */
  hideBackground?: boolean;
  /** Move the focus into the dialog when it opens. Default `true`. */
  autoFocus?: boolean;
}

/**
 * Collects every element that has to be hidden while `dialog` is open: the
 * siblings of the dialog and of each one of its ancestors (never an ancestor
 * itself, because hiding an ancestor would hide the dialog too).
 */
export function collectBackgroundElements(dialog: HTMLElement | null): HTMLElement[] {
  if (!dialog) return [];
  const result: HTMLElement[] = [];
  let node: HTMLElement | null = dialog;

  while (node && node.parentElement) {
    const parent: HTMLElement = node.parentElement;
    for (const child of Array.from(parent.children)) {
      if (child !== node && child instanceof HTMLElement) result.push(child);
    }
    if (parent === document.body) break;
    node = parent;
  }

  return Array.from(new Set(result));
}

/** Hides the background and returns the function that restores it. */
function hideBackground(dialog: HTMLElement | null): () => void {
  const elements = collectBackgroundElements(dialog);
  const restore: (() => void)[] = [];

  for (const el of elements) {
    const previousAriaHidden = el.getAttribute('aria-hidden');
    const previousInert = 'inert' in HTMLElement.prototype ? (el as HTMLElement & { inert: boolean }).inert : undefined;

    el.setAttribute('aria-hidden', 'true');
    if (previousInert !== undefined) (el as HTMLElement & { inert: boolean }).inert = true;

    restore.push(() => {
      if (previousAriaHidden === null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', previousAriaHidden);
      if (previousInert !== undefined) (el as HTMLElement & { inert: boolean }).inert = previousInert;
    });
  }

  return () => {
    for (const fn of restore) fn();
  };
}

/**
 * Moves the focus between the items of a composite widget (a `menu`, a
 * `radiogroup`, a `tablist`…).
 *
 * Audit UI-14: the menus and the radio groups declared their ARIA role but
 * were not keyboard navigable at all.
 */
export function moveFocusWithin(
  root: HTMLElement | null,
  selector: string,
  direction: 'next' | 'prev' | 'first' | 'last'
): boolean {
  if (!root) return false;
  const items = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(isFocusableElement);
  if (items.length === 0) return false;

  const active = document.activeElement as HTMLElement | null;
  const currentIndex = active ? items.indexOf(active) : -1;

  let nextIndex: number;
  switch (direction) {
    case 'first':
      nextIndex = 0;
      break;
    case 'last':
      nextIndex = items.length - 1;
      break;
    case 'next':
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
      break;
    case 'prev':
      nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
      break;
  }

  items[nextIndex]?.focus?.();
  return true;
}

/**
 * Traps the keyboard focus inside a dialog.
 *
 * @param isOpen   whether the dialog is currently rendered
 * @param options  see {@link FocusTrapOptions}
 * @returns the ref that must be attached to the dialog container
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  isOpen: boolean,
  options: FocusTrapOptions = {}
): RefObject<T> {
  const containerRef = useRef<T>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // The options are read through a ref so that an inline `onEscape` callback
  // (new identity on every render) never restarts the effect: restarting it
  // would hide/unhide the background and steal the focus again and again.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!isOpen) return;

    const {
      onEscape,
      initialFocus,
      restoreFocus = true,
      hideBackground: shouldHideBackground = true,
      autoFocus = true,
    } = optionsRef.current;

    const container = containerRef.current;

    // Remember the trigger so the focus can be given back on close.
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // The focus has to be inside the dialog *before* the background is
    // hidden, otherwise the browser drops the focus when it becomes inert.
    if (autoFocus) {
      const preferred =
        initialFocus && container && container.contains(initialFocus) ? initialFocus : null;
      const focusables = getFocusableElements(container);
      const index = resolveInitialFocusIndex(focusables.length);
      const target = preferred ?? (index >= 0 ? focusables[index] : container);
      // `requestAnimationFrame` guarantees the element is laid out (and not
      // hidden behind an entrance animation) before it receives the focus.
      const raf =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(() => target?.focus?.())
          : null;
      if (raf === null) target?.focus?.();
    }

    const restoreBackground = shouldHideBackground ? hideBackground(container) : () => {};

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (onEscape) {
          // Stop the global shortcuts (MainLayout) from reacting as well.
          event.preventDefault();
          event.stopPropagation();
          onEscape();
        }
        return;
      }

      if (event.key !== 'Tab') return;

      const focusables = getFocusableElements(container);
      const active = document.activeElement as HTMLElement | null;
      const activeIndex = active ? focusables.indexOf(active) : -1;
      const action = resolveFocusTrapAction(event.key, event.shiftKey, focusables.length, activeIndex);

      if (!action) return;
      event.preventDefault();
      if (action.type === 'focus-container') {
        container?.focus?.();
      } else {
        focusables[action.index]?.focus?.();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      restoreBackground();

      if (restoreFocus) {
        const previous = restoreFocusRef.current;
        if (previous && previous.isConnected && typeof previous.focus === 'function') {
          previous.focus();
        }
      }
      restoreFocusRef.current = null;
    };
  }, [isOpen]);

  return containerRef;
}
