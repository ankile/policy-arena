import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireEditorOrService } from "./access";

/** Frozen pre-versioning predictions. Historical mutations now fail closed.
 * Public reads stay byte-compatible for old consumers and legacy UI selection.
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
    throw new Error(
      "Legacy stage prefills are frozen to preserve prediction history; use stagePredictions begin/appendBatch/publish"
    );
  },
});

/** Retained only to fail loudly for old destructive publishing clients. */
export const pruneStale = mutation({
  args: {
    serviceToken: v.optional(v.string()),
    dataset_repo: v.string(),
    taxonomy_version: v.string(),
    // Keep the historical argument shape so callers receive the migration error.
    task: v.optional(v.string()),
    keep_episode_indices: v.array(v.int64()),
  },
  handler: async (ctx, args) => {
    const principal = await requireEditorOrService(ctx, args.serviceToken);
    if (principal !== "service") {
      throw new Error("Stage prefills are pruned by the labeling pipeline (service) only");
    }
    throw new Error("Legacy stage prefills cannot be pruned; select an immutable prediction run instead");
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
