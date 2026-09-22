import type { StageLabelRow } from "../../convex/stageConsistency";
import type { TrajectoryReviewSpec } from "../../convex/trajectoryReview";
import type { TrajectoryEventLink } from "../../convex/trajectoryEventLinks";
import { eventRecords, projectVideoEvents, type VideoEvent } from "./trajectoryVideoEvents";
import { patchActionOccurrence } from "./trajectoryActionEdits";
import { getUnifiedEventCandidates, setUnifiedEventTime } from "./trajectoryUnifiedEvents";

/** Suggestions, not a state-machine constraint. Future labels may suggest the
 * next item to review, but never establish progress or completed actions now.
 * Stage order is a fallback; skips, alternate paths and retries stay available. */
export function progressAtTime(spec: TrajectoryReviewSpec, row: StageLabelRow, time: number, attemptOverride?: number) {
  const events = projectVideoEvents(spec, row);
  const count = row.attempt_count;
  if (!Number.isSafeInteger(count) || Number(count) < 1) throw new Error("Set a valid episode attempt count in Episode summary.");
  const validAttempt = (value: number | null | undefined): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= Number(count);
  if (attemptOverride !== undefined && !validAttempt(attemptOverride)) throw new Error("Choose an existing attempt.");
  const valid = events.filter((event) => event.time !== null && event.time >= 0 && validAttempt(event.attempt));
  const inferredAttempt = valid.filter((event) => event.time! <= time).at(-1)?.attempt ?? 1;
  const attempt = attemptOverride ?? inferredAttempt;
  const inAttempt = events.filter((event) => event.attempt === attempt);
  const past = inAttempt.filter((event) => event.time !== null && event.time >= 0 && event.time <= time);
  const stages = [...spec.task_definition.stages].sort((a, b) => a.index - b.index);
  const stageMarks = past.filter((event) => event.kind === "stage" && event.definitionId);
  const current = stages.filter((stage) => stageMarks.some((event) => event.definitionId === stage.id)).at(-1) ?? null;
  const baseline = current ?? stages[0];
  const futureStage = inAttempt.find((event) => event.kind === "stage" && event.time !== null && event.time > time &&
    stages.some((stage) => stage.id === event.definitionId && stage.index > baseline.index));
  const next = stages.find((stage) => stage.id === futureStage?.definitionId) ?? stages.find((stage) => stage.index > baseline.index) ?? null;
  const recordedNext = next ? inAttempt.filter((event) => event.kind === "stage" && event.definitionId === next.id) : [];
  const nextEvent = recordedNext.length === 1 ? recordedNext[0] : null;
  const nextAmbiguous = recordedNext.length > 1;
  const actions = spec.task_definition.keyActions.flatMap((action) => {
    const marks = inAttempt.filter((event) => event.kind === "action" && event.definitionId === action.id);
    if (past.some((event) => event.kind === "action" && event.definitionId === action.id)) return [];
    const nearby = action.stageLinks.filter((link) => link.stageId === baseline.id || link.stageId === next?.id);
    if (!nearby.length) return [];
    return [{ definition: action, existing: marks.length === 1 ? marks[0] : null, ambiguous: marks.length > 1,
      priority: nearby.some((link) => link.stageId === next?.id && link.relation === "required_for_entry") ? 0 : 1 }];
  }).sort((a, b) => a.priority - b.priority);
  return { events, attempt, current, baseline, next, nextEvent, nextAmbiguous, actions, past };
}

/** Resolve the existing explicit/shared semantics before offering a retime. */
export function sharedGroupForEvent(spec: TrajectoryReviewSpec, row: StageLabelRow, event: VideoEvent, links: TrajectoryEventLink[]) {
  return getUnifiedEventCandidates(spec, row).find((group) =>
    (event.key === `transition:${group.transitionIndex}` || event.key === `action:${group.actionIndex}:${group.occurrenceIndex}`) &&
    (group.relation === "equivalent" || links.some((link) => link.action_id === group.actionId && link.stage_id === group.stageId && link.attempt_index === group.attemptIndex && link.relation === "shared")) &&
    !links.some((link) => link.action_id === group.actionId && link.stage_id === group.stageId && link.attempt_index === group.attemptIndex && link.relation === "distinct"));
}

/** Retimes the advertised record, never appends a duplicate or erases evidence. */
export function moveProgressEvent(spec: TrajectoryReviewSpec, row: StageLabelRow, event: VideoEvent, time: number, duration: number, links: TrajectoryEventLink[]) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(time) || time < 0 || time > duration) throw new Error("Choose a frame inside the policy episode.");
  const live = projectVideoEvents(spec, row).find((item) => item.key === event.key);
  if (!live || live.definitionId !== event.definitionId || live.attempt !== event.attempt || live.time !== event.time) throw new Error("This mark changed. Select it again before moving it.");
  const group = sharedGroupForEvent(spec, row, event, links);
  if (group) return setUnifiedEventTime(spec, row, group.id, time);
  const [, index, occurrence] = event.key.split(":").map(Number);
  if (event.kind === "stage") return { ...row, stage_transitions: eventRecords(row.stage_transitions).map((item, i) => i === index ? { ...item, time_s: time } : item) };
  if (event.kind === "action") return { ...row, key_action_observations: eventRecords(row.key_action_observations).map((item, i) => i === index ? patchActionOccurrence(item, occurrence, { time_s: time }) : item) };
  throw new Error("Use the failure inspector to move a failure mark.");
}
