import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireEditorOrService } from "./access";

/**
 * Apply jobs bridge web-captured outcome reviews to HuggingFace. Since
 * 2026-08-21 the apply runs NATIVELY as a scheduled Convex action
 * (applyWorker:run, see convex/apply/) — enqueue schedules it immediately;
 * no external worker polling is required. The legacy Python
 * arena_review_worker `claim` path is kept as a fallback (set the
 * APPLY_NATIVE=0 deployment env var to disable native scheduling); claims
 * are atomic, so both paths can coexist without double-applying.
 * Status machine: pending → applying → applied | failed; pending → cancelled.
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
    const jobId = await ctx.db.insert("applyJobs", {
      dataset_repo: args.dataset_repo,
      status: "pending",
      requested_by: principal,
      requested_at: Date.now(),
      dry_run: args.dry_run ?? false,
    });
    if (process.env.APPLY_NATIVE !== "0") {
      await ctx.scheduler.runAfter(0, internal.applyWorker.run, { jobId });
    }
    return jobId;
  },
});

/** Native worker claims its scheduled job. Null when no longer pending
 * (cancelled first, or claimed by the legacy polling worker). */
export const claimById = internalMutation({
  args: { id: v.id("applyJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!job || job.status !== "pending") return null;
    await ctx.db.patch(args.id, {
      status: "applying",
      worker_id: "convex-action",
      started_at: Date.now(),
    });
    // A platform-level action timeout bypasses applyWorker's try/catch. Start
    // the reaper clock at the claim, not enqueue, so scheduler delay cannot
    // make the watchdog run before the claim is stale.
    await ctx.scheduler.runAfter(
      NATIVE_STALE_REAPER_DELAY_MS,
      internal.applyJobs.failStaleNativeInternal,
      { id: args.id }
    );
    return await ctx.db.get(args.id);
  },
});

/** Native worker reports completion (internal twin of `finish`). */
export const finishInternal = internalMutation({
  args: {
    id: v.id("applyJobs"),
    ok: v.boolean(),
    hf_commit_sha: v.optional(v.string()),
    pre_apply_sha: v.optional(v.string()),
    error: v.optional(v.string()),
    log_tail: v.optional(v.string()),
    num_confirmed: v.optional(v.int64()),
    num_skipped: v.optional(v.int64()),
  },
  handler: async (ctx, args) => {
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
export const STALE_APPLYING_MS = 10 * 60 * 1000;
export const NATIVE_STALE_REAPER_DELAY_MS = 12 * 60 * 1000;

export function isStaleNativeApplyJob(
  job:
    | {
        status: string;
        worker_id?: string;
        started_at?: number;
      }
    | null,
  now: number
): boolean {
  return Boolean(
    job &&
      job.status === "applying" &&
      job.worker_id === "convex-action" &&
      job.started_at !== undefined &&
      now - job.started_at > STALE_APPLYING_MS
  );
}

/** Mark a platform-terminated native action failed after its claim goes stale.
 * A normally completed action has already left `applying`, so this is a no-op.
 */
export const failStaleNativeInternal = internalMutation({
  args: { id: v.id("applyJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!isStaleNativeApplyJob(job, Date.now())) {
      return null;
    }
    await ctx.db.patch(args.id, {
      status: "failed",
      finished_at: Date.now(),
      error:
        "native Convex apply action exceeded its execution window; " +
        "no completion record was written (HF may be partially mutated; " +
        "re-apply idempotently with the rollback worker)",
    });
    return args.id;
  },
});

export const cancel = mutation({
  args: { serviceToken: v.optional(v.string()), id: v.id("applyJobs") },
  handler: async (ctx, args) => {
    const principal = await requireEditorOrService(ctx, args.serviceToken);
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
        ? `cancelled by ${principal}: worker claim went stale mid-apply (HF may be ` +
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
