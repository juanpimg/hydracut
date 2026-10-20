/**
 * Canonical transition options, shared by the desktop inspector and the
 * mobile transition sheet.
 *
 * The desktop `ClipInspector` selects and the mobile `MobileCapCutLayout`
 * sheets used to declare their own option lists: the mobile one drifted
 * (it missed the `slide-left` out and the `wipe-right` in variants, so a
 * mobile user could not apply a transition a desktop user could). There is
 * exactly one list now — the desktop labels are authoritative — and both
 * shells render FROM it.
 */

import type { TransitionType } from '../../types/project';

export interface TransitionOption {
  id: TransitionType;
  label: string;
}

/**
 * Every transition the app offers, in picker order. Keep in sync with the
 * `TransitionType` union of `src/types/project.ts`.
 */
export const TRANSITION_OPTIONS: readonly TransitionOption[] = [
  { id: 'none', label: 'Ninguno' },
  { id: 'fade-black', label: 'Fundido a Negro' },
  { id: 'fade-white', label: 'Fundido a Blanco' },
  { id: 'slide-left', label: 'Deslizar (Slide)' },
  { id: 'wipe-right', label: 'Cortina (Wipe)' },
];

/** Fade-in picker options (the full canonical set). */
export const FADE_IN_OPTIONS: readonly TransitionOption[] = TRANSITION_OPTIONS;

/** Fade-out picker options (the full canonical set). */
export const FADE_OUT_OPTIONS: readonly TransitionOption[] = TRANSITION_OPTIONS;

/**
 * Fail-fast parity check for option lists that intentionally mirror the
 * canonical set (e.g. the mobile pickers until every shell imports the
 * constants above directly): throws when the ids or the labels drift, so a
 * silent capability gap can never ship again.
 */
export function assertTransitionOptionsParity(
  name: string,
  options: readonly TransitionOption[]
): void {
  const inSync =
    options.length === TRANSITION_OPTIONS.length &&
    options.every(
      (opt, index) =>
        opt.id === TRANSITION_OPTIONS[index].id &&
        opt.label === TRANSITION_OPTIONS[index].label
    );
  if (!inSync) {
    throw new Error(
      `${name} ha divergido de TRANSITION_OPTIONS: actualiza la lista o importa FADE_IN_OPTIONS / FADE_OUT_OPTIONS directamente.`
    );
  }
}
