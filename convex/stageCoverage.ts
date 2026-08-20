/**
 * Live stage-label coverage aggregates — the data behind the Coverage tab.
 *
 * Everything is computed from the reactive tables (stageTaskSpecs +
 * stagePrefills + stageReviews + datasets), so the dashboard reflects every
 * prefill push and review save immediately. Per (episode, schema) the
 * "current label" follows the phase-2 fold: latest COMMITTED review
 * (confirmed | corrected, across reviewers) beats the latest pipeline
 * prefill.
 *
 * Scale note: this query collect()s the full stagePrefills table (~2.7k docs
 * as of 2026-08-20). Convex's per-transaction read budget comfortably holds
 * that; if the suite grows near ~10k prefills, add a by_task index and
 * per-task pagination before it bites.
 */
import { query } from "./_generated/server";
import { isNewer, reviewerKey } from "./stageReviews";

type StageHist = number[];

function emptyHist(nStages: number): StageHist {
  return Array.from({ length: nStages }, () => 0);
}

function stageOf(label: Record<string, unknown> | undefined, stageField: string): number | null {
  const raw = label?.[stageField];
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "bigint") return Number(raw);
  // Convex numbers arrive as float64; accept integral floats, reject the rest.
  if (typeof raw === "number" && raw % 1 === 0) return raw;
  return null;
}

export const overview = query({
  args: {},
  handler: async (ctx) => {
    const liveSpecs = (await ctx.db.query("stageTaskSpecs").collect()).filter((s) => s.live);
    const datasets = await ctx.db.query("datasets").collect();
    const numEpisodes = new Map<string, number | null>(
      datasets.map((d) => [d.repo_id, d.num_episodes == null ? null : Number(d.num_episodes)])
    );
    const allPrefills = await ctx.db.query("stagePrefills").collect();
    const allReviews = await ctx.db.query("stageReviews").collect();

    const tasks = [];
    for (const specRow of liveSpecs) {
      const spec = specRow.spec as {
        stage_field: string;
        ladder: { max_stage: number };
      };
      const stageField = spec.stage_field;
      const nStages = spec.ladder.max_stage + 1;
      const tax = specRow.taxonomy_version;

      const prefills = allPrefills.filter(
        (p) => p.task === specRow.task && p.taxonomy_version === tax
      );
      const reviews = allReviews.filter(
        (r) => r.task === specRow.task && r.taxonomy_version === tax
      );

      // Latest review per (repo, episode, reviewer); cleared folds out.
      const latestPerReviewer = new Map<string, (typeof reviews)[number]>();
      for (const row of reviews) {
        const key = `${row.dataset_repo}|${row.episode_index}|${reviewerKey(row)}`;
        const prev = latestPerReviewer.get(key);
        if (prev === undefined || isNewer(row, prev)) latestPerReviewer.set(key, row);
      }
      const folded = [...latestPerReviewer.values()].filter((r) => r.status !== "cleared");

      // Latest committed row per (repo, episode) across reviewers — the
      // human side of the current-label fold.
      const committedByEp = new Map<string, (typeof reviews)[number]>();
      for (const row of folded) {
        if (row.status !== "confirmed" && row.status !== "corrected") continue;
        const key = `${row.dataset_repo}|${row.episode_index}`;
        const prev = committedByEp.get(key);
        if (prev === undefined || isNewer(row, prev)) committedByEp.set(key, row);
      }

      const prefillByEp = new Map<string, (typeof prefills)[number]>();
      for (const p of prefills) prefillByEp.set(`${p.dataset_repo}|${p.episode_index}`, p);

      // Per-repo coverage rows.
      const repoNames = [
        ...new Set([...prefills.map((p) => p.dataset_repo), ...folded.map((r) => r.dataset_repo)]),
      ].sort();
      const repos = repoNames.map((repo) => {
        const rPrefills = prefills.filter((p) => p.dataset_repo === repo);
        const rFolded = folded.filter((r) => r.dataset_repo === repo);
        const committedEps = new Set(
          rFolded
            .filter((r) => r.status === "confirmed" || r.status === "corrected")
            .map((r) => String(r.episode_index))
        );
        const prefillEps = new Set(rPrefills.map((p) => String(p.episode_index)));
        const count = (status: string) => rFolded.filter((r) => r.status === status).length;
        return {
          repo,
          num_episodes: numEpisodes.get(repo) ?? null,
          n_prefill: rPrefills.length,
          n_flagged: rPrefills.filter((p) => (p.violation_codes ?? []).length > 0).length,
          n_committed: committedEps.size,
          n_uncertain: count("uncertain"),
          n_draft: count("draft"),
          n_vlm_only: [...prefillEps].filter((e) => !committedEps.has(e)).length,
          n_human_only: [...committedEps].filter((e) => !prefillEps.has(e)).length,
        };
      });

      // Stage histograms: current labels (committed > prefill) + committed-only.
      const currentHist = emptyHist(nStages);
      const committedHist = emptyHist(nStages);
      let unknownStage = 0;
      const allEps = new Set([...prefillByEp.keys(), ...committedByEp.keys()]);
      for (const key of allEps) {
        const committed = committedByEp.get(key);
        const label = (committed?.label ?? prefillByEp.get(key)?.label) as
          | Record<string, unknown>
          | undefined;
        const s = stageOf(label, stageField);
        if (s === null || s < 0 || s >= nStages) {
          unknownStage += 1;
          continue;
        }
        currentHist[s] += 1;
        if (committed !== undefined) committedHist[s] += 1;
      }

      // Pipeline volume (prefills are already one operative row per episode).
      const pipelineCounts = new Map<string, { name: string; version: string; model: string; n: number }>();
      for (const p of prefills) {
        const model = String((p.evidence as { model?: unknown })?.model ?? "unknown");
        const key = `${p.pipeline.name}@${p.pipeline.version}|${model}`;
        const entry = pipelineCounts.get(key) ?? {
          name: p.pipeline.name,
          version: p.pipeline.version,
          model,
          n: 0,
        };
        entry.n += 1;
        pipelineCounts.set(key, entry);
      }

      // Reviewer activity over the folded (latest, non-cleared) rows.
      const reviewerCounts = new Map<string, { reviewer: string; committed: number; uncertain: number; draft: number }>();
      for (const r of folded) {
        const entry = reviewerCounts.get(r.reviewer) ?? {
          reviewer: r.reviewer,
          committed: 0,
          uncertain: 0,
          draft: 0,
        };
        if (r.status === "confirmed" || r.status === "corrected") entry.committed += 1;
        else if (r.status === "uncertain") entry.uncertain += 1;
        else if (r.status === "draft") entry.draft += 1;
        reviewerCounts.set(r.reviewer, entry);
      }

      tasks.push({
        task: specRow.task,
        taxonomy_version: tax,
        stage_field: stageField,
        n_stages: nStages,
        repos,
        pipelines: [...pipelineCounts.values()].sort((a, b) => b.n - a.n),
        reviewers: [...reviewerCounts.values()].sort((a, b) => b.committed - a.committed),
        stage_hist_current: currentHist,
        stage_hist_committed: committedHist,
        n_unknown_stage: unknownStage,
      });
    }
    tasks.sort((a, b) => a.task.localeCompare(b.task));
    return { tasks, generated_at: Date.now() };
  },
});
