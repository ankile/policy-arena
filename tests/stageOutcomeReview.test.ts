import { expect, test } from "bun:test";
import { validateStageOutcomeReview } from "../convex/stageOutcomeReview";
import { stageReviewCoverage, STAGE_OUTCOME_REVIEW_FIELDS, reviewedSummariesDisagree } from "../convex/stageReviewCoverage";
import { eligibleGold } from "../convex/labelingScores";
import { blankTrajectoryReview, trajectoryFromReview, type TrajectoryReviewSpec } from "../convex/trajectoryReview";
import type { StageLabelRow } from "../convex/stageConsistency";
import type { Doc } from "../convex/_generated/dataModel";
import fixtures from "./fixtures/trajectory-review-fixtures.json";

for (const task of fixtures.synthetic.tasks) {
  const spec = task.spec.trajectory as TrajectoryReviewSpec;
  const success = task.cases.find((item) => item.name === "valid_success")!;
  test(`${task.source_name}: human result review validates only supervised fields and preserves the original schema`, () => {
    const row: StageLabelRow = structuredClone(success.review_label!);
    row.key_action_observations = [{ action_id: "unreviewed-model-action", first_time_s: 999 }];
    row.failure_mode = "unreviewed-model-failure";
    row.failure_events = [{ failure_mode_id: "retained", time_s: 999 }];
    const before = structuredClone(row);
    expect(validateStageOutcomeReview(spec, row, success.duration_s)).toEqual([]);
    expect(row).toEqual(before);
    const canonical = trajectoryFromReview(row);
    expect(canonical.task_success).toBe(true);
    expect(canonical.final_state_id).toBe(row.final_state);
    expect(canonical.key_action_observations).toEqual(row.key_action_observations);
    expect(Object.keys(canonical)).toEqual(Object.keys(trajectoryFromReview(success.review_label!)));
    for (const state of spec.task_definition.successDefinition.successfulFinalStateIds) {
      expect(validateStageOutcomeReview(spec, { ...row, final_state: state }, success.duration_s)).toEqual([]);
    }
    for (const patch of [{ task_success: null }, { task_success: "true" }, { final_state: "" }, { final_state: "undeclared" }, { task_success: false }, { final_state: spec.task_definition.finalStates[0].id }]) {
      expect(validateStageOutcomeReview(spec, { ...row, ...patch }, success.duration_s).length).toBeGreaterThan(0);
    }
    // A later failure does not erase the highest stage achieved earlier.
    expect(validateStageOutcomeReview(spec, { ...row, task_success: false, final_state: spec.task_definition.finalStates[0].id }, success.duration_s)).toEqual([]);
    expect(validateStageOutcomeReview(spec, row, 0).length).toBeGreaterThan(0);
    const blank = blankTrajectoryReview(spec, "test/repo", 0);
    expect(validateStageOutcomeReview(spec, blank, 30).map((issue) => issue.fields[0])).toContain("task_success");
    expect(validateStageOutcomeReview(spec, blank, 30).map((issue) => issue.fields[0])).toContain("final_state");
  });
}

test("new review coverage adds outcome/end state without upgrading old reviews or attesting hidden labels", () => {
  const old = stageReviewCoverage("stages-v1", "confirmed", true)!;
  expect(old.reviewed_fields).not.toContain("task_success");
  expect(old.reviewed_fields).not.toContain("final_state");
  for (const status of ["confirmed", "corrected"]) {
    const coverage = stageReviewCoverage("stages-outcome-v1", status, true)!;
    expect(coverage.reviewed_fields).toEqual([...STAGE_OUTCOME_REVIEW_FIELDS]);
    expect(coverage.excluded_fields).not.toContain("task_success");
    expect(coverage.excluded_fields).not.toContain("final_state");
    expect(coverage.reviewed_fields.some((field) => /action|failure|evidence|confidence|notes/.test(field))).toBe(false);
    expect(coverage.excluded_fields).toContain("failure_mode");
    expect(coverage.excluded_fields).toContain("key_action_observations.*.occurred");
  }
  for (const status of ["draft", "uncertain"]) expect(stageReviewCoverage("stages-outcome-v1", status, true)!.reviewed_fields).toEqual([]);
  const base = { _id: "review-1", _creationTime: 1, saved_at: 1, episode_index: 0n, taxonomy_version: "v1", reviewer: "test", status: "confirmed", prediction_id: "prediction-1", label: {} } as unknown as Doc<"stageReviews">;
  const latest = { ...base, _creationTime: 2, saved_at: 2, review_coverage: stageReviewCoverage("stages-outcome-v1", "confirmed", true) };
  expect(eligibleGold([base, latest], "v1").eligible).toHaveLength(0);
  expect(eligibleGold([latest], "v1").excluded).toEqual([0n]);
});

test("adjudication compares success/end state only when both reviews cover them and ignores hidden failure labels", () => {
  const row = { label: { max_stage: 7, task_success: true, final_state: "seated", failure_mode: "none" },
    review_coverage: stageReviewCoverage("stages-outcome-v1", "confirmed", true) };
  expect(reviewedSummariesDisagree(row, { ...row, label: { ...row.label, failure_mode: "other" } })).toBe(false);
  for (const patch of [{ task_success: false }, { final_state: "on_table" }, { max_stage: 6 }]) {
    expect(reviewedSummariesDisagree(row, { ...row, label: { ...row.label, ...patch } })).toBe(true);
  }
  const old = { label: { ...row.label, task_success: false, final_state: "on_table" },
    review_coverage: stageReviewCoverage("stages-v1", "confirmed", true) };
  expect(reviewedSummariesDisagree(row, old)).toBe(false);
  expect(reviewedSummariesDisagree(row, { ...old, review_coverage: undefined })).toBe(false);
});
