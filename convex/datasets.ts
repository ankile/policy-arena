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

export const updateEpisodeCount = mutation({
  args: {
    repo_id: v.string(),
    num_episodes: v.int64(),
  },
  handler: async (ctx, args) => {
    const dataset = await ctx.db
      .query("datasets")
      .withIndex("by_repo", (q) => q.eq("repo_id", args.repo_id))
      .unique();
    if (dataset && dataset.num_episodes !== args.num_episodes) {
      await ctx.db.patch(dataset._id, { num_episodes: args.num_episodes });
    }
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
