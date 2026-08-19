import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireEditorOrService } from "./access";
import { validateStageLabel, type ExportedStageSpec } from "./stageConsistency";

/**
 * Human stage-label reviews are APPEND-ONLY: every save inserts a row; readers
 * fold to the latest row per (dataset_repo, episode_index, taxonomy_version,
 * reviewer). Per-reviewer folding is what makes blinded double-labeling
 * representable — two reviewers each hold a live latest row and disagreement
 * is a query, not a conflict.
 *
 * Status vocabulary matches the cv2 CorrectionUIServer (the incumbent this
 * supersedes), plus draft/cleared:
 *  - confirmed:  the prefill prediction is right as-is
 *  - corrected:  the reviewer edited the label (gold-eligible, like confirmed)
 *  - uncertain:  reviewed but not gold-eligible; violations allowed
 *  - draft:      lossless autosave of in-progress edits; violations allowed
 *  - cleared:    undo — the reviewer's row folds out entirely
 *
 * confirmed/corrected saves are gated by the SAME TS rule interpreter the form
 * uses (stageConsistency.ts, fixture-pinned to the Python oracle); Python
 * re-validates authoritatively at gold consolidation.
 */

const STATUSES = ["confirmed", "corrected", "uncertain", "draft", "cleared"] as const;
const COMMITTED = ["confirmed", "corrected"] as const;

/** Stable per-reviewer fold key: auth user id for humans, name for service backfills. */
function reviewerKey(row: { reviewer: string; reviewer_user_id?: string | null }): string {
  return row.reviewer_user_id ?? `svc:${row.reviewer}`;
}

export const save = mutation({
  args: {
    serviceToken: v.optional(v.string()),
    task: v.string(),
    dataset_repo: v.string(),
    episode_index: v.int64(),
    taxonomy_version: v.string(),
    status: v.string(),
    label: v.optional(v.record(v.string(), v.any())),
    notes: v.optional(v.string()),
    prefill_pushed_at: v.optional(v.float64()),
    blind: v.optional(v.boolean()),
    episode_duration_s: v.optional(v.float64()),
    // Attribution override for scripted replays/backfills of historical
    // human_labels.csv batches (service principal only).
    reviewer_override: v.optional(v.string()),
    // Decision-time override for those same backfills (labeled_at from the
    // CSV); ignored for human saves, which are stamped server-side.
    saved_at_override: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const principal = await requireEditorOrService(ctx, args.serviceToken);
    if (!(STATUSES as readonly string[]).includes(args.status)) {
      throw new Error(`Invalid stage review status: ${args.status}`);
    }
    const specRow = await ctx.db
      .query("stageTaskSpecs")
      .withIndex("by_task_version", (q) =>
        q.eq("task", args.task).eq("taxonomy_version", args.taxonomy_version)
      )
      .unique();
    if (specRow === null) {
      throw new Error(
        `no stageTaskSpecs row for ${args.task}@${args.taxonomy_version} — ` +
          "a review must reference an exported taxonomy version"
      );
    }
    if (args.status === "cleared") {
      if (args.label !== undefined) {
        throw new Error("A cleared review must not carry a label");
      }
    } else {
      if (args.label === undefined) {
        throw new Error(`A ${args.status} review requires the full label row`);
      }
      if ((COMMITTED as readonly string[]).includes(args.status)) {
        const spec = specRow.spec as ExportedStageSpec;
        const violations = validateStageLabel(spec, args.label, args.episode_duration_s);
        if (violations.length > 0) {
          throw new Error(
            `label is internally inconsistent (${violations.length} violation(s)): ` +
              violations.map((viol) => `[${viol.code}] ${viol.message}`).join("; ")
          );
        }
      }
    }
    let reviewer: string;
    if (principal === "service") {
      if (args.reviewer_override === undefined) {
        throw new Error("service saves must carry reviewer_override for attribution");
      }
      reviewer = args.reviewer_override;
    } else {
      if (args.reviewer_override !== undefined || args.saved_at_override !== undefined) {
        throw new Error("reviewer/saved_at overrides are reserved for the service principal");
      }
      reviewer = principal;
    }
    const userId = await getAuthUserId(ctx);
    return await ctx.db.insert("stageReviews", {
      task: args.task,
      dataset_repo: args.dataset_repo,
      episode_index: args.episode_index,
      taxonomy_version: args.taxonomy_version,
      status: args.status,
      label: args.label,
      notes: args.notes,
      prefill_pushed_at: args.prefill_pushed_at,
      blind: args.blind,
      reviewer,
      reviewer_user_id: userId ?? undefined,
      saved_at: principal === "service" ? (args.saved_at_override ?? Date.now()) : Date.now(),
    });
  },
});

/**
 * Latest non-cleared row per (episode_index, taxonomy_version, reviewer), plus
 * summary counts. `taxonomy_version` narrows to one schema when given.
 */
export const latestForRepo = query({
  args: {
    dataset_repo: v.string(),
    taxonomy_version: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let rows = await ctx.db
      .query("stageReviews")
      .withIndex("by_repo", (q) => q.eq("dataset_repo", args.dataset_repo))
      .collect();
    if (args.taxonomy_version !== undefined) {
      rows = rows.filter((r) => r.taxonomy_version === args.taxonomy_version);
    }
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.episode_index}|${row.taxonomy_version}|${reviewerKey(row)}`;
      const prev = latest.get(key);
      if (prev === undefined || row.saved_at > prev.saved_at) {
        latest.set(key, row);
      }
    }
    const folded = [...latest.values()].filter((r) => r.status !== "cleared");
    const count = (status: string) => folded.filter((r) => r.status === status).length;
    return {
      episodes: folded,
      num_confirmed: count("confirmed"),
      num_corrected: count("corrected"),
      num_uncertain: count("uncertain"),
      num_draft: count("draft"),
    };
  },
});

/** Full audit trail for one episode, oldest first. */
export const historyForEpisode = query({
  args: { dataset_repo: v.string(), episode_index: v.int64() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("stageReviews")
      .withIndex("by_repo_episode", (q) =>
        q.eq("dataset_repo", args.dataset_repo).eq("episode_index", args.episode_index)
      )
      .collect();
    return rows.sort((a, b) => a.saved_at - b.saved_at);
  },
});

/**
 * Episodes whose COMMITTED latest rows differ across reviewers on the core
 * triple (stage, failure mode, final state) under one taxonomy version — the
 * blinded-double-labeling disagreement queue.
 */
export const disagreementsForRepo = query({
  args: {
    dataset_repo: v.string(),
    task: v.string(),
    taxonomy_version: v.string(),
  },
  handler: async (ctx, args) => {
    const specRow = await ctx.db
      .query("stageTaskSpecs")
      .withIndex("by_task_version", (q) =>
        q.eq("task", args.task).eq("taxonomy_version", args.taxonomy_version)
      )
      .unique();
    if (specRow === null) {
      throw new Error(`no stageTaskSpecs row for ${args.task}@${args.taxonomy_version}`);
    }
    const spec = specRow.spec as ExportedStageSpec;
    const rows = (
      await ctx.db
        .query("stageReviews")
        .withIndex("by_repo", (q) => q.eq("dataset_repo", args.dataset_repo))
        .collect()
    ).filter((r) => r.taxonomy_version === args.taxonomy_version);
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.episode_index}|${reviewerKey(row)}`;
      const prev = latest.get(key);
      if (prev === undefined || row.saved_at > prev.saved_at) {
        latest.set(key, row);
      }
    }
    const byEpisode = new Map<string, (typeof rows)[number][]>();
    for (const row of latest.values()) {
      if (!(COMMITTED as readonly string[]).includes(row.status)) continue;
      const key = String(row.episode_index);
      byEpisode.set(key, [...(byEpisode.get(key) ?? []), row]);
    }
    const triple = (row: (typeof rows)[number]) => {
      const label = row.label ?? {};
      return JSON.stringify([
        label[spec.stage_field] ?? null,
        label[spec.failure_mode_field] ?? null,
        label[spec.final_state_field] ?? null,
      ]);
    };
    const disagreements = [];
    for (const [episode, reviewRows] of byEpisode) {
      if (reviewRows.length < 2) continue;
      const triples = new Set(reviewRows.map(triple));
      if (triples.size > 1) {
        disagreements.push({ episode_index: Number(episode), reviews: reviewRows });
      }
    }
    return disagreements.sort((a, b) => a.episode_index - b.episode_index);
  },
});
