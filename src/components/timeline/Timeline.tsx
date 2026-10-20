import React, { useRef, useEffect } from 'react';
import { useProjectStore } from '../../store/useProjectStore';
import { masterClock } from '../../core/engine/MasterClock';
import { Clip, Track } from '../../types/project';
import { TimelineToolbar } from './TimelineToolbar';
import { TimeRuler } from './TimeRuler';
import { TrackHeader } from './TrackHeader';
import { TrackLane } from './TrackLane';
import { Playhead } from './Playhead';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { announce } from '../layout/liveRegion';

/**
 * F6 · Height of a track lane in px (must match the `h-14` of `TrackLane`).
 */
export const TRACK_LANE_HEIGHT = 56;

/**
 * F6 · Height of the time ruler in px (must match the `h-7` of the ruler).
 */
export const RULER_HEIGHT = 28;

/**
 * F6 · Minimum movement (px) that turns a click into a rubber band drag.
 *
 * Below it the gesture is a plain click on the empty space (which clears the
 * selection).
 */
export const RUBBER_BAND_THRESHOLD_PX = 4;

/**
 * F6 · Rectangle of the rubber band, in TIMELINE CONTENT pixels (the origin
 * is the first pixel of the first track lane, after the ruler).
 */
export interface RubberBandRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * F6 · Ids of the clips whose box INTERSECTS the rubber band rectangle.
 *
 * The band touches a clip when their rectangles overlap (the clip does not
 * have to be fully inside the band). The result is ordered like the timeline
 * (track by track, then by start time).
 */
export function selectClipIdsInRect(
  clips: Clip[],
  tracks: Track[],
  zoom: number,
  rect: RubberBandRect
): string[] {
  const trackIndex = new Map(tracks.map((track, index) => [track.id, index]));
  const hits: Array<{ id: string; track: number; start: number }> = [];

  for (const clip of clips) {
    const index = trackIndex.get(clip.trackId);
    if (index === undefined) continue;
    const x0 = clip.start * zoom;
    const x1 = (clip.start + clip.duration) * zoom;
    const y0 = index * TRACK_LANE_HEIGHT;
    const y1 = y0 + TRACK_LANE_HEIGHT;
    if (x0 < rect.right && x1 > rect.left && y0 < rect.bottom && y1 > rect.top) {
      hits.push({ id: clip.id, track: index, start: clip.start });
    }
  }

  hits.sort((a, b) => (a.track !== b.track ? a.track - b.track : a.start - b.start));
  return hits.map((hit) => hit.id);
}

/**
 * F6 · Merges the ids of a rubber band with the current selection.
 *
 * The band REPLACES the selection, but with Ctrl/Cmd the touched clips JOIN
 * it (the primary selection does not change).
 */
export function mergeSelection(current: string[], added: string[]): string[] {
  return Array.from(new Set([...current, ...added]));
}

export const Timeline: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  const zoom = useProjectStore((s) => s.zoom);
  const setZoom = useProjectStore((s) => s.setZoom);
  const selectClip = useProjectStore((s) => s.selectClip);
  const selectClips = useProjectStore((s) => s.selectClips);
  const selectAllClips = useProjectStore((s) => s.selectAllClips);
  const snappingGuideTime = useProjectStore((s) => s.snappingGuideTime);
  const lanesContainerRef = useRef<HTMLDivElement>(null);
  const headersContainerRef = useRef<HTMLDivElement>(null);
  /** F6 · The rubber band rectangle (updated IMPERATIVELY: no React render). */
  const rubberBandRef = useRef<HTMLDivElement>(null);
  /** F6 · The rubber band gesture in progress (if any). */
  const bandGestureRef = useRef<{
    controller: AbortController;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    lastClientX: number;
    lastClientY: number;
    frame: number | null;
  } | null>(null);
  /**
   * F6 · True when the last gesture was a rubber band: the `click` event that
   * follows it must NOT clear the selection it just made.
   */
  const bandConsumedClickRef = useRef(false);

  /**
   * UI-11: the ruler and the lanes must share **exactly** the same width.
   * The previous formulas differed (`max(1400, d*z+400)` vs `max(1200, d*z+300)`),
   * so the ruler always stopped 100–200 px before the tracks did.
   * This value matches the one used by `TimeRuler`.
   */
  const totalWidth = Math.max(1200, project.duration * zoom + 300);
  const timelineTracksHeight = project.tracks.length * TRACK_LANE_HEIGHT; // 56px per track
  const totalTimelineHeight = timelineTracksHeight + RULER_HEIGHT; // plus ruler height

  /**
   * UI-09/UI-10: the track list scrolls vertically and the track headers stay
   * in sync with it. The scroll offset is applied imperatively (no React state)
   * so that scrolling does not re-render the whole timeline.
   */
  const handleLanesScroll = () => {
    const lanes = lanesContainerRef.current;
    const headers = headersContainerRef.current;
    if (!lanes || !headers) return;
    if (Math.abs(headers.scrollTop - lanes.scrollTop) > 0.5) {
      headers.scrollTop = lanes.scrollTop;
    }
  };

  const handleHeadersScroll = () => {
    const lanes = lanesContainerRef.current;
    const headers = headersContainerRef.current;
    if (!lanes || !headers) return;
    if (Math.abs(lanes.scrollTop - headers.scrollTop) > 0.5) {
      lanes.scrollTop = headers.scrollTop;
    }
  };

  /* ------------------------------------------------------------------ */
  /* F6 — rubber band selection                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Starts the rubber band when the user presses on the EMPTY space of the
   * timeline.
   *
   * It does NOT fight the other gestures:
   * - the clips own their pointer events (they stop the propagation) so a
   *   drag of a clip never draws a band;
   * - the ruler scrubs the playhead (it is excluded explicitly);
   * - the wheel keeps scrolling / zooming (the band never touches it);
   * - on touch the gesture is a scroll: the multi-selection is reached with
   *   the long press of a clip (the equivalent of Ctrl + clic).
   */
  const handleLanesPointerDown = (e: React.PointerEvent) => {
    // A new gesture starts: the flag of the previous one is stale.
    bandConsumedClickRef.current = false;

    if (e.pointerType !== 'mouse') return;
    if (e.button !== 0) return;

    const target = e.target as HTMLElement | null;
    if (target && typeof target.closest === 'function') {
      if (target.closest('[data-clip-id]')) return;
      if (target.closest('[data-testid="time-ruler"]')) return;
    }

    const container = lanesContainerRef.current;
    if (!container) return;

    // F6: Ctrl/Cmd + drag ADDS the touched clips to the current selection.
    const additive = e.ctrlKey || e.metaKey;

    // The geometry of the scrollport is captured ONCE: the band is painted
    // from the cached rectangle instead of forcing a layout on every move.
    const containerRect = container.getBoundingClientRect();
    const startX = e.clientX - containerRect.left + container.scrollLeft;
    const startY = e.clientY - containerRect.top + container.scrollTop - RULER_HEIGHT;

    // The band must not start a text selection nor a native drag.
    e.preventDefault();

    bandGestureRef.current?.controller.abort();
    const controller = new AbortController();
    const { signal } = controller;
    const gesture = {
      controller,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX,
      startY,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      frame: null as number | null,
    };
    bandGestureRef.current = gesture;

    const paintBand = () => {
      gesture.frame = null;
      const band = rubberBandRef.current;
      const current = lanesContainerRef.current;
      if (!band || !current) return;
      const currentX = gesture.lastClientX - containerRect.left + current.scrollLeft;
      const currentY = gesture.lastClientY - containerRect.top + current.scrollTop - RULER_HEIGHT;
      const left = Math.min(gesture.startX, currentX);
      const top = Math.min(gesture.startY, currentY);
      band.style.display = 'block';
      band.style.transform = `translate(${left}px, ${top}px)`;
      band.style.width = `${Math.abs(currentX - gesture.startX)}px`;
      band.style.height = `${Math.abs(currentY - gesture.startY)}px`;
    };

    const onMove = (moveEvent: PointerEvent) => {
      gesture.lastClientX = moveEvent.clientX;
      gesture.lastClientY = moveEvent.clientY;
      // ONE paint per frame: the timeline must stay at 60 FPS (the overlay
      // never re-renders the React tree).
      if (gesture.frame !== null) return;
      if (typeof requestAnimationFrame !== 'function') {
        paintBand();
        return;
      }
      gesture.frame = requestAnimationFrame(paintBand);
    };

    const onUp = (upEvent: PointerEvent) => {
      controller.abort();
      if (bandGestureRef.current === gesture) bandGestureRef.current = null;
      if (gesture.frame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(gesture.frame);
      }
      gesture.frame = null;
      const band = rubberBandRef.current;
      if (band) band.style.display = 'none';

      const dx = Math.abs(upEvent.clientX - gesture.startClientX);
      const dy = Math.abs(upEvent.clientY - gesture.startClientY);

      // The click event that follows the pointerup must not clear the
      // selection the band just made.
      bandConsumedClickRef.current = true;

      if (dx < RUBBER_BAND_THRESHOLD_PX && dy < RUBBER_BAND_THRESHOLD_PX) {
        // A click on the empty space: the selection is cleared.
        selectClip(null);
        return;
      }

      const currentX = upEvent.clientX - containerRect.left + container.scrollLeft;
      const currentY = upEvent.clientY - containerRect.top + container.scrollTop - RULER_HEIGHT;
      const rect: RubberBandRect = {
        left: Math.min(gesture.startX, currentX),
        top: Math.min(gesture.startY, currentY),
        right: Math.max(gesture.startX, currentX),
        bottom: Math.max(gesture.startY, currentY),
      };
      const ids = selectClipIdsInRect(project.clips, project.tracks, zoom, rect);
      if (additive) {
        // Ctrl/Cmd + drag: the touched clips JOIN the current selection.
        const current = useProjectStore.getState().selectedClipIds;
        selectClips(mergeSelection(current, ids));
        return;
      }
      // The band REPLACES the selection (an empty band clears it).
      selectClips(ids);
    };

    window.addEventListener('pointermove', onMove, { signal });
    window.addEventListener('pointerup', onUp, { signal });
    window.addEventListener('pointercancel', onUp, { signal });
  };

  // Unmount safety net: a band in progress must not leave window listeners
  // behind.
  useEffect(() => {
    return () => {
      bandGestureRef.current?.controller.abort();
      bandGestureRef.current = null;
    };
  }, []);

  /* ------------------------------------------------------------------ */
  /* F6 — Ctrl + A selects every clip                                    */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'a' && e.key !== 'A') return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.altKey) return;
      // The system shortcut must keep working inside a text field.
      const active = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
      if (active) {
        const tag = typeof active.tagName === 'string' ? active.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (active.isContentEditable === true) return;
      }
      e.preventDefault();
      selectAllClips();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectAllClips]);

  // Cursor-anchored Wheel Zoom (Ctrl + Wheel) with non-passive event listener
  useEffect(() => {
    const container = lanesContainerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const mouseXInContainer = e.clientX - rect.left;
        const currentScrollLeft = container.scrollLeft;
        const currentZoom = useProjectStore.getState().zoom;
        const mouseTime = (mouseXInContainer + currentScrollLeft) / currentZoom;

        const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
        const newZoom = Math.max(10, Math.min(250, currentZoom * zoomFactor));
        setZoom(newZoom);

        const newScrollLeft = Math.max(0, mouseTime * newZoom - mouseXInContainer);
        container.scrollLeft = newScrollLeft;
      } else if (e.deltaX === 0 && e.deltaY !== 0) {
        // UI-20: a plain wheel must NOT be hijacked. The vertical wheel scrolls
        // the track list; only a wheel over the ruler is turned into a
        // horizontal scroll (that is where the user expects to scrub in time).
        const target = e.target as HTMLElement | null;
        const overRuler = typeof target?.closest === 'function'
          ? target.closest('[data-testid="time-ruler"]')
          : null;
        if (overRuler) {
          e.preventDefault();
          container.scrollLeft += e.deltaY;
        }
      }
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', onWheel);
    };
  }, [setZoom]);

  // Two-finger pinch-to-zoom on touch screens
  useEffect(() => {
    const container = lanesContainerRef.current;
    if (!container) return;

    const activePointers = new Map<number, { x: number; y: number }>();
    let initialDistance = 0;
    let initialZoom = 1;

    const onPointerDown = (e: PointerEvent) => {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size === 2) {
        const [p1, p2] = Array.from(activePointers.values());
        initialDistance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        initialZoom = useProjectStore.getState().zoom;
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 2 && initialDistance > 0) {
        const [p1, p2] = Array.from(activePointers.values());
        const currentDistance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const scale = currentDistance / initialDistance;
        const newZoom = Math.max(10, Math.min(250, initialZoom * scale));
        setZoom(newZoom);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) {
        initialDistance = 0;
      }
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerUp);

    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerUp);
    };
  }, [setZoom]);

  const handleFitToScreen = () => {
    const container = lanesContainerRef.current;
    if (!container) return;
    const availableWidth = container.clientWidth - 80;
    const maxClipTime = project.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);
    const targetDuration = Math.max(5, maxClipTime || project.duration);
    const targetZoom = Math.max(10, Math.min(200, availableWidth / targetDuration));
    setZoom(targetZoom);
    container.scrollLeft = 0;
  };

  /**
   * F5 · La acción del estado vacío: añade el primer medio utilizable en el
   * cabezal (sin cruzar a la ola U3: no toca el importador del bin).
   */
  const handleAnadirPrimerMedio = () => {
    const estado = useProjectStore.getState();
    const medio =
      estado.project.mediaPool.find((m) => m.status !== 'missing' && m.status !== 'error') ??
      estado.project.mediaPool[0];
    if (!medio) return;
    estado.addClipFromMedia(medio, undefined, masterClock.getTime());
    announce(`«${medio.name}» añadido a la línea de tiempo`);
  };

  const hayClips = project.clips.length > 0;
  const hayMedios = project.mediaPool.length > 0;

  return (
    <div className="flex flex-col h-full w-full max-w-full min-w-0 bg-app border-t border-border-subtle select-none z-10 overflow-hidden">
      {/* Top Toolbar */}
      <TimelineToolbar
        onFitToScreen={handleFitToScreen}
        selectAllSlot={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="select-all-clips"
            aria-label="Seleccionar todos los clips"
            title="Seleccionar todo (Ctrl+A)"
            onClick={selectAllClips}
            disabled={project.clips.length === 0}
          >
            Seleccionar todo
          </Button>
        }
      />

      {/* Main Timeline Workspace */}
      <div className="flex-1 flex w-full max-w-full min-w-0 overflow-hidden">
        {/* Left Column: Track Headers */}
        <div className="w-28 min-[400px]:w-36 sm:w-40 md:w-48 lg:w-56 bg-panel border-r border-border-subtle flex flex-col shrink-0 z-20 overflow-hidden">
          {/* Header spacer aligned with ruler */}
          <div className="h-7 shrink-0 bg-panel border-b border-border-subtle px-2 flex items-center justify-between text-caption uppercase text-text-2">
            <span>Pistas</span>
            <Badge variant="neutral">
              <span className="font-mono">{project.tracks.length}</span>
            </Badge>
          </div>

          {/* Track Headers List — scrolls vertically in sync with the lanes */}
          <div
            ref={headersContainerRef}
            onScroll={handleHeadersScroll}
            className="flex-1 overflow-y-auto overflow-x-hidden no-scrollbar"
          >
            {project.tracks.map((track, idx) => (
              <TrackHeader key={track.id} track={track} index={idx} />
            ))}
          </div>
        </div>

        {/* Right Area: Scrollable Tracks & Ruler + Empty State overlay */}
        <div className="flex-1 relative min-w-0 overflow-hidden">
          <div
            ref={lanesContainerRef}
            onScroll={handleLanesScroll}
            onPointerDown={handleLanesPointerDown}
            onClick={() => {
              // F6: the click that follows a rubber band must not clear the
              // selection the band just made.
              if (bandConsumedClickRef.current) {
                bandConsumedClickRef.current = false;
                return;
              }
              selectClip(null);
            }}
            className="absolute inset-0 overflow-auto bg-app min-w-0"
          >
            {/*
              Time Ruler — `sticky top-0` keeps it pinned to the top of the
              scrollport while the tracks scroll vertically, and it scrolls
              horizontally with the lanes (one single scroll source, no JS).
              `scrollLeft` stays 0 on purpose: the ruler is already translated by
              the native scroll of the container.
            */}
            <div
              className="sticky top-0 z-20 h-7 bg-panel [&>div]:!w-full"
              style={{ width: `${totalWidth}px` }}
            >
              <TimeRuler scrollLeft={0} />
            </div>

            {/* Track Lanes */}
            <div style={{ width: `${totalWidth}px` }} className="relative">
              {project.tracks.map((track) => (
                <TrackLane key={track.id} track={track} width={totalWidth} />
              ))}

              {/* F6 · Rubber band. It is painted IMPERATIVELY (one style write
                  per frame): the timeline never re-renders while the band is
                  being dragged. */}
              <div
                ref={rubberBandRef}
                data-testid="rubber-band"
                aria-hidden="true"
                className="absolute hidden pointer-events-none border border-accent bg-accent-soft rounded-sm z-40"
              />
            </div>

            {/* Draggable Playhead */}
            <Playhead timelineHeight={totalTimelineHeight} />

            {/* Vertical Snapping Guide Line */}
            {snappingGuideTime !== null && (
              <div
                data-testid="snapping-guide-line"
                style={{
                  left: `${snappingGuideTime * zoom}px`,
                  height: `${totalTimelineHeight}px`,
                }}
                className="absolute top-0 w-[2px] bg-accent z-30 pointer-events-none"
              >
                <div className="absolute top-6 -left-1 w-2.5 h-2.5 bg-accent rotate-45" />
              </div>
            )}
          </div>

          {/* F5 · Estado vacío diseñado: titular + una acción (+ pista de arrastrar y soltar). */}
          {!hayClips && (
            <div
              data-testid="timeline-empty-state"
              className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4"
            >
              <div className="pointer-events-auto flex max-w-72 flex-col items-center gap-1.5 rounded-md border border-border bg-panel px-6 py-5 text-center">
                <p className="text-body-lg text-text-1">Sin clips</p>
                <p className="text-body-sm text-text-2">
                  Arrastra un medio al carril o impórtalo desde Medios
                </p>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleAnadirPrimerMedio}
                  disabled={!hayMedios}
                  title={hayMedios ? 'Añade el primer medio en el cabezal' : 'Importa primero un archivo desde Medios'}
                >
                  Añade un medio
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
