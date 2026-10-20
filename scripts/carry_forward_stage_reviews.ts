import { parseArgs } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { normalizeStageSpec } from "../src/lib/stage-spec";
import { blankTrajectoryReview } from "../convex/trajectoryReview";

/** Carry human stage reviews forward to an ADDITIVE successor definition.
 *
 * Only for a target that keeps every stage (id + index), key action and failure
 * mode of the source, i.e. a version that only added choices. Each reviewer's
 * latest non-cleared source row is replayed through the normal service save
 * path into the target version — same status, label (identity re-stamped to
 * the target), notes, blind flag, duration, protocol, reviewer and saved_at —
 * so the target spec re-validates every committed review. Episodes where that
 * reviewer already has a target-version row are skipped (the newer human
 * decision wins). Source rows are never modified. Dry run unless --apply.
 *
 * bun scripts/carry_forward_stage_reviews.ts --url https://grandiose-rook-292.convex.cloud \
 *   --task routing_d1 --from trajectory-review/v1/routing_d1/v5 --to trajectory-review/v1/routing_d1/v6 \
 *   --repo ankile/<dataset> [--apply]   (--apply needs ARENA_SERVICE_TOKEN in the environment) */
async function main() {
  const { values } = parseArgs({ options: {
    url: { type: "string" }, task: { type: "string" }, from: { type: "string" }, to: { type: "string" },
    repo: { type: "string", multiple: true }, apply: { type: "boolean" },
  } });
  if (!values.url || !values.task || !values.from || !values.to || !values.repo?.length) {
    throw new Error("Usage: --url URL --task TASK --from VERSION --to VERSION --repo REPO [--repo REPO ...] [--apply]");
  }
  const client = new ConvexHttpClient(new URL(values.url).origin);
  const rows = await client.query(api.stageTaskSpecs.forTask, { task: values.task });
  const row = (version: string) => {
    const found = rows.find((r) => r.taxonomy_version === version);
    if (!found) throw new Error(`${values.task}@${version} is not published`);
    return normalizeStageSpec(found.spec);
  };
  const source = row(values.from).trajectory!.task_definition;
  const targetSpec = row(values.to);
  const target = targetSpec.trajectory!.task_definition;
  const ids = (items: { id: string }[]) => items.map((item) => item.id);
  const stageKeys = (def: typeof source) => def.stages.map((s) => `${s.index}:${s.id}`);
  if (JSON.stringify(stageKeys(source)) !== JSON.stringify(stageKeys(target))) throw new Error("stages differ; not an additive successor");
  if (JSON.stringify(ids(source.keyActions)) !== JSON.stringify(ids(target.keyActions))) throw new Error("key actions differ; not an additive successor");
  const missing = ids(source.failureModes).filter((id) => !ids(target.failureModes).includes(id));
  if (missing.length) throw new Error(`target drops failure modes: ${missing.join(", ")}`);
  const added = ids(target.failureModes).filter((id) => !ids(source.failureModes).includes(id));
  console.log(`${values.from} → ${values.to}: additive (+${added.join(", +") || "nothing"})`);

  const serviceToken = process.env.ARENA_SERVICE_TOKEN;
  if (values.apply && !serviceToken) throw new Error("--apply requires ARENA_SERVICE_TOKEN in the environment");
  let copied = 0, skipped = 0;
  for (const repo of values.repo) {
    const from = (await client.query(api.stageReviews.latestForRepo, { dataset_repo: repo, taxonomy_version: values.from })).episodes;
    const to = (await client.query(api.stageReviews.latestForRepo, { dataset_repo: repo, taxonomy_version: values.to })).episodes;
    const reviewerKey = (r: { reviewer: string; reviewer_user_id?: string }) => r.reviewer_user_id ?? `svc:${r.reviewer}`;
    const done = new Set(to.map((r) => `${r.episode_index}|${reviewerKey(r)}`));
    for (const review of [...from].sort((a, b) => Number(a.episode_index) - Number(b.episode_index))) {
      const tag = `${repo} ep ${review.episode_index} (${review.reviewer}, ${review.status})`;
      if (done.has(`${review.episode_index}|${reviewerKey(review)}`)) { console.log(`skip ${tag}: target review exists`); skipped++; continue; }
      if (review.prediction_id !== undefined || review.legacy_prefill_id !== undefined || review.prefill_pushed_at !== undefined || review.event_links !== undefined) {
        throw new Error(`${tag}: carries prediction/prefill/event-link provenance this script does not translate`);
      }
      const identity = blankTrajectoryReview(targetSpec.trajectory!, repo, Number(review.episode_index)).trajectory_identity;
      const label = { ...review.label!, trajectory_identity: identity };
      console.log(`${values.apply ? "copy" : "would copy"} ${tag} failure_mode=${String(label.failure_mode || "-")}`);
      if (values.apply) {
        await client.mutation(api.stageReviews.save, {
          serviceToken, task: values.task, dataset_repo: repo, taxonomy_version: values.to,
          episode_index: review.episode_index, status: review.status, label, notes: review.notes,
          review_protocol: review.review_coverage?.protocol, blind: review.blind,
          episode_duration_s: review.episode_duration_s, reviewer_override: review.reviewer,
          saved_at_override: review.saved_at,
        });
      }
      copied++;
    }
  }
  console.log(`${values.apply ? "Copied" : "Would copy"} ${copied}, skipped ${skipped}.${values.apply ? "" : " Dry run: nothing written."}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
