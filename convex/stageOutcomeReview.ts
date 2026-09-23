import type { StageLabelRow, Violation } from "./stageConsistency";
import type { TrajectoryReviewSpec } from "./trajectoryReview";
import { validateStageOnlyReview } from "./stageOnlyReview";

/** Validate only the human-supervised projection. Never repair or derive hidden
 * action/failure fields from a human outcome; the model contract stays intact. */
export function validateStageOutcomeReview(spec: TrajectoryReviewSpec, row: StageLabelRow, duration?: number | null): Violation[] {
  const issues = validateStageOnlyReview(spec, row, duration);
  const fail = (field: string, message: string) => issues.push({ code: "stage_review", fields: [field], message });
  const task = spec.task_definition;
  const state = task.finalStates.find((item) => item.id === row.final_state);
  if (typeof row.task_success !== "boolean") fail("task_success", "Choose Success or Failure, or save as uncertain if you cannot decide.");
  if (!state) fail("final_state", "Choose how the episode ended from this task's end states.");
  const maximum = task.stages.find((item) => item.id === row.max_stage_id && item.index === row.max_stage);
  if (maximum && state && typeof row.task_success === "boolean") {
    const successfulStage = task.successDefinition.successfulStageIds.includes(maximum.id);
    const successfulEnd = task.successDefinition.successfulFinalStateIds.includes(state.id);
    if (row.task_success && !successfulStage) fail("max_stage", "Success requires a completed-task stage. Check the furthest stage reached.");
    if (row.task_success && !successfulEnd) fail("final_state", "This end state does not meet the task's success definition. Check the result and end state, or save as uncertain.");
    if (!row.task_success && successfulStage && successfulEnd) fail("task_success", "The completed stage and end state both indicate success. Check the result, or save as uncertain.");
  }
  return issues;
}
