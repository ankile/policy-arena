import { describe, expect, test } from "bun:test";

import {
  binaryTrueCountFromEpisodeStats,
  effectiveEpisodeLengthFromStats,
  summarizeEpisodeFrames,
  successFromEpisodeStats,
} from "./hf-api";

function binaryStats(feature: "done" | "is_valid", values: number[]) {
  const count = values.length;
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    [`stats/${feature}/min`]: [Math.min(...values)],
    [`stats/${feature}/max`]: [Math.max(...values)],
    [`stats/${feature}/mean`]: [sum / count],
    [`stats/${feature}/count`]: [count],
  };
}

describe("episode metadata outcomes", () => {
  test("reads episode success from stats/success/max", () => {
    expect(successFromEpisodeStats({ "stats/success/max": [1] })).toBe(true);
    expect(successFromEpisodeStats({ "stats/success/max": [0] })).toBe(false);
    expect(successFromEpisodeStats({})).toBeNull();
  });

  test("rejects non-binary success metadata", () => {
    expect(() => successFromEpisodeStats({ "stats/success/max": [0.5] })).toThrow(
      "must be 0 or 1"
    );
  });
});

describe("effective episode length", () => {
  test("includes the first done frame and drops its retained tail", () => {
    const row = {
      length: 6,
      ...binaryStats("done", [0, 0, 1, 1, 1, 1]),
      ...binaryStats("is_valid", [1, 1, 1, 1, 1, 0]),
    };
    expect(effectiveEpisodeLengthFromStats(row)).toBe(3);
  });

  test("ends at the last valid frame when there is no done frame", () => {
    const row = {
      length: 5,
      ...binaryStats("done", [0, 0, 0, 0, 0]),
      ...binaryStats("is_valid", [1, 1, 1, 0, 0]),
    };
    expect(effectiveEpisodeLengthFromStats(row)).toBe(3);
  });

  test("uses raw length for legacy metadata without terminal features", () => {
    expect(effectiveEpisodeLengthFromStats({ length: 7 })).toBe(7);
  });

  test("recovers exact binary counts from floating-point means", () => {
    const row = {
      ...binaryStats("is_valid", [1, 1, 1, 0, 0]),
    };
    expect(binaryTrueCountFromEpisodeStats(row, "is_valid", 5)).toBe(3);
  });

  test("fails on partial or inconsistent terminal metadata", () => {
    expect(() =>
      effectiveEpisodeLengthFromStats({
        length: 5,
        "stats/is_valid/mean": [0.8],
      })
    ).toThrow("incomplete is_valid statistics");

    expect(() =>
      effectiveEpisodeLengthFromStats({
        length: 5,
        ...binaryStats("done", [0, 0, 1, 1]),
      })
    ).toThrow("does not match episode length");
  });
});

describe("legacy per-frame fallback", () => {
  test("uses first done or last valid frame and reads success", () => {
    const rows = [
      { frame_index: 0, done: 0, is_valid: 1, success: 1 },
      { frame_index: 1, done: 1, is_valid: 1, success: 1 },
      { frame_index: 2, done: 1, is_valid: 0, success: 1 },
      { frame_index: 3, done: 1, is_valid: 0, success: 1 },
    ];
    expect(summarizeEpisodeFrames(rows, 7)).toEqual({
      effectiveLength: 2,
      success: true,
    });
  });

  test("fails on a non-prefix validity mask", () => {
    const rows = [
      { frame_index: 0, done: 0, is_valid: 1, success: 0 },
      { frame_index: 1, done: 0, is_valid: 0, success: 0 },
      { frame_index: 2, done: 0, is_valid: 1, success: 0 },
    ];
    expect(() => summarizeEpisodeFrames(rows, 9)).toThrow(
      "valid frame after an invalid frame"
    );
  });
});
