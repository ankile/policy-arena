import { parseArgs } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { canonicalDigest } from "../convex/stagePredictionContract";
import { normalizeStageSpec } from "../src/lib/stage-spec";
import { trajectoryTaskDefinitionDigest } from "../convex/trajectoryReview";
import { stageReviewTasks } from "../shared/stageReviewTasks";
import { stageReviewRelease } from "../shared/stageReviewRelease";

/** Read-only by default. --apply requires a server-only publisher credential. */
async function main() {
  const { values } = parseArgs({ options: {
    url: { type: "string" }, apply: { type: "boolean" }, verify: { type: "boolean" },
  } });
  if (!values.url || (values.apply && values.verify)) {
    throw new Error("Usage: bun scripts/stage_review_release.ts --url https://DEPLOYMENT.convex.cloud [--apply | --verify]");
  }
  const url = new URL(values.url);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".convex.cloud") || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use an explicit HTTPS Convex deployment URL without credentials or query parameters");
  }
  const client = new ConvexHttpClient(url.origin);
  const entries = [];
  let ready = true;
  for (const task of stageReviewTasks) {
    const spec = stageReviewRelease[task.task];
    const normalized = normalizeStageSpec(spec);
    const { taxonomy_hash, ...content } = spec;
    if (spec.taxonomy_version !== task.version || await canonicalDigest(content) !== taxonomy_hash ||
      await trajectoryTaskDefinitionDigest(normalized.trajectory!.task_definition) !== spec.trajectory.task_definition_sha256) {
      throw new Error(`${task.task}: bundled release content/hash mismatch`);
    }
    const rows = await client.query(api.stageTaskSpecs.forTask, { task: task.task });
    const live = rows.filter((row) => row.live);
    if (live.length > 1) throw new Error(`${task.task}: multiple live definitions`);
    const previous = live[0]?.taxonomy_version ?? null;
    if (previous !== null && previous !== task.previousVersion && previous !== task.version) {
      throw new Error(`${task.task}: unexpected live version ${previous}; refusing to supersede it`);
    }
    const existing = rows.find((row) => row.taxonomy_version === task.version);
    if (existing && (existing.taxonomy_hash !== taxonomy_hash || await canonicalDigest(existing.spec) !== await canonicalDigest(spec))) {
      throw new Error(`${task.task}: immutable release content conflict`);
    }
    ready &&= previous === task.version;
    console.log(`${task.name}: ${previous ?? "not published"} → ${task.version}${previous === task.version ? " (ready)" : " (publication required)"}`);
    entries.push({ previous, fields: { task: task.task, taxonomy_version: task.version, taxonomy_hash, spec,
      live: true, source: "policy-arena-stage-review-release/v1" } });
  }
  if (values.verify && !ready) throw new Error("Release not ready. Publish the definitions before merging/deploying the frontend.");
  if (!values.apply || ready) {
    console.log(ready ? "All released definitions verified. No writes needed." : "Inspection only: no shared data changed. Use --apply after publication approval.");
    return;
  }
  const serviceToken = process.env.ARENA_SERVICE_TOKEN;
  if (!serviceToken) throw new Error("--apply requires ARENA_SERVICE_TOKEN in the environment (never VITE_* or a command-line argument)");
  // Existing API only: stage all candidates before promoting any task. This is
  // resumable, not an atomic multi-task migration; do not run concurrent publishers.
  for (const entry of entries) {
    if (entry.previous === entry.fields.taxonomy_version) continue;
    await client.mutation(api.stageTaskSpecs.upsert, { serviceToken, ...entry.fields, live: false });
  }
  for (const entry of entries) {
    if (entry.previous === entry.fields.taxonomy_version) continue;
    const current = await client.query(api.stageTaskSpecs.liveForTask, { task: entry.fields.task });
    if ((current?.taxonomy_version ?? null) !== entry.previous) {
      throw new Error(`${entry.fields.task}: live definition changed; inspect before retrying`);
    }
    await client.mutation(api.stageTaskSpecs.upsert, { serviceToken, ...entry.fields });
  }
  for (const { fields: entry } of entries) {
    const row = await client.query(api.stageTaskSpecs.liveForTask, { task: entry.task });
    if (row?.taxonomy_version !== entry.taxonomy_version || row.taxonomy_hash !== entry.taxonomy_hash ||
      await canonicalDigest(row.spec) !== await canonicalDigest(entry.spec)) {
      throw new Error(`${entry.task}: publication readback did not match the release`);
    }
  }
  console.log("Published and verified all three definitions. Predictions, reviews, and human outcomes were not modified.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Stage-review release failed");
  process.exitCode = 1;
});
