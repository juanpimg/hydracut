# Project: HydraCut Studio — Stability, Robustness & Multi-Device Responsiveness

> **Nota de verificación (2026-10-20).** Este documento es la especificación de
> requisitos (R1–R6) del proyecto más el inventario de la ola de producto
> posterior, no un informe de estado. La petición original vive en
> `.agents/teamwork/ORIGINAL_REQUEST.md`. Para saber **qué está
> realmente verificado y con qué comando**, véase [`TEST_INFRA.md`](./TEST_INFRA.md):
> 795 tests de Vitest en 35 ficheros (`npm test`) y 140 checks en 5 suites del
> harness de navegador real (`npm run test:browser`). La suite E2E de 4 niveles
> prevista como `src/tests/e2e/` y el fichero `TEST_READY.md` nunca existieron.

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
| 18 | Internal Clipboard | `copyClips` / `pasteClips` / `duplicateClips` (`Ctrl+C/V/D`); relative layout kept, track compatibility, lock and overlap policy respected | M4 | `src/store/useProjectStore.ts`, `src/components/layout/MainLayout.tsx` (`resolveClipboardShortcut`) |
| 19 | Overlap Policy | Per-project `block` (default) / `overwrite` / `ripple`; every refusal sets `lastError`, shown in `StoreErrorBanner` (both layouts) | M4 | `src/store/useProjectStore.ts` (`DEFAULT_OVERLAP_POLICY`), `src/components/inspector/ClipInspector.tsx` |
| 20 | Media Trash | `removeMediaItem` moves media + clips to `project.trash` (reversible via `restoreFromTrash`); explicit purge (`purgeTrash` / `purgeTrashedMedia`) deletes OPFS blobs | M4 | `src/store/useProjectStore.ts`, `src/components/media/MediaBin.tsx` |
| 21 | Missing Media & Relink | `MediaItem.status` (`ok`/`missing`/`error`); "Medios ausentes" panel with `relinkMedia` against a local file | M4 | `src/types/project.ts`, `src/components/media/MediaBin.tsx` |
| 22 | Real Crossfade | Linear mix between adjacent clips (`crossfadeMix`); deliberate overlap distinguished from illegal via `isDeliberateCrossfadeOverlap()` | M4 | `src/core/utils/crossfade.ts`, store `createCrossfade`/`setCrossfadeDuration`/`removeCrossfade` |
| 23 | Per-Clip Audio Fades | `linear` / `equalPower` (default) gain envelope, frame-quantized; same envelope in preview (`previewClipFadeGain`) and export (`buildAudioFadeAutomation`) | M4 | `src/core/utils/audioFades.ts`, store `setAudioFade`/`clearAudioFades` |
| 24 | Per-Clip Color Filters | Brightness, contrast, saturation, temperature, grayscale, sepia + 7 presets; applied by `Compositor`, identical in preview and export | M4 | `src/core/utils/colorFilters.ts` (`COLOR_FILTER_PRESETS`) |
| 25 | Coherent Speed & Pitch | `resolvePlayback()` single source of truth; `detuneCents = -1200·log2(rate)` when preserving pitch | M4 | `src/core/utils/playbackRate.ts` |
| 26 | Transform Keyframes | `x`, `y`, `scale`, `opacity` with linear interpolation (`evaluateKeyframes`), frame-quantized relative time | M4 | `src/core/utils/keyframes.ts`, store `addKeyframe`/`updateKeyframe`/`removeKeyframe`/`clearKeyframes` |
| 27 | Multi-Select & Batch | `Ctrl+clic`, `Mayús+clic`, rubber-band rect, `Ctrl+A`; batch volume/opacity/speed/mute + delete with a single undo | M4 | `src/store/useProjectStore.ts`, `src/components/timeline/Timeline.tsx`, `src/components/timeline/ClipItem.tsx` |
| 28 | Export Presets & Range | 4 one-click presets (`EXPORT_PRESETS`) + in/out range (`full`/`custom`, `HH:MM:SS:FF` label, `rebaseClipsToRange`) | M4 | `src/components/export/ExportModal.tsx` |
| 29 | Backup with Embedded Media | `.hydra` embeds media bytes up to `MAX_EMBEDDED_MEDIA_BYTES` (64 MB); reported import (`importProjectFromFileWithReport`) | M4 | `src/core/storage/projectStorage.ts`, `src/components/media/MediaBin.tsx` |
| 30 | Storage Manager | Real browser quota (`readStorageEstimate`), usage summary (`summarizeStorageUsage`), two-step trash purge | M4 | `src/core/storage/projectStorage.ts`, `src/components/media/MediaBin.tsx` |
| 31 | Full Mobile Parity | Master volume, ±1 frame (`stepFrame`), 4× speed, `fade-white` — same engine calls as desktop | M4 | `src/components/mobile/MobilePreviewPlayer.tsx`, `src/tests/mobile-parity.test.ts` |
| 32 | Display-Resolution Rendering | Preview rasterizes to screen size × `devicePixelRatio` (`computeRenderScale`), not fixed 1920×1080 | M4 | `src/core/engine/Compositor.ts`, `src/tests/render-scale.test.ts` |
| 33 | Real-Browser Test Harness | 5 suites, 140 checks (`npm run test:browser`); quality guard against lying tests | M4 | `src/tests/browser/`, `src/tests/quality-guard.test.ts` |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Audio Engine & Media Export Defensive Safeguards | R1, R2: MasterClock, AudioEngine, PreviewPlayer, sampleMedia, webcodecsExporter | none | COMPLETED (verificado por vitest + navegador, 2026-10-20) |
| M2 | Responsive Layouts, Tablet Header & Media Touch Accessibility | R3, R4, R5, R6: Timeline, TimelineToolbar, useIsMobile, MainLayout, MobileCapCutLayout, Header, MediaItemCard | none | COMPLETED (verificado por vitest + harness layout 92 checks, 2026-10-20) |
| M3 | Final Acceptance & E2E Test Pass | 100% E2E test pass, production build verification, multi-device criteria | M1, M2, E2E Testing Track | COMPLETED: 795/795 vitest, 140/140 checks de navegador, `tsc` limpio y `npm run build` en verde (2026-10-20) |
| M4 | Product Features Wave | Clipboard, overlap policy, trash, missing/relink, crossfade, audio fades, color filters, speed/pitch, keyframes, multi-select, export presets+range, backup con medios, storage manager, mobile parity, display-resolution rendering | M1, M2 | COMPLETED: cada función con suite vitest propia + 22 checks `features` en navegador (2026-10-20) |
| E2E | E2E Testing Track | Suites reales: 35 ficheros vitest (`src/tests/*.test.ts`) + harness de 5 suites (`src/tests/browser/`, `npm run test:browser`). ⚠️ La suite prevista como `src/tests/e2e/` (4 tiers) **nunca se creó**. Ver `TEST_INFRA.md`. | none | COMPLETED |

## Code Layout
- `src/core/engine/MasterClock.ts` (Owned by M1)
- `src/core/engine/AudioEngine.ts` (Owned by M1)
- `src/core/utils/sampleMedia.ts` (Owned by M1)
- `src/core/export/webcodecsExporter.ts` (Owned by M1)
- `src/components/player/PreviewPlayer.tsx` (Owned by M1)
- `src/components/mobile/MobilePreviewPlayer.tsx` (Owned by M1, M4 parity)
- `src/components/timeline/Timeline.tsx` (Owned by M2, M4 rubber-band + Ctrl+A)
- `src/components/timeline/TimelineToolbar.tsx` (Owned by M2)
- `src/hooks/useIsMobile.ts` (Owned by M2)
- `src/components/layout/MainLayout.tsx` (Owned by M2, M4 clipboard shortcuts + StoreErrorBanner)
- `src/components/mobile/MobileCapCutLayout.tsx` (Owned by M2)
- `src/components/layout/Header.tsx` (Owned by M2)
- `src/components/media/MediaItemCard.tsx` (Owned by M2)
- `src/store/useProjectStore.ts` — clipboard, overlap, trash, multi-select, crossfade, fades, keyframes (Owned by M4)
- `src/core/utils/crossfade.ts`, `audioFades.ts`, `colorFilters.ts`, `keyframes.ts`, `playbackRate.ts`, `masterVolume.ts` (Owned by M4)
- `src/components/export/ExportModal.tsx` — presets + range (Owned by M4)
- `src/components/inspector/ClipInspector.tsx` — fades, crossfade, filters, keyframes, overlap policy (Owned by M4)
- `src/components/media/MediaBin.tsx` — trash, missing/relink, backup, storage manager (Owned by M4)
- `src/core/storage/projectStorage.ts` — embedded backup (64 MB), quota/trash (Owned by M4)
- `src/tests/` — 35 suites unitarias y de integración de Vitest (`*.test.ts`), la guarda de calidad `quality-guard.test.ts` y el harness E2E de navegador (`src/tests/browser/` con 5 suites, ejecutado con `npm run test:browser`).

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

### Playback Speed & Pitch ↔ Inspector, Preview & Exporter
- `resolvePlayback(clip?: PlaybackOptions | null): ResolvedPlayback` (`src/core/utils/playbackRate.ts`) — single source of truth. Returns `{ rate, preservesPitch, detuneCents }` (effective rate clamped to [0.0625, 4]); `detuneCents = -1200 * log2(rate)` when pitch is preserved, `0` otherwise. `preservePitch: undefined` means "preserve" (backwards compatibility).

### Clipboard, Selection & Overlap ↔ Timeline & Inspector
- `copyClips(clipIds: string[]): number` / `pasteClips(trackId?: string, atTime?: number): string[]` / `duplicateClips(clipIds: string[]): string[]` — paste targets the requested track (or a compatible fallback) at the playhead; refusals set `lastError`.
- `selectClip(clipId: string | null, options?: { additive?: boolean; range?: boolean }): void` — `additive` (Ctrl+clic) sums, `range` (Mayús+clic) selects the track range; `selectAllClips()` selects everything.
- `setOverlapPolicy(policy: OverlapPolicy): void` — `block` is the default (`DEFAULT_OVERLAP_POLICY`); refusals publish the reason in `lastError`, rendered by `StoreErrorBanner` in both layouts.

### Export Presets & Range ↔ Export Modal
- `EXPORT_PRESETS: ExportPreset[]` — 4 presets (Web 720p, Social 1080p, Vertical 9:16, Alta calidad 1080p60); `computeExportDimensions(resolution, aspectRatio)` always returns even sizes; `findActivePreset(settings)` derives the active preset.
- `formatExportRange(range, fps): string` — `"Exportando HH:MM:SS:FF → HH:MM:SS:FF (N s)"`; `buildRangeExportClips(…rangeStart, rangeEnd)` re-bases and trims clips into the range.

### Backup & Storage ↔ Media Bin
- `MAX_EMBEDDED_MEDIA_BYTES = 64 * 1024 * 1024` — `.hydra` embeds media bytes up to 64 MB, exports without them (with a warning) above it.
- `exportProjectToFile(project, format)` / `importProjectFromFileWithReport(file): Promise<ImportReport>` — backup and reported restore.
- `readStorageEstimate()` / `buildQuotaSnapshot(usage, quota)` / `summarizeStorageUsage(projectCount, { mediaPool, trash })` / `formatStorageBytes(bytes)` — storage manager data.
