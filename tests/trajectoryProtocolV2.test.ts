import { describe, expect, test } from "bun:test";
import { stageReviewRelease } from "../shared/stageReviewRelease";
import { normalizeStageSpec } from "../src/lib/stage-spec";
import { patchStageMark } from "../src/lib/stageTimeline";
import { blankTrajectoryReview, canonicalizeTrajectoryReview, trajectoryFromReview, trajectoryShapeViolations, trajectoryTaskDefinitionDigest } from "../convex/trajectoryReview";
import { parseCanonicalTrajectoryLabel, validateTrajectoryLabel } from "../convex/trajectoryContract";
import { prepareStageOutcomeLabel, validateStageOutcomeReview } from "../convex/stageOutcomeReview";
import { CURRENT_REVIEW_FIELDS, CURRENT_REVIEW_PROTOCOL, stageReviewCoverage } from "../convex/stageReviewCoverage";
import { eligibleGold, scoreSummaries } from "../convex/labelingScores";
import { canonicalDigest } from "../convex/stagePredictionContract";
import type { Doc } from "../convex/_generated/dataModel";

for (const [taskId, exported] of Object.entries(stageReviewRelease)) describe(`${taskId} no-end-state protocol`, () => {
  const spec = normalizeStageSpec(exported).trajectory!;
  const task = spec.task_definition;
  function humanSuccess() {
    let row = blankTrajectoryReview(spec, "org/data", 0);
    const finalIndex = taskId === "routing_d1" ? 9 : 6;
    for (const stage of task.stages.slice(1, finalIndex + 1)) row = patchStageMark(spec, row, null, stage.id, stage.index, 1);
    return prepareStageOutcomeLabel(spec, { ...row, task_success: true });
  }
  function machineSuccess() {
    const row = humanSuccess();
    const reached = new Set(task.stages.filter((stage) => stage.index <= Number(row.max_stage)).map((stage) => stage.id));
    const required = new Set(task.successDefinition.requiredKeyActionIds);
    for (const action of task.keyActions) if (action.stageLinks.some((link) => link.relation === "required_for_entry" && reached.has(link.stageId))) required.add(action.id);
    return { ...trajectoryFromReview(row), key_action_observations: task.keyActions.map((action) => ({
      action_id: action.id, occurred: required.has(action.id), first_time_s: required.has(action.id) ? 10 : null,
      occurrences: required.has(action.id) ? [{ attempt_index: 1, time_s: 10, confidence: "high", evidence: "Visible controlled placement" }] : [],
    })) };
  }
  test("the exported definition, response and pins contain no end-state contract", async () => {
    expect(task.definitionSchemaVersion).toBe("trajectory-task/v2");
    expect(task).not.toHaveProperty("finalStates");
    expect(task.successDefinition).not.toHaveProperty("successfulFinalStateIds");
    expect(exported).not.toHaveProperty("final_states");
    expect(exported.editable_fields).not.toContain("final_state");
    expect(spec.response_schema).toMatchObject({ properties: { schema_version: { enum: ["trajectory-label/v2"] } } });
    expect((spec.response_schema.properties as object)).not.toHaveProperty("final_state_id");
    expect(await trajectoryTaskDefinitionDigest(task)).toBe(spec.task_definition_sha256);
    const { taxonomy_hash, ...content } = exported;
    expect(await canonicalDigest(content)).toBe(taxonomy_hash);
  });
  test("held full placement succeeds; optional release and hidden actions are not human attested", () => {
    const row = humanSuccess();
    expect(row).not.toHaveProperty("final_state");
    expect(validateStageOutcomeReview(spec, row, 30)).toEqual([]);
    const coverage = stageReviewCoverage(CURRENT_REVIEW_PROTOCOL, "confirmed", true)!;
    expect(coverage.reviewed_fields).toEqual([...CURRENT_REVIEW_FIELDS]);
    expect(coverage.reviewed_fields).not.toContain("final_state");
    expect(coverage.reviewed_fields.some((field) => field.startsWith("key_action"))).toBe(false);
    const canonical = machineSuccess();
    expect(parseCanonicalTrajectoryLabel(canonical)).toEqual(canonical);
    expect(validateTrajectoryLabel(canonical, task)).toEqual([]);
    expect(trajectoryShapeViolations(spec, canonical)).toEqual([]);
    expect(parseCanonicalTrajectoryLabel({ ...canonical, final_state_id: "unclear" })).toBeNull();
    expect(canonicalizeTrajectoryReview({ ...row, final_state: "unclear" }).unknownKeys).toEqual(["final_state"]);
  });
  test("later loss preserves historical progress, and all human failure choices save without an endpoint", () => {
    const row = humanSuccess();
    for (const mode of task.failureModes.filter((mode) => mode.id !== "none")) {
      expect(validateStageOutcomeReview(spec, { ...row, task_success: false, failure_mode: mode.id }, 30)).toEqual([]);
    }
    expect(validateStageOutcomeReview(spec, { ...row, task_success: false }, 30).length).toBeGreaterThan(0);
    expect(validateStageOutcomeReview(spec, { ...row, final_state: "unclear" }, 30).length).toBeGreaterThan(0);
    const canonical = machineSuccess();
    const mode = taskId === "routing_d1" ? "first_clip_retention_lost" : "placement_lost";
    const failed = { ...canonical, task_success: false, primary_failure: { failure_mode_id: mode, time_s: 11 },
      failure_events: [{ attempt_index: 1, time_s: 11, confidence: "high", evidence: "Placement lost", failure_mode_id: mode }] };
    expect(validateTrajectoryLabel(failed, task)).toEqual([]);
  });
  test("the v2 scorer evaluates only attested summaries and rejects mixed protocol pairs", () => {
    const gold = parseCanonicalTrajectoryLabel(machineSuccess())!;
    const metrics = scoreSummaries([{ gold, prediction: gold }]);
    expect(metrics).toMatchObject({ protocol: "trajectory-summary-agreement/v2", stage_exact: 1, failure_exact: 1 });
    expect(metrics).not.toHaveProperty("final_exact");
    expect(() => scoreSummaries([{ gold, prediction: { ...gold, schema_version: "trajectory-label/v1", final_state_id: "old" } }])).toThrow("mix label protocols");
    const review = { _id: "review", _creationTime: 1, saved_at: 1, episode_index: 0n, taxonomy_version: exported.taxonomy_version,
      reviewer: "test", status: "confirmed", prediction_id: "prediction", label: humanSuccess(),
      review_coverage: stageReviewCoverage(CURRENT_REVIEW_PROTOCOL, "confirmed", true) } as unknown as Doc<"stageReviews">;
    expect(eligibleGold([review], exported.taxonomy_version).eligible).toHaveLength(1);
    expect(eligibleGold([{ ...review, review_coverage: stageReviewCoverage("stages-v1", "confirmed", true) }], exported.taxonomy_version).eligible).toHaveLength(0);
  });
});
