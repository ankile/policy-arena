import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { parseEpisodes, type Generation } from "../../convex/labelingContract";
import { useSearchParam } from "../lib/useSearchParam";
import type { TrajectoryTaskDefinition } from "../../convex/trajectoryContract";

const INITIAL_DATASET = "ankile/real01b-routing-d1-r8-bigdp-vs-deployed-testing-heldout-sobol50";
const input = "w-full rounded-lg border border-warm-200 bg-white px-3 py-2 text-sm text-ink";
const button = "rounded-lg bg-teal px-4 py-2 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer";
const card = "rounded-2xl border border-warm-200 bg-white p-6";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Operation failed";
function reviewLink(repo: string, schema: string, prediction: string, episode = 0) {
  return `/?${new URLSearchParams({ tab: "explorer", dataset: repo, view: "stage", schema, prediction, episode: String(episode), blind: "1", sstatus: "all" })}`;
}

export default function LabelingLab() {
  const [repo, setRepo] = useSearchParam("dataset", INITIAL_DATASET);
  const datasets = useQuery(api.datasets.list, {});
  const availability = useQuery(api.labelingLab.availability);
  const viewer = useQuery(api.users.viewer);
  const dataset = datasets?.find((d) => d.repo_id === repo);
  return <div className="space-y-6">
    <div>
      <h2 className="font-display text-3xl">Labeling Lab</h2>
      <p className="mt-2 text-ink-muted">Version the prompt, compare predictions with frozen human reviews, and label new episodes.</p>
    </div>
    <div className="rounded-xl border border-warm-200 bg-warm-50 p-4 text-sm" role="status">
      {availability?.message ?? "Checking worker availability…"}
      {!viewer?.isEditor && <p className="mt-1">Sign in with an allowlisted Hugging Face account to save configurations, freeze benchmarks, or run jobs.</p>}
    </div>
    <section className={card}>
      <label className="block text-sm font-medium mb-2" htmlFor="label-dataset">Dataset</label>
      <select id="label-dataset" className={input} value={repo} onChange={(e) => setRepo(e.target.value)}>
        {!dataset && <option value={repo}>{repo}</option>}
        {datasets?.map((d) => <option key={d._id} value={d.repo_id}>{d.repo_id}</option>)}
      </select>
      {dataset && <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-muted">
        <span>{dataset.task}</span><span>{dataset.num_episodes?.toString() ?? "Unknown"} episodes</span>
        <span className="break-all">Media revision {dataset.stats_hf_sha ?? "not pinned"}</span>
      </div>}
    </section>
    {dataset ? <DatasetLab key={repo} dataset={dataset} editor={Boolean(viewer?.isEditor)} enabled={Boolean(availability?.enabled)} />
      : <p className="text-ink-muted">{datasets ? "This dataset must be registered in Arena first." : "Loading datasets…"}</p>}
  </div>;
}

function DatasetLab({ dataset, editor, enabled }: { dataset: Doc<"datasets">; editor: boolean; enabled: boolean }) {
  const configs = useQuery(api.labelingLab.configs, { task: dataset.task });
  const [selected, setSelected] = useState<string>("");
  const config = configs?.find((c) => c._id === selected) ?? configs?.[0];
  return <>
    <section className={card}>
      <h3 className="font-display text-xl mb-4">Pipeline configuration</h3>
      {configs === undefined ? <p>Loading configurations…</p> : !config ? <p className="text-sm text-ink-muted">No Python pipeline preset is registered for {dataset.task} yet.</p> : <>
        <label className="block text-sm mb-2" htmlFor="label-config">Saved version</label>
        <select id="label-config" className={input} value={config._id} onChange={(e) => setSelected(e.target.value)}>
          {configs.map((c) => <option key={c._id} value={c._id}>{c.name} · {new Date(c.created_at).toLocaleString()}</option>)}
        </select>
        <ConfigEditor key={config._id} config={config} editor={editor} saved={setSelected} />
      </>}
    </section>
    {config && <JobPanel key={config._id} dataset={dataset} config={config} editor={editor} enabled={enabled} />}
    <PredictionPanel dataset={dataset} taxonomy={config?.taxonomy_version} editor={editor} />
    <GoldPanel task={dataset.task} editor={editor} />
  </>;
}

function ConfigEditor({ config, editor, saved }: { config: Doc<"labelingConfigs">; editor: boolean; saved: (id: string) => void }) {
  const save = useMutation(api.labelingLab.saveConfig);
  const spec = useQuery(api.stageTaskSpecs.forTask, { task: config.task })?.find((s) => s._id === config.spec_id);
  const [prompt, setPrompt] = useState(config.system_prompt);
  const [name, setName] = useState(`${config.name} revision`);
  const [settings, setSettings] = useState<Generation>(config.generation);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dirty = prompt !== config.system_prompt || JSON.stringify(settings) !== JSON.stringify(config.generation);
  async function saveVersion() {
    setBusy(true); setError("");
    try { saved(await save({ parent_id: config._id, name, system_prompt: prompt, generation: settings })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <div className="mt-4 space-y-4">
    <div className="grid gap-4 md:grid-cols-3">
      <div><span className="block text-xs text-ink-muted mb-1">Model</span><p className="text-sm font-mono">{settings.model}</p><p className="text-xs text-ink-muted">Gemini Developer API</p></div>
      <label className="text-sm">Video FPS<input className={input} type="number" min={1} max={12} value={settings.video_fps} disabled={!editor} onChange={(e) => setSettings({ ...settings, video_fps: Number(e.target.value) })} /></label>
      <label className="text-sm">Maximum attempts per episode<input className={input} type="number" min={1} max={5} value={settings.max_attempts} disabled={!editor} onChange={(e) => setSettings({ ...settings, max_attempts: Number(e.target.value) })} /></label>
      <label className="text-sm">Maximum output tokens<input className={input} type="number" min={1024} max={32768} value={settings.max_output_tokens} disabled={!editor} onChange={(e) => setSettings({ ...settings, max_output_tokens: Number(e.target.value) })} /></label>
      <label className="text-sm">Thinking level<select className={input} value={settings.thinking_level ?? ""} disabled={!editor} onChange={(e) => setSettings({ ...settings, thinking_level: (e.target.value || null) as Generation["thinking_level"] })}><option value="">Provider default</option>{["low", "medium", "high"].map((x) => <option key={x}>{x}</option>)}</select></label>
      <label className="text-sm">Media resolution<select className={input} value={settings.media_resolution ?? ""} disabled={!editor} onChange={(e) => setSettings({ ...settings, media_resolution: (e.target.value || null) as Generation["media_resolution"] })}><option value="">Provider default</option>{["low", "medium", "high"].map((x) => <option key={x}>{x}</option>)}</select></label>
    </div>
    <label className="flex gap-2 text-sm"><input type="checkbox" disabled={!editor} checked={settings.final_frame_stills} onChange={(e) => setSettings({ ...settings, final_frame_stills: e.target.checked })} />Include each camera's final frame</label>
    <details><summary className="cursor-pointer text-sm font-medium">Task definition and stages</summary>{spec ? <TaskDefinition definition={spec.spec.trajectory.task_definition} /> : <p>Loading task definition…</p>}</details>
    <label className="block text-sm font-medium">System prompt<textarea className={`${input} mt-2 min-h-64 font-mono text-xs`} value={prompt} readOnly={!editor} onChange={(e) => setPrompt(e.target.value)} /></label>
    <p className="text-xs text-ink-muted">Edit the auditor instructions while preserving the embedded task definition. Task and schema changes require a new Python preset.</p>
    <details><summary className="cursor-pointer text-sm">Response schema and saved settings</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ generation: config.generation, response_schema: config.response_schema, worker_revision: config.worker_revision, digest: config.digest }, null, 2)}</pre></details>
    {editor && <div className="flex items-end gap-3 flex-wrap"><label className="text-sm flex-1">New version name<input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></label><button className={button} disabled={busy || !dirty} onClick={() => void saveVersion()}>{busy ? "Saving…" : "Save new version"}</button></div>}
    {dirty && <p className="text-sm text-gold">Save your edits as a new version before running them. The Run panel below uses the saved version.</p>}
    {error && <p role="alert" className="text-sm text-coral">{error}</p>}
  </div>;
}

function TaskDefinition({ definition: d }: { definition: TrajectoryTaskDefinition }) {
  return <div className="mt-4 space-y-4 text-sm">
    <h4 className="font-medium">{d.displayName}</h4><p>{d.objective}</p>
    <div><p className="font-medium mb-2">Success criteria</p><ul className="list-disc pl-5 space-y-1">{d.successCriteria.map((s) => <li key={s}>{s}</li>)}</ul></div>
    <ol className="space-y-3">{d.stages.map((s) => <li key={s.id} className="rounded-lg bg-warm-50 p-4"><p className="font-medium">S{s.index} · {s.name}</p><p className="mt-1 text-ink-muted">{s.description}</p><ul className="mt-2 list-disc pl-5">{s.entryCriteria.map((c) => <li key={c}>{c}</li>)}</ul>{s.exclusions?.length ? <p className="mt-2 text-ink-muted">Exclusions: {s.exclusions.join(" ")}</p> : null}</li>)}</ol>
    <details><summary className="cursor-pointer font-medium">Key actions, failures, and decision rules</summary><div className="mt-3 space-y-3">{d.keyActions.map((a) => <p key={a.id}><strong>{a.name}.</strong> {a.description}</p>)}{d.failureModes.map((f) => <p key={f.id}><span className="font-mono text-xs">{f.id}</span> · {f.description}</p>)}{d.decisionRules.map((r) => <p key={r.id}>{r.rule}</p>)}</div></details>
  </div>;
}

function JobPanel({ dataset, config, editor, enabled }: { dataset: Doc<"datasets">; config: Doc<"labelingConfigs">; editor: boolean; enabled: boolean }) {
  const submit = useMutation(api.labelingLab.submit), cancel = useMutation(api.labelingLab.cancel);
  const jobs = useQuery(api.labelingLab.jobs, { dataset_repo: dataset.repo_id });
  const [episodesText, setEpisodesText] = useState("0"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const request = useRef<{ input: string; key: string } | null>(null);
  let episodes: number[] = [], selectionError = "";
  try { episodes = parseEpisodes(episodesText); if (dataset.num_episodes !== undefined && episodes.some((e) => e >= Number(dataset.num_episodes))) selectionError = "Episode exceeds dataset bounds"; }
  catch (e) { selectionError = errorMessage(e); }
  async function run() {
    setBusy(true); setError("");
    const identity = JSON.stringify([config._id, episodes]);
    if (request.current?.input !== identity) request.current = { input: identity, key: crypto.randomUUID() };
    try { await submit({ config_id: config._id, dataset_repo: dataset.repo_id, episodes, request_key: request.current.key }); request.current = null; }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <section className={card}>
    <h3 className="font-display text-xl">Run labeling</h3>
    <div className="mt-4 flex gap-3 items-end flex-wrap"><label className="text-sm flex-1">Episodes<input className={input} value={episodesText} onChange={(e) => setEpisodesText(e.target.value)} placeholder="0, 2-5" /></label><button className={button} disabled={!editor || !enabled || busy || Boolean(selectionError)} onClick={() => void run()}>{busy ? "Submitting…" : "Run saved version"}</button></div>
    <p className="text-sm text-ink-muted mt-3">{selectionError || `${episodes.length} episode${episodes.length === 1 ? "" : "s"} · at most ${episodes.length * config.generation.max_attempts} model calls · ${config.name}`}</p>
    <p className="text-sm text-ink-muted mt-1">New predictions are candidates. Promotion requires a scored benchmark and an editor's decision.</p>
    {error && <p role="alert" className="text-sm text-coral mt-3">{error}</p>}
    <div className="mt-5 space-y-3">{jobs?.map((j) => <div key={j._id} className="rounded-lg border border-warm-200 p-4 text-sm">
      <div className="flex justify-between gap-3"><span>{j.status.replaceAll("_", " ")} · {j.completed_episodes}/{j.episodes.length} episodes · {j.provider_calls} calls</span><span className="text-ink-muted">{new Date(j.requested_at).toLocaleString()}</span></div>
      {j.error && <p className="mt-2 text-coral">{j.error}</p>}
      {j.prediction_run_id && <a className="text-teal underline" href={reviewLink(j.dataset_repo, config.taxonomy_version, j.prediction_run_id, j.episodes[0])}>Review predictions</a>}
      {editor && ["queued", "dispatched", "running"].includes(j.status) && <button className="mt-2 text-coral underline" onClick={() => void cancel({ job_id: j._id }).catch((e) => setError(errorMessage(e)))}>Cancel job</button>}
    </div>)}{jobs?.length === 0 && <p className="text-sm text-ink-muted">No hosted jobs for this dataset.</p>}</div>
  </section>;
}

function PredictionPanel({ dataset, taxonomy, editor }: { dataset: Doc<"datasets">; taxonomy?: string; editor: boolean }) {
  const versions = useQuery(api.stagePredictions.listForRepo, taxonomy ? { dataset_repo: dataset.repo_id, taxonomy_version: taxonomy } : "skip");
  return <section className={card}>
    <h3 className="font-display text-xl mb-3">Predictions and human review</h3>
    {taxonomy && <a className="text-sm text-teal underline" href={reviewLink(dataset.repo_id, taxonomy, versions?.active_run_id ?? "legacy")}>Open episode 0 for review</a>}
    {versions?.runs.length === 0 && <p className="mt-3 text-sm text-ink-muted">No published prediction versions for this schema. Human review is available without a prediction.</p>}
    <div className="mt-4 space-y-4">{versions?.runs.map((r) => <div key={r._id} className="border-t border-warm-200 pt-3 text-sm">
      <a className="text-teal underline break-all" href={reviewLink(dataset.repo_id, r.taxonomy_version, r._id)}>{r.pipeline.name} · {r.pipeline.version}</a>
      <p className="text-ink-muted">{r.expected_count} predictions · {r._id === versions.active_run_id ? "Selected" : "Candidate"}</p>
      {editor && <FreezeControls runId={r._id} />}
    </div>)}</div>
  </section>;
}
function FreezeControls({ runId }: { runId: Id<"stagePredictionRuns"> }) {
  const readiness = useQuery(api.labelingScores.readiness, { run_id: runId });
  const freeze = useMutation(api.labelingScores.freeze);
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  async function makeBenchmark() {
    setBusy(true); setMessage("");
    try { await freeze({ run_id: runId, name: `Gold snapshot ${new Date().toISOString().slice(0, 10)}` }); setMessage("Benchmark frozen. See Gold benchmarks below."); }
    catch (e) { setMessage(errorMessage(e)); } finally { setBusy(false); }
  }
  return <div className="mt-2 text-xs text-ink-muted"><span>{readiness?.eligible ?? "…"} eligible gold reviews · {readiness?.excluded ?? "…"} excluded or unresolved</span><button disabled={!readiness?.eligible || busy} className="ml-3 text-teal underline disabled:opacity-40" onClick={() => void makeBenchmark()}>Freeze gold benchmark</button>{message && <p role="status" className="mt-1">{message}</p>}</div>;
}

function GoldPanel({ task, editor }: { task: string; editor: boolean }) {
  const benchmarks = useQuery(api.labelingScores.benchmarks, { task });
  return <section className={card}>
    <h3 className="font-display text-xl">Gold benchmarks</h3>
    <p className="mt-2 text-sm text-ink-muted">Snapshots retain the exact reviews, prediction attribution, schema, and media revision. These are prediction-assisted human corrections. Once used to tune a prompt, they are development data.</p>
    {benchmarks?.length === 0 && <p className="mt-4 text-sm">No frozen benchmark for this task. Review episodes with existing predictions, then freeze a snapshot above. You can choose a different dataset to find those reviews.</p>}
    {benchmarks?.map((b) => <Benchmark key={b._id} benchmark={b} editor={editor} />)}
    <p className="mt-4 text-xs text-ink-muted">The first scorer reports summary-field agreement and stage error. Event timing and a promotion rule still need verification; these scores cannot promote a version.</p>
  </section>;
}
function Benchmark({ benchmark: b, editor }: { benchmark: Doc<"labelingBenchmarks">; editor: boolean }) {
  const versions = useQuery(api.stagePredictions.listForRepo, { dataset_repo: b.dataset_repo, taxonomy_version: b.taxonomy_version });
  const scores = useQuery(api.labelingScores.scores, { benchmark_id: b._id });
  const score = useMutation(api.labelingScores.score);
  const [run, setRun] = useState(b.baseline_run_id), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function evaluate() {
    setBusy(true); setError(""); try { await score({ benchmark_id: b._id, run_id: run }); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <div className="border-t border-warm-200 mt-5 pt-4">
    <p className="font-medium">{b.name} · {b.rows.length} episodes</p><p className="text-xs text-ink-muted break-all mt-1">{b.dataset_repo} · {new Date(b.created_at).toISOString()}</p>
    <div className="flex gap-3 mt-3"><select aria-label="Prediction version to score" className={input} value={run} onChange={(e) => setRun(e.target.value as Id<"stagePredictionRuns">)}>{versions?.runs.map((r) => <option key={r._id} value={r._id}>{r.pipeline.version}{r._id === b.baseline_run_id ? " · frozen baseline" : ""}</option>)}</select><button className={button} disabled={!editor || busy} onClick={() => void evaluate()}>Score</button></div>
    {error && <p role="alert" className="text-sm text-coral mt-2">{error}</p>}
    {scores && scores.length > 0 && <div className="overflow-x-auto"><table className="mt-4 w-full text-xs text-left"><thead><tr>{["Version", "Stage", "Final state", "Failure", "Attempts", "Stage MAE"].map((s) => <th className="py-2 pr-3" key={s}>{s}</th>)}</tr></thead><tbody>{scores.map((s) => <tr key={s._id} className="border-t border-warm-200"><td className="py-2 pr-3">{s.run_id === b.baseline_run_id ? "Baseline" : versions?.runs.find((r) => r._id === s.run_id)?.pipeline.version ?? s.run_id}</td>{[s.metrics.stage_exact, s.metrics.final_exact, s.metrics.failure_exact, s.metrics.attempts_exact].map((n, i) => <td key={i} className="pr-3">{n}/{s.metrics.n}</td>)}<td>{Number(s.metrics.stage_mae).toFixed(2)}</td></tr>)}</tbody></table></div>}
  </div>;
}
