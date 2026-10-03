import { expect, test } from "bun:test";
import { seedStageReview } from "./stagePredictionReview";
import { blankTrajectoryReview } from "../../convex/trajectoryReview";
import type { ExportedStageSpec } from "../../convex/stageConsistency";
import { latestStagePreviews } from "../../sandbox/localStagePreviews";

for (const spec of Object.values(latestStagePreviews)) {
  for (const outcome of ["success", "failure", "timeout"] as const) {
    test(`${spec.task}: ${outcome} prefills only the binary result under the latest definition`, () => {
      const emptyLabel = blankTrajectoryReview(spec.trajectory, "org/repo", 0);
      const before = structuredClone(emptyLabel);
      const seeded = seedStageReview({ spec: spec as ExportedStageSpec, outcome, legacy: true, emptyLabel });
      expect(seeded.label).toEqual({ ...before, task_success: outcome === "success" });
      expect(emptyLabel).toEqual(before);
      expect(seeded.inheritedSuccess).toBe(false); // No success-to-stage overlay.
    });

    test(`${spec.task}: ${outcome} overrides a disagreeing model result only in the editable review`, () => {
      const label = { ...blankTrajectoryReview(spec.trajectory, "org/repo", 0), task_success: outcome !== "success" };
      const before = structuredClone(label);
      const seeded = seedStageReview({ spec: spec as ExportedStageSpec, outcome, legacy: false, prediction: { label, attribution: {} } });
      expect(seeded.label).toEqual({ ...before, task_success: outcome === "success" });
      expect(label).toEqual(before);
    });
  }

  test(`${spec.task}: unknown outcomes do not guess, and saved human edits remain authoritative`, () => {
    const emptyLabel = blankTrajectoryReview(spec.trajectory, "org/repo", 0);
    for (const outcome of [null, "unknown", ""]) {
      expect(seedStageReview({ spec: spec as ExportedStageSpec, outcome, legacy: true, emptyLabel }).label).toEqual(emptyLabel);
    }
    for (const task_success of [true, false, null]) {
      const label = { ...emptyLabel, task_success };
      const seeded = seedStageReview({ spec: spec as ExportedStageSpec, outcome: "success", legacy: true,
        own: { label, attribution: {}, humanNotes: "Keep this judgment." } });
      expect(seeded.label).toEqual(label);
      expect(seeded.humanNotes).toBe("Keep this judgment.");
      expect(seeded.fromOwnReview).toBe(true);
    }
  });
}
