import { useCallback, useEffect, useRef, useState } from 'react';
import {
  computeAnchoredMenuPosition,
  toAnchorRect,
  type AnchoredMenuOptions,
  type AnchoredMenuPosition,
} from '../components/layout/overlayGeometry';

/**
 * Positions an anchored menu (popover) with `position: fixed` so that it can
 * never be clipped by an ancestor with `overflow: hidden` / `overflow-x: auto`
 * (audit UI-01, UI-02, UI-03).
 *
 * The menu itself is rendered by the caller inside a React portal; this hook
 * only owns the geometry and keeps it up to date while the menu is open.
 */
export interface UseAnchoredMenuOptions extends AnchoredMenuOptions {
  /** Fixed width of the menu, in px. */
  menuWidth: number;
  /** Fixed height of the menu, in px (used to decide the placement). */
  menuHeight: number;
}

export interface UseAnchoredMenuResult {
  /** Position to apply to the portaled menu, or `null` while it is closed. */
  position: AnchoredMenuPosition | null;
  /** Recomputes the position on demand. */
  update: () => void;
}

export function useAnchoredMenu(
  isOpen: boolean,
  triggerRef: React.RefObject<HTMLElement>,
  options: UseAnchoredMenuOptions
): UseAnchoredMenuResult {
  const [position, setPosition] = useState<AnchoredMenuPosition | null>(null);

  // Kept in a ref so that an inline options object never invalidates `update`.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const update = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') return;

    const rect = trigger.getBoundingClientRect();
    const { menuWidth, menuHeight, ...anchoring } = optionsRef.current;

    setPosition(
      computeAnchoredMenuPosition(
        toAnchorRect(rect),
        { width: menuWidth, height: menuHeight },
        { width: window.innerWidth, height: window.innerHeight },
        anchoring
      )
    );
  }, [triggerRef]);

  useEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }

    update();

    const onViewportChange = () => update();
    window.addEventListener('resize', onViewportChange);
    // `capture: true` also catches the scrolls of any scrollable ancestor.
    window.addEventListener('scroll', onViewportChange, true);

    return () => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [isOpen, update]);

  return { position, update };
}
