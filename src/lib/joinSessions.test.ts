import { describe, expect, test } from "bun:test";

import {
  alignRounds,
  alignmentSummary,
  formatIdList,
  hidePolicies,
  joinedPolicies,
  parseIdList,
  sessionLetter,
  sideSuccessSummary,
  toggleId,
  type JoinSide,
} from "./joinSessions";

function result(policy: string, success: boolean, episode: number) {
  return { policy_id: policy, policyName: policy, success, episode_index: episode };
}

const sideA: JoinSide = {
  sessionId: "sA",
  rounds: [
    { index: 0, results: [result("p1", true, 0), result("p2", false, 1)] },
    { index: 1, results: [result("p1", false, 2), result("p2", false, 3)] },
    { index: 2, results: [result("p1", true, 4), result("p2", true, 5)] },
  ],
};

const sideB: JoinSide = {
  sessionId: "sB",
  rounds: [
    { index: 0, results: [result("p3", true, 0)] },
    { index: 1, results: [result("p3", true, 1)] },
  ],
};

describe("alignRounds", () => {
  test("aligns by round index and marks missing rounds null", () => {
    const rounds = alignRounds([sideA, sideB]);
    expect(rounds.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(rounds[0].perSide[0]).toBe(sideA.rounds[0].results);
    expect(rounds[0].perSide[1]).toBe(sideB.rounds[0].results);
    expect(rounds[2].perSide[1]).toBeNull();
  });

  test("union covers rounds that only the later side has", () => {
    const onlyLate: JoinSide = {
      sessionId: "sC",
      rounds: [{ index: 7, results: [result("p9", false, 0)] }],
    };
    const rounds = alignRounds([sideB, onlyLate]);
    expect(rounds.map((r) => r.index)).toEqual([0, 1, 7]);
    expect(rounds[2].perSide).toEqual([null, onlyLate.rounds[0].results]);
  });

  test("sorts numerically even when rounds arrive out of order", () => {
    const shuffled: JoinSide = {
      sessionId: "s",
      rounds: [
        { index: 10, results: [] },
        { index: 2, results: [] },
        { index: 1, results: [] },
      ],
    };
    expect(alignRounds([shuffled]).map((r) => r.index)).toEqual([1, 2, 10]);
  });

  test("rejects duplicate round indices within a side", () => {
    const dup: JoinSide = {
      sessionId: "s",
      rounds: [
        { index: 0, results: [] },
        { index: 0, results: [] },
      ],
    };
    expect(() => alignRounds([dup])).toThrow(/duplicate round index 0/);
  });
});

describe("sideSuccessSummary", () => {
  test("counts successes per policy in first-seen order", () => {
    expect(sideSuccessSummary(sideA)).toEqual([
      { policy_id: "p1", policyName: "p1", successes: 2, rounds: 3 },
      { policy_id: "p2", policyName: "p2", successes: 1, rounds: 3 },
    ]);
  });
});

describe("joinedPolicies", () => {
  test("unions policies across sides in first-seen order", () => {
    expect(joinedPolicies([sideA, sideB]).map((p) => p.policy_id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    expect(joinedPolicies([sideB, sideA]).map((p) => p.policy_id)).toEqual([
      "p3",
      "p1",
      "p2",
    ]);
  });
});

describe("hidePolicies", () => {
  test("drops hidden results, keeps rounds, distinguishes [] from null", () => {
    const rounds = alignRounds([sideA, sideB]);
    const hidden = hidePolicies(rounds, new Set(["p2", "p3"]));
    expect(hidden.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(hidden[0].perSide[0]).toEqual([result("p1", true, 0)]);
    expect(hidden[0].perSide[1]).toEqual([]); // B ran round 0 but p3 is hidden
    expect(hidden[2].perSide[1]).toBeNull(); // B never ran round 2
  });

  test("returns the same rounds when nothing is hidden", () => {
    const rounds = alignRounds([sideA, sideB]);
    expect(hidePolicies(rounds, new Set())).toBe(rounds);
  });
});

describe("alignmentSummary", () => {
  test("reports aligned and single-side counts", () => {
    expect(alignmentSummary(alignRounds([sideA, sideB]))).toBe(
      "2 aligned · 1 A-only",
    );
    expect(alignmentSummary(alignRounds([sideB, sideA]))).toBe(
      "2 aligned · 1 B-only",
    );
  });

  test("handles no rounds", () => {
    expect(alignmentSummary([])).toBe("0 aligned");
  });
});

describe("url id lists", () => {
  test("round-trips and dedupes", () => {
    expect(parseIdList(null)).toEqual([]);
    expect(parseIdList("")).toEqual([]);
    expect(parseIdList("a,b,a")).toEqual(["a", "b"]);
    expect(formatIdList([])).toBeNull();
    expect(formatIdList(["a", "b"])).toBe("a,b");
  });

  test("toggle adds at the end and removes in place", () => {
    expect(toggleId([], "a")).toEqual(["a"]);
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
  });

  test("letters follow selection order", () => {
    expect(sessionLetter(0)).toBe("A");
    expect(sessionLetter(1)).toBe("B");
    expect(() => sessionLetter(26)).toThrow();
  });
});
