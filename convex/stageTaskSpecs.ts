import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireEditorOrService } from "./access";

/**
 * Stage-label task specs are EXPORTED DATA: the Python stage-labeling registry
 * (sir/real/stage_labeling/tasks.py StageLabelTaskSpec, serialized by
 * sir/real/stage_labeling/spec_export.py) is the single source of truth. Rows
 * are keyed (task, taxonomy_version) so a live taxonomy and a candidate one
 * (a proposed stage split under evaluation) coexist; exactly one version per
 * task carries `live: true`. The UI renders the stage-review form and its
 * instant consistency feedback from `spec`; Python re-validates every saved
 * label authoritatively at gold consolidation, so a stale row here can only
 * mis-guide the UI, never mint a bad gold label.
 */

// Keys the UI's spec normalizer requires. Python's exporter self-checks the
// full shape; this guards against a partial/foreign payload reaching the UI.
const REQUIRED_SPEC_KEYS = [
  "task",
  "lifecycle_task",
  "taxonomy_version",
  "taxonomy_hash",
  "released_field",
  "ladder",
  "failure_modes",
  "final_states",
  "success_final_state",
  "stage_field",
  "final_state_field",
  "failure_mode_field",
  "event_fields",
  "bool_fields",
  "time_fields",
  "editable_fields",
  "constraints",
  "fps",
] as const;

export const upsert = mutation({
  args: {
    serviceToken: v.optional(v.string()),
    task: v.string(),
    taxonomy_version: v.string(),
    taxonomy_hash: v.string(),
    live: v.boolean(),
    spec: v.any(),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const principal = await requireEditorOrService(ctx, args.serviceToken);
    if (principal !== "service") {
      throw new Error(
        "Stage task specs are exported by the Python registry (service principal) only"
      );
    }
    if (typeof args.spec !== "object" || args.spec === null || Array.isArray(args.spec)) {
      throw new Error("spec payload must be a serialized stage-spec object");
    }
    const spec = args.spec as Record<string, unknown>;
    for (const key of REQUIRED_SPEC_KEYS) {
      if (!(key in spec)) {
        throw new Error(`spec payload missing required key "${key}"`);
      }
    }
    if (
      spec.task !== args.task ||
      spec.taxonomy_version !== args.taxonomy_version ||
      spec.taxonomy_hash !== args.taxonomy_hash
    ) {
      throw new Error(
        "spec payload task/taxonomy_version/taxonomy_hash must match the row keys"
      );
    }
    const existing = await ctx.db
      .query("stageTaskSpecs")
      .withIndex("by_task_version", (q) =>
        q.eq("task", args.task).eq("taxonomy_version", args.taxonomy_version)
      )
      .unique();
    // A version's vocabulary is immutable ONCE LABELS REFERENCE IT: a hash
    // change on re-upsert is allowed only while no live committed review row
    // exists under this (task, taxonomy_version) — day-0 fingerprint-formula
    // changes stay possible, but repointing a version that already has stored
    // human labels is refused (bump the version instead).
    if (existing && existing.taxonomy_hash !== args.taxonomy_hash) {
      const reviewRows = (
        await ctx.db
          .query("stageReviews")
          .withIndex("by_task", (q) => q.eq("task", args.task))
          .collect()
      ).filter((r) => r.taxonomy_version === args.taxonomy_version);
      const latest = new Map<string, (typeof reviewRows)[number]>();
      for (const row of reviewRows) {
        const key = `${row.episode_index}|${row.reviewer_user_id ?? `svc:${row.reviewer}`}`;
        const prev = latest.get(key);
        const newer =
          prev === undefined ||
          row.saved_at > prev.saved_at ||
          (row.saved_at === prev.saved_at && row._creationTime > prev._creationTime);
        if (newer) latest.set(key, row);
      }
      const committed = [...latest.values()].filter(
        (r) => r.status === "confirmed" || r.status === "corrected"
      );
      if (committed.length > 0) {
        throw new Error(
          `taxonomy_hash changed for ${args.task}@${args.taxonomy_version} ` +
            `(${existing.taxonomy_hash} -> ${args.taxonomy_hash}) but ` +
            `${committed.length} committed review(s) reference this version; ` +
            "bump the taxonomy_version instead of mutating a referenced vocabulary"
        );
      }
    }
    const siblings = await ctx.db
      .query("stageTaskSpecs")
      .withIndex("by_task", (q) => q.eq("task", args.task))
      .collect();
    if (args.live) {
      for (const sib of siblings) {
        if (sib._id !== existing?._id && sib.live) {
          await ctx.db.patch(sib._id, { live: false });
        }
      }
    } else if (existing?.live) {
      // Demoting the ONLY live version would strand the task with no live
      // spec (the review UI's entry point) — a candidate export must carry a
      // NEW taxonomy_version, not repurpose the live one.
      const otherLive = siblings.some((sib) => sib._id !== existing._id && sib.live);
      if (!otherLive) {
        throw new Error(
          `${args.task}@${args.taxonomy_version} is the only LIVE version; ` +
            "exporting it as a candidate (live=false) would leave the task " +
            "with no live spec. Export the candidate under a new taxonomy_version."
        );
      }
    }
    const row = {
      task: args.task,
      taxonomy_version: args.taxonomy_version,
      taxonomy_hash: args.taxonomy_hash,
      live: args.live,
      spec: args.spec,
      exported_at: Date.now(),
      source: args.source,
    };
    if (existing) {
      await ctx.db.replace(existing._id, row);
      return existing._id;
    }
    return await ctx.db.insert("stageTaskSpecs", row);
  },
});

/** Every exported taxonomy version for a task (live + candidates). */
export const forTask = query({
  args: { task: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("stageTaskSpecs")
      .withIndex("by_task", (q) => q.eq("task", args.task))
      .collect();
  },
});

/** The single live taxonomy version for a task, or null when none exists. */
export const liveForTask = query({
  args: { task: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("stageTaskSpecs")
      .withIndex("by_task", (q) => q.eq("task", args.task))
      .collect();
    const live = rows.filter((r) => r.live);
    if (live.length > 1) {
      throw new Error(
        `multiple live stage specs for ${args.task}: ` +
          live.map((r) => r.taxonomy_version).join(", ")
      );
    }
    return live[0] ?? null;
  },
});

export const all = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("stageTaskSpecs").collect();
  },
});
