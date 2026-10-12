/** Release pins, not a second definition of stage semantics. See data/stage-review. */
export const stageReviewTasks = [
  { task: "marker_d2", name: "Marker", version: "trajectory-review/v1/marker_d2/v7", previousVersion: "trajectory-review/v1/marker_d2/v6" },
  { task: "square_d2", name: "Square nut", version: "trajectory-review/v1/square_d2/v6", previousVersion: "trajectory-review/v1/square_d2/v5" },
  { task: "routing_d1", name: "Routing", version: "trajectory-review/v1/routing_d1/v5", previousVersion: "trajectory-review/v1/routing_d1/v4" },
] as const;

export function stageReviewTask(task: string | undefined) {
  return stageReviewTasks.find((entry) => entry.task === task);
}
