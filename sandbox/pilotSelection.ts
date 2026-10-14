/** Sampling proxies are historical model judgments, never human stage labels. */
export type PilotCandidate = {
  task: string;
  dataset: string;
  episode: number;
  outcome: "success" | "failure";
  humanOutcome: string;
  outcomeSource: string;
  predictionHash: string;
  failureProxy: string;
  stageProxy: number;
  policy: string;
  attempts: number;
};

export const PILOT_SEED = "stage-reference-pilot-2026-10-12-v1";

// Stable unsigned hash: only breaks ties, never chooses an outcome or label.
function rank(row: PilotCandidate) {
  let hash = 2166136261;
  for (const char of `${PILOT_SEED}:${row.dataset}:${row.episode}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  return hash;
}

/** Fixed quotas; greedily diversify failure/stage, policy and retry proxies,
 * while keeping dataset representation balanced within each outcome group. */
export function selectPilot(candidates: PilotCandidate[]): PilotCandidate[] {
  if (new Set(candidates.map((row) => row.task)).size !== 1) throw new Error("Select one task at a time");
  const identities = candidates.map((row) => `${row.dataset}#${row.episode}`);
  if (new Set(identities).size !== identities.length) throw new Error("Duplicate episode identity");
  const selected: PilotCandidate[] = [];
  for (const [outcome, quota] of [["success", 7], ["failure", 13]] as const) {
    const pool = candidates.filter((row) => row.outcome === outcome);
    if (pool.length < quota) throw new Error(`Need ${quota} human ${outcome} episodes, found ${pool.length}`);
    const group: PilotCandidate[] = [];
    while (group.length < quota) {
      const remaining = pool.filter((row) => !group.includes(row));
      const count = (dataset: string) => group.filter((row) => row.dataset === dataset).length;
      const minimum = Math.min(...remaining.map((row) => count(row.dataset)));
      const score = (row: PilotCandidate) =>
        (outcome === "failure" && !group.some((r) => r.failureProxy === row.failureProxy) ? 8 : 0) +
        (!group.some((r) => r.stageProxy === row.stageProxy) ? 4 : 0) +
        (!group.some((r) => r.dataset === row.dataset && r.policy === row.policy) ? 2 : 0) +
        (!group.some((r) => (r.attempts > 1) === (row.attempts > 1)) ? 1 : 0);
      const next = remaining.filter((row) => count(row.dataset) === minimum)
        .sort((a, b) => score(b) - score(a) || rank(a) - rank(b) || a.dataset.localeCompare(b.dataset) || a.episode - b.episode)[0];
      group.push(next);
    }
    selected.push(...group);
  }
  return selected.sort((a, b) => a.dataset.localeCompare(b.dataset) || a.episode - b.episode);
}
