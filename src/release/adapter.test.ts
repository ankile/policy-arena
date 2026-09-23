import { describe, expect, test } from "bun:test";
import { createReleaseAdapter } from "./adapter";
import type { UISnapshot } from "./adapter";
import type { Release } from "./types";
const release: Release = {
  schemaVersion: 1,
  version: "2026-09-22",
  state: "public_verified",
  selectionSha256: "frozen",
  sourceSha256: {},
  datasets: [
    {
      id: "mulligan/eval",
      task: "real-marker-d2",
      role: "evaluation",
      variant: null,
      episodes: 2,
      frames: 100,
      fps: 15,
      cameras: [],
      parent: null,
      source: "source/eval",
      revision: "a".repeat(40),
      tier: "mainline",
    },
  ],
  tasks: [
    {
      id: "marker_d2",
      title: "Marker",
      domain: "real",
      datasetTask: "real-marker-d2",
      metric: "full_success",
      policies: ["a", "b"].map((id, i) => ({
        id,
        round: "R0",
        method: id,
        arm: id,
        modelId: id,
        rate: 1 - i,
        lo: 0,
        hi: 1,
        successes: 1 - i,
        episodes: 1,
        provenance: "pinned",
        blocks: ["block"],
      })),
      blocks: [
        {
          id: "block",
          round: "R0",
          dataset: "mulligan/eval",
          source: "source/eval",
          revision: "a".repeat(40),
          fps: 15,
          cameras: [],
          reviewedEpisodes: null,
          sourcePath: "pinned",
          starts: [
            {
              index: 7,
              results: ["a", "b"].map((policyId, i) => ({
                policyId,
                episode: 10 + i,
                success: i === 0,
                outcome: i === 0 ? "success" : "failure",
                steps: 20 + i,
                frames: 50,
                score: 1 - i,
                marks: null,
                videos: {},
              })),
            },
          ],
        },
      ],
    },
  ],
};
const ui: UISnapshot = {
  selectionSha256: "frozen",
  datasets: [{ repo: "mulligan/eval", created: 123, sourceType: "eval" }],
  blocks: [{ id: "block", created: 456, mode: "manual" }],
  coverage: [],
};
describe("original Arena release adapter", () => {
  test("rejects mismatched snapshots and unknown queries or repositories", () => {
    expect(() =>
      createReleaseAdapter(release, { ...ui, selectionSha256: "changed" }),
    ).toThrow("mismatch");
    const a = createReleaseAdapter(release, ui);
    expect(() =>
      a.resolve("datasets:getByRepo", { repo_id: "source/pilot" }),
    ).toThrow("Not in release");
    expect(() => a.resolve("reviews:latestForRepo", {})).toThrow(
      "not available",
    );
    expect(a.resolve("users:viewer")).toBeNull();
  });
  test("preserves paired initial-state identity, selected episodes, and corrected step counts", () => {
    const a = createReleaseAdapter(release, ui);
    expect(a.resolve("evalSessions:getDetail", { id: "block" })).toMatchObject({
      dataset_repo: "mulligan/eval",
      rounds: [
        {
          index: 7,
          results: [
            {
              policy_id: "a",
              episode_index: 10,
              success: true,
              num_frames: 20,
            },
            {
              policy_id: "b",
              episode_index: 11,
              success: false,
              num_frames: 21,
            },
          ],
        },
      ],
    });
    expect(a.resolve("ratings:sessionOutcomes")).toMatchObject([
      {
        perPolicy: [
          { policy_id: "a", rollouts: 1, successes: 1, successFramesSum: 20 },
          { policy_id: "b", rollouts: 1, successes: 0 },
        ],
      },
    ]);
    expect(
      a.resolve("pairings:listRounds", { policyIdA: "b", policyIdB: "a" }),
    ).toMatchObject([
      { roundIndex: 7, results: [{ policyId: "b" }, { policyId: "a" }] },
    ]);
    expect(a.resolve("pairings:listRounds", { policyIdA: "outside" })).toEqual(
      [],
    );
  });
  test("memoizes query values for the original effect and joined-view dependencies", () => {
    const a = createReleaseAdapter(release, ui);
    expect(a.resolve("evalSessions:getDetail", { id: "block" })).toBe(
      a.resolve("evalSessions:getDetail", { id: "block" }),
    );
  });
});
