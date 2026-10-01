import { latestStagePreviews, type PreviewTask } from "./localStagePreviews";

export type ReviewSample = {
  task: PreviewTask;
  taskName: string;
  datasetName: string;
  dataset: string;
  prediction?: string;
  schema?: string;
};

// A sample is a dataset, not a separate task or annotation mode. Keep the
// original dataset identities. New task navigation opens the latest candidate
// explicitly; existing URLs keep their original taxonomy and predictions/reviews.
export const reviewSamples: readonly ReviewSample[] = [
  { task: "routing_d1", taskName: "Routing", datasetName: "R8 · 3-arm evaluation", dataset: "ankile/real01b-routing-d1-r8-threearm-checkpoint100000-iql-g0997-n32-heldout-sobol50", prediction: "legacy", schema: latestStagePreviews.routing_d1.taxonomy_version },
  { task: "marker_d2", taskName: "Marker", datasetName: "R5 · repeat evaluation", dataset: "ankile/real01b-md2-r5-repeat-base-dp-filmtiidk4-c200k-n32-s2026070704", prediction: "legacy", schema: latestStagePreviews.marker_d2.taxonomy_version },
  { task: "square_d2", taskName: "Square nut", datasetName: "R5 · redo evaluation", dataset: "ankile/real01b-square-d2-r5-redo-base-dp-filmtiidk4-c200k-n32-s2026081801", prediction: "legacy", schema: latestStagePreviews.square_d2.taxonomy_version },
  { task: "routing_d1", taskName: "Routing", datasetName: "UMI-relative · 15-arm evaluation", dataset: "ankile/real01b-routing-d1-umirel-lineage-15arm-heldout-sobol50-s2026090701", prediction: "legacy", schema: latestStagePreviews.routing_d1.taxonomy_version },
];

export function reviewSampleHref(sample: ReviewSample) {
  return `?${new URLSearchParams({
    dataset: sample.dataset,
    episode: "0",
    ...(sample.prediction ? { prediction: sample.prediction } : {}),
    ...(sample.schema ? { schema: sample.schema } : {}),
  })}`;
}
