# Immutable stage prediction versions

This contract replaces destructive stage-prefill publishing. A prediction run
belongs to one dataset, task, and taxonomy. Each run binds its complete episode
manifest, producer identity, provenance, and taxonomy hash before accepting rows.
Published versions remain separately queryable. Choosing a default version is a
separate operation with an audit record.

## Existing data and deployment

The existing `stagePrefills` table remains the frozen legacy version. Deployment
does not copy, replace, delete, or reattribute those records. Both the legacy
`upsertBatch` and `pruneStale` paths are disabled, and the Python methods fail
locally with the replacement API name. This preserves the legacy records present
at cutover; generations overwritten before cutover cannot be reconstructed from
that table.

Existing human reviews keep their labels and attribution. New reviews can bind
`prediction_id` and `prediction_sha256`, or `legacy_prefill_id`. A prediction
reference must match the review's dataset, episode, task, and taxonomy. Selecting
another version does not repoint a saved review's evidence.

When copying another human review, also supply `copied_from_review_id` and that
review's exact prediction references and `prefill_pushed_at`. The backend checks
the source review and preserves its provenance. These fields record the form's
source; they are not a complete log of which predictions the reviewer may have
viewed elsewhere.

The deployment serving both local development and the public application is
`grandiose-rook-292`. Follow [CLAUDE.md](../CLAUDE.md) for its deployment command.
An ordinary local Convex development command can deploy to this live database.
Run the offline test suite first. Before production acceptance, capture a
read-only export of legacy prefills, schemas, and human reviews. Compare their
identities and contents after deployment, then inspect the signed-in UI without
saving labels. Record deployment commits, snapshot digests, and observed results
in the rollout record. Do not treat a successful build or HTTP status as evidence
that old data is unchanged.

Compare the downloaded Convex exports with the local-only auditor:

```bash
python3 scripts/audit_convex_snapshots.py before.zip after.zip \
  --require-empty-predictions > audit.json
```

It requires the legacy and new prediction table members, compares stored IDs
and content, and fails on missing or changed protected data. Authentication and
heartbeat tables are explicitly excluded from the comparison. The empty-table
option is for this infrastructure cutover, before importing any new runs.

## Run lifecycle

1. `begin` creates a run in `uploading` state. `run_key` is globally unique, so
   include the campaign and dataset identity. Reusing a key with exactly the same
   metadata returns the same run. A conflicting identity fails.
2. `appendBatch` inserts immutable episode rows. An identical retry returns an
   unchanged count. Any changed content for an existing episode fails. Partial
   uploads remain available by explicit run ID for audit; normal version lists
   show published runs.
3. Read back every row and recompute its digest and the complete manifest.
4. `publish` requires the exact expected count and ordered manifest digest. It
   seals the run without choosing it as the default.
5. `activate` selects a published run only if `expected_active_run_id` still
   matches the current selection. A concurrent change fails. Selection changes
   append an audit event. `restoreLegacy` returns to the frozen legacy selection
   through the same compare-and-swap check.

The Python upload helper performs steps 1 through 4, including complete
read-back verification before publication. It never activates a version. A
failed upload does not change the current selection or delete uploaded evidence.
Resume an interrupted upload with the exact original manifest and run key.
Publish and append retries are idempotent. Do not change a run key to conceal an
unexpected conflict; inspect the stored run and the original export first.

## Python API

The authenticated write routes live under
`/api/v1/mutate/stagePredictions/` and require the machine `ingest` scope.
Queries are public. See [machine-api.md](machine-api.md) for credentials.

```python
from policy_arena import PolicyArenaClient

arena = PolicyArenaClient("https://grandiose-rook-292.convex.cloud")

# Load these values from an audited, immutable export manifest.
run_id = arena.upload_stage_prediction_run(
    rows,
    run_key=manifest["run_key"],
    dataset_repo=manifest["dataset_repo"],
    task=manifest["task"],
    taxonomy_version=manifest["taxonomy_version"],
    taxonomy_hash=manifest["taxonomy_hash"],
    pipeline=manifest["pipeline"],
    source=manifest["source"],
    provenance=manifest["provenance"],
)

# Inspect this published run before explicitly changing the default.
predictions = arena.fetch_stage_predictions(run_id)
versions = arena.list_stage_prediction_runs(
    manifest["dataset_repo"], taxonomy_version=manifest["taxonomy_version"]
)
arena.activate_stage_prediction_run(
    run_id, expected_active_run_id=versions["active_run_id"]
)
```

`upload_stage_prediction_run` accepts 1 to 10,000 rows per dataset. The helper
validates every source row before its first network write, batches by both count
and content size, checks stored metadata and every row, and verifies published
status. It leaves exceptions visible. Retry transport failures with the same
frozen inputs; authentication, validation, and content conflicts require fixing
their stated cause.

The helper checks the stored run's `content_protocol` before publishing. A future
protocol requires an explicit client update, rather than silently changing the
meaning of a hash.

Lower-level methods expose each operation separately:

| Method | Result |
| --- | --- |
| `begin_stage_prediction_run(...)` | Run ID |
| `append_stage_predictions(run_id, rows)` | Inserted and unchanged counts |
| `publish_stage_prediction_run(run_id)` | Run ID |
| `activate_stage_prediction_run(run_id, expected_active_run_id=...)` | Run ID |
| `restore_legacy_stage_predictions(repo, taxonomy_version=..., expected_active_run_id=...)` | Restores legacy selection |
| `get_stage_prediction_run(run_id)` | Run metadata or `None` |
| `list_stage_prediction_runs(repo, taxonomy_version=...)` | Published runs, active run ID, legacy count |
| `fetch_stage_predictions(run_id)` | Every paginated row of that run |
| `fetch_stage_prediction(prediction_id)` | Exact immutable prediction row |
| `stage_prediction_history(repo, episode, taxonomy_version=...)` | Versioned prediction summaries and legacy rows |
| `fetch_stage_prediction_selection_history(repo, taxonomy_version=...)` | Complete activation and rollback audit history |

`fetch_stage_prefills` still reads the frozen legacy table. Use the versioned
methods when querying a new pipeline. Queries return Convex int64 episode values;
their `.value` is the Python integer. `fetch_stage_reviews` retains its existing
latest-review behavior. Use `stageReviews:historyForEpisode` when the complete
human review history is required.

## Export payload and digest contract

Run metadata contains:

```json
{
  "run_key": "campaign/task/dataset-identity/revision",
  "dataset_repo": "owner/dataset",
  "task": "routing_d1",
  "taxonomy_version": "registered-version",
  "taxonomy_hash": "64 lowercase hexadecimal characters",
  "pipeline": {"name": "producer", "version": "version", "git_commit": "commit"},
  "expected_count": 150,
  "manifest_sha256": "64 lowercase hexadecimal characters",
  "source": "exporter identity",
  "provenance": {"campaign_manifest": "durable artifact location"}
}
```

The registered task specification must match the taxonomy hash. The backend also
binds the actual serialized specification content. Taxonomy version and producer
run version are separate identities.

Each appended row contains these fields. Optional fields must be omitted when
absent; explicit `null` changes the digest and is valid only for fields whose
schema accepts arbitrary JSON.

| Field | Contract |
| --- | --- |
| `episode_index` | Nonnegative signed int64, encoded with `ConvexInt64` by the client |
| `label` | JSON object matching the registered review form's field meanings |
| `episode_duration_s` | Finite positive number |
| `evidence` | JSON provenance and evidence, required |
| `canonical_response` | Optional complete canonical pipeline response |
| `source_revision` | Optional pinned source content revision, exactly 40 or 64 lowercase hex characters |
| `review_reason` | Optional string |
| `violation_codes` | Optional list of strings |
| `confidence` | Optional string |
| `vote_summary` | Optional JSON value |

Row size is at most 128 KiB in the canonical encoding. An append batch contains
at most 50 rows and 1 MiB of canonical row content. The API accepts strict JSON
values, rejects nonfinite numbers and unpaired Unicode surrogates, and caps
nesting depth at 64. Python integers inside JSON must fit the JavaScript safe
integer range. Episode indexes preserve their full int64 range separately.

The digest protocol is `arena-prediction-content/v1`. Its typed byte encoding is:

| Value | Bytes |
| --- | --- |
| `null` | ASCII `z` |
| Boolean | ASCII `t` or `f` |
| Number | ASCII `n` followed by the 16 lowercase hex digits of its big-endian IEEE754 float64 representation; negative zero becomes positive zero |
| String | ASCII `s`, decimal UTF-8 byte length, `:`, then UTF-8 bytes |
| Array | ASCII `a`, decimal element count, `:`, then each encoded element |
| Object | ASCII `o`, decimal key count, `:`, then encoded key/value pairs sorted by lexicographic UTF-8 key bytes |

The hash is SHA-256 of those bytes. It does not hash ordinary JSON text. Before
hashing a prediction payload, replace `episode_index` with its decimal string.
Include every supplied payload field, and exclude server metadata such as
`run_id`, `_id`, and `content_sha256`. The manifest hashes a list of
`[episode_decimal_string, content_sha256]` pairs sorted numerically by episode.
Duplicate episodes fail. The run identity hash binds all `begin` arguments
except authentication.

The Python implementation is
[`prediction_hashes.py`](../python/policy_arena/prediction_hashes.py), and the
backend implementation is
[`stagePredictionContract.ts`](../convex/stagePredictionContract.ts). Both test
against [shared vectors](../tests/fixtures/stage-prediction-hashes.json), including
Unicode ordering, negative zero, subnormal floats, optional fields, and maximum
int64 episode identity.

## Preparing the campaign import and direct pipeline integration

The immutable API stores complete canonical responses, but it does not translate
`trajectory-label/v1` into a review taxonomy. The campaign importer must resolve
that contract before uploading. Nested maximum stage, actions, transitions,
primary failure, and endpoint records cannot be renamed into the legacy fields
without checking their semantics. Historical progress and final retained state
must remain distinct. Preserve the raw response and explain any flattening or
fields omitted from the form. Register a new taxonomy when the meanings differ.

Build one reusable exporter for the manual import and future direct integration.
Its durable export manifest must include:

- Campaign identity, pinned producer commit, model and prompt/schema versions,
  source artifact locations and hashes, dataset revisions, and exact episode IDs.
- One dataset-scoped run identity, exact row count, and ordered manifest hash.
- Original attempts and targeted reruns with an explicit selection rule. Preserve
  rejected responses, validation errors, and unresolved cases in source evidence;
  do not silently drop them from the coverage accounting.
- The adapter version, taxonomy hash, complete canonical responses, and any
  information supplied to the predictor, including human outcome labels.
- Read-back verification results, published run IDs, explicit activation events,
  and baseline-versus-post-import checks of existing predictions and reviews.

Future direct publishing should call this exporter after the pipeline has stored
its durable results. A persisted outbox can retry the same run identity across
process restarts. Mark delivery complete only after stored-content verification
and publication. Keep activation a deliberate release step so a partially
delivered multi-dataset campaign cannot silently change default predictions.
No pipeline scheduler or automatic publishing is introduced by this contract.

## Preparing unseen human evaluation

Do not sample or score the new evaluation set during this infrastructure change.
Before annotation, freeze a 10-episode-per-task sampling manifest for Marker,
Square, and Routing and bind it to dataset revisions and the published prediction
run IDs. Record the eligible population, seed, sampling procedure, and exclusions.
Exclude episodes used in prior hand-review, prompt/model tuning, targeted rerun
selection, or taxonomy debugging. Audit those exclusions against the pipeline's
evidence and Arena review history; absence of an Arena review alone does not
prove an episode was unseen during pipeline development.

The follow-up annotation workflow must hide predictions, model confidence,
pipeline review flags, prior human stage labels, and automatic outcome-derived
prefills. Existing policy-arm blind mode alone does not provide that separation.
Prediction-based queue ordering also reveals model information, so use the
frozen sample order. Record independent-annotation mode and whether a prediction
was exposed. Never bind a hidden prediction as though the reviewer had seen it.

Keep the sampled prediction run fixed while collecting labels. Store human
judgments in their own append-only history and export a frozen gold manifest with
review IDs, reviewer identities, taxonomy hash, and adjudication rules. Do not
rerun or tune the predictor on those labels before reporting the held-out score.

Predefine stage accuracy and ordinal stage error, failure and endpoint metrics,
and event-time tolerance with missing-event handling. Report per-task scores,
counts, disagreements, and uncertainty for the small sample. The pipeline
receives human outcome labels, so binary outcome agreement is not an independent
accuracy estimate. Score historical stage progress and final-state semantics
against the agreed taxonomy without silently forcing predictions to agree with
those supplied outcomes.
