import { describe, expect, test } from "bun:test";

import { armsFromResults, parseArmFilter, unknownArms } from "./episodeArms";

const payload = {
  summary: [
    { policy_id: 0, name: "r4_base_rel" },
    { policy_id: 1, name: "r4_ours_rel" },
    { policy_id: 2, name: "r4_ours_vel" },
  ],
  rollouts: [
    { episode_index: 0, policy_id: 2 },
    { episode_index: 1, policy_id: 0 },
    { episode_index: 2, policy_id: 1 },
  ],
};

describe("armsFromResults", () => {
  test("joins rollout policy_id to the summary arm name", () => {
    expect([...armsFromResults(payload)]).toEqual([
      [0, "r4_ours_vel"],
      [1, "r4_base_rel"],
      [2, "r4_ours_rel"],
    ]);
  });

  test("throws when a rollout's policy has no summary row", () => {
    const bad = { ...payload, rollouts: [{ episode_index: 0, policy_id: 9 }] };
    expect(() => armsFromResults(bad)).toThrow("policy_id 9");
  });

  test("throws on duplicate episodes and missing arrays", () => {
    const dup = { ...payload, rollouts: [payload.rollouts[0], payload.rollouts[0]] };
    expect(() => armsFromResults(dup)).toThrow("duplicate rollout");
    expect(() => armsFromResults({ rollouts: [] })).toThrow("summary");
  });
});

describe("parseArmFilter", () => {
  test("all and empty mean no filter", () => {
    expect(parseArmFilter("all")).toBeNull();
    expect(parseArmFilter(" , ")).toBeNull();
  });

  test("comma-separated values select several arms, deduplicated", () => {
    expect(parseArmFilter("r4_base_rel, r4_ours_rel,r4_base_rel")).toEqual([
      "r4_base_rel",
      "r4_ours_rel",
    ]);
  });
});

test("unknownArms reports selections the dataset lacks", () => {
  expect(unknownArms(["r4_ours_rel", "nope"], ["r4_base_rel", "r4_ours_rel"])).toEqual([
    "nope",
  ]);
});
