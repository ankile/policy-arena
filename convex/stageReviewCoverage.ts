import { v } from "convex/values";

/** Whole-form attestation, not inferred edit tracking or per-field assessment.
 * Paths are relative to the stored review label; '*' means every array item.
 * A confirmed structured-v1 review covers the structured judgments below,
 * including retained values. Source prose and confidence remain lossless but
 * explicitly outside that attestation. Human notes live at review.notes.
 * stages-v1 attests only stage transitions, maximum stage and attempt count;
 * all other pipeline fields remain outside the human review.
 * stages-outcome-v1 additionally attests task_success and final_state. It does
 * not upgrade old stage-only reviews or attest hidden actions/failure details.
 * stages-outcome-v2 also attests the primary failure_mode, but never its time
 * or secondary failure events. Earlier scopes retain their original meaning.
 * Missing coverage on historical rows means unknown coverage, never all fields.
 */
export const STRUCTURED_REVIEW_FIELDS = [
  "max_stage", "max_stage_id", "failure_mode", "primary_failure_time_s",
  "final_state", "attempt_count", "task_success",
  "stage_transitions.*.from_stage_id", "stage_transitions.*.from_stage_index",
  "stage_transitions.*.to_stage_id", "stage_transitions.*.to_stage_index",
  "stage_transitions.*.attempt_index", "stage_transitions.*.time_s",
  "key_action_observations.*.action_id", "key_action_observations.*.occurred",
  "key_action_observations.*.first_time_s",
  "key_action_observations.*.occurrences.*.attempt_index",
  "key_action_observations.*.occurrences.*.time_s",
  "failure_events.*.failure_mode_id", "failure_events.*.attempt_index",
  "failure_events.*.time_s",
] as const;

export const EXCLUDED_REVIEW_FIELDS = [
  "trajectory_identity", "notes", "confidence", "needs_human_review", "review_reasons",
  "stage_transitions.*.evidence", "stage_transitions.*.confidence",
  "key_action_observations.*.occurrences.*.evidence",
  "key_action_observations.*.occurrences.*.confidence",
  "failure_events.*.evidence", "failure_events.*.confidence",
] as const;

export const STAGE_REVIEW_FIELDS = STRUCTURED_REVIEW_FIELDS.filter((path) =>
  path === "max_stage" || path === "max_stage_id" || path === "attempt_count" || path.startsWith("stage_transitions."));
export const STAGE_OUTCOME_REVIEW_FIELDS = [...STAGE_REVIEW_FIELDS, "task_success", "final_state"] as const;
export const CURRENT_REVIEW_PROTOCOL = "stages-outcome-v2" as const;
export const STAGE_OUTCOME_FAILURE_REVIEW_FIELDS = [...STAGE_OUTCOME_REVIEW_FIELDS, "failure_mode"] as const;
export const SUPPORTED_REVIEW_PROTOCOLS = ["structured-v1", "stages-v1", "stages-outcome-v1", CURRENT_REVIEW_PROTOCOL] as const;
export const reviewProtocolValidator = v.union(v.literal("structured-v1"), v.literal("stages-v1"), v.literal("stages-outcome-v1"), v.literal(CURRENT_REVIEW_PROTOCOL));
export const reviewCoverageValidator = v.object({
  protocol: reviewProtocolValidator,
  reviewed_fields: v.array(v.string()),
  excluded_fields: v.array(v.string()),
});

export function stageReviewCoverage(
  protocol: typeof SUPPORTED_REVIEW_PROTOCOLS[number] | undefined, status: string, trajectory: boolean,
) {
  if (protocol === undefined) return undefined;
  if (!trajectory) throw new Error(`${protocol} review protocol requires a trajectory schema`);
  if (status === "cleared") throw new Error("A cleared review must not carry a review protocol");
  const fields: readonly string[] = protocol === "stages-v1" ? STAGE_REVIEW_FIELDS
    : protocol === "stages-outcome-v1" ? STAGE_OUTCOME_REVIEW_FIELDS
    : protocol === CURRENT_REVIEW_PROTOCOL ? STAGE_OUTCOME_FAILURE_REVIEW_FIELDS : STRUCTURED_REVIEW_FIELDS;
  return {
    protocol,
    reviewed_fields: status === "confirmed" || status === "corrected"
      ? [...fields] : [],
    excluded_fields: [...EXCLUDED_REVIEW_FIELDS, ...STRUCTURED_REVIEW_FIELDS.filter((path) => !fields.includes(path))],
  };
}

/** Compare jointly attested judgments and stage timing, never retained hidden
 * fields. Callers surface unknown historical coverage separately. */
export function reviewedSummariesDisagree(
  left: { label?: Record<string, unknown>; review_coverage?: { reviewed_fields: string[] } },
  right: { label?: Record<string, unknown>; review_coverage?: { reviewed_fields: string[] } },
  timeToleranceS = 0,
) {
  const covered = (field: string) => left.review_coverage?.reviewed_fields.includes(field) && right.review_coverage?.reviewed_fields.includes(field);
  if (["max_stage", "max_stage_id", "final_state", "task_success", "failure_mode", "attempt_count"].some((field) =>
    covered(field) && left.label?.[field] !== right.label?.[field])) return true;
  const fields = STAGE_REVIEW_FIELDS.filter((field) => field.startsWith("stage_transitions.") && covered(field));
  if (!fields.length) return false;
  const leftMarks = left.label?.stage_transitions;
  const rightMarks = right.label?.stage_transitions;
  if (!Array.isArray(leftMarks) || !Array.isArray(rightMarks)) return JSON.stringify(leftMarks) !== JSON.stringify(rightMarks);
  if (leftMarks.length !== rightMarks.length) return true;
  return leftMarks.some((mark, index) => fields.some((field) => {
    const key = field.slice("stage_transitions.*.".length);
    const a = mark?.[key]; const b = rightMarks[index]?.[key];
    return key === "time_s" && typeof a === "number" && typeof b === "number"
      ? Math.abs(a - b) > timeToleranceS + 1e-9 : a !== b;
  }));
}
