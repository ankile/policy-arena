import { query } from "./_generated/server";
import { v } from "convex/values";

export const getPairCounts = query({
  args: {
    environment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get policies (optionally filtered by environment)
    let policies;
    if (args.environment) {
      policies = await ctx.db
        .query("policies")
        .withIndex("by_environment", (q) => q.eq("environment", args.environment!))
        .collect();
    } else {
      policies = await ctx.db.query("policies").collect();
    }

    // Build policy_id -> model_id map
    const idToModelId = new Map<string, string>();
    const policyIds = new Set<string>();
    for (const p of policies) {
      idToModelId.set(p._id as string, p.model_id);
      policyIds.add(p._id as string);
    }

    // Collect all round results for these policies, grouped by (session_id, round_index)
    const roundGroups = new Map<string, string[]>(); // "session_id|round_index" -> [model_id, ...]
    for (const p of policies) {
      const results = await ctx.db
        .query("roundResults")
        .withIndex("by_policy", (q) => q.eq("policy_id", p._id))
        .collect();
      for (const r of results) {
        const key = `${r.session_id}|${r.round_index}`;
        const modelId = idToModelId.get(r.policy_id as string);
        if (!modelId) continue;
        if (!roundGroups.has(key)) {
          roundGroups.set(key, []);
        }
        roundGroups.get(key)!.push(modelId);
      }
    }

    // Count pairwise co-occurrences
    const counts: Record<string, Record<string, number>> = {};
    for (const modelIds of roundGroups.values()) {
      // All pairs within this round group
      for (let i = 0; i < modelIds.length; i++) {
        for (let j = i + 1; j < modelIds.length; j++) {
          const a = modelIds[i];
          const b = modelIds[j];
          if (!counts[a]) counts[a] = {};
          if (!counts[b]) counts[b] = {};
          counts[a][b] = (counts[a][b] || 0) + 1;
          counts[b][a] = (counts[b][a] || 0) + 1;
        }
      }
    }

    return counts;
  },
});

export const getOpponents = query({
  args: {
    environment: v.optional(v.string()),
    exclude_model_ids: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    let policies = await ctx.db.query("policies").collect();

    // Filter by environment if specified
    if (args.environment) {
      policies = policies.filter((p) => p.environment === args.environment);
    }

    // Exclude specific model_ids (e.g. the focus policy in calibrate mode)
    if (args.exclude_model_ids) {
      policies = policies.filter(
        (p) => !args.exclude_model_ids!.includes(p.model_id)
      );
    }

    // Return all candidates sorted by ELO (descending).
    // Random sampling is done client-side to avoid deterministic
    // Math.random() in Convex queries.
    const sorted = [...policies].sort((a, b) => b.elo - a.elo);
    return sorted.map((p) => ({
      model_id: p.model_id,
      name: p.name,
      elo: p.elo,
    }));
  },
});
