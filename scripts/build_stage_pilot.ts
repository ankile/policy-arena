/** Read-only sampler. Prints a frozen manifest; never calls models or writes to Arena. */
import { createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { PILOT_SEED, selectPilot, type PilotCandidate } from "../sandbox/pilotSelection";

const client = new ConvexHttpClient("https://grandiose-rook-292.convex.cloud");
const sources = [
  {task: "marker_d2", name: "Marker R5", version: "v3", repo: "ankile/real01b-md2-r5-repeat-base-dp-filmtiidk4-c200k-n32-s2026070704"},
  {task: "marker_d2", name: "Marker R4", version: "v3", repo: "ankile/real01b-marker-d2-r4-trio-baseline-dp-iql-c125k-n16-heval-sobolseed2026070604"},
  {task: "marker_d2", name: "Marker R3", version: "v3", repo: "ankile/real01b-marker-d2-r3-trio-baseline-dp-iql-vpc100k-n16-heval-sobolseed2026070201"},
  {task: "square_d2", name: "Nut R5", version: "v3", repo: "ankile/real01b-square-d2-r5-redo-base-dp-filmtiidk4-c200k-n32-s2026081801"},
  {task: "square_d2", name: "Nut R4", version: "v3", repo: "ankile/real01b-square-d2-r4-quad-baseline-nocf-freecf-iql-s2final-n16-heval-sobolseed2026070304"},
  {task: "square_d2", name: "Nut R3", version: "v3", repo: "ankile/real01b-square-d2-r3-fixedinit-checkpoint100000-heldout-sobol50"},
  {task: "routing_d1", name: "Routing R8", version: "v1", repo: "ankile/real01b-routing-d1-r8-threearm-checkpoint100000-iql-g0997-n32-heldout-sobol50"},
  {task: "routing_d1", name: "Routing R6", version: "v1", repo: "ankile/real01b-routing-d1-r6-threearm-checkpoint100000-iql-g0997-n16-heldout-sobol50"},
  {task: "routing_d1", name: "Routing R4", version: "v1", repo: "ankile/real01b-routing-d1-r4-threearm-checkpoint100000-iql-g0997-n16-heldout-sobol50"},
];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function get(url: string, allowMissing = false) {
  const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
  if (response.status === 404 && allowMissing) return null;
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const text = await response.text();
  return {value: JSON.parse(text), sha256: sha(text)};
}
const all: PilotCandidate[] = [];
const provenance = [];
for (const source of sources) {
  const head = await get(`https://huggingface.co/api/datasets/${source.repo}`);
  const revision = head!.value.sha as string;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(`Unpinned dataset ${source.repo}`);
  const base = `https://huggingface.co/datasets/${source.repo}/resolve/${revision}`;
  const applied = await get(`${base}/.outcome_edit_progress.json`, true);
  const results = await get(`${base}/results.json`);
  const web = await client.query(api.reviews.latestForRepo, {dataset_repo: source.repo});
  const reviews = new Map(web.episodes.map((row) => [Number(row.episode_index), row]));
  const rollouts = new Map<number, {policy_id: number | string}>(results!.value.rollouts.map((r: {episode_index: number; policy_id: number | string}) => [r.episode_index, r]));
  const taxonomy = `trajectory-review/v1/${source.task}/${source.version}`;
  const catalog = await client.query(api.stagePredictions.listForRepo, {dataset_repo: source.repo, taxonomy_version: taxonomy});
  const run = catalog.runs.find((row) => row._id === catalog.active_run_id);
  if (!run) throw new Error(`No active historical prediction: ${source.repo}`);
  let cursor: string | null = null;
  let count = 0;
  do {
    const page = await client.query(api.stagePredictions.forRun, {run_id: run._id, paginationOpts: {cursor, numItems: 50}});
    for (const prediction of page.page) {
      const episode = Number(prediction.episode_index);
      const review = reviews.get(episode);
      const change = applied?.value.changed_episodes[String(episode)];
      // Only explicit human decisions. Skipped/undecided episodes are not
      // classified from model output, inferred stages or collector defaults.
      const humanOutcome = review?.status === "confirmed" ? review.new_outcome : change?.new_outcome;
      if (!["success", "failure", "timeout"].includes(humanOutcome)) continue;
      const label = prediction.canonical_response;
      const rollout = rollouts.get(episode);
      if (!label || !rollout) throw new Error(`Missing sampling metadata: ${source.repo} ep ${episode}`);
      if (!Number.isInteger(label.max_stage?.stage_index) || typeof label.primary_failure?.failure_mode_id !== "string") throw new Error("Invalid prediction proxies");
      all.push({task: source.task, dataset: source.repo, episode,
        outcome: humanOutcome === "success" ? "success" : "failure", humanOutcome,
        outcomeSource: review?.status === "confirmed" ? `arena:${review._id}` : "hf:.outcome_edit_progress.json",
        predictionHash: prediction.content_sha256,
        failureProxy: label.primary_failure.failure_mode_id, stageProxy: label.max_stage.stage_index,
        policy: String(rollout.policy_id), attempts: label.attempt_count});
      count++;
    }
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  provenance.push({...source, revision, outcomeSha256: applied?.sha256 ?? null, resultsSha256: results!.sha256,
    predictionRun: run._id, predictionTaxonomy: taxonomy, eligible: count});
  console.error(`${source.name}: ${count} eligible episodes`);
  if (count < 7) throw new Error(`Insufficient explicitly reviewed episodes: ${source.repo}`);
}
const episodes = [...new Set(sources.map((row) => row.task))].flatMap((task) => selectPilot(all.filter((row) => row.task === task)));
console.log(JSON.stringify({id: PILOT_SEED, createdAt: new Date().toISOString(),
  purpose: "Development reference pilot, not a population-representative or unseen benchmark",
  quotas: {perTask: 20, success: 7, failure: 13},
  method: "Explicit human outcomes (timeouts count as failure); dataset-balanced greedy coverage of historical failure/stage/policy/retry proxies; seeded tie-break. Proxies are NOT new-taxonomy truth and are hidden while labeling.",
  sources: provenance, episodes}, null, 2));
