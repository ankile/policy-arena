import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient, useQuery, usePaginatedQuery } from "convex/react";
import { getFunctionName, type FunctionArgs } from "convex/server";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { api } from "../convex/_generated/api";
import StageReview from "../src/components/StageReview";
import { stageReviewDataSource, type StageReviewDataSource } from "../src/lib/stageReviewDataSource";
import { stageReviewCoverage } from "../convex/stageReviewCoverage";
import "../src/index.css";

// Development-only entry, not an input to the production Vite build.
// Reads use the public query API. There is deliberately no mutation client.
const client = new ConvexReactClient("https://grandiose-rook-292.convex.cloud");
const storageKey = "policy-arena-stage-playground-v1";
type Saved = FunctionArgs<typeof api.stageReviews.save> & {
  _id: string; reviewer: string; reviewer_user_id: string; saved_at: number;
  review_coverage?: ReturnType<typeof stageReviewCoverage>;
};
const stored = localStorage.getItem(storageKey);
let reviews: Saved[] = [];
let storageError: string | null = null;
try { reviews = stored ? jsonToConvex(JSON.parse(stored)) as unknown as Saved[] : []; }
catch { storageError = "Saved playground data could not be read. Export browser storage before resetting it."; }
const listeners = new Set<() => void>();
let revision = 0;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const refresh = () => { revision++; listeners.forEach((listener) => listener()); };
const samples = [
  { task: "routing_d1", name: "Routing", dataset: "ankile/real01b-routing-d1-r8-threearm-checkpoint100000-iql-g0997-n32-heldout-sobol50", prediction: "n17a1n9nvncnxcmmnczd4z65x98dv3d7" },
  { task: "marker_d2", name: "Marker", dataset: "ankile/real01b-md2-r5-repeat-base-dp-filmtiidk4-c200k-n32-s2026070704" },
  { task: "square_d2", name: "Square nut", dataset: "ankile/real01b-square-d2-r5-redo-base-dp-filmtiidk4-c200k-n32-s2026081801" },
  { task: "routing_d1", name: "Routing · manual", dataset: "ankile/real01b-routing-d1-umirel-lineage-15arm-heldout-sobol50-s2026090701", prediction: "legacy" },
];
const params = new URLSearchParams(window.location.search);
const sample = samples.find((s) => s.dataset === params.get("dataset")) ?? samples[0];
if (!params.has("dataset")) {
  params.set("dataset", sample.dataset); params.set("episode", "0");
  if (sample.prediction) params.set("prediction", sample.prediction);
  history.replaceState(null, "", `${location.pathname}?${params}`);
}
const dataSource: StageReviewDataSource = {
  ...stageReviewDataSource,
  useQuery: ((query, args) => {
    useSyncExternalStore(subscribe, () => revision);
    const name = getFunctionName(query);
    const local = name === "users:viewer" || name === "stageReviews:latestForRepo";
    // The I/O boundary already supplies each query's matching argument type.
    const remote = useQuery(query, (local ? "skip" : args) as never);
    if (args === "skip") return undefined;
    if (name === "users:viewer") return { userId: "local-reviewer", username: "Local playground", isEditor: true };
    if (name === "stageReviews:latestForRepo") {
      const filter = args as { dataset_repo: string; taxonomy_version: string };
      const latest = new Map<string, Saved>();
      for (const review of reviews) if (review.dataset_repo === filter.dataset_repo && review.taxonomy_version === filter.taxonomy_version) latest.set(String(review.episode_index), review);
      const episodes = [...latest.values()];
      return { episodes, num_confirmed: episodes.filter((r) => r.status === "confirmed").length, num_corrected: 0 };
    }
    return remote;
  }) as StageReviewDataSource["useQuery"],
  usePaginatedQuery,
  useMutation: ((mutation) => {
    if (getFunctionName(mutation) !== "stageReviews:save") throw new Error("Only local stage-review saves are supported in the playground.");
    return async (args: FunctionArgs<typeof api.stageReviews.save>) => {
      if (storageError) throw new Error(storageError);
      const coverage = stageReviewCoverage(args.review_protocol, args.status, args.review_protocol !== undefined);
      const review: Saved = { ...args, ...(coverage ? { review_coverage: coverage } : {}), _id: `local-${crypto.randomUUID()}`, reviewer: "Local playground", reviewer_user_id: "local-reviewer", saved_at: Date.now() };
      const next = [...reviews, review];
      localStorage.setItem(storageKey, JSON.stringify(convexToJson(next as unknown as Value)));
      reviews = next; refresh();
      return review._id;
    };
  }) as StageReviewDataSource["useMutation"],
};

export default function Playground() {
  useSyncExternalStore(subscribe, () => revision);
  return <main className="max-w-[1900px] mx-auto p-4 md:p-6">
    <div className="rounded-xl border border-teal/30 bg-teal/5 p-4 mb-4 flex flex-wrap items-center gap-4">
      <div className="flex-1 min-w-60"><h1 className="font-display text-xl">Stage Review · Local playground</h1>
        <p className="text-sm text-ink-muted">Real videos and imported predictions. Trial labels save only in this browser; shared labels stay untouched. No sign-in needed.</p></div>
      <nav className="flex flex-wrap gap-2" aria-label="Try a task">{samples.map((s) => {
        const search = new URLSearchParams({ dataset: s.dataset, episode: "0", ...(s.prediction ? { prediction: s.prediction } : {}) });
        return <a key={s.dataset} className={`px-3 py-2 rounded-lg border text-sm ${s === sample ? "bg-teal text-white" : "bg-white border-warm-200"}`} href={`?${search}`}>{s.name}</a>;
      })}</nav>
      <button className="text-sm text-teal underline" onClick={() => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(convexToJson(reviews as unknown as Value), null, 2)], { type: "application/json" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = "stage-review-playground.json"; anchor.click(); URL.revokeObjectURL(url);
      }}>Export {reviews.length} local saves</button>
    </div>
    {storageError && <p role="alert" className="text-coral">{storageError}</p>}
    <StageReview repoId={sample.dataset} task={sample.task} dataSource={dataSource}
      onExit={() => { window.location.href = "/sandbox/stage-review.html"; }}
      onOpenOutcomeReview={() => window.open(`https://policy-eval.ankile.com/?tab=explorer&dataset=${encodeURIComponent(sample.dataset)}&view=outcome`, "_blank", "noopener")} />
  </main>;
}

createRoot(document.getElementById("root")!).render(<ConvexProvider client={client}><Playground /></ConvexProvider>);
