import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireEditorOrService } from "./access";
import { loadTaskStatusMap } from "./statuses";
import { effectiveStatus, statusOrInheritValidator } from "./statusShared";

// Legacy string-list variant — the deployed frontend calls this until the
// environmentsDetailed cutover ships; remove once Vercel is redeployed.
export const environments = query({
  handler: async (ctx) => {
    const policies = await ctx.db.query("policies").collect();
    return [...new Set(policies.map((p) => p.environment))].sort();
  },
});

export const environmentsDetailed = query({
  args: {},
  handler: async (ctx) => {
    const policies = await ctx.db.query("policies").collect();
    const taskStatuses = await loadTaskStatusMap(ctx);
    return [...new Set(policies.map((p) => p.environment))].sort().map(
      (environment) => ({
        environment,
        status: effectiveStatus(undefined, environment, taskStatuses),
      })
    );
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
    const taskStatuses = await loadTaskStatusMap(ctx);

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

        return {
          ...policy,
          effective_status: effectiveStatus(
            policy.status,
            policy.environment,
            taskStatuses
          ),
          successRate,
          avgSuccessSteps,
          totalRollouts: total,
          totalSuccesses: successes,
        };
      })
    );

    return enriched.sort((a, b) => b.elo - a.elo);
  },
});

export const listNames = query({
  handler: async (ctx) => {
    const policies = await ctx.db.query("policies").collect();
    const taskStatuses = await loadTaskStatusMap(ctx);
    return policies.map((p) => ({
      _id: p._id,
      name: p.name,
      environment: p.environment,
      effective_status: effectiveStatus(p.status, p.environment, taskStatuses),
    }));
  },
});

export const get = query({
  args: { id: v.id("policies") },
  handler: async (ctx, args) => {
    const policy = await ctx.db.get(args.id);
    if (!policy) return null;
    const taskStatuses = await loadTaskStatusMap(ctx);
    return {
      ...policy,
      effective_status: effectiveStatus(
        policy.status,
        policy.environment,
        taskStatuses
      ),
    };
  },
});

export const setStatus = mutation({
  args: {
    model_id: v.string(),
    status: statusOrInheritValidator,
    status_reason: v.optional(v.string()),
    serviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireEditorOrService(ctx, args.serviceToken);
    const policy = await ctx.db
      .query("policies")
      .withIndex("by_model_id", (q) => q.eq("model_id", args.model_id))
      .unique();
    if (!policy) {
      throw new Error(`Policy not found: ${args.model_id}`);
    }
    await ctx.db.patch(policy._id, {
      status: args.status === "inherit" ? undefined : args.status,
      status_reason: args.status === "inherit" ? undefined : args.status_reason,
    });
    return policy._id;
  },
});

export const getByModelId = query({
  args: { model_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("policies")
      .withIndex("by_model_id", (q) => q.eq("model_id", args.model_id))
      .unique();
  },
});

export const updateEnvironment = mutation({
  args: {
    model_id: v.string(),
    environment: v.string(),
    serviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireEditorOrService(ctx, args.serviceToken);
    const policy = await ctx.db
      .query("policies")
      .withIndex("by_model_id", (q) => q.eq("model_id", args.model_id))
      .unique();
    if (!policy) {
      throw new Error(`Policy not found: ${args.model_id}`);
    }
    await ctx.db.patch(policy._id, { environment: args.environment });
    return policy._id;
  },
});

export const deletePolicy = mutation({
  args: { model_id: v.string(), serviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireEditorOrService(ctx, args.serviceToken);
    const policy = await ctx.db
      .query("policies")
      .withIndex("by_model_id", (q) => q.eq("model_id", args.model_id))
      .unique();
    if (!policy) throw new Error(`Policy not found: ${args.model_id}`);

    // Verify no round results reference this policy
    const results = await ctx.db
      .query("roundResults")
      .withIndex("by_policy", (q) => q.eq("policy_id", policy._id))
      .collect();
    if (results.length > 0) {
      throw new Error(
        `Cannot delete policy with ${results.length} round results. ` +
        `Remove it from all sessions first.`
      );
    }

    // Delete any ELO history entries
    const eloHistory = await ctx.db
      .query("eloHistory")
      .withIndex("by_policy", (q) => q.eq("policy_id", policy._id))
      .collect();
    for (const e of eloHistory) {
      await ctx.db.delete(e._id);
    }

    await ctx.db.delete(policy._id);
    return { deleted: policy._id, model_id: args.model_id };
  },
});

export const register = mutation({
  args: {
    name: v.string(),
    model_id: v.string(),
    model_url: v.optional(v.string()),
    training_url: v.optional(v.string()),
    environment: v.string(),
    serviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireEditorOrService(ctx, args.serviceToken);
    const existing = await ctx.db
      .query("policies")
      .withIndex("by_model_id", (q) => q.eq("model_id", args.model_id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        model_url: args.model_url,
        training_url: args.training_url,
        environment: args.environment,
      });
      return existing._id;
    }

    return await ctx.db.insert("policies", {
      name: args.name,
      model_id: args.model_id,
      model_url: args.model_url,
      training_url: args.training_url,
      environment: args.environment,
      elo: 1500,
      wins: BigInt(0),
      losses: BigInt(0),
      draws: BigInt(0),
    });
  },
});
