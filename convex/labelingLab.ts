import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireEditor, requireEditorOrService, viewerIsEditor } from "./access";
import { canonicalDigest } from "./stagePredictionContract";
import { generationValidator, LEASE_MS, MAX_EPISODES, validateEpisodes, validateGeneration } from "./labelingContract";

function submissionReady() {
  return process.env.LABELING_ENABLED === "1" && Boolean(process.env.LABELING_CLOUD_RUN_JOB)
    && Boolean(process.env.LABELING_DISPATCHER_JSON) && Boolean(process.env.LABELING_CANARY_RECEIPT);
}
async function validatePromptTask(prompt: string, task: unknown) {
  const blocks = [...prompt.matchAll(/<task_definition format="application\/json">([\s\S]*?)<\/task_definition>/g)];
  if (blocks.length !== 1 || await canonicalDigest(JSON.parse(blocks[0][1])) !== await canonicalDigest(task)) {
    throw new Error("Prompt must preserve the registered task definition; schema changes require a new Python preset");
  }
}
export const availability = query({
  args: {},
  handler: () => ({ enabled: submissionReady(), max_episodes: MAX_EPISODES,
    message: submissionReady() ? "Worker enabled" : "Cloud worker setup and an end-to-end canary are required before Run is enabled." }),
});
export const configs = query({
  args: { task: v.string() },
  handler: (ctx, args) => ctx.db.query("labelingConfigs").withIndex("by_task", (q) => q.eq("task", args.task)).order("desc").take(100),
});

// Presets come from the Python contract exporter, never a browser-supplied schema.
export const registerPreset = internalMutation({
  args: { name: v.string(), spec_id: v.id("stageTaskSpecs"), system_prompt: v.string(),
    response_schema: v.any(), generation: generationValidator, worker_revision: v.string() },
  handler: async (ctx, args) => {
    const spec = await ctx.db.get(args.spec_id);
    if (!spec?.spec.trajectory) throw new Error("A registered trajectory task specification is required");
    if (!/^[0-9a-f]{40}$/.test(args.worker_revision)) throw new Error("Pin the worker source revision");
    validateGeneration(args.generation, args.generation.model);
    if (!args.system_prompt.trim() || args.system_prompt.length > 100_000) throw new Error("Invalid prompt size");
    await validatePromptTask(args.system_prompt, spec.spec.trajectory.task_definition);
    const content = { ...args, task: spec.task, taxonomy_version: spec.taxonomy_version, taxonomy_hash: spec.taxonomy_hash };
    const digest = await canonicalDigest(content);
    const existing = await ctx.db.query("labelingConfigs").withIndex("by_digest", (q) => q.eq("digest", digest)).unique();
    if (existing) return existing._id;
    return ctx.db.insert("labelingConfigs", { ...content, digest, created_by: "python-preset", created_at: Date.now() });
  },
});
export const saveConfig = mutation({
  args: { parent_id: v.id("labelingConfigs"), name: v.string(), system_prompt: v.string(), generation: generationValidator },
  handler: async (ctx, args) => {
    const actor = await requireEditor(ctx);
    const parent = await ctx.db.get(args.parent_id);
    if (!parent) throw new Error("Configuration not found");
    if (!args.name.trim() || args.name.length > 100) throw new Error("Name must contain 1..100 characters");
    if (!args.system_prompt.trim() || args.system_prompt.length > 100_000) throw new Error("Prompt must contain 1..100000 characters");
    validateGeneration(args.generation, parent.generation.model);
    const spec = await ctx.db.get(parent.spec_id);
    if (!spec?.spec.trajectory || spec.taxonomy_hash !== parent.taxonomy_hash) throw new Error("Registered task definition changed");
    await validatePromptTask(args.system_prompt, spec.spec.trajectory.task_definition);
    const content = { name: args.name.trim(), parent_id: parent._id, task: parent.task,
      spec_id: parent.spec_id, taxonomy_version: parent.taxonomy_version, taxonomy_hash: parent.taxonomy_hash,
      system_prompt: args.system_prompt, response_schema: parent.response_schema,
      generation: args.generation, worker_revision: parent.worker_revision };
    const digest = await canonicalDigest(content);
    const existing = await ctx.db.query("labelingConfigs").withIndex("by_digest", (q) => q.eq("digest", digest)).unique();
    if (existing) return existing._id;
    return ctx.db.insert("labelingConfigs", { ...content, digest, created_by: actor, created_at: Date.now() });
  },
});
export const jobs = query({
  args: { dataset_repo: v.string() },
  handler: async (ctx, args) => {
    if (!await viewerIsEditor(ctx)) return [];
    return ctx.db.query("labelingJobs").withIndex("by_repo", (q) => q.eq("dataset_repo", args.dataset_repo)).order("desc").take(50);
  },
});
async function event(ctx: MutationCtx, job_id: Id<"labelingJobs">, name: string, actor: string, fence: number) {
  await ctx.db.insert("labelingJobEvents", { job_id, event: name, actor, fence, at: Date.now() });
}
export const submit = mutation({
  args: { config_id: v.id("labelingConfigs"), dataset_repo: v.string(), episodes: v.array(v.number()), request_key: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireEditor(ctx);
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Sign in before submitting");
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(args.request_key)) throw new Error("Invalid submission identity");
    const requestDigest = await canonicalDigest({ config_id: args.config_id, dataset_repo: args.dataset_repo, episodes: [...args.episodes].sort((a,b) => a-b) });
    const existing = await ctx.db.query("labelingJobs").withIndex("by_request", (q) => q.eq("requested_user_id", userId).eq("request_key", args.request_key)).unique();
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new Error("Submission identity was reused with different input");
      return existing._id;
    }
    if (!submissionReady()) throw new Error("Labeling worker is disabled until its cloud canary is verified");
    const config = await ctx.db.get(args.config_id);
    const dataset = await ctx.db.query("datasets").withIndex("by_repo", (q) => q.eq("repo_id", args.dataset_repo)).unique();
    if (!config || !dataset || dataset.task !== config.task) throw new Error("Choose a registered dataset and matching task configuration");
    if (dataset.stats_status !== "ready" || !dataset.stats_hf_sha || !/^[0-9a-f]{40}$/.test(dataset.stats_hf_sha) || dataset.num_episodes === undefined) throw new Error("Refresh dataset statistics to pin its media revision before submitting");
    const episodes = validateEpisodes(args.episodes, Number(dataset.num_episodes));
    // One global job, with one worker call at a time, is the initial spend ceiling.
    for (const status of ["queued", "dispatched", "running", "cancel_requested"] as const) {
      if (await ctx.db.query("labelingJobs").withIndex("by_status", (q) => q.eq("status", status)).first()) throw new Error("Another labeling job is active; finish or cancel it first");
    }
    const now = Date.now();
    const jobId = await ctx.db.insert("labelingJobs", { config_id: config._id, config_digest: config.digest,
      dataset_repo: args.dataset_repo, dataset_revision: dataset.stats_hf_sha, episodes,
      requested_by: actor, requested_user_id: userId, requested_at: now, updated_at: now,
      request_key: args.request_key, request_digest: requestDigest, status: "queued", completed_episodes: 0,
      provider_calls: 0, fence: 0 });
    await event(ctx, jobId, "submitted", actor, 0);
    await ctx.scheduler.runAfter(0, internal.labelingDispatch.run, { job_id: jobId });
    return jobId;
  },
});
export const cancel = mutation({
  args: { job_id: v.id("labelingJobs") },
  handler: async (ctx, args) => {
    const actor = await requireEditor(ctx);
    const job = await ctx.db.get(args.job_id);
    if (!job) throw new Error("Job not found");
    if (["completed", "cancelled", "failed"].includes(job.status)) return;
    const status = job.status === "running" ? "cancel_requested" : "cancelled";
    await ctx.db.patch(job._id, { status, updated_at: Date.now() });
    await event(ctx, job._id, status, actor, job.fence);
  },
});
export const dispatchRequest = internalQuery({
  args: { job_id: v.id("labelingJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.job_id);
    return job?.status === "queued" && submissionReady() ? job : null;
  },
});
export const dispatched = internalMutation({
  args: { job_id: v.id("labelingJobs"), execution: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.job_id);
    if (!job || job.status !== "queued") return;
    const status = args.error ? "failed" : "dispatched";
    await ctx.db.patch(job._id, { status, execution: args.execution, error: args.error, updated_at: Date.now() });
    await event(ctx, job._id, status, "dispatcher", job.fence);
  },
});
async function requireWorker(ctx: MutationCtx, token: string | undefined) {
  if (await requireEditorOrService(ctx, token) !== "service") throw new Error("Worker credential required");
}
export const claim = mutation({
  args: { serviceToken: v.optional(v.string()), job_id: v.id("labelingJobs"), worker_id: v.string() },
  handler: async (ctx, args) => {
    await requireWorker(ctx, args.serviceToken);
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(args.worker_id)) throw new Error("Invalid worker identity");
    const job = await ctx.db.get(args.job_id);
    if (!job || !["queued", "dispatched", "running"].includes(job.status)) throw new Error("Job cannot be claimed");
    if (job.worker_id && job.worker_id !== args.worker_id) throw new Error("Job already has an execution owner; recovery requires an audited checkpoint handoff");
    if (job.lease_until && job.lease_until <= Date.now()) throw new Error("Lease expired; automatic takeover is disabled to avoid overlapping paid calls");
    const fence = job.fence || 1;
    await ctx.db.patch(job._id, { worker_id: args.worker_id, fence, status: "running", lease_until: Date.now() + LEASE_MS, updated_at: Date.now() });
    if (!job.worker_id) await event(ctx, job._id, "claimed", args.worker_id, fence);
    const config = await ctx.db.get(job.config_id);
    if (!config || config.digest !== job.config_digest) throw new Error("Frozen configuration mismatch");
    const spec = await ctx.db.get(config.spec_id);
    if (!spec || spec.taxonomy_hash !== config.taxonomy_hash) throw new Error("Frozen task specification mismatch");
    return { job, config, spec, fence };
  },
});
export const heartbeat = mutation({
  args: { serviceToken: v.optional(v.string()), job_id: v.id("labelingJobs"), worker_id: v.string(), fence: v.number() },
  handler: async (ctx, args) => {
    await requireWorker(ctx, args.serviceToken);
    const job = await ctx.db.get(args.job_id);
    if (!job || job.worker_id !== args.worker_id || job.fence !== args.fence || !job.lease_until || job.lease_until <= Date.now()) throw new Error("Worker lease is stale");
    if (!["running", "cancel_requested"].includes(job.status)) throw new Error("Job is terminal");
    await ctx.db.patch(job._id, { lease_until: Date.now() + LEASE_MS, updated_at: Date.now() });
    return { cancel: job.status === "cancel_requested" || !submissionReady() };
  },
});
