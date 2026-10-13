# TEST_INFRA — HydraCut Studio Test Architecture & E2E Testing Framework

## 1. Overview & Objectives

This document establishes the comprehensive 4-tier test architecture and verification framework for **HydraCut Studio**, addressing the stability, robustness, and multi-device responsiveness requirements (R1 through R6) defined in `ORIGINAL_REQUEST.md` and specified in `PROJECT.md`.

The testing infrastructure guarantees:
- **Opaque-Box Verification**: Tests validate observable contracts, behaviors, state transitions, and layout invariants derived strictly from authoritative specifications (`ORIGINAL_REQUEST.md` and `PROJECT.md`), avoiding coupling to fragile internal implementation details.
- **Complete 4-Tier Coverage**: Systematic partitioning from single-feature contracts (Tier 1), boundary/extreme stress conditions (Tier 2), cross-subsystem pairwise interactions (Tier 3), to real-world multi-device editing workflows (Tier 4).
- **Strict Isolation**: Every test is self-contained with independent state setup in `beforeEach`, clean mock restoration in `afterEach`, and zero test order dependencies.
- **Deterministic CI Execution**: Native execution through the project's standard test runner (`npm test` via Vitest) and type validation via `tsc`.

---

## 2. 4-Tier Test Architecture

```
+-----------------------------------------------------------------------+
|  Tier 4: Real-World Scenarios (End-to-End Workloads)                  |
|  - Complete iPhone SE, iPhone 13 Landscape, iPad 768px sessions       |
|  - Safari iOS WebKit media ingestion & export                         |
|  - Live orientation rotation during active playback                   |
+-----------------------------------------------------------------------+
                                  ▲
+-----------------------------------------------------------------------+
|  Tier 3: Pairwise Cross-Feature Combinations                          |
|  - Audio playback while resizing landscape <-> portrait (R1 x R4)     |
|  - Touch addition during headless audio engine run (R1 x R5)          |
|  - Export trigger on mobile landscape without captureStream (R2 x R4) |
|  - Narrow timeline scrubbing under suspended audio (R1 x R3)          |
|  - Media touch add on tablet layout followed by export check (R5 x R6)|
+-----------------------------------------------------------------------+
                                  ▲
+-----------------------------------------------------------------------+
|  Tier 2: Boundary & Corner Cases (>=5 per feature)                    |
|  - R1: Thrown constructors, rapid play/pause spam, extreme gain/vol   |
|  - R2: Missing APIs, corrupt media, single-pixel canvas, zero duration|
|  - R3: 320x568 min viewport, 471px breakpoint edge, 50+ clip scroll   |
|  - R4: 500px boundary height, 926x390 ultrawide, 250px crushed height |
|  - R5: 50 rapid taps, simultaneous delete+tap, missing media IDs      |
|  - R6: 767px vs 768px vs 769px, 200-char titles, rapid ratio toggles  |
+-----------------------------------------------------------------------+
                                  ▲
+-----------------------------------------------------------------------+
|  Tier 1: Feature Coverage (>=5 per feature for R1 through R6)         |
|  - R1: Web Audio fault tolerance, dual-clock, safe graph, stopAll     |
|  - R2: captureStream detection, MIME checks, Safari MP4, fallbacks    |
|  - R3: Strict flex containment (w-full max-w-full min-w-0), 0px over  |
|  - R4: useIsMobile landscape detection (<=500px), canvas h >= 150px   |
|  - R5: MediaItemCard onClick addition, stopPropagation on delete/plus |
|  - R6: Header 768px tablet containment, compact input, export button  |
+-----------------------------------------------------------------------+
```

### Tier 1: Feature Coverage (>= 5 tests per requirement)
- **R1 (Audio Engine & Clock)**: Safe `AudioContext` acquisition, dual-clock fallback via `performance.now()`, suspended/closed state resilience, null-safe gain graph, clean teardown via `stopAll()`.
- **R2 (Defensive Samples & Export)**: Explicit capability detection for `captureStream`, MIME checking (`isTypeSupported`) with MP4 candidates for Safari, graceful sample media generation with fallback items, descriptive Spanish export error handling.
- **R3 (Strict Mobile Timeline Containment)**: Viewport containment at 320px, 360px, 390px, 471px, toolbar compacting, invariant `scrollWidth === clientWidth` (0px horizontal overflow).
- **R4 (Mobile Landscape Adaptation)**: Landscape detection in `useIsMobile` (`innerHeight <= 500` or `(max-height: 500px)`), compact toolbar/timeline, canvas visible height guarantee >= 150px (and > 120px on 320px height), non-zero canvas dimensions.
- **R5 (Touch Accessibility in Media Gallery)**: Direct `onClick` timeline addition on `MediaItemCard`, `e.stopPropagation()` on nested buttons (`Plus`, `Trash2`), always-visible mobile add control (`md:hidden`), keyboard/ARIA accessibility.
- **R6 (Tablet Header Adaptation)**: Header width containment at 768px portrait, text label migration from `sm:` to `lg:`, input compaction (`w-28 md:w-36 lg:w-52`), unclipped and accessible export button.

### Tier 2: Boundary & Corner Cases (>= 5 tests per requirement)
- Tests system behavior under stress, invalid or extreme inputs, degenerate conditions, and edge boundaries (e.g. 500px vs 501px height, 767px vs 768px width, 200-character project titles, rapid event bursts, null/undefined APIs).

### Tier 3: Pairwise Cross-Feature Interactions
- Tests combinations of two or more features operating simultaneously to identify state leaks, race conditions, and unhandled cross-module dependencies.

### Tier 4: Real-World Application Scenarios (>= 5 workloads)
- Tests realistic end-to-end user workflows executed across simulated real devices (iPhone SE 320x568, iPhone 13 Landscape 844x390, iPad Portrait 768x1024, Safari iOS WebKit, Dynamic Orientation Rotation).

---

## 3. Requirements Traceability Matrix

| Requirement | Title | Tier 1 Tests | Tier 2 Tests | Tier 3 Tests | Tier 4 Workloads |
|-------------|-------|--------------|--------------|--------------|------------------|
| **R1** | Web Audio Fault Tolerance | 6 tests | 5 tests | 4 tests | Workloads 1, 4, 5 |
| **R2** | Defensive Sample & Export | 6 tests | 5 tests | 3 tests | Workloads 3, 4 |
| **R3** | Strict Mobile Timeline Containment | 5 tests | 5 tests | 3 tests | Workloads 1, 5 |
| **R4** | Mobile Landscape Support | 5 tests | 5 tests | 3 tests | Workloads 2, 5 |
| **R5** | Media Gallery Touch Accessibility | 5 tests | 5 tests | 3 tests | Workloads 1, 2, 4 |
| **R6** | Adaptive Tablet Header (768px) | 5 tests | 5 tests | 2 tests | Workload 3 |
| **Total** | Full Suite Coverage | **32 tests** | **30 tests** | **8 tests** | **5 workloads** |

---

## 4. Test Environment & Mocking Strategy

### 4.1 Test Runner & Execution
- **Framework**: Vitest (`vitest run`) running in Node.js environment.
- **Command**: `npm test` or `npx vitest run src/tests/e2e/`.
- **TypeScript Checking**: `npx tsc --noEmit` verifies strict types with zero compilation errors.

### 4.2 Browser API Polyfilling & Mocking Strategy
Because Vitest executes headlessly in Node.js:
1. **Web Audio API**:
   - `window.AudioContext` and `window.webkitAudioContext` are mocked via clean classes with configurable states (`running`, `suspended`, `closed`), currentTime counters, and controllable `resume()` / `createGain()` behaviors.
   - Fault injection: constructor throws, `resume()` rejects, destination is disconnected.
2. **Canvas & Media Capture**:
   - `HTMLCanvasElement.prototype.captureStream` and `webkitCaptureStream` are controlled per test scenario to verify capability detection and fallback triggers.
   - `MediaRecorder` and `MediaRecorder.isTypeSupported` are mocked to emulate Chrome (VP9/VP8/WebM), Safari iOS (MP4 only, WebM unsupported), and unsupported legacy webviews.
3. **Viewport & Responsive Geometry**:
   - `window.innerWidth`, `window.innerHeight`, `window.matchMedia`, and DOM container properties (`clientWidth`, `scrollWidth`, `clientHeight`, `scrollHeight`) are configured per test device profile.
4. **State Isolation**:
   - Zustand stores (`useProjectStore`, `useUIStore`) are reset prior to each test using store reset methods (`resetProject()`, state overrides).
   - Global polyfills are deleted or restored to original values in `afterEach` hooks.

---

## 5. Authoritative Expected Output Derivation

All expected outcomes are derived directly from the authoritative specifications:
1. **R1**: `PROJECT.md § Interface Contracts` and `ORIGINAL_REQUEST.md § R1`:
   - `getAudioContext()` must return `AudioContext | null`, never throwing.
   - `getTime()` must advance smoothly using `performance.now()` fallback when Web Audio is missing or suspended.
   - `audioEngine.stopAll()` must cleanly cease audio playback and reset nodes on player unmount.
2. **R2**: `PROJECT.md § Feature Inventory (Features 5–8)` and `ORIGINAL_REQUEST.md § R2`:
   - `isCanvasCaptureSupported()` returns boolean without throwing.
   - `getSupportedVideoMimeType()` evaluates candidates `['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4']` and returns valid MIME or null.
   - Sample media generation produces fallback assets when canvas capture fails.
   - Exporter produces descriptive Spanish error when canvas capture is unsupported.
3. **R3**: `ORIGINAL_REQUEST.md § R3 & Acceptance Criteria`:
   - Containment: `scrollWidth === clientWidth` on viewport widths 320px to 471px (0px overflow-x).
4. **R4**: `ORIGINAL_REQUEST.md § R4 & Acceptance Criteria`:
   - `useIsMobile(768)` evaluates to `true` when `window.innerHeight <= 500`.
   - Player canvas visible height is >= 150px on 844x390 and > 120px on 568x320.
5. **R5**: `ORIGINAL_REQUEST.md § R5 & Acceptance Criteria`:
   - Direct click/tap on `MediaItemCard` container calls `addClipFromMedia`.
   - Clicking `Trash2` calls `stopPropagation()` and does not add a clip.
6. **R6**: `ORIGINAL_REQUEST.md § R6 & Acceptance Criteria`:
   - At 768px portrait, header elements do not clip, input width is compacted, export button is accessible.

---

## 6. Test Suite Inventory & Runner Commands

### 6.1 Test Suites in `src/tests/e2e/`
- `src/tests/e2e/tier1-features.test.ts`: Tier 1 Feature Coverage (32 tests across R1–R6).
- `src/tests/e2e/tier2-boundary.test.ts`: Tier 2 Boundary & Corner Cases (30 tests across R1–R6).
- `src/tests/e2e/tier3-pairwise.test.ts`: Tier 3 Cross-Feature Interactions (8 tests).
- `src/tests/e2e/tier4-scenarios.test.ts`: Tier 4 Real-World Application Workloads (5 end-to-end scenarios).

### 6.2 Running Tests
```bash
# Run all tests in the project (baseline unit tests + all E2E tiers)
npm test

# Run only E2E test suites
npx vitest run src/tests/e2e/

# Run a specific tier
npx vitest run src/tests/e2e/tier1-features.test.ts
npx vitest run src/tests/e2e/tier2-boundary.test.ts
npx vitest run src/tests/e2e/tier3-pairwise.test.ts
npx vitest run src/tests/e2e/tier4-scenarios.test.ts

# Verify TypeScript compilation and bundling
npm run build
```
