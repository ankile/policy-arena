import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest, type TestConvex } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { planSplice, rowsFingerprint, spliceIndexMap } from "../convex/episodeSpliceLogic";

// Episode splice (2026-10-20, marker_d2 umirel lineage eval ep 476): the Hub
// removed one rollout and renumbered the survivors; every Arena row keyed by
// (dataset_repo, episode_index) must follow, and the removed (round, policy)
// slot must accept the re-collected rollout.
const modules = {
  "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
  "../convex/evalSessions.ts": () => import("../convex/evalSessions"),
  "../convex/episodeSplice.ts": () => import("../convex/episodeSplice"),
  "../convex/access.ts": () => import("../convex/access"),
  "../convex/statuses.ts": () => import("../convex/statuses"),
  "../convex/statusShared.ts": () => import("../convex/statusShared"),
};
const SERVICE_TOKEN = "episode-splice-test-only-bridge-token";
const service = { serviceToken: SERVICE_TOKEN };
const REPO = "test/spliced-eval";
const policy = (id: string) => ({ name: id, model_id: `test://${id}`, environment: "marker_d2" });
const result = (id: string, episode: number, success = true) => ({
  model_id: `test://${id}`,
  success,
  episode_index: BigInt(episode),
  num_frames: BigInt(100),
});

describe("splice planning", () => {
  test("dense renumber with removed episodes mapped to null", () => {
    expect([...spliceIndexMap(5, [1, 3])]).toEqual([[0, 0], [1, null], [2, 1], [3, null], [4, 2]]);
    expect(() => spliceIndexMap(5, [5])).toThrow(/outside/);
    expect(() => spliceIndexMap(5, [1, 1])).toThrow(/duplicate/);
    expect(() => spliceIndexMap(5, [])).toThrow(/empty/);
  });

  test("rows past total_before fail loud (wrong count or already spliced)", () => {
    const rows = [{ table: "outcomeReviews", id: "a", episode_index: 5 }];
    expect(() => planSplice(rows, 5, [1])).toThrow(/outside 0..4/);
  });

  test("fingerprint is order-independent and changes with any index", () => {
    const a = { table: "t", id: "a", episode_index: 1 };
    const b = { table: "t", id: "b", episode_index: 2 };
    expect(rowsFingerprint([a, b])).toBe(rowsFingerprint([b, a]));
    expect(rowsFingerprint([a, b])).not.toBe(rowsFingerprint([a, { ...b, episode_index: 1 }]));
  });
});

describe("episodeSplice plan/apply", () => {
  let t: TestConvex<typeof schema>;
  let oldServiceToken: string | undefined;
  beforeEach(() => {
    oldServiceToken = process.env.ARENA_SERVICE_TOKEN;
    process.env.ARENA_SERVICE_TOKEN = SERVICE_TOKEN;
    t = convexTest(schema, modules);
  });
  afterEach(() => {
    if (oldServiceToken === undefined) delete process.env.ARENA_SERVICE_TOKEN;
    else process.env.ARENA_SERVICE_TOKEN = oldServiceToken;
  });

  test("renumbers reviews, notes and round results; the removed slot takes the redo", async () => {
    // 3 rounds x 2 arms = episodes 0..5; episode 2 (round 1, arm A) is spliced out.
    const sessionId = await t.mutation(api.evalSessions.submit, {
      ...service,
      dataset_repo: REPO,
      session_mode: "manual",
      policies: [policy("A"), policy("B")],
      rounds: [
        { round_index: BigInt(0), results: [result("A", 0), result("B", 1)] },
        { round_index: BigInt(1), results: [result("A", 2, false), result("B", 3)] },
        { round_index: BigInt(2), results: [result("A", 4), result("B", 5)] },
      ],
    });
    await t.run(async (ctx) => {
      const review = (ep: number, status: string, saved_at: number) =>
        ctx.db.insert("outcomeReviews", {
          dataset_repo: REPO, episode_index: BigInt(ep), status, reviewer: "r", saved_at,
          ...(status === "confirmed" ? { new_outcome: "failure", outcome_frame: BigInt(10) } : {}),
        });
      await review(1, "confirmed", 1);
      await review(2, "skipped", 2);
      await review(5, "confirmed", 3);
      await review(5, "confirmed", 4); // superseded history row moves too
      await ctx.db.insert("episodeNotes", { dataset_repo: REPO, episode_index: BigInt(2), notes: "SPLICE", updated_by: "r", updated_at: 1 });
      await ctx.db.insert("episodeNotes", { dataset_repo: REPO, episode_index: BigInt(4), notes: "keep", updated_by: "r", updated_at: 1 });
      await ctx.db.insert("outcomeReviews", { dataset_repo: "test/other", episode_index: BigInt(5), status: "skipped", reviewer: "r", saved_at: 1 });
    });

    const args = { dataset_repo: REPO, total_before: 6, drop: [2] };
    const planned = await t.query(internal.episodeSplice.plan, args);
    expect(planned.by_table).toEqual({
      outcomeReviews: { patched: 2, deleted: 1 },
      episodeNotes: { patched: 1, deleted: 1 },
      roundResults: { patched: 3, deleted: 1 },
    });
    await expect(
      t.mutation(internal.episodeSplice.apply, { ...args, expected_fingerprint: "stale" }),
    ).rejects.toThrow(/row set changed/);
    await t.mutation(internal.episodeSplice.apply, { ...args, expected_fingerprint: planned.fingerprint });

    const state = await t.run(async (ctx) => ({
      reviews: (await ctx.db.query("outcomeReviews").collect()).map((r) => [r.dataset_repo, Number(r.episode_index), r.status]),
      notes: (await ctx.db.query("episodeNotes").collect()).map((n) => [Number(n.episode_index), n.notes]),
      results: (await ctx.db.query("roundResults").withIndex("by_session", (q) => q.eq("session_id", sessionId as never)).collect())
        .map((r) => [Number(r.round_index), Number(r.episode_index)]).sort(),
    }));
    const byKey = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();
    expect(byKey(state.reviews)).toEqual(byKey([
      [REPO, 1, "confirmed"], [REPO, 4, "confirmed"], [REPO, 4, "confirmed"], ["test/other", 5, "skipped"],
    ]));
    expect(state.notes).toEqual([[3, "keep"]]);
    expect(state.results).toEqual([[0, 0], [0, 1], [1, 2], [2, 3], [2, 4]]);

    // A second apply with the same plan is refused (indices already moved).
    await expect(
      t.mutation(internal.episodeSplice.apply, { ...args, expected_fingerprint: planned.fingerprint }),
    ).rejects.toThrow(/outside 0..5|row set changed/);

    // The re-collected rollout (appended as episode 5) lands in the freed slot.
    await t.mutation(api.evalSessions.addRounds, {
      ...service,
      id: sessionId,
      policies: [policy("A"), policy("B")],
      rounds: [{ round_index: BigInt(1), results: [result("A", 5)] }],
    });
    const after = await t.run(async (ctx) =>
      (await ctx.db.query("roundResults").withIndex("by_session", (q) => q.eq("session_id", sessionId as never)).collect())
        .map((r) => [Number(r.round_index), Number(r.episode_index)]).sort(),
    );
    expect(after).toEqual([[0, 0], [0, 1], [1, 2], [1, 5], [2, 3], [2, 4]]);
  });
});
