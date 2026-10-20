/**
 * Follow an episode splice on the Hub: renumber every Arena row keyed by
 * (dataset_repo, episode_index) and delete the rows of removed episodes.
 *
 * The Hub side is sir `repair_eval_dataset --drop-episodes` (survivors renumbered
 * dense; outcome-review sidecars renumbered with them). Run `plan` first, then
 * `apply` with the plan's fingerprint, immediately after the Hub commit:
 *
 *   npx convex run episodeSplice:plan  '{"dataset_repo": R, "total_before": N, "drop": [i]}'
 *   npx convex run episodeSplice:apply '{..., "expected_fingerprint": "<from plan>"}'
 *
 * Covered: outcomeReviews (every row, not just the latest), episodeNotes,
 * stagePrefills, stageReviews, and roundResults of every eval session on the
 * repo. The removed episode's roundResults row is deleted so a re-collected
 * rollout for the same (round, policy) is accepted by addRounds' dedup. Stage
 * predictions / labeling jobs / benchmarks pin episode sets by revision; a repo
 * that has any is refused rather than half-renumbered. The fingerprint pins the
 * exact pre-splice row set, so a second apply (or a concurrent review save)
 * fails instead of shifting indices twice; an in-flight apply job refuses it. Run it
 * only AFTER the Hub splice commit has landed (the shell checks the Hub head first):
 * renumbered rows against an unspliced Hub would apply reviews to the wrong
 * episodes. Internal: deploy credentials only.
 */
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id, TableNames } from "./_generated/dataModel";
import { v } from "convex/values";
import { planSplice, summarizePlan, type SpliceRow } from "./episodeSpliceLogic";

const spliceArgs = {
  dataset_repo: v.string(),
  total_before: v.number(),
  drop: v.array(v.number()),
};

type SplicedTable = "outcomeReviews" | "episodeNotes" | "stagePrefills" | "stageReviews" | "roundResults";

async function collectRows(ctx: QueryCtx, repo: string) {
  const runs = await ctx.db
    .query("stagePredictionRuns")
    .withIndex("by_repo_taxonomy", (q) => q.eq("dataset_repo", repo))
    .take(1);
  const jobs = (await ctx.db.query("labelingJobs").collect()).filter((j) => j.dataset_repo === repo);
  const benchmarks = (await ctx.db.query("labelingBenchmarks").collect()).filter((b) => b.dataset_repo === repo);
  if (runs.length || jobs.length || benchmarks.length) {
    throw new Error(
      `${repo} has stage-prediction runs (${runs.length}), labeling jobs (${jobs.length}) or ` +
        `benchmarks (${benchmarks.length}) pinned to episode indices; splice refuses to renumber them`
    );
  }

  const rows: SpliceRow[] = [];
  const add = (table: SplicedTable, docs: Array<{ _id: string; episode_index: bigint }>) => {
    for (const doc of docs) rows.push({ table, id: doc._id, episode_index: Number(doc.episode_index) });
  };
  add("outcomeReviews", await ctx.db.query("outcomeReviews").withIndex("by_repo", (q) => q.eq("dataset_repo", repo)).collect());
  add("episodeNotes", await ctx.db.query("episodeNotes").withIndex("by_repo_episode", (q) => q.eq("dataset_repo", repo)).collect());
  add("stagePrefills", await ctx.db.query("stagePrefills").withIndex("by_repo", (q) => q.eq("dataset_repo", repo)).collect());
  add("stageReviews", await ctx.db.query("stageReviews").withIndex("by_repo", (q) => q.eq("dataset_repo", repo)).collect());
  const sessions = (await ctx.db.query("evalSessions").collect()).filter((s) => s.dataset_repo === repo);
  for (const session of sessions) {
    add("roundResults", await ctx.db.query("roundResults").withIndex("by_session", (q) => q.eq("session_id", session._id)).collect());
  }
  return { rows, sessionIds: sessions.map((s) => s._id) };
}

export const plan = internalQuery({
  args: spliceArgs,
  handler: async (ctx, args) => {
    const { rows, sessionIds } = await collectRows(ctx, args.dataset_repo);
    const p = planSplice(rows, args.total_before, args.drop);
    return {
      fingerprint: p.fingerprint,
      sessions: sessionIds,
      by_table: summarizePlan(p),
      unchanged: p.unchanged,
      deletes: p.deletes,
    };
  },
});

export const apply = internalMutation({
  args: { ...spliceArgs, expected_fingerprint: v.string() },
  handler: async (ctx, args) => {
    const { rows, sessionIds } = await collectRows(ctx, args.dataset_repo);
    const p = planSplice(rows, args.total_before, args.drop);
    if (p.fingerprint !== args.expected_fingerprint) {
      throw new Error(
        `row set changed since the plan (fingerprint ${p.fingerprint} != expected ` +
          `${args.expected_fingerprint}); re-run episodeSplice:plan -- was the splice already applied?`
      );
    }
    // An apply job in flight would merge pre-splice progress with renumbered rows.
    const inFlight = (await ctx.db.query("applyJobs").withIndex("by_repo", (q) => q.eq("dataset_repo", args.dataset_repo)).collect())
      .filter((job) => job.status === "pending" || job.status === "applying");
    if (inFlight.length) {
      throw new Error(`${args.dataset_repo} has ${inFlight.length} apply job(s) pending/applying; wait for them before splicing`);
    }
    for (const row of p.deletes) {
      await ctx.db.delete(row.id as Id<TableNames>);
    }
    for (const row of p.patches) {
      await ctx.db.patch(row.id as Id<SplicedTable>, { episode_index: BigInt(row.new_episode_index) });
    }
    return { sessions: sessionIds, by_table: summarizePlan(p), unchanged: p.unchanged };
  },
});
