/**
 * Recompute Policy Arena dataset summaries from authoritative episode parquet
 * metadata, then update Convex only after every selected dataset passes audit.
 *
 * Usage:
 *   bun run scripts/rebuild_dataset_stats.ts
 *   bun run scripts/rebuild_dataset_stats.ts ankile/repo-a ankile/repo-b
 */

import {
  fetchParquetMetadata,
  fetchSuccessStatus,
} from "../src/lib/hf-api";

const ARENA_URL = "https://grandiose-rook-292.convex.cloud";
const BATCH_SIZE = 6;

type RegisteredDataset = {
  repo_id: string;
  name: string;
};

type DatasetStats = {
  repo_id: string;
  num_episodes: number;
  total_duration_seconds: number;
  num_success: number;
  num_failure: number;
};

async function hasEpisodeMetadata(repoId: string): Promise<boolean> {
  const url =
    `https://huggingface.co/api/datasets/${repoId}/tree/main/meta/episodes` +
    "?recursive=true&expand=false&limit=1";
  const response = await fetch(url);
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Hugging Face metadata preflight returned ${response.status} for ${repoId}`);
  }
  return true;
}

async function convexRequest<T>(
  kind: "query" | "mutation",
  path: string,
  args: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`${ARENA_URL}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  if (!response.ok) {
    throw new Error(`Convex ${kind} ${path} returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as
    | { status: "success"; value: T }
    | { status: "error"; errorMessage: string };
  if (payload.status !== "success") {
    throw new Error(`Convex ${kind} ${path} failed: ${payload.errorMessage}`);
  }
  return payload.value;
}

async function computeStats(dataset: RegisteredDataset): Promise<DatasetStats> {
  const metadata = await fetchParquetMetadata(dataset.repo_id);
  const successMap = await fetchSuccessStatus(dataset.repo_id);
  const numSuccess = [...successMap.values()].filter(Boolean).length;
  const numEpisodes = metadata.episodes.length;
  if (successMap.size !== numEpisodes) {
    throw new Error(
      `${dataset.repo_id}: ${successMap.size} outcomes for ${numEpisodes} episodes`
    );
  }
  const totalDuration = metadata.episodes.reduce(
    (sum, episode) => sum + episode.duration,
    0
  );
  console.log(
    `[audit] ${dataset.repo_id}: ${numSuccess}/${numEpisodes} success, ` +
      `${totalDuration.toFixed(1)} effective seconds`
  );
  return {
    repo_id: dataset.repo_id,
    num_episodes: numEpisodes,
    total_duration_seconds: totalDuration,
    num_success: numSuccess,
    num_failure: numEpisodes - numSuccess,
  };
}

async function main() {
  const requested = new Set(Bun.argv.slice(2));
  const registered = await convexRequest<RegisteredDataset[]>(
    "query",
    "datasets:list",
    {}
  );
  const selected =
    requested.size === 0
      ? registered
      : registered.filter((dataset) => requested.has(dataset.repo_id));
  const found = new Set(selected.map((dataset) => dataset.repo_id));
  const missing = [...requested].filter((repoId) => !found.has(repoId));
  if (missing.length > 0) {
    throw new Error(`Datasets are not registered in Policy Arena: ${missing.join(", ")}`);
  }

  const available: RegisteredDataset[] = [];
  const unavailable: RegisteredDataset[] = [];
  for (let start = 0; start < selected.length; start += BATCH_SIZE) {
    const batch = selected.slice(start, start + BATCH_SIZE);
    const checks = await Promise.all(
      batch.map(async (dataset) => ({
        dataset,
        available: await hasEpisodeMetadata(dataset.repo_id),
      }))
    );
    for (const check of checks) {
      (check.available ? available : unavailable).push(check.dataset);
    }
  }
  if (requested.size > 0 && unavailable.length > 0) {
    throw new Error(
      `Requested datasets have no Hugging Face episode metadata: ` +
        unavailable.map((dataset) => dataset.repo_id).join(", ")
    );
  }
  for (const dataset of unavailable) {
    console.log(`[unavailable] ${dataset.repo_id}`);
  }

  console.log(`Auditing ${available.length} dataset(s) before any Convex writes`);
  const audited: DatasetStats[] = [];
  for (let start = 0; start < available.length; start += BATCH_SIZE) {
    const batch = available.slice(start, start + BATCH_SIZE);
    audited.push(...(await Promise.all(batch.map(computeStats))));
  }

  console.log(`Audit passed for all ${audited.length} dataset(s); updating Convex`);
  for (const stats of audited) {
    await convexRequest("mutation", "datasets:updateStats", stats);
    console.log(`[updated] ${stats.repo_id}`);
  }
}

await main();
