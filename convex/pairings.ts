import { query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {
    environment: v.optional(v.string()),
    policyId: v.optional(v.id("policies")),
  },
  handler: async (ctx, args) => {
    const sessions = await ctx.db.query("evalSessions").collect();

    // Pre-load all policies into a cache
    const allPolicies = await ctx.db.query("policies").collect();
    const policyCache = new Map<
      string,
      { _id: string; name: string; environment: string; elo: number }
    >();
    for (const p of allPolicies) {
      policyCache.set(p._id, {
        _id: p._id,
        name: p.name,
        environment: p.environment,
        elo: p.elo,
      });
    }
    const getPolicyCached = (id: string) => policyCache.get(id);

    // Aggregate stats by canonical pair (sorted IDs)
    const pairStats = new Map<
      string,
      {
        idA: string;
        idB: string;
        winsA: number;
        winsB: number;
        draws: number;
        sessionIds: Set<string>;
      }
    >();

    for (const session of sessions) {
      // Filter by environment: check if any policy in the session matches
      if (args.environment) {
        let envMatch = false;
        for (const pid of session.policy_ids) {
          const p = getPolicyCached(pid);
          if (p && p.environment === args.environment) {
            envMatch = true;
            break;
          }
        }
        if (!envMatch) continue;
      }

      // Filter by policyId: session must contain the policy
      if (args.policyId && !session.policy_ids.some((id) => id === args.policyId)) {
        continue;
      }

      const results = await ctx.db
        .query("roundResults")
        .withIndex("by_session", (q) => q.eq("session_id", session._id))
        .collect();

      // Group results by round_index
      const roundsMap = new Map<number, Array<{ policy_id: string; success: boolean }>>();
      for (const r of results) {
        const idx = Number(r.round_index);
        if (!roundsMap.has(idx)) roundsMap.set(idx, []);
        roundsMap.get(idx)!.push({ policy_id: r.policy_id, success: r.success });
      }

      // Compute pairwise outcomes per round
      for (const [, roundResults] of roundsMap) {
        for (let i = 0; i < roundResults.length; i++) {
          for (let j = i + 1; j < roundResults.length; j++) {
            const a = roundResults[i];
            const b = roundResults[j];

            // Canonical pair: sorted by ID
            const [idA, idB] = a.policy_id < b.policy_id
              ? [a.policy_id, b.policy_id]
              : [b.policy_id, a.policy_id];
            const aIsFirst = a.policy_id === idA;

            const key = `${idA}:${idB}`;
            if (!pairStats.has(key)) {
              pairStats.set(key, {
                idA,
                idB,
                winsA: 0,
                winsB: 0,
                draws: 0,
                sessionIds: new Set(),
              });
            }
            const stats = pairStats.get(key)!;
            stats.sessionIds.add(session._id);

            if (a.success && !b.success) {
              if (aIsFirst) stats.winsA++;
              else stats.winsB++;
            } else if (!a.success && b.success) {
              if (aIsFirst) stats.winsB++;
              else stats.winsA++;
            } else {
              stats.draws++;
            }
          }
        }
      }
    }

    // Build result array
    const result = [];
    for (const [, stats] of pairStats) {
      const policyA = getPolicyCached(stats.idA);
      const policyB = getPolicyCached(stats.idB);
      if (!policyA || !policyB) continue;

      // If filtering by policy, only include pairs containing that policy
      if (args.policyId) {
        if (stats.idA !== args.policyId && stats.idB !== args.policyId) continue;
      }

      const totalRounds = stats.winsA + stats.winsB + stats.draws;
      result.push({
        policyA,
        policyB,
        stats: {
          totalRounds,
          winsA: stats.winsA,
          winsB: stats.winsB,
          draws: stats.draws,
          winRateA: totalRounds > 0 ? stats.winsA / totalRounds : 0,
          winRateB: totalRounds > 0 ? stats.winsB / totalRounds : 0,
        },
        sessionCount: stats.sessionIds.size,
      });
    }

    return result.sort((a, b) => b.stats.totalRounds - a.stats.totalRounds);
  },
});

export const detail = query({
  args: {
    policyIdA: v.id("policies"),
    policyIdB: v.id("policies"),
  },
  handler: async (ctx, args) => {
    const policyA = await ctx.db.get(args.policyIdA);
    const policyB = await ctx.db.get(args.policyIdB);
    if (!policyA || !policyB) return null;

    // Find all sessions containing both policies
    const allSessions = await ctx.db.query("evalSessions").order("desc").collect();
    const matchingSessions = allSessions.filter(
      (s) =>
        s.policy_ids.some((id) => id === args.policyIdA) &&
        s.policy_ids.some((id) => id === args.policyIdB)
    );

    const sessions = await Promise.all(
      matchingSessions.map(async (session) => {
        const results = await ctx.db
          .query("roundResults")
          .withIndex("by_session", (q) => q.eq("session_id", session._id))
          .collect();

        // Filter to only the two policies and group by round
        const roundsMap = new Map<
          number,
          Array<{
            policy_id: string;
            policyName: string;
            success: boolean;
            episode_index: number;
          }>
        >();

        for (const r of results) {
          if (r.policy_id !== args.policyIdA && r.policy_id !== args.policyIdB) continue;
          const idx = Number(r.round_index);
          if (!roundsMap.has(idx)) roundsMap.set(idx, []);
          roundsMap.get(idx)!.push({
            policy_id: r.policy_id,
            policyName: r.policy_id === args.policyIdA ? policyA.name : policyB.name,
            success: r.success,
            episode_index: Number(r.episode_index),
          });
        }

        // Sort each round's results: A first, then B
        for (const [, roundResults] of roundsMap) {
          roundResults.sort((a, b) => {
            if (a.policy_id === args.policyIdA && b.policy_id !== args.policyIdA) return -1;
            if (a.policy_id !== args.policyIdA && b.policy_id === args.policyIdA) return 1;
            return 0;
          });
        }

        return {
          _id: session._id,
          _creationTime: session._creationTime,
          dataset_repo: session.dataset_repo,
          session_mode: session.session_mode ?? "manual",
          rounds: Array.from(roundsMap.entries())
            .sort(([a], [b]) => a - b)
            .map(([index, results]) => ({ index, results })),
        };
      })
    );

    return {
      policyA,
      policyB,
      sessions,
    };
  },
});
