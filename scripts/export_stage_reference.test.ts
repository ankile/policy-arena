import { describe, expect, test } from "bun:test";
import { freezeReference } from "./export_stage_reference";
import { blankTrajectoryReview } from "../convex/trajectoryReview";
import { stageReviewCoverage } from "../convex/stageReviewCoverage";
import { stageReviewRelease } from "../shared/stageReviewRelease";
import { normalizeStageSpec } from "../src/lib/stage-spec";
import type { LocalReview } from "../sandbox/localReviewStore";

const spec = stageReviewRelease.marker_d2;
const tag = normalizeStageSpec(spec).trajectory!;
const pilot = { id: "test", purpose: "development only", method: "fixed",
  sources: [{ task: "marker_d2", repo: "org/data", revision: "a".repeat(40), name: "Test" }],
  episodes: [{ task: "marker_d2", dataset: "org/data", episode: 1 }] };
const provenance = { export_file_sha256: "b".repeat(64), pilot_file_sha256: "c".repeat(64) };
function review(): LocalReview {
  return { _id: "local-one", dataset_repo: "org/data", episode_index: 1n,
    task: "marker_d2", taxonomy_version: spec.taxonomy_version, reviewer: "Local playground",
    reviewer_user_id: "local-reviewer", saved_at: 100, blind: true, status: "confirmed",
    episode_duration_s: 20, review_protocol: "stages-outcome-v3",
    review_coverage: stageReviewCoverage("stages-outcome-v3", "confirmed", true),
    local_task_definition_sha256: spec.trajectory.task_definition_sha256,
    label: { ...blankTrajectoryReview(tag, "org/data", 1n), task_success: false,
      max_stage: 0, max_stage_id: "initial_state",
      failure_mode: "grasp_not_established" }, notes: "Human observation" };
}
describe("human reference export", () => {
  test("freezes only supervised fields and preserves originals", async () => {
    const row = review(), original = structuredClone(row);
    const gold = await freezeReference([row], pilot, "marker_d2", provenance);
    expect(gold.cases[0].expected).toEqual({ task_success: false, failure_mode_id: "grasp_not_established",
      max_stage_id: "initial_state", max_stage_index: 0, attempt_count: 1, stage_transitions: [] });
    expect(gold.cases[0].human_notes).toBe("Human observation");
    expect(row).toEqual(original);
    expect(gold.task_definition_sha256).toBe(spec.trajectory.task_definition_sha256);
    expect((await freezeReference([row], pilot, "marker_d2", provenance)).reference_sha256).toBe(gold.reference_sha256);
  });
  test("latest draft blocks stale confirmed review", async () => {
    const row = review();
    await expect(freezeReference([row, { ...row, _id: "later", status: "draft", saved_at: 101 }], pilot, "marker_d2", provenance)).rejects.toThrow("not committed");
  });
  test("does not confuse same episode numbers across datasets", async () => {
    await expect(freezeReference([{ ...review(), dataset_repo: "different/data" }], pilot, "marker_d2", provenance)).rejects.toThrow("missing");
  });
  test("rejects stale pins, insufficient coverage and incomplete failure choice", async () => {
    const row = review();
    await expect(freezeReference([{ ...row, local_task_definition_sha256: "d".repeat(64) }], pilot, "marker_d2", provenance)).rejects.toThrow("pin differs");
    await expect(freezeReference([{ ...row, review_coverage: undefined }], pilot, "marker_d2", provenance)).rejects.toThrow("coverage");
    await expect(freezeReference([{ ...row, label: { ...row.label, failure_mode: "" } }], pilot, "marker_d2", provenance)).rejects.toThrow("primary reason");
  });
  test("rejects duplicate cohort and identity mismatch", async () => {
    await expect(freezeReference([review()], { ...pilot, episodes: [...pilot.episodes, ...pilot.episodes] }, "marker_d2", provenance)).rejects.toThrow("Duplicate");
    const row = review();
    await expect(freezeReference([{ ...row, label: { ...row.label, trajectory_identity: {} } }], pilot, "marker_d2", provenance)).rejects.toThrow("identity differs");
  });
  test("evaluation flag never bypasses unknown pins or uncommitted saves", async () => {
    const options = { allowPendingDefinitionReview: true };
    await expect(freezeReference([{ ...review(), local_task_definition_sha256: "d".repeat(64) }],
      pilot, "marker_d2", provenance, options)).rejects.toThrow("pin differs");
    await expect(freezeReference([{ ...review(), status: "draft" }], pilot,
      "marker_d2", provenance, options)).rejects.toThrow("not committed");
  });
  test("old routing boundaries remain provisional without changing original saves", async () => {
    const routing = stageReviewRelease.routing_d1;
    const routingTag = normalizeStageSpec(routing).trajectory!;
    const row: LocalReview = { ...review(), task: "routing_d1", taxonomy_version: routing.taxonomy_version,
      local_task_definition_sha256: "ddf423c02e069c5fd959b4a9e98b874bb25be03f4e12d36905b800093a8e9bb0",
      label: { ...blankTrajectoryReview(routingTag, "org/data", 1n), task_success: false,
        max_stage: 0, max_stage_id: routingTag.task_definition.stages[0].id, failure_mode: "first_clip_grasp_not_established" } };
    const cohort = { ...pilot, sources: pilot.sources.map((s) => ({ ...s, task: "routing_d1" })),
      episodes: pilot.episodes.map((e) => ({ ...e, task: "routing_d1" })) };
    const original = structuredClone(row);
    await expect(freezeReference([row], cohort, "routing_d1", provenance)).rejects.toThrow("recheck");
    const gold = await freezeReference([row], cohort, "routing_d1", provenance,
      { allowPendingDefinitionReview: true });
    expect(gold.cases[0].definition_review_issues).toHaveLength(1);
    expect(gold.cases[0].source_review.task_definition_sha256).toBe(row.local_task_definition_sha256!);
    expect(gold.cases[0].expected.failure_mode_id).toBe("first_clip_grasp_not_established");
    expect(row).toEqual(original);
  });
});
