import type { StageLabelRow, Violation } from "./stageConsistency";
import type { TrajectoryReviewSpec } from "./trajectoryReview";
import { TRAJECTORY_TIME_TOLERANCE_S } from "./trajectoryTime";

/** A human stage review deliberately does not validate or attest model actions,
 * failures, outcomes, or prose. The original prediction contract stays intact. */
export function validateStageOnlyReview(spec: TrajectoryReviewSpec, row: StageLabelRow, duration?: number | null): Violation[] {
  const issues: Violation[] = [];
  const fail = (field: string, message: string) => issues.push({ code: "stage_review", fields: [field], message });
  const stages = spec.task_definition.stages;
  const maximum = stages.find((s) => s.id === row.max_stage_id && s.index === row.max_stage);
  if (!maximum) fail("max_stage", "Choose the furthest stage reached in this episode.");
  const count = row.attempt_count;
  if (!Number.isSafeInteger(count) || Number(count) < 1) fail("attempt_count", "Set a whole-number attempt count of at least 1.");
  if (!Number.isFinite(duration) || Number(duration) <= 0) fail("stage_transitions", "A verified policy duration is required to confirm stages.");
  if (!Array.isArray(row.stage_transitions)) {
    fail("stage_transitions", "The stage timeline is malformed; its original data has been preserved.");
    return issues;
  }
  const last = new Map<number, { time: number; stage: number }>();
  let greatest = 0;
  let previousTime = -Infinity;
  let previousAttempt = 0;
  Array.from(row.stage_transitions).forEach((raw: unknown, index: number) => {
    const field = `stage_transitions.${index}`;
    const name = `Stage mark ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { fail(field, `${name}: invalid record.`); return; }
    const event = raw as StageLabelRow;
    const from = stages.find((s) => s.id === event.from_stage_id && s.index === event.from_stage_index);
    const to = stages.find((s) => s.id === event.to_stage_id && s.index === event.to_stage_index);
    if (!from || !to || to.index <= from.index) fail(field, `${name}: choose a valid forward stage transition.`);
    if (to) greatest = Math.max(greatest, to.index);
    const attempt = event.attempt_index;
    if (!Number.isSafeInteger(attempt) || Number(attempt) < 1 || Number(attempt) > Number(count)) fail(field, `${name}: choose an existing attempt.`);
    const time = event.time_s;
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || (duration != null && time > duration + TRAJECTORY_TIME_TOLERANCE_S)) {
      fail(field, `${name}: set a time inside the policy episode, before reset footage.`);
    } else if (typeof attempt === "number" && to) {
      if (time < previousTime) fail(field, `${name}: marks are out of time order. Use “Order stage marks by time” before confirming.`);
      if (attempt < previousAttempt) fail(field, `${name}: attempt numbers must follow the episode's time order.`);
      previousTime = time;
      previousAttempt = attempt;
      const previous = last.get(attempt);
      if (previous && (time < previous.time || to.index <= previous.stage || (from && from.index < previous.stage))) {
        fail(field, `${name}: stages must advance within an attempt. Check the stage and time, use “Order stage marks by time”, or assign the correct retry.`);
      }
      last.set(attempt, { time, stage: to.index });
    }
  });
  if (maximum && maximum.index !== greatest) fail("max_stage", `The furthest stage must match the highest recorded mark (S${greatest}). Add its missing timestamp or correct the summary.`);
  return issues;
}
