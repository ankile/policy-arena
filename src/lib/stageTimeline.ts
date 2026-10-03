import type { StageLabelRow } from "../../convex/stageConsistency";
import type { TrajectoryReviewSpec } from "../../convex/trajectoryReview";
export class StageTimelineDataError extends Error {}
const readableEventName = (id: string) => id.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
function eventRecords(value: unknown): StageLabelRow[] {
  if (!Array.isArray(value) || !Array.from(value).every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
    throw new StageTimelineDataError("The stage timeline is malformed. Its original data is preserved; repair the source before labeling.");
  }
  return value;
}

export const stageTitle = (stage: { name: string; index: number; id: string }) =>
  `S${stage.index} · ${stage.name === `S${stage.index}` ? readableEventName(stage.id) : stage.name}`;
export function stageMarks(spec: TrajectoryReviewSpec, row: StageLabelRow) {
  return eventRecords(row.stage_transitions).map((event, index) => ({ index, event,
    stage: spec.task_definition.stages.find((s) => s.id === event.to_stage_id && s.index === event.to_stage_index),
    time: typeof event.time_s === "number" && Number.isFinite(event.time_s) ? event.time_s : null,
  }));
}
export function stageContext(spec: TrajectoryReviewSpec, row: StageLabelRow, time: number, attemptOverride?: number) {
  const marks = stageMarks(spec, row);
  const sorted = [...marks].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
  const validAttempt = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= Number(row.attempt_count);
  const attempt = attemptOverride ?? sorted.filter((m) => m.time !== null && m.time <= time && validAttempt(m.event.attempt_index)).at(-1)?.event.attempt_index ?? 1;
  const inAttempt = sorted.filter((m) => m.event.attempt_index === attempt);
  const past = inAttempt.filter((m) => m.time !== null && m.time >= 0 && m.time <= time && m.stage);
  const current = past.reduce<(typeof spec.task_definition.stages)[number] | null>((best, m) => !best || m.stage!.index > best.index ? m.stage! : best, null);
  // Suggest only unrecorded stages. Merely opening an episode must never offer
  // to move its first existing model mark to frame zero.
  const next = spec.task_definition.stages.find((s) => s.index > (current?.index ?? 0) && !inAttempt.some((m) => m.stage?.id === s.id)) ?? null;
  return { marks, sorted, inAttempt, attempt: Number(attempt), current, next };
}

/** Called only after an explicit human edit. The previous-stage references are
 * derived from the visible sequence, not a second hidden labeling task. Keep
 * array indices stable for focused timestamp inputs. */
export function relinkStagePredecessors(spec: TrajectoryReviewSpec, row: StageLabelRow, affectedAttempts: ReadonlySet<number>): StageLabelRow {
  const marks = stageMarks(spec, row);
  const previous = new Map<number, (typeof spec.task_definition.stages)[number]>();
  const replacements = new Map<number, StageLabelRow>();
  for (const mark of [...marks].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity))) {
    if (!mark.stage || mark.time === null || !Number.isSafeInteger(mark.event.attempt_index)) continue;
    const attempt = Number(mark.event.attempt_index);
    if (!affectedAttempts.has(attempt)) continue;
    const from = previous.get(attempt) ?? spec.task_definition.stages[0];
    replacements.set(mark.index, { ...mark.event, from_stage_id: from.id, from_stage_index: from.index });
    previous.set(attempt, mark.stage);
  }
  return { ...row, stage_transitions: marks.map((m) => replacements.get(m.index) ?? m.event) };
}

export function withStageMaximum(spec: TrajectoryReviewSpec, row: StageLabelRow): StageLabelRow {
  const marks = stageMarks(spec, row);
  // Malformed identities remain a visible validation error, never auto-repaired.
  if (marks.some((mark) => !mark.stage)) return row;
  const greatest = Math.max(0, ...marks.map((mark) => mark.stage!.index));
  const maximum = spec.task_definition.stages.find((stage) => stage.index === greatest)!;
  return { ...row, max_stage: maximum.index, max_stage_id: maximum.id };
}

export function removeStageMark(spec: TrajectoryReviewSpec, row: StageLabelRow, index: number): StageLabelRow {
  const marks = stageMarks(spec, row);
  if (!marks[index]) throw new StageTimelineDataError("This stage mark no longer exists.");
  return withStageMaximum(spec, relinkStagePredecessors(spec, { ...row,
    stage_transitions: marks.filter((mark) => mark.index !== index).map((mark) => mark.event),
  }, new Set([Number(marks[index].event.attempt_index)])));
}

/** A stage edit never updates action/failure records, even for formerly shared
 * times. Array identities remain stable; chronological repair is explicit. */
export function patchStageMark(spec: TrajectoryReviewSpec, row: StageLabelRow, index: number | null, stageId: string, time: number | null, attempt: number) {
  const stage = spec.task_definition.stages.find((s) => s.id === stageId);
  if (!stage || stage.index === 0) throw new Error("S0 is the starting state. Choose a reached stage to timestamp.");
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > Number(row.attempt_count)) throw new Error("Choose an existing attempt.");
  const events = eventRecords(row.stage_transitions);
  if (index !== null && !events[index]) throw new Error("This stage mark no longer exists.");
  const earlier = events.filter((e, i) => i !== index && e.attempt_index === attempt && typeof e.time_s === "number" && time !== null && e.time_s <= time && Number(e.to_stage_index) < stage.index)
    .sort((a, b) => Number(a.to_stage_index) - Number(b.to_stage_index)).at(-1);
  const from = spec.task_definition.stages.find((s) => s.id === earlier?.to_stage_id) ?? spec.task_definition.stages[0];
  const event = { ...(index === null ? { confidence: "medium", evidence: "" } : events[index]),
    from_stage_id: from.id, from_stage_index: from.index, to_stage_id: stage.id, to_stage_index: stage.index, time_s: time, attempt_index: attempt };
  const nextEvents = index === null ? [...events, event].sort((a, b) => Number(a.time_s ?? Infinity) - Number(b.time_s ?? Infinity))
    : events.map((e, i) => i === index ? event : e);
  const affected = new Set([attempt]);
  if (index !== null) affected.add(Number(events[index].attempt_index));
  return withStageMaximum(spec, relinkStagePredecessors(spec, { ...row, stage_transitions: nextEvents }, affected));
}
