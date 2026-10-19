# Project: HydraCut Studio — Stability, Robustness & Multi-Device Responsiveness

> **Nota de verificación (2026-10-19).** Este documento es la especificación de
> requisitos (R1–R6) del proyecto, no un informe de estado. La petición original
> vive en `.agents/teamwork/ORIGINAL_REQUEST.md`. Para saber **qué está
> realmente verificado y con qué comando**, véase [`TEST_INFRA.md`](./TEST_INFRA.md):
> las suites de Vitest (`npm test`) y el harness de navegador real
> (`npm run test:browser`). La suite E2E de 4 niveles prevista como
> `src/tests/e2e/` y el fichero `TEST_READY.md` nunca existieron.

## Architecture
HydraCut Studio is a web-based non-linear video editor built with React, TypeScript, Tailwind CSS, Zustand, and WebCodecs/Web Audio.
Key subsystems:
- **Audio & Timing**: `MasterClock` coordinates timeline playback; `AudioEngine` controls audio clips and Web Audio context.
- **Preview & Rendering**: `PreviewPlayer` (desktop) and `MobilePreviewPlayer` (mobile) render video canvas and sync audio.
- **Export & Sample Media**: `webcodecsExporter` performs hardware-accelerated video export with `MediaRecorder` fallback; `sampleMedia` provides default assets.
- **Responsive Layout**: `useIsMobile` routes between desktop (`MainLayout`) and mobile (`MobileCapCutLayout`).
- **Timeline**: `Timeline` and `TimelineToolbar` display tracks, clips, and editing controls.
- **Header**: Top navigation bar with project title, ratio selector, undo/redo, shortcuts, and export triggers.
- **Media Bin**: Asset library containing `MediaItemCard` elements with drag/drop, keyboard, and touch capabilities.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Web Audio API Fault Tolerance | Safe AudioContext creation, state checking, suspended handling, and graceful degradation without throwing | M1 | ORIGINAL_REQUEST § R1 |
| 2 | MasterClock Fallback Timing | Dual-clock fallback using `performance.now()` when Web Audio is missing or suspended, preventing timeline freeze | M1 | ORIGINAL_REQUEST § R1 |
| 3 | AudioEngine Null-Safe Graph | Safe gain node creation and null-safe `updateAudio()` preventing unhandled exceptions from unmounting React | M1 | ORIGINAL_REQUEST § R1 |
| 4 | PreviewPlayer Clean Unmount | Explicit pause and `audioEngine.stopAll()` on component unmount in PreviewPlayer and MobilePreviewPlayer | M1 | ORIGINAL_REQUEST § R1 |
| 5 | Defensive Canvas CaptureStream | Explicit capability detection for `captureStream` in `sampleMedia` and `webcodecsExporter` | M1 | ORIGINAL_REQUEST § R2 |
| 6 | MediaRecorder Cross-Browser Fallback | Safe `MediaRecorder.isTypeSupported` checks including `video/mp4` for Safari/iOS compatibility | M1 | ORIGINAL_REQUEST § R2 |
| 7 | Sample Media Graceful Degradation | Fallback asset generation (audio chime + color cards) when video recording is unsupported | M1 | ORIGINAL_REQUEST § R2 |
| 8 | Informative Video Export Fallback | Actionable error messages in Spanish when real-time canvas capture is unsupported | M1 | ORIGINAL_REQUEST § R2 |
| 9 | Mobile Timeline Strict Flex Containment | Apply `w-full max-w-full min-w-0` to `Timeline` container to prevent layout blowing out parent width | M2 | ORIGINAL_REQUEST § R3 |
| 10 | TimelineToolbar Narrow Viewport Adaptation | Compact button spacing, conditional visibility of duplicate controls on < 480px, guaranteeing `scrollWidth === clientWidth` (320px–471px) | M2 | ORIGINAL_REQUEST § R3 |
| 11 | Mobile Landscape Detection in `useIsMobile` | Detect viewport height <= 500px and landscape orientation `(max-height: 500px)` | M2 | ORIGINAL_REQUEST § R4 |
| 12 | Landscape Canvas Dimension Guarantee | Compact timeline and toolbars in landscape/reduced height, guaranteeing the player monitor keeps a usable visible height (container `min-h-[140px]` in compact mode, `min-h-[180px]` in portrait) | M2 | ORIGINAL_REQUEST § R4 |
| 13 | Touch Interaction in MediaItemCard | Direct `onClick` addition to timeline from card container, without requiring hover or HTML5 Drag & Drop | M2 | ORIGINAL_REQUEST § R5 |
| 14 | Event Propagation Control in Media Cards | `e.stopPropagation()` on nested buttons (`Plus`, `Trash2`) to avoid accidental timeline addition on deletion | M2 | ORIGINAL_REQUEST § R5 |
| 15 | Always-Visible Mobile Media Actions | The quick-action overlay stays visible on devices without hover (`[@media(hover:none)]`) and the "Añadir" button is shown below 768 px (`hidden max-[767px]:flex`); it used to be `md:hidden`, which hid it on touch tablets | M2 | ORIGINAL_REQUEST § R5 |
| 16 | Tablet Header Adaptive Containment | Horizontal scroll contained in the header (`overflow-x-auto no-scrollbar`), compact project input (`w-32 sm:w-44 md:w-52`) and labels hidden below their breakpoint (`hidden sm:inline` / `hidden md:inline`) | M2 | ORIGINAL_REQUEST § R6 |
| 17 | E2E Acceptance Verification | Pass 100% of E2E tests covering R1–R6, clean `npm run build`, and multi-device criteria (harness de navegador en `src/tests/browser/`) | M3 | ORIGINAL_REQUEST Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Audio Engine & Media Export Defensive Safeguards | R1, R2: MasterClock, AudioEngine, PreviewPlayer, sampleMedia, webcodecsExporter | none | IN_PROGRESS |
| M2 | Responsive Layouts, Tablet Header & Media Touch Accessibility | R3, R4, R5, R6: Timeline, TimelineToolbar, useIsMobile, MainLayout, MobileCapCutLayout, Header, MediaItemCard | none | IN_PROGRESS |
| M3 | Final Acceptance & E2E Test Pass | 100% E2E test pass, production build verification, multi-device criteria | M1, M2, E2E Testing Track | PLANNED |
| E2E | E2E Testing Track | Opaque-box test suite covering R1–R6. ⚠️ La suite prevista como `src/tests/e2e/` (4 tiers) **nunca se creó**: la verificación real son las suites de Vitest (`src/tests/*.test.ts`) y el harness de navegador (`src/tests/browser/`, `npm run test:browser`). Ver `TEST_INFRA.md`. | none | IN_PROGRESS |

## Code Layout
- `src/core/engine/MasterClock.ts` (Owned by M1)
- `src/core/engine/AudioEngine.ts` (Owned by M1)
- `src/core/utils/sampleMedia.ts` (Owned by M1)
- `src/core/export/webcodecsExporter.ts` (Owned by M1)
- `src/components/player/PreviewPlayer.tsx` (Owned by M1)
- `src/components/mobile/MobilePreviewPlayer.tsx` (Owned by M1)
- `src/components/timeline/Timeline.tsx` (Owned by M2)
- `src/components/timeline/TimelineToolbar.tsx` (Owned by M2)
- `src/hooks/useIsMobile.ts` (Owned by M2)
- `src/components/layout/MainLayout.tsx` (Owned by M2)
- `src/components/mobile/MobileCapCutLayout.tsx` (Owned by M2)
- `src/components/layout/Header.tsx` (Owned by M2)
- `src/components/media/MediaItemCard.tsx` (Owned by M2)
- `src/tests/` — Suites unitarias y de integración de Vitest (`*.test.ts`), la guarda de calidad `quality-guard.test.ts` y el harness E2E de navegador (`src/tests/browser/`, ejecutado con `npm run test:browser`).

## Interface Contracts
### MasterClock ↔ AudioEngine & Players
- `masterClock.getAudioContext(): AudioContext | null` — returns null if AudioContext is unsupported or cannot be created. Never throws.
- `masterClock.getTime(): number` — returns current timeline time in seconds. Uses audioCtx time if available, otherwise falls back to `performance.now()`. Never freezes.
- `audioEngine.updateAudio(time: number, isPlaying: boolean, ...)` — returns void. Catches internal audio errors and never throws into React call stack.
- `audioEngine.stopAll(): void` — stops all playing audio elements and resets nodes. Called on player unmount.

### SampleMedia & Exporter ↔ Media Gallery & Export Modal
- `isCanvasCaptureSupported(): boolean` — checks `typeof HTMLCanvasElement !== 'undefined' && ('captureStream' in HTMLCanvasElement.prototype || 'webkitCaptureStream' in HTMLCanvasElement.prototype)`.
- `getSupportedVideoMimeType(): string | null` — evaluates candidates `video/webm;codecs=vp9`, `video/webm;codecs=vp8`, `video/webm`, `video/mp4;codecs=avc1`, `video/mp4`. Returns null if none supported.
- `createPresetMediaItems(): Promise<MediaItem[]>` — returns array of preset items. If video generation is unsupported, generates fallback image cards and audio clips. Never throws or returns empty.
