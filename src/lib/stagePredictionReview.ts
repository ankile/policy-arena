import type { Id } from "../../convex/_generated/dataModel";
import type { ExportedStageSpec, StageLabelRow } from "../../convex/stageConsistency";

/** Captured when the form is seeded, never inferred from the current selector. */
export interface PredictionAttribution {
  prediction_id?: Id<"stagePredictions">;
  prediction_sha256?: string;
  legacy_prefill_id?: Id<"stagePrefills">;
  prefill_pushed_at?: number;
  episode_duration_s?: number;
  copied_from_review_id?: Id<"stageReviews">;
}

export interface ReviewSeed {
  label: StageLabelRow;
  attribution: PredictionAttribution;
  inheritedSuccess: boolean;
  fromOwnReview: boolean;
}

export function seedStageReview({
  own,
  prediction,
  outcome,
  spec,
  legacy,
}: {
  own?: { label: StageLabelRow | null; attribution: PredictionAttribution };
  prediction?: { label: StageLabelRow; attribution: PredictionAttribution };
  outcome: string | null;
  spec: ExportedStageSpec;
  legacy: boolean;
}): ReviewSeed {
  const fromOwnReview = own?.label != null;
  const label = { ...(fromOwnReview ? own.label : prediction?.label ?? {}) };
  // Legacy outcome inheritance remains explicit. An immutable prediction is
  // shown exactly as registered, including disagreement with human outcomes.
  const inheritedSuccess = !fromOwnReview && legacy && outcome === "success";
  if (inheritedSuccess) {
    label[spec.stage_field] = spec.ladder.success_level;
    label[spec.final_state_field] = spec.success_final_state;
    label[spec.failure_mode_field] = "none";
  }
  return {
    label,
    attribution: { ...(fromOwnReview ? own.attribution : prediction?.attribution ?? {}) },
    inheritedSuccess,
    fromOwnReview,
  };
}

export function attributionDescription(source: PredictionAttribution): string {
  const copied = source.copied_from_review_id
    ? `Copied from human review ${source.copied_from_review_id}. Original source: ` : "";
  if (source.prediction_id) {
    return `${copied}prediction ${source.prediction_id} · SHA-256 ${source.prediction_sha256}`;
  }
  if (source.legacy_prefill_id) {
    return `${copied}legacy prediction ${source.legacy_prefill_id} · ${new Date(source.prefill_pushed_at!).toISOString()}`;
  }
  if (source.prefill_pushed_at !== undefined) {
    return `${copied}historical prefill timestamp ${new Date(source.prefill_pushed_at).toISOString()}; exact prediction was not recorded`;
  }
  return `${copied}No prediction source recorded`;
}

/** Validate against the query list BEFORE sending an ID to Convex. */
export function resolvePredictionSelection(
  selected: string,
  runs: ReadonlyArray<{ _id: string }>,
): { runId: Id<"stagePredictionRuns"> | null; error: string | null } {
  if (selected === "legacy") return { runId: null, error: null };
  const run = runs.find((candidate) => candidate._id === selected);
  if (!run) {
    return {
      runId: null,
      error: `Prediction version ${selected} is not published for this dataset and taxonomy. Choose a listed version.`,
    };
  }
  return { runId: run._id as Id<"stagePredictionRuns">, error: null };
}

/** Raw invalid label values may contain policy identity; keep blind displays numeric. */
export function stageDisplay(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? `S${value}` : "invalid stage";
}
