import type { Doc, Id } from "../convex/_generated/dataModel";
import previousSpec from "./data/routing_d1_v2.spec.json";
import previousRouting from "./data/routing_d1_v3.spec.json";
import previousMarker from "./data/marker_d2_v5.spec.json";
import previousSquare from "./data/square_d2_v4.spec.json";
import routing from "./data/routing_d1_v4.spec.json";
import marker from "./data/marker_d2_v6.spec.json";
import square from "./data/square_d2_v5.spec.json";

export const latestStagePreviews = { routing_d1: routing, marker_d2: marker, square_d2: square };
export type PreviewTask = keyof typeof latestStagePreviews;
const previewRows: Doc<"stageTaskSpecs">[] = [previousSpec, previousRouting, previousMarker, previousSquare, ...Object.values(latestStagePreviews)].map((candidate) => ({
  _id: `local-${candidate.taxonomy_version}` as Id<"stageTaskSpecs">,
  _creationTime: 0, exported_at: 0, live: false,
  task: candidate.task, taxonomy_version: candidate.taxonomy_version, taxonomy_hash: candidate.taxonomy_hash,
  spec: candidate, source: "local-stage-preview/v1",
}));

/** Local candidate only. Never demote the published live version or remap its
 * predictions/reviews to different stage semantics. No cloud writes occur. */
export function withLocalStagePreviews(task: string, rows: Doc<"stageTaskSpecs">[] | undefined) {
  if (rows === undefined) return rows;
  const missing = previewRows.filter((candidate) => candidate.task === task && !rows.some((row) => row.taxonomy_version === candidate.taxonomy_version));
  return missing.length ? [...rows, ...missing] : rows;
}

export function stagePreviewHref(task: PreviewTask, search: string) {
  const params = new URLSearchParams(search);
  params.set("schema", latestStagePreviews[task].taxonomy_version);
  params.set("prediction", "legacy");
  return `?${params}`;
}
