import { query, mutation, internalMutation } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireEditorOrService } from "./access";
import { statusValidator } from "./statusShared";

export async function loadTaskStatusMap(
  ctx: QueryCtx
): Promise<Map<string, Doc<"taskStatuses">>> {
  const rows = await ctx.db.query("taskStatuses").collect();
  return new Map(rows.map((r) => [r.task, r]));
}

export const listTaskStatuses = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("taskStatuses").collect();
    return rows.sort((a, b) => a.task.localeCompare(b.task));
  },
});

/**
 * Declarative upsert of a task's status row: omitted reason/superseded_by
 * CLEAR those fields (callers editing one field pass the others through).
 */
export const setTaskStatus = mutation({
  args: {
    task: v.string(),
    status: statusValidator,
    reason: v.optional(v.string()),
    superseded_by: v.optional(v.string()),
    serviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const principal = await requireEditorOrService(ctx, args.serviceToken);
    const fields = {
      status: args.status,
      reason: args.reason,
      superseded_by: args.superseded_by,
      updated_at: Date.now(),
      updated_by: principal,
    };
    const existing = await ctx.db
      .query("taskStatuses")
      .withIndex("by_task", (q) => q.eq("task", args.task))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("taskStatuses", { task: args.task, ...fields });
  },
});

// Idempotent seed (run via `npx convex run statuses:seedDefaults`): every task
// string observed in policies/datasets gets a taskStatuses row (mainline set
// below, everything else retired). Ran 2026-08-20; it also folded the legacy
// evalSessions.excluded/exclusion_reason pair into status fields (that code is
// gone now that the schema dropped those fields).
const SEED_MAINLINE = ["marker_d2", "square_d2", "routing_d1"];
const SEED_SUPERSEDED_BY: Record<string, string> = {
  insert_marker_d1_v0: "insert_marker_d1",
  insert_marker_single_v0: "insert_marker_single",
};

export const seedDefaults = internalMutation({
  args: {},
  handler: async (ctx) => {
    const policies = await ctx.db.query("policies").collect();
    const datasets = await ctx.db.query("datasets").collect();
    const tasks = new Set<string>([
      ...SEED_MAINLINE,
      ...policies.map((p) => p.environment),
      ...datasets.map((d) => d.task),
    ]);

    const existing = await loadTaskStatusMap(ctx);
    let inserted = 0;
    for (const task of [...tasks].sort()) {
      if (existing.has(task)) continue;
      const mainline = SEED_MAINLINE.includes(task);
      await ctx.db.insert("taskStatuses", {
        task,
        status: mainline ? "mainline" : "retired",
        reason: mainline
          ? undefined
          : "Seeded retired 2026-08-20 (not in mainline set)",
        superseded_by: SEED_SUPERSEDED_BY[task],
        updated_at: Date.now(),
        updated_by: "seedDefaults",
      });
      inserted++;
    }

    return { taskStatusesInserted: inserted };
  },
});
