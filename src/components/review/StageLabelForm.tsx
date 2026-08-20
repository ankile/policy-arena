import { useEffect, useState } from "react";
import type { ExportedStageSpec, StageLabelRow, Violation } from "../../../convex/stageConsistency";

// ---------------------------------------------------------------------------
// Spec-driven stage-label form. NOTHING here is task-specific: field names,
// ladder rungs, enums, and event fields all come from the exported spec, so a
// taxonomy change (split/removed stages, renamed fields) never touches this
// file. Values live in a Record keyed by the spec's own field names (the same
// row shape the validator, Convex, and gold consolidation consume).
// ---------------------------------------------------------------------------

function violationFields(violations: Violation[]): Set<string> {
  return new Set(violations.flatMap((v) => v.fields));
}

/** Local-state numeric input: commits a parsed value (or clears) on change,
 *  never re-renders the video grid per keystroke. */
function TimeInput({
  value,
  flagged,
  onCommit,
}: {
  value: number | null;
  flagged: boolean;
  onCommit: (t: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- sync the
       local draft text to an externally-committed value (controlled bridge). */
    setText(value === null ? "" : String(value));
  }, [value]);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const s = text.trim();
        if (s === "") {
          onCommit(null);
          return;
        }
        const parsed = Number(s);
        onCommit(Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        e.stopPropagation();
      }}
      placeholder="—"
      className={`w-16 rounded border px-1 py-0.5 text-[11px] font-mono text-right ${
        flagged ? "border-coral ring-1 ring-coral/40" : "border-warm-200"
      }`}
    />
  );
}

export function StageLabelForm({
  spec,
  row,
  violations,
  frame,
  markFrame,
  markDisabled,
  onEdit,
  onSeekTime,
  disabled,
}: {
  spec: ExportedStageSpec;
  row: StageLabelRow;
  violations: Violation[];
  /** Current playhead frame (display only). */
  frame: number;
  /** Snap-and-return the DISPLAYED frame (ViewerControls.pause() ?? frame);
   *  null when the display is unverified (drift) — the mark is refused. */
  markFrame: () => number | null;
  /** Frame verification failed — marking is disabled until it clears. */
  markDisabled: boolean;
  onEdit: (patch: StageLabelRow) => void;
  onSeekTime: (timeS: number) => void;
  disabled: boolean;
}) {
  const flagged = violationFields(violations);
  const stage = typeof row[spec.stage_field] === "number" ? (row[spec.stage_field] as number) : null;
  const boolSet = new Set(spec.bool_fields);
  const timeSet = new Set(spec.time_fields);
  const selectedLevel =
    stage !== null ? spec.ladder.levels.find((lvl) => lvl.sid === stage) : undefined;
  const [showFullLadder, setShowFullLadder] = useState(false);

  const timeOf = (tf: string): number | null =>
    typeof row[tf] === "number" ? (row[tf] as number) : null;

  const enumSelect = (field: string, options: string[]) => {
    const value = typeof row[field] === "string" ? (row[field] as string) : "";
    const unknown = value !== "" && !options.includes(value);
    return (
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onEdit({ [field]: e.target.value || undefined });
          e.currentTarget.blur();
        }}
        className={`w-full rounded-lg border bg-white px-2 py-1.5 text-xs font-mono text-ink cursor-pointer ${
          flagged.has(field) || unknown ? "border-coral ring-1 ring-coral/40" : "border-warm-200"
        }`}
      >
        <option value="">— unset —</option>
        {unknown && (
          <option value={value} disabled>
            ⚠ {value} (not in taxonomy {spec.taxonomy_version})
          </option>
        )}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  };

  return (
    <div className="mt-4 space-y-3">
      {/* Stage ladder buttons */}
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-mono uppercase tracking-wide text-ink-muted mr-1">
            {spec.stage_field}
          </span>
          {spec.ladder.levels.map((lvl) => (
            <button
              key={lvl.sid}
              disabled={disabled}
              onClick={() => onEdit({ [spec.stage_field]: lvl.sid })}
              title={lvl.text}
              className={`px-2.5 py-1 rounded-lg text-xs font-mono font-medium cursor-pointer transition-all ${
                stage === lvl.sid
                  ? "bg-teal text-white"
                  : flagged.has(spec.stage_field)
                    ? "bg-white border border-coral/50 text-ink-muted"
                    : "bg-white border border-warm-200 text-ink-muted hover:border-warm-300"
              }`}
            >
              S{lvl.sid}
              {(lvl.gate_field || lvl.gate_any_of.length > 0 || lvl.gate_all_of.length > 0) && (
                <span className="ml-0.5 opacity-60" title="gated rung">
                  ⚿
                </span>
              )}
            </button>
          ))}
          <button
            onClick={() => setShowFullLadder((show) => !show)}
            className="ml-1 text-[10px] font-mono text-ink-muted hover:text-teal cursor-pointer"
          >
            {showFullLadder ? "▾ ladder" : "▸ ladder"}
          </button>
        </div>
        {selectedLevel && !showFullLadder && (
          <p className="mt-1 text-[11px] text-ink-muted font-body">
            S{selectedLevel.sid}: {selectedLevel.text}
          </p>
        )}
        {showFullLadder && (
          <div className="mt-1 space-y-0.5">
            {spec.ladder.levels.map((lvl) => (
              <p
                key={lvl.sid}
                className={`text-[11px] font-body ${
                  stage === lvl.sid ? "text-ink font-medium" : "text-ink-muted"
                }`}
              >
                S{lvl.sid}: {lvl.text}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Enums */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wide text-ink-muted mb-1">
            {spec.final_state_field}
          </div>
          {enumSelect(spec.final_state_field, spec.final_states)}
        </div>
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wide text-ink-muted mb-1">
            {spec.failure_mode_field}
          </div>
          {enumSelect(spec.failure_mode_field, spec.failure_modes)}
        </div>
      </div>

      {/* Event bools + paired times */}
      <div className="space-y-1">
        {spec.event_fields
          .filter((f) => boolSet.has(f.name))
          .map((f) => {
            const bf = f.name;
            const tf = `${bf}_time_s`;
            const hasTime = timeSet.has(tf);
            const boolVal = row[bf] === true;
            const t = hasTime ? timeOf(tf) : null;
            const rowFlagged = flagged.has(bf) || (hasTime && flagged.has(tf));
            return (
              <div
                key={bf}
                className={`flex items-center gap-2 rounded-lg px-2 py-1 ${
                  rowFlagged ? "ring-1 ring-coral/50 bg-coral-light/30" : ""
                }`}
              >
                <label
                  className="flex items-center gap-1.5 text-[11px] font-mono text-ink cursor-pointer flex-1 min-w-0"
                  title={f.description}
                >
                  <input
                    type="checkbox"
                    checked={boolVal}
                    disabled={disabled}
                    onChange={(e) => onEdit({ [bf]: e.target.checked })}
                  />
                  <span className="truncate">{bf}</span>
                </label>
                {hasTime && (
                  <>
                    <TimeInput
                      value={t}
                      flagged={flagged.has(tf)}
                      onCommit={(next) => onEdit({ [tf]: next ?? undefined })}
                    />
                    <span className="text-[10px] font-mono text-ink-muted w-10">
                      {t !== null ? `f${Math.round(t * spec.fps)}` : ""}
                    </span>
                    <button
                      disabled={disabled || markDisabled}
                      onClick={() => {
                        const at = markFrame();
                        if (at === null) return; // drifted display — refused
                        onEdit({
                          [bf]: true,
                          [tf]: Math.round((at / spec.fps) * 100) / 100,
                        });
                      }}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                        markDisabled
                          ? "bg-warm-100 text-ink-muted/40 cursor-not-allowed"
                          : "bg-teal/10 text-teal hover:bg-teal/20 cursor-pointer"
                      }`}
                      title={
                        markDisabled
                          ? "frame drift detected — re-seek until the banner clears"
                          : `set ${bf} + time from the displayed frame (${frame})`
                      }
                    >
                      ◉ mark
                    </button>
                    <button
                      disabled={t === null}
                      onClick={() => t !== null && onSeekTime(t)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                        t !== null
                          ? "bg-warm-100 text-ink-muted hover:bg-warm-200 cursor-pointer"
                          : "text-ink-muted/30"
                      }`}
                      title={t !== null ? `seek to ${t}s` : undefined}
                    >
                      →
                    </button>
                    <button
                      disabled={disabled || (row[bf] === undefined && t === null)}
                      onClick={() => onEdit({ [bf]: false, [tf]: undefined })}
                      className="px-1.5 py-0.5 rounded text-[10px] font-mono text-ink-muted hover:text-coral cursor-pointer"
                      title="clear (bool=false, time absent)"
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            );
          })}
        {/* Time fields without a bool partner (rare) */}
        {spec.time_fields
          .filter((tf) => !boolSet.has(tf.replace(/_time_s$/, "")))
          .map((tf) => (
            <div key={tf} className="flex items-center gap-2 px-2 py-1">
              <span className="text-[11px] font-mono text-ink flex-1">{tf}</span>
              <TimeInput
                value={timeOf(tf)}
                flagged={flagged.has(tf)}
                onCommit={(next) => onEdit({ [tf]: next ?? undefined })}
              />
            </div>
          ))}
      </div>

      {/* Notes */}
      <textarea
        value={typeof row.notes === "string" ? (row.notes as string) : ""}
        disabled={disabled}
        onChange={(e) => onEdit({ notes: e.target.value || undefined })}
        placeholder="notes…"
        rows={2}
        className="w-full rounded-lg border border-warm-200 bg-white px-2 py-1.5 text-xs font-body text-ink"
      />

      {/* Live violations */}
      {violations.length > 0 && (
        <div className="rounded-lg border border-coral/30 bg-coral-light px-3 py-2 space-y-0.5">
          {violations.map((v, i) => (
            <p key={i} className="text-[11px] font-mono text-coral">
              [{v.code}] {v.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
