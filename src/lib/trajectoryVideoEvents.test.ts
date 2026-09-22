import { describe, expect, test } from "bun:test";
import fixtures from "../../tests/fixtures/trajectory-review-fixtures.json";
import { blankTrajectoryReview, trajectoryFromReview, type TrajectoryReviewSpec } from "../../convex/trajectoryReview";
import { captureVideoEvent, projectVideoEvents } from "./trajectoryVideoEvents";
import type { StageLabelRow } from "../../convex/stageConsistency";

describe("video event projection and capture", () => {
  for (const source of fixtures.real_campaign_cases.filter((item) => item.name.endsWith("_valid"))) {
    const task = fixtures.synthetic.tasks.find((item) => item.source_name === source.source_name)!;
    const spec = task.spec.trajectory as TrajectoryReviewSpec;
    test(`${source.source_name}: every occurrence is visible and viewing preserves canonical output`, () => {
      const row = structuredClone(source.review_label) as StageLabelRow;
      const before = JSON.stringify(row);
      const canonical = trajectoryFromReview(row);
      const events = projectVideoEvents(spec, row);
      const actions = row.key_action_observations as Array<{ occurrences: unknown[] }>;
      expect(events.length).toBe((row.stage_transitions as unknown[]).length + (row.failure_events as unknown[]).length + actions.reduce((n, a) => n + a.occurrences.length, 0));
      expect(new Set(events.map((e) => e.key)).size).toBe(events.length);
      expect(JSON.stringify(row)).toBe(before);
      expect(trajectoryFromReview(row)).toEqual(canonical);
    });
    test(`${source.source_name}: stage capture never creates a corresponding action`, () => {
      const row = blankTrajectoryReview(spec, "test/repo", 0);
      const stage = spec.task_definition.stages[2];
      const result = captureVideoEvent(spec, row, { kind: "stage", id: stage.id, fromStageId: spec.task_definition.stages[0].id, time: 1.234567, attempt: 1 }, 10);
      expect(result.row.key_action_observations).toBe(row.key_action_observations);
      expect(result.row.max_stage).toBeNull();
      expect(result.row.stage_transitions).toEqual([{ time_s: 1.234567, attempt_index: 1, confidence: "medium", evidence: "", from_stage_id: spec.task_definition.stages[0].id, from_stage_index: 0, to_stage_id: stage.id, to_stage_index: stage.index }]);
      const explicit = captureVideoEvent(spec, row, { kind: "stage", id: stage.id, fromStageId: spec.task_definition.stages[0].id, time: 1, attempt: 1, updateMaximum: true }, 10);
      expect(explicit.row.max_stage_id).toBe(stage.id);
      expect(row.stage_transitions).toEqual([]);
    });
  }
  const spec = fixtures.synthetic.tasks.find((item) => item.source_name === "routing_d1_v1")!.spec.trajectory as TrajectoryReviewSpec;
  test("repeated actions preserve occurrences and derive the actual first time", () => {
    const row = blankTrajectoryReview(spec, "test/repo", 0);
    row.attempt_count = 2;
    const id = spec.task_definition.keyActions[0].id;
    const first = captureVideoEvent(spec, row, { kind: "action", id, time: 5.555555, attempt: 2 }, 10);
    const next = captureVideoEvent(spec, first.row, { kind: "action", id, time: 2.25, attempt: 1 }, 10);
    const actions = next.row.key_action_observations as StageLabelRow[];
    expect(actions[0].first_time_s).toBe(2.25);
    expect(actions[0].occurred).toBe(true);
    expect((actions[0].occurrences as StageLabelRow[]).map((e) => e.time_s)).toEqual([5.555555, 2.25]);
    expect(next.row.stage_transitions).toEqual([]);
    expect(next.key).toBe("action:0:1");
  });
  test("primary failure only changes when explicitly requested", () => {
    const row = blankTrajectoryReview(spec, "test/repo", 0);
    const id = spec.task_definition.failureModes.find((f) => f.id !== "none")!.id;
    const first = captureVideoEvent(spec, row, { kind: "failure", id, time: 3, attempt: 1 }, 10);
    expect(first.row.failure_mode).toBe("");
    const explicit = captureVideoEvent(spec, row, { kind: "failure", id, time: 3, attempt: 1, primaryFailure: true }, 10);
    expect(explicit.row.failure_mode).toBe(id);
    expect(explicit.row.primary_failure_time_s).toBe(3);
    expect(explicit.row.task_success).toBeNull();
  });
  test("invalid captures and malformed arrays fail without losing source data", () => {
    const row = blankTrajectoryReview(spec, "test/repo", 0);
    const capture = { kind: "action" as const, id: spec.task_definition.keyActions[0].id, time: 11, attempt: 1 };
    expect(() => captureVideoEvent(spec, row, capture, 10)).toThrow("reset footage");
    expect(() => captureVideoEvent(spec, row, { ...capture, time: 2, attempt: 2 }, 10)).toThrow("attempt");
    expect(() => captureVideoEvent(spec, { ...row, attempt_count: null }, { ...capture, time: 2 }, 10)).toThrow("attempt");
    expect(() => captureVideoEvent(spec, { ...row, key_action_observations: null }, { ...capture, time: 2 }, 10)).toThrow("invalid structure");
    expect(() => projectVideoEvents(spec, { ...row, stage_transitions: new Array(1) })).toThrow();
    expect(row.stage_transitions).toEqual([]);
  });
});
