# Generic trajectory stage review

The `trajectory-review/v1` adapter preserves canonical machine labels in the append-only human review flow. It supports historical `trajectory-label/v1` and current `trajectory-label/v2`; the adapter version is not the machine output version. New navigation shows only the latest task definition, selected by dataset.

## Current protocol: no end-state labels

The release uses **Marker v7, Square nut v6, and Routing v5**, generated from SIR's `trajectory-task/v2` definitions. Machine labels use `trajectory-label/v2`. New definitions, response schemas, labels, human forms, and summary metrics have **no end-state inventory or field**. Task-specific physical success requirements remain necessary; removing the end-state enum does not remove the success criterion.

Human reviews use `stages-outcome-v3`: reviewers supervise stage transitions/times, maximum historical stage, attempt count, binary success, and primary failure category. Key actions and failure-event timestamps remain available to the machine pipeline, but are neither shown as human controls nor certified by this review scope. Existing human binary outcomes prefill across definition revisions. They do not supply missing stage times or action observations.

Marker/Nut S1–S6 mean align for grasp, establish grasp, lift, align for insertion, engage the target, and achieve full seating. **S6 no longer requires release.** Routing retains its two-cycle S1–S10 ladder; both clips correctly seated is success even if the final release is absent. A subsequent placement loss can fail after the highest stage was reached: never erase historical progress to force agreement with the final outcome.

Marker/Nut failure categories are `grasp_not_established`, `grasp_lost`, `insertion_not_attempted`, `false_insertion`, `incomplete_insertion`, and `placement_lost`. These distinguish no secure grasp from losing one, no entry from incomplete seating after entry, and later loss of an achieved placement. Routing shares the grasp categories and defines not-attempted, engagement-missed, seating-incomplete, and retention-lost for each physical clip. All tasks add `none` for success and `unknown_failure_cause` when evidence cannot establish the cause (requires explanation and review).

Choose the earliest clearly observed specific failure that remains unrecovered; later achievement can recover it. Keep recovered/later events in the machine ledger. Generic absence/unknown categories apply only without a specific unrecovered event; enum order breaks equal-onset ties. Separate position/rotation misalignment and release-incomplete categories are removed. A human-anchored success with an early recording cutoff must preserve the binary outcome and request review rather than invent unseen stages/actions/timestamps.

Definitions and exported schemas are immutable and hash-bound. Old annotations, local saves, predictions, and their end-state fields retain their original version and meaning; nothing is silently migrated or deleted. Historical supervised end-state scores remain historical, not v2 metrics. Source-free human reviews do not automatically become evaluation gold: attribution and review-coverage requirements still apply.

SIR's new campaign CLI defaults to these definitions; explicit historical task files retain v1 replay. Its low-level historical loader remains pinned for parity. No relabeling or shared database publication is performed merely by exporting specs or running the local playground.

## Stored representation

The exported spec includes `trajectory.adapter_version`, the complete source `task_definition`, its `task_definition_sha256`, and the generated `response_schema`. The Arena taxonomy is `trajectory-review/v1/<source taxonomyVersion>`. The embedded task definition retains its native taxonomy version.

| Canonical prediction | Editable review field |
| --- | --- |
| `schema_version`, `task_id`, `taxonomy_version`, `sample_id` | `trajectory_identity` (source identity, not editable) |
| `max_stage.stage_index`, `max_stage.stage_id` | `max_stage`, `max_stage_id` |
| `primary_failure.failure_mode_id`, `primary_failure.time_s` | `failure_mode`, `primary_failure_time_s` |
| `final_state_id` (historical v1 only) | `final_state` (historical v1 only) |
| Remaining scalars and event arrays | Same names and complete values |

Remaining fields are `attempt_count`, `task_success`, `stage_transitions`, `key_action_observations`, `failure_events`, `confidence`, `needs_human_review`, `review_reasons`, and `notes`. Repeated occurrences, attempts, timestamps, confidence, and evidence stay intact. The immutable prediction additionally retains the complete original `canonical_response`.

Registration verifies the source definition's sorted compact UTF-8 JSON SHA-256 and the whole exported spec's Arena typed content digest. Import rejects unsupported identity or structural fields and requires lossless agreement between the editable representation and `canonical_response`. Supported semantic errors remain inspectable predictions with validation flags. Confirmed/corrected human reviews must pass the shared semantic, structural, and episode-duration checks.

The TypeScript semantic validator follows `sir/real/stage_labeling/trajectory_contract.py`; cross-language fixtures and the real local HTTP integration test check agreement. Source task definitions use integer stage indices. A fractional numeric extension to the task definition requires an explicit source serialization update.

## Reviewing and correcting

The current form places stage-marking controls beside the synchronized video playhead and shows stage marks on the timeline. Reviewers edit stages, result, and primary failure, not the hidden action ledger or end-state fields. Maximum historical progress and final outcome remain separate. Changing success does not erase earlier events. The definition panel lists stages, success requirements, and decision rules. Historical structured reviews retain their original, broader attestation scope.

Timestamp inputs preserve native precision. Focusing and leaving an unchanged field never rounds source values. Valid edits enter the draft immediately; unfinished numeric text blocks saving and navigation until corrected or cleared. Marking and seeking use the existing video controls. Adding, removing, or reordering events is explicit; validation checks action order, attempts, chronology, required actions, matching primary failure onset, and duration bounds with the source's 0.01-second endpoint tolerance.

An eligible draft is saved before navigation. An existing own review remains authoritative within its original taxonomy and source identity. New task navigation uses the latest definition; incompatible old predictions are not reused as new stage suggestions. Separate schemas are never translated or blended.

Policy-blind mode hides free-text evidence, reasons, notes, raw prediction JSON, and pipeline identity until explicit unblinding. It does **not** hide predicted stages, structured decisions, or current outcome decisions. Unblinding is retained in the saved review attestation.

Prediction provenance shows the original source revision and duration. Outcome decisions are drawn from the current outcome records. The source revision is provenance: the browser's existing dataset metadata/media reads still use the current Hugging Face dataset. Before reviewing predictions against a changed dataset revision, verify that the video and frame coordinates still identify the original episode; differing source/current cutoffs must be documented separately.

## New annotations and later evaluation

An episode without a compatible prediction starts with an explicit source-free identity, `<dataset_repo>#episode=<episode_index>`, unset maximum stage, empty event ledgers, and the declared machine action inventory. An existing human binary outcome can prefill success independently of stage-definition changes; otherwise the result is unset. V2 has no final-state field. Before the form opens, the existing frame-signal reader must resolve the validated policy prefix; loading or errors block annotation. The prefix duration is captured in the draft attribution, and reset-tail timestamps cannot become confirmed labels. Raw episode length is not substituted when this lookup fails.

This remains the ordinary assisted review flow. Reviewing/correcting predictions, or labeling while current outcomes and model summaries are visible, does not produce an unseen independent evaluation set. Exclude those exposed episodes from the later unseen sample. Prediction-hidden annotation, mode-aware gold folding, a locked holdout sample, and scoring against that holdout are follow-up work; this change does not select or score episodes.

## Local verification

- `bun test` includes Python semantic fixtures, generic Convex import/review tests, and actual `StageReview` DOM tests.
- `tests/integration/test_prediction_roundtrip.py` exercises real local machine HTTP handlers and Python reverse conversion; see `tests/integration/README.md`.
- Run Vite locally and open `/tests/browser/stage-review.html?fixture=trajectory&episode=0&prediction=A` for the real review component with an archived Marker prediction fixture. The fixture has no camera, Convex, or Hugging Face calls; saves affect only its in-memory adapter. It is not an application route or production bypass.

## Historical design notes (superseded, not current instructions)

The following three revision notes describe earlier immutable candidates. Their release requirements, endpoint fields, defaults, and navigation behavior are historical. Use the current protocol and production release sections for new work.

### Routing two-cycle revision (v3 candidate)

The local playground groups both Routing datasets under one task. New Routing
navigation explicitly selects `trajectory-review/v1/routing_d1/v3`; existing
deep links keep their original taxonomy/prediction selection. The v3 candidate
is supplied only by the sandbox data adapter, not registered or made live in
Convex. The production app and published predictions are unchanged.

The task definition lives in SIR at
`sir/real/stage_labeling/data/routing_d1_v3.json`. The playground's generated
`sandbox/data/routing_d1_v3.spec.json` includes that complete definition, its
content hash, and the ordinary generated `trajectory-label/v1` response schema.
It changes task semantics, not the output format or human supervision scope.

| First cycle | Second cycle |
| --- | --- |
| S1 · Reach the rope | S6 · Reach the rope again |
| S2 · Hold the rope | S7 · Hold the rope again |
| S3 · Align with the first clip | S8 · Align with the second clip |
| S4 · Engage the first clip | S9 · Engage the second clip |
| S5 · First release | S10 · Final release |

S0 means the rope has not yet been reached. Reach requires arrival within
grasping range; holding requires sustained rope control, not a momentary pinch.
FIRST/SECOND retain the canonical physical clip identities, not camera-space
left/right. The second cycle describes a new pickup after first-clip work; it
does not require the first clip to be seated. Repeated initial pickup retries
are not a second cycle. Continuing the original hold does not establish S6/S7.

Release requires actually letting go of a held rope, not opening empty jaws or
an accidental slip from closed jaws. An episode ending after only first-clip
work reaches S5, not S10. A final release is not a successful-seat judgment:
S10 can fail, and a successful endpoint may stop at S9 while still held. The
existing physical success criterion still requires both clips to remain seated;
seating stays in the pipeline action ledger and separate endpoint judgment.
Timestamp only supported milestones; equal timestamps and forward jumps are
allowed. Out-of-order or uncertain clip identity is flagged for human review,
not silently relabeled into the normal sequence.

V1 and the earlier v2 clip-milestone candidate are preserved, not converted:
renaming their stages cannot supply trustworthy v3 times. V3 reviews start
without earlier model prefill, and local saves remain keyed by dataset, episode,
and taxonomy. Use the taxonomy selector to return to previous reviews/predictions.
The pipeline's existing `routing_d1` default remains v1 for reproducibility;
future v3 runs must select the new definition file explicitly. No relabeling,
remote publication, or shared human-label migration is performed here.

Verify the preview against SIR using a Python environment with the SIR imports:

```bash
python scripts/build_stage_preview.py --sir-root /path/to/self-improving-robots --task routing_d1 --version v3 --check
python scripts/build_stage_preview.py --sir-root /path/to/self-improving-robots --task routing_d1 --version v2 --check
```

Without `--check`, this command prints the reproducible preview spec. Publishing
v3 later requires the normal new-taxonomy registration and separate prediction
run; it must not overwrite earlier artifacts or change the meaning of saved reviews.

### Positive Marker and Square nut stages (v5/v4 candidates)

The same local preview adapter now supplies `marker_d2/v5` and `square_d2/v4`.
New task navigation selects the respective candidate explicitly, without model
prefill. Existing URLs, published specs, prediction payloads, and saved labels
retain their original versions. No shared labels are migrated or overwritten.

| Stage | Marker v5 | Square nut v4 |
| --- | --- | --- |
| S0 | Start | Start |
| S1 | Align for grasp | Align for grasp |
| S2 | Grasp the marker | Grasp the nut |
| S3 | Lift the marker | Lift the nut |
| S4 | Align the marker for insertion | Align the nut over the peg |
| S5 | Engage the holder hole | Engage the peg through the hole |
| S6 | Release the fully seated marker | Release the nut to the base |

Stages are positive achievements. A secure hold while still on the table is S2;
table clearance is S3. Marker S4 requires upright, local hole alignment, not
merely turning vertical elsewhere. S5 requires actual hole engagement, not
pressing beside the insertion target. A partial release or fully-seated hold
remains an endpoint/action distinction within S5, not an extra human stage.

For a failed episode ending at S{k} below S6, the progress shortfall is failure
to reach S{k+1}; the concrete causal failure mode is still separate. Never assign
the next stage just because it was attempted. Occluded evidence warrants review,
not certainty that an event never happened. Later loss of a verified S6 result
does not erase S6 or imply a nonexistent S7. Maximum stage remains the highest
achievement across attempts rather than the final physical state.

The narrow recording-cutoff allowances are retained: Marker requires visible
release of an already fully seated marker even if retreat is cut off; Nut
requires released, independent downward motion along a captured peg shaft with
no obstruction/escape path. Neither permits invented future times or seating.

Canonical sources are `sir/real/stage_labeling/data/marker_d2_v5.json` and
`square_d2_v4.json` in SIR. The JSON output remains `trajectory-label/v1`, with
versioned stage IDs and one additional secure-grasp action per task; existing
close-attempt actions cannot stand in for verified grasp. Humans still supervise
stages, result, end state, and primary failure, not the hidden action ledger.
Built-in SIR defaults remain pinned for old campaigns; new runs must explicitly
select the candidate definition files. No model runs or remote publication are
performed by the preview generator.

```bash
python scripts/build_stage_preview.py --sir-root /path/to/self-improving-robots --task marker_d2 --version v5 --check
python scripts/build_stage_preview.py --sir-root /path/to/self-improving-robots --task square_d2 --version v4 --check
```

### Failure and endpoint revisions (v6/v5/v4 candidates)

Current navigation selects **Marker v6, Square nut v5, and Routing v4**. These
preserve the preceding positive stage ladders and key actions exactly, while
versioning failure causes, endpoint definitions, and related decision rules.
The output shape is still `trajectory-label/v1`. Old definitions/specs remain
selectable with their original hashes; no labels, predictions, or local saves
are converted. Built-in SIR campaign defaults remain unchanged. These are local
preview candidates, not registered cloud taxonomies or newly evaluated prompts.

Three independent questions govern labeling:

1. **Progress:** which positive milestones were actually achieved? For Marker
   and Nut, failure after S3 means lift achieved but insertion alignment S4 was
   not achieved. Historical progress survives a later loss.
2. **Failure:** what observed cause explains the unresolved unsuccessful result?
   Prefer a specific cause to `progress_stopped`. Keep recovered events in the
   event ledger, but do not make them the primary cause of an eventual success.
3. **Endpoint:** where is the object now, is it engaged/seated, and is it held
   or released? A table endpoint alone cannot distinguish a miss from a drop.

| Phase | Marker | Square nut |
| --- | --- | --- |
| Grasp alignment / pickup | `pregrasp_misalignment`, `grasp_not_attempted`, `grasp_miss` | Same |
| Hold / lift | `grasp_lost`, `lift_blocked` | Same |
| Insertion preparation | `insertion_position_misalignment`, `insertion_orientation_misalignment`, `insertion_path_blocked` | Same |
| Entry / descent | `holder_contact_no_insertion`, `false_insertion`, `wrong_hole_entry`, `insertion_jammed` | `hole_missed_peg`, `insertion_jammed` |
| Release | `released_before_seating`, `release_not_completed` | `released_off_peg`, `released_hung_on_peg`, `release_not_completed` |
| Later loss | `placement_lost_after_release` | Same |

This table groups typical phases; it is **not a hard maximum-stage filter**.
Marker TOP/rim contact without entry remains `holder_contact_no_insertion`;
SIDE/table pushing is `false_insertion`. A wrong hole is a failure only when the
task explicitly constrains the target hole. Nut off-peg release is distinct
from a static on-peg hang, and neither overrides the narrow verified
captured-descent cutoff allowance. `release_not_completed` requires a fully
seated object that is still clamped, not simply holding it elsewhere.

Routing uses shared `grasp_not_attempted`, `grasp_miss`, and `grasp_lost`, with
the pickup cycle stated in evidence. Each physical clip has five explicit
outcomes: `{first,second}_clip_not_attempted`, `_alignment_failed`,
`_engagement_missed`, `_seating_incomplete`, and `_seat_lost`. A first-clip loss
can explain failure even at S10 after successful second-clip work. There is no
automatic release failure: both clips seated at S9 can be a success while held.
If fingers visibly obstruct seating, use that clip's seating-incomplete mode.

All tasks also declare `none` (successful terminal result), `progress_stopped`
(visible terminal shortfall without a more specific cause),
`unknown_failure_cause` (insufficient evidence), and `other` (visible cause
outside the inventory). Unknown/other require an explanation and review.
Observed events use their first decisive timestamp. Endpoint-conditioned
absences use final decisive evidence, not a fabricated earlier onset.

Marker/Nut endpoints now distinguish table-supported secure grasp, lifted hold
away from target, local hold without entry, partial engagement held/released,
full seating held/released, the existing narrow cutoff state, free airborne,
known off-table, and unclear. Prefer the most specific state. Routing endpoints
first identify the retained clip set (neither/first/second/both), then held vs
released. Seat-set-only states apply when capture is known but grip status is
uncertain; unknown capture instead requires `unclear` and review.

Open **Failure causes and end states · definition reference** above the player
to inspect every current definition. The editor uses the same enums and shows
their descriptions. Human edits still do not attest hidden key actions or
rewrite failure-event timestamps.

Regenerate/check the current candidates using the SIR-compatible environment:

```bash
uv run python scripts/build_stage_preview.py --sir-root /path/to/self-improving-robots --task marker_d2 --check
uv run python scripts/build_stage_preview.py --sir-root /path/to/self-improving-robots --task square_d2 --check
uv run python scripts/build_stage_preview.py --sir-root /path/to/self-improving-robots --task routing_d1 --check
```

Use explicit `--version` to verify older immutable candidates. The generator
derives failure/end-state inventories and the canonical response schema from
SIR, and fails if the adapter's preferred success endpoint becomes invalid.

## Production release: latest definitions

The shared Data Explorer → dataset → Stage review release targets Marker v7 (S1–S6),
Square nut v6 (S1–S6), and Routing v5 (S1–S10), plus S0. The dataset determines
the task; this adds no task/dataset selector or combined queue. The version is
shown as a read-only badge, not a selector.

Release pins live in `shared/stageReviewTasks.ts`; exact exported definitions in
`data/stage-review/` are also used by the playground. The SIR Python definitions
remain the authoring source. `scripts/build_stage_preview.py --check` verifies
these generated snapshots against SIR. The release guard pins the published
predecessors (Marker v4, Nut v3, Routing v1), not intermediate local candidates.
An unexpected live version requires inspection before changing the release pins.

Existing human success/failure outcomes still prefill new reviews. Old stage
predictions/reviews are never translated into a new definition. Stale links open
the latest definition without reusing incompatible model suggestions; compatible
explicit prediction choices and saved human edits remain intact. Missing or
inactive definitions block editing rather than silently falling back.

### Coordinated backend, definitions, and frontend rollout

Merging code does **not** publish database definitions. First deploy the additive
backend changes for `trajectory-task/v2`, `trajectory-label/v2`, and
`stages-outcome-v3` using the project's approved backend deployment workflow.
Keep support for historical versions. Only then publish definitions through the
existing service-only `stageTaskSpecs.upsert` mutation and verify them before
deploying the new frontend. No shared deployment is performed by this PR itself.
The frontend blocks editing when backend review capabilities are missing.

With the reviewed artifacts and compatible backend:

```sh
# Read-only inspection (no credential required):
bun run stage-review:release --url https://grandiose-rook-292.convex.cloud

# Approved publication; existing ARENA_SERVICE_TOKEN must be in the environment:
bun run stage-review:release --url https://grandiose-rook-292.convex.cloud --apply

# Read-only gate: fails if any released definition is missing/inactive/different:
bun run stage-review:release --url https://grandiose-rook-292.convex.cloud --verify
```

Keep the token out of git, command-line arguments, and all `VITE_*` variables.
Preflight verifies all content hashes and rejects unexpected live versions.
The command stages candidates before promoting tasks, then verifies readback.
This is resumable, **not atomic across tasks**; do not run concurrent publishers.
On interruption, inspect and rerun. Already completed tasks are skipped. Only
task-spec rows/live flags change; no predictions, reviews, or human outcomes do.

After verification, merge/deploy the frontend and sign in to check the definition
badge, stage menu, inherited human outcome, and a scoped draft for each task.
The playground remains browser-local and is not a shared labeling endpoint.
Historical definitions/reviews remain stored; rollback must never delete labels
or change the meaning of an existing version.
