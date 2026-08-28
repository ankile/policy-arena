import { describe, expect, test } from "bun:test";
import { summarizeDatasetStats } from "../../convex/datasetStatsLogic";

describe("summarizeDatasetStats", () => {
  test("computes effective duration and source summaries", () => {
    const summary = summarizeDatasetStats(
      [
        {
          episodeIndex: 0,
          rawLength: 10,
          success: true,
          validFrames: 8,
          doneFrames: 4,
          humanFrames: 0,
        },
        {
          episodeIndex: 1,
          rawLength: 12,
          success: true,
          validFrames: 12,
          doneFrames: 0,
          humanFrames: 3,
        },
        {
          episodeIndex: 2,
          rawLength: 6,
          success: false,
          validFrames: null,
          doneFrames: null,
          humanFrames: 2,
        },
      ],
      2
    );

    expect(summary).toEqual({
      numEpisodes: 3,
      totalFrames: 28,
      totalDurationSeconds: 12.5,
      numSuccess: 2,
      numFailure: 1,
      numHumanFrames: 5,
      numPolicyFrames: 23,
      numAutonomousSuccess: 1,
    });
  });

  test("marks source summaries unavailable when every row lacks source stats", () => {
    const summary = summarizeDatasetStats(
      [
        {
          episodeIndex: 0,
          rawLength: 5,
          success: false,
          validFrames: null,
          doneFrames: null,
          humanFrames: null,
        },
      ],
      5
    );

    expect(summary.numHumanFrames).toBeNull();
    expect(summary.numPolicyFrames).toBeNull();
    expect(summary.numAutonomousSuccess).toBeNull();
  });

  test("rejects partial source metadata", () => {
    expect(() =>
      summarizeDatasetStats(
        [
          {
            episodeIndex: 0,
            rawLength: 5,
            success: false,
            validFrames: null,
            doneFrames: null,
            humanFrames: 0,
          },
          {
            episodeIndex: 1,
            rawLength: 5,
            success: false,
            validFrames: null,
            doneFrames: null,
            humanFrames: null,
          },
        ],
        5
      )
    ).toThrow("source statistics for only part");
  });

  test("rejects duplicate episode indices", () => {
    expect(() =>
      summarizeDatasetStats(
        [
          {
            episodeIndex: 0,
            rawLength: 5,
            success: false,
            validFrames: null,
            doneFrames: null,
            humanFrames: 0,
          },
          {
            episodeIndex: 0,
            rawLength: 5,
            success: false,
            validFrames: null,
            doneFrames: null,
            humanFrames: 0,
          },
        ],
        5
      )
    ).toThrow("Duplicate episode_index 0");
  });
});
