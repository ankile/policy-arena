import { query } from "./_generated/server";
import { v } from "convex/values";

export const getFailuresByPolicy = query({
  args: { policy_id: v.id("policies") },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("roundResults")
      .withIndex("by_policy", (q) => q.eq("policy_id", args.policy_id))
      .order("desc")
      .collect();

    const failures = results.filter((r) => !r.success).slice(0, 20);

    return Promise.all(
      failures.map(async (r) => {
        const session = await ctx.db.get(r.session_id);
        return {
          session_id: r.session_id,
          dataset_repo: session?.dataset_repo ?? "",
          round_index: Number(r.round_index),
          episode_index: Number(r.episode_index),
          success: r.success,
          num_frames: r.num_frames != null ? Number(r.num_frames) : null,
          session_creation_time: session?._creationTime ?? 0,
        };
      })
    );
  },
});

export const getRecentByPolicy = query({
  args: { policy_id: v.id("policies") },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("roundResults")
      .withIndex("by_policy", (q) => q.eq("policy_id", args.policy_id))
      .order("desc")
      .take(20);

    return Promise.all(
      results.map(async (r) => {
        const session = await ctx.db.get(r.session_id);
        return {
          session_id: r.session_id,
          dataset_repo: session?.dataset_repo ?? "",
          round_index: Number(r.round_index),
          episode_index: Number(r.episode_index),
          success: r.success,
          num_frames: r.num_frames != null ? Number(r.num_frames) : null,
          session_creation_time: session?._creationTime ?? 0,
        };
      })
    );
  },
});
