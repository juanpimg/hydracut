import { useState, useEffect } from 'react';

/**
 * Height under which the app switches to the compact (CapCut-like) shell.
 */
export const COMPACT_HEIGHT = 500;

/**
 * Pure viewport classification.
 *
 * A viewport is "mobile" when it is narrower than the breakpoint **or** when
 * it is short (landscape phone / small window), which keeps the compact
 * shell on 844×390 and 568×320.
 */
export function isMobileViewport(
  width: number,
  height: number,
  breakpoint: number = 768,
  compactHeight: number = COMPACT_HEIGHT
): boolean {
  return width < breakpoint || height <= compactHeight;
}

/**
 * Hook to detect mobile viewports (< 768px) and mobile landscape (height <= 500px).
 * Uses window.matchMedia and resize listener for performant event-driven updates.
 */
export function useIsMobile(breakpoint: number = 768): boolean {
  const checkIsMobile = () => {
    if (typeof window === 'undefined') return false;
    return isMobileViewport(window.innerWidth, window.innerHeight, breakpoint);
  };

  const [isMobile, setIsMobile] = useState<boolean>(checkIsMobile);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia(`(max-width: ${breakpoint - 1}px), (max-height: ${COMPACT_HEIGHT}px)`);
    
    const updateMatch = () => {
      setIsMobile(checkIsMobile());
    };

    // Set initial
    setIsMobile(checkIsMobile());

    // Listen to media query changes
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', updateMatch);
    } else {
      // Fallback for older browsers
      mediaQuery.addListener(updateMatch);
    }

    // Also listen to window resize events for immediate updates
    window.addEventListener('resize', updateMatch);

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', updateMatch);
      } else {
        mediaQuery.removeListener(updateMatch);
      }
      window.removeEventListener('resize', updateMatch);
    };
  }, [breakpoint]);

  return isMobile;
}

/**
 * Hook to detect reduced window height / landscape mode (height <= maxHeight).
 */
export function useIsCompactHeight(maxHeight: number = COMPACT_HEIGHT): boolean {
  const check = () => {
    if (typeof window === 'undefined') return false;
    return window.innerHeight <= maxHeight;
  };

  const [isCompact, setIsCompact] = useState<boolean>(check);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const query = window.matchMedia(`(max-height: ${maxHeight}px)`);
    const update = () => setIsCompact(check());

    setIsCompact(check());

    if (query.addEventListener) {
      query.addEventListener('change', update);
    } else {
      query.addListener(update);
    }
    window.addEventListener('resize', update);

    return () => {
      if (query.removeEventListener) {
        query.removeEventListener('change', update);
      } else {
        query.removeListener(update);
      }
      window.removeEventListener('resize', update);
    };
  }, [maxHeight]);

  return isCompact;
}
