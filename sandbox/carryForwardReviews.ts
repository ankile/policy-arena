import marker from "../data/stage-review/marker_d2_v6.spec.json";
import square from "../data/stage-review/square_d2_v5.spec.json";
import routing from "../data/stage-review/routing_d1_v4.spec.json";
import { stageReviewRelease } from "../shared/stageReviewRelease";
import { blankTrajectoryReview, normalizeTrajectoryReviewSpec, validTrajectoryIdentity } from "../convex/trajectoryReview";
import { validateStageOnlyReview } from "../convex/stageOnlyReview";
import { validateStageOutcomeReview } from "../convex/stageOutcomeReview";
import { CURRENT_REVIEW_FIELDS, CURRENT_REVIEW_PROTOCOL, stageReviewCoverage } from "../convex/stageReviewCoverage";
import type { LocalReview } from "./localReviewStore";
import { insertionFailureCorrection } from "./insertionFailureCorrection";

const predecessors = { marker_d2: marker, square_d2: square, routing_d1: routing };
type Task = keyof typeof predecessors;
const committed = (status: string) => ["confirmed", "corrected"].includes(status);
const identity = (row: LocalReview) => `${row.task}|${row.dataset_repo}|${row.episode_index}|${row.reviewer_user_id}`;

/** Only implications supported by the old category are mapped. In particular,
 * alignment errors do not establish whether an insertion was attempted. */
function failureMapping(task: Task, failure: string, maxStage: number): string {
  if (["pregrasp_misalignment", "grasp_not_attempted", "grasp_miss"].includes(failure)) {
    return task === "routing_d1" || maxStage < 2 ? "grasp_not_established" : "";
  }
  if (["none", "grasp_lost", "unknown_failure_cause"].includes(failure)) return failure;
  if (task === "routing_d1") {
    if (/^(first|second)_clip_(not_attempted|engagement_missed)$/.test(failure)) return failure;
    if (/^(first|second)_clip_seat_lost$/.test(failure)) return failure.replace("_seat_lost", "_retention_lost");
  } else {
    // The retained Marker v6 false-insertion category already meant SIDE/TABLE.
    // Top contact alone does not prove a push; the Nut miss category spans both
    // blocked entrance and off-target placement. Neither is safe to auto-map.
    if (task === "marker_d2" && failure === "false_insertion") return "false_insertion";
    if (["insertion_jammed", "released_hung_on_peg"].includes(failure)) return "incomplete_insertion";
    if (failure === "placement_lost_after_release") return "placement_lost";
  }
  return "";
}

/** Explicit, browser-local, append-only transfer. Only named predecessors and
 * the pinned, stage-preserving failure correction are supported. Existing
 * current-content reviews (including cleared/draft) always win. */
export function planCarryForward(reviews: LocalReview[], now = Date.now()) {
  const latest = new Map<string, LocalReview>();
  for (const row of reviews) latest.set(`${identity(row)}|${row.taxonomy_version}`, row);
  const additions: LocalReview[] = [];
  const blocked: { source: LocalReview; reason: string }[] = [];
  for (const source of latest.values()) {
    if (!(source.task in predecessors) || source.reviewer_user_id !== "local-reviewer") continue;
    const task = source.task as Task;
    const current = stageReviewRelease[task];
    const correction = insertionFailureCorrection[task];
    const failureCorrection = source.taxonomy_version === current.taxonomy_version &&
      current.trajectory.task_definition_sha256 === correction.targetDefinitionSha256 &&
      (source.local_task_definition_sha256 === undefined || source.local_task_definition_sha256 === correction.previousDefinitionSha256) &&
      source.label?.task_success === false && correction.recheckFailures.includes(String(source.label.failure_mode));
    const previous = failureCorrection ? current : predecessors[task];
    if (source.taxonomy_version !== previous.taxonomy_version || source.status === "cleared" || !source.label ||
      (!failureCorrection && latest.has(`${identity(source)}|${current.taxonomy_version}`))) continue;
    const previousTag = normalizeTrajectoryReviewSpec(previous.trajectory, task, previous.taxonomy_version);
    const currentTag = normalizeTrajectoryReviewSpec(current.trajectory, task, current.taxonomy_version);
    const old = source.label;
    if (!validTrajectoryIdentity(previousTag, old.trajectory_identity)) {
      blocked.push({ source, reason: "Source identity does not match its definition." }); continue;
    }
    const stageIssues = validateStageOnlyReview(previousTag, old, source.episode_duration_s);
    if (stageIssues.length) { blocked.push({ source, reason: stageIssues[0].message }); continue; }
    // Old prediction/action ledgers are preserved in the original, not passed off
    // as new-schema machine output or attached to a mismatching prediction ID.
    const label = blankTrajectoryReview(currentTag, source.dataset_repo, source.episode_index);
    const issues: string[] = failureCorrection && !committed(source.status) ? [...source.local_migration?.issues ?? []] : [];
    if (committed(source.status) && !CURRENT_REVIEW_FIELDS.every((field) => source.review_coverage?.reviewed_fields.includes(field))) {
      issues.push("Confirm the carried review: its earlier supervision did not cover every current review field.");
    }
    const stageId = (id: string, index: number) => {
      const before = previous.trajectory.task_definition.stages.find((stage) => stage.id === id && stage.index === index);
      const after = current.trajectory.task_definition.stages.find((stage) => stage.index === index);
      if (!before || !after || (id !== after.id && !(task !== "routing_d1" && index === 6))) {
        throw new Error("Unsupported stage mapping; originals were not changed.");
      }
      return after.id;
    };
    Object.assign(label, {
      max_stage: old.max_stage,
      max_stage_id: stageId(old.max_stage_id as string, old.max_stage as number),
      attempt_count: old.attempt_count,
      task_success: old.task_success,
      stage_transitions: (old.stage_transitions as Record<string, unknown>[]).map((event) => ({
        ...event,
        from_stage_id: stageId(event.from_stage_id as string, event.from_stage_index as number),
        to_stage_id: stageId(event.to_stage_id as string, event.to_stage_index as number),
      })),
    });
    if (!failureCorrection && task !== "routing_d1" && old.max_stage === 6) {
      issues.push("Check S6 timing: the saved release timestamp is preserved; full seating may have occurred earlier.");
    }
    if (!failureCorrection && task === "routing_d1") {
      issues.push("Check clip identity and order: first means LEFT, second means RIGHT. A right-clip insertion attempt before left seating is a terminal failure. Stage marks and the human outcome were preserved for review.");
    }
    const mapped = failureCorrection ? "" : failureMapping(task, String(old.failure_mode ?? ""), Number(old.max_stage));
    label.failure_mode = old.task_success === true ? "none" : mapped;
    if (old.task_success === false && (!mapped || mapped === "none")) {
      label.failure_mode = "";
      issues.push(`Choose the new failure category (previously ${String(old.failure_mode).replaceAll("_", " ")}).`);
    }
    const validation = validateStageOutcomeReview(currentTag, label, source.episode_duration_s);
    // Failure selection already has a clearer, migration-specific explanation.
    for (const item of validation) if (!item.fields.includes("failure_mode")) issues.push(item.message);
    const status = committed(source.status) && issues.length === 0 && validation.length === 0
      ? source.status : source.status === "uncertain" ? "uncertain" : "draft";
    additions.push({
      _id: `carry-forward-v2:${source._id}`, task, dataset_repo: source.dataset_repo,
      local_task_definition_sha256: current.trajectory.task_definition_sha256,
      episode_index: source.episode_index, taxonomy_version: current.taxonomy_version,
      reviewer: source.reviewer, reviewer_user_id: source.reviewer_user_id,
      saved_at: now, status, label, notes: source.notes ?? "",
      ...(source.blind === undefined ? {} : { blind: source.blind }),
      episode_duration_s: source.episode_duration_s,
      review_protocol: CURRENT_REVIEW_PROTOCOL,
      review_coverage: stageReviewCoverage(CURRENT_REVIEW_PROTOCOL, status, true),
      local_migration: {
        version: "trajectory-v2-carry-forward/v1", source_review_id: source._id,
        source_taxonomy: source.taxonomy_version, source_saved_at: source.saved_at,
        issues, failure_mapping: { from: String(old.failure_mode ?? ""), to: String(label.failure_mode) },
      },
    });
  }
  return { additions, blocked };
}
