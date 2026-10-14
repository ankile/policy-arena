import { expect, test } from "bun:test";
import {
  appendFeedback,
  comparisonEpisode,
  feedbackStorageKey,
  filterCases,
  freshVerdicts,
  latestFeedback,
  readFeedback,
  validateBundle,
  type ComparisonBundle,
  type Feedback,
} from "./labelComparison";

export function fixtureBundle(): ComparisonBundle {
  const tasks = ["marker_d2", "square_d2", "routing_d1"] as const;
  const definition = (task: (typeof tasks)[number]) => ({
    taskId: task,
    taxonomyVersion: `${task}/test`,
    displayName: task,
    stages: [0, 1, 2].map((index) => ({
      id: `s${index}`,
      index,
      name: `Stage ${index}`,
      description: "Positive milestone",
      entryCriteria: ["Visible evidence"],
      exclusions: ["A fleeting touch"],
    })),
    failureModes: [
      {
        id: "grasp_lost",
        name: "Grasp lost",
        description: "Lost after sustained control",
      },
      { id: "none", description: "Success" },
    ],
  });
  return {
    schema_version: "human-model-review-bundle/v1",
    comparison_sha256: "baseline",
    requested_models: ["requested"],
    resolved_models: ["reported"],
    selection_note: "Development set",
    tasks: Object.fromEntries(
      tasks.map((task) => [
        task,
        {
          definition: definition(task),
          system_prompt: "Pinned prompt",
          definition_sha256: "definition",
          reference_sha256: "reference",
        },
      ]),
    ) as ComparisonBundle["tasks"],
    cases: tasks.flatMap((task) =>
      Array.from({ length: 20 }, (_, episode) => {
        const dataset = `test/${task}`;
        const human = {
          task_success: false,
          failure_mode_id: "grasp_lost",
          max_stage_id: "s1",
          max_stage_index: 1,
          attempt_count: 1,
          stage_transitions: [
            {
              to_stage_id: "s1",
              to_stage_index: 1,
              attempt_index: 1,
              time_s: 1.25,
            },
          ],
        };
        return {
          sample_id: `${dataset}#episode=${episode}`,
          dataset,
          task_id: task,
          dataset_name: task,
          episode_index: episode,
          duration_s: 15,
          fps: 15,
          hf_revision: "revision",
          cameras: [
            {
              role: "SIDE",
              key: "side",
              start_s: 30,
              url: `https://huggingface.co/datasets/${dataset}/resolve/revision/video.mp4`,
            },
          ],
          human,
          predicted: { ...human, task_success: episode > 0 ? false : true },
          model: {
            stage_transitions: [{ ...human.stage_transitions[0], time_s: 2.5 }],
            notes: "Observed a grasp",
            confidence: "high",
            failure_events: [],
          },
          human_notes: "Gold note",
          matches: {
            success: episode > 0,
            failure_reason: true,
            furthest_stage: true,
          },
          all_match: episode > 0,
          definition_review_issues: [],
          raw_response: "{}",
          request_prompt: "Video only",
          response_model: "reported",
          attempt_sha256: "attempt",
          source_review: {
            id: "original",
            saved_at: 1,
            task_definition_sha256: "definition",
          },
        };
      }),
    ),
  };
}
function feedback(sampleId: string): Feedback {
  return {
    id: "review-1",
    saved_at: "2026-10-13T00:00:00Z",
    comparison_sha256: "baseline",
    sample_id: sampleId,
    task_id: "marker_d2",
    source_review_id: "original",
    attempt_sha256: "attempt",
    verdicts: { ...freshVerdicts(), success: "human" },
    note: "Use the wrist camera",
    evidence_times_s: [1.25],
  };
}
function storage() {
  const map = new Map<string, string>([
    ["policy-arena-stage-playground-v1", "do not modify"],
  ]);
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    map,
  };
}
test("all tasks, differences and per-field filters retain exact dataset identities", () => {
  const bundle = validateBundle(fixtureBundle());
  expect(filterCases(bundle, "all", "all", [])).toHaveLength(60);
  expect(filterCases(bundle, "all", "differences", [])).toHaveLength(3);
  expect(filterCases(bundle, "marker_d2", "success", [])).toHaveLength(1);
  expect(filterCases(bundle, "all", "failure_reason", [])).toHaveLength(0);
  const saved = feedback(bundle.cases[0].sample_id);
  expect(filterCases(bundle, "all", "unreviewed", [saved])).toHaveLength(2);
  expect(
    latestFeedback([saved], "other-baseline", saved.sample_id),
  ).toBeUndefined();
});
test("label flags and pinned media are verified, not trusted blindly", () => {
  const bundle = fixtureBundle();
  bundle.cases[0].matches.success = true;
  expect(() => validateBundle(bundle)).toThrow("flags");
  const media = fixtureBundle();
  media.cases[0].cameras[0].url = "https://example.com/video.mp4";
  expect(() => validateBundle(media)).toThrow("pinned");
  const duplicate = fixtureBundle();
  duplicate.cases[1] = duplicate.cases[0];
  expect(() => validateBundle(duplicate)).toThrow("identity");
});
test("playback uses each camera's offset and stops at the gold policy window", () => {
  const episode = comparisonEpisode(fixtureBundle().cases[0]);
  expect(episode.rawLength).toBe(225);
  expect(episode.perCamera.side).toEqual({
    fileIndex: 0,
    fromTimestamp: 30,
    toTimestamp: 45,
  });
});
test("feedback is append-only, baseline-bound and cannot overwrite original annotations", () => {
  const store = storage();
  const row = feedback("test/marker_d2#episode=0");
  appendFeedback(store, row);
  const revised = {
    ...row,
    id: "review-2",
    note: "Criteria need clarification",
  };
  appendFeedback(store, revised);
  expect(readFeedback(store)).toHaveLength(2);
  expect(
    latestFeedback(readFeedback(store), "baseline", row.sample_id),
  ).toEqual(revised);
  expect(store.map.get("policy-arena-stage-playground-v1")).toBe(
    "do not modify",
  );
  expect(() => appendFeedback(store, revised)).toThrow("Duplicate");
});
test("malformed feedback blocks writes rather than replacing existing history", () => {
  const store = storage();
  store.setItem(feedbackStorageKey, '{"bad":true}');
  expect(() =>
    appendFeedback(store, feedback("test/marker_d2#episode=0")),
  ).toThrow("malformed");
  expect(store.getItem(feedbackStorageKey)).toBe('{"bad":true}');
});
