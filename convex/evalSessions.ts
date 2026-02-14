import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { computeEloUpdate } from "./elo";

export const submit = mutation({
  args: {
    dataset_repo: v.string(),
    notes: v.optional(v.string()),
    policies: v.array(
      v.object({
        name: v.string(),
        wandb_artifact: v.string(),
        wandb_run_url: v.optional(v.string()),
        environment: v.string(),
      })
    ),
    rounds: v.array(
      v.object({
        round_index: v.int64(),
        results: v.array(
          v.object({
            wandb_artifact: v.string(),
            success: v.boolean(),
            episode_index: v.int64(),
          })
        ),
      })
    ),
  },
  handler: async (ctx, args) => {
    // 1. Register/upsert all policies
    const artifactToId = new Map<string, Id<"policies">>();
    for (const p of args.policies) {
      const existing = await ctx.db
        .query("policies")
        .withIndex("by_artifact", (q) =>
          q.eq("wandb_artifact", p.wandb_artifact)
        )
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, {
          name: p.name,
          wandb_run_url: p.wandb_run_url,
          environment: p.environment,
        });
        artifactToId.set(p.wandb_artifact, existing._id);
      } else {
        const id = await ctx.db.insert("policies", {
          name: p.name,
          wandb_artifact: p.wandb_artifact,
          wandb_run_url: p.wandb_run_url,
          environment: p.environment,
          elo: 1500,
          wins: BigInt(0),
          losses: BigInt(0),
          draws: BigInt(0),
        });
        artifactToId.set(p.wandb_artifact, id);
      }
    }

    const policyIds = args.policies.map(
      (p) => artifactToId.get(p.wandb_artifact)!
    );

    // 2. Create eval session
    const sessionId = await ctx.db.insert("evalSessions", {
      dataset_repo: args.dataset_repo,
      num_rounds: BigInt(args.rounds.length),
      policy_ids: policyIds,
      notes: args.notes,
    });

    // 3. Insert round results and compute ELO updates
    // Track cumulative ELO changes across all rounds
    const eloDeltas = new Map<Id<"policies">, number>();
    const winDeltas = new Map<Id<"policies">, bigint>();
    const lossDeltas = new Map<Id<"policies">, bigint>();
    const drawDeltas = new Map<Id<"policies">, bigint>();

    for (const id of policyIds) {
      eloDeltas.set(id, 0);
      winDeltas.set(id, BigInt(0));
      lossDeltas.set(id, BigInt(0));
      drawDeltas.set(id, BigInt(0));
    }

    for (const round of args.rounds) {
      // Insert round results
      for (const result of round.results) {
        const policyId = artifactToId.get(result.wandb_artifact)!;
        await ctx.db.insert("roundResults", {
          session_id: sessionId,
          round_index: BigInt(Number(round.round_index)),
          policy_id: policyId,
          success: result.success,
          episode_index: BigInt(Number(result.episode_index)),
        });
      }

      // Compute pairwise ELO updates for this round
      const roundResults = round.results.map((r) => ({
        policyId: artifactToId.get(r.wandb_artifact)!,
        success: r.success,
      }));

      for (let i = 0; i < roundResults.length; i++) {
        for (let j = i + 1; j < roundResults.length; j++) {
          const a = roundResults[i];
          const b = roundResults[j];

          // Get current ELO (base + accumulated delta)
          const policyA = (await ctx.db.get(a.policyId))!;
          const policyB = (await ctx.db.get(b.policyId))!;
          const ratingA = policyA.elo + eloDeltas.get(a.policyId)!;
          const ratingB = policyB.elo + eloDeltas.get(b.policyId)!;

          let scoreA: number;
          if (a.success && !b.success) {
            scoreA = 1; // A wins
            winDeltas.set(a.policyId, winDeltas.get(a.policyId)! + BigInt(1));
            lossDeltas.set(
              b.policyId,
              lossDeltas.get(b.policyId)! + BigInt(1)
            );
          } else if (!a.success && b.success) {
            scoreA = 0; // B wins
            lossDeltas.set(
              a.policyId,
              lossDeltas.get(a.policyId)! + BigInt(1)
            );
            winDeltas.set(b.policyId, winDeltas.get(b.policyId)! + BigInt(1));
          } else {
            scoreA = 0.5; // Draw
            drawDeltas.set(
              a.policyId,
              drawDeltas.get(a.policyId)! + BigInt(1)
            );
            drawDeltas.set(
              b.policyId,
              drawDeltas.get(b.policyId)! + BigInt(1)
            );
          }

          const [newA, newB] = computeEloUpdate(ratingA, ratingB, scoreA);
          eloDeltas.set(a.policyId, newA - policyA.elo);
          eloDeltas.set(b.policyId, newB - policyB.elo);
        }
      }
    }

    // 4. Apply ELO updates to policies and write history
    for (const id of policyIds) {
      const policy = (await ctx.db.get(id))!;
      const newElo =
        Math.round((policy.elo + eloDeltas.get(id)!) * 100) / 100;
      await ctx.db.patch(id, {
        elo: newElo,
        wins: policy.wins + winDeltas.get(id)!,
        losses: policy.losses + lossDeltas.get(id)!,
        draws: policy.draws + drawDeltas.get(id)!,
      });

      await ctx.db.insert("eloHistory", {
        policy_id: id,
        elo: newElo,
        session_id: sessionId,
      });
    }

    return sessionId;
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const sessions = await ctx.db
      .query("evalSessions")
      .order("desc")
      .collect();

    return Promise.all(
      sessions.map(async (session) => {
        const policyNames = await Promise.all(
          session.policy_ids.map(async (id) => {
            const policy = await ctx.db.get(id);
            return policy?.name ?? "Unknown";
          })
        );
        return {
          ...session,
          policyNames,
        };
      })
    );
  },
});

export const getDetail = query({
  args: { id: v.id("evalSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    if (!session) return null;

    const results = await ctx.db
      .query("roundResults")
      .withIndex("by_session", (q) => q.eq("session_id", args.id))
      .collect();

    // Group results by round
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
      const roundIdx = Number(r.round_index);
      if (!roundsMap.has(roundIdx)) roundsMap.set(roundIdx, []);
      const policy = await ctx.db.get(r.policy_id);
      roundsMap.get(roundIdx)!.push({
        policy_id: r.policy_id,
        policyName: policy?.name ?? "Unknown",
        success: r.success,
        episode_index: Number(r.episode_index),
      });
    }

    const policies = await Promise.all(
      session.policy_ids.map(async (id) => {
        const policy = await ctx.db.get(id);
        return policy!;
      })
    );

    return {
      ...session,
      policies,
      rounds: Array.from(roundsMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([index, results]) => ({ index, results })),
    };
  },
});

export const getByPolicy = query({
  args: { policy_id: v.id("policies") },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("roundResults")
      .withIndex("by_policy", (q) => q.eq("policy_id", args.policy_id))
      .collect();

    // Get unique session IDs
    const sessionIds = [
      ...new Set(results.map((r) => r.session_id)),
    ] as Id<"evalSessions">[];
    const sessions = await Promise.all(
      sessionIds.map(async (id) => {
        const session = await ctx.db.get(id);
        return session!;
      })
    );

    return sessions.sort((a, b) => b._creationTime - a._creationTime);
  },
});
