import { mutation } from "./_generated/server";

export const clearAll = mutation({
  args: {},
  handler: async (ctx) => {
    const tables = [
      "roundResults",
      "eloHistory",
      "evalSessions",
      "policies",
    ] as const;

    let totalDeleted = 0;
    for (const table of tables) {
      const docs = await ctx.db.query(table).collect();
      for (const doc of docs) {
        await ctx.db.delete(doc._id);
      }
      totalDeleted += docs.length;
    }

    return `Cleared ${totalDeleted} documents across ${tables.length} tables`;
  },
});
