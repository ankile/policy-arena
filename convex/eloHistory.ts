import { query } from "./_generated/server";
import { v } from "convex/values";

export const getByPolicy = query({
  args: { policy_id: v.id("policies") },
  handler: async (ctx, args) => {
    const history = await ctx.db
      .query("eloHistory")
      .withIndex("by_policy", (q) => q.eq("policy_id", args.policy_id))
      .collect();

    return Promise.all(
      history.map(async (entry) => {
        const session = await ctx.db.get(entry.session_id);
        return {
          ...entry,
          sessionDatasetRepo: session?.dataset_repo,
        };
      })
    );
  },
});
