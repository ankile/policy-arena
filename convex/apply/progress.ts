/**
 * Progress-record and review-overlay semantics.
 *
 * Port of sir/tools/outcome_editor.py record primitives + the arena worker's
 * build_overlay. The `.outcome_edit_progress.json` record shape is the shared
 * contract with every historical apply:
 *   {"changed_episodes": {"<idx>": {new_outcome, outcome_frame, soft_truncate,
 *     subtask_frames?}}, "skipped_episodes": [idx, ...]}
 * subtask_frames key PRESENCE marks a record reviewed in subtask mode (may be
 * an empty list); records from 0-mark sessions never carry the key.
 */

import { dumpsIndent2, loadsPy } from "./pyjson";
import type { Json } from "./pyjson";

export const PROGRESS_FILENAME = ".outcome_edit_progress.json";
export const OUTCOME_NAMES = ["success", "failure", "timeout"] as const;
export type OutcomeName = (typeof OUTCOME_NAMES)[number];

export interface ChangedRecord {
  new_outcome: OutcomeName;
  outcome_frame: number;
  soft_truncate: boolean;
  subtask_frames?: number[];
}

/**
 * changed_episodes is a Map: the file is written without sort_keys, so its key
 * order is Python dict insertion order (a re-review keeps its slot, a review
 * after a skip appends). A plain object would enumerate the integer-like keys
 * ascending and rewrite the file on every apply.
 */
export interface ProgressRecord {
  changed_episodes: Map<string, ChangedRecord>;
  skipped_episodes: number[];
  /** Any other top-level keys of the loaded file, in file order (load_progress
   * keeps them and save_progress writes them back). */
  extra?: Map<string, Json>;
  /** Top-level key order of the loaded file. */
  keyOrder?: string[];
}

export interface Overlay {
  changed_episodes: Record<string, ChangedRecord>;
  skipped_episodes: number[];
}

/** One folded (latest-per-episode, cleared-removed) Convex outcome review row. */
export interface ReviewRow {
  episode_index: number | bigint;
  status: string;
  new_outcome?: string;
  outcome_frame?: number | bigint;
  soft_truncate?: boolean;
  subtask_frames?: Array<number | bigint>;
  reviewer: string;
  source_tool?: string;
}

export function asInt(value: number | bigint): number {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
      throw new Error(`int64 value ${value} exceeds safe integer range`);
    }
    return Number(value);
  }
  if (!Number.isInteger(value)) throw new Error(`Expected integer, got ${value}`);
  return value;
}

function asOutcome(value: string | undefined): OutcomeName {
  if (value === undefined || !(OUTCOME_NAMES as readonly string[]).includes(value)) {
    throw new Error(`Unknown outcome ${JSON.stringify(value)}`);
  }
  return value as OutcomeName;
}

/**
 * Convert latest-per-episode Convex reviews into a progress-record overlay.
 * Mirrors arena_review_worker.build_overlay exactly: confirmed →
 * changed_episodes entry (subtask_frames key present ⇔ the review carried
 * one, even empty); skipped → skipped_episodes.
 */
export function buildOverlay(rows: ReviewRow[]): Overlay {
  const changed: Record<string, ChangedRecord> = {};
  const skipped: number[] = [];
  for (const row of rows) {
    const epIdx = asInt(row.episode_index);
    if (row.status === "confirmed") {
      if (row.outcome_frame === undefined) {
        throw new Error(`Episode ${epIdx}: confirmed review missing outcome_frame`);
      }
      const record: ChangedRecord = {
        new_outcome: asOutcome(row.new_outcome),
        outcome_frame: asInt(row.outcome_frame),
        soft_truncate: Boolean(row.soft_truncate ?? false),
      };
      if (row.subtask_frames !== undefined && row.subtask_frames !== null) {
        // Deduplicated + sorted to match mark_episode_changed record semantics.
        record.subtask_frames = [...new Set(row.subtask_frames.map(asInt))].sort((a, b) => a - b);
      }
      changed[String(epIdx)] = record;
    } else if (row.status === "skipped") {
      skipped.push(epIdx);
    } else {
      throw new Error(`Unexpected review status for episode ${epIdx}: ${row.status}`);
    }
  }
  return { changed_episodes: changed, skipped_episodes: skipped };
}

/**
 * Review rows whose stored outcome_frame differs from the frame the apply
 * committed (normalization snaps a terminal-padding mark to the last valid
 * frame). The apply worker writes these back so the Arena fold keeps
 * matching the HF progress record.
 */
export function outcomeFrameWritebacks<Id>(
  rows: Array<{ _id: Id; episode_index: number | bigint; status: string; outcome_frame?: number | bigint }>,
  appliedFrames: Array<{ episode_index: number; outcome_frame: number }>
): Array<{ review_id: Id; episode_index: number; outcome_frame: number }> {
  const applied = new Map(appliedFrames.map((e) => [e.episode_index, e.outcome_frame]));
  const out: Array<{ review_id: Id; episode_index: number; outcome_frame: number }> = [];
  for (const row of rows) {
    if (row.status !== "confirmed") continue;
    const epIdx = asInt(row.episode_index);
    const frame = applied.get(epIdx);
    if (frame === undefined) throw new Error(`Episode ${epIdx}: confirmed review was not applied`);
    if (row.outcome_frame === undefined) {
      throw new Error(`Episode ${epIdx}: confirmed review missing outcome_frame`);
    }
    if (frame !== asInt(row.outcome_frame)) {
      out.push({ review_id: row._id, episode_index: epIdx, outcome_frame: frame });
    }
  }
  return out;
}

/** load_progress (without the legacy reward-file migration: those datasets
 * were all migrated cv2-era; a legacy file alongside a missing progress file
 * would need the deprecated Python editor — fail loud instead). */
export function loadProgress(text: string | null): ProgressRecord {
  if (text === null) return { changed_episodes: new Map(), skipped_episodes: [] };
  const parsed = loadsPy(text, { dictsAsMaps: true });
  if (!(parsed instanceof Map)) throw new Error(`${PROGRESS_FILENAME}: top level is not an object`);
  const changed = parsed.get("changed_episodes") ?? new Map<string, Json>();
  if (!(changed instanceof Map)) throw new Error(`${PROGRESS_FILENAME}: changed_episodes is not an object`);
  const skipped = parsed.get("skipped_episodes") ?? [];
  if (!Array.isArray(skipped)) throw new Error(`${PROGRESS_FILENAME}: skipped_episodes is not a list`);
  return {
    // Entry records keep their own key order (non-integer keys: a plain object
    // preserves it).
    changed_episodes: new Map(
      [...changed.entries()].map(([ep, rec]) => {
        if (!(rec instanceof Map)) throw new Error(`${PROGRESS_FILENAME}: episode ${ep} record is not an object`);
        return [ep, Object.fromEntries(rec) as unknown as ChangedRecord];
      })
    ),
    skipped_episodes: skipped as number[],
    extra: new Map([...parsed.entries()].filter(([k]) => k !== "changed_episodes" && k !== "skipped_episodes")),
    keyOrder: [...parsed.keys()],
  };
}

/** Progress record from a plain changed_episodes object (tests, fixtures). */
export function progressRecord(
  changed: Record<string, ChangedRecord>,
  skipped: number[] = []
): ProgressRecord {
  return { changed_episodes: new Map(Object.entries(changed)), skipped_episodes: skipped };
}

/** save_progress: json.dump(indent=2) of the loaded dict — file key order, with
 * load_progress's setdefault keys appended when the file lacked them. */
export function serializeProgress(progress: ProgressRecord): string {
  const values = new Map<string, Json>(progress.extra ?? []);
  values.set("changed_episodes", progress.changed_episodes as unknown as Map<string, Json>);
  values.set("skipped_episodes", progress.skipped_episodes);
  const order = [...(progress.keyOrder ?? [])];
  for (const key of ["changed_episodes", "skipped_episodes"]) if (!order.includes(key)) order.push(key);
  return dumpsIndent2(new Map(order.map((k) => [k, values.get(k)!])));
}

function removeSkipped(progress: ProgressRecord, epIdx: number): void {
  progress.skipped_episodes = progress.skipped_episodes.filter((s) => asInt(s) !== epIdx);
}

/** mark_episode_changed: persists subtask_frames key ⇔ reviewed-or-nonempty. */
export function markEpisodeChanged(
  progress: ProgressRecord,
  epIdx: number,
  record: {
    new_outcome: OutcomeName;
    outcome_frame: number;
    soft_truncate: boolean;
    subtask_frames: number[];
    subtask_reviewed: boolean;
  }
): void {
  removeSkipped(progress, epIdx);
  const entry: ChangedRecord = {
    new_outcome: record.new_outcome,
    outcome_frame: record.outcome_frame,
    soft_truncate: record.soft_truncate,
  };
  if (record.subtask_reviewed || record.subtask_frames.length > 0) {
    entry.subtask_frames = [...new Set(record.subtask_frames)].sort((a, b) => a - b);
  }
  // Map.set keeps an existing key's slot — Python dict assignment semantics.
  progress.changed_episodes.set(String(epIdx), entry);
}

export function markEpisodeSkipped(progress: ProgressRecord, epIdx: number): void {
  progress.changed_episodes.delete(String(epIdx));
  removeSkipped(progress, epIdx);
  progress.skipped_episodes.push(epIdx);
}

/** merge_overlay_into_progress: same primitives as the interactive editor. */
export function mergeOverlayIntoProgress(progress: ProgressRecord, overlay: Overlay): ProgressRecord {
  for (const [epStr, record] of Object.entries(overlay.changed_episodes)) {
    markEpisodeChanged(progress, parseInt(epStr, 10), {
      new_outcome: record.new_outcome,
      outcome_frame: record.outcome_frame,
      soft_truncate: record.soft_truncate ?? false,
      subtask_frames: record.subtask_frames ?? [],
      subtask_reviewed: "subtask_frames" in record,
    });
  }
  for (const epIdx of overlay.skipped_episodes) {
    markEpisodeSkipped(progress, asInt(epIdx));
  }
  return progress;
}

/** subtask_mark_count_error — shared success/prefix legality contract. */
export function subtaskMarkCountError(
  newOutcome: OutcomeName,
  nMarks: number,
  subtaskMarks: number
): string | null {
  if (subtaskMarks <= 0) return null;
  if (newOutcome === "success") {
    if (nMarks !== subtaskMarks) {
      return (
        `a SUCCESS episode must carry exactly ${subtaskMarks} subtask mark(s) ` +
        `(the mid-episode sub-goal(s); the final sub-goal is the terminal success), ` +
        `got ${nMarks}`
      );
    }
  } else if (nMarks > subtaskMarks) {
    return (
      `a ${newOutcome.toUpperCase()} episode may carry at most ${subtaskMarks} subtask ` +
      `mark(s), got ${nMarks}`
    );
  }
  return null;
}

/**
 * resolve_subtask_marks against the Convex taskSpecs export (RealTaskSpec is
 * the Python single source of truth; taskSpecs rows mirror task_name +
 * num_subtask_marks). No registered task → 0 (legacy single-terminal-mark);
 * registered tasks disagreeing → loud failure.
 */
export function resolveSubtaskMarks(
  datasetTasks: string[],
  taskSpecs: Array<{ task_name: string; num_subtask_marks: number | bigint }>
): number {
  const byTaskName = new Map(taskSpecs.map((s) => [s.task_name, asInt(s.num_subtask_marks)]));
  const counts = new Set<number>();
  for (const name of datasetTasks) {
    const marks = byTaskName.get(name);
    if (marks !== undefined) counts.add(marks);
  }
  if (counts.size === 0) return 0;
  if (counts.size > 1) {
    throw new Error(
      `dataset mixes tasks with differing num_subtask_marks ${[...counts].sort()} ` +
        `across tasks ${[...datasetTasks].sort()}`
    );
  }
  return [...counts][0];
}
