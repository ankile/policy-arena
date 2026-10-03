import { describe, expect, test } from "bun:test";
import type { Doc } from "../convex/_generated/dataModel";
import { canonicalDigest } from "../convex/stagePredictionContract";
import { blankTrajectoryReview, trajectoryTaskDefinitionDigest } from "../convex/trajectoryReview";
import { normalizeStageSpec } from "../src/lib/stage-spec";
import { patchStageMark, stageTitle } from "../src/lib/stageTimeline";
import { validateStageOnlyReview } from "../convex/stageOnlyReview";
import { prepareStageOutcomeLabel, validateStageOutcomeReview } from "../convex/stageOutcomeReview";
import previousSpec from "./data/routing_d1_v2.spec.json";
import spec from "./data/routing_d1_v3.spec.json";
import { latestStagePreviews, stagePreviewHref, withLocalStagePreviews } from "./localStagePreviews";

describe("Routing v3 two-cycle preview", () => {
  test("exported definition and adapter hashes match their contents", async () => {
    const normalized = normalizeStageSpec(spec);
    expect(await trajectoryTaskDefinitionDigest(normalized.trajectory!.task_definition)).toBe(spec.trajectory.task_definition_sha256);
    const { taxonomy_hash, ...content } = spec;
    expect(await canonicalDigest(content)).toBe(taxonomy_hash);
    expect(spec.trajectory.task_definition.taxonomyVersion).toBe("routing_d1/v3");
  });

  test("candidate preserves the published version and never mutates returned rows", () => {
    const original = [{ taxonomy_version: "trajectory-review/v1/routing_d1/v1", live: true }] as Doc<"stageTaskSpecs">[];
    const rows = withLocalStagePreviews("routing_d1", original)!;
    expect(original).toHaveLength(1);
    expect(rows[0]).toBe(original[0]);
    expect(rows[1].live).toBe(false);
    expect(rows[1].taxonomy_version).toBe(previousSpec.taxonomy_version);
    expect(rows[1].spec).toBe(previousSpec);
    expect(rows[2].spec).toBe(spec);
    expect(rows[3].taxonomy_version).toBe(latestStagePreviews.routing_d1.taxonomy_version);
    expect(withLocalStagePreviews("routing_d1", original)![2]).toBe(rows[2]);
    expect(withLocalStagePreviews("routing_d1", rows)).toBe(rows);
    expect(withLocalStagePreviews("unknown", original)).toBe(original);
    expect(withLocalStagePreviews("routing_d1", undefined)).toBeUndefined();
  });

  test("opt-in retains dataset/episode but does not reuse an old prediction", () => {
    const source = "?dataset=org%2Frouting&episode=116&prediction=v1-run&schema=old";
    const next = new URLSearchParams(stagePreviewHref("routing_d1", source));
    expect(next.get("dataset")).toBe("org/routing");
    expect(next.get("episode")).toBe("116");
    expect(next.get("schema")).toBe(latestStagePreviews.routing_d1.taxonomy_version);
    expect(next.get("prediction")).toBe("legacy");
    expect(new URLSearchParams(source).get("prediction")).toBe("v1-run");
  });

  test("plain-language stage names support blank human reviews and skipped milestones", () => {
    const schema = normalizeStageSpec(spec).trajectory!;
    expect(schema.task_definition.stages.slice(1).map(stageTitle)).toEqual([
      "S1 · Reach the rope", "S2 · Hold the rope", "S3 · Align with the first clip", "S4 · Engage the first clip", "S5 · First release",
      "S6 · Reach the rope again", "S7 · Hold the rope again", "S8 · Align with the second clip", "S9 · Engage the second clip", "S10 · Final release",
    ]);
    let row = blankTrajectoryReview(schema, "org/routing", 116);
    const actions = structuredClone(row.key_action_observations);
    expect(row.trajectory_identity).toMatchObject({ taxonomy_version: "routing_d1/v3" });
    for (const index of [1, 2, 6, 10]) row = patchStageMark(schema, row, null, schema.task_definition.stages[index].id, index, 1);
    expect(validateStageOnlyReview(schema, row, 30)).toEqual([]);
    row = prepareStageOutcomeLabel(schema, { ...row, task_success: true, final_state: "rope_in_both_clips", failure_mode: "none" });
    expect(validateStageOutcomeReview(schema, row, 30)).toEqual([]);
    expect(row.key_action_observations).toEqual(actions);
  });

  test("release does not force success, and a seated endpoint can succeed before final release", () => {
    const schema = normalizeStageSpec(spec).trajectory!;
    let row = blankTrajectoryReview(schema, "org/routing", 0);
    row = patchStageMark(schema, row, null, "second_clip_engaged", 9, 1);
    row = prepareStageOutcomeLabel(schema, { ...row, task_success: true, final_state: "rope_in_both_clips" });
    expect(validateStageOutcomeReview(schema, row, 30)).toEqual([]);
    row = patchStageMark(schema, row, null, "final_rope_released", 10, 1);
    row = { ...row, task_success: false, final_state: "rope_in_second_clip_only", failure_mode: "second_seated_first_skipped" };
    expect(validateStageOutcomeReview(schema, row, 30)).toEqual([]);
    expect(validateStageOutcomeReview(schema, { ...row, task_success: true, failure_mode: "none" }, 30).length).toBeGreaterThan(0);
    const firstRelease = patchStageMark(schema, blankTrajectoryReview(schema, "org/routing", 0), null, "first_rope_released", 5, 1);
    expect(firstRelease.max_stage).toBe(5);
  });
});
