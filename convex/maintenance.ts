import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";

type PolicyCounts = {
  wins: bigint;
  losses: bigint;
  draws: bigint;
};

type RoundResult = {
  policyId: Id<"policies">;
  success: boolean;
};

function emptyCounts(): PolicyCounts {
  return { wins: BigInt(0), losses: BigInt(0), draws: BigInt(0) };
}

function ensureCounts(
  countsByPolicy: Map<Id<"policies">, PolicyCounts>,
  policyId: Id<"policies">
): PolicyCounts {
  let counts = countsByPolicy.get(policyId);
  if (!counts) {
    counts = emptyCounts();
    countsByPolicy.set(policyId, counts);
  }
  return counts;
}

async function getSessionRoundCount(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"evalSessions">
): Promise<number> {
  const results = await ctx.db
    .query("roundResults")
    .withIndex("by_session", (q) => q.eq("session_id", sessionId))
    .collect();
  return new Set(results.map((r) => Number(r.round_index))).size;
}

async function computePolicyCountsFromRoundResults(
  ctx: QueryCtx | MutationCtx,
  policies: Doc<"policies">[]
): Promise<Map<Id<"policies">, PolicyCounts>> {
  const countsByPolicy = new Map<Id<"policies">, PolicyCounts>();
  for (const policy of policies) {
    countsByPolicy.set(policy._id, emptyCounts());
  }

  const sessions = await ctx.db.query("evalSessions").order("asc").collect();
  for (const session of sessions) {
    if (session.session_mode === "rollout") continue;

    const results = await ctx.db
      .query("roundResults")
      .withIndex("by_session", (q) => q.eq("session_id", session._id))
      .collect();
    const rounds = new Map<number, RoundResult[]>();
    for (const result of results) {
      const roundIndex = Number(result.round_index);
      if (!rounds.has(roundIndex)) rounds.set(roundIndex, []);
      rounds.get(roundIndex)!.push({
        policyId: result.policy_id,
        success: result.success,
      });
    }

    for (const [, roundResults] of rounds) {
      for (let i = 0; i < roundResults.length; i++) {
        for (let j = i + 1; j < roundResults.length; j++) {
          const a = roundResults[i];
          const b = roundResults[j];
          const countsA = ensureCounts(countsByPolicy, a.policyId);
          const countsB = ensureCounts(countsByPolicy, b.policyId);

          if (a.success && !b.success) {
            countsA.wins += BigInt(1);
            countsB.losses += BigInt(1);
          } else if (!a.success && b.success) {
            countsA.losses += BigInt(1);
            countsB.wins += BigInt(1);
          } else {
            countsA.draws += BigInt(1);
            countsB.draws += BigInt(1);
          }
        }
      }
    }
  }

  return countsByPolicy;
}

export const auditSessionDerivedData = query({
  args: { id: v.id("evalSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    if (!session) throw new Error("Session not found");
    const actualRoundCount = await getSessionRoundCount(ctx, args.id);

    const policies = await Promise.all(
      session.policy_ids.map(async (id) => (await ctx.db.get(id))!)
    );
    const expectedCounts = await computePolicyCountsFromRoundResults(ctx, policies);

    return {
      session: {
        id: session._id,
        storedNumRounds: Number(session.num_rounds),
        actualRoundCount,
        notes: session.notes,
      },
      policies: policies.map((policy) => {
        const expected = expectedCounts.get(policy._id) ?? emptyCounts();
        return {
          id: policy._id,
          name: policy.name,
          stored: {
            wins: Number(policy.wins),
            losses: Number(policy.losses),
            draws: Number(policy.draws),
          },
          expected: {
            wins: Number(expected.wins),
            losses: Number(expected.losses),
            draws: Number(expected.draws),
          },
        };
      }),
    };
  },
});

export const repairSessionDerivedData = mutation({
  args: { id: v.id("evalSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    if (!session) throw new Error("Session not found");

    const actualRoundCount = await getSessionRoundCount(ctx, args.id);
    const sessionPatch: {
      num_rounds: bigint;
      notes?: string;
    } = { num_rounds: BigInt(actualRoundCount) };

    if (/^Eval: \d+ policies, \d+ rounds$/.test(session.notes ?? "")) {
      sessionPatch.notes = `Eval: ${session.policy_ids.length} policies, ${actualRoundCount} rounds`;
    }
    await ctx.db.patch(args.id, sessionPatch);

    const allPolicies = await ctx.db.query("policies").collect();
    const expectedCounts = await computePolicyCountsFromRoundResults(ctx, allPolicies);
    let patchedPolicies = 0;

    for (const policy of allPolicies) {
      const expected = expectedCounts.get(policy._id) ?? emptyCounts();
      if (
        policy.wins !== expected.wins ||
        policy.losses !== expected.losses ||
        policy.draws !== expected.draws
      ) {
        await ctx.db.patch(policy._id, {
          wins: expected.wins,
          losses: expected.losses,
          draws: expected.draws,
        });
        patchedPolicies += 1;
      }
    }

    return {
      sessionId: args.id,
      numRounds: actualRoundCount,
      patchedPolicies,
    };
  },
});
