import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { EXCLUDED_REVIEW_FIELDS, stageReviewCoverage, STRUCTURED_REVIEW_FIELDS, STAGE_REVIEW_FIELDS, STAGE_OUTCOME_REVIEW_FIELDS } from "../convex/stageReviewCoverage";
import { manifestDigest, predictionDigest } from "../convex/stagePredictionContract";
import { trajectoryFromReview } from "../convex/trajectoryReview";
import { validateStageLabel, type ExportedStageSpec } from "../convex/stageConsistency";
import fixtures from "./fixtures/trajectory-review-fixtures.json";
import legacyFixtures from "../src/lib/stage-consistency-fixtures.json";

const modules = {
  "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
  "../convex/stageReviews.ts": () => import("../convex/stageReviews"),
  "../convex/stageTaskSpecs.ts": () => import("../convex/stageTaskSpecs"),
  "../convex/stagePredictions.ts": () => import("../convex/stagePredictions"),
};
const source = fixtures.synthetic.tasks.find((task) => task.spec.task === "routing_d1")!;
const fixture = source.cases.find((row) => row.name === "valid_success")!;
const repo = "test/structured-review";
const service = { serviceToken: "review-coverage-local-only" };
let t: ReturnType<typeof convexTest<typeof schema>>;
let oldToken: string | undefined;
beforeEach(async () => {
  oldToken = process.env.ARENA_SERVICE_TOKEN;
  process.env.ARENA_SERVICE_TOKEN = service.serviceToken;
  t = convexTest({ schema, modules, transactionLimits: true });
  await t.mutation(api.stageTaskSpecs.upsert, { ...service, task: source.spec.task,
    taxonomy_version: source.spec.taxonomy_version, taxonomy_hash: source.spec.taxonomy_hash,
    live: true, spec: source.spec, source: "test-only" });
});
afterEach(() => {
  if (oldToken === undefined) delete process.env.ARENA_SERVICE_TOKEN;
  else process.env.ARENA_SERVICE_TOKEN = oldToken;
});
function args() {
  const label = structuredClone(fixture.review_label!);
  label.trajectory_identity.sample_id = `${repo}#episode=0`;
  // The synthetic prediction fixture assigns timestamps independently; the
  // human review explicitly reconciles this known equivalent event.
  label.key_action_observations[0].first_time_s = 2;
  label.key_action_observations[0].occurrences[0].time_s = 2;
  return { ...service, reviewer_override: "test-reviewer", task: source.spec.task,
    dataset_repo: repo, taxonomy_version: source.spec.taxonomy_version, episode_index: 0n,
    status: "confirmed", label, episode_duration_s: fixture.duration_s };
}

describe("structured review coverage", () => {
  for (const task of fixtures.synthetic.tasks) test(`${task.source_name}: backend confirms stages, result and end state without certifying hidden predictions`, async () => {
    await t.mutation(api.stageTaskSpecs.upsert, { ...service, task: task.spec.task,
      taxonomy_version: task.spec.taxonomy_version, taxonomy_hash: task.spec.taxonomy_hash,
      live: true, spec: task.spec, source: "test-only" });
    const example = task.cases.find((row) => row.name === "valid_success")!;
    const label = structuredClone(example.review_label!);
    label.trajectory_identity.sample_id = `${repo}#episode=0`;
    label.failure_mode = "other";
    label.key_action_observations[0].first_time_s = 999;
    const input = { ...args(), task: task.spec.task, taxonomy_version: task.spec.taxonomy_version,
      label, episode_duration_s: example.duration_s };
    const oldId = await t.mutation(api.stageReviews.save, { ...input, review_protocol: "stages-v1" });
    const id = await t.mutation(api.stageReviews.save, { ...input, review_protocol: "stages-outcome-v1" });
    const saved = await t.run((ctx) => ctx.db.get(id));
    expect(saved!.label).toEqual(label);
    expect(saved!.review_coverage!.reviewed_fields).toEqual([...STAGE_OUTCOME_REVIEW_FIELDS]);
    expect(saved!.review_coverage!.excluded_fields).toContain("failure_mode");
    expect(saved!.review_coverage!.excluded_fields).toContain("key_action_observations.*.first_time_s");
    expect((await t.run((ctx) => ctx.db.get(oldId)))!.review_coverage!.reviewed_fields).toEqual([...STAGE_REVIEW_FIELDS]);
    for (const patch of [{ task_success: null }, { final_state: "" }, { task_success: false }]) {
      await expect(t.mutation(api.stageReviews.save, { ...input, label: { ...label, ...patch }, review_protocol: "stages-outcome-v1" })).rejects.toThrow("internally inconsistent");
    }
    const unknown = { ...label, task_success: null, final_state: "" };
    for (const status of ["draft", "uncertain"]) {
      const draftId = await t.mutation(api.stageReviews.save, { ...input, reviewer_override: "pending-reviewer", status, label: unknown, review_protocol: "stages-outcome-v1" });
      const draft = await t.run((ctx) => ctx.db.get(draftId));
      expect(draft!.label).toEqual(unknown);
      expect(draft!.review_coverage!.reviewed_fields).toEqual([]);
    }
  });

  for (const task of fixtures.synthetic.tasks) test(`${task.source_name}: stage-only confirmation round-trips the task's full ladder`, async () => {
    await t.mutation(api.stageTaskSpecs.upsert, { ...service, task: task.spec.task,
      taxonomy_version: task.spec.taxonomy_version, taxonomy_hash: task.spec.taxonomy_hash,
      live: true, spec: task.spec, source: "test-only" });
    const example = task.cases.find((row) => row.name === "valid_success")!;
    const label = structuredClone(example.review_label!);
    label.trajectory_identity.sample_id = `${repo}#episode=0`;
    // Human stage review does not attest or reconcile these pipeline fields.
    label.task_success = false;
    label.failure_mode = "other";
    const input = { ...args(), task: task.spec.task, taxonomy_version: task.spec.taxonomy_version,
      label, episode_duration_s: example.duration_s, review_protocol: "stages-v1" as const };
    const id = await t.mutation(api.stageReviews.save, input);
    const saved = await t.run((ctx) => ctx.db.get(id));
    expect(saved!.label).toEqual(label);
    expect(saved!.label!.max_stage).toBe(task.spec.ladder.max_stage);
    expect(saved!.review_coverage!.reviewed_fields).toEqual([...STAGE_REVIEW_FIELDS]);
    const invalid = structuredClone(label);
    invalid.stage_transitions[0].time_s = example.duration_s + 1;
    await expect(t.mutation(api.stageReviews.save, { ...input, label: invalid })).rejects.toThrow("before reset footage");
    expect((await t.run((ctx) => ctx.db.get(id)))!.label).toEqual(label);
  });

  test("stage-only confirmation preserves conflicting model fields without attesting them", async () => {
    const input = args();
    input.label.key_action_observations[0].first_time_s = 999;
    input.label.key_action_observations[0].occurrences[0].time_s = 998;
    input.label.failure_mode = "other";
    input.label.task_success = false;
    const before = structuredClone(input.label);
    const id = await t.mutation(api.stageReviews.save, { ...input, review_protocol: "stages-v1" });
    const saved = await t.run((ctx) => ctx.db.get(id));
    expect(saved!.label).toEqual(before);
    expect(saved!.review_coverage!.protocol).toBe("stages-v1");
    expect(saved!.review_coverage!.reviewed_fields).toEqual([...STAGE_REVIEW_FIELDS]);
    expect(saved!.review_coverage!.reviewed_fields.some((field) => /action|failure|task_success|final_state/.test(field))).toBe(false);
    expect(saved!.review_coverage!.excluded_fields).toContain("key_action_observations.*.first_time_s");
    expect(saved!.review_coverage!.excluded_fields).toContain("task_success");
  });

  test("stage-only drafts have no completed coverage and confirmation still checks stage times and identities", async () => {
    const input = args(); input.label.stage_transitions[0].time_s = 999;
    await expect(t.mutation(api.stageReviews.save, { ...input, review_protocol: "stages-v1" })).rejects.toThrow("before reset footage");
    const id = await t.mutation(api.stageReviews.save, { ...input, status: "draft", review_protocol: "stages-v1" });
    expect((await t.run((ctx) => ctx.db.get(id)))!.review_coverage!.reviewed_fields).toEqual([]);
    input.label.stage_transitions[0].time_s = 2;
    input.label.trajectory_identity.sample_id = "wrong/episode";
    await expect(t.mutation(api.stageReviews.save, { ...input, review_protocol: "stages-v1" })).rejects.toThrow("trajectory identity");
  });

  test("completed coverage is fixed, explicit, and never claims source prose or confidence", () => {
    for (const status of ["confirmed", "corrected"]) {
      const coverage = stageReviewCoverage("structured-v1", status, true)!;
      expect(coverage.reviewed_fields).toEqual([...STRUCTURED_REVIEW_FIELDS]);
      expect(coverage.excluded_fields).toEqual([...EXCLUDED_REVIEW_FIELDS]);
      expect(coverage.reviewed_fields.some((path) => /evidence|confidence|notes|review_reasons|needs_human_review/.test(path))).toBe(false);
      coverage.reviewed_fields.pop();
      expect(stageReviewCoverage("structured-v1", status, true)!.reviewed_fields).toHaveLength(STRUCTURED_REVIEW_FIELDS.length);
    }
    expect(stageReviewCoverage(undefined, "confirmed", true)).toBeUndefined();
  });

  test("legacy save followed by protocol review appends without rewriting old labels or inventing historical coverage", async () => {
    const originalArgs = args();
    const originalId = await t.mutation(api.stageReviews.save, originalArgs);
    const original = await t.run((ctx) => ctx.db.get(originalId));
    expect(original!.review_coverage).toBeUndefined();
    const humanNotes = "Human observation, separate from retained model notes.";
    const id = await t.mutation(api.stageReviews.save, { ...originalArgs,
      review_protocol: "structured-v1", notes: humanNotes });
    const saved = await t.run((ctx) => ctx.db.get(id));
    expect(id).not.toBe(originalId);
    expect(saved!.notes).toBe(humanNotes);
    expect(saved!.label).toEqual(originalArgs.label);
    expect(saved!.label!.notes).toBe(originalArgs.label.notes);
    expect(saved!.review_coverage).toEqual(stageReviewCoverage("structured-v1", "confirmed", true));
    expect(await t.run((ctx) => ctx.db.get(originalId))).toEqual(original);
    expect(await t.query(api.stageReviews.historyForEpisode, { dataset_repo: repo, episode_index: 0n })).toHaveLength(2);
  });

  test("draft and uncertain retain contradictions losslessly without completed coverage", async () => {
    for (const status of ["draft", "uncertain"]) {
      const input = args();
      input.label.key_action_observations[0].first_time_s = 2.5;
      input.label.key_action_observations[0].occurrences[0].time_s = 2.5;
      const id = await t.mutation(api.stageReviews.save, { ...input, status, review_protocol: "structured-v1" });
      const row = await t.run((ctx) => ctx.db.get(id));
      expect(row!.label).toEqual(input.label);
      expect(row!.review_coverage!.reviewed_fields).toEqual([]);
      expect(row!.review_coverage!.excluded_fields).toContain("notes");
    }
  });

  test("new confirmations and corrections reject cross-timeline conflicts even from old clients", async () => {
    const input = args();
    input.label.key_action_observations[0].first_time_s = 2.5;
    input.label.key_action_observations[0].occurrences[0].time_s = 2.5;
    expect(validateStageLabel(source.spec as ExportedStageSpec, input.label, input.episode_duration_s)).toEqual([]);
    for (const status of ["confirmed", "corrected"]) {
      await expect(t.mutation(api.stageReviews.save, { ...input, status })).rejects.toThrow("label timeline is inconsistent");
      await expect(t.mutation(api.stageReviews.save, { ...input, status, review_protocol: "structured-v1" })).rejects.toThrow("label timeline is inconsistent");
    }
    expect(await t.run((ctx) => ctx.db.query("stageReviews").collect())).toEqual([]);
  });

  test("protocol is rejected for clear while old clear clients continue to work", async () => {
    const input = { ...args(), label: undefined };
    await expect(t.mutation(api.stageReviews.save, { ...input, status: "cleared", review_protocol: "structured-v1" })).rejects.toThrow("cleared review");
    const id = await t.mutation(api.stageReviews.save, { ...input, status: "cleared" });
    expect((await t.run((ctx) => ctx.db.get(id)))!.review_coverage).toBeUndefined();
  });

  test("legacy schemas still save without protocol and reject invented structured coverage", async () => {
    const legacy = legacyFixtures["routing_d1@s10_v1"];
    await t.mutation(api.stageTaskSpecs.upsert, { ...service, task: "routing_d1",
      taxonomy_version: legacy.spec.taxonomy_version, taxonomy_hash: legacy.spec.taxonomy_hash,
      live: true, spec: legacy.spec, source: "test-only" });
    const input = { ...args(), taxonomy_version: legacy.spec.taxonomy_version,
      label: legacy.fixtures.find((entry) => entry.name === "clean_success")!.row };
    const id = await t.mutation(api.stageReviews.save, input);
    expect((await t.run((ctx) => ctx.db.get(id)))!.review_coverage).toBeUndefined();
    await expect(t.mutation(api.stageReviews.save, { ...input, review_protocol: "structured-v1" })).rejects.toThrow("requires a trajectory schema");
  });

  test("prediction import preserves a conflicting timeline and its original model metadata", async () => {
    const input = args();
    input.label.key_action_observations[0].first_time_s = 2.5;
    input.label.key_action_observations[0].occurrences[0].time_s = 2.5;
    await t.run((ctx) => ctx.db.insert("datasets", { repo_id: repo, name: "Test", task: source.spec.task,
      source_type: "eval", environment: source.spec.task, num_episodes: 1n }));
    const prediction = { episode_index: 0n, label: input.label,
      canonical_response: trajectoryFromReview(input.label), episode_duration_s: fixture.duration_s,
      evidence: {}, source_revision: "b".repeat(40) };
    const sha = await predictionDigest(prediction);
    const runId = await t.mutation(api.stagePredictions.begin, { ...service,
      task: source.spec.task, taxonomy_version: source.spec.taxonomy_version,
      taxonomy_hash: source.spec.taxonomy_hash, dataset_repo: repo, run_key: "test-preserved-conflict",
      pipeline: { name: "test", version: "v1", git_commit: "a".repeat(40) }, expected_count: 1,
      manifest_sha256: await manifestDigest([{ episode_index: 0n, content_sha256: sha }]), source: "test-only", provenance: {} });
    await t.mutation(api.stagePredictions.appendBatch, { ...service, run_id: runId, rows: [prediction] });
    await t.mutation(api.stagePredictions.publish, { ...service, run_id: runId });
    const stored = (await t.query(api.stagePredictions.forRun, { run_id: runId, paginationOpts: { numItems: 10, cursor: null } })).page[0];
    expect(stored.label).toEqual(input.label);
    expect(stored.content_sha256).toBe(sha);
    const originalPrediction = await t.run((ctx) => ctx.db.get(stored._id));
    await expect(t.mutation(api.stageReviews.save, { ...input, review_protocol: "structured-v1",
      prediction_id: stored._id, prediction_sha256: sha })).rejects.toThrow("label timeline is inconsistent");
    expect(await t.run((ctx) => ctx.db.get(stored._id))).toEqual(originalPrediction);
  });
});
