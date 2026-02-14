import { query } from "./_generated/server";
import { v } from "convex/values";

export const getOpponents = query({
  args: { num_opponents: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const numOpponents = args.num_opponents ?? 2;
    const policies = await ctx.db.query("policies").collect();

    if (policies.length === 0) return [];
    if (policies.length <= numOpponents) {
      return policies.map((p) => ({
        wandb_artifact: p.wandb_artifact,
        name: p.name,
        elo: p.elo,
      }));
    }

    const sorted = [...policies].sort((a, b) => b.elo - a.elo);
    const thirdSize = Math.max(1, Math.floor(sorted.length / 3));

    const topThird = sorted.slice(0, thirdSize);
    const bottomThird = sorted.slice(-thirdSize);

    const picks: typeof sorted = [];

    // Pick from top third
    const topPick = topThird[Math.floor(Math.random() * topThird.length)];
    picks.push(topPick);

    // Pick from bottom third (avoid duplicates)
    const bottomCandidates = bottomThird.filter(
      (p) => p._id !== topPick._id
    );
    if (bottomCandidates.length > 0) {
      picks.push(
        bottomCandidates[Math.floor(Math.random() * bottomCandidates.length)]
      );
    }

    // If we need more, pick from middle
    if (picks.length < numOpponents) {
      const middleThird = sorted.slice(thirdSize, -thirdSize);
      const remaining = middleThird.filter(
        (p) => !picks.some((pick) => pick._id === p._id)
      );
      while (picks.length < numOpponents && remaining.length > 0) {
        const idx = Math.floor(Math.random() * remaining.length);
        picks.push(remaining.splice(idx, 1)[0]);
      }
    }

    return picks.slice(0, numOpponents).map((p) => ({
      wandb_artifact: p.wandb_artifact,
      name: p.name,
      elo: p.elo,
    }));
  },
});
