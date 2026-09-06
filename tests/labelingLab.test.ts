import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import fixtures from "./fixtures/trajectory-review-fixtures.json";
import { parseEpisodes, validateEpisodes, validateGeneration } from "../convex/labelingContract";
import { eligibleGold, scoreSummaries } from "../convex/labelingScores";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { manifestDigest, predictionDigest } from "../convex/stagePredictionContract";
import { stageReviewCoverage } from "../convex/stageReviewCoverage";

const modules = {
  "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
  "../convex/labelingLab.ts": () => import("../convex/labelingLab"),
  "../convex/labelingScores.ts": () => import("../convex/labelingScores"),
  "../convex/labelingDispatch.ts": () => import("../convex/labelingDispatch"),
  "../convex/stagePredictions.ts": () => import("../convex/stagePredictions"),
};
const generation = { model: "test-model", video_fps: 4, max_output_tokens: 32768, temperature: null,
  media_resolution: null, thinking_level: null, final_frame_stills: false, max_attempts: 3 };
const source = fixtures.synthetic.tasks[0];
const prompt = `Fixture instructions\n<task_definition format="application/json">${JSON.stringify(source.spec.trajectory.task_definition)}</task_definition>`;
const fixture = source.cases.find((item) => item.name === "historical_high_stage_final_failure")!;
const repo = "test/labeling-lab";
let t: ReturnType<typeof convexTest<typeof schema>>;
let editor: ReturnType<typeof t.withIdentity>;
let configId: Id<"labelingConfigs">;
let env: Record<string, string | undefined>;
beforeEach(async () => {
  const names = ["ARENA_EDITOR_SUBS", "ARENA_SERVICE_TOKEN", "LABELING_ENABLED", "LABELING_CLOUD_RUN_JOB", "LABELING_DISPATCHER_JSON", "LABELING_CANARY_RECEIPT"];
  env = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  process.env.ARENA_EDITOR_SUBS = "editor-sub";
  process.env.ARENA_SERVICE_TOKEN = "test-only-service";
  t = convexTest({ schema, modules, transactionLimits: true });
  const { user, spec } = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { username: "editor" });
    await ctx.db.insert("authAccounts", { userId: user, provider: "huggingface", providerAccountId: "editor-sub" });
    const spec = await ctx.db.insert("stageTaskSpecs", { task: source.spec.task, taxonomy_version: source.spec.taxonomy_version,
      taxonomy_hash: source.spec.taxonomy_hash, live: true, spec: source.spec, exported_at: 1, source: "test" });
    await ctx.db.insert("datasets", { repo_id: repo, name: "test", task: source.spec.task, environment: source.spec.task,
      source_type: "eval", num_episodes: 40n, stats_status: "ready", stats_hf_sha: "a".repeat(40) });
    return { user, spec };
  });
  editor = t.withIdentity({ subject: user });
  configId = await t.mutation(internal.labelingLab.registerPreset, { name: "Fixture", spec_id: spec,
    system_prompt: prompt, response_schema: {}, generation, worker_revision: "b".repeat(40) });
});
afterEach(() => { for (const [name,value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });

describe("Labeling Lab authorization and immutable requests", () => {
  test("anonymous and non-editor identities cannot write", async () => {
    const args = { parent_id: configId, name: "new", system_prompt: `${prompt}\nEdited instructions`, generation };
    await expect(t.mutation(api.labelingLab.saveConfig, args)).rejects.toThrow("Not signed in");
    const user = await t.run((ctx) => ctx.db.insert("users", { username: "outsider" }));
    await expect(t.withIdentity({ subject: user }).mutation(api.labelingLab.saveConfig, args)).rejects.toThrow("account id");
    await expect(t.mutation(api.labelingLab.submit, { config_id: configId, dataset_repo: repo, episodes: [0], request_key: "test-submission-key" })).rejects.toThrow("Not signed in");
  });
  test("saving edits creates an immutable version, and an exact retry deduplicates", async () => {
    const before = await t.run((ctx) => ctx.db.get(configId));
    const args = { parent_id: configId, name: "new", system_prompt: `${prompt}\nEdited instructions`, generation };
    const id = await editor.mutation(api.labelingLab.saveConfig, args);
    expect(id).not.toBe(configId);
    expect(await editor.mutation(api.labelingLab.saveConfig, args)).toBe(id);
    expect(await t.run((ctx) => ctx.db.get(configId))).toEqual(before);
    await expect(editor.mutation(api.labelingLab.saveConfig, { ...args, generation: { ...generation, model: "unapproved-model" } })).rejects.toThrow("Model");
    await expect(editor.mutation(api.labelingLab.saveConfig, { ...args, system_prompt: "A different task" })).rejects.toThrow("preserve the registered task");
  });
  test("deployment without verified worker settings fails closed even for an editor", async () => {
    expect((await t.query(api.labelingLab.availability, {})).enabled).toBe(false);
    await expect(editor.mutation(api.labelingLab.submit, { config_id: configId, dataset_repo: repo, episodes: [0], request_key: "test-submission-key" })).rejects.toThrow("disabled");
    expect(await t.run((ctx) => ctx.db.query("labelingJobs").collect())).toEqual([]);
  });
  test("humans cannot impersonate the worker", async () => {
    const jobId = await seedJob();
    await expect(editor.mutation(api.labelingLab.claim, { job_id: jobId, worker_id: "worker-one" })).rejects.toThrow("Worker credential");
    await expect(t.mutation(api.labelingLab.claim, { serviceToken: "incorrect", job_id: jobId, worker_id: "worker-one" })).rejects.toThrow("Invalid service token");
  });
  test("duplicate executions and stale leases cannot acquire a paid job", async () => {
    const job_id = await seedJob();
    const args = { serviceToken: "test-only-service", job_id, worker_id: "worker-one" };
    const claim = await t.mutation(api.labelingLab.claim, args);
    expect((await t.mutation(api.labelingLab.claim, args)).fence).toBe(claim.fence);
    await expect(t.mutation(api.labelingLab.claim, { ...args, worker_id: "worker-two" })).rejects.toThrow("execution owner");
    await expect(t.mutation(api.labelingLab.heartbeat, { ...args, fence: 99 })).rejects.toThrow("stale");
    await t.run((ctx) => ctx.db.patch(job_id, { lease_until: Date.now() - 1 }));
    await expect(t.mutation(api.labelingLab.claim, args)).rejects.toThrow("expired");
  });
  test("cancellation is authorized and stops a queued worker from claiming", async () => {
    const job_id = await seedJob();
    await expect(t.mutation(api.labelingLab.cancel, { job_id })).rejects.toThrow("Not signed in");
    await editor.mutation(api.labelingLab.cancel, { job_id });
    await expect(t.mutation(api.labelingLab.claim, { serviceToken: "test-only-service", job_id, worker_id: "worker-one" })).rejects.toThrow("cannot be claimed");
  });
  test("admission ceilings reject malformed ranges and oversized settings", () => {
    expect(parseEpisodes("0, 2-4")).toEqual([0,2,3,4]);
    for (const text of ["", "0,0", "1-0", "0-999999999", "$(evil)", "NaN"]) expect(() => parseEpisodes(text)).toThrow();
    expect(() => validateEpisodes([40], 40)).toThrow();
    expect(() => validateGeneration({ ...generation, max_attempts: 100 }, generation.model)).toThrow();
  });
});
async function seedJob() {
  return t.run(async (ctx) => {
    const config = (await ctx.db.get(configId))!, user = (await ctx.db.query("users").first())!;
    return ctx.db.insert("labelingJobs", { config_id: configId, config_digest: config.digest, dataset_repo: repo,
      dataset_revision: "a".repeat(40), episodes: [0], requested_by: "editor", requested_user_id: user._id,
      requested_at: Date.now(), updated_at: Date.now(), request_key: "test-key", request_digest: "test-digest",
      status: "queued", completed_episodes: 0, provider_calls: 0, fence: 0 });
  });
}

describe("Frozen gold scoring", () => {
  test("new uncertain or cleared reviews never fall back to old confirmed gold", () => {
    const base = { _id: "r1", _creationTime: 1, saved_at: 1, episode_index: 0n,
      reviewer: "test", taxonomy_version: "v1", status: "confirmed", label: {}, prediction_id: "p1" } as Doc<"stageReviews">;
    expect(eligibleGold([base], "v1").eligible).toHaveLength(1);
    for (const status of ["uncertain", "draft", "cleared"]) {
      expect(eligibleGold([base, { ...base, _creationTime: 2, saved_at: 2, status }], "v1").eligible).toHaveLength(0);
    }
    expect(eligibleGold([base, { ...base, reviewer: "second" }], "v1").eligible).toHaveLength(0);
  });
  test("summary scores have explicit denominators and cannot authorize promotion", () => {
    const gold = fixture.canonical;
    const metrics = scoreSummaries([{ gold, prediction: { ...gold, attempt_count: gold.attempt_count + 1 } }]);
    expect(metrics.n).toBe(1); expect(metrics.stage_exact).toBe(1); expect(metrics.attempts_exact).toBe(0);
    expect(metrics.promotion_eligible).toBe(false); expect(metrics.event_timing_scored).toBe(false);
    expect(() => scoreSummaries([])).toThrow();
  });
  test("snapshot and scoring pin exact reviews, prediction payloads and source media", async () => {
    const row = { episode_index: 0n, label: fixture.review_label!, canonical_response: fixture.canonical,
      episode_duration_s: fixture.duration_s, evidence: {}, source_revision: "a".repeat(40) };
    const service = { serviceToken: "test-only-service" };
    const run_id = await t.mutation(api.stagePredictions.begin, { ...service, run_key: "baseline",
      dataset_repo: repo, task: source.spec.task, taxonomy_version: source.spec.taxonomy_version, taxonomy_hash: source.spec.taxonomy_hash,
      pipeline: { name: "test", version: "v1", git_commit: "b".repeat(40) }, expected_count: 1,
      manifest_sha256: await manifestDigest([{ episode_index: 0n, content_sha256: await predictionDigest(row) }]), source: "test", provenance: {} });
    await t.mutation(api.stagePredictions.appendBatch, { ...service, run_id, rows: [row] });
    await t.mutation(api.stagePredictions.publish, { ...service, run_id });
    const prediction = (await t.query(api.stagePredictions.forRun, { run_id, paginationOpts: { cursor: null, numItems: 1 } })).page[0];
    const reviewId = await t.run((ctx) => ctx.db.insert("stageReviews", { task: source.spec.task, dataset_repo: repo,
      taxonomy_version: source.spec.taxonomy_version, taxonomy_hash: source.spec.taxonomy_hash, episode_index: 0n,
      status: "confirmed", label: row.label, reviewer: "gold-reviewer", saved_at: 1,
      prediction_id: prediction._id, prediction_sha256: prediction.content_sha256, prediction_run_id: run_id,
      episode_duration_s: fixture.duration_s }));
    await expect(t.mutation(api.labelingScores.freeze, { run_id, name: "gold" })).rejects.toThrow("Not signed in");
    const benchmark_id = await editor.mutation(api.labelingScores.freeze, { run_id, name: "gold" });
    const id = await editor.mutation(api.labelingScores.score, { benchmark_id, run_id });
    expect(await editor.mutation(api.labelingScores.score, { benchmark_id, run_id })).toBe(id);
    expect((await t.run((ctx) => ctx.db.get(id)))!.metrics.stage_exact).toBe(1);
    const frozen = await t.run((ctx) => ctx.db.get(benchmark_id));
    expect(frozen!.rows[0].prediction_id).toBe(prediction._id);
    expect(frozen!.rows[0].review_coverage).toBeUndefined();
    expect(frozen!.rows[0].human_notes).toBeUndefined();
    const originalReview = (await t.run((ctx) => ctx.db.get(reviewId)))!;
    const { _id: _reviewId, _creationTime: _createdAt, ...originalFields } = originalReview;
    void _reviewId; void _createdAt;
    const coverage = stageReviewCoverage("structured-v1", "confirmed", true)!;
    await t.run((ctx) => ctx.db.insert("stageReviews", { ...originalFields, saved_at: 2,
      review_coverage: coverage, notes: "Human notes distinct from retained model prose." }));
    const withCoverageId = await editor.mutation(api.labelingScores.freeze, { run_id, name: "structured gold" });
    const withCoverage = (await t.run((ctx) => ctx.db.get(withCoverageId)))!;
    expect(withCoverage.rows[0].review_coverage).toEqual(coverage);
    expect(withCoverage.rows[0].human_notes).toBe("Human notes distinct from retained model prose.");
    expect(withCoverage.rows[0].label).toEqual(frozen!.rows[0].label);
    expect(withCoverage.digest).not.toBe(frozen!.digest);
    expect(await t.run((ctx) => ctx.db.get(benchmark_id))).toEqual(frozen);
    expect(await t.run((ctx) => ctx.db.get(reviewId))).toEqual(originalReview);
    await t.run((ctx) => ctx.db.patch(prediction._id, { source_revision: "c".repeat(40) }));
    // A distinct snapshot exercises scoring admission, without mutating a prior score.
    const second = await t.run((ctx) => ctx.db.insert("labelingBenchmarks", { ...Object.fromEntries(Object.entries(frozen!).filter(([k]) => !k.startsWith("_"))) } as Omit<Doc<"labelingBenchmarks">, "_id" | "_creationTime">));
    await expect(editor.mutation(api.labelingScores.score, { benchmark_id: second, run_id })).rejects.toThrow("mismatched media");
  });
});
