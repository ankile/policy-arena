import { query } from "./_generated/server";
import { v } from "convex/values";

export const getOpponents = query({
  args: {
    environment: v.optional(v.string()),
    exclude_artifacts: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    let policies = await ctx.db.query("policies").collect();

    // Filter by environment if specified
    if (args.environment) {
      policies = policies.filter((p) => p.environment === args.environment);
    }

    // Exclude specific artifacts (e.g. the focus policy in calibrate mode)
    if (args.exclude_artifacts) {
      policies = policies.filter(
        (p) => !args.exclude_artifacts!.includes(p.wandb_artifact)
      );
    }

    // Return all candidates sorted by ELO (descending).
    // Random sampling is done client-side to avoid deterministic
    // Math.random() in Convex queries.
    const sorted = [...policies].sort((a, b) => b.elo - a.elo);
    return sorted.map((p) => ({
      wandb_artifact: p.wandb_artifact,
      name: p.name,
      elo: p.elo,
    }));
  },
});
