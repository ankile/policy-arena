import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  policies: defineTable({
    name: v.string(),
    wandb_artifact: v.string(),
    wandb_run_url: v.optional(v.string()),
    environment: v.string(),
    elo: v.float64(),
    wins: v.int64(),
    losses: v.int64(),
    draws: v.int64(),
  })
    .index("by_artifact", ["wandb_artifact"])
    .index("by_environment", ["environment"]),

  evalSessions: defineTable({
    dataset_repo: v.string(),
    num_rounds: v.int64(),
    policy_ids: v.array(v.id("policies")),
    notes: v.optional(v.string()),
    session_mode: v.optional(v.string()),  // "manual" | "pool-sample" | "calibrate"
  }),

  roundResults: defineTable({
    session_id: v.id("evalSessions"),
    round_index: v.int64(),
    policy_id: v.id("policies"),
    success: v.boolean(),
    episode_index: v.int64(),
    num_frames: v.optional(v.int64()),
  })
    .index("by_session", ["session_id"])
    .index("by_policy", ["policy_id"]),

  eloHistory: defineTable({
    policy_id: v.id("policies"),
    elo: v.float64(),
    session_id: v.id("evalSessions"),
  }).index("by_policy", ["policy_id"]),

  datasets: defineTable({
    repo_id: v.string(),
    name: v.string(),
    task: v.string(),
    source_type: v.string(), // "teleop" | "rollout" | "dagger" | "eval"
    environment: v.string(),
    num_episodes: v.optional(v.int64()),
    total_duration_seconds: v.optional(v.float64()),
    num_success: v.optional(v.int64()),
    num_failure: v.optional(v.int64()),
    num_human_frames: v.optional(v.int64()),
    num_policy_frames: v.optional(v.int64()),
    num_autonomous_success: v.optional(v.int64()),
    wandb_artifact: v.optional(v.string()),
    notes: v.optional(v.string()),
  })
    .index("by_repo", ["repo_id"])
    .index("by_task", ["task"])
    .index("by_source_type", ["source_type"]),
});
