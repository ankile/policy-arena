import type { StageLabelRow } from "../../convex/stageConsistency";
import type { TrajectoryReviewSpec } from "../../convex/trajectoryReview";
import { setActionOccurrences } from "./trajectoryActionEdits";
import { selectPrimaryFailure } from "./trajectoryUnifiedEvents";

export type VideoEventKind = "stage" | "action" | "failure";
export interface VideoEvent {
  key: string;
  kind: VideoEventKind;
  title: string;
  time: number | null;
  attempt: number | null;
}
export const readableEventName = (id: string) => id.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export function eventRecords(value: unknown): StageLabelRow[] {
  if (!Array.isArray(value) || !Array.from(value).every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
    throw new Error("An event list has an invalid structure. Inspect the source before editing it.");
  }
  return value;
}
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** A lossless display projection. Keys address the current arrays only and are
 * never persisted as event identities. Rendering does not repair source data. */
export function projectVideoEvents(spec: TrajectoryReviewSpec, row: StageLabelRow): VideoEvent[] {
  const task = spec.task_definition;
  const events: VideoEvent[] = [];
  eventRecords(row.stage_transitions).forEach((event, index) => {
    const stage = task.stages.find((s) => s.id === event.to_stage_id);
    events.push({ key: `transition:${index}`, kind: "stage", time: finite(event.time_s), attempt: finite(event.attempt_index),
      title: stage ? `S${stage.index} · ${stage.name === `S${stage.index}` ? readableEventName(stage.id) : stage.name}` : "Unknown stage" });
  });
  eventRecords(row.key_action_observations).forEach((action, index) => {
    const definition = task.keyActions.find((a) => a.id === action.action_id);
    eventRecords(action.occurrences).forEach((event, occurrence) => {
      events.push({ key: `action:${index}:${occurrence}`, kind: "action", time: finite(event.time_s), attempt: finite(event.attempt_index),
        title: definition?.name ?? "Unknown action" });
    });
  });
  eventRecords(row.failure_events).forEach((event, index) => {
    const definition = task.failureModes.find((f) => f.id === event.failure_mode_id);
    events.push({ key: `failure:${index}`, kind: "failure", time: finite(event.time_s), attempt: finite(event.attempt_index),
      title: definition ? readableEventName(definition.id) : "Unknown failure" });
  });
  return events.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
}

export interface EventCapture {
  kind: VideoEventKind;
  id: string;
  time: number;
  attempt: number;
  fromStageId?: string;
  updateMaximum?: boolean;
  primaryFailure?: boolean;
}

/** Explicit single-kind capture. No action/stage equivalence is inferred.
 * Existing records, order, precision and source evidence remain untouched. */
export function captureVideoEvent(spec: TrajectoryReviewSpec, row: StageLabelRow, capture: EventCapture, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(capture.time) || capture.time < 0 || capture.time > duration) {
    throw new Error("Choose a frame within the policy episode, before the reset footage.");
  }
  if (!Number.isSafeInteger(row.attempt_count) || Number(row.attempt_count) < 1 || !Number.isSafeInteger(capture.attempt) || capture.attempt < 1 || capture.attempt > Number(row.attempt_count)) {
    throw new Error("Choose an existing attempt. Update the episode attempt count to record another attempt.");
  }
  const task = spec.task_definition;
  const occurrence = { time_s: capture.time, attempt_index: capture.attempt, confidence: "medium", evidence: "" };
  let next = { ...row };
  let key: string;
  if (capture.kind === "stage") {
    const stage = task.stages.find((s) => s.id === capture.id);
    const from = task.stages.find((s) => s.id === capture.fromStageId);
    if (!stage || !from) throw new Error("Choose the stage reached and the previous stage.");
    const events = eventRecords(row.stage_transitions);
    key = `transition:${events.length}`;
    next.stage_transitions = [...events, { ...occurrence, from_stage_id: from.id, from_stage_index: from.index, to_stage_id: stage.id, to_stage_index: stage.index }];
    if (capture.updateMaximum) next = { ...next, max_stage: stage.index, max_stage_id: stage.id };
  } else if (capture.kind === "action") {
    if (!task.keyActions.some((a) => a.id === capture.id)) throw new Error("Choose a task-defined action.");
    const actions = eventRecords(row.key_action_observations);
    const matches = actions.map((a, i) => a.action_id === capture.id ? i : -1).filter((i) => i >= 0);
    if (matches.length !== 1) throw new Error("This action is missing or duplicated in the source. Resolve it before adding an occurrence.");
    const index = matches[0];
    const events = eventRecords(actions[index].occurrences);
    key = `action:${index}:${events.length}`;
    next.key_action_observations = actions.map((a, i) => i === index ? setActionOccurrences(a, [...events, occurrence]) : a);
  } else {
    if (!task.failureModes.some((f) => f.id === capture.id && f.id !== task.successDefinition.noFailureModeId)) throw new Error("Choose a failure mode.");
    const events = eventRecords(row.failure_events);
    key = `failure:${events.length}`;
    next.failure_events = [...events, { ...occurrence, failure_mode_id: capture.id }];
    if (capture.primaryFailure) next = selectPrimaryFailure(next, events.length);
  }
  return { row: next, key };
}
