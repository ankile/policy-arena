import { describe, expect, test } from "bun:test";
import pilot from "./data/stage-reference-pilot.json";
import { selectPilot, type PilotCandidate } from "./pilotSelection";

describe("frozen human reference sample", () => {
  for (const task of ["marker_d2", "square_d2", "routing_d1"]) test(`${task}: 20 distinct episodes, 7 successes, 13 failures, 3 datasets`, () => {
    const rows = pilot.episodes.filter((row) => row.task === task);
    expect(rows).toHaveLength(20);
    expect(rows.filter((row) => row.outcome === "success")).toHaveLength(7);
    expect(rows.filter((row) => row.outcome === "failure")).toHaveLength(13);
    expect(new Set(rows.map((row) => row.dataset)).size).toBe(3);
    expect(new Set(rows.map((row) => `${row.dataset}#${row.episode}`)).size).toBe(20);
    expect(new Set(rows.filter((row) => row.outcome === "failure").map((row) => row.failureProxy)).size).toBeGreaterThanOrEqual(8);
    for (const row of rows) {
      expect(row.outcomeSource.startsWith("arena:") || row.outcomeSource === "hf:.outcome_edit_progress.json").toBe(true);
      expect(row.outcome).toBe(row.humanOutcome === "success" ? "success" : "failure");
      expect(row.predictionHash).toMatch(/^[0-9a-f]{64}$/);
      const source = pilot.sources.find((source) => source.repo === row.dataset)!;
      expect(source.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(source.eligible).toBeGreaterThan(0);
    }
  });

  const candidates: PilotCandidate[] = Array.from({length: 120}, (_, i) => ({
    task: "task", dataset: `dataset-${i % 3}`, episode: i, outcome: i < 30 ? "success" : "failure",
    humanOutcome: i < 30 ? "success" : "timeout", outcomeSource: "human", predictionHash: "test",
    stageProxy: i % 6, failureProxy: `failure-${i % 11}`, policy: String(i % 4), attempts: i % 2 + 1,
  }));
  test("selection is deterministic and independent of input ordering", () => {
    expect(selectPilot(candidates)).toEqual(selectPilot([...candidates].reverse()));
    expect(selectPilot(candidates)).toHaveLength(20);
  });
  test("never fills missing human outcomes from model judgments", () => {
    expect(() => selectPilot(candidates.filter((row) => row.outcome === "failure"))).toThrow("Need 7 human success");
    expect(() => selectPilot([...candidates, candidates[0]])).toThrow("Duplicate episode");
  });
});
