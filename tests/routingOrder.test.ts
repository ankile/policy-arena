import { expect, test } from "bun:test";
import { stageReviewRelease } from "../shared/stageReviewRelease";
import { normalizeStageSpec } from "../src/lib/stage-spec";
import { blankTrajectoryReview, trajectoryFromReview } from "../convex/trajectoryReview";
import { validateTrajectoryTaskDefinition, validateTrajectoryLabel } from "../convex/trajectoryContract";
import { patchStageMark } from "../src/lib/stageTimeline";

const schema = normalizeStageSpec(stageReviewRelease.routing_d1).trajectory!;
const task = schema.task_definition;
const event = (mode = "wrong_clip_order", time = 4, attempt = 1) => ({
  failure_mode_id: mode, time_s: time, attempt_index: attempt, confidence: "high", evidence: "Visible insertion at RIGHT before LEFT seating",
});
function label(leftTime = 4, rightTime = 8) {
  let row = blankTrajectoryReview(schema, "test/routing", 0);
  for (const stage of task.stages.slice(1, 10)) row = patchStageMark(schema, row, null, stage.id, stage.index, 1);
  const canonical = trajectoryFromReview({ ...row, task_success: true, failure_mode: "none" });
  return { ...canonical, task_success: true, primary_failure: { failure_mode_id: "none", time_s: null as number | null },
    failure_events: [] as ReturnType<typeof event>[],
    key_action_observations: task.keyActions.map((a) => {
      const occurred = a.id !== "terminal_rope_release";
      const time = a.id === "first_clip_seated" ? leftTime : a.id === "second_clip_insertion_attempt" ? rightTime : 10;
      return { action_id: a.id, occurred, first_time_s: occurred ? time : null,
        occurrences: occurred ? [{ attempt_index: 1, time_s: time, confidence: "high", evidence: "Observed action" }] : [] };
    }),
  };
}

test("routing order corrects the current protocol in place, with no end-state field", () => {
  expect(task.taxonomyVersion).toBe("routing_d1/v7");
  expect(task.definitionSchemaVersion).toBe("trajectory-task/v2");
  expect(validateTrajectoryTaskDefinition(task)).toEqual([]);
  expect(task.stages[3].name).toContain("left");
  expect(task.stages[8].name).toContain("right");
  expect(task).not.toHaveProperty("finalStates");
  expect(validateTrajectoryLabel(label(), task)).toEqual([]);
});

test("reverse observed chronology cannot silently succeed even with both clips seated", () => {
  const row = label(6, 4);
  expect(validateTrajectoryLabel(row, task).join()).toContain("precedes");
  row.task_success = false;
  row.failure_events = [event()];
  row.primary_failure = { failure_mode_id: "wrong_clip_order", time_s: 4 };
  expect(validateTrajectoryLabel(row, task)).toEqual([]);
  row.failure_events = [event("wrong_clip_order", 5)];
  expect(validateTrajectoryLabel(row, task).join()).toContain("precedes");
});

test("a terminal event overrides recoverable failures and cannot be recovered in another attempt", () => {
  const row = { ...label(6, 4), attempt_count: 2, task_success: false,
    failure_events: [event("first_clip_grasp_lost", 2), event(), event("wrong_clip_order", 12, 2)],
    primary_failure: { failure_mode_id: "wrong_clip_order", time_s: 4 } };
  expect(validateTrajectoryLabel(row, task)).toEqual([]);
  for (const primary_failure of [{ failure_mode_id: "first_clip_grasp_lost", time_s: 2 }, { failure_mode_id: "wrong_clip_order", time_s: 12 }]) {
    expect(validateTrajectoryLabel({ ...row, primary_failure }, task).join()).toContain("first terminal failure");
  }
  for (const needs_human_review of [false, true]) expect(validateTrajectoryLabel({ ...row, task_success: true, needs_human_review,
    review_reasons: needs_human_review ? ["Human success conflicts with visible wrong order"] : [],
    primary_failure: { failure_mode_id: "none", time_s: null } }, task).join()).toContain("terminal failure cannot");
});

test("mere contact or occluded left seating is not automatic proof of wrong order", () => {
  const row = label();
  const contact = row.key_action_observations.find((a) => a.action_id === "second_clip_contact")!;
  contact.first_time_s = contact.occurrences[0].time_s = 2;
  expect(validateTrajectoryLabel(row, task)).toEqual([]);
  const left = row.key_action_observations.find((a) => a.action_id === "first_clip_seated")!;
  Object.assign(left, { occurred: false, first_time_s: null, occurrences: [] });
  expect(validateTrajectoryLabel({ ...row, needs_human_review: true, review_reasons: ["Left seating occluded; human success anchor"] }, task)).toEqual([]);
});

test("malformed action-order metadata fails closed", () => {
  for (const order of [false, {}, { prerequisiteActionId: [], laterActionIds: [] }, { prerequisiteActionId: "first_clip_seated", laterActionIds: [[]] },
    { prerequisiteActionId: "first_clip_seated", laterActionIds: ["first_clip_seated"] }]) {
    const changed = structuredClone(task);
    Object.assign(changed.failureModes.find((m) => m.id === "wrong_clip_order")!, { actionOrder: order });
    expect(validateTrajectoryTaskDefinition(changed).join()).toContain("actionOrder");
  }
});
