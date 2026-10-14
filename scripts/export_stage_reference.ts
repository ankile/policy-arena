/** Freeze only explicitly human-supervised fields. Never export hidden ledgers as gold.
 * bun scripts/export_stage_reference.ts --export FILE --task marker_d2 --out FILE
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { canonicalDigest } from "../convex/stagePredictionContract";
import { trajectoryTaskDefinitionDigest } from "../convex/trajectoryReview";
import { CURRENT_REVIEW_FIELDS, CURRENT_REVIEW_PROTOCOL } from "../convex/stageReviewCoverage";
import { validateStageOutcomeReview } from "../convex/stageOutcomeReview";
import { normalizeStageSpec } from "../src/lib/stage-spec";
import { stageReviewRelease } from "../shared/stageReviewRelease";
import { planCarryForward } from "../sandbox/carryForwardReviews";
import type { LocalReview } from "../sandbox/localReviewStore";

type Task = keyof typeof stageReviewRelease;
type Pilot = {
  id: string; purpose: string; method: string;
  sources: { task: string; repo: string; revision: string; name: string }[];
  episodes: { task: string; dataset: string; episode: number }[];
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = (row: { dataset_repo: string; episode_index: bigint }) => `${row.dataset_repo}#episode=${row.episode_index}`;

export async function freezeReference(reviews: LocalReview[], pilot: Pilot, task: Task,
  provenance: { export_file_sha256: string; pilot_file_sha256: string },
  options: { allowPendingDefinitionReview?: boolean } = {}) {
  const spec = stageReviewRelease[task];
  const tag = normalizeStageSpec(spec).trajectory!;
  const definitionHash = await trajectoryTaskDefinitionDigest(tag.task_definition);
  if (definitionHash !== spec.trajectory.task_definition_sha256) throw new Error("Task definition content pin mismatch");
  const selected = pilot.episodes.filter((row) => row.task === task);
  if (!selected.length) throw new Error("Empty reference set");
  const selectedIds = new Set(selected.map((row) => `${row.dataset}#episode=${row.episode}`));
  if (selectedIds.size !== selected.length) throw new Error("Duplicate pilot identity");
  const migration = planCarryForward([...reviews].sort((a, b) => a.saved_at - b.saved_at));
  if (!options.allowPendingDefinitionReview && migration.additions.some((row) => row.task === task && selectedIds.has(identity(row)))) {
    throw new Error("Selected annotations still need an explicit protocol carry-forward/recheck");
  }
  const cases = [];
  for (const episode of selected) {
    const sampleId = `${episode.dataset}#episode=${episode.episode}`;
    const candidates = reviews.filter((row) => row.task === task && row.dataset_repo === episode.dataset &&
      Number(row.episode_index) === episode.episode && row.taxonomy_version === spec.taxonomy_version &&
      row.reviewer_user_id === "local-reviewer").sort((a, b) => b.saved_at - a.saved_at);
    const row = candidates[0];
    if (!row || !["confirmed", "corrected"].includes(row.status) || !row.label) {
      throw new Error(`${sampleId}: latest review is missing or not committed`);
    }
    if (candidates[1]?.saved_at === row.saved_at && candidates[1]._id !== row._id) {
      throw new Error(`${sampleId}: ambiguous latest review`);
    }
    if (row.review_protocol !== CURRENT_REVIEW_PROTOCOL ||
      !CURRENT_REVIEW_FIELDS.every((field) => row.review_coverage?.reviewed_fields.includes(field))) {
      throw new Error(`${sampleId}: supervision coverage is incomplete`);
    }
    const pending = migration.additions.find((item) => item.local_migration?.source_review_id === row._id);
    if (row.local_task_definition_sha256 && row.local_task_definition_sha256 !== definitionHash &&
      !(options.allowPendingDefinitionReview && pending)) {
      throw new Error(`${sampleId}: saved definition pin differs`);
    }
    // Evaluation-only: retain the saved human values, without creating a review,
    // repinning a source, or treating a pending migration as human confirmation.
    // Unknown pins and retired/ambiguous values still fail validation below.
    const issues = validateStageOutcomeReview(tag, row.label, row.episode_duration_s);
    if (issues.length) throw new Error(`${sampleId}: ${issues.map((issue) => issue.message).join("; ")}`);
    const expectedIdentity = { schema_version: "trajectory-label/v2", task_id: task,
      taxonomy_version: tag.task_definition.taxonomyVersion, sample_id: sampleId };
    if (await canonicalDigest(row.label.trajectory_identity) !== await canonicalDigest(expectedIdentity)) {
      throw new Error(`${sampleId}: trajectory identity differs`);
    }
    const source = pilot.sources.filter((item) => item.repo === episode.dataset && item.task === task);
    if (source.length !== 1 || !/^[a-f0-9]{40}$/.test(source[0].revision)) throw new Error(`${sampleId}: missing pinned media source`);
    const transitions = (row.label.stage_transitions as Record<string, unknown>[]).map((event) =>
      Object.fromEntries(["from_stage_id", "from_stage_index", "to_stage_id", "to_stage_index", "attempt_index", "time_s"].map((key) => [key, event[key]])));
    cases.push({ sample_id: sampleId, dataset: episode.dataset, episode_index: episode.episode,
      hf_revision: source[0].revision, dataset_name: source[0].name,
      episode_duration_s: row.episode_duration_s,
      source_review: { id: row._id, saved_at: row.saved_at, status: row.status, blind: row.blind,
        protocol: row.review_protocol, definition_pin_present: row.local_task_definition_sha256 !== undefined,
        task_definition_sha256: row.local_task_definition_sha256 ?? null,
        // Convex JSON retains exact bigint encoding in the source record checksum.
        sha256: await canonicalDigest(convexToJson(row as unknown as Value)) },
      expected: { task_success: row.label.task_success, failure_mode_id: row.label.failure_mode,
        max_stage_id: row.label.max_stage_id, max_stage_index: row.label.max_stage,
        attempt_count: row.label.attempt_count, stage_transitions: transitions },
      definition_review_issues: pending?.local_migration?.issues ?? [],
      human_notes: row.notes ?? "" });
  }
  const body = { schema_version: "trajectory-human-reference/v1", task_id: task,
    taxonomy_version: tag.task_definition.taxonomyVersion, task_definition: tag.task_definition,
    task_definition_sha256: definitionHash, review_protocol: CURRENT_REVIEW_PROTOCOL,
    reviewed_fields: CURRENT_REVIEW_FIELDS, purpose: pilot.purpose,
    selection: { pilot_id: pilot.id, method: pilot.method }, ...provenance, cases };
  return { ...body, reference_sha256: await canonicalDigest(body) };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    export: { type: "string" }, task: { type: "string" }, out: { type: "string" },
    pilot: { type: "string", default: "sandbox/data/stage-reference-pilot.json" },
    "allow-pending-definition-review": { type: "boolean", default: false },
  } });
  if (!values.export || !values.out || !values.task || !(values.task in stageReviewRelease)) {
    throw new Error("Required: --export FILE --task marker_d2|square_d2|routing_d1 --out NEW_FILE");
  }
  const raw = readFileSync(values.export, "utf8"), pilotRaw = readFileSync(values.pilot!, "utf8");
  const reviews = jsonToConvex(JSON.parse(raw)) as unknown as LocalReview[];
  const gold = await freezeReference(reviews, JSON.parse(pilotRaw), values.task as Task,
    { export_file_sha256: sha(raw), pilot_file_sha256: sha(pilotRaw) },
    { allowPendingDefinitionReview: values["allow-pending-definition-review"] });
  writeFileSync(values.out, JSON.stringify(gold, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output: values.out, cases: gold.cases.length,
    successes: gold.cases.filter((row) => row.expected.task_success).length, sha256: gold.reference_sha256 }));
}
