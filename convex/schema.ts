import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  policies: defineTable({
    name: v.string(),
    model_id: v.string(),
    model_url: v.optional(v.string()),
    training_url: v.optional(v.string()),
    environment: v.string(),
    elo: v.optional(v.float64()),
    wins: v.optional(v.int64()),
    losses: v.optional(v.int64()),
    draws: v.optional(v.int64()),
    status: v.optional(v.string()),
    effective_status: v.optional(v.string()),
  })
    .index("by_model_id", ["model_id"])
    .index("by_environment", ["environment"]),

  evalSessions: defineTable({
    dataset_repo: v.string(),
    num_rounds: v.int64(),
    policy_ids: v.array(v.id("policies")),
    submission_id: v.optional(v.string()),
    submission_fingerprint: v.optional(v.string()),
    notes: v.optional(v.string()),
    session_mode: v.optional(v.string()), // "manual" | "pool-sample" | "calibrate" | "rollout"
    excluded: v.optional(v.boolean()), // true → hidden from UI and dropped from ELO/success-rate metrics
    exclusion_reason: v.optional(v.string()), // why this session was excluded (for future reference)
    operator: v.optional(v.string()),
    status: v.optional(v.string()),
    status_reason: v.optional(v.string()),
    effective_status: v.optional(v.string()),
  }).index("by_submission_id", ["submission_id"]),

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
    dataset_role: v.optional(v.string()), // "aggregate_parent" | "training_view" | "eval_session" | "rollout"
    trainable: v.optional(v.boolean()),
    environment: v.string(),
    num_episodes: v.optional(v.int64()),
    total_duration_seconds: v.optional(v.float64()),
    num_success: v.optional(v.int64()),
    num_failure: v.optional(v.int64()),
    num_human_frames: v.optional(v.int64()),
    num_policy_frames: v.optional(v.int64()),
    num_autonomous_success: v.optional(v.int64()),
    stats_algorithm_version: v.optional(v.string()),
    stats_computed_at: v.optional(v.float64()),
    stats_hf_sha: v.optional(v.string()),
    stats_status: v.optional(v.string()),
    status: v.optional(v.string()),
    effective_status: v.optional(v.string()),
    model_id: v.optional(v.string()), // programmatic policy lookup key (URI-prefixed)
    model_url: v.optional(v.string()), // human-facing link (W&B artifact/run, HF Hub, etc.)
    parent_repo_id: v.optional(v.string()),
    derived_repo_ids: v.optional(v.array(v.string())),
    mutually_exclusive_with: v.optional(v.array(v.string())),
    view_family_id: v.optional(v.string()),
    view_id: v.optional(v.string()),
    producer_model_ids: v.optional(v.array(v.string())),
    target_model_id: v.optional(v.string()),
    target_arm_key: v.optional(v.string()),
    notes: v.optional(v.string()),
  })
    .index("by_repo", ["repo_id"])
    .index("by_task", ["task"])
    .index("by_dataset_role", ["dataset_role"])
    .index("by_source_type", ["source_type"]),
});
