import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReviewViewer,
  type ViewerControls,
} from "../src/components/review/ReviewViewer";
import {
  isTypingTarget,
  useWindowKeydown,
} from "../src/components/review/useWindowKeydown";
import {
  setSearchParams,
  useSearchParam,
  useSearchParamNavigationGuard,
} from "../src/lib/useSearchParam";
import {
  appendFeedback,
  comparisonEpisode,
  comparisonFields,
  failureName,
  feedbackStorageKey,
  filterCases,
  freshVerdicts,
  latestFeedback,
  readFeedback,
  stageName,
  taskNames,
  type ComparisonBundle,
  type ComparisonCase,
  type ComparisonField,
  type ComparisonFilter,
  type Feedback,
  type Verdict,
} from "./labelComparison";
import "./label-comparison.css";

const fieldNames = {
  success: "Success / failure",
  failure_reason: "Failure reason",
  furthest_stage: "Furthest stage",
};
const filters: [ComparisonFilter, string][] = [
  ["differences", "Differences"],
  ["success", "Outcome"],
  ["failure_reason", "Reason"],
  ["furthest_stage", "Stage"],
  ["unreviewed", "Needs feedback"],
  ["all", "All episodes"],
];

function downloadFeedback(rows: Feedback[], comparison: string) {
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          {
            schema_version: "label-comparison-feedback/v1",
            comparison_sha256: comparison,
            scope:
              "Review feedback/proposals only; original human and model labels unchanged.",
            feedback: rows,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "label-comparison-feedback.json";
  link.click();
  URL.revokeObjectURL(url);
}

export function ComparisonDetail({
  bundle,
  row,
  saved,
  onSave,
  onDirty,
}: {
  bundle: ComparisonBundle;
  row: ComparisonCase;
  saved?: Feedback;
  onSave: (feedback: Feedback) => Promise<void>;
  onDirty: (dirty: boolean) => void;
}) {
  const definition = bundle.tasks[row.task_id].definition;
  const controls = useRef<ViewerControls | null>(null);
  const [frame, setFrame] = useState(0);
  const [drift, setDrift] = useState<string | null>(null);
  const [unverifiable, setUnverifiable] = useState(false);
  const [verdicts, setVerdicts] = useState(saved?.verdicts ?? freshVerdicts());
  const [note, setNote] = useState(saved?.note ?? "");
  const [times, setTimes] = useState<number[]>(saved?.evidence_times_s ?? []);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(saved ? "Feedback saved locally" : "");
  const [error, setError] = useState("");
  const [timeline, setTimeline] = useState("both");
  const episode = useMemo(() => comparisonEpisode(row), [row]);
  const keys = useMemo(() => row.cameras.map((camera) => camera.key), [row]);
  const videoUrls = useMemo(
    () =>
      Object.fromEntries(row.cameras.map((camera) => [camera.key, camera.url])),
    [row],
  );
  const seek = (time: number) => {
    controls.current?.pause();
    setFrame(
      Math.max(0, Math.min(episode.rawLength - 1, Math.round(time * row.fps))),
    );
  };
  useWindowKeydown((event) => {
    if (
      isTypingTarget(event) ||
      event.repeat ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      (event.target as HTMLElement | null)?.closest("button, a, summary")
    )
      return;
    if (event.code === "Space") {
      event.preventDefault();
      controls.current?.togglePlay();
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const current = controls.current?.pause() ?? frame;
      setFrame(
        Math.max(
          0,
          Math.min(
            episode.rawLength - 1,
            current + (event.key === "ArrowLeft" ? -1 : 1),
          ),
        ),
      );
    }
  });
  const markers = useMemo(
    () =>
      [
        ...(timeline === "model"
          ? []
          : row.human.stage_transitions.map((mark, index) => ({
              id: `human:${index}`,
              frame: mark.time_s * row.fps,
              label: `Y${mark.to_stage_index}`,
              title: `your S${mark.to_stage_index} at ${mark.time_s.toFixed(2)} s · attempt ${mark.attempt_index}`,
            }))),
        ...(timeline === "human"
          ? []
          : row.model.stage_transitions.map((mark, index) => ({
              id: `model:${index}`,
              frame: mark.time_s * row.fps,
              label: `G${mark.to_stage_index}`,
              title: `Gemini S${mark.to_stage_index} at ${mark.time_s.toFixed(2)} s · attempt ${mark.attempt_index}`,
            }))),
      ].filter((mark) => mark.frame <= episode.rawLength),
    [row, episode.rawLength, timeline],
  );
  const edit = () => {
    onDirty(true);
    setMessage("Unsaved feedback");
    setError("");
  };
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      if (
        !note.trim() &&
        !times.length &&
        comparisonFields.every((field) => verdicts[field] === "unreviewed")
      ) {
        throw new Error(
          "Choose a judgment, add a note, or bookmark evidence before saving.",
        );
      }
      await onSave({
        id: crypto.randomUUID(),
        saved_at: new Date().toISOString(),
        comparison_sha256: bundle.comparison_sha256,
        sample_id: row.sample_id,
        task_id: row.task_id,
        source_review_id: row.source_review.id,
        attempt_sha256: row.attempt_sha256,
        verdicts,
        note,
        evidence_times_s: times,
      });
      onDirty(false);
      setMessage("Feedback saved locally");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const value = (source: "human" | "predicted", field: ComparisonField) => {
    const label = row[source];
    if (field === "success")
      return (
        <span
          className={`result-badge ${label.task_success ? "success" : "failure"}`}
        >
          {label.task_success ? "Success" : "Failure"}
        </span>
      );
    return field === "failure_reason"
      ? failureName(definition, label.failure_mode_id)
      : stageName(definition, label.max_stage_id);
  };
  const relevantStages = definition.stages.filter((stage) =>
    [row.human.max_stage_id, row.predicted.max_stage_id].includes(stage.id),
  );
  const relevantFailures = definition.failureModes.filter((mode) =>
    [row.human.failure_mode_id, row.predicted.failure_mode_id].includes(
      mode.id,
    ),
  );
  return (
    <article className="comparison-detail">
      <header className="case-heading">
        <div>
          <p className="eyebrow">
            {taskNames[row.task_id]} · {row.dataset_name}
          </p>
          <h2>Episode {row.episode_index}</h2>
        </div>
        <span
          className={`result-badge ${row.all_match ? "success" : "failure"}`}
        >
          {row.all_match
            ? "All 3 agree"
            : `${comparisonFields.filter((field) => !row.matches[field]).length} differences`}
        </span>
      </header>
      {!!row.definition_review_issues.length && (
        <details className="criteria-warning">
          <summary>
            Routing criteria changed after your annotation — recheck this case
          </summary>
          {row.definition_review_issues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
        </details>
      )}
      <section
        className="comparison-card comparison-videos"
        aria-label="Episode video evidence"
      >
        <div className="video-heading">
          <span>Clean cameras · {row.duration_s.toFixed(1)}s</span>
          <label>
            Stage marks{" "}
            <select
              aria-label="Timeline label source"
              value={timeline}
              onChange={(event) => setTimeline(event.target.value)}
            >
              <option value="both">Yours + Gemini</option>
              <option value="human">Yours</option>
              <option value="model">Gemini</option>
            </select>
          </label>
        </div>
        <ReviewViewer
          datasetId={row.dataset}
          episode={episode}
          cameraKeys={keys}
          primaryKey={keys[0]}
          fps={row.fps}
          frame={frame}
          onFrame={setFrame}
          lastValidFrame={null}
          controlsRef={controls}
          cropByCameraKey={null}
          storedFrameHW={null}
          onDrift={setDrift}
          onUnverifiable={setUnverifiable}
          timelineMarkers={markers}
          videoUrls={videoUrls}
        />
        <div className="video-footer">
          <span>Y = your stage · G = Gemini stage · click a mark to seek</span>
          <button
            disabled={!!drift || unverifiable || saving}
            onClick={() => {
              const current = controls.current?.pause() ?? frame;
              const time = Number((current / row.fps).toFixed(3));
              setTimes([...new Set([...times, time])].sort((a, b) => a - b));
              edit();
            }}
          >
            ＋ Bookmark this moment
          </button>
        </div>
      </section>

      <section
        className="comparison-card"
        aria-label="Your labels compared with Gemini"
      >
        <div className="table-scroll">
          <table className="comparison-table">
            <thead>
              <tr>
                <th>Check</th>
                <th>Your label</th>
                <th>Gemini</th>
                <th>Your feedback</th>
              </tr>
            </thead>
            <tbody>
              {comparisonFields.map((field) => (
                <tr
                  key={field}
                  className={row.matches[field] ? "" : "disagrees"}
                >
                  <th scope="row">
                    {fieldNames[field]}
                    <small>
                      {row.matches[field] ? "✓ Agrees" : "≠ Different"}
                    </small>
                  </th>
                  <td>{value("human", field)}</td>
                  <td>{value("predicted", field)}</td>
                  <td>
                    <select
                      aria-label={`Feedback on ${fieldNames[field]}`}
                      disabled={saving}
                      value={verdicts[field]}
                      onChange={(event) => {
                        setVerdicts({
                          ...verdicts,
                          [field]: event.target.value as Verdict,
                        });
                        edit();
                      }}
                    >
                      <option value="unreviewed">Not reviewed</option>
                      <option value="human">Keep my label</option>
                      <option value="model">Gemini is right</option>
                      <option value="criteria">Clarify criteria</option>
                      <option value="unclear">Need another look</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rationale">
          <strong>Gemini’s rationale</strong>
          <p>{row.model.notes || "No rationale supplied."}</p>
          {row.model.failure_events.map((event, index) => (
            <p key={index}>
              <button className="time-link" onClick={() => seek(event.time_s)}>
                {event.time_s.toFixed(2)}s ↗
              </button>{" "}
              {event.evidence}
            </p>
          ))}
          {row.human_notes && (
            <p>
              <strong>Your original note:</strong> {row.human_notes}
            </p>
          )}
        </div>
        <div className="feedback-form">
          <label htmlFor="feedback-note">
            What should the criteria or prompt say differently?
          </label>
          <textarea
            id="feedback-note"
            rows={3}
            value={note}
            disabled={saving}
            placeholder="e.g. This is a brief pinch, not a secure grasp. Require sustained control before S2."
            onChange={(event) => {
              setNote(event.target.value);
              edit();
            }}
          />
          {!!times.length && (
            <div className="bookmarks">
              <span>Evidence:</span>
              {times.map((time) => (
                <span key={time}>
                  <button onClick={() => seek(time)}>
                    {time.toFixed(2)}s ↗
                  </button>
                  <button
                    disabled={saving}
                    aria-label={`Remove bookmark at ${time.toFixed(2)} seconds`}
                    onClick={() => {
                      setTimes(times.filter((t) => t !== time));
                      edit();
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="feedback-actions">
            <button className="primary-button" disabled={saving} onClick={save}>
              {saving ? "Saving…" : "Save feedback"}
            </button>
            <span role="status">{message}</span>
            <span className="feedback-safety">
              Feedback only — original labels stay unchanged.
            </span>
          </div>
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
        </div>
      </section>

      <details className="comparison-card" open>
        <summary>
          Stage timestamps{" "}
          <small>
            Click a time to inspect · timing differences are not scored
          </small>
        </summary>
        <div className="table-scroll">
          <table className="stage-times">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Your marks</th>
                <th>Gemini marks</th>
              </tr>
            </thead>
            <tbody>
              {definition.stages
                .filter((stage) => stage.index > 0)
                .map((stage) => (
                  <tr key={stage.id}>
                    <th>{stageName(definition, stage.id)}</th>
                    {[
                      row.human.stage_transitions,
                      row.model.stage_transitions,
                    ].map((marks, column) => (
                      <td key={column}>
                        {marks.filter((mark) => mark.to_stage_id === stage.id)
                          .length ? (
                          marks
                            .filter((mark) => mark.to_stage_id === stage.id)
                            .map((mark, index) => (
                              <button
                                key={index}
                                className="time-link"
                                title={mark.evidence}
                                onClick={() => seek(mark.time_s)}
                              >
                                {mark.time_s.toFixed(2)}s{" "}
                                <small>A{mark.attempt_index}</small> ↗
                              </button>
                            ))
                        ) : (
                          <span className="muted">Not marked</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
      <details className="comparison-card">
        <summary>Criteria behind this difference</summary>
        {relevantStages.map((stage) => (
          <div key={stage.id} className="criteria-item">
            <strong>{stageName(definition, stage.id)}</strong>
            <p>{stage.description}</p>
            <ul>
              {stage.entryCriteria.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
            <p className="muted">
              Does not count: {stage.exclusions.join(" ")}
            </p>
          </div>
        ))}
        {relevantFailures.map((mode) => (
          <div key={mode.id} className="criteria-item">
            <strong>{failureName(definition, mode.id)}</strong>
            <p>{mode.description}</p>
          </div>
        ))}
      </details>
      <details className="comparison-card">
        <summary>Exact prompt and raw response</summary>
        <details>
          <summary>System prompt · {definition.taxonomyVersion}</summary>
          <pre>{bundle.tasks[row.task_id].system_prompt}</pre>
        </details>
        <details>
          <summary>Video request</summary>
          <pre>{row.request_prompt}</pre>
        </details>
        <details>
          <summary>Raw Gemini response · {row.response_model}</summary>
          <pre>{row.raw_response}</pre>
        </details>
        <p className="muted">
          Human snapshot:{" "}
          {new Date(row.source_review.saved_at).toLocaleString()} ·{" "}
          {row.source_review.id}
        </p>
        <p className="muted">
          HF revision: {row.hf_revision} · immutable response:{" "}
          {row.attempt_sha256}
        </p>
      </details>
    </article>
  );
}

export default function ComparisonReview({
  bundle,
}: {
  bundle: ComparisonBundle;
}) {
  const [task] = useSearchParam("task", "all");
  const [filterValue] = useSearchParam("filter", "differences");
  const [selected] = useSearchParam("case", "");
  const filter = filters.some(([key]) => key === filterValue)
    ? (filterValue as ComparisonFilter)
    : "differences";
  const [feedbackState, setFeedbackState] = useState(() => {
    try {
      return { rows: readFeedback(localStorage), error: "" };
    } catch (cause) {
      return { rows: [] as Feedback[], error: String(cause) };
    }
  });
  const [dirty, setDirty] = useState(false);
  const guard = useCallback(
    () =>
      !dirty ||
      window.confirm(
        "Leave without saving this feedback? Your original labels are safe.",
      ),
    [dirty],
  );
  useSearchParamNavigationGuard(guard);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key !== feedbackStorageKey) return;
      try {
        setFeedbackState({ rows: readFeedback(localStorage), error: "" });
      } catch (cause) {
        setFeedbackState({ rows: [], error: String(cause) });
      }
    };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, []);
  const rows = filterCases(bundle, task, filter, feedbackState.rows);
  const row =
    rows.find((candidate) => candidate.sample_id === selected) ?? rows[0];
  const index = row ? rows.indexOf(row) : -1;
  const navigate = (updates: Record<string, string | null>) => {
    if (setSearchParams(updates)) setDirty(false);
  };
  const save = async (feedback: Feedback) => {
    if (feedbackState.error) throw new Error(feedbackState.error);
    await navigator.locks.request(feedbackStorageKey, () => {
      const updated = appendFeedback(localStorage, feedback);
      setFeedbackState({ rows: updated, error: "" });
    });
  };
  const reviewed = bundle.cases.filter((candidate) =>
    latestFeedback(
      feedbackState.rows,
      bundle.comparison_sha256,
      candidate.sample_id,
    ),
  ).length;
  return (
    <main className="comparison-shell">
      <header className="comparison-header">
        <div>
          <p className="eyebrow">60-episode blind evaluation · local review</p>
          <h1>Your labels vs Gemini</h1>
          <p>
            Three checks. Watch the evidence, review the difference, leave
            feedback.
          </p>
        </div>
        <div>
          <button
            className="primary-button"
            disabled={!!feedbackState.error || !feedbackState.rows.length}
            onClick={() =>
              downloadFeedback(
                readFeedback(localStorage),
                bundle.comparison_sha256,
              )
            }
          >
            Export feedback · {reviewed}/60
          </button>
          <a
            href="/sandbox/stage-review.html?queue=pilot20"
            target="_blank"
            rel="noopener noreferrer"
          >
            Original annotation playground ↗
          </a>
        </div>
      </header>
      <div className="comparison-toolbar">
        <nav aria-label="Comparison task">
          {[["all", "All tasks"], ...Object.entries(taskNames)].map(
            ([key, name]) => (
              <button
                key={key}
                aria-pressed={task === key}
                onClick={() => navigate({ task: key, case: null })}
              >
                {name}
                <span>
                  {
                    bundle.cases.filter(
                      (c) => key === "all" || c.task_id === key,
                    ).length
                  }
                </span>
              </button>
            ),
          )}
        </nav>
        <p>
          {bundle.resolved_models.join(", ")}{" "}
          <span className="muted">
            · human labels were not supplied to Gemini
          </span>
        </p>
      </div>
      <div className="comparison-filters" aria-label="Difference filter">
        {filters.map(([key, name]) => (
          <button
            key={key}
            aria-pressed={filter === key}
            onClick={() => navigate({ filter: key, case: null })}
          >
            {name}{" "}
            <span>
              {filterCases(bundle, task, key, feedbackState.rows).length}
            </span>
          </button>
        ))}
      </div>
      {feedbackState.error && (
        <p role="alert" className="error-message">
          {feedbackState.error}
        </p>
      )}
      <div className="comparison-layout">
        <aside className="comparison-queue" aria-label="Comparison episodes">
          <div className="queue-heading">
            {rows.length} episodes <span>{reviewed} with feedback</span>
          </div>
          <div className="queue-list">
            {rows.map((candidate) => (
              <button
                key={candidate.sample_id}
                aria-current={candidate === row ? "true" : undefined}
                onClick={() => navigate({ case: candidate.sample_id })}
              >
                <span className="queue-case">
                  {candidate.dataset_name} · Ep {candidate.episode_index}
                  <span>
                    {latestFeedback(
                      feedbackState.rows,
                      bundle.comparison_sha256,
                      candidate.sample_id,
                    )
                      ? "✓"
                      : ""}
                  </span>
                </span>
                <span
                  className={`queue-outcome ${candidate.human.task_success ? "success-text" : "failure-text"}`}
                >
                  Your label:{" "}
                  {candidate.human.task_success ? "success" : "failure"}
                </span>
                <span className="difference-chips">
                  {comparisonFields
                    .filter((field) => !candidate.matches[field])
                    .map((field) => (
                      <span key={field}>
                        {field === "success"
                          ? "Outcome"
                          : field === "failure_reason"
                            ? "Reason"
                            : "Stage"}
                      </span>
                    ))}
                  {candidate.all_match && (
                    <span className="agrees">All agree</span>
                  )}
                </span>
              </button>
            ))}
          </div>
          <p className="queue-note">
            Frozen labels from the evaluated snapshot. Feedback never rewrites
            them.
          </p>
        </aside>
        <div className="comparison-workspace">
          <div className="case-navigation">
            <span>{row ? `${index + 1} / ${rows.length}` : "0 cases"}</span>
            <div>
              <button
                disabled={index <= 0}
                onClick={() => navigate({ case: rows[index - 1].sample_id })}
              >
                ← Previous
              </button>
              <button
                disabled={index < 0 || index >= rows.length - 1}
                onClick={() => navigate({ case: rows[index + 1].sample_id })}
              >
                Next →
              </button>
            </div>
          </div>
          {row ? (
            <ComparisonDetail
              key={row.sample_id}
              bundle={bundle}
              row={row}
              saved={latestFeedback(
                feedbackState.rows,
                bundle.comparison_sha256,
                row.sample_id,
              )}
              onSave={save}
              onDirty={setDirty}
            />
          ) : (
            <div className="comparison-card empty-state">
              No cases in this filter. Try “All episodes”.
            </div>
          )}
        </div>
      </div>
      <footer className="comparison-footer">
        Local feedback only · no database writes or model calls · export
        feedback when you’re done
      </footer>
    </main>
  );
}
