import { describe, expect, test } from "bun:test";
import type { Doc } from "../convex/_generated/dataModel";
import { canonicalDigest } from "../convex/stagePredictionContract";
import { blankTrajectoryReview, trajectoryTaskDefinitionDigest } from "../convex/trajectoryReview";
import { prepareStageOutcomeLabel, validateStageOutcomeReview } from "../convex/stageOutcomeReview";
import { normalizeStageSpec } from "../src/lib/stage-spec";
import { patchStageMark } from "../src/lib/stageTimeline";
import { latestStagePreviews, stagePreviewHref, withLocalStagePreviews } from "./localStagePreviews";

for (const task of ["marker_d2", "square_d2"] as const) describe(`${task} positive milestones`, () => {
  const spec = latestStagePreviews[task];
  const schema = normalizeStageSpec(spec).trajectory!;
  test("six stages, original output format, and matching immutable hashes", async () => {
    expect(schema.task_definition.stages.map((stage) => stage.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(schema.task_definition.stages.slice(1).every((stage) => !/never|without|fails?\b/i.test(stage.description))).toBe(true);
    expect(await trajectoryTaskDefinitionDigest(schema.task_definition)).toBe(spec.trajectory.task_definition_sha256);
    const { taxonomy_hash, ...content } = spec;
    expect(await canonicalDigest(content)).toBe(taxonomy_hash);
    expect(spec.trajectory.response_schema.properties.schema_version.enum).toEqual(["trajectory-label/v1"]);
    expect(spec.ladder.success_level).toBe(6);
  });
  test("candidate is scoped to its task and never replaces the live spec or remaps predictions", () => {
    const original = [{ task, taxonomy_version: "earlier", live: true }] as Doc<"stageTaskSpecs">[];
    const rows = withLocalStagePreviews(task, original)!;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(original[0]);
    expect(rows[2].spec).toBe(spec);
    expect(rows[2].live).toBe(false);
    expect(withLocalStagePreviews(task, rows)).toBe(rows);
    expect(withLocalStagePreviews(task, undefined)).toBeUndefined();
    const link = new URLSearchParams(stagePreviewHref(task, "?dataset=org%2Fdata&episode=11&prediction=old-run"));
    expect(link.get("dataset")).toBe("org/data");
    expect(link.get("episode")).toBe("11");
    expect(link.get("schema")).toBe(spec.taxonomy_version);
    expect(link.get("prediction")).toBe("legacy");
  });
  test("human stage/outcome review preserves hidden actions and distinguishes held from released", () => {
    let row = blankTrajectoryReview(schema, "org/data", 0);
    const hidden = structuredClone(row.key_action_observations);
    for (const stage of schema.task_definition.stages.slice(1, 6)) row = patchStageMark(schema, row, null, stage.id, stage.index, 1);
    const noun = task === "marker_d2" ? "marker" : "nut";
    row = prepareStageOutcomeLabel(schema, { ...row, task_success: false, final_state: `${noun}_fully_seated_held`, failure_mode: "release_not_completed" });
    expect(validateStageOutcomeReview(schema, row, 30)).toEqual([]);
    expect(row.max_stage).toBe(5);
    expect(validateStageOutcomeReview(schema, { ...row, task_success: true, failure_mode: "none" }, 30).length).toBeGreaterThan(0);
    row = patchStageMark(schema, row, null, schema.task_definition.stages[6].id, 6, 1);
    for (const final_state of schema.task_definition.successDefinition.successfulFinalStateIds) {
      const complete = prepareStageOutcomeLabel(schema, { ...row, task_success: true, final_state, failure_mode: "none" });
      expect(validateStageOutcomeReview(schema, complete, 30)).toEqual([]);
      expect(complete.key_action_observations).toEqual(hidden);
    }
    // Later loss is a separate endpoint failure, not a fabricated S7 or erased S6.
    expect(validateStageOutcomeReview(schema, { ...row, task_success: false, final_state: `${noun}_on_table`, failure_mode: "other" }, 30)).toEqual([]);
  });
});
