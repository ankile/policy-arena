import type { StageLabelRow, Violation } from "./stageConsistency";
import type { TrajectoryReviewSpec } from "./trajectoryReview";
import { validateStageOnlyReview } from "./stageOnlyReview";

/** Validate only the human-supervised projection. Never repair hidden actions,
 * failure times or secondary events; the model contract stays intact. */
export function validateStageOutcomeReview(spec: TrajectoryReviewSpec, row: StageLabelRow, duration?: number | null, reviewFailureMode = true): Violation[] {
  const issues = validateStageOnlyReview(spec, row, duration);
  const fail = (field: string, message: string) => issues.push({ code: "stage_review", fields: [field], message });
  const task = spec.task_definition;
  const state = task.finalStates.find((item) => item.id === row.final_state);
  if (typeof row.task_success !== "boolean") fail("task_success", "Choose Success or Failure, or save as uncertain if you cannot decide.");
  if (!state) fail("final_state", "Choose how the episode ended from this task's end states.");
  if (reviewFailureMode) {
    const mode = task.failureModes.find((item) => item.id === row.failure_mode);
    const noFailure = task.successDefinition.noFailureModeId;
    if (row.task_success === false && (!mode || mode.id === noFailure)) fail("failure_mode", "Choose the primary reason the episode failed.");
    if (row.task_success === true && row.failure_mode !== noFailure) fail("failure_mode", "A successful episode must use the task's no-failure mode.");
  }
  const maximum = task.stages.find((item) => item.id === row.max_stage_id && item.index === row.max_stage);
  if (maximum && state && typeof row.task_success === "boolean") {
    const successfulStage = task.successDefinition.successfulStageIds.includes(maximum.id);
    const successfulEnd = task.successDefinition.successfulFinalStateIds.includes(state.id);
    if ((row.task_success || successfulEnd) && !successfulStage) fail("max_stage", "A successful result or end state requires a completed-task stage. Check the furthest stage reached.");
    if (row.task_success && !successfulEnd) fail("final_state", "This end state does not meet the task's success definition. Check the result and end state, or save as uncertain.");
    if (!row.task_success && successfulEnd) fail("task_success", "This end state indicates success. Check the result and end state, or save as uncertain.");
  }
  return issues;
}

/** A human's explicit result determines only the primary mode, not its time or
 * the retained failure-event ledger. Uncertain outcomes remain undecided. */
export function prepareStageOutcomeLabel(spec: TrajectoryReviewSpec, row: StageLabelRow): StageLabelRow {
  return { ...row, failure_mode: row.task_success === true ? spec.task_definition.successDefinition.noFailureModeId
    : typeof row.task_success !== "boolean" ? "" : row.failure_mode };
}
