import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useSearchParam, useSearchParamNumber } from "../lib/useSearchParam";
import {
  FPS,
  explorerCameraKeys,
  fetchAppliedProgress,
  fetchEpisodeFrameSignals,
  fetchLabelHistory,
  fetchLedgerArms,
  fetchReviewEpisodes,
  getVideoUrl,
  selectPrimaryCameraKey,
  type AppliedProgress,
  type EpisodeFrameSignals,
  type LabelEvent,
  type ReviewEpisode,
} from "../lib/hf-api";

// ---------------------------------------------------------------------------
// Contract notes
//
// This is the operator decision-capture half of sir/tools/outcome_editor.py.
// It ONLY writes decisions into Convex (api.reviews.save) and enqueues apply
// jobs (api.applyJobs.enqueue). Materializing `.outcome_edit_progress.json`,
// rewriting reward/done/is_valid and pushing to HuggingFace all happen in the
// Python apply worker — nothing here touches the dataset.
// ---------------------------------------------------------------------------

type Outcome = "success" | "failure" | "timeout";
type QueueFilter = "all" | "failure" | "success" | "timeout";

const OUTCOMES: Outcome[] = ["success", "failure", "timeout"];

/**
 * Required mid-episode subtask marks, keyed by the Convex dataset `task` —
 * FALLBACK ONLY, used while the exported `taskSpecs` row is loading or for a
 * task the exporter has not pushed yet.
 *
 * AUTHORITY IS PYTHON: `resolve_subtask_marks` in sir/tools/outcome_editor.py
 * reads `RealTaskSpec.num_subtask_marks` (exported to Convex by
 * sir/tools/export_arena_task_specs.py), and the apply worker RE-VALIDATES every
 * confirmed record with `subtask_mark_count_error` before touching HuggingFace.
 * This table only makes the gate visible to the operator while they review; a
 * stale entry here cannot write a bad label — it can only mis-guide the UI, and
 * the worker will reject the job loudly.
 */
const REVIEW_SUBTASK_MARKS: Record<string, number> = {
  routing_d1: 1,
};

type CropBox = [number, number, number, number];

/** Port of camera_role_for_video_key in sir/real/camera_utils.py. */
function cameraRoleForVideoKey(
  key: string,
  keysByRole: Record<string, string>
): string | null {
  const bare = key.split(".").at(-1) ?? key;
  if (bare in keysByRole) return bare;
  for (const [role, serial] of Object.entries(keysByRole)) {
    if (bare === serial) return role;
  }
  return null;
}

const OUTCOME_CHIP: Record<Outcome, string> = {
  success: "bg-teal-light text-teal",
  failure: "bg-coral-light text-coral",
  timeout: "bg-gold-light text-gold",
};

// Palette hex values mirror the @theme block in src/index.css (teal / coral / gold).
const OUTCOME_HEX: Record<Outcome, string> = {
  success: "#0B6E6E",
  failure: "#D4654A",
  timeout: "#C4961A",
};

const QUEUE_FILTERS: { id: QueueFilter; label: string }[] = [
  { id: "failure", label: "Failures" },
  { id: "success", label: "Successes" },
  { id: "timeout", label: "Timeouts" },
  { id: "all", label: "All" },
];

// Station roles read left-to-right the way the operator looks at the cell.
const CAMERA_ROLE_ORDER = ["side_1", "side_2", "wrist_left", "wrist_right"];

const SIGNAL_CONCURRENCY = 3;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function orderCameraKeys(keys: string[]): string[] {
  const rank = (key: string) => {
    const bare = key.split(".").at(-1) ?? key;
    const index = CAMERA_ROLE_ORDER.indexOf(bare);
    return index === -1 ? CAMERA_ROLE_ORDER.length : index;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// -- Label-history rendering (taxonomy-blind: unknown kinds render as JSON) --
const SOURCE_TOOL_SHORT: Record<string, string> = {
  "web-review": "web",
  "cv2-editor": "cv2",
  "collection-results": "collection",
};

function sourceLabel(event: LabelEvent): string {
  const tool = SOURCE_TOOL_SHORT[event.source.tool] ?? event.source.tool;
  const agent = event.source.agent ? ` ${event.source.agent}` : "";
  return `${event.source.kind}·${tool}${agent}`;
}

function describeLabelPayload(
  kind: string,
  payload: Record<string, unknown>
): string {
  if (payload.action === "skip") return "skip (kept labels)";
  if (payload.action === "unlabel") return "unlabeled (decision retracted)";
  if (kind === "outcome" && typeof payload.new_outcome === "string") {
    let text = `${payload.new_outcome} @ ${payload.outcome_frame}`;
    if (payload.soft_truncate) text += " ·soft-trunc";
    const marks = payload.subtask_frames;
    if (Array.isArray(marks) && marks.length > 0) text += ` ·${marks.length} marks`;
    return text;
  }
  return `${kind}: ${JSON.stringify(payload).slice(0, 60)}`;
}

function eventSeekFrame(event: LabelEvent): number | null {
  const frame = event.payload.outcome_frame;
  return typeof frame === "number" ? frame : null;
}

function cameraLabel(key: string): string {
  return key.split(".").at(-1) ?? key;
}

/**
 * Legality of `n` subtask marks for `outcome` — mirrors
 * `subtask_mark_count_error` in sir/real/lifecycle/outcome_results.py.
 */
function subtaskMarkCountError(
  outcome: Outcome,
  n: number,
  required: number
): string | null {
  if (required <= 0) return null;
  if (outcome === "success") {
    if (n !== required) {
      return `a SUCCESS episode must carry exactly ${required} subtask mark(s), got ${n}`;
    }
    return null;
  }
  if (n > required) {
    return `a ${outcome.toUpperCase()} episode may carry at most ${required} subtask mark(s), got ${n}`;
  }
  return null;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

// ---------------------------------------------------------------------------
// Review records (Convex rows, BigInt → number)
// ---------------------------------------------------------------------------

interface ReviewRecord {
  episodeIndex: number;
  status: string;
  newOutcome: Outcome | null;
  outcomeFrame: number | null;
  softTruncate: boolean;
  subtaskFrames: number[] | null;
  reviewer: string;
  savedAt: number;
}

interface PendingReview {
  outcome: Outcome | null;
  markedFrame: number | null;
  subtaskFrames: number[];
  softTruncate: boolean;
}

const EMPTY_PENDING: PendingReview = {
  outcome: null,
  markedFrame: null,
  subtaskFrames: [],
  softTruncate: false,
};

// ---------------------------------------------------------------------------
// Timeline strip
// ---------------------------------------------------------------------------

function Timeline({
  rawLength,
  frame,
  signals,
  pending,
  onScrub,
}: {
  rawLength: number;
  frame: number;
  signals: EpisodeFrameSignals | null;
  pending: PendingReview;
  onScrub: (frame: number) => void;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

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
    signals && signals.lastValidFrame < rawLength - 1
      ? signals.lastValidFrame + 1
      : null;
  const truncStart =
    pending.softTruncate && pending.markedFrame !== null
      ? pending.markedFrame + 1
      : null;

  return (
    <div className="mt-4">
      <div
        ref={barRef}
        className="relative h-12 rounded-lg bg-warm-100 border border-warm-200 cursor-pointer select-none touch-none"
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

        {/* Region a confirmed soft truncation would invalidate */}
        {truncStart !== null && truncStart < rawLength && (
          <div
            className="absolute top-0 bottom-0"
            style={{
              left: pct(truncStart),
              right: 0,
              backgroundImage:
                "repeating-linear-gradient(-45deg, rgba(212,101,74,0.35) 0 5px, transparent 5px 10px)",
            }}
            title={`soft truncation would drop frames ${truncStart}..${rawLength - 1}`}
          />
        )}

        {/* Existing done==1 onset */}
        {signals?.doneOnsetFrame != null && (
          <div
            className="absolute top-0 bottom-0 border-l border-dashed border-ink-muted"
            style={{ left: pct(signals.doneOnsetFrame) }}
            title={`existing outcome frame (done==1 onset) ${signals.doneOnsetFrame}`}
          />
        )}

        {/* Existing mid-episode reward spikes (hollow) */}
        {signals?.rewardSpikeFrames.map((spike) => (
          <div
            key={`spike-${spike}`}
            className="absolute bottom-1 w-2 h-2 rounded-full border border-ink-muted"
            style={{ left: pct(spike), transform: "translateX(-50%)" }}
            title={`existing reward spike at frame ${spike}`}
          />
        ))}

        {/* Pending subtask marks */}
        {pending.subtaskFrames.map((mark) => (
          <div
            key={`mark-${mark}`}
            className="absolute bottom-1 w-2.5 h-2.5 rounded-full bg-purple-600"
            style={{ left: pct(mark), transform: "translateX(-50%)" }}
            title={`subtask mark at frame ${mark}`}
          />
        ))}

        {/* Pending outcome marker */}
        {pending.markedFrame !== null && pending.outcome !== null && (
          <>
            <div
              className="absolute top-0 bottom-0 w-px"
              style={{
                left: pct(pending.markedFrame),
                backgroundColor: OUTCOME_HEX[pending.outcome],
              }}
            />
            <div
              className="absolute top-0"
              style={{
                left: pct(pending.markedFrame),
                transform: "translateX(-50%)",
                width: 0,
                height: 0,
                borderLeft: "6px solid transparent",
                borderRight: "6px solid transparent",
                borderTop: `9px solid ${OUTCOME_HEX[pending.outcome]}`,
              }}
              title={`${pending.outcome} @ frame ${pending.markedFrame}`}
            />
          </>
        )}

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-ink"
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

// ---------------------------------------------------------------------------
// Camera grid + frame-exact seeking
// ---------------------------------------------------------------------------

interface ViewerControls {
  togglePlay: () => void;
  /** Stop playback and snap the frame counter to the displayed frame.
   *  Returns the snapped frame when playback WAS running, else null — mark
   *  handlers must use it: during playback the parent `frame` state is frozen
   *  at the play-start value and marking there lands frames early. */
  pause: () => number | null;
}

function ReviewViewer({
  datasetId,
  episode,
  cameraKeys,
  primaryKey,
  frame,
  onFrame,
  signals,
  pending,
  controlsRef,
  cropByCameraKey,
  storedFrameHW,
  onDrift,
}: {
  datasetId: string;
  episode: ReviewEpisode;
  cameraKeys: string[];
  primaryKey: string;
  frame: number;
  onFrame: (frame: number) => void;
  signals: EpisodeFrameSignals | null;
  pending: PendingReview;
  controlsRef: RefObject<ViewerControls | null>;
  /** Station display crops per camera key (stored-frame px), null = no spec. */
  cropByCameraKey: Record<string, CropBox> | null;
  /** Crop reference space [H, W]; present whenever cropByCameraKey is. */
  storedFrameHW: [number, number] | null;
  /** Frame-verification drift, surfaced so the parent can BLOCK confirms —
   *  a drifted display means the counted frame is not the shown frame. */
  onDrift: (drift: string | null) => void;
}) {
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const seekTokenRef = useRef(0);
  const playingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [drift, setDrift] = useState<string | null>(null);
  const [unverifiable, setUnverifiable] = useState(false);
  // Station crop display defaults ON to match the cv2 editor's review view.
  const [cropOn, setCropOn] = useState(true);
  const [cropDimsError, setCropDimsError] = useState<string | null>(null);
  const hasCrops =
    cropByCameraKey !== null &&
    storedFrameHW !== null &&
    cameraKeys.some((key) => cropByCameraKey[key] !== undefined);
  const cropsActive = hasCrops && cropOn && cropDimsError === null;
  // Bumped when a video reaches HAVE_METADATA. Seeks issued before that are
  // dropped by the browser, so the seek+verify pass must re-run afterwards or
  // the operator sees a phantom drift warning from the pre-load frame 0.
  const [metadataEpoch, setMetadataEpoch] = useState(0);

  const primaryFrom = episode.perCamera[primaryKey].fromTimestamp;
  const primaryTo = episode.perCamera[primaryKey].toTimestamp;

  const setVideoRef = useCallback(
    (key: string) => (el: HTMLVideoElement | null) => {
      if (el) videoRefs.current.set(key, el);
      else videoRefs.current.delete(key);
    },
    []
  );

  // Playback state is per-episode; a queue advance must never leave the new
  // episode auto-playing from the previous one's position.
  useEffect(() => {
    playingRef.current = false;
    /* eslint-disable react-hooks/set-state-in-effect -- switching episodes is
       an imperative reset of playback state, not derived render state. */
    setPlaying(false);
    setDrift(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [episode]);

  // Crop-vs-video dims guard. This must NOT live in onLoadedMetadata: video
  // src is per-FILE (many episodes share one chunk file, so the event fires
  // once per session), and the crop spec can arrive after metadata. Re-check
  // whenever the spec, camera set, or a video's metadata changes; reset when
  // the SPEC changes (not per episode — that wiped a real mismatch forever).
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- imperative guard over
       video-element metadata, not derived render state. */
    setCropDimsError(null);
    if (cropByCameraKey === null || storedFrameHW === null) return;
    const [frameH, frameW] = storedFrameHW;
    for (const key of cameraKeys) {
      if (cropByCameraKey[key] === undefined) continue;
      const video = videoRefs.current.get(key);
      // Metadata not loaded yet -> metadataEpoch re-runs this effect later.
      if (!video || video.videoWidth === 0) continue;
      if (video.videoWidth !== frameW || video.videoHeight !== frameH) {
        setCropDimsError(
          `${cameraLabel(key)} is ${video.videoWidth}x${video.videoHeight}, ` +
            `crop boxes expect ${frameW}x${frameH} stored frames`
        );
        return;
      }
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [cropByCameraKey, storedFrameHW, cameraKeys, metadataEpoch]);

  // Frame-exact seek: every camera lands on the midpoint of frame i, offset by
  // that camera's own from_timestamp (0 today, but multi-episode video chunks
  // rely on it). The primary camera's landing is VERIFIED, never assumed.
  useEffect(() => {
    if (playing) return;
    for (const key of cameraKeys) {
      const video = videoRefs.current.get(key);
      if (!video) continue;
      video.currentTime =
        episode.perCamera[key].fromTimestamp + (frame + 0.5) / FPS;
    }
    const primary = videoRefs.current.get(primaryKey);
    if (!primary) return;
    // Capability is flagged from the loadedmetadata handler (see below) so the
    // operator sees a banner instead of a silently unverified seek.
    if (typeof primary.requestVideoFrameCallback !== "function") return;
    const token = ++seekTokenRef.current;
    primary.requestVideoFrameCallback((_now, meta) => {
      if (seekTokenRef.current !== token) return;
      const exact = (meta.mediaTime - primaryFrom) * FPS;
      const landed = Math.round(exact);
      if (Math.abs(exact - landed) > 0.25 || landed !== frame) {
        setDrift(
          `requested frame ${frame}, video presented frame ${landed} ` +
            `(mediaTime ${meta.mediaTime.toFixed(4)}s, from_timestamp ` +
            `${primaryFrom.toFixed(4)}s, exact ${exact.toFixed(3)})`
        );
      } else {
        setDrift(null);
      }
    });
  }, [frame, playing, episode, cameraKeys, primaryKey, primaryFrom, metadataEpoch]);

  const stopAndSnap = useCallback((): number | null => {
    playingRef.current = false;
    setPlaying(false);
    const primary = videoRefs.current.get(primaryKey);
    if (!primary) return null;
    const snapped = clamp(
      Math.round((primary.currentTime - primaryFrom) * FPS - 0.5),
      0,
      episode.rawLength - 1
    );
    onFrame(snapped);
    return snapped;
  }, [episode.rawLength, onFrame, primaryFrom, primaryKey]);

  const togglePlay = useCallback(() => {
    if (playingRef.current) {
      stopAndSnap();
    } else {
      playingRef.current = true;
      setPlaying(true);
    }
  }, [stopAndSnap]);

  const pause = useCallback((): number | null => {
    if (playingRef.current) return stopAndSnap();
    return null;
  }, [stopAndSnap]);

  useEffect(() => {
    controlsRef.current = { togglePlay, pause };
  }, [controlsRef, togglePlay, pause]);

  useEffect(() => {
    onDrift(drift);
  }, [drift, onDrift]);

  // Playback: the primary camera drives, the others follow its offset-corrected
  // clock; playback halts at the raw end of the episode segment.
  useEffect(() => {
    if (!playing) return;
    const primary = videoRefs.current.get(primaryKey);
    if (!primary) return;
    const videos = cameraKeys
      .map((key) => videoRefs.current.get(key))
      .filter((v): v is HTMLVideoElement => Boolean(v));
    for (const video of videos) void video.play();

    let raf = 0;
    const tick = () => {
      const elapsed = primary.currentTime - primaryFrom;
      for (const key of cameraKeys) {
        const video = videoRefs.current.get(key);
        if (!video || video === primary) continue;
        const target = episode.perCamera[key].fromTimestamp + elapsed;
        if (Math.abs(video.currentTime - target) > 0.1) video.currentTime = target;
      }
      if (primary.currentTime >= primaryTo) {
        stopAndSnap();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const video of videos) video.pause();
    };
  }, [playing, cameraKeys, episode, primaryKey, primaryFrom, primaryTo, stopAndSnap]);

  // All cameras in ONE row, like the cv2 editor's side-by-side composite.
  const gridCols =
    ["grid-cols-1", "grid-cols-2", "grid-cols-3", "grid-cols-4"][
      Math.min(cameraKeys.length, 4) - 1
    ] ?? "grid-cols-4";

  // cv2-editor decision overlays: frames at/after the pending outcome frame
  // get a translucent outcome tint (denser strictly-after the mark when
  // soft-truncate is on); a pending subtask frame gets a solid border + tag.
  // Suppressed during playback — the frame counter only tracks while scrubbing.
  const decisionTint =
    !playing && pending.outcome !== null && pending.markedFrame !== null && frame >= pending.markedFrame
      ? {
          color: OUTCOME_HEX[pending.outcome],
          alpha: pending.softTruncate && frame > pending.markedFrame ? 0.4 : 0.2,
        }
      : null;
  const isSubtaskFrame = !playing && pending.subtaskFrames.includes(frame);

  return (
    <div>
      {drift && (
        <div className="mb-3 rounded-lg border border-coral bg-coral-light px-4 py-2 text-xs font-mono text-coral">
          ⚠ frame drift on {cameraLabel(primaryKey)}: {drift}. Do not trust the
          displayed frame — re-seek (arrow keys) before marking.
        </div>
      )}
      {unverifiable && (
        <div className="mb-3 rounded-lg border border-gold bg-gold-light px-4 py-2 text-xs font-mono text-gold">
          ⚠ this browser has no requestVideoFrameCallback — seek landings cannot
          be verified. Review in Chrome/Edge before confirming marks.
        </div>
      )}

      {cropDimsError && (
        <div className="mb-3 rounded-lg border border-gold bg-gold-light px-4 py-2 text-xs font-mono text-gold">
          ⚠ station crops disabled: {cropDimsError}
        </div>
      )}

      <div className={`grid ${gridCols} gap-3`}>
        {cameraKeys.map((key) => {
          const box = cropByCameraKey?.[key];
          // Stable DOM per camera: cropping is style/class-only so toggling
          // (or the dims guard tripping) never remounts (= reloads) the video.
          const cropped =
            cropsActive && box !== undefined && storedFrameHW !== null;
          const frameW = (storedFrameHW ?? [0, 0])[1];
          let containerStyle: React.CSSProperties | undefined;
          let videoStyle: React.CSSProperties | undefined;
          if (cropped) {
            const [x0, y0, x1, y1] = box;
            containerStyle = { aspectRatio: `${x1 - x0} / ${y1 - y0}` };
            videoStyle = {
              position: "absolute",
              maxWidth: "none",
              width: `${(frameW / (x1 - x0)) * 100}%`,
              left: `${(-x0 / (x1 - x0)) * 100}%`,
              top: `${(-y0 / (y1 - y0)) * 100}%`,
            };
          }
          return (
            <div
              key={key}
              className={`relative ${cropped ? "overflow-hidden rounded-lg bg-warm-100" : ""}`}
              style={containerStyle}
            >
              <video
                ref={setVideoRef(key)}
                src={getVideoUrl(key, episode.perCamera[key].fileIndex, datasetId)}
                className={cropped ? "" : "w-full rounded-lg bg-warm-100"}
                style={videoStyle}
                muted
                playsInline
                preload="auto"
                onLoadedMetadata={(e) => {
                  const video = e.target as HTMLVideoElement;
                  video.currentTime =
                    episode.perCamera[key].fromTimestamp + (frame + 0.5) / FPS;
                  if (
                    key === primaryKey &&
                    typeof video.requestVideoFrameCallback !== "function"
                  ) {
                    setUnverifiable(true);
                  }
                  // Crop-dims guard lives in the effect above (src is
                  // per-file, this event fires once per session).
                  setMetadataEpoch((epoch) => epoch + 1);
                }}
              />
              {decisionTint && (
                <div
                  className="absolute inset-0 pointer-events-none rounded-lg"
                  style={{
                    backgroundColor: decisionTint.color,
                    opacity: decisionTint.alpha,
                  }}
                />
              )}
              {isSubtaskFrame && (
                <div
                  className="absolute inset-0 pointer-events-none rounded-lg border-[6px] border-purple-600"
                >
                  <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-purple-600 text-white text-[10px] font-mono font-medium">
                    SUBTASK REWARD
                  </span>
                </div>
              )}
              <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/60 text-white text-[11px] font-mono">
                {cameraLabel(key)}
                {key === primaryKey ? " ·primary" : ""}
                {cropped ? " ·crop" : ""}
              </span>
            </div>
          );
        })}
      </div>

      <Timeline
        rawLength={episode.rawLength}
        frame={frame}
        signals={signals}
        pending={pending}
        onScrub={(next) => {
          if (playingRef.current) stopAndSnap();
          onFrame(next);
        }}
      />

      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={togglePlay}
          className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-teal text-white font-body font-medium text-xs hover:bg-teal/90 transition-colors cursor-pointer"
        >
          {playing ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6,4 20,12 6,20" />
            </svg>
          )}
          {playing ? "Pause" : "Play"}
          <span className="font-mono text-[10px] opacity-70">space</span>
        </button>
        <span className="font-mono text-xs text-ink">
          frame {frame} / {episode.rawLength - 1}
        </span>
        {hasCrops && cropDimsError === null && (
          <button
            onClick={() => setCropOn((on) => !on)}
            className={`ml-auto px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all ${
              cropOn
                ? "bg-teal/10 text-teal border border-teal/40"
                : "bg-white border border-warm-200 text-ink-muted hover:border-warm-300"
            }`}
            title="Station display crops from the task registry (same view as the cv2 editor)"
          >
            station crop {cropOn ? "on" : "off"}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Work queue row
// ---------------------------------------------------------------------------

function QueueRow({
  episode,
  signals,
  signalError,
  review,
  applied,
  selected,
  onSelect,
  arm,
}: {
  episode: ReviewEpisode;
  signals: EpisodeFrameSignals | null;
  signalError: string | null;
  review: ReviewRecord | null;
  /** Applied HF-record state when no web review exists: outcome, or "skip". */
  applied: string | null;
  selected: boolean;
  onSelect: () => void;
  arm: string | null;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 rounded-lg border transition-all cursor-pointer ${
        selected
          ? "bg-teal/10 border-teal shadow-sm"
          : "bg-white border-warm-200 hover:border-warm-300"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-medium text-ink">
          Ep {episode.episodeIndex}
        </span>
        {signalError ? (
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-coral-light text-coral"
            title={signalError}
          >
            error
          </span>
        ) : signals ? (
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${OUTCOME_CHIP[signals.detectedOutcome]}`}
          >
            {signals.detectedOutcome}
          </span>
        ) : (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-warm-100 text-ink-muted animate-pulse">
            …
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 mt-1">
        <span className="text-[10px] font-mono text-ink-muted truncate">
          {episode.rawLength}f
          {arm ? ` · ${arm}` : ""}
        </span>
        {review === null && applied !== null ? (
          <span
            className="text-[10px] font-mono text-teal/70"
            title="Already treated on HuggingFace (applied outcome-edit record)"
          >
            {applied === "skip" ? "skipped" : `✓ ${applied}`} ·applied
          </span>
        ) : review === null ? (
          <span className="text-[10px] font-mono text-ink-muted/60">
            unreviewed
          </span>
        ) : review.status === "confirmed" ? (
          <span
            className="text-[10px] font-mono text-teal"
            title={`${review.reviewer} · ${formatClock(review.savedAt)}`}
          >
            ✓ {review.newOutcome}
            {review.softTruncate ? " ·trunc" : ""}
          </span>
        ) : (
          <span
            className="text-[10px] font-mono text-ink-muted"
            title={`${review.reviewer} · ${formatClock(review.savedAt)}`}
          >
            skipped
          </span>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Commit panel
// ---------------------------------------------------------------------------

function CommitPanel({
  repoId,
  numConfirmed,
  numSkipped,
  numEpisodes,
}: {
  repoId: string;
  numConfirmed: number;
  numSkipped: number;
  numEpisodes: number;
}) {
  const jobs = useQuery(api.applyJobs.forRepo, { dataset_repo: repoId });
  const worker = useQuery(api.applyJobs.workerStatus, {});
  const enqueue = useMutation(api.applyJobs.enqueue);
  const cancelJob = useMutation(api.applyJobs.cancel);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const activeJob = jobs?.find(
    (job) => job.status === "pending" || job.status === "applying"
  );
  const totalReviews = numConfirmed + numSkipped;

  const age = worker ? now - worker.last_seen : null;
  // useQuery: undefined = still loading, null = no heartbeat row exists.
  // Rendering the loading flash as "no worker" trains operators to ignore
  // the one pill that matters when the worker really is dead.
  const workerPill =
    worker === undefined
      ? { text: "checking worker…", className: "bg-warm-100 text-ink-muted" }
      : age === null
      ? {
          text: "no worker has ever checked in",
          className: "bg-coral-light text-coral",
        }
      : age < 90_000
        ? {
            text: `worker live ${formatAge(age)}`,
            className: "bg-teal-light text-teal",
          }
        : age < 600_000
          ? {
              text: `worker last seen ${formatAge(age)}`,
              className: "bg-gold-light text-gold",
            }
          : {
              text: `worker offline (${formatAge(age)}) — start tmux \`arena-review-worker\` (host per docs/policy-arena-review-suite-plan.md)`,
              className: "bg-coral-light text-coral",
            };

  const statusChip: Record<string, string> = {
    pending: "bg-gold-light text-gold",
    applying: "bg-gold-light text-gold",
    applied: "bg-teal-light text-teal",
    failed: "bg-coral-light text-coral",
    cancelled: "bg-warm-100 text-ink-muted",
  };

  return (
    <div className="border-t border-warm-200 bg-warm-50 px-6 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-xs text-ink">
          {numConfirmed} confirmed · {numSkipped} skipped · {numEpisodes} episodes
        </span>
        <span
          className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${workerPill.className}`}
          title={worker ? `${worker.worker_id}${worker.info ? ` · ${worker.info}` : ""}` : undefined}
        >
          {workerPill.text}
        </span>
        <div className="flex-1" />
        <button
          disabled={busy || totalReviews === 0 || Boolean(activeJob)}
          onClick={() => {
            setError(null);
            setBusy(true);
            enqueue({ dataset_repo: repoId })
              .catch((err: Error) => setError(err.message))
              .finally(() => setBusy(false));
          }}
          className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
            busy || totalReviews === 0 || activeJob
              ? "bg-warm-100 text-ink-muted/50 cursor-not-allowed"
              : "bg-teal text-white hover:bg-teal/90 cursor-pointer"
          }`}
        >
          {activeJob ? `Job ${activeJob.status}…` : "Commit to HuggingFace"}
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-coral/30 bg-coral-light px-3 py-2 text-xs text-coral font-mono">
          {error}
        </div>
      )}

      {jobs && jobs.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {jobs.map((job) => (
            <div
              key={job._id}
              className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-ink-muted"
            >
              <span
                className={`px-1.5 py-0.5 rounded ${statusChip[job.status] ?? "bg-warm-100 text-ink-muted"}`}
              >
                {job.status}
              </span>
              <span>{formatClock(job.requested_at)}</span>
              <span>{job.requested_by}</span>
              {job.num_confirmed != null && (
                <span>
                  {Number(job.num_confirmed)} confirmed ·{" "}
                  {Number(job.num_skipped ?? BigInt(0))} skipped
                </span>
              )}
              {job.hf_commit_sha && (
                <a
                  href={`https://huggingface.co/datasets/${repoId}/tree/${job.hf_commit_sha}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-teal hover:underline"
                >
                  {job.hf_commit_sha.slice(0, 8)} →
                </a>
              )}
              {job.error && (
                <button
                  onClick={() => setExpanded(expanded === job._id ? null : job._id)}
                  className="text-coral hover:underline cursor-pointer"
                >
                  {expanded === job._id ? "hide error" : "show error"}
                </button>
              )}
              {(job.status === "pending" ||
                (job.status === "applying" &&
                  job.started_at !== undefined &&
                  now - Number(job.started_at) > 10 * 60 * 1000)) && (
                <button
                  onClick={() => {
                    setError(null);
                    cancelJob({ id: job._id }).catch((err: Error) =>
                      setError(err.message)
                    );
                  }}
                  className="text-ink-muted hover:text-coral cursor-pointer"
                  title={
                    job.status === "applying"
                      ? "Worker claim went stale — reclaim the stuck job, then re-commit"
                      : undefined
                  }
                >
                  {job.status === "applying" ? "reclaim stuck job" : "cancel"}
                </button>
              )}
              {expanded === job._id && (
                <pre className="w-full whitespace-pre-wrap rounded bg-white border border-warm-200 p-2 text-[10px] text-coral">
                  {job.error}
                  {job.log_tail ? `\n\n${job.log_tail}` : ""}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Help overlay
// ---------------------------------------------------------------------------

const HELP_KEYS: [string, string][] = [
  ["← / →", "step 1 frame (shift: 10)"],
  ["[ / ]", "step 30 frames"],
  ["Home / End", "first / last frame"],
  ["space", "play / pause"],
  ["s / f / t", "set outcome success / failure / timeout + mark here"],
  ["m", "move the outcome mark to this frame"],
  ["g", "toggle a subtask mark at this frame"],
  ["x", "toggle soft truncation"],
  ["u", "unmark: reset to the detected outcome"],
  ["c", "confirm + save, advance to the next episode"],
  ["n", "skip (twice when subtask marks are unsaved)"],
  ["p / b", "previous episode in the queue"],
  ["q / Esc", "exit review mode"],
  ["?", "toggle this help"],
];

function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl border border-warm-200 shadow-lg p-6 max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display text-lg text-ink mb-3">Review shortcuts</h3>
        <dl className="space-y-1.5">
          {HELP_KEYS.map(([key, description]) => (
            <div key={key} className="flex items-baseline gap-3 text-xs">
              <dt className="font-mono text-ink w-28 flex-shrink-0">{key}</dt>
              <dd className="text-ink-muted font-body">{description}</dd>
            </div>
          ))}
        </dl>
        <button
          onClick={onClose}
          className="mt-4 px-3 py-1.5 rounded-lg border border-warm-200 text-xs text-ink-muted hover:bg-warm-50 cursor-pointer"
        >
          Close
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outcome review (main)
// ---------------------------------------------------------------------------

export default function OutcomeReview({
  repoId,
  task,
  onExit,
}: {
  repoId: string;
  task?: string;
  onExit: () => void;
}) {
  const viewer = useQuery(api.users.viewer);
  const reviews = useQuery(api.reviews.latestForRepo, { dataset_repo: repoId });
  const taskSpec = useQuery(api.taskSpecs.forTask, task ? { task } : "skip");
  const saveReview = useMutation(api.reviews.save);

  const [episodes, setEpisodes] = useState<ReviewEpisode[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ledgerArms, setLedgerArms] = useState<Map<number, string> | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [armFilter, setArmFilter] = useSearchParam("arm", "all");
  // The APPLIED record on HF (cv2-era sessions + past worker applies) — the
  // record of truth for treatment that already reached the Hub. Without it the
  // queue calls fully-treated datasets "unreviewed". Tri-state: undefined =
  // still loading, null = dataset has no record (never treated).
  const [applied, setApplied] = useState<AppliedProgress | null | undefined>(undefined);
  const [appliedError, setAppliedError] = useState<string | null>(null);
  // First-time flow: only never-addressed episodes (no web review, no applied
  // record entry). Switch to "all" to revisit treated episodes.
  const [statusFilter, setStatusFilter] = useSearchParam("status", "unaddressed");
  // Append-only label-provenance ledger (who/when/how for every label change).
  // Supplementary: absence or load failure never blocks reviewing.
  const [labelHistory, setLabelHistory] = useState<LabelEvent[] | null | undefined>(undefined);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [signals, setSignals] = useState<Map<number, EpisodeFrameSignals>>(
    () => new Map()
  );
  const [signalErrors, setSignalErrors] = useState<Map<number, string>>(
    () => new Map()
  );
  const [filter, setFilter] = useSearchParam("queue", "failure");
  const [selectedEpisode, setSelectedEpisode] = useSearchParamNumber("episode");
  const [frame, setFrame] = useState(0);
  const [pending, setPending] = useState<PendingReview>(EMPTY_PENDING);
  const [viewerDrift, setViewerDrift] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [skipArmed, setSkipArmed] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const controlsRef = useRef<ViewerControls | null>(null);

  // Exported registry row wins; hardcoded map only bridges MISSING rows.
  // Convex useQuery is undefined WHILE LOADING and null for a missing row —
  // only the latter may fall back. Treating "loading" as 0 marks hides
  // subtask work and lets structurally-invalid labels through, so actions
  // and the unaddressed filter gate on specReady.
  const specReady = !task || taskSpec !== undefined;
  const subtaskMarksRequired = task
    ? taskSpec != null
      ? Number(taskSpec.num_subtask_marks)
      : (REVIEW_SUBTASK_MARKS[task] ?? 0)
    : 0;

  // -- Episode metadata --------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setEpisodes(null);
    setLoadError(null);
    fetchReviewEpisodes(repoId)
      .then((result) => {
        if (!cancelled) setEpisodes(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  // -- Applied outcome-edit record from HF (absence = never treated) --------
  useEffect(() => {
    let cancelled = false;
    setApplied(undefined);
    setAppliedError(null);
    fetchAppliedProgress(repoId)
      .then((progress) => {
        if (!cancelled) setApplied(progress);
      })
      .catch((err: Error) => {
        // A present-but-unreadable record must be loud: silently treating a
        // fully-reviewed dataset as unaddressed invites duplicate review work.
        if (!cancelled) setAppliedError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  // -- Label-history ledger (provenance; absence is fine) -------------------
  useEffect(() => {
    let cancelled = false;
    setLabelHistory(undefined);
    setHistoryError(null);
    fetchLabelHistory(repoId)
      .then((events) => {
        if (!cancelled) setLabelHistory(events);
      })
      .catch((err: Error) => {
        if (!cancelled) setHistoryError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  const historyByEpisode = useMemo(() => {
    const byEpisode = new Map<number, LabelEvent[]>();
    for (const event of labelHistory ?? []) {
      const list = byEpisode.get(event.episode_index);
      if (list) list.push(event);
      else byEpisode.set(event.episode_index, [event]);
    }
    // "Current" = last by TIMESTAMP, not file order — a bootstrap appended
    // around live events must not misreport the current label source.
    for (const list of byEpisode.values()) {
      list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    }
    return byEpisode;
  }, [labelHistory]);

  // -- Ledger arm labels (optional sidecars; absence is fine) --------------
  useEffect(() => {
    let cancelled = false;
    setLedgerArms(null);
    setLedgerError(null);
    fetchLedgerArms(repoId)
      .then((arms) => {
        if (!cancelled) setLedgerArms(arms);
      })
      .catch((err: Error) => {
        // A malformed ledger must be visible, not silently unfiltered.
        if (!cancelled) setLedgerError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  // -- Detected outcomes, progressively in the background -----------------
  useEffect(() => {
    if (!episodes) return;
    let cancelled = false;
    const queue = [...episodes];
    const worker = async () => {
      while (!cancelled) {
        const episode = queue.shift();
        if (!episode) return;
        try {
          const result = await fetchEpisodeFrameSignals(
            repoId,
            episode.dataPath,
            episode.episodeIndex
          );
          if (cancelled) return;
          setSignals((prev) => new Map(prev).set(episode.episodeIndex, result));
        } catch (err) {
          if (cancelled) return;
          // Surfaced in the queue row + a banner; never defaulted to an outcome.
          setSignalErrors((prev) =>
            new Map(prev).set(episode.episodeIndex, (err as Error).message)
          );
        }
      }
    };
    void Promise.all(
      Array.from({ length: SIGNAL_CONCURRENCY }, () => worker())
    );
    return () => {
      cancelled = true;
    };
  }, [episodes, repoId]);

  // -- Convex reviews ----------------------------------------------------
  const reviewByEpisode = useMemo(() => {
    const map = new Map<number, ReviewRecord>();
    for (const row of reviews?.episodes ?? []) {
      map.set(Number(row.episode_index), {
        episodeIndex: Number(row.episode_index),
        status: row.status,
        newOutcome: (row.new_outcome as Outcome | undefined) ?? null,
        outcomeFrame:
          row.outcome_frame != null ? Number(row.outcome_frame) : null,
        softTruncate: row.soft_truncate ?? false,
        subtaskFrames: row.subtask_frames
          ? row.subtask_frames.map((value) => Number(value))
          : null,
        reviewer: row.reviewer,
        savedAt: row.saved_at,
      });
    }
    return map;
  }, [reviews]);

  const effectiveOutcome = useCallback(
    (episodeIndex: number): Outcome | null => {
      const review = reviewByEpisode.get(episodeIndex);
      if (review?.status === "confirmed" && review.newOutcome) {
        return review.newOutcome;
      }
      return signals.get(episodeIndex)?.detectedOutcome ?? null;
    },
    [reviewByEpisode, signals]
  );

  const armOptions = useMemo(
    () => (ledgerArms ? [...new Set(ledgerArms.values())].sort() : []),
    [ledgerArms]
  );

  // Addressed = a web review exists OR the applied HF record already carries
  // the episode (changed or skipped — a cv2-era skip is a deliberate
  // keep-labels-as-is decision, not an omission). On a subtask task a changed
  // record WITHOUT the subtask_frames key predates subtask review and must
  // re-queue, exactly like episode_fully_processed in the cv2 editor.
  const isAddressed = useCallback(
    (episodeIndex: number): boolean => {
      if (reviewByEpisode.has(episodeIndex)) return true;
      if (applied == null) return false;
      if (applied.skipped.has(episodeIndex)) return true;
      const record = applied.changed.get(episodeIndex);
      if (record === undefined) return false;
      return subtaskMarksRequired <= 0 || record.subtaskFrames !== null;
    },
    [reviewByEpisode, applied, subtaskMarksRequired]
  );

  const filteredEpisodes = useMemo(() => {
    if (!episodes) return [];
    let result = episodes;
    if (statusFilter === "unaddressed") {
      // Addressed-ness is unknown until the applied record AND the task spec
      // settle (isAddressed's subtask-key rule needs subtaskMarksRequired) —
      // an early queue here would flash fully-treated episodes. A load ERROR
      // falls through unfiltered (the loud banner explains treated episodes
      // may show as unaddressed) rather than blanking the queue forever.
      if ((applied === undefined && appliedError === null) || !specReady) return [];
      if (applied !== undefined) {
        result = result.filter((episode) => !isAddressed(episode.episodeIndex));
      }
    }
    if (filter !== "all") {
      result = result.filter(
        (episode) => effectiveOutcome(episode.episodeIndex) === filter
      );
    }
    // A stale ?arm= from another dataset must not silently empty the queue:
    // only apply the filter when the value exists in THIS dataset's ledger.
    if (armFilter !== "all" && ledgerArms && armOptions.includes(armFilter)) {
      result = result.filter(
        (episode) => ledgerArms.get(episode.episodeIndex) === armFilter
      );
    }
    return result;
  }, [
    episodes,
    statusFilter,
    applied,
    isAddressed,
    filter,
    effectiveOutcome,
    armFilter,
    ledgerArms,
    armOptions,
  ]);

  const currentEpisode = useMemo(
    () =>
      episodes?.find((episode) => episode.episodeIndex === selectedEpisode) ??
      null,
    [episodes, selectedEpisode]
  );
  const currentSignals =
    selectedEpisode !== null ? (signals.get(selectedEpisode) ?? null) : null;
  const currentSignalError =
    selectedEpisode !== null ? (signalErrors.get(selectedEpisode) ?? null) : null;

  // Pull the selected episode's signals to the front of the queue. Keyed on a
  // boolean, not the signals map, so unrelated background arrivals do not
  // re-fire this fetch on every update.
  const currentSignalsMissing =
    currentEpisode !== null && !signals.has(currentEpisode.episodeIndex);
  useEffect(() => {
    if (!currentEpisode || !currentSignalsMissing) return;
    let cancelled = false;
    fetchEpisodeFrameSignals(
      repoId,
      currentEpisode.dataPath,
      currentEpisode.episodeIndex
    )
      .then((result) => {
        if (!cancelled) {
          setSignals((prev) =>
            new Map(prev).set(currentEpisode.episodeIndex, result)
          );
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setSignalErrors((prev) =>
            new Map(prev).set(currentEpisode.episodeIndex, err.message)
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentEpisode, currentSignalsMissing, repoId]);

  // Auto-select the head of the queue when nothing is selected yet.
  useEffect(() => {
    if (selectedEpisode !== null) return;
    const head = filteredEpisodes[0];
    if (head) setSelectedEpisode(head.episodeIndex);
  }, [selectedEpisode, filteredEpisodes, setSelectedEpisode]);

  // -- Prefill on episode open -------------------------------------------
  const prefilledFor = useRef<number | null>(null);

  // Selection change: IMMEDIATELY clear the previous episode's decision state.
  // The prefill below waits on async loads (signals, applied record); without
  // this reset the old episode's tint/chips/marks render over the NEW
  // episode's video for seconds, and edits made in that gap are discarded.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- imperative reset of
       working state on selection change, not derived render state. */
    setPending(EMPTY_PENDING);
    setFrame(0);
    setDirty(false);
    setSkipArmed(false);
    setViewerDrift(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selectedEpisode]);

  useEffect(() => {
    if (selectedEpisode === null || !currentSignals) return;
    // The applied HF record outranks detected signals in the prefill — wait
    // for it to settle (a load error falls through, with its loud banner).
    if (applied === undefined && appliedError === null) return;
    if (prefilledFor.current === selectedEpisode) return;
    prefilledFor.current = selectedEpisode;
    // Opening an episode resets the operator's working state to the prefill:
    // web review > applied HF record (cv2 resume semantics) > detected signals.
    const review = reviewByEpisode.get(selectedEpisode);
    const appliedRecord = applied?.changed.get(selectedEpisode);
    if (review?.status === "confirmed" && review.newOutcome) {
      setPending({
        outcome: review.newOutcome,
        markedFrame: review.outcomeFrame,
        subtaskFrames: review.subtaskFrames ?? [],
        softTruncate: review.softTruncate,
      });
    } else if (
      // A web SKIP means keep-labels-as-is: the as-is state IS the applied
      // record when one exists (falling to detected signals here would show
      // the pre-edit outcome and a stray confirm could revert an applied edit).
      (review === undefined || review.status === "skipped") &&
      appliedRecord !== undefined
    ) {
      setPending({
        outcome: appliedRecord.newOutcome as Outcome,
        markedFrame: appliedRecord.outcomeFrame,
        subtaskFrames: appliedRecord.subtaskFrames ?? [],
        softTruncate: appliedRecord.softTruncate,
      });
    } else {
      setPending({
        outcome: currentSignals.detectedOutcome,
        markedFrame:
          currentSignals.doneOnsetFrame ?? currentSignals.lastValidFrame,
        subtaskFrames: [],
        softTruncate: false,
      });
    }
    setFrame(0);
    setDirty(false);
    setSkipArmed(false);
    setActionError(null);
  }, [selectedEpisode, currentSignals, reviewByEpisode, applied, appliedError]);

  // -- Actions -----------------------------------------------------------
  const selectEpisode = useCallback(
    (episodeIndex: number) => {
      setSelectedEpisode(episodeIndex);
    },
    [setSelectedEpisode]
  );

  const advance = useCallback(
    (fromIndex: number) => {
      const position = filteredEpisodes.findIndex(
        (episode) => episode.episodeIndex === fromIndex
      );
      // Out-of-queue (e.g. a deep-linked addressed episode under the
      // unaddressed filter): advancing would silently jump to the queue HEAD
      // and walk already-done work. Stay put instead.
      if (position === -1) return;
      const next = filteredEpisodes[position + 1];
      if (next) selectEpisode(next.episodeIndex);
    },
    [filteredEpisodes, selectEpisode]
  );

  const confirm = useCallback(async () => {
    if (selectedEpisode === null || saving) return;
    // The pending state still holds the PREVIOUS episode's decision until this
    // episode's signals arrive and the prefill effect runs — confirming in
    // that window would record the old outcome/frame onto the new episode.
    if (prefilledFor.current !== selectedEpisode) {
      setActionError(
        `Episode ${selectedEpisode} is still loading — wait for the outcome prefill.`
      );
      return;
    }
    if (!specReady) {
      // Confirming against the fallback mark count could save a structurally
      // invalid label (e.g. a subtask success with no marks, key omitted).
      setActionError("Task spec still loading — wait before confirming.");
      return;
    }
    if (viewerDrift !== null) {
      setActionError(
        `Video/frame-counter drift detected (${viewerDrift}) — reload before confirming; ` +
          "the displayed frame may not be the counted frame."
      );
      return;
    }
    if (!pending.outcome) {
      setActionError("Set an outcome (s / f / t) before confirming.");
      return;
    }
    if (pending.markedFrame === null) {
      setActionError("Mark the outcome frame (m) before confirming.");
      return;
    }
    if (subtaskMarksRequired > 0) {
      const countError = subtaskMarkCountError(
        pending.outcome,
        pending.subtaskFrames.length,
        subtaskMarksRequired
      );
      if (countError) {
        setActionError(
          `Cannot confirm: ${countError}; press g to toggle a subtask mark.`
        );
        return;
      }
      const late = pending.subtaskFrames.filter(
        (mark) => mark >= (pending.markedFrame as number)
      );
      if (late.length > 0) {
        setActionError(
          `Subtask mark(s) ${late.join(", ")} are not before the outcome frame ` +
            `${pending.markedFrame}; move them earlier (g to toggle).`
        );
        return;
      }
    } else if (pending.subtaskFrames.length > 0) {
      setActionError(
        `Task ${task ?? "(unknown)"} takes no subtask marks; remove them with g.`
      );
      return;
    }

    setSaving(true);
    setActionError(null);
    try {
      await saveReview({
        dataset_repo: repoId,
        episode_index: BigInt(selectedEpisode),
        status: "confirmed",
        new_outcome: pending.outcome,
        outcome_frame: BigInt(pending.markedFrame),
        soft_truncate: pending.softTruncate,
        // The key's PRESENCE marks this as reviewed in subtask mode, exactly
        // like the desktop editor's progress record. Omit it when N == 0.
        subtask_frames:
          subtaskMarksRequired > 0
            ? pending.subtaskFrames.map((mark) => BigInt(mark))
            : undefined,
      });
      setDirty(false);
      advance(selectedEpisode);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [
    advance,
    pending,
    repoId,
    saveReview,
    saving,
    selectedEpisode,
    specReady,
    subtaskMarksRequired,
    task,
    viewerDrift,
  ]);

  const skip = useCallback(async () => {
    if (selectedEpisode === null || saving) return;
    // Same prefill-race guard as confirm: pending may still be the previous
    // episode's state (its subtask marks would trigger a bogus double-n arm).
    if (prefilledFor.current !== selectedEpisode) {
      setActionError(
        `Episode ${selectedEpisode} is still loading — wait for the outcome prefill.`
      );
      return;
    }
    if (!specReady) {
      setActionError("Task spec still loading — wait before skipping.");
      return;
    }
    if (pending.subtaskFrames.length > 0 && !skipArmed) {
      // Mirrors the cv2 editor's double-n guard: skipping would silently drop
      // marks the operator already placed.
      setSkipArmed(true);
      setActionError(
        `Episode ${selectedEpisode} has ${pending.subtaskFrames.length} unsaved subtask ` +
          `mark(s) at ${pending.subtaskFrames.join(", ")}. Press c to SAVE, or n again to DISCARD.`
      );
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      await saveReview({
        dataset_repo: repoId,
        episode_index: BigInt(selectedEpisode),
        status: "skipped",
      });
      setDirty(false);
      setSkipArmed(false);
      advance(selectedEpisode);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [
    advance,
    pending.subtaskFrames,
    repoId,
    saveReview,
    saving,
    selectedEpisode,
    skipArmed,
    specReady,
  ]);

  // Stepping while playing would desync the frame counter from the video, so a
  // navigation key stops playback first (the cv2 editor does the same).
  const stepFrame = useCallback(
    (delta: number) => {
      if (!currentEpisode) return;
      controlsRef.current?.pause();
      setFrame((prev) => clamp(prev + delta, 0, currentEpisode.rawLength - 1));
    },
    [currentEpisode]
  );

  const jumpToFrame = useCallback((next: number) => {
    controlsRef.current?.pause();
    setFrame(next);
  }, []);

  const updatePending = useCallback((update: Partial<PendingReview>) => {
    setPending((prev) => ({ ...prev, ...update }));
    setDirty(true);
  }, []);

  // -- Keyboard ----------------------------------------------------------
  function handleKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const key = event.key;
    if (key !== "n") setSkipArmed(false);

    if (showHelp && (key === "Escape" || key === "q" || key === "?")) {
      event.preventDefault();
      setShowHelp(false);
      return;
    }
    if (key === "Escape" || key === "q") {
      event.preventDefault();
      onExit();
      return;
    }
    if (key === "?") {
      event.preventDefault();
      setShowHelp(true);
      return;
    }
    if (!currentEpisode) return;

    switch (key) {
      case "ArrowLeft":
        event.preventDefault();
        stepFrame(event.shiftKey ? -10 : -1);
        return;
      case "ArrowRight":
        event.preventDefault();
        stepFrame(event.shiftKey ? 10 : 1);
        return;
      case "[":
        event.preventDefault();
        stepFrame(-30);
        return;
      case "]":
        event.preventDefault();
        stepFrame(30);
        return;
      case "Home":
        event.preventDefault();
        jumpToFrame(0);
        return;
      case "End":
        event.preventDefault();
        jumpToFrame(currentEpisode.rawLength - 1);
        return;
      case " ":
        event.preventDefault();
        controlsRef.current?.togglePlay();
        return;
      case "s":
      case "f":
      case "t": {
        event.preventDefault();
        // During playback the `frame` state is FROZEN at the play-start value;
        // pause() returns the actually-displayed frame — mark there.
        const markAt = controlsRef.current?.pause() ?? frame;
        const outcome: Outcome =
          key === "s" ? "success" : key === "f" ? "failure" : "timeout";
        updatePending({ outcome, markedFrame: markAt });
        setActionError(null);
        return;
      }
      case "m":
      case "Enter": {
        event.preventDefault();
        const markAt = controlsRef.current?.pause() ?? frame;
        updatePending({ markedFrame: markAt });
        setActionError(null);
        return;
      }
      case "g": {
        event.preventDefault();
        if (!specReady) {
          setActionError("Task spec still loading — wait before placing subtask marks.");
          return;
        }
        if (subtaskMarksRequired <= 0) {
          setActionError(
            `Task ${task ?? "(unknown)"} defines 0 subtask marks (RealTaskSpec.num_subtask_marks).`
          );
          return;
        }
        const markAt = controlsRef.current?.pause() ?? frame;
        const marks = pending.subtaskFrames;
        if (marks.includes(markAt)) {
          updatePending({ subtaskFrames: marks.filter((m) => m !== markAt) });
          setActionError(null);
        } else if (marks.length >= subtaskMarksRequired) {
          setActionError(
            `Already have ${subtaskMarksRequired} subtask mark(s); press g on a marked frame to remove one.`
          );
        } else {
          updatePending({ subtaskFrames: [...marks, markAt].sort((a, b) => a - b) });
          setActionError(null);
        }
        return;
      }
      case "x":
        event.preventDefault();
        updatePending({ softTruncate: !pending.softTruncate });
        return;
      case "u":
        event.preventDefault();
        if (!currentSignals) return;
        updatePending({
          outcome: currentSignals.detectedOutcome,
          markedFrame: null,
          subtaskFrames: [],
          softTruncate: false,
        });
        setActionError(null);
        return;
      case "c":
        event.preventDefault();
        void confirm();
        return;
      case "n":
        event.preventDefault();
        void skip();
        return;
      case "p":
      case "b": {
        event.preventDefault();
        const position = filteredEpisodes.findIndex(
          (episode) => episode.episodeIndex === currentEpisode.episodeIndex
        );
        if (position === -1) {
          setActionError(
            "This episode is not in the current queue; pick one from the list."
          );
          return;
        }
        const previous = filteredEpisodes[position - 1];
        if (previous) selectEpisode(previous.episodeIndex);
        else setActionError("Already at the first episode in the queue.");
        return;
      }
      default:
        return;
    }
  }

  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keyHandlerRef.current = handleKey;
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // -- Render ------------------------------------------------------------
  const cameraKeys = useMemo(() => {
    if (!currentEpisode) return [];
    const all = orderCameraKeys(
      explorerCameraKeys(Object.keys(currentEpisode.perCamera))
    );
    // Task-default review cameras (RealTaskSpec.consumed_camera_roles, e.g.
    // marker_d2 -> side_1 + wrist_left), in the spec's display order. Fall
    // back to every stream when the spec has no default or nothing matches
    // (legacy key namespaces).
    const roles = taskSpec?.review_camera_roles;
    if (roles == null || roles.length === 0) return all;
    const keysByRole = taskSpec!.camera_keys_by_role;
    const selected = roles
      .map((role) =>
        all.find((key) => cameraRoleForVideoKey(key, keysByRole) === role)
      )
      .filter((key): key is string => key !== undefined);
    return selected.length > 0 ? selected : all;
  }, [currentEpisode, taskSpec]);

  // A PARTIAL role match must not pass silently: the task registry says the
  // review needs these views, and judging outcomes from fewer is a banner-
  // worthy degradation (e.g. a role hidden by the explorer's key filter).
  const missingCameraRoles = useMemo(() => {
    const roles = taskSpec?.review_camera_roles;
    if (!currentEpisode || roles == null || roles.length === 0) return [];
    const keysByRole = taskSpec!.camera_keys_by_role;
    const all = orderCameraKeys(
      explorerCameraKeys(Object.keys(currentEpisode.perCamera))
    );
    return roles.filter(
      (role) => !all.some((key) => cameraRoleForVideoKey(key, keysByRole) === role)
    );
  }, [currentEpisode, taskSpec]);
  const primaryKey = useMemo(
    () => (cameraKeys.length > 0 ? selectPrimaryCameraKey(cameraKeys) : ""),
    [cameraKeys]
  );

  // Station display crops from the exported task spec, resolved per video key
  // (role- or serial-named), in stored-frame pixel space.
  const storedFrameHW = useMemo<[number, number] | null>(
    () =>
      taskSpec != null
        ? [Number(taskSpec.stored_frame_hw[0]), Number(taskSpec.stored_frame_hw[1])]
        : null,
    [taskSpec]
  );
  const cropByCameraKey = useMemo<Record<string, CropBox> | null>(() => {
    if (taskSpec == null) return null;
    const keysByRole = taskSpec.camera_keys_by_role;
    const map: Record<string, CropBox> = {};
    for (const key of cameraKeys) {
      const role = cameraRoleForVideoKey(key, keysByRole);
      const box = role !== null ? taskSpec.crop_boxes[role] : undefined;
      if (box !== undefined) {
        map[key] = box.map(Number) as CropBox;
      }
    }
    return map;
  }, [taskSpec, cameraKeys]);

  const numConfirmed = reviews?.num_confirmed ?? 0;
  const numSkipped = reviews?.num_skipped ?? 0;
  const numLoadedSignals = signals.size;
  const numAddressed = useMemo(
    () =>
      episodes === null || (applied === undefined && appliedError === null) || !specReady
        ? null
        : episodes.filter((episode) => isAddressed(episode.episodeIndex)).length,
    [episodes, applied, appliedError, isAddressed, specReady]
  );

  if (!viewer?.isEditor) {
    return (
      <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8">
        <button
          onClick={onExit}
          className="text-xs text-ink-muted hover:text-teal mb-4 cursor-pointer"
        >
          &larr; Back to explorer
        </button>
        <p className="font-body text-ink-muted text-center">
          {viewer === undefined
            ? "Checking permissions…"
            : "Outcome review is limited to allowlisted editors. Sign in with an editor account."}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-warm-200 shadow-sm overflow-hidden">
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}

      {/* Header */}
      <div className="px-6 py-4 border-b border-warm-100 bg-warm-50 flex items-center justify-between gap-4">
        <div>
          <button
            onClick={onExit}
            className="text-xs text-ink-muted hover:text-teal cursor-pointer"
          >
            &larr; Back to explorer
          </button>
          <h2 className="font-display text-xl text-ink mt-1">Outcome review</h2>
          <p className="text-xs text-ink-muted font-mono mt-0.5">
            {repoId}
            {task ? ` · ${task}` : ""} ·{" "}
            {subtaskMarksRequired > 0
              ? `${subtaskMarksRequired} subtask mark(s) required`
              : "no subtask marks"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-ink-muted">
            {dirty
              ? "unsaved changes"
              : selectedEpisode !== null && reviewByEpisode.has(selectedEpisode)
                ? "saved ✓"
                : "no web review yet"}
          </span>
          <button
            onClick={() => setShowHelp(true)}
            className="w-7 h-7 rounded-full border border-warm-200 text-ink-muted hover:text-teal hover:border-teal text-sm cursor-pointer"
            title="Keyboard shortcuts"
          >
            ?
          </button>
        </div>
      </div>

      {loadError && (
        <div className="mx-6 mt-4 rounded-lg border border-coral/30 bg-coral-light px-4 py-3 text-sm text-coral font-mono">
          Failed to load episode metadata: {loadError}
        </div>
      )}
      {appliedError && (
        <div className="mx-6 mt-4 rounded-lg border border-coral/30 bg-coral-light px-4 py-3 text-xs text-coral font-mono">
          Failed to load the applied outcome-edit record — treated episodes may
          show as unaddressed: {appliedError}
        </div>
      )}
      {historyError && (
        <div className="mx-6 mt-4 rounded-lg border border-gold/40 bg-gold-light px-4 py-3 text-xs text-ink font-mono">
          Label-history ledger failed to load (provenance hidden, reviewing
          unaffected): {historyError}
        </div>
      )}
      {missingCameraRoles.length > 0 && (
        <div className="mx-6 mt-4 rounded-lg border border-gold/40 bg-gold-light px-4 py-3 text-xs text-ink font-mono">
          Task expects review camera(s) {missingCameraRoles.join(", ")} but no
          matching stream was found in this dataset — judging from the
          remaining views only.
        </div>
      )}
      {signalErrors.size > 0 && (
        <div className="mx-6 mt-4 rounded-lg border border-coral/30 bg-coral-light px-4 py-3 text-xs text-coral font-mono">
          {signalErrors.size} episode(s) failed frame-signal parsing:{" "}
          {[...signalErrors.entries()]
            .slice(0, 3)
            .map(([index, message]) => `ep ${index}: ${message}`)
            .join(" · ")}
        </div>
      )}

      <div className="grid grid-cols-[260px_1fr] gap-0">
        {/* Work queue */}
        <div className="border-r border-warm-100 p-4 flex flex-col gap-3 max-h-[80vh]">
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              e.currentTarget.blur();
            }}
            className="w-full rounded-lg border border-warm-200 bg-white px-2 py-1.5 text-xs font-body text-ink cursor-pointer"
            title="Unaddressed = no web review and not in the applied HF record"
          >
            <option value="unaddressed">Unaddressed only</option>
            <option value="all">All statuses</option>
          </select>
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as QueueFilter);
              // A focused select swallows the review shortcuts and letter keys
              // drive its native typeahead — release focus after each change.
              e.currentTarget.blur();
            }}
            className="w-full rounded-lg border border-warm-200 bg-white px-2 py-1.5 text-xs font-body text-ink cursor-pointer"
          >
            {QUEUE_FILTERS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {armOptions.length > 0 && (
            <select
              value={armFilter}
              onChange={(e) => {
                setArmFilter(e.target.value);
                e.currentTarget.blur();
              }}
              className="w-full rounded-lg border border-warm-200 bg-white px-2 py-1.5 text-xs font-body text-ink cursor-pointer"
              title="Filter by ledger arm (blind_dagger / protocol_quota / teleop_manifest ledgers)"
            >
              <option value="all">All arms</option>
              {armOptions.map((arm) => (
                <option key={arm} value={arm}>
                  {arm}
                </option>
              ))}
            </select>
          )}
          {ledgerError && (
            <div className="rounded-lg border border-coral/30 bg-coral-light px-2 py-1.5 text-[10px] text-coral font-mono">
              arm filter unavailable — ledger parse failed: {ledgerError}
            </div>
          )}
          <div className="text-[11px] font-mono text-ink-muted">
            {numAddressed ?? "…"} of {episodes?.length ?? 0} addressed ·{" "}
            {reviewByEpisode.size} this web ledger ·{" "}
            {filteredEpisodes.length} in queue
            {episodes && numLoadedSignals < episodes.length && (
              <span className="block animate-pulse">
                outcomes {numLoadedSignals}/{episodes.length}…
              </span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {episodes === null && !loadError && (
              <div className="flex items-center gap-2 text-xs text-ink-muted">
                <div className="w-4 h-4 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
                Loading episodes…
              </div>
            )}
            {filteredEpisodes.map((episode) => (
              <QueueRow
                key={episode.episodeIndex}
                episode={episode}
                signals={signals.get(episode.episodeIndex) ?? null}
                signalError={signalErrors.get(episode.episodeIndex) ?? null}
                review={reviewByEpisode.get(episode.episodeIndex) ?? null}
                applied={
                  applied?.changed.get(episode.episodeIndex)?.newOutcome ??
                  (applied?.skipped.has(episode.episodeIndex) ? "skip" : null)
                }
                selected={selectedEpisode === episode.episodeIndex}
                onSelect={() => selectEpisode(episode.episodeIndex)}
                arm={ledgerArms?.get(episode.episodeIndex) ?? null}
              />
            ))}
            {episodes !== null && filteredEpisodes.length === 0 && (
              <div className="text-xs text-ink-muted font-body">
                {statusFilter === "unaddressed" &&
                applied === undefined &&
                appliedError === null
                  ? "Checking the applied HF record…"
                  : statusFilter === "unaddressed" &&
                      episodes.length > 0 &&
                      episodes.every((episode) => isAddressed(episode.episodeIndex))
                    ? `All ${episodes.length} episodes are already addressed. ` +
                      `Switch to "All statuses" to revisit them.`
                    : "No episodes match this filter yet."}
              </div>
            )}
          </div>
        </div>

        {/* Viewer */}
        <div className="p-5">
          {currentEpisode === null ? (
            <div className="py-16 text-center text-ink-muted font-body">
              Select an episode from the queue to review it.
            </div>
          ) : currentSignalError ? (
            <div className="rounded-lg border border-coral/30 bg-coral-light px-4 py-3 text-sm text-coral font-mono">
              Episode {currentEpisode.episodeIndex} frame signals failed to
              parse: {currentSignalError}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 mb-3">
                <span className="font-display text-lg text-ink">
                  Episode {currentEpisode.episodeIndex}
                </span>
                {currentSignals ? (
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${OUTCOME_CHIP[currentSignals.detectedOutcome]}`}
                  >
                    detected {currentSignals.detectedOutcome}
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-xs bg-warm-100 text-ink-muted animate-pulse">
                    detecting…
                  </span>
                )}
                {(() => {
                  const chain = historyByEpisode.get(currentEpisode.episodeIndex);
                  const last = chain?.[chain.length - 1];
                  if (!last) return null;
                  return (
                    <span
                      className="px-2 py-0.5 rounded-full text-xs font-mono bg-warm-100 text-ink-muted"
                      title={`Current label source (${chain!.length} event${chain!.length === 1 ? "" : "s"} in ledger): ${describeLabelPayload(last.label_kind, last.payload)} at ${last.ts}`}
                    >
                      {sourceLabel(last)}
                    </span>
                  );
                })()}
                {reviewByEpisode.get(currentEpisode.episodeIndex) === undefined &&
                  applied != null &&
                  (applied.changed.has(currentEpisode.episodeIndex) ||
                    applied.skipped.has(currentEpisode.episodeIndex)) && (
                    <span
                      className="px-2 py-0.5 rounded-full text-xs font-medium bg-teal/10 text-teal"
                      title="This episode's decisions are already applied on HuggingFace; confirming records a NEW review on top"
                    >
                      already applied on HF
                      {applied.skipped.has(currentEpisode.episodeIndex)
                        ? " (skip)"
                        : ""}
                    </span>
                  )}
                {pending === EMPTY_PENDING && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-warm-100 text-ink-muted animate-pulse">
                    loading decision…
                  </span>
                )}
                {pending.outcome && (
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium ${OUTCOME_CHIP[pending.outcome]}`}
                  >
                    pending {pending.outcome}
                    {pending.markedFrame !== null
                      ? ` @ ${pending.markedFrame}`
                      : " (unmarked)"}
                  </span>
                )}
                {pending.softTruncate && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-coral-light text-coral">
                    soft-truncate
                  </span>
                )}
                {subtaskMarksRequired > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-purple-100 text-purple-700">
                    subtask {pending.subtaskFrames.length}/{subtaskMarksRequired}
                    {pending.subtaskFrames.length > 0
                      ? ` @ ${pending.subtaskFrames.join(", ")}`
                      : ""}
                  </span>
                )}
                {currentSignals && (
                  <span className="text-[11px] font-mono text-ink-muted">
                    valid {currentSignals.validLength}/{currentEpisode.rawLength}
                    {currentSignals.doneOnsetFrame != null
                      ? ` · done@${currentSignals.doneOnsetFrame}`
                      : ""}
                  </span>
                )}
              </div>

              {actionError && (
                <div className="mb-3 rounded-lg border border-coral/30 bg-coral-light px-3 py-2 text-xs text-coral font-mono">
                  {actionError}
                </div>
              )}

              {cameraKeys.length === 0 ? (
                <div className="rounded-lg border border-coral/30 bg-coral-light px-4 py-3 text-sm text-coral font-mono">
                  Episode {currentEpisode.episodeIndex} exposes no reviewable
                  camera streams.
                </div>
              ) : (
                <ReviewViewer
                  datasetId={repoId}
                  episode={currentEpisode}
                  cameraKeys={cameraKeys}
                  primaryKey={primaryKey}
                  frame={frame}
                  onFrame={setFrame}
                  signals={currentSignals}
                  pending={pending}
                  controlsRef={controlsRef}
                  cropByCameraKey={cropByCameraKey}
                  storedFrameHW={storedFrameHW}
                  onDrift={setViewerDrift}
                />
              )}

              {(() => {
                const chain = historyByEpisode.get(currentEpisode.episodeIndex);
                if (!chain || chain.length === 0) return null;
                return (
                  <div className="mt-3 rounded-lg border border-warm-200 bg-warm-50 px-3 py-2">
                    <div className="text-[10px] font-mono uppercase tracking-wide text-ink-muted mb-1">
                      Label history · {chain.length} event{chain.length === 1 ? "" : "s"}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {chain.map((event, i) => {
                        const seek = eventSeekFrame(event);
                        const current = i === chain.length - 1;
                        return (
                          <button
                            key={i}
                            disabled={seek === null}
                            // jumpToFrame (not raw setFrame): it pauses first —
                            // a seek during playback would be silently reverted
                            // by the next stopAndSnap.
                            onClick={() =>
                              seek !== null &&
                              jumpToFrame(
                                clamp(seek, 0, currentEpisode.rawLength - 1)
                              )
                            }
                            title={
                              seek === null
                                ? undefined
                                : seek > currentEpisode.rawLength - 1
                                  ? `Seek to frame ${currentEpisode.rawLength - 1} (event frame ${seek} is beyond this timeline)`
                                  : `Seek to frame ${seek}`
                            }
                            className={`flex items-baseline gap-2 text-left text-[11px] font-mono rounded px-1 -mx-1 ${
                              seek !== null ? "cursor-pointer hover:bg-warm-100" : "cursor-default"
                            } ${current ? "text-ink" : "text-ink-muted"}`}
                          >
                            <span className="shrink-0 text-ink-muted/70">
                              {event.ts.slice(0, 16).replace("T", " ")}
                            </span>
                            <span className="shrink-0">{sourceLabel(event)}</span>
                            <span className={current ? "font-medium" : ""}>
                              {describeLabelPayload(event.label_kind, event.payload)}
                              {current ? "  ← current" : ""}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {OUTCOMES.map((outcome) => (
                  <button
                    key={outcome}
                    onClick={() => {
                      updatePending({ outcome, markedFrame: frame });
                      setActionError(null);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all ${
                      pending.outcome === outcome
                        ? OUTCOME_CHIP[outcome]
                        : "bg-white border border-warm-200 text-ink-muted hover:border-warm-300"
                    }`}
                  >
                    {outcome}
                    <span className="ml-1.5 font-mono text-[10px] opacity-60">
                      {outcome[0]}
                    </span>
                  </button>
                ))}
                <button
                  onClick={() => updatePending({ softTruncate: !pending.softTruncate })}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all ${
                    pending.softTruncate
                      ? "bg-coral-light text-coral"
                      : "bg-white border border-warm-200 text-ink-muted hover:border-warm-300"
                  }`}
                >
                  soft-truncate
                  <span className="ml-1.5 font-mono text-[10px] opacity-60">x</span>
                </button>
                <div className="flex-1" />
                <button
                  disabled={saving}
                  onClick={() => void skip()}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-warm-200 text-ink-muted hover:border-warm-300 cursor-pointer"
                >
                  {skipArmed ? "skip (discard marks)" : "skip"}
                  <span className="ml-1.5 font-mono text-[10px] opacity-60">n</span>
                </button>
                <button
                  disabled={saving}
                  onClick={() => void confirm()}
                  className={`px-4 py-1.5 rounded-lg text-xs font-medium ${
                    saving
                      ? "bg-warm-100 text-ink-muted/50 cursor-not-allowed"
                      : "bg-teal text-white hover:bg-teal/90 cursor-pointer"
                  }`}
                >
                  confirm
                  <span className="ml-1.5 font-mono text-[10px] opacity-70">c</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <CommitPanel
        repoId={repoId}
        numConfirmed={numConfirmed}
        numSkipped={numSkipped}
        numEpisodes={episodes?.length ?? 0}
      />
    </div>
  );
}
