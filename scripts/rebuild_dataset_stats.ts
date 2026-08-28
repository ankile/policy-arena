/**
 * Queue authoritative Policy Arena dataset-summary refreshes in Convex and
 * wait for every selected dataset to finish.
 *
 * The Convex worker pins each computation to the current Hugging Face commit
 * SHA and reads meta/episodes parquet statistics. This script is the manual
 * reconciliation path for Hub changes made outside dataset registration and
 * the native outcome-review apply worker.
 *
 * Usage:
 *   bun run scripts/rebuild_dataset_stats.ts
 *   bun run scripts/rebuild_dataset_stats.ts ankile/repo-a ankile/repo-b
 */

const ARENA_URL = "https://grandiose-rook-292.convex.cloud";
const BATCH_SIZE = 6;
const POLL_INTERVAL_MS = 2000;
const REFRESH_TIMEOUT_MS = 10 * 60 * 1000;

type RegisteredDataset = {
  repo_id: string;
  name: string;
  stats_status?: "pending" | "ready" | "error";
  stats_hf_sha?: string;
  stats_error?: string;
  stats_refresh_requested_at?: number;
};

async function loadServiceToken(): Promise<string> {
  const envToken = process.env.POLICY_ARENA_TOKEN?.trim();
  if (envToken) return envToken;
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set and POLICY_ARENA_TOKEN is absent");
  const tokenFile = Bun.file(`${home}/.config/sir/policy_arena_token`);
  if (!(await tokenFile.exists())) {
    throw new Error(
      "No arena service token found. Set POLICY_ARENA_TOKEN or create ~/.config/sir/policy_arena_token"
    );
  }
  const token = (await tokenFile.text()).trim();
  if (!token) throw new Error("Arena service token file is empty");
  return token;
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

async function waitForBatch(
  datasets: RegisteredDataset[],
  requestedAt: Map<string, number>
): Promise<void> {
  const pending = new Map(datasets.map((dataset) => [dataset.repo_id, dataset]));
  const deadline = Date.now() + REFRESH_TIMEOUT_MS;
  while (pending.size > 0) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for dataset stats: ${[...pending.keys()].join(", ")}`);
    }
    const rows = await Promise.all(
      [...pending.keys()].map((repoId) =>
        convexRequest<RegisteredDataset | null>("query", "datasets:getByRepo", {
          repo_id: repoId,
        })
      )
    );
    for (const row of rows) {
      if (row === null) throw new Error("A registered dataset disappeared during refresh");
      if (row.stats_status === "error") {
        throw new Error(`${row.repo_id}: ${row.stats_error ?? "stats refresh failed"}`);
      }
      if (
        row.stats_status === "ready" &&
        row.stats_refresh_requested_at === undefined
      ) {
        console.log(`[ready] ${row.repo_id} @ ${row.stats_hf_sha?.slice(0, 8)}`);
        pending.delete(row.repo_id);
      } else if (
        row.stats_refresh_requested_at !== undefined &&
        row.stats_refresh_requested_at !== requestedAt.get(row.repo_id)
      ) {
        throw new Error(`${row.repo_id}: another stats refresh replaced this request`);
      }
    }
    if (pending.size > 0) await Bun.sleep(POLL_INTERVAL_MS);
  }
}

async function main(): Promise<void> {
  const requested = new Set(Bun.argv.slice(2));
  const token = await loadServiceToken();
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

  console.log(`Refreshing ${selected.length} dataset(s) in batches of ${BATCH_SIZE}`);
  for (let start = 0; start < selected.length; start += BATCH_SIZE) {
    const batch = selected.slice(start, start + BATCH_SIZE);
    const requestedAt = new Map<string, number>();
    for (const dataset of batch) {
      const timestamp = await convexRequest<number>("mutation", "datasets:refreshStats", {
        repo_id: dataset.repo_id,
        serviceToken: token,
      });
      requestedAt.set(dataset.repo_id, timestamp);
      console.log(`[queued] ${dataset.repo_id}`);
    }
    await waitForBatch(batch, requestedAt);
  }
}

await main();
