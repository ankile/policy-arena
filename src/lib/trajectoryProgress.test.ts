import { expect, test } from "bun:test";
import fixtures from "../../tests/fixtures/trajectory-review-fixtures.json";
import { blankTrajectoryReview, type TrajectoryReviewSpec } from "../../convex/trajectoryReview";
import type { StageLabelRow } from "../../convex/stageConsistency";
import { captureVideoEvent } from "./trajectoryVideoEvents";
import { moveProgressEvent, progressAtTime } from "./trajectoryProgress";

for (const task of fixtures.synthetic.tasks) {
  const spec = task.spec.trajectory as TrajectoryReviewSpec;
  test(`${task.source_name}: cursor-based progress never uses endpoint or future achievements`, () => {
    const empty = blankTrajectoryReview(spec, "test/repo", 0);
    const [zero, , two, three] = spec.task_definition.stages;
    const captured = captureVideoEvent(spec, empty, { kind: "stage", id: two.id, fromStageId: zero.id, time: 4.1234567, attempt: 1 }, 30).row;
    const later = captureVideoEvent(spec, captured, { kind: "stage", id: three.id, fromStageId: two.id, time: 12, attempt: 1, updateMaximum: true }, 30).row;
    const before = JSON.stringify(later);
    expect(progressAtTime(spec, later, 0).current).toBeNull();
    expect(progressAtTime(spec, later, 0).next?.id).toBe(two.id);
    expect(progressAtTime(spec, later, 5).current?.id).toBe(two.id);
    expect(progressAtTime(spec, later, 13).current?.id).toBe(three.id);
    expect(progressAtTime(spec, later, 1).current).toBeNull();
    expect(JSON.stringify(later)).toBe(before);
  });
}
const spec = fixtures.synthetic.tasks.find((task) => task.source_name === "routing_d1_v1")!.spec.trajectory as TrajectoryReviewSpec;
const real = () => structuredClone(fixtures.real_campaign_cases.find((c) => c.name === "real_routing_d1_valid")!.review_label) as StageLabelRow;

test("actions come from local stage links and stop being suggested once recorded in this attempt", () => {
  const row = real();
  expect(progressAtTime(spec, row, 0).actions.map((a) => a.definition.id)).toContain("rope_grasped");
  const afterGrasp = progressAtTime(spec, row, 4);
  expect(afterGrasp.actions.map((a) => a.definition.id)).not.toContain("rope_grasped");
  expect(afterGrasp.actions.map((a) => a.definition.id)).not.toContain("second_clip_contact");
});

test("retry context does not inherit another attempt's achievements or hide its actions", () => {
  const row = { ...real(), attempt_count: 2 };
  const retry = progressAtTime(spec, row, 20, 2);
  expect(retry.current).toBeNull();
  expect(retry.attempt).toBe(2);
  expect(retry.next?.index).toBe(1);
  expect(progressAtTime(spec, row, 20, 1).current).not.toBeNull();
  expect(() => progressAtTime(spec, row, 20, 3)).toThrow("existing attempt");
});

test("retiming is exact, preserves unrelated values, and rejects a stale event reference", () => {
  const row = real();
  const progress = progressAtTime(spec, row, 0);
  const event = progress.nextEvent!;
  const moved = moveProgressEvent(spec, row, event, 2.12345678, 30, []);
  expect((moved.stage_transitions as StageLabelRow[])[0].time_s).toBe(2.12345678);
  expect((moved.key_action_observations as StageLabelRow[])[0].first_time_s).toBe(2.12345678);
  expect(moved.failure_events).toBe(row.failure_events);
  expect(moved.max_stage).toBe(row.max_stage);
  expect(() => moveProgressEvent(spec, moved, event, 2, 30, [])).toThrow("changed");
  expect(() => moveProgressEvent(spec, row, event, 40, 30, [])).toThrow("policy episode");
});

test("conditional stage/action candidates remain independent unless explicitly shared", () => {
  const row = real();
  const event = progressAtTime(spec, row, 4).nextEvent!;
  expect(event.definitionId).toBe("first_clip_reached_off_axis");
  const moved = moveProgressEvent(spec, row, event, 5, 30, []);
  expect(moved.key_action_observations).toBe(row.key_action_observations);
});

test("ambiguous repeated stages are not silently chosen as a single retime target", () => {
  const row = real();
  row.stage_transitions = [...row.stage_transitions as StageLabelRow[], { ...(row.stage_transitions as StageLabelRow[])[0], time_s: 5 }];
  const context = progressAtTime(spec, row, 0);
  expect(context.nextAmbiguous).toBe(true);
  expect(context.nextEvent).toBeNull();
});
