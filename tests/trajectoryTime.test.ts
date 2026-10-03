import { expect, test } from "bun:test";
import { isPolicyFrame, policyFrameCount } from "../convex/trajectoryTime";

for (const frames of [1, 31, 62, 124, 248, 450]) test(`policy boundary at ${frames}/15 seconds excludes the first reset frame`, () => {
  const duration = frames / 15;
  expect(policyFrameCount(duration, 15)).toBe(frames);
  expect(isPolicyFrame(frames - 1, duration, 15)).toBe(true);
  expect(isPolicyFrame(frames, duration, 15)).toBe(false);
  expect(isPolicyFrame(frames + 1, duration, 15)).toBe(false);
  expect(isPolicyFrame(-1, duration, 15)).toBe(false);
  expect(isPolicyFrame(0.5, duration, 15)).toBe(false);
});

test("missing or invalid durations cannot authorize video capture", () => {
  for (const duration of [null, undefined, 0, -1, NaN, Infinity]) {
    expect(policyFrameCount(duration, 15)).toBeNull();
    expect(isPolicyFrame(0, duration, 15)).toBe(false);
  }
});
