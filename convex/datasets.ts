import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const register = mutation({
  args: {
    repo_id: v.string(),
    name: v.string(),
    task: v.string(),
    source_type: v.string(),
    environment: v.string(),
    num_episodes: v.optional(v.int64()),
    wandb_artifact: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("datasets")
      .withIndex("by_repo", (q) => q.eq("repo_id", args.repo_id))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args });
      return existing._id;
    }
    return await ctx.db.insert("datasets", args);
  },
});

export const updateStats = mutation({
  args: {
    repo_id: v.string(),
    num_episodes: v.number(),
    total_duration_seconds: v.number(),
  },
  handler: async (ctx, args) => {
    const dataset = await ctx.db
      .query("datasets")
      .withIndex("by_repo", (q) => q.eq("repo_id", args.repo_id))
      .unique();
    if (!dataset) return;
    const count = BigInt(args.num_episodes);
    const patch: Record<string, unknown> = {};
    if (dataset.num_episodes !== count) patch.num_episodes = count;
    if (dataset.total_duration_seconds !== args.total_duration_seconds)
      patch.total_duration_seconds = args.total_duration_seconds;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(dataset._id, patch);
    }
  },
});

export const deleteByRepo = mutation({
  args: { repo_id: v.string() },
  handler: async (ctx, args) => {
    const dataset = await ctx.db
      .query("datasets")
      .withIndex("by_repo", (q) => q.eq("repo_id", args.repo_id))
      .unique();
    if (!dataset) return null;
    await ctx.db.delete(dataset._id);
    return dataset._id;
  },
});

export const list = query({
  args: {
    source_type: v.optional(v.string()),
    task: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let datasets;
    if (args.source_type) {
      datasets = await ctx.db
        .query("datasets")
        .withIndex("by_source_type", (q) =>
          q.eq("source_type", args.source_type!)
        )
        .collect();
    } else {
      datasets = await ctx.db.query("datasets").collect();
    }
    if (args.task) {
      datasets = datasets.filter((d) => d.task === args.task);
    }
    return datasets.sort((a, b) => b._creationTime - a._creationTime);
  },
});
