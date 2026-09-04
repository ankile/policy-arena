"use node";

/**
 * Native apply worker — Convex action port of sir/tools/arena_review_worker.py.
 *
 * Scheduled by applyJobs:enqueue (no polling): claims the job, materializes
 * the review overlay, runs the TS apply pipeline (convex/apply/) on a
 * snapshot fetched at the pre-apply sha, pushes ONE atomic HF commit pinned
 * on that sha (a concurrent push to main fails the commit loudly), advances
 * the v3.0 tag, patches the arena session's roundResults in place, and
 * reports status + shas back to the job row.
 *
 * Requires the HF_TOKEN deployment env var (write access to the datasets).
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { buildOverlay } from "./apply/progress";
import type { ReviewRow } from "./apply/progress";
import type { LabelSource } from "./apply/labelHistory";
import { headlessApply } from "./apply/pipeline";
import {
  revisionSha,
  listRepoFiles,
  downloadRepoFile,
  commitFiles,
  advanceLerobotVersionTag,
} from "./apply/hf";
import type { HfClient } from "./apply/hf";

const LOG_TAIL_CHARS = 2000;

export const run = internalAction({
  args: { jobId: v.id("applyJobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.runMutation(internal.applyJobs.claimById, { id: jobId });
    if (job === null) return; // claimed by another worker or cancelled first
    const repoId = job.dataset_repo;
    const log: string[] = [];
    let preSha: string | undefined;
    let hfMutated = false;
    try {
      const token = process.env.HF_TOKEN;
      if (!token) throw new Error("HF_TOKEN deployment env var is not set");
      const client: HfClient = { repoId, token };

      const reviews = await ctx.runQuery(api.reviews.latestForRepo, { dataset_repo: repoId });
      const overlay = buildOverlay(reviews.episodes as unknown as ReviewRow[]);
      const numConfirmed = Object.keys(overlay.changed_episodes).length;
      const numSkipped = overlay.skipped_episodes.length;
      if (numConfirmed === 0 && numSkipped === 0) {
        throw new Error(`No confirmed or skipped reviews recorded for ${repoId}`);
      }
      // Label-history provenance: who made each decision and which apply job
      // carried it. Side-channel, NOT overlay fields — decision records stay
      // shaped exactly like the historical editor's.
      const sourceByEpisode = new Map<number, LabelSource>(
        (reviews.episodes as unknown as ReviewRow[]).map((row) => [
          Number(row.episode_index),
          { kind: "human", agent: String(row.reviewer), tool: "web-review" },
        ])
      );

      const taskSpecs = (await ctx.runQuery(api.taskSpecs.all, {})) as Array<{
        task_name: string;
        num_subtask_marks: number | bigint;
      }>;

      preSha = await revisionSha(client);
      const paths = await listRepoFiles(client, preSha);
      const result = await headlessApply({
        store: { paths, fetch: (p) => downloadRepoFile(client, p, preSha!) },
        overlay,
        provenance: { sourceByEpisode, evidence: { apply_job: String(jobId) } },
        preApplySha: preSha,
        taskSpecs,
      });
      log.push(...result.summary.log);

      if (job.dry_run) {
        // Honest state: nothing landed on HF, so the job must not read as applied.
        await ctx.runMutation(internal.applyJobs.finishInternal, {
          id: jobId,
          ok: false,
          error: "dry-run: apply computed in-memory, nothing pushed",
          log_tail: log.join("\n").slice(-LOG_TAIL_CHARS),
          num_confirmed: BigInt(numConfirmed),
          num_skipped: BigInt(numSkipped),
        });
        return;
      }

      const postSha = await commitFiles({
        client,
        files: result.changedFiles,
        message:
          `Apply ${numConfirmed} outcome review(s) from policy-eval.ankile.com ` +
          `(job ${String(jobId)})`,
        parentCommit: preSha,
      });
      hfMutated = true;
      log.push(`Committed ${result.changedFiles.size} file(s) @ ${postSha.slice(0, 8)}`);
      await advanceLerobotVersionTag(client, postSha);
      log.push(`Moved v3.0 -> ${postSha.slice(0, 8)}`);

      const corrected = await ctx.runMutation(internal.evalSessions.correctOutcomes, {
        dataset_repo: repoId,
        corrections: result.summary.episode_success.map((e) => ({
          episode_index: BigInt(e.episode_index),
          success: e.success,
          num_frames: BigInt(e.num_frames),
          num_subtask_marks: BigInt(e.num_subtask_marks),
        })),
      });
      log.push(
        corrected.session_found
          ? `Arena session synced in place: ${corrected.updated} round result(s) corrected.`
          : "(no arena session registered for this repo; sync skipped)"
      );

      const statsRefreshQueued = await ctx.runMutation(
        internal.datasets.enqueueStatsRefreshInternal,
        { repo_id: repoId }
      );
      log.push(
        statsRefreshQueued
          ? "Dataset summary refresh queued."
          : "(no arena dataset registered for this repo; summary refresh skipped)"
      );

      await ctx.runMutation(internal.applyJobs.finishInternal, {
        id: jobId,
        ok: true,
        hf_commit_sha: postSha,
        pre_apply_sha: preSha,
        log_tail: log.join("\n").slice(-LOG_TAIL_CHARS),
        num_confirmed: BigInt(numConfirmed),
        num_skipped: BigInt(numSkipped),
      });
    } catch (error) {
      const err = error instanceof Error ? (error.stack ?? error.message) : String(error);
      await ctx.runMutation(internal.applyJobs.finishInternal, {
        id: jobId,
        ok: false,
        error: err.slice(-LOG_TAIL_CHARS),
        log_tail: log.join("\n").slice(-LOG_TAIL_CHARS),
        // If HF was already mutated the pre-state sha is the rollback anchor;
        // record it on the failed job too.
        pre_apply_sha: hfMutated ? preSha : undefined,
      });
    }
  },
});
