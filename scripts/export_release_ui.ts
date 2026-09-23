/** Read-only metadata snapshot for the original Arena components. No live results override the release. */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { readFileSync, writeFileSync } from "node:fs";
import { validateRelease } from "../src/release/types";
const [input, output, backend] = process.argv.slice(2);
if (!input || !output || !backend)
  throw new Error(
    "Usage: bun scripts/export_release_ui.ts RELEASE_JSON OUTPUT_JSON CONVEX_URL",
  );
const release = validateRelease(JSON.parse(readFileSync(input, "utf8")));
const client = new ConvexHttpClient(backend);
const [datasets, sessions] = await Promise.all([
  client.query(api.datasets.list, {}),
  client.query(api.evalSessions.list, {}),
]);
const map = new Map(release.datasets.map((d) => [d.source, d.id]));
const rows = release.datasets.map((d) => {
  const row = datasets.find((r) => r.repo_id === d.source);
  return {
    repo: d.id,
    created: row?._creationTime ?? Date.parse(release.version.slice(0, 10)),
    sourceType:
      d.role === "evaluation"
        ? "eval"
        : d.role === "policy-rollouts"
          ? "rollout"
          : d.id.includes("teleop")
            ? "teleop"
            : "dagger",
  };
});
const blocks = release.tasks.flatMap((t) =>
  t.blocks.map((b) => {
    const s = sessions.find((s) => s.dataset_repo === b.source);
    if (!s) throw new Error(`Missing source session: ${b.source}`);
    return {
      id: b.id,
      created: s._creationTime,
      mode: s.session_mode ?? "manual",
    };
  }),
);
const coverage = [];
for (const task of release.tasks.filter((t) => t.domain === "real")) {
  const sourceTask = datasets.find(
    (d) => d.repo_id === task.blocks[0].source,
  )?.task;
  if (!sourceTask) throw new Error(`Missing source task: ${task.id}`);
  const c = await client.query(api.stageCoverage.forTask, {
    task: sourceTask,
    includeAll: true,
  });
  if (!c) throw new Error(`Missing coverage: ${task.id}`);
  coverage.push({
    task: task.id,
    taxonomy_version: c.taxonomy_version,
    generated_at: c.generated_at,
    repos: c.repos
      .filter((r) => map.has(r.repo))
      .map((r) => ({ ...r, repo: map.get(r.repo)! })),
  });
}
const result = {
  selectionSha256: release.selectionSha256,
  datasets: rows,
  blocks,
  coverage,
};
writeFileSync(
  output,
  JSON.stringify(
    result,
    (_k, v) => (typeof v === "bigint" ? Number(v) : v),
    2,
  ) + "\n",
);
console.log(
  `Exported ${rows.length} dataset identities, ${blocks.length} session dates, ${coverage.reduce((n, c) => n + c.repos.length, 0)} scoped coverage rows`,
);
