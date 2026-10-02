import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { buildEpisodeMap, normalizeOutcomeFrame, type FileFrameColumns } from "../convex/apply/frames";
import { buildOverlay, outcomeFrameWritebacks } from "../convex/apply/progress";
import { labelSourcesByEpisode } from "../convex/applyWorker";

const modules = {
  "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
  "../convex/reviews.ts": () => import("../convex/reviews"),
};
const REPO = "test/outcome-provenance";
const service = { serviceToken: "outcome-provenance-token" };
let oldToken: string | undefined;
let oldAllowlist: string | undefined;
beforeEach(() => {
  oldToken = process.env.ARENA_SERVICE_TOKEN;
  oldAllowlist = process.env.ARENA_EDITOR_SUBS;
  process.env.ARENA_SERVICE_TOKEN = service.serviceToken;
  process.env.ARENA_EDITOR_SUBS = "provenance-editor";
});
afterEach(() => {
  if (oldToken === undefined) delete process.env.ARENA_SERVICE_TOKEN;
  else process.env.ARENA_SERVICE_TOKEN = oldToken;
  if (oldAllowlist === undefined) delete process.env.ARENA_EDITOR_SUBS;
  else process.env.ARENA_EDITOR_SUBS = oldAllowlist;
});

function confirmed(episode: number, frame: number) {
  return {
    dataset_repo: REPO,
    episode_index: BigInt(episode),
    status: "confirmed",
    new_outcome: "failure",
    outcome_frame: BigInt(frame),
    soft_truncate: false,
    subtask_frames: [] as bigint[],
  };
}

async function signedInEditor(t: ReturnType<typeof convexTest>) {
  const user = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { username: "editor" });
    await ctx.db.insert("authAccounts", {
      userId, provider: "huggingface", providerAccountId: "provenance-editor",
    });
    return userId;
  });
  return t.withIdentity({ subject: user });
}

/** One 6-frame episode whose terminal frame 5 is is_valid=0 padding. */
function paddedEpisode(): FileFrameColumns {
  return {
    path: "data/chunk-000/file-000.parquet",
    numRows: 6,
    episodeIndex: new Float64Array(6),
    frameIndex: new Float64Array([0, 1, 2, 3, 4, 5]),
    reward: new Float32Array(6),
    done: new Float64Array(6),
    success: new Float64Array(6),
    isValid: new Float64Array([1, 1, 1, 1, 1, 0]),
    dirty: false,
  };
}

describe("scripted review provenance", () => {
  test("service saves record source_tool and the apply uses it as label-history tool", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.reviews.save, {
      ...service, ...confirmed(0, 3), reviewer_override: "ankile", source_tool: "rule:example (x.py)",
    });
    await t.mutation(api.reviews.save, { ...service, ...confirmed(1, 2), reviewer_override: "ankile" });
    const { episodes } = await t.query(api.reviews.latestForRepo, { dataset_repo: REPO });
    expect(episodes.map((row) => row.source_tool)).toEqual(["rule:example (x.py)", undefined]);
    const sources = labelSourcesByEpisode(episodes);
    expect(sources.get(0)).toEqual({ kind: "human", agent: "ankile", tool: "rule:example (x.py)" });
    expect(sources.get(1)).toEqual({ kind: "human", agent: "ankile", tool: "web-review" });
  });

  test("source_tool is service-only and non-empty", async () => {
    const t = convexTest(schema, modules);
    const editor = await signedInEditor(t);
    await expect(editor.mutation(api.reviews.save, { ...confirmed(0, 3), source_tool: "rule:x" }))
      .rejects.toThrow("source_tool is reserved for the service principal");
    await expect(t.mutation(api.reviews.save, { ...service, ...confirmed(0, 3), source_tool: "  " }))
      .rejects.toThrow("non-empty");
    await editor.mutation(api.reviews.save, confirmed(0, 3));
    const { episodes } = await t.query(api.reviews.latestForRepo, { dataset_repo: REPO });
    expect(episodes[0].reviewer).toBe("editor");
    expect(episodes[0].source_tool).toBeUndefined();
  });

  test("reattribution patches exactly the listed placeholder-reviewer rows", async () => {
    const t = convexTest(schema, modules);
    for (const ep of [0, 1]) {
      await t.mutation(api.reviews.save, { ...service, ...confirmed(ep, 3), reviewer_override: "ankile:rule" });
    }
    await t.mutation(api.reviews.save, { ...service, ...confirmed(2, 3), reviewer_override: "ankile" });
    const args = { dataset_repo: REPO, from_reviewer: "ankile:rule", reviewer: "ankile", source_tool: "rule:x" };
    await expect(t.mutation(internal.reviews.reattributeScriptedReviews, { ...args, episode_indices: [0n] }))
      .rejects.toThrow("expected exactly");
    await expect(t.mutation(internal.reviews.reattributeScriptedReviews, { ...args, episode_indices: [0n, 1n, 2n] }))
      .rejects.toThrow("expected exactly");
    expect(await t.mutation(internal.reviews.reattributeScriptedReviews, { ...args, episode_indices: [1n, 0n] }))
      .toBe(2);
    const { episodes } = await t.query(api.reviews.latestForRepo, { dataset_repo: REPO });
    expect(episodes.map((row) => [row.reviewer, row.source_tool])).toEqual([
      ["ankile", "rule:x"], ["ankile", "rule:x"], ["ankile", undefined],
    ]);
  });
});

describe("applied outcome_frame write-back", () => {
  test("a terminal-padding mark is written back as the normalized frame on the applied row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.reviews.save, { ...service, ...confirmed(0, 5) }); // terminal padding frame
    await t.mutation(api.reviews.save, { ...service, ...confirmed(1, 2) }); // valid frame, untouched
    const { episodes } = await t.query(api.reviews.latestForRepo, { dataset_repo: REPO });

    // Same normalization the apply pipeline runs on the overlay.
    const overlay = buildOverlay(episodes);
    const ep = buildEpisodeMap([paddedEpisode()]).get(0)!;
    const applied = Object.entries(overlay.changed_episodes).map(([epStr, record]) => ({
      episode_index: Number(epStr),
      outcome_frame: epStr === "0" ? normalizeOutcomeFrame(ep, record.outcome_frame) : record.outcome_frame,
    }));
    const writebacks = outcomeFrameWritebacks(episodes, applied);
    expect(writebacks.map((w) => [w.episode_index, w.outcome_frame])).toEqual([[0, 4]]);

    const result = await t.mutation(internal.reviews.recordAppliedOutcomeFrames, {
      dataset_repo: REPO,
      applied: writebacks.map((w) => ({ review_id: w.review_id, outcome_frame: BigInt(w.outcome_frame) })),
    });
    expect(result).toEqual({ patched: 1, superseded: [] });
    const after = (await t.query(api.reviews.latestForRepo, { dataset_repo: REPO })).episodes;
    expect(after.map((row) => [row.outcome_frame, row.submitted_outcome_frame])).toEqual([
      [4n, 5n], [2n, undefined],
    ]);
    expect(outcomeFrameWritebacks(after, applied)).toEqual([]);
    // Same audit row, not a new one.
    expect(after[0]._id).toBe(episodes[0]._id);
  });

  test("a review saved during the apply is not clobbered", async () => {
    const t = convexTest(schema, modules);
    const applied = await t.mutation(api.reviews.save, { ...service, ...confirmed(0, 5) });
    const newer = await t.mutation(api.reviews.save, { ...service, ...confirmed(0, 5) });
    const result = await t.mutation(internal.reviews.recordAppliedOutcomeFrames, {
      dataset_repo: REPO, applied: [{ review_id: applied, outcome_frame: 4n }],
    });
    expect(result).toEqual({ patched: 0, superseded: [0n] });
    const rows = await t.run((ctx) => ctx.db.query("outcomeReviews").collect());
    for (const row of rows) {
      expect(row.outcome_frame).toBe(5n);
      expect(row.submitted_outcome_frame).toBeUndefined();
    }
    expect((await t.query(api.reviews.latestForRepo, { dataset_repo: REPO })).episodes[0]._id).toBe(newer);
  });

  test("a clear saved during the apply also supersedes the applied row", async () => {
    const t = convexTest(schema, modules);
    const applied = await t.mutation(api.reviews.save, { ...service, ...confirmed(0, 5) });
    await t.mutation(api.reviews.save, {
      ...service, dataset_repo: REPO, episode_index: 0n, status: "cleared",
    });
    expect(await t.mutation(internal.reviews.recordAppliedOutcomeFrames, {
      dataset_repo: REPO, applied: [{ review_id: applied, outcome_frame: 4n }],
    })).toEqual({ patched: 0, superseded: [0n] });
  });

  test("write-back refuses frames normalization cannot produce", async () => {
    const t = convexTest(schema, modules);
    const id: Id<"outcomeReviews"> = await t.mutation(api.reviews.save, { ...service, ...confirmed(0, 5) });
    for (const frame of [5n, 6n]) {
      await expect(t.mutation(internal.reviews.recordAppliedOutcomeFrames, {
        dataset_repo: REPO, applied: [{ review_id: id, outcome_frame: frame }],
      })).rejects.toThrow("not earlier than the submitted frame");
    }
    await expect(t.mutation(internal.reviews.recordAppliedOutcomeFrames, {
      dataset_repo: "test/other", applied: [{ review_id: id, outcome_frame: 4n }],
    })).rejects.toThrow("belongs to");
    await t.mutation(internal.reviews.recordAppliedOutcomeFrames, {
      dataset_repo: REPO, applied: [{ review_id: id, outcome_frame: 4n }],
    });
    await expect(t.mutation(internal.reviews.recordAppliedOutcomeFrames, {
      dataset_repo: REPO, applied: [{ review_id: id, outcome_frame: 3n }],
    })).rejects.toThrow("already normalized once");
  });

  test("every confirmed review must have been applied", () => {
    expect(() => outcomeFrameWritebacks(
      [{ _id: "a", episode_index: 7n, status: "confirmed", outcome_frame: 3n }], []
    )).toThrow("Episode 7: confirmed review was not applied");
  });

  test("reviewedRepos lists every repo with review rows", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.reviews.save, { ...service, ...confirmed(0, 3) });
    await t.mutation(api.reviews.save, { ...service, ...confirmed(0, 3), dataset_repo: "test/a" });
    expect(await t.query(api.reviews.reviewedRepos, {})).toEqual(["test/a", REPO]);
  });
});
