import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { statusValidator } from "./statusShared";

export default defineSchema({
  ...authTables,

  // Hand-managed task/line lifecycle status (see statusShared.ts). Lives in
  // its own table because taskSpecs/stageTaskSpecs are db.replace()d wholesale
  // by the Python exporters and would destroy hand-set fields. Per-entity
  // `status` overrides on policies/evalSessions/datasets take precedence;
  // tasks without a row are mainline.
  taskStatuses: defineTable({
    task: v.string(), // matches policies.environment / datasets.task
    status: statusValidator,
    reason: v.optional(v.string()),
    superseded_by: v.optional(v.string()), // e.g. insert_marker_d1_v0 -> insert_marker_d1
    updated_at: v.float64(),
    updated_by: v.string(),
  }).index("by_task", ["task"]),

  // Overrides authTables.users to add the Hugging Face username — the
  // DISPLAY/audit string; authorization keys on the OIDC sub via
  // authAccounts.providerAccountId + ARENA_EDITOR_SUBS (see access.ts).
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.float64()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.float64()),
    isAnonymous: v.optional(v.boolean()),
    username: v.optional(v.string()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),

  policies: defineTable({
    name: v.string(),
    model_id: v.string(),
    model_url: v.optional(v.string()),
    training_url: v.optional(v.string()),
    environment: v.string(),
    status: v.optional(statusValidator), // override; absent = inherit from task
    status_reason: v.optional(v.string()),
  })
    .index("by_model_id", ["model_id"])
    .index("by_environment", ["environment"]),

  evalSessions: defineTable({
    dataset_repo: v.string(),
    num_rounds: v.int64(),
    policy_ids: v.array(v.id("policies")),
    notes: v.optional(v.string()),
    session_mode: v.optional(v.string()),  // "manual" | "pool-sample" | "calibrate" | "rollout"
    status: v.optional(statusValidator), // override; absent = inherit from task
    status_reason: v.optional(v.string()),
    // Who physically ran the eval — an HF USERNAME from the `operators`
    // registry (validated at write). Stored as the username (not a users id)
    // so it can be recorded before the person ever signs in; once they log in
    // via HF OAuth, users.username makes the join to their account.
    operator: v.optional(v.string()),
  }),

  // Registry of known eval operators (HF usernames). Sessions validate their
  // `operator` against this table; the UI select is populated from it.
  operators: defineTable({
    hf_username: v.string(),
    added_at: v.float64(),
    added_by: v.string(),
  }).index("by_username", ["hf_username"]),

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

  // Append-only human outcome reviews (web port of sir/tools/outcome_editor).
  // Latest row per (dataset_repo, episode_index) wins; "cleared" undoes.
  outcomeReviews: defineTable({
    dataset_repo: v.string(),
    episode_index: v.int64(),
    status: v.string(), // "confirmed" | "skipped" | "cleared"
    new_outcome: v.optional(v.string()), // "success" | "failure" | "timeout"
    outcome_frame: v.optional(v.int64()),
    soft_truncate: v.optional(v.boolean()),
    subtask_frames: v.optional(v.array(v.int64())),
    reviewer: v.string(),
    reviewer_user_id: v.optional(v.id("users")),
    saved_at: v.float64(),
  })
    .index("by_repo", ["dataset_repo"])
    .index("by_repo_episode", ["dataset_repo", "episode_index"]),

  // Jobs bridging web reviews to HF via the Python apply worker.
  applyJobs: defineTable({
    dataset_repo: v.string(),
    status: v.string(), // pending | applying | applied | failed | cancelled
    requested_by: v.string(),
    requested_at: v.float64(),
    worker_id: v.optional(v.string()),
    started_at: v.optional(v.float64()),
    finished_at: v.optional(v.float64()),
    hf_commit_sha: v.optional(v.string()),
    pre_apply_sha: v.optional(v.string()),
    error: v.optional(v.string()),
    log_tail: v.optional(v.string()),
    num_confirmed: v.optional(v.int64()),
    num_skipped: v.optional(v.int64()),
    dry_run: v.optional(v.boolean()),
  })
    .index("by_repo", ["dataset_repo"])
    .index("by_status", ["status"]),

  workerHeartbeats: defineTable({
    worker_id: v.string(),
    last_seen: v.float64(),
    info: v.optional(v.string()),
  }).index("by_worker", ["worker_id"]),

  // Task-spec data exported from the Python task registry (RealTaskSpec) —
  // NEVER hand-edited. sir/tools/export_arena_task_specs.py is the sole
  // writer; the UI reads crop boxes / subtask-mark counts from here instead
  // of mirroring Python constants in TS. Phase 2 extends this with the full
  // StageLabelTaskSpec export.
  taskSpecs: defineTable({
    task: v.string(), // RealTaskSpec.name — matches datasets.task
    task_name: v.string(), // LeRobot/collection task name, e.g. "Square_D1"
    num_subtask_marks: v.int64(),
    // Crop reference space [H, W] (stored-frame pixels; station frames are 480x640).
    stored_frame_hw: v.array(v.int64()),
    // Station role -> serial-eye camera key (e.g. side_1 -> "25916956_left").
    camera_keys_by_role: v.record(v.string(), v.string()),
    // Station role -> effective display crop [x0, y0, x1, y1] in stored-frame
    // pixels, half-open (defaults merged with RealTaskSpec.camera_crop_overrides).
    crop_boxes: v.record(v.string(), v.array(v.int64())),
    // Default review camera roles in display order (RealTaskSpec.
    // consumed_camera_roles, e.g. marker_d2 -> ["side_1", "wrist_left"]);
    // empty/absent = show every stream. Optional so pre-field rows validate.
    review_camera_roles: v.optional(v.array(v.string())),
    exported_at: v.float64(),
    source: v.string(), // exporter provenance (host + sir git sha)
  }).index("by_task", ["task"]),

  // Stage-label task specs (Phase 2): the FULL StageLabelTaskSpec vocabulary,
  // exported per (task, taxonomy_version) so LIVE and CANDIDATE taxonomies
  // coexist during taxonomy iteration (stage splits/removals). `spec` is the
  // serialized JSON from sir/real/stage_labeling/spec_export.py — service-
  // write-only exported data whose shape Python validates at export; storing
  // it opaque keeps this schema stable across taxonomy changes, and all
  // numbers arrive as plain float64 (no BigInt handling in the UI).
  stageTaskSpecs: defineTable({
    task: v.string(),
    taxonomy_version: v.string(),
    taxonomy_hash: v.string(),
    live: v.boolean(), // exactly one live version per task (enforced in upsert)
    spec: v.any(),
    exported_at: v.float64(),
    source: v.string(), // exporter provenance (host + sir git sha)
  })
    .index("by_task", ["task"])
    .index("by_task_version", ["task", "taxonomy_version"]),

  // VLM stage-label predictions ("prefills"): the most up-to-date prediction
  // per (dataset_repo, episode_index, taxonomy_version), pushed by
  // sir/tools/publish_stage_prefills.py when a labeling pipeline's output is
  // published. Service-write-only, replaced wholesale on re-publish —
  // prediction HISTORY lives in git run dirs and the HF .label_history.jsonl
  // ledger, not here. `label` is the full editable-field row keyed by the
  // spec's own field names (opaque; interpreted against stageTaskSpecs).
  stagePrefills: defineTable({
    task: v.string(),
    dataset_repo: v.string(),
    episode_index: v.int64(),
    taxonomy_version: v.string(),
    label: v.record(v.string(), v.any()),
    review_reason: v.optional(v.string()), // battery adjudication flags, verbatim
    violation_codes: v.optional(v.array(v.string())), // Python validate_label on the prediction
    confidence: v.optional(v.string()), // gemini consensus: low | medium | high
    vote_summary: v.optional(v.any()), // compact per-field sample votes
    episode_duration_s: v.optional(v.float64()),
    pipeline: v.object({
      name: v.string(),
      version: v.string(),
      git_commit: v.string(),
    }),
    evidence: v.any(), // run_name/model/prompt_variant/samples/labels_csv_sha256/urls
    pushed_at: v.float64(),
    source: v.string(),
  })
    .index("by_repo", ["dataset_repo"])
    .index("by_task", ["task"])
    .index("by_repo_episode", ["dataset_repo", "episode_index"]),

  // Append-only human stage reviews (multi-reviewer). Latest row per
  // (dataset_repo, episode_index, taxonomy_version, reviewer) wins; "cleared"
  // folds out. Gold consolidation (sir refresh_stage_gold) pulls committed
  // rows (confirmed | corrected) and re-validates them authoritatively with
  // the Python validator before they can become consolidated_gold.csv rows.
  stageReviews: defineTable({
    task: v.string(),
    dataset_repo: v.string(),
    episode_index: v.int64(),
    taxonomy_version: v.string(),
    status: v.string(), // confirmed | corrected | uncertain | draft | cleared
    label: v.optional(v.record(v.string(), v.any())),
    notes: v.optional(v.string()),
    prefill_pushed_at: v.optional(v.float64()), // which prefill generation was shown
    blind: v.optional(v.boolean()), // reviewed with policy/arm identity hidden
    // Bounds context persisted with the row (prefills can be pruned later).
    episode_duration_s: v.optional(v.float64()),
    reviewer: v.string(),
    reviewer_user_id: v.optional(v.id("users")),
    saved_at: v.float64(),
  })
    .index("by_repo", ["dataset_repo"])
    .index("by_repo_episode", ["dataset_repo", "episode_index"])
    .index("by_task", ["task"]),

  datasets: defineTable({
    repo_id: v.string(),
    name: v.string(),
    task: v.string(),
    source_type: v.string(), // "teleop" | "rollout" | "dagger" | "eval"
    dataset_role: v.optional(v.string()), // "aggregate_parent" | "training_view" | "eval_session" | "rollout"
    trainable: v.optional(v.boolean()),
    status: v.optional(statusValidator), // override; absent = inherit from task
    status_reason: v.optional(v.string()),
    environment: v.string(),
    num_episodes: v.optional(v.int64()),
    total_duration_seconds: v.optional(v.float64()),
    num_success: v.optional(v.int64()),
    num_failure: v.optional(v.int64()),
    num_human_frames: v.optional(v.int64()),
    num_policy_frames: v.optional(v.int64()),
    num_autonomous_success: v.optional(v.int64()),
    stats_status: v.optional(
      v.union(v.literal("pending"), v.literal("ready"), v.literal("error"))
    ),
    stats_hf_sha: v.optional(v.string()),
    stats_computed_at: v.optional(v.float64()),
    stats_algorithm_version: v.optional(v.string()),
    stats_error: v.optional(v.string()),
    stats_refresh_requested_at: v.optional(v.float64()),
    model_id: v.optional(v.string()),        // programmatic policy lookup key (URI-prefixed)
    model_url: v.optional(v.string()),       // human-facing link (W&B artifact/run, HF Hub, etc.)
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
