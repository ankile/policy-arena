import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { computeEloUpdate } from "./elo";

export const submit = mutation({
  args: {
    dataset_repo: v.string(),
    notes: v.optional(v.string()),
    session_mode: v.optional(v.string()),
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
            num_frames: v.optional(v.int64()),
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
      session_mode: args.session_mode,
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
          ...(result.num_frames != null
            ? { num_frames: BigInt(Number(result.num_frames)) }
            : {}),
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

          if (a.success && !b.success) {
            // A wins — update ELO
            winDeltas.set(a.policyId, winDeltas.get(a.policyId)! + BigInt(1));
            lossDeltas.set(
              b.policyId,
              lossDeltas.get(b.policyId)! + BigInt(1)
            );
            const [newA, newB] = computeEloUpdate(ratingA, ratingB, 1);
            eloDeltas.set(a.policyId, newA - policyA.elo);
            eloDeltas.set(b.policyId, newB - policyB.elo);
          } else if (!a.success && b.success) {
            // B wins — update ELO
            lossDeltas.set(
              a.policyId,
              lossDeltas.get(a.policyId)! + BigInt(1)
            );
            winDeltas.set(b.policyId, winDeltas.get(b.policyId)! + BigInt(1));
            const [newA, newB] = computeEloUpdate(ratingA, ratingB, 0);
            eloDeltas.set(a.policyId, newA - policyA.elo);
            eloDeltas.set(b.policyId, newB - policyB.elo);
          } else {
            // Draw (both succeed or both fail) — no ELO update, no info gained
            drawDeltas.set(
              a.policyId,
              drawDeltas.get(a.policyId)! + BigInt(1)
            );
            drawDeltas.set(
              b.policyId,
              drawDeltas.get(b.policyId)! + BigInt(1)
            );
          }
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

    // Sort each round's results to match session.policy_ids order
    const policyIdOrder = session.policy_ids.map(String);
    for (const [, roundResults] of roundsMap) {
      roundResults.sort(
        (a, b) =>
          policyIdOrder.indexOf(a.policy_id) -
          policyIdOrder.indexOf(b.policy_id)
      );
    }

    return {
      ...session,
      policies,
      rounds: Array.from(roundsMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([index, results]) => ({ index, results })),
    };
  },
});

export const deleteSession = mutation({
  args: { id: v.id("evalSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    if (!session) throw new Error("Session not found");

    // 1. Delete round results for this session
    const results = await ctx.db
      .query("roundResults")
      .withIndex("by_session", (q) => q.eq("session_id", args.id))
      .collect();
    for (const r of results) {
      await ctx.db.delete(r._id);
    }

    // 2. Delete ALL eloHistory entries (will be recomputed)
    const allEloHistory = await ctx.db.query("eloHistory").collect();
    for (const e of allEloHistory) {
      await ctx.db.delete(e._id);
    }

    // 3. Delete the session
    await ctx.db.delete(args.id);

    // 4. Reset ALL policies to initial ELO
    const allPolicies = await ctx.db.query("policies").collect();
    for (const p of allPolicies) {
      await ctx.db.patch(p._id, {
        elo: 1500,
        wins: BigInt(0),
        losses: BigInt(0),
        draws: BigInt(0),
      });
    }

    // 5. Replay all remaining sessions chronologically to recompute ELO
    const remainingSessions = await ctx.db
      .query("evalSessions")
      .order("asc")
      .collect();

    for (const sess of remainingSessions) {
      const sessResults = await ctx.db
        .query("roundResults")
        .withIndex("by_session", (q) => q.eq("session_id", sess._id))
        .collect();

      // Group by round
      const roundsMap = new Map<
        number,
        Array<{ policyId: Id<"policies">; success: boolean }>
      >();
      for (const r of sessResults) {
        const roundIdx = Number(r.round_index);
        if (!roundsMap.has(roundIdx)) roundsMap.set(roundIdx, []);
        roundsMap.get(roundIdx)!.push({
          policyId: r.policy_id,
          success: r.success,
        });
      }

      // Compute pairwise ELO updates
      const eloDeltas = new Map<Id<"policies">, number>();
      const winDeltas = new Map<Id<"policies">, bigint>();
      const lossDeltas = new Map<Id<"policies">, bigint>();
      const drawDeltas = new Map<Id<"policies">, bigint>();

      for (const id of sess.policy_ids) {
        eloDeltas.set(id, 0);
        winDeltas.set(id, BigInt(0));
        lossDeltas.set(id, BigInt(0));
        drawDeltas.set(id, BigInt(0));
      }

      const sortedRounds = Array.from(roundsMap.entries()).sort(
        ([a], [b]) => a - b
      );

      for (const [, roundResults] of sortedRounds) {
        for (let i = 0; i < roundResults.length; i++) {
          for (let j = i + 1; j < roundResults.length; j++) {
            const a = roundResults[i];
            const b = roundResults[j];

            const policyA = (await ctx.db.get(a.policyId))!;
            const policyB = (await ctx.db.get(b.policyId))!;
            const ratingA = policyA.elo + eloDeltas.get(a.policyId)!;
            const ratingB = policyB.elo + eloDeltas.get(b.policyId)!;

            let scoreA: number;
            if (a.success && !b.success) {
              scoreA = 1;
              winDeltas.set(
                a.policyId,
                winDeltas.get(a.policyId)! + BigInt(1)
              );
              lossDeltas.set(
                b.policyId,
                lossDeltas.get(b.policyId)! + BigInt(1)
              );
            } else if (!a.success && b.success) {
              scoreA = 0;
              lossDeltas.set(
                a.policyId,
                lossDeltas.get(a.policyId)! + BigInt(1)
              );
              winDeltas.set(
                b.policyId,
                winDeltas.get(b.policyId)! + BigInt(1)
              );
            } else {
              scoreA = 0.5;
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

      // Apply ELO updates and write history
      for (const id of sess.policy_ids) {
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
          session_id: sess._id,
        });
      }
    }

    return { deleted: args.id, sessionsReplayed: remainingSessions.length };
  },
});

export const addRounds = mutation({
  args: {
    id: v.id("evalSessions"),
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
            num_frames: v.optional(v.int64()),
          })
        ),
      })
    ),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    if (!session) throw new Error("Session not found");

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

    // 2. Expand session's policy_ids if new policies appeared
    const existingPolicyIds = new Set(session.policy_ids.map(String));
    const updatedPolicyIds = [...session.policy_ids];
    for (const [, id] of artifactToId) {
      if (!existingPolicyIds.has(String(id))) {
        updatedPolicyIds.push(id);
      }
    }

    // 3. Insert round results and compute ELO updates for new rounds only
    const eloDeltas = new Map<Id<"policies">, number>();
    const winDeltas = new Map<Id<"policies">, bigint>();
    const lossDeltas = new Map<Id<"policies">, bigint>();
    const drawDeltas = new Map<Id<"policies">, bigint>();

    for (const round of args.rounds) {
      for (const result of round.results) {
        const policyId = artifactToId.get(result.wandb_artifact)!;
        if (!eloDeltas.has(policyId)) {
          eloDeltas.set(policyId, 0);
          winDeltas.set(policyId, BigInt(0));
          lossDeltas.set(policyId, BigInt(0));
          drawDeltas.set(policyId, BigInt(0));
        }

        await ctx.db.insert("roundResults", {
          session_id: args.id,
          round_index: BigInt(Number(round.round_index)),
          policy_id: policyId,
          success: result.success,
          episode_index: BigInt(Number(result.episode_index)),
          ...(result.num_frames != null
            ? { num_frames: BigInt(Number(result.num_frames)) }
            : {}),
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

          const policyA = (await ctx.db.get(a.policyId))!;
          const policyB = (await ctx.db.get(b.policyId))!;
          const ratingA = policyA.elo + eloDeltas.get(a.policyId)!;
          const ratingB = policyB.elo + eloDeltas.get(b.policyId)!;

          if (a.success && !b.success) {
            winDeltas.set(a.policyId, winDeltas.get(a.policyId)! + BigInt(1));
            lossDeltas.set(
              b.policyId,
              lossDeltas.get(b.policyId)! + BigInt(1)
            );
            const [newA, newB] = computeEloUpdate(ratingA, ratingB, 1);
            eloDeltas.set(a.policyId, newA - policyA.elo);
            eloDeltas.set(b.policyId, newB - policyB.elo);
          } else if (!a.success && b.success) {
            lossDeltas.set(
              a.policyId,
              lossDeltas.get(a.policyId)! + BigInt(1)
            );
            winDeltas.set(b.policyId, winDeltas.get(b.policyId)! + BigInt(1));
            const [newA, newB] = computeEloUpdate(ratingA, ratingB, 0);
            eloDeltas.set(a.policyId, newA - policyA.elo);
            eloDeltas.set(b.policyId, newB - policyB.elo);
          } else {
            drawDeltas.set(
              a.policyId,
              drawDeltas.get(a.policyId)! + BigInt(1)
            );
            drawDeltas.set(
              b.policyId,
              drawDeltas.get(b.policyId)! + BigInt(1)
            );
          }
        }
      }
    }

    // 4. Update session metadata
    const newNumRounds = session.num_rounds + BigInt(args.rounds.length);
    await ctx.db.patch(args.id, {
      num_rounds: newNumRounds,
      policy_ids: updatedPolicyIds,
      notes: `Eval: ${updatedPolicyIds.length} policies, ${newNumRounds} rounds`,
    });

    // 5. Apply ELO updates and update history
    for (const [id, delta] of eloDeltas) {
      const policy = (await ctx.db.get(id))!;
      const newElo =
        Math.round((policy.elo + delta) * 100) / 100;
      await ctx.db.patch(id, {
        elo: newElo,
        wins: policy.wins + winDeltas.get(id)!,
        losses: policy.losses + lossDeltas.get(id)!,
        draws: policy.draws + drawDeltas.get(id)!,
      });

      // Update or create eloHistory entry for this session
      const historyEntries = await ctx.db
        .query("eloHistory")
        .withIndex("by_policy", (q) => q.eq("policy_id", id))
        .collect();
      const existing = historyEntries.find((e) => e.session_id === args.id);

      if (existing) {
        await ctx.db.patch(existing._id, { elo: newElo });
      } else {
        await ctx.db.insert("eloHistory", {
          policy_id: id,
          elo: newElo,
          session_id: args.id,
        });
      }
    }

    return args.id;
  },
});

export const updateNotes = mutation({
  args: {
    id: v.id("evalSessions"),
    notes: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    if (!session) throw new Error("Session not found");
    await ctx.db.patch(args.id, { notes: args.notes });
    return args.id;
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
