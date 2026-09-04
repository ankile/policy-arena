import { describe, expect, test } from "bun:test";

import { armLabels, armStats, armsFromPolicies } from "./armStats";

function r(policy_id: string, success: boolean, marks: number | null = null) {
  return { policy_id, success, num_subtask_marks: marks };
}

describe("armStats", () => {
  const rounds = [
    { results: [r("a", true, 1), r("b", false, 1)] },
    { results: [r("a", false, 0), r("b", false, 1)] },
    { results: [r("a", true, 1)] },
    { results: [r("b", true, 1), r("zzz", true, 0)] },
  ];

  test("n and successes count only rounds where the arm ran", () => {
    const s = armStats(["a", "b"], rounds, 1);
    expect(s.get("a")).toMatchObject({ n: 3, successes: 2 });
    expect(s.get("b")).toMatchObject({ n: 3, successes: 1 });
  });

  test("pairwise records are symmetric and skip unlisted arms", () => {
    const s = armStats(["a", "b"], rounds, 1);
    expect(s.get("a")).toMatchObject({ wins: 1, draws: 1, losses: 0 });
    expect(s.get("b")).toMatchObject({ wins: 0, draws: 1, losses: 1 });
    expect(s.has("zzz")).toBe(false);
  });

  test("graded record splits a binary draw by marks", () => {
    // Round 2: both fail, a=0 marks vs b=1 mark -> graded loss for a.
    const s = armStats(["a", "b"], rounds, 1);
    expect(s.get("a")).toMatchObject({ scoreWins: 1, scoreDraws: 0, scoreLosses: 1 });
  });

  test("binary task leaves the graded record at zero", () => {
    const s = armStats(["a", "b"], rounds, 0);
    expect(s.get("a")).toMatchObject({ scoreWins: 0, scoreDraws: 0, scoreLosses: 0 });
  });
});

describe("armsFromPolicies", () => {
  test("numbers policies in list order, then stragglers from results", () => {
    const arms = armsFromPolicies(
      [
        { _id: "a", name: "policy-a" },
        { _id: "b", name: "policy-b" },
      ],
      [{ index: 0, results: [{ policy_id: "c", policyName: "policy-c", success: true, episode_index: 0, num_subtask_marks: null }] }],
    );
    expect(arms.map((a) => [a.key, a.label, a.policyNumber, a.name])).toEqual([
      ["a", "1", 1, "policy-a"],
      ["b", "2", 2, "policy-b"],
      ["c", "3", 3, "policy-c"],
    ]);
    expect(armLabels(arms).get("c")).toBe("3");
  });
});
