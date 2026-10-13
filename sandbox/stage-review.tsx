import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient, useQuery, usePaginatedQuery } from "convex/react";
import { getFunctionName, type FunctionArgs } from "convex/server";
import { convexToJson, type Value } from "convex/values";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import StageReview from "../src/components/StageReview";
import { stageReviewDataSource, type StageReviewDataSource } from "../src/lib/stageReviewDataSource";
import { stageReviewCoverage, SUPPORTED_REVIEW_PROTOCOLS } from "../convex/stageReviewCoverage";
import ReviewTaskNavigation from "./ReviewTaskNavigation";
import { allReviewSamples, latestReviewSearch } from "./stageReviewSamples";
import { withLocalStagePreviews, latestStagePreviews } from "./localStagePreviews";
import StagePreviewNotice from "./StagePreviewNotice";
import PilotQueue from "./PilotQueue";
import type { PilotEpisode } from "./pilotReviewStatus";
import pilot from "./data/stage-reference-pilot.json";
import { setSearchParams, useSearchParam } from "../src/lib/useSearchParam";
import { appendLocalReviews, localReviewStorageKey, readLocalReviews, type LocalReview } from "./localReviewStore";
import { planCarryForward } from "./carryForwardReviews";
import CarryForwardNotice from "./CarryForwardNotice";
import "../src/index.css";

// Browser-local entry: available in development and preview builds, not shared production.
// Reads use the public query API. There is deliberately no mutation client.
const client = new ConvexReactClient("https://grandiose-rook-292.convex.cloud");
let reviews: LocalReview[] = [];
let storageError: string | null = null;
try { reviews = readLocalReviews(localStorage); }
catch { storageError = "Saved playground data could not be read. Export browser storage before resetting it."; }
const listeners = new Set<() => void>();
let revision = 0;
let migrationRevision = 0;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const refresh = () => { revision++; listeners.forEach((listener) => listener()); };
window.addEventListener("storage", (event) => {
  if (event.key !== localReviewStorageKey) return;
  try { reviews = readLocalReviews(localStorage); storageError = null; }
  catch { storageError = "Saved playground data could not be read. Export browser storage before resetting it."; }
  refresh();
});
async function carryForwardReviews() {
  await navigator.locks.request(localReviewStorageKey, () => {
    if (storageError) throw new Error(storageError);
    const current = readLocalReviews(localStorage);
    const { additions } = planCarryForward(current);
    if (!additions.length) return;
    reviews = appendLocalReviews(localStorage, additions, true);
    migrationRevision++; refresh();
  });
}
const params = new URLSearchParams(window.location.search);
const startsInPilot = params.get("queue") === "pilot20" || !params.has("dataset");
const initialRow = pilot.episodes.find((row) => row.dataset === params.get("dataset") && String(row.episode) === params.get("episode"))
  ?? pilot.episodes.find((row) => row.dataset === params.get("dataset")) ?? pilot.episodes[0];
if (startsInPilot) {
  params.set("queue", "pilot20");
  params.set("dataset", initialRow.dataset);
  params.set("episode", String(initialRow.episode));
  params.set("prediction", "legacy");
}
const initialSample = allReviewSamples.find((s) => s.dataset === params.get("dataset"));
if (!initialSample) throw new Error("This dataset is not configured for the local playground. Open /sandbox/stage-review.html to choose a reference task.");
const latestSearch = latestReviewSearch(initialSample, `?${params}`);
if (latestSearch !== window.location.search) history.replaceState(null, "", `${location.pathname}${latestSearch}`);
const dataSource: StageReviewDataSource = {
  ...stageReviewDataSource,
  useQuery: ((query, args) => {
    useSyncExternalStore(subscribe, () => revision);
    const name = getFunctionName(query);
    const local = name === "users:viewer" || name === "stageReviews:latestForRepo";
    // The I/O boundary already supplies each query's matching argument type.
    const remote = useQuery(query, (local ? "skip" : args) as never);
    if (args === "skip") return undefined;
    if (name === "stageTaskSpecs:forTask") return withLocalStagePreviews(
      (args as { task: string }).task, remote as Doc<"stageTaskSpecs">[] | undefined);
    if (name === "users:viewer") return { userId: "local-reviewer", username: "Local playground", isEditor: true };
    if (name === "stageReviews:latestForRepo") {
      const filter = args as { dataset_repo: string; taxonomy_version: string };
      const latest = new Map<string, LocalReview>();
      for (const review of reviews) if (review.dataset_repo === filter.dataset_repo && review.taxonomy_version === filter.taxonomy_version) latest.set(String(review.episode_index), review);
      const episodes = [...latest.values()];
      return { episodes, supported_review_protocols: [...SUPPORTED_REVIEW_PROTOCOLS], num_confirmed: episodes.filter((r) => r.status === "confirmed").length, num_corrected: 0 };
    }
    return remote;
  }) as StageReviewDataSource["useQuery"],
  usePaginatedQuery,
  useMutation: ((mutation) => {
    if (getFunctionName(mutation) !== "stageReviews:save") throw new Error("Only local stage-review saves are supported in the playground.");
    return async (args: FunctionArgs<typeof api.stageReviews.save>) => {
      if (storageError) throw new Error(storageError);
      return navigator.locks.request(localReviewStorageKey, () => {
        const coverage = stageReviewCoverage(args.review_protocol, args.status, args.review_protocol !== undefined);
        const prior = readLocalReviews(localStorage).reverse().find((row) => row.dataset_repo === args.dataset_repo &&
          row.episode_index === args.episode_index && row.taxonomy_version === args.taxonomy_version);
        const review: LocalReview = { ...args, ...(coverage ? { review_coverage: coverage } : {}),
          ...(prior?.local_migration ? { local_migration: prior.local_migration } : {}),
          _id: `local-${crypto.randomUUID()}`, reviewer: "Local playground", reviewer_user_id: "local-reviewer", saved_at: Date.now() };
        reviews = appendLocalReviews(localStorage, [review]); refresh();
        return review._id;
      });
    };
  }) as StageReviewDataSource["useMutation"],
};

const pilotDataSource: StageReviewDataSource = {
  ...dataSource,
  // A reference set starts without model stage suggestions, even if a new
  // prediction is later published for the latest taxonomy.
  useQuery: ((query, args) => {
    const name = getFunctionName(query);
    const hidden = ["stagePrefills:forRepo", "stagePredictions:listForRepo"].includes(name);
    const value = dataSource.useQuery(query, (hidden ? "skip" : args) as never);
    if (args === "skip") return undefined;
    if (name === "stagePrefills:forRepo") return [];
    if (name === "stagePredictions:listForRepo") return {runs: [], active_run_id: null, legacy_count: 0};
    return value;
  }) as StageReviewDataSource["useQuery"],
  fetchReviewEpisodes: async (repo) => {
    const selected = new Set(pilot.episodes.filter((row) => row.dataset === repo).map((row) => row.episode));
    const episodes = (await dataSource.fetchReviewEpisodes(repo)).filter((row) => selected.has(row.episodeIndex));
    if (episodes.length !== selected.size) throw new Error("Reference episodes are missing from this dataset; rebuild the sample before labeling.");
    return episodes;
  },
};

function openPilot(row: PilotEpisode) {
  const sample = allReviewSamples.find((item) => item.dataset === row.dataset)!;
  setSearchParams({dataset: row.dataset, episode: String(row.episode), queue: "pilot20",
    schema: latestStagePreviews[sample.task].taxonomy_version, prediction: "legacy",
    sstatus: "all", sconf: null, sflag: null, sarm: null});
}

export default function Playground() {
  useSyncExternalStore(subscribe, () => revision);
  const [repo] = useSearchParam("dataset", initialSample!.dataset);
  const [queue] = useSearchParam("queue", "");
  const [episode] = useSearchParam("episode", "0");
  const sample = allReviewSamples.find((row) => row.dataset === repo);
  if (!sample) return <p role="alert">Unknown local dataset. Reopen the playground to choose a reference task.</p>;
  const isPilot = queue === "pilot20";
  return <main className="max-w-[1900px] mx-auto p-4 md:p-6">
    <div className="rounded-xl border border-teal/30 bg-teal/5 p-4 mb-4 flex flex-wrap items-center gap-4">
      <div className="flex-1 min-w-60"><h1 className="font-display text-xl">Stage Review · Local playground</h1>
        <p className="text-sm text-ink-muted">Saves stay in this browser. Shared labels are unchanged.</p></div>
      <button className="text-sm text-teal underline" onClick={() => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(convexToJson(reviews as unknown as Value), null, 2)], { type: "application/json" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = "stage-review-playground.json"; anchor.click(); URL.revokeObjectURL(url);
      }}>Export {reviews.length} local saves</button>
    </div>
    {storageError && <p role="alert" className="text-coral">{storageError}</p>}
    <StagePreviewNotice task={sample.task} />
    <StageReview key={`${sample.dataset}:${isPilot}:${migrationRevision}`} repoId={sample.dataset} task={sample.task} dataSource={isPilot ? pilotDataSource : dataSource}
      fixedTaxonomyVersion={latestStagePreviews[sample.task].taxonomy_version}
      renderQueueNavigation={(navigate) => <>
        <CarryForwardNotice reviews={reviews} current={[...reviews].reverse().find((row) => row.dataset_repo === sample.dataset &&
          String(row.episode_index) === episode && row.taxonomy_version === latestStagePreviews[sample.task].taxonomy_version)}
          onTransfer={async () => {
            let transfer: Promise<void> | undefined;
            await navigate(() => { transfer = carryForwardReviews(); });
            await transfer;
          }} />
        {isPilot
        ? <PilotQueue current={sample} saves={reviews} taxonomy={latestStagePreviews[sample.task].taxonomy_version}
            onSelect={(row) => navigate(() => openPilot(row))}
            onBrowse={() => navigate(() => setSearchParams({queue: "all"}))} />
        : <div className="p-4 flex flex-wrap items-center justify-between gap-4">
            <ReviewTaskNavigation current={sample} onSelect={(next) => navigate(() => setSearchParams({
              dataset: next.dataset, episode: "0", prediction: "legacy", schema: latestStagePreviews[next.task].taxonomy_version,
              sstatus: "all", sconf: null, sflag: null, sarm: null}))} />
            <button className="text-teal text-sm underline" onClick={() => navigate(() => openPilot(pilot.episodes.find((row) => row.task === sample.task)!))}>Open 20-episode reference set</button>
          </div>}
        </>}
      onExit={() => openPilot(pilot.episodes.find((row) => row.task === sample.task)!)}
      onOpenOutcomeReview={() => window.open(`https://policy-eval.ankile.com/?tab=explorer&dataset=${encodeURIComponent(sample.dataset)}&view=outcome`, "_blank", "noopener")} />
  </main>;
}

createRoot(document.getElementById("root")!).render(<ConvexProvider client={client}><Playground /></ConvexProvider>);
