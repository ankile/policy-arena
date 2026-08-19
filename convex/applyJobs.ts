import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireEditor, requireEditorOrService } from "./access";

/**
 * Apply jobs bridge web-captured outcome reviews to HuggingFace: an editor
 * enqueues a job for a repo; the Python arena_review_worker (service
 * principal) claims it, materializes the progress record, runs the existing
 * outcome_editor apply+push path, and reports back. Status machine:
 * pending → applying → applied | failed; pending → cancelled.
 */

const ACTIVE_STATUSES = ["pending", "applying"];

export const enqueue = mutation({
  args: {
    serviceToken: v.optional(v.string()),
    dataset_repo: v.string(),
    dry_run: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const principal = await requireEditorOrService(ctx, args.serviceToken);
    const existing = await ctx.db
      .query("applyJobs")
      .withIndex("by_repo", (q) => q.eq("dataset_repo", args.dataset_repo))
      .collect();
    const active = existing.find((j) => ACTIVE_STATUSES.includes(j.status));
    if (active) {
      throw new Error(
        `An apply job for ${args.dataset_repo} is already ${active.status}`
      );
    }
    const reviews = await ctx.db
      .query("outcomeReviews")
      .withIndex("by_repo", (q) => q.eq("dataset_repo", args.dataset_repo))
      .collect();
    if (reviews.length === 0) {
      throw new Error(`No outcome reviews recorded for ${args.dataset_repo}`);
    }
    return await ctx.db.insert("applyJobs", {
      dataset_repo: args.dataset_repo,
      status: "pending",
      requested_by: principal,
      requested_at: Date.now(),
      dry_run: args.dry_run ?? false,
    });
  },
});

/** Worker claims the oldest pending job. Returns null when queue is empty. */
export const claim = mutation({
  args: { serviceToken: v.optional(v.string()), worker_id: v.string() },
  handler: async (ctx, args) => {
    const principal = await requireEditorOrService(ctx, args.serviceToken);
    if (principal !== "service") {
      throw new Error("Only the worker (service principal) may claim jobs");
    }
    const pending = await ctx.db
      .query("applyJobs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("asc")
      .first();
    if (!pending) return null;
    await ctx.db.patch(pending._id, {
      status: "applying",
      worker_id: args.worker_id,
      started_at: Date.now(),
    });
    return await ctx.db.get(pending._id);
  },
});

export const finish = mutation({
  args: {
    serviceToken: v.optional(v.string()),
    id: v.id("applyJobs"),
    ok: v.boolean(),
    hf_commit_sha: v.optional(v.string()),
    // Repo sha BEFORE the worker's push — the exact pre-review state, needed
    // because one apply can produce multiple HF commits (data + README card),
    // so parent(hf_commit_sha) is not a reliable pre-state.
    pre_apply_sha: v.optional(v.string()),
    error: v.optional(v.string()),
    log_tail: v.optional(v.string()),
    num_confirmed: v.optional(v.int64()),
    num_skipped: v.optional(v.int64()),
  },
  handler: async (ctx, args) => {
    const principal = await requireEditorOrService(ctx, args.serviceToken);
    if (principal !== "service") {
      throw new Error("Only the worker (service principal) may finish jobs");
    }
    const job = await ctx.db.get(args.id);
    if (!job) throw new Error("Job not found");
    if (job.status !== "applying") {
      throw new Error(`Cannot finish a job in status ${job.status}`);
    }
    if (!args.ok && !args.error) {
      throw new Error("Failed jobs must carry an error message");
    }
    await ctx.db.patch(args.id, {
      status: args.ok ? "applied" : "failed",
      finished_at: Date.now(),
      hf_commit_sha: args.hf_commit_sha,
      pre_apply_sha: args.pre_apply_sha,
      error: args.error,
      log_tail: args.log_tail,
      num_confirmed: args.num_confirmed,
      num_skipped: args.num_skipped,
    });
    return args.id;
  },
});

// An `applying` job whose worker died (laptop sleep mid-apply) would
// otherwise be stuck forever: enqueue rejects while it exists, and the
// freshness gate blocks every ingest for the repo. After this long with no
// finish, the claim is considered abandoned and cancellable.
const STALE_APPLYING_MS = 10 * 60 * 1000;

export const cancel = mutation({
  args: { id: v.id("applyJobs") },
  handler: async (ctx, args) => {
    await requireEditor(ctx);
    const job = await ctx.db.get(args.id);
    if (!job) throw new Error("Job not found");
    const staleApplying =
      job.status === "applying" &&
      job.started_at !== undefined &&
      Date.now() - job.started_at > STALE_APPLYING_MS;
    if (job.status !== "pending" && !staleApplying) {
      throw new Error(
        `Only pending or stale-applying jobs can be cancelled (status: ${job.status})`
      );
    }
    await ctx.db.patch(args.id, {
      status: "cancelled",
      finished_at: Date.now(),
      error: staleApplying
        ? "cancelled by operator: worker claim went stale mid-apply (HF may be " +
          "partially mutated; re-committing re-applies idempotently)"
        : undefined,
    });
    return args.id;
  },
});

export const forRepo = query({
  args: {
    dataset_repo: v.string(),
    // Default keeps the UI panel small; audit consumers (freshness gate,
    // parity gate, backfill) pass a large limit — truncation there silently
    // hid applied jobs and misattributed history.
    limit: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const jobs = await ctx.db
      .query("applyJobs")
      .withIndex("by_repo", (q) => q.eq("dataset_repo", args.dataset_repo))
      .collect();
    return jobs
      .sort((a, b) => b.requested_at - a.requested_at)
      .slice(0, args.limit ?? 5);
  },
});

export const beat = mutation({
  args: {
    serviceToken: v.optional(v.string()),
    worker_id: v.string(),
    info: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const principal = await requireEditorOrService(ctx, args.serviceToken);
    if (principal !== "service") {
      throw new Error("Only the worker (service principal) may heartbeat");
    }
    const existing = await ctx.db
      .query("workerHeartbeats")
      .withIndex("by_worker", (q) => q.eq("worker_id", args.worker_id))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { last_seen: Date.now(), info: args.info });
      return existing._id;
    }
    return await ctx.db.insert("workerHeartbeats", {
      worker_id: args.worker_id,
      last_seen: Date.now(),
      info: args.info,
    });
  },
});

export const workerStatus = query({
  args: {},
  handler: async (ctx) => {
    const beats = await ctx.db.query("workerHeartbeats").collect();
    if (beats.length === 0) return null;
    return beats.sort((a, b) => b.last_seen - a.last_seen)[0];
  },
});
