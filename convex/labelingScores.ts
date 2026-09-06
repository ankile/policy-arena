import { v } from "convex/values";
import { mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireEditor } from "./access";
import { canonicalDigest } from "./stagePredictionContract";
import { isNewer, reviewerKey } from "./stageReviews";
import { trajectoryFromReview } from "./trajectoryReview";
import { validateStageLabel, type ExportedStageSpec } from "./stageConsistency";

/** Fold ALL statuses first. A new uncertain/draft/cleared row invalidates old gold. */
export function eligibleGold(rows: Doc<"stageReviews">[], taxonomy: string) {
  const latest = new Map<string, Doc<"stageReviews">>();
  for (const row of rows.filter((r) => r.taxonomy_version === taxonomy)) {
    const key = `${row.episode_index}:${reviewerKey(row)}`;
    const prev = latest.get(key);
    if (!prev || isNewer(row, prev)) latest.set(key, row);
  }
  const byEpisode = new Map<bigint, Doc<"stageReviews">[]>();
  for (const row of latest.values()) byEpisode.set(row.episode_index, [...(byEpisode.get(row.episode_index) ?? []), row]);
  const eligible: Doc<"stageReviews">[] = [], excluded: bigint[] = [];
  for (const [episode, reviews] of byEpisode) {
    // Multi-reviewer cases require explicit adjudication, even if summaries agree.
    if (reviews.length !== 1 || !["confirmed", "corrected"].includes(reviews[0].status) || !reviews[0].label || !reviews[0].prediction_id) excluded.push(episode);
    else eligible.push(reviews[0]);
  }
  return { eligible: eligible.sort((a,b) => Number(a.episode_index-b.episode_index)), excluded };
}
async function goldFor(ctx: QueryCtx | MutationCtx, run: Doc<"stagePredictionRuns">) {
  const rows = await ctx.db.query("stageReviews").withIndex("by_repo", (q) => q.eq("dataset_repo", run.dataset_repo)).take(2001);
  if (rows.length > 2000) throw new Error("Review history exceeds the interactive freeze limit; export an audited snapshot");
  return eligibleGold(rows, run.taxonomy_version);
}
export const readiness = query({
  args: { run_id: v.id("stagePredictionRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.run_id);
    if (!run) throw new Error("Prediction run not found");
    const gold = await goldFor(ctx, run);
    return { eligible: gold.eligible.filter((r) => r.prediction_run_id === run._id).length,
      excluded: gold.excluded.length + gold.eligible.filter((r) => r.prediction_run_id !== run._id).length };
  },
});
export const freeze = mutation({
  args: { run_id: v.id("stagePredictionRuns"), name: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireEditor(ctx);
    if (!args.name.trim() || args.name.length > 100) throw new Error("Give the benchmark a name of at most 100 characters");
    const run = await ctx.db.get(args.run_id);
    if (!run || run.status !== "published") throw new Error("Freeze a published baseline run");
    const spec = await ctx.db.query("stageTaskSpecs").withIndex("by_task_version", (q) => q.eq("task", run.task).eq("taxonomy_version", run.taxonomy_version)).unique();
    if (!spec?.spec.trajectory || spec.taxonomy_hash !== run.taxonomy_hash) throw new Error("Matching trajectory schema required");
    const gold = await goldFor(ctx, run);
    const rows = [], excluded = [...gold.excluded];
    for (const review of gold.eligible) {
      if (review.prediction_run_id !== run._id) { excluded.push(review.episode_index); continue; }
      const prediction = await ctx.db.get(review.prediction_id!);
      if (!prediction || prediction.run_id !== run._id || prediction.episode_index !== review.episode_index || prediction.content_sha256 !== review.prediction_sha256 || !prediction.source_revision || review.taxonomy_hash !== run.taxonomy_hash) throw new Error("Review prediction attribution or media revision is missing or inconsistent");
      if (!review.episode_duration_s || review.episode_duration_s !== prediction.episode_duration_s) throw new Error("Review video duration does not match its prediction");
      if (validateStageLabel(spec.spec as ExportedStageSpec, review.label!, review.episode_duration_s).length) throw new Error("Gold review fails semantic validation");
      rows.push({ episode_index: review.episode_index, review_id: review._id, prediction_id: prediction._id,
        source_revision: prediction.source_revision, label: trajectoryFromReview(review.label!) });
    }
    if (!rows.length || rows.length > 100) throw new Error("Freeze requires 1..100 complete, unambiguous reviews attributed to this baseline");
    const content = { task: run.task, dataset_repo: run.dataset_repo, taxonomy_version: run.taxonomy_version,
      taxonomy_hash: run.taxonomy_hash, baseline_run_id: run._id, rows, excluded_episodes: excluded.sort((a,b) => Number(a-b)) };
    const digest = await canonicalDigest({ ...content,
      rows: rows.map((row) => ({ ...row, episode_index: row.episode_index.toString() })),
      excluded_episodes: content.excluded_episodes.map(String) });
    return ctx.db.insert("labelingBenchmarks", { ...content, name: args.name.trim(), digest, created_at: Date.now(), created_by: actor });
  },
});
export const benchmarks = query({
  args: { task: v.string() },
  handler: (ctx, args) => ctx.db.query("labelingBenchmarks").withIndex("by_task", (q) => q.eq("task", args.task)).order("desc").take(50),
});
export const scores = query({
  args: { benchmark_id: v.id("labelingBenchmarks") },
  handler: (ctx, args) => ctx.db.query("labelingScores").withIndex("by_benchmark", (q) => q.eq("benchmark_id", args.benchmark_id)).order("desc").take(100),
});
type SummaryLabel = { max_stage: { stage_index: number }; final_state_id: string; primary_failure: { failure_mode_id: string }; attempt_count: number; task_success: boolean };
export function scoreSummaries(pairs: { gold: SummaryLabel; prediction: SummaryLabel }[]) {
  if (!pairs.length) throw new Error("Cannot score an empty benchmark");
  let stage = 0, final = 0, failure = 0, attempts = 0, success = 0, absoluteStageError = 0;
  for (const { gold, prediction } of pairs) {
    for (const label of [gold, prediction]) {
      if (!Number.isInteger(label.max_stage?.stage_index) || !Number.isInteger(label.attempt_count) ||
          typeof label.final_state_id !== "string" || typeof label.primary_failure?.failure_mode_id !== "string" || typeof label.task_success !== "boolean") throw new Error("Malformed trajectory summary");
    }
    stage += Number(gold.max_stage.stage_index === prediction.max_stage.stage_index);
    final += Number(gold.final_state_id === prediction.final_state_id);
    failure += Number(gold.primary_failure.failure_mode_id === prediction.primary_failure.failure_mode_id);
    attempts += Number(gold.attempt_count === prediction.attempt_count);
    success += Number(gold.task_success === prediction.task_success);
    absoluteStageError += Math.abs(gold.max_stage.stage_index - prediction.max_stage.stage_index);
  }
  return { protocol: "trajectory-summary-agreement/v1", n: pairs.length, stage_exact: stage,
    final_exact: final, failure_exact: failure, attempts_exact: attempts,
    outcome_conditioned_success_exact: success, stage_mae: absoluteStageError / pairs.length,
    event_timing_scored: false, promotion_eligible: false };
}
export const score = mutation({
  args: { benchmark_id: v.id("labelingBenchmarks"), run_id: v.id("stagePredictionRuns") },
  handler: async (ctx, args) => {
    const actor = await requireEditor(ctx);
    const benchmark = await ctx.db.get(args.benchmark_id), run = await ctx.db.get(args.run_id);
    if (!benchmark || !run || run.status !== "published" || run.dataset_repo !== benchmark.dataset_repo || run.taxonomy_hash !== benchmark.taxonomy_hash || run.task !== benchmark.task) throw new Error("Candidate must be published on the benchmark dataset and schema");
    const existing = await ctx.db.query("labelingScores").withIndex("by_benchmark_run", (q) => q.eq("benchmark_id", benchmark._id).eq("run_id", run._id)).unique();
    if (existing) return existing._id;
    const pairs = [];
    for (const gold of benchmark.rows) {
      const prediction = await ctx.db.query("stagePredictions").withIndex("by_run_episode", (q) => q.eq("run_id", run._id).eq("episode_index", gold.episode_index)).unique();
      if (!prediction || prediction.source_revision !== gold.source_revision || !prediction.canonical_response) throw new Error(`Missing prediction or mismatched media revision for episode ${gold.episode_index}`);
      if (prediction.validation_codes.length || prediction.violation_codes?.length) throw new Error(`Candidate episode ${gold.episode_index} has semantic violations`);
      pairs.push({ gold: gold.label as SummaryLabel, prediction: prediction.canonical_response as SummaryLabel });
    }
    return ctx.db.insert("labelingScores", { benchmark_id: benchmark._id, run_id: run._id,
      benchmark_digest: benchmark.digest, run_manifest_sha256: run.manifest_sha256,
      metrics: scoreSummaries(pairs), created_at: Date.now(), created_by: actor });
  },
});
