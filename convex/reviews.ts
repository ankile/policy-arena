import { query, mutation, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireEditor, requireEditorOrService } from "./access";

export const episodeNotes = query({
  args: { dataset_repo: v.string(), episode_index: v.int64() },
  handler: async (ctx, args) => await ctx.db
    .query("episodeNotes")
    .withIndex("by_repo_episode", (q) =>
      q.eq("dataset_repo", args.dataset_repo).eq("episode_index", args.episode_index)
    )
    .unique(),
});

/** Reusable notes from other episodes across datasets for the same task. */
export const noteSuggestions = query({
  args: { dataset_repo: v.string(), episode_index: v.int64() },
  handler: async (ctx, args) => {
    const dataset = await ctx.db.query("datasets")
      .withIndex("by_repo", (q) => q.eq("repo_id", args.dataset_repo)).unique();
    if (!dataset || !dataset.task.trim()) return { recent: [], mostUsed: [] };
    const datasets = await ctx.db.query("datasets")
      .withIndex("by_task", (q) => q.eq("task", dataset.task)).collect();
    const groups = await Promise.all(datasets.map((row) => ctx.db.query("episodeNotes")
      .withIndex("by_repo_episode", (q) => q.eq("dataset_repo", row.repo_id)).collect()));
    const counts = new Map<string, { notes: string; count: number; lastUsed: number }>();
    for (const row of groups.flat()) {
      if (row.dataset_repo === args.dataset_repo && row.episode_index === args.episode_index) continue;
      const notes = row.notes.trim();
      if (!notes) continue;
      const previous = counts.get(notes);
      counts.set(notes, {
        notes,
        count: (previous?.count ?? 0) + 1,
        lastUsed: Math.max(previous?.lastUsed ?? 0, row.updated_at),
      });
    }
    const suggestions = [...counts.values()];
    const byRecent = (a: typeof suggestions[number], b: typeof suggestions[number]) =>
      b.lastUsed - a.lastUsed || a.notes.localeCompare(b.notes);
    return {
      recent: [...suggestions].sort(byRecent).slice(0, 6),
      mostUsed: suggestions.sort((a, b) => b.count - a.count || byRecent(a, b)).slice(0, 6),
    };
  },
});

export const saveNotes = mutation({
  args: { dataset_repo: v.string(), episode_index: v.int64(), notes: v.string() },
  handler: async (ctx, args) => {
    const editor = await requireEditor(ctx);
    if (args.episode_index < BigInt(0)) throw new Error("Episode index must be non-negative");
    const previous = await ctx.db
      .query("episodeNotes")
      .withIndex("by_repo_episode", (q) =>
        q.eq("dataset_repo", args.dataset_repo).eq("episode_index", args.episode_index)
      )
      .unique();
    const fields = { ...args, updated_by: editor, updated_at: Date.now() };
    if (previous) await ctx.db.patch(previous._id, fields);
    else await ctx.db.insert("episodeNotes", fields);
  },
});

const OUTCOMES = ["success", "failure", "timeout"] as const;
const STATUSES = ["confirmed", "skipped", "cleared"] as const;

/**
 * Outcome reviews are APPEND-ONLY: every save inserts a row, and readers fold
 * to the latest row per (dataset_repo, episode_index). This preserves a full
 * audit trail; the applied record of truth on HF remains
 * `.outcome_edit_progress.json`, materialized by the Python apply worker.
 *
 * Record semantics mirror sir/tools/outcome_editor.py exactly:
 *  - confirmed: {new_outcome, outcome_frame, soft_truncate, subtask_frames?}
 *    (subtask_frames key present ⇔ reviewed in subtask mode, may be empty)
 *  - skipped: reviewed, no change
 *  - cleared: undo a previous review (episode returns to unreviewed)
 */
export const save = mutation({
  args: {
    serviceToken: v.optional(v.string()),
    dataset_repo: v.string(),
    episode_index: v.int64(),
    status: v.string(),
    new_outcome: v.optional(v.string()),
    outcome_frame: v.optional(v.int64()),
    soft_truncate: v.optional(v.boolean()),
    subtask_frames: v.optional(v.array(v.int64())),
    // Attribution override for scripted backfills of historical cv2-era
    // records (service principal only; humans are attributed from auth).
    reviewer_override: v.optional(v.string()),
    // The script/rule that produced a scripted review (service principal
    // only); becomes the label-history source.tool on apply.
    source_tool: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const principal = await requireEditorOrService(ctx, args.serviceToken);
    if (!(STATUSES as readonly string[]).includes(args.status)) {
      throw new Error(`Invalid review status: ${args.status}`);
    }
    if (args.status === "confirmed") {
      if (
        args.new_outcome === undefined ||
        !(OUTCOMES as readonly string[]).includes(args.new_outcome)
      ) {
        throw new Error(
          `Confirmed review requires new_outcome in ${OUTCOMES.join("/")}, got ${args.new_outcome}`
        );
      }
      if (args.outcome_frame === undefined || args.outcome_frame < BigInt(0)) {
        throw new Error("Confirmed review requires a non-negative outcome_frame");
      }
    } else {
      if (
        args.new_outcome !== undefined ||
        args.outcome_frame !== undefined ||
        args.subtask_frames !== undefined
      ) {
        throw new Error(`A ${args.status} review must not carry outcome fields`);
      }
    }
    if (args.status === "cleared") {
      // Clearing an ALREADY-APPLIED decision is a trap: the HF edit stays in
      // place, the episode folds out of latestForRepo, and the next apply
      // would re-record lower counts that satisfy the freshness gate over an
      // un-reverted dataset. Applied decisions are corrected by RE-REVIEWING.
      const latest = await ctx.db
        .query("outcomeReviews")
        .withIndex("by_repo_episode", (q) =>
          q.eq("dataset_repo", args.dataset_repo).eq("episode_index", args.episode_index)
        )
        .collect();
      const newest = latest
        .filter((row) => row.status !== "cleared")
        .sort((a, b) => b.saved_at - a.saved_at)[0];
      if (newest !== undefined) {
        const jobs = await ctx.db
          .query("applyJobs")
          .withIndex("by_repo", (q) => q.eq("dataset_repo", args.dataset_repo))
          .collect();
        const appliedAfter = jobs.some(
          (job) =>
            job.status === "applied" &&
            job.started_at !== undefined &&
            job.started_at >= newest.saved_at
        );
        if (appliedAfter) {
          throw new Error(
            "This decision was already applied to HuggingFace — clearing cannot " +
              "revert it. Re-review the episode (confirm the corrected outcome) " +
              "and commit again instead."
          );
        }
      }
    }
    let reviewer: string;
    if (principal === "service") {
      reviewer = args.reviewer_override ?? "service";
      if (args.source_tool !== undefined && !args.source_tool.trim()) {
        throw new Error("source_tool must be a non-empty string");
      }
    } else {
      if (args.reviewer_override !== undefined) {
        throw new Error("reviewer_override is reserved for the service principal");
      }
      if (args.source_tool !== undefined) {
        throw new Error("source_tool is reserved for the service principal");
      }
      reviewer = principal;
    }
    const userId = await getAuthUserId(ctx);
    return await ctx.db.insert("outcomeReviews", {
      dataset_repo: args.dataset_repo,
      episode_index: args.episode_index,
      status: args.status,
      new_outcome: args.new_outcome,
      outcome_frame: args.outcome_frame,
      soft_truncate: args.status === "confirmed" ? (args.soft_truncate ?? false) : undefined,
      subtask_frames: args.subtask_frames,
      reviewer,
      reviewer_user_id: userId ?? undefined,
      source_tool: args.source_tool,
      saved_at: Date.now(),
    });
  },
});

/** Latest review per episode for a repo (cleared rows fold to "no review"). */
export const latestForRepo = query({
  args: { dataset_repo: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("outcomeReviews")
      .withIndex("by_repo", (q) => q.eq("dataset_repo", args.dataset_repo))
      .collect();
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      // _creationTime is monotonically assigned; later insert wins.
      const key = row.episode_index.toString();
      const prev = latest.get(key);
      if (!prev || row._creationTime > prev._creationTime) latest.set(key, row);
    }
    const episodes = [...latest.values()]
      .filter((row) => row.status !== "cleared")
      .sort((a, b) => Number(a.episode_index - b.episode_index));
    return {
      episodes,
      num_confirmed: episodes.filter((e) => e.status === "confirmed").length,
      num_skipped: episodes.filter((e) => e.status === "skipped").length,
    };
  },
});

/** The newest row for an episode, cleared rows included (latestForRepo's fold). */
async function newestEpisodeRow(
  ctx: MutationCtx,
  datasetRepo: string,
  episodeIndex: bigint
): Promise<Doc<"outcomeReviews">> {
  const rows = await ctx.db
    .query("outcomeReviews")
    .withIndex("by_repo_episode", (q) =>
      q.eq("dataset_repo", datasetRepo).eq("episode_index", episodeIndex)
    )
    .collect();
  if (rows.length === 0) throw new Error(`No reviews for ${datasetRepo} episode ${episodeIndex}`);
  return rows.reduce((a, b) => (b._creationTime > a._creationTime ? b : a));
}

/**
 * Write the outcome_frame an apply actually committed to HF back onto the
 * review row it applied, keeping the reviewer's raw frame in
 * submitted_outcome_frame. Apply normalization only ever moves a mark on the
 * terminal is_valid=0 padding frame back to the last valid frame, so the
 * applied frame must be strictly earlier. A row that is no longer the newest
 * for its episode (a review saved while the apply ran) is left alone: the next
 * apply normalizes the newer row.
 */
export const recordAppliedOutcomeFrames = internalMutation({
  args: {
    dataset_repo: v.string(),
    applied: v.array(
      v.object({ review_id: v.id("outcomeReviews"), outcome_frame: v.int64() })
    ),
  },
  handler: async (ctx, args) => {
    let patched = 0;
    const superseded: bigint[] = [];
    for (const { review_id, outcome_frame } of args.applied) {
      const row = await ctx.db.get(review_id);
      if (row === null) throw new Error(`Review ${review_id} not found`);
      const where = `${args.dataset_repo} episode ${row.episode_index} (review ${review_id})`;
      if (row.dataset_repo !== args.dataset_repo) {
        throw new Error(`Review ${review_id} belongs to ${row.dataset_repo}, not ${args.dataset_repo}`);
      }
      if (row.status !== "confirmed" || row.outcome_frame === undefined) {
        throw new Error(`${where}: only confirmed reviews carry an outcome_frame`);
      }
      if (row.submitted_outcome_frame !== undefined) {
        throw new Error(
          `${where}: already normalized once (submitted ${row.submitted_outcome_frame}, ` +
            `applied ${row.outcome_frame}); a second differing frame ${outcome_frame} means ` +
            "the apply normalization is not idempotent"
        );
      }
      if (outcome_frame >= row.outcome_frame) {
        throw new Error(
          `${where}: applied frame ${outcome_frame} is not earlier than the submitted ` +
            `frame ${row.outcome_frame}; normalization only snaps terminal padding back`
        );
      }
      const newest = await newestEpisodeRow(ctx, row.dataset_repo, row.episode_index);
      if (newest._id !== row._id) {
        superseded.push(row.episode_index);
        continue;
      }
      await ctx.db.patch(review_id, {
        outcome_frame,
        submitted_outcome_frame: row.outcome_frame,
      });
      patched += 1;
    }
    return { patched, superseded };
  },
});

/**
 * Re-attribute scripted reviews saved under a placeholder reviewer string.
 * The episode list is explicit and must match the reviewer's rows exactly.
 */
export const reattributeScriptedReviews = internalMutation({
  args: {
    dataset_repo: v.string(),
    from_reviewer: v.string(),
    reviewer: v.string(),
    source_tool: v.string(),
    episode_indices: v.array(v.int64()),
  },
  handler: async (ctx, args) => {
    if (!args.reviewer.trim() || !args.source_tool.trim()) {
      throw new Error("reviewer and source_tool must be non-empty");
    }
    const rows = (
      await ctx.db
        .query("outcomeReviews")
        .withIndex("by_repo", (q) => q.eq("dataset_repo", args.dataset_repo))
        .collect()
    ).filter((row) => row.reviewer === args.from_reviewer);
    const expected = [...new Set(args.episode_indices.map(String))].sort();
    const found = rows.map((row) => String(row.episode_index)).sort();
    if (expected.length !== args.episode_indices.length) {
      throw new Error("episode_indices contains duplicates");
    }
    if (found.length !== expected.length || found.some((ep, i) => ep !== expected[i])) {
      throw new Error(
        `Rows by ${args.from_reviewer} on ${args.dataset_repo} cover episodes [${found}], ` +
          `expected exactly [${expected}]`
      );
    }
    for (const row of rows) {
      if (row.source_tool !== undefined) {
        throw new Error(`Review ${row._id} already carries source_tool ${row.source_tool}`);
      }
      await ctx.db.patch(row._id, { reviewer: args.reviewer, source_tool: args.source_tool });
    }
    return rows.length;
  },
});

/** Every dataset repo with at least one outcome review row (audit surface). */
export const reviewedRepos = query({
  args: {},
  handler: async (ctx) => {
    const repos = new Set<string>();
    for await (const row of ctx.db.query("outcomeReviews")) repos.add(row.dataset_repo);
    return [...repos].sort();
  },
});

/** Full append-only history for one episode (audit surface). */
export const historyForEpisode = query({
  args: { dataset_repo: v.string(), episode_index: v.int64() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("outcomeReviews")
      .withIndex("by_repo_episode", (q) =>
        q.eq("dataset_repo", args.dataset_repo).eq("episode_index", args.episode_index)
      )
      .collect();
  },
});
