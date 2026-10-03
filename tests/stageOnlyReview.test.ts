import { expect, test } from "bun:test";
import { validateStageOnlyReview } from "../convex/stageOnlyReview";
import { stageReviewCoverage } from "../convex/stageReviewCoverage";
import { eligibleGold } from "../convex/labelingScores";
import { blankTrajectoryReview, type TrajectoryReviewSpec } from "../convex/trajectoryReview";
import { patchStageMark, removeStageMark, stageContext } from "../src/lib/stageTimeline";
import type { Doc } from "../convex/_generated/dataModel";
import fixtures from "./fixtures/trajectory-review-fixtures.json";

for (const task of fixtures.synthetic.tasks) {
  const spec = task.spec.trajectory as TrajectoryReviewSpec;
  test(`${task.source_name}: human stage records validate without any action, outcome or failure judgments`, () => {
    const blank = blankTrajectoryReview(spec, "test/repo", 0);
    const row = patchStageMark(spec, blank, null, spec.task_definition.stages[2].id, 2.1234567, 1);
    expect(validateStageOnlyReview(spec, row, 30)).toEqual([]);
    expect(row.key_action_observations).toEqual(blank.key_action_observations);
    expect(row.task_success).toBeNull();
    expect(stageContext(spec, row, 0).current).toBeNull();
    expect(stageContext(spec, row, 0).next?.index).toBe(1);
    expect(stageContext(spec, row, 3).current?.index).toBe(2);
    const retry = { ...row, attempt_count: 2 };
    expect(stageContext(spec, retry, 3, 2).current).toBeNull();
    expect(stageContext(spec, retry, 3, 2).next?.index).toBe(1);
    expect(validateStageOnlyReview(spec, { ...row, max_stage: 0, max_stage_id: spec.task_definition.stages[0].id }, 30).length).toBeGreaterThan(0);
    expect(validateStageOnlyReview(spec, row, 1).length).toBeGreaterThan(0);
    expect(validateStageOnlyReview(spec, row, undefined).length).toBeGreaterThan(0);
  });
}
test("stage-only validation rejects invalid, reversed, duplicate and out-of-attempt stage marks", () => {
  const spec = fixtures.synthetic.tasks[0].spec.trajectory as TrajectoryReviewSpec;
  const blank = blankTrajectoryReview(spec, "test/repo", 0);
  const first = patchStageMark(spec, blank, null, spec.task_definition.stages[2].id, 4, 1);
  const second = patchStageMark(spec, first, null, spec.task_definition.stages[3].id, 8, 1);
  for (const patch of [{ time_s: -1 }, { time_s: 3 }, { time_s: NaN }, { attempt_index: 2 }, { attempt_index: 1.5 }, { to_stage_index: 999 }, { from_stage_index: 999 }]) {
    const events = structuredClone(second.stage_transitions); Object.assign(events[1], patch);
    expect(validateStageOnlyReview(spec, { ...second, stage_transitions: events }, 30).length).toBeGreaterThan(0);
  }
  expect(validateStageOnlyReview(spec, { ...first, stage_transitions: [first.stage_transitions[0], first.stage_transitions[0]] }, 30).length).toBeGreaterThan(0);
  expect(validateStageOnlyReview(spec, { ...first, stage_transitions: null }, 30).length).toBeGreaterThan(0);
});

test("inserting or removing a stage derives predecessor links from the visible sequence, never from actions", () => {
  const spec = fixtures.synthetic.tasks[0].spec.trajectory as TrajectoryReviewSpec;
  const blank = blankTrajectoryReview(spec, "test/repo", 0);
  const later = patchStageMark(spec, blank, null, spec.task_definition.stages[3].id, 8, 1);
  const inserted = patchStageMark(spec, later, null, spec.task_definition.stages[2].id, 4, 1);
  expect(inserted.stage_transitions[1].from_stage_index).toBe(2);
  expect(inserted.stage_transitions.map((event) => event.time_s)).toEqual([4, 8]);
  expect(inserted.key_action_observations).toEqual(blank.key_action_observations);
  const removed = removeStageMark(spec, inserted, 0);
  expect(removed.stage_transitions[0].from_stage_index).toBe(0);
  expect(validateStageOnlyReview(spec, removed, 30)).toEqual([]);
});

test("full-summary gold scoring excludes stage-only reviews and folds them before old full-label gold", () => {
  const base = { _id: "review-1", _creationTime: 1, saved_at: 1, episode_index: 0n, taxonomy_version: "v1", reviewer: "test", status: "confirmed", prediction_id: "prediction-1", label: {} } as unknown as Doc<"stageReviews">;
  expect(eligibleGold([base], "v1").eligible).toHaveLength(1);
  const stages = { ...base, _creationTime: 2, saved_at: 2, review_coverage: stageReviewCoverage("stages-v1", "confirmed", true) };
  expect(eligibleGold([base, stages], "v1").eligible).toHaveLength(0);
  expect(eligibleGold([stages], "v1").excluded).toEqual([0n]);
});

test("maximum equals recorded progress, including S0 without marks and bounded historical times", () => {
  const spec = fixtures.synthetic.tasks[0].spec.trajectory as TrajectoryReviewSpec;
  const blank = { ...blankTrajectoryReview(spec, "test/repo", 0), max_stage: 0, max_stage_id: spec.task_definition.stages[0].id };
  expect(validateStageOnlyReview(spec, blank, 30)).toEqual([]);
  expect(validateStageOnlyReview(spec, { ...blank, max_stage: 7, max_stage_id: spec.task_definition.stages[7].id }, 30).some((issue) => issue.fields.includes("max_stage"))).toBe(true);
  const row = patchStageMark(spec, blank, null, spec.task_definition.stages[1].id, 30.009, 1);
  expect(validateStageOnlyReview(spec, row, 30)).toEqual([]);
  expect(validateStageOnlyReview(spec, { ...row, stage_transitions: [{ ...row.stage_transitions[0], time_s: 30.011 }] }, 30).length).toBeGreaterThan(0);
});

test("retry marks are globally chronological; edits/removals never rewrite an unrelated retry's predecessor", () => {
  const spec = fixtures.synthetic.tasks[0].spec.trajectory as TrajectoryReviewSpec;
  const first = patchStageMark(spec, { ...blankTrajectoryReview(spec, "test/repo", 0), attempt_count: 2 }, null, spec.task_definition.stages[3].id, 4, 1);
  const second = patchStageMark(spec, first, null, spec.task_definition.stages[4].id, 8, 2);
  second.stage_transitions[1].from_stage_id = spec.task_definition.stages[3].id;
  second.stage_transitions[1].from_stage_index = 3;
  const originalRetry = structuredClone(second.stage_transitions[1]);
  const edited = patchStageMark(spec, second, 0, spec.task_definition.stages[2].id, 3, 1);
  expect(edited.stage_transitions[1]).toEqual(originalRetry);
  expect(removeStageMark(spec, edited, 0).stage_transitions[0]).toEqual(originalRetry);
  expect(validateStageOnlyReview(spec, second, 30)).toEqual([]);
  const reversed = { ...second, stage_transitions: [...second.stage_transitions].reverse() };
  expect(validateStageOnlyReview(spec, reversed, 30).some((issue) => issue.message.includes("Order stage marks by time"))).toBe(true);
  const interleaved = { ...second, stage_transitions: second.stage_transitions.map((mark, i) => ({ ...mark, attempt_index: i === 0 ? 2 : 1 })) };
  expect(validateStageOnlyReview(spec, interleaved, 30).some((issue) => issue.message.includes("attempt numbers"))).toBe(true);
});
