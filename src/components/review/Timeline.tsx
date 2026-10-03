import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { clamp } from "./format";
import { layoutTimelineMarkers, type TimelineMarker } from "../../lib/timelineMarkers";

// ---------------------------------------------------------------------------
// Timeline strip — extracted from OutcomeReview.tsx (Phase-2 component
// extraction). The bar, pointer-capture scrub, is_valid hatch, playhead, and
// frame footer are review-type-agnostic; domain markers (outcome triangle,
// soft-trunc hatch, subtask dots, event-time ticks) are injected via
// `renderOverlays`, which receives the same `pct` positioning helper the
// inline markers used.
// ---------------------------------------------------------------------------

export function Timeline({
  rawLength,
  frame,
  lastValidFrame,
  onScrub,
  renderOverlays,
  markers = [],
  markersDisabled = false,
  onMarkerSelect,
}: {
  rawLength: number;
  frame: number;
  /** Drives the is_valid==0 padding hatch; null = unknown/none. */
  lastValidFrame: number | null;
  onScrub: (frame: number) => void;
  renderOverlays?: (pct: (value: number) => string) => ReactNode;
  markers?: TimelineMarker[];
  markersDisabled?: boolean;
  onMarkerSelect?: (id: string) => void;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const markerSizeRef = useRef<HTMLSpanElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState({ width: 320, labelWidth: 48, labelHeight: 28 });
  useEffect(() => {
    if (!barRef.current || !markerSizeRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const bar = barRef.current?.getBoundingClientRect();
      const label = markerSizeRef.current?.getBoundingClientRect();
      if (!bar?.width || !label?.width || !label.height) return;
      setSize((previous) => previous.width === bar.width && previous.labelWidth === label.width && previous.labelHeight === label.height
        ? previous : { width: bar.width, labelWidth: label.width, labelHeight: label.height });
    });
    observer.observe(barRef.current);
    observer.observe(markerSizeRef.current);
    return () => observer.disconnect();
  }, []);
  const positioned = layoutTimelineMarkers(markers, rawLength, size.width, size.labelWidth);
  const laneCount = positioned.reduce((count, marker) => Math.max(count, marker.lane + 1), 0);

  const pct = (value: number) => `${(value / rawLength) * 100}%`;

  const frameFromClientX = (clientX: number): number => {
    const bar = barRef.current;
    if (!bar) return frame;
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return frame;
    const ratio = (clientX - rect.left) / rect.width;
    return clamp(Math.floor(ratio * rawLength), 0, rawLength - 1);
  };

  const invalidStart =
    lastValidFrame !== null && lastValidFrame < rawLength - 1
      ? lastValidFrame + 1
      : null;

  return (
    <div className="mt-4">
      <div
        ref={barRef}
        role="group"
        aria-label="Video progress bar"
        className="relative h-12 rounded-lg bg-warm-100 border border-warm-200 cursor-pointer select-none touch-none"
        style={laneCount ? { height: laneCount * size.labelHeight + 20 } : undefined}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          onScrub(frameFromClientX(e.clientX));
        }}
        onPointerMove={(e) => {
          if (dragging) onScrub(frameFromClientX(e.clientX));
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setDragging(false);
        }}
        onPointerCancel={() => setDragging(false)}
      >
        <span ref={markerSizeRef} aria-hidden="true" className="absolute invisible pointer-events-none w-12 h-7" />
        {/* Invalid padding beyond the last valid frame */}
        {invalidStart !== null && (
          <div
            className="absolute top-0 bottom-0 bg-warm-300/60"
            style={{
              left: pct(invalidStart),
              right: 0,
              backgroundImage:
                "repeating-linear-gradient(45deg, rgba(138,127,114,0.35) 0 5px, transparent 5px 10px)",
            }}
            title={`is_valid==0 padding from frame ${invalidStart}`}
          />
        )}

        {renderOverlays?.(pct)}

        {positioned.map((marker) => <div key={marker.id} className="absolute inset-0 pointer-events-none">
          <span aria-hidden="true" className={`absolute bottom-0 w-px ${marker.active ? "bg-teal" : "bg-teal/40"}`}
            style={{ left: pct(marker.frame), top: (marker.lane + 1) * size.labelHeight }} />
          <button type="button" title={marker.title} aria-label={`Go to ${marker.title}`}
            aria-current={marker.active ? "step" : undefined} aria-pressed={marker.selected ?? false}
            disabled={markersDisabled}
            className={`absolute z-20 w-12 h-7 rounded border text-sm font-mono cursor-pointer pointer-events-auto disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal ${marker.active ? "bg-teal text-white border-teal" : "bg-white text-teal border-teal/30 hover:bg-teal/10"} ${marker.selected ? "ring-2 ring-ink/60" : ""}`}
            style={{ left: `clamp(${size.labelWidth / 2}px, ${pct(marker.frame)}, calc(100% - ${size.labelWidth / 2}px))`, top: marker.lane * size.labelHeight + 3, transform: "translateX(-50%)" }}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onScrub(clamp(Math.round(marker.frame), 0, rawLength - 1));
              onMarkerSelect?.(marker.id);
            }}>{marker.label}</button>
        </div>)}

        {/* Playhead */}
        <div
          className="absolute z-10 top-0 bottom-0 w-0.5 bg-ink pointer-events-none"
          style={{ left: pct(frame), transform: "translateX(-50%)" }}
        />
      </div>
      <div className="flex justify-between text-[10px] font-mono text-ink-muted mt-1">
        <span>0</span>
        <span>{rawLength - 1}</span>
      </div>
    </div>
  );
}
