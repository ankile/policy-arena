export const comparisonFields = [
  "success",
  "failure_reason",
  "furthest_stage",
] as const;
export type ComparisonField = (typeof comparisonFields)[number];
export type TaskId = "marker_d2" | "square_d2" | "routing_d1";
export const taskNames: Record<TaskId, string> = {
  marker_d2: "Marker",
  square_d2: "Nut / peg",
  routing_d1: "Routing",
};
export type StageMark = {
  to_stage_id: string;
  to_stage_index: number;
  attempt_index: number;
  time_s: number;
  evidence?: string;
};
export type Summary = {
  task_success: boolean;
  failure_mode_id: string;
  max_stage_id: string;
  max_stage_index: number;
};
export type ComparisonCase = {
  sample_id: string;
  task_id: TaskId;
  dataset: string;
  dataset_name: string;
  episode_index: number;
  duration_s: number;
  fps: number;
  hf_revision: string;
  cameras: { role: string; key: string; url: string; start_s: number }[];
  human: Summary & { stage_transitions: StageMark[]; attempt_count: number };
  predicted: Summary;
  model: {
    stage_transitions: StageMark[];
    notes: string;
    confidence: string;
    failure_events: {
      failure_mode_id: string;
      time_s: number;
      evidence: string;
    }[];
  };
  human_notes: string;
  matches: Record<ComparisonField, boolean>;
  all_match: boolean;
  definition_review_issues: string[];
  raw_response: string;
  request_prompt: string;
  response_model: string;
  attempt_sha256: string;
  source_review: {
    id: string;
    saved_at: number;
    task_definition_sha256: string;
  };
};
export type Definition = {
  taskId: TaskId;
  taxonomyVersion: string;
  displayName: string;
  stages: {
    id: string;
    index: number;
    name: string;
    description: string;
    entryCriteria: string[];
    exclusions: string[];
  }[];
  failureModes: { id: string; name?: string; description: string }[];
};
export type ComparisonBundle = {
  schema_version: "human-model-review-bundle/v1";
  comparison_sha256: string;
  requested_models: string[];
  resolved_models: string[];
  selection_note: string;
  tasks: Record<
    TaskId,
    {
      definition: Definition;
      system_prompt: string;
      definition_sha256: string;
      reference_sha256: string;
    }
  >;
  cases: ComparisonCase[];
};
export type ComparisonFilter =
  | "differences"
  | ComparisonField
  | "all"
  | "unreviewed";
export type Verdict = "unreviewed" | "human" | "model" | "criteria" | "unclear";
export type Feedback = {
  id: string;
  saved_at: string;
  comparison_sha256: string;
  sample_id: string;
  task_id: TaskId;
  source_review_id: string;
  attempt_sha256: string;
  verdicts: Record<ComparisonField, Verdict>;
  note: string;
  evidence_times_s: number[];
};
export const feedbackStorageKey = "policy-arena-label-comparison-feedback-v1";
export const freshVerdicts = (): Feedback["verdicts"] => ({
  success: "unreviewed",
  failure_reason: "unreviewed",
  furthest_stage: "unreviewed",
});

export function validateBundle(value: unknown): ComparisonBundle {
  const bundle = value as ComparisonBundle;
  if (
    bundle?.schema_version !== "human-model-review-bundle/v1" ||
    !Array.isArray(bundle.cases) ||
    bundle.cases.length !== 60
  ) {
    throw new Error("Expected the frozen 60-episode comparison bundle.");
  }
  const identities = new Set<string>();
  for (const row of bundle.cases) {
    if (
      identities.has(row.sample_id) ||
      row.sample_id !== `${row.dataset}#episode=${row.episode_index}`
    )
      throw new Error("Ambiguous comparison identity.");
    identities.add(row.sample_id);
    if (
      !bundle.tasks[row.task_id] ||
      !row.cameras.length ||
      !(row.duration_s > 0) ||
      !(row.fps > 0)
    )
      throw new Error("Missing task/video evidence.");
    const matches = {
      success: row.human.task_success === row.predicted.task_success,
      failure_reason:
        row.human.failure_mode_id === row.predicted.failure_mode_id,
      furthest_stage:
        row.human.max_stage_id === row.predicted.max_stage_id &&
        row.human.max_stage_index === row.predicted.max_stage_index,
    };
    if (
      comparisonFields.some((field) => row.matches[field] !== matches[field]) ||
      row.all_match !== comparisonFields.every((field) => matches[field])
    ) {
      throw new Error(
        "Comparison flags disagree with the saved human/model labels.",
      );
    }
    for (const camera of row.cameras) {
      if (
        !camera.url.startsWith(
          `https://huggingface.co/datasets/${row.dataset}/resolve/${row.hf_revision}/`,
        ) ||
        !Number.isFinite(camera.start_s) ||
        camera.start_s < 0
      ) {
        throw new Error(
          "Comparison video is not pinned to its reference revision.",
        );
      }
    }
  }
  return bundle;
}

export function latestFeedback(
  rows: Feedback[],
  baseline: string,
  sampleId: string,
) {
  return [...rows]
    .reverse()
    .find(
      (row) => row.comparison_sha256 === baseline && row.sample_id === sampleId,
    );
}

export function filterCases(
  bundle: ComparisonBundle,
  task: string,
  filter: ComparisonFilter,
  feedback: Feedback[],
) {
  return bundle.cases
    .filter(
      (row) =>
        (task === "all" || row.task_id === task) &&
        (filter === "all" ||
          (filter === "differences" && !row.all_match) ||
          (filter === "unreviewed" &&
            !row.all_match &&
            !latestFeedback(
              feedback,
              bundle.comparison_sha256,
              row.sample_id,
            )) ||
          (comparisonFields.includes(filter as ComparisonField) &&
            !row.matches[filter as ComparisonField])),
    )
    .sort(
      (a, b) =>
        Number(a.matches.success) - Number(b.matches.success) ||
        comparisonFields.filter((f) => !b.matches[f]).length -
          comparisonFields.filter((f) => !a.matches[f]).length ||
        a.dataset_name.localeCompare(b.dataset_name) ||
        a.episode_index - b.episode_index,
    );
}

export function readFeedback(storage: Pick<Storage, "getItem">): Feedback[] {
  const raw = storage.getItem(feedbackStorageKey);
  if (!raw) return [];
  const rows: unknown = JSON.parse(raw);
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !row ||
        typeof row.id !== "string" ||
        typeof row.sample_id !== "string" ||
        typeof row.comparison_sha256 !== "string" ||
        typeof row.note !== "string" ||
        !Array.isArray(row.evidence_times_s) ||
        row.evidence_times_s.some(
          (time: unknown) =>
            typeof time !== "number" || !Number.isFinite(time) || time < 0,
        ) ||
        comparisonFields.some(
          (field) =>
            !["unreviewed", "human", "model", "criteria", "unclear"].includes(
              row.verdicts?.[field],
            ),
        ),
    )
  ) {
    throw new Error(
      "Saved comparison feedback is malformed. It has not been overwritten.",
    );
  }
  return rows as Feedback[];
}

/** Caller holds a browser storage lock. Never reads/writes the annotation key. */
export function appendFeedback(
  storage: Pick<Storage, "getItem" | "setItem">,
  feedback: Feedback,
) {
  const rows = readFeedback(storage);
  if (rows.some((row) => row.id === feedback.id))
    throw new Error("Duplicate feedback identity.");
  const next = [...rows, feedback];
  storage.setItem(feedbackStorageKey, JSON.stringify(next));
  return next;
}

export function stageName(definition: Definition, id: string) {
  const stage = definition.stages.find((row) => row.id === id);
  return stage ? `S${stage.index} · ${stage.name}` : id;
}
export function failureName(definition: Definition, id: string) {
  if (id === "none") return "None — success";
  const mode = definition.failureModes.find((row) => row.id === id);
  return mode?.name ?? id.replaceAll("_", " ");
}

export function comparisonEpisode(row: ComparisonCase) {
  return {
    episodeIndex: row.episode_index,
    rawLength: Math.max(1, Math.round(row.duration_s * row.fps)),
    dataPath: "",
    perCamera: Object.fromEntries(
      row.cameras.map((camera) => [
        camera.key,
        {
          fileIndex: 0,
          fromTimestamp: camera.start_s,
          toTimestamp: camera.start_s + row.duration_s,
        },
      ]),
    ),
  };
}
