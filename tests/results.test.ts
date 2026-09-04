import { describe, expect, test } from "bun:test";

import {
  isResumedEvalPrefix,
  liveSubtaskFramesByEpisode,
  subtaskFramesForValidation,
} from "../convex/apply/results";

// Rollout rows as save_results_file writes them: live 'g' marks land in
// subtask_frames; an older row has no key at all.
function livePayload(): Record<string, unknown> {
  return {
    rollouts: [
      { episode_index: 0, outcome: "failure", num_steps: 10, subtask_frames: [4] },
      { episode_index: 1, outcome: "success", num_steps: 12, subtask_frames: [7, 7] },
      { episode_index: 2, outcome: "timeout", num_steps: 9, subtask_frames: [] },
      { episode_index: 3, outcome: "failure", num_steps: 8 },
    ],
  };
}

describe("live subtask marks from results.json", () => {
  test("reads rollout marks, dedupes, skips empty and absent", () => {
    expect([...liveSubtaskFramesByEpisode(livePayload())]).toEqual([
      [0, [4]],
      [1, [7]],
    ]);
    expect(liveSubtaskFramesByEpisode(null).size).toBe(0);
  });

  test("unreviewed episodes keep their live marks", () => {
    const out = subtaskFramesForValidation(
      { changed_episodes: {}, skipped_episodes: [] },
      livePayload()
    );
    expect([...out]).toEqual([
      [0, [4]],
      [1, [7]],
    ]);
  });

  test("the review record overrides live marks per episode", () => {
    const progress = {
      changed_episodes: {
        // Reviewed with a MOVED mark: the record wins over the live frame.
        "0": { new_outcome: "failure" as const, outcome_frame: 9, soft_truncate: false, subtask_frames: [5] },
        // Reviewed, marks cleared: apply zeroed the live spike, so none tolerated.
        "1": { new_outcome: "failure" as const, outcome_frame: 11, soft_truncate: false, subtask_frames: [] },
        // Pre-subtask record (no key): same as cleared.
        "3": { new_outcome: "failure" as const, outcome_frame: 7, soft_truncate: false },
      },
      skipped_episodes: [],
    };
    expect([...subtaskFramesForValidation(progress, livePayload())]).toEqual([[0, [5]]]);
    // Record-only (collection datasets have no results.json).
    expect([...subtaskFramesForValidation(progress, null)]).toEqual([[0, [5]]]);
  });
});

describe("resumed eval prefix", () => {
  const rollout = (ep: number) => ({ episode_index: ep, policy_id: 0, outcome: "failure", num_steps: 5 });
  const current = () => ({
    dataset_name: "same-eval",
    arena_session_id: "session-1",
    timestamp: "finished",
    summary: [{ policy_id: 0, num_rounds: 2 }],
    rollouts: [rollout(0), rollout(1)],
    arena_submitted_round_indices: [0, 1],
    args: { environment: "routing_d1", arena_session_status: "testing" },
  });
  const previous = () => ({
    ...current(),
    timestamp: "checkpoint",
    summary: [{ policy_id: 0, num_rounds: 1 }],
    rollouts: [rollout(0)],
    arena_submitted_round_indices: [0],
    args: { environment: "routing_d1" },
  });

  test("tolerates a CLI key added to args by the resuming build", () => {
    expect(isResumedEvalPrefix(previous(), current())).toBe(true);
  });

  test("a shared args key with a different value is a different run", () => {
    const prev = previous();
    prev.args = { environment: "marker_d2" };
    expect(isResumedEvalPrefix(prev, current())).toBe(false);
  });

  test("a diverging rollout prefix is not a resume", () => {
    const prev = previous();
    prev.rollouts = [{ ...rollout(0), outcome: "success" }];
    expect(isResumedEvalPrefix(prev, current())).toBe(false);
  });
});
