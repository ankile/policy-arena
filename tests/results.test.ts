import { describe, expect, test } from "bun:test";

import {
  canonicalizeResultsTexts,
  isResumedEvalPrefix,
  liveMarksPayload,
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
    arena_submitted_rollouts: [[0, 0], [1, 0]],
    phase_stops: [{ visit_id: "first" }, { visit_id: "second" }],
    args: { environment: "routing_d1", arena_session_status: "testing" },
  });
  const previous = () => ({
    ...current(),
    timestamp: "checkpoint",
    summary: [{ policy_id: 0, num_rounds: 1 }],
    rollouts: [rollout(0)],
    arena_submitted_round_indices: [0],
    arena_submitted_rollouts: [[0, 0]],
    phase_stops: [{ visit_id: "first" }],
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

  test("rejects modified or removed submission and phase-stop history", () => {
    for (const key of ["arena_submitted_rollouts", "phase_stops"] as const) {
      const modified = current();
      modified[key].reverse();
      expect(isResumedEvalPrefix(previous(), modified)).toBe(false);
      const removed = current();
      removed[key] = [];
      expect(isResumedEvalPrefix(previous(), removed)).toBe(false);
    }
  });

  test("advances the raw backup on resume and preserves it on repeat apply", () => {
    const args = {
      resultsText: JSON.stringify(current()),
      existingBackupText: JSON.stringify(previous()),
      progressRecord: {
        changed_episodes: {
          "0": { new_outcome: "success" as const, outcome_frame: 3, soft_truncate: true },
        },
        skipped_episodes: [],
      },
      overridesFilename: ".outcome_edit_progress.json",
      frameOutcomes: new Map([
        [0, { outcome: "success" as const, expectedNumSteps: 4 }],
        [1, { outcome: "failure" as const, expectedNumSteps: 5 }],
      ]),
    };
    const first = canonicalizeResultsTexts(args);
    expect(JSON.parse(first.backupText!)).toEqual(current());
    expect(JSON.parse(first.resultsText!).rollouts[0].outcome).toBe("success");
    const second = canonicalizeResultsTexts({
      ...args, resultsText: first.resultsText!, existingBackupText: first.backupText,
    });
    expect(second.resultsText).toBeNull();
    expect(second.backupText).toBeNull();
  });

  test("a diverging rollout prefix is not a resume", () => {
    const prev = previous();
    prev.rollouts = [{ ...rollout(0), outcome: "success" }];
    expect(isResumedEvalPrefix(prev, current())).toBe(false);
  });
});

describe("results.json subtask_frames canonicalization", () => {
  // Live eval-time marks: ep0 mark at 4, ep1 at 7, ep2 empty key, ep3 keyless.
  const raw = () => ({
    dataset_name: "eval",
    summary: [{ policy_id: 0, num_rounds: 5, successes: 1, failures: 4, success_rate: 0.2 }],
    rollouts: [
      { episode_index: 0, policy_id: 0, outcome: "failure", num_steps: 10, subtask_frames: [4] },
      { episode_index: 1, policy_id: 0, outcome: "success", num_steps: 12, subtask_frames: [7] },
      { episode_index: 2, policy_id: 0, outcome: "failure", num_steps: 9, subtask_frames: [] },
      { episode_index: 3, policy_id: 0, outcome: "failure", num_steps: 8 },
      { episode_index: 4, policy_id: 0, outcome: "failure", num_steps: 6, subtask_frames: [2] },
    ],
  });
  const progress = () => ({
    changed_episodes: {
      // Live mark deliberately removed (the routing "second clip only" case).
      "0": { new_outcome: "failure" as const, outcome_frame: 9, soft_truncate: false, subtask_frames: [] },
      // Mark moved, duplicates in a hand-edited record collapse.
      "1": { new_outcome: "success" as const, outcome_frame: 11, soft_truncate: false, subtask_frames: [6, 6] },
      // Mark added to a rollout that had none (keyless row gains the key).
      "3": { new_outcome: "failure" as const, outcome_frame: 7, soft_truncate: false, subtask_frames: [3] },
      // Same marks as live: no patch.
      "4": { new_outcome: "failure" as const, outcome_frame: 5, soft_truncate: false, subtask_frames: [2] },
    },
    skipped_episodes: [],
  });
  const frameOutcomes = new Map([
    [0, { outcome: "failure" as const, expectedNumSteps: 10 }],
    [1, { outcome: "success" as const, expectedNumSteps: 12 }],
    [2, { outcome: "failure" as const, expectedNumSteps: 9 }],
    [3, { outcome: "failure" as const, expectedNumSteps: 8 }],
    [4, { outcome: "failure" as const, expectedNumSteps: 6 }],
  ]);
  const canon = (resultsText: string, existingBackupText: string | null, record = progress()) =>
    canonicalizeResultsTexts({
      resultsText,
      existingBackupText,
      progressRecord: record,
      overridesFilename: ".outcome_edit_progress.json",
      frameOutcomes,
    });

  test("reviewed rollouts take the record's marks; unreviewed keep live; backup keeps live", () => {
    const out = canon(JSON.stringify(raw()), null);
    const rollouts = JSON.parse(out.resultsText!).rollouts;
    expect(rollouts.map((r: Record<string, unknown>) => r.subtask_frames)).toEqual([
      [],
      [6],
      [],
      [3],
      [2],
    ]);
    expect(JSON.parse(out.backupText!)).toEqual(raw());
    expect(out.reconciliation!.subtask_frames_patches).toBe(3);
    expect(JSON.parse(out.resultsText!)._outcome_edit_reconciliation.subtask_frames_patches).toBe(3);
  });

  test("a record without the key canonicalizes to no marks; keyless no-mark rows stay keyless", () => {
    const record = {
      changed_episodes: {
        "0": { new_outcome: "failure" as const, outcome_frame: 9, soft_truncate: false },
        "3": { new_outcome: "failure" as const, outcome_frame: 7, soft_truncate: false },
      },
      skipped_episodes: [],
    };
    const rollouts = JSON.parse(canon(JSON.stringify(raw()), null, record).resultsText!).rollouts;
    expect(rollouts[0].subtask_frames).toEqual([]);
    expect("subtask_frames" in rollouts[3]).toBe(false);
  });

  test("re-apply on a mark-only drift rewrites the reconciliation, then is a no-op", () => {
    // A results.json reconciled before subtask canonicalization existed: outcome
    // fields canonical, marks still live, legacy reconciliation without the count.
    const legacy = raw() as Record<string, unknown>;
    legacy._outcome_edit_reconciliation = {
      overrides_file: ".outcome_edit_progress.json",
      episodes_reviewed: 4,
      outcome_class_changes: 0,
      num_steps_patches: 0,
      success_flips: [],
    };
    const backup = JSON.stringify(raw());
    const first = canon(JSON.stringify(legacy), backup);
    expect(first.backupText).toBeNull(); // eval-time backup is never rewritten once reconciled
    const fixed = JSON.parse(first.resultsText!);
    expect(fixed._outcome_edit_reconciliation.subtask_frames_patches).toBe(3);
    expect(fixed.rollouts.map((r: Record<string, unknown>) => r.outcome)).toEqual(
      raw().rollouts.map((r) => r.outcome)
    );
    const second = canon(first.resultsText!, backup);
    expect(second.resultsText).toBeNull();
  });

  test("live marks come from the eval-time backup once results.json is reconciled", () => {
    const reconciled = JSON.parse(canon(JSON.stringify(raw()), null).resultsText!);
    // Episode 0 later SKIPPED: unreviewed again, so its live (eval-time) mark
    // must be tolerated — not the canonical empty list.
    const record = progress();
    delete (record.changed_episodes as Record<string, unknown>)["0"];
    const live = liveMarksPayload(reconciled, raw());
    expect(live).toEqual(raw());
    expect([...subtaskFramesForValidation(record, live)].sort((a, b) => a[0] - b[0])).toEqual([
      [0, [4]],
      [1, [6]],
      [3, [3]],
      [4, [2]],
    ]);
    // A raw results.json is its own live source; a reconciled one without the
    // backup is unrecoverable provenance.
    expect(liveMarksPayload(raw(), null)).toEqual(raw());
    expect(liveMarksPayload(null, null)).toBeNull();
    expect(() => liveMarksPayload(reconciled, null)).toThrow(/results_eval_time.json is missing/);
  });
});
