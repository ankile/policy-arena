import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const environments = query({
  handler: async (ctx) => {
    const policies = await ctx.db.query("policies").collect();
    return [...new Set(policies.map((p) => p.environment))].sort();
  },
});

export const leaderboard = query({
  args: { environment: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let policies;
    if (args.environment) {
      policies = await ctx.db
        .query("policies")
        .withIndex("by_environment", (q) => q.eq("environment", args.environment!))
        .collect();
    } else {
      policies = await ctx.db.query("policies").collect();
    }

    const enriched = await Promise.all(
      policies.map(async (policy) => {
        const results = await ctx.db
          .query("roundResults")
          .withIndex("by_policy", (q) => q.eq("policy_id", policy._id))
          .collect();

        const total = results.length;
        const successes = results.filter((r) => r.success).length;
        const successRate = total > 0 ? successes / total : null;

        const successfulWithFrames = results.filter(
          (r) => r.success && r.num_frames != null
        );
        const avgSuccessSteps =
          successfulWithFrames.length > 0
            ? Math.round(
                successfulWithFrames.reduce(
                  (sum, r) => sum + Number(r.num_frames!),
                  0
                ) / successfulWithFrames.length
              )
            : null;

        return { ...policy, successRate, avgSuccessSteps };
      })
    );

    return enriched.sort((a, b) => b.elo - a.elo);
  },
});

export const get = query({
  args: { id: v.id("policies") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByArtifact = query({
  args: { wandb_artifact: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("policies")
      .withIndex("by_artifact", (q) => q.eq("wandb_artifact", args.wandb_artifact))
      .unique();
  },
});

export const register = mutation({
  args: {
    name: v.string(),
    wandb_artifact: v.string(),
    wandb_run_url: v.optional(v.string()),
    environment: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("policies")
      .withIndex("by_artifact", (q) => q.eq("wandb_artifact", args.wandb_artifact))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        wandb_run_url: args.wandb_run_url,
        environment: args.environment,
      });
      return existing._id;
    }

    return await ctx.db.insert("policies", {
      name: args.name,
      wandb_artifact: args.wandb_artifact,
      wandb_run_url: args.wandb_run_url,
      environment: args.environment,
      elo: 1500,
      wins: BigInt(0),
      losses: BigInt(0),
      draws: BigInt(0),
    });
  },
});
