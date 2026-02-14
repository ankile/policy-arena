import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export const seedData = mutation({
  args: {},
  handler: async (ctx) => {
    // Check if already seeded
    const existing = await ctx.db.query("policies").first();
    if (existing) {
      return "Already seeded";
    }

    // Seed policies
    const policiesData = [
      {
        name: "DiffusionPolicy-25k",
        wandb_artifact: "ankile/dp-franka/dp-25k:v0",
        wandb_run_url: "https://wandb.ai/ankile/dp-franka/runs/abc123",
        environment: "franka_pick_cube",
        elo: 1680,
        wins: BigInt(45),
        losses: BigInt(15),
        draws: BigInt(10),
      },
      {
        name: "DiffusionPolicy-50k",
        wandb_artifact: "ankile/dp-franka/dp-50k:v0",
        wandb_run_url: "https://wandb.ai/ankile/dp-franka/runs/def456",
        environment: "franka_pick_cube",
        elo: 1720,
        wins: BigInt(52),
        losses: BigInt(12),
        draws: BigInt(8),
      },
      {
        name: "ACT-Large",
        wandb_artifact: "ankile/act-franka/act-large:v0",
        wandb_run_url: "https://wandb.ai/ankile/act-franka/runs/ghi789",
        environment: "franka_pick_cube",
        elo: 1550,
        wins: BigInt(30),
        losses: BigInt(28),
        draws: BigInt(12),
      },
      {
        name: "ACT-Small",
        wandb_artifact: "ankile/act-franka/act-small:v0",
        environment: "franka_pick_cube",
        elo: 1480,
        wins: BigInt(22),
        losses: BigInt(35),
        draws: BigInt(13),
      },
      {
        name: "VQ-BeT-v1",
        wandb_artifact: "ankile/vqbet-franka/vqbet-v1:v0",
        wandb_run_url: "https://wandb.ai/ankile/vqbet-franka/runs/jkl012",
        environment: "franka_pick_cube",
        elo: 1600,
        wins: BigInt(38),
        losses: BigInt(22),
        draws: BigInt(10),
      },
      {
        name: "BC-Transformer",
        wandb_artifact: "ankile/bc-franka/bc-transformer:v0",
        environment: "franka_pick_cube",
        elo: 1420,
        wins: BigInt(18),
        losses: BigInt(40),
        draws: BigInt(12),
      },
      {
        name: "MLP-MSE-Baseline",
        wandb_artifact: "ankile/mlp-franka/mlp-mse:v0",
        environment: "franka_pick_cube",
        elo: 1350,
        wins: BigInt(12),
        losses: BigInt(48),
        draws: BigInt(10),
      },
    ];

    const policyIds: Id<"policies">[] = [];
    for (const p of policiesData) {
      const id = await ctx.db.insert("policies", p);
      policyIds.push(id);
    }

    // Seed an eval session
    const sessionId = await ctx.db.insert("evalSessions", {
      dataset_repo: "ankile/eval-session-2026-02-14",
      num_rounds: BigInt(5),
      policy_ids: [policyIds[0], policyIds[1], policyIds[2]],
      notes: "Initial comparison of DP-25k vs DP-50k vs ACT-Large",
    });

    // Seed round results
    const roundOutcomes = [
      // Round 0: DP-25k success, DP-50k success, ACT-Large fail
      [true, true, false],
      // Round 1: DP-25k fail, DP-50k success, ACT-Large fail
      [false, true, false],
      // Round 2: DP-25k success, DP-50k success, ACT-Large success
      [true, true, true],
      // Round 3: DP-25k success, DP-50k fail, ACT-Large fail
      [true, false, false],
      // Round 4: DP-25k fail, DP-50k success, ACT-Large success
      [false, true, true],
    ];

    const participantIds = [policyIds[0], policyIds[1], policyIds[2]];
    let episodeIdx = 0;
    for (let roundIdx = 0; roundIdx < roundOutcomes.length; roundIdx++) {
      for (let pIdx = 0; pIdx < participantIds.length; pIdx++) {
        await ctx.db.insert("roundResults", {
          session_id: sessionId,
          round_index: BigInt(roundIdx),
          policy_id: participantIds[pIdx],
          success: roundOutcomes[roundIdx][pIdx],
          episode_index: BigInt(episodeIdx),
        });
        episodeIdx++;
      }
    }

    // Seed ELO history
    for (const id of policyIds) {
      const policy = (await ctx.db.get(id))!;
      await ctx.db.insert("eloHistory", {
        policy_id: id,
        elo: policy.elo,
        session_id: sessionId,
      });
    }

    return `Seeded ${policyIds.length} policies and 1 eval session`;
  },
});
