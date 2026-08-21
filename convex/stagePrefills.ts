import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireEditorOrService } from "./access";

/**
 * Stage-label prefills are PIPELINE OUTPUT, not editable state: the sir
 * publisher (sir/tools/publish_stage_prefills.py) pushes a labeling pipeline's
 * final per-episode predictions here so the review UI can prefill the form and
 * show model evidence. One row per (dataset_repo, episode_index,
 * taxonomy_version); a re-publish replaces the row (the publisher itself
 * guards against clobbering a DIFFERENT pipeline's rows without --force, and
 * prediction history is durable in git run dirs + the HF ledger).
 */

const prefillRow = v.object({
  task: v.string(),
  dataset_repo: v.string(),
  episode_index: v.int64(),
  taxonomy_version: v.string(),
  label: v.record(v.string(), v.any()),
  review_reason: v.optional(v.string()),
  violation_codes: v.optional(v.array(v.string())),
  confidence: v.optional(v.string()),
  vote_summary: v.optional(v.any()),
  episode_duration_s: v.optional(v.float64()),
  pipeline: v.object({
    name: v.string(),
    version: v.string(),
    git_commit: v.string(),
  }),
  evidence: v.any(),
});

export const upsertBatch = mutation({
  args: {
    serviceToken: v.optional(v.string()),
    rows: v.array(prefillRow),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const principal = await requireEditorOrService(ctx, args.serviceToken);
    if (principal !== "service") {
      throw new Error(
        "Stage prefills are pushed by the labeling pipeline (service principal) only"
      );
    }
    if (args.rows.length === 0) {
      throw new Error("upsertBatch called with zero rows");
    }
    // Every (task, taxonomy_version) in the batch must reference an exported
    // spec — a prefill under an unexported taxonomy could never be reviewed.
    const specPairs = new Set(
      args.rows.map((r) => JSON.stringify([r.task, r.taxonomy_version]))
    );
    for (const pair of specPairs) {
      const [task, taxonomyVersion] = JSON.parse(pair) as [string, string];
      const spec = await ctx.db
        .query("stageTaskSpecs")
        .withIndex("by_task_version", (q) =>
          q.eq("task", task).eq("taxonomy_version", taxonomyVersion)
        )
        .unique();
      if (spec === null) {
        throw new Error(
          `no stageTaskSpecs row for ${task}@${taxonomyVersion} — export the spec first`
        );
      }
    }
    const pushedAt = Date.now();
    let inserted = 0;
    let replaced = 0;
    for (const row of args.rows) {
      const existing = await ctx.db
        .query("stagePrefills")
        .withIndex("by_repo_episode", (q) =>
          q.eq("dataset_repo", row.dataset_repo).eq("episode_index", row.episode_index)
        )
        .collect();
      const match = existing.find((r) => r.taxonomy_version === row.taxonomy_version);
      const doc = { ...row, pushed_at: pushedAt, source: args.source };
      if (match) {
        await ctx.db.replace(match._id, doc);
        replaced += 1;
      } else {
        await ctx.db.insert("stagePrefills", doc);
        inserted += 1;
      }
    }
    return { inserted, replaced, pushed_at: pushedAt };
  },
});

/**
 * Delete prefills for (dataset_repo, taxonomy_version) whose episode is NOT in
 * `keep_episode_indices` — the publisher calls this once after all upsert
 * chunks so a re-published pipeline run that DROPPED episodes leaves no stale
 * predictions behind ("wholesale replace" across chunked pushes). Limitation
 * (documented in the publisher): a re-publish whose per-row repos no longer
 * cover a previously-pushed repo never prunes that repo.
 */
export const pruneStale = mutation({
  args: {
    serviceToken: v.optional(v.string()),
    dataset_repo: v.string(),
    taxonomy_version: v.string(),
    // Guards cross-task deletion: four tasks share taxonomy "s7_v1", so a
    // repo ever holding two tasks' prefills would otherwise let one line's
    // wholesale-replace silently delete the other's rows.
    task: v.optional(v.string()),
    keep_episode_indices: v.array(v.int64()),
  },
  handler: async (ctx, args) => {
    const principal = await requireEditorOrService(ctx, args.serviceToken);
    if (principal !== "service") {
      throw new Error("Stage prefills are pruned by the labeling pipeline (service) only");
    }
    if (args.keep_episode_indices.length === 0) {
      throw new Error("refusing to prune EVERY prefill — keep_episode_indices is empty");
    }
    const keep = new Set(args.keep_episode_indices.map((e) => e.toString()));
    const rows = await ctx.db
      .query("stagePrefills")
      .withIndex("by_repo", (q) => q.eq("dataset_repo", args.dataset_repo))
      .collect();
    let pruned = 0;
    for (const row of rows) {
      if (row.taxonomy_version !== args.taxonomy_version) continue;
      if (args.task !== undefined && row.task !== args.task) continue;
      if (!keep.has(row.episode_index.toString())) {
        await ctx.db.delete(row._id);
        pruned += 1;
      }
    }
    return { pruned };
  },
});

/** All prefills for a repo (optionally one taxonomy version). */
export const forRepo = query({
  args: {
    dataset_repo: v.string(),
    taxonomy_version: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("stagePrefills")
      .withIndex("by_repo", (q) => q.eq("dataset_repo", args.dataset_repo))
      .collect();
    return args.taxonomy_version === undefined
      ? rows
      : rows.filter((r) => r.taxonomy_version === args.taxonomy_version);
  },
});
