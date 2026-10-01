import { describe, expect, test } from "bun:test";
import { canonicalDigest } from "../convex/stagePredictionContract";
import { blankTrajectoryReview, trajectoryTaskDefinitionDigest } from "../convex/trajectoryReview";
import { prepareStageOutcomeLabel, validateStageOutcomeReview } from "../convex/stageOutcomeReview";
import { normalizeStageSpec } from "../src/lib/stage-spec";
import { patchStageMark } from "../src/lib/stageTimeline";
import { latestStagePreviews } from "./localStagePreviews";
import previousMarker from "./data/marker_d2_v5.spec.json";
import previousSquare from "./data/square_d2_v4.spec.json";
import previousRouting from "./data/routing_d1_v3.spec.json";

for (const [previous, spec] of [[previousMarker, latestStagePreviews.marker_d2], [previousSquare, latestStagePreviews.square_d2], [previousRouting, latestStagePreviews.routing_d1]]) {
  describe(spec.taxonomy_version, () => {
    const schema = normalizeStageSpec(spec).trajectory!;
    const definition = schema.task_definition;
    test("failure revisions preserve stages/actions and keep both hashes and envelope vocabularies coherent", async () => {
      expect(definition.stages).toEqual(previous.trajectory.task_definition.stages);
      expect(definition.keyActions).toEqual(previous.trajectory.task_definition.keyActions);
      expect(spec.failure_modes).toEqual(definition.failureModes.map((mode) => mode.id));
      expect(spec.final_states).toEqual(definition.finalStates.map((state) => state.id));
      expect(definition.successDefinition.successfulFinalStateIds).toContain(spec.success_final_state);
      expect(spec.trajectory.response_schema.properties.primary_failure.properties.failure_mode_id.enum).toEqual(spec.failure_modes);
      expect(spec.trajectory.response_schema.properties.final_state_id.enum).toEqual(spec.final_states);
      expect(await trajectoryTaskDefinitionDigest(definition)).toBe(spec.trajectory.task_definition_sha256);
      const { taxonomy_hash, ...content } = spec;
      expect(await canonicalDigest(content)).toBe(taxonomy_hash);
    });
    test("human failure choices remain separate from historical maximum and hidden actions", () => {
      let row = blankTrajectoryReview(schema, "org/data", 0);
      const hidden = structuredClone(row.key_action_observations);
      const last = definition.stages.at(-1)!;
      row = patchStageMark(schema, row, null, last.id, last.index, 1);
      for (const failure_mode of spec.failure_modes.filter((mode) => mode !== "none")) {
        const failure = prepareStageOutcomeLabel(schema, { ...row, task_success: false, final_state: spec.final_states[0], failure_mode });
        expect(validateStageOutcomeReview(schema, failure, 30)).toEqual([]);
        expect(failure.key_action_observations).toEqual(hidden);
        expect(failure.max_stage).toBe(last.index);
      }
    });
  });
}

test("Routing S9 can succeed held, while S10 can fail because the first clip lost its seat", () => {
  const schema = normalizeStageSpec(latestStagePreviews.routing_d1).trajectory!;
  let row = patchStageMark(schema, blankTrajectoryReview(schema, "org/routing", 0), null, "second_clip_engaged", 1, 1);
  row = prepareStageOutcomeLabel(schema, { ...row, task_success: true, final_state: "rope_in_both_clips_held" });
  expect(validateStageOutcomeReview(schema, row, 30)).toEqual([]);
  row = patchStageMark(schema, row, null, "final_rope_released", 2, 1);
  row = { ...row, task_success: false, final_state: "rope_in_second_clip_released", failure_mode: "first_clip_seat_lost" };
  expect(validateStageOutcomeReview(schema, row, 30)).toEqual([]);
  expect(validateStageOutcomeReview(schema, { ...row, failure_mode: "first_clip_unseated_after_seating" }, 30).length).toBeGreaterThan(0);
});
