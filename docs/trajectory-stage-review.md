# Generic trajectory stage review

The `trajectory-review/v1` adapter preserves canonical machine labels in the append-only human review flow. It supports historical `trajectory-label/v1` and current `trajectory-label/v2`; the adapter version is not the machine output version. New navigation shows only the latest task definition, selected by dataset.

## Current protocol: no end-state labels

The release uses **Marker v7, Square nut v6, and Routing v5**, generated from SIR's `trajectory-task/v2` definitions. Machine labels use `trajectory-label/v2`. New definitions, response schemas, labels, human forms, and summary metrics have **no end-state inventory or field**. Task-specific physical success requirements remain necessary; removing the end-state enum does not remove the success criterion.

Human reviews use `stages-outcome-v3`: reviewers supervise stage transitions/times, maximum historical stage, attempt count, binary success, and primary failure category. Key actions and failure-event timestamps remain available to the machine pipeline, but are neither shown as human controls nor certified by this review scope. Existing human binary outcomes prefill across definition revisions. They do not supply missing stage times or action observations.

Marker/Nut S1–S6 mean align for grasp, establish grasp, lift, align for insertion, engage the target, and achieve full seating. **S6 no longer requires release.** Routing retains its two-cycle S1–S10 ladder; both clips correctly seated in LEFT-then-RIGHT order is success even if the final release is absent. A subsequent placement loss can fail after the highest stage was reached: never erase historical progress to force agreement with the final outcome.

Marker/Nut failure categories are `grasp_not_established`, `grasp_lost`, `insertion_not_attempted`, `false_insertion`, `incomplete_insertion`, and `placement_lost`. These distinguish no secure grasp from losing one, no entry from incomplete seating after entry, and later loss of an achieved placement. Routing shares the grasp categories and defines not-attempted, engagement-missed, seating-incomplete, and retention-lost for each physical clip. All tasks add `none` for success and `unknown_failure_cause` when evidence cannot establish the cause (requires explanation and review).

**Routing order is terminal:** `first_clip` is the fixed physical LEFT clip, `second_clip` is RIGHT, independent of camera viewpoint or visitation order. A deliberate RIGHT insertion attempt before LEFT seating is `wrong_clip_order`, even if both clips seat later. Mere approach/contact/overlap is not an insertion attempt. The failure selector names both clips explicitly. Machine validators reject terminal events reported as success and observed reversed action chronology without a matching failure event; unobserved left seating is not automatically proof of absence. Terminal wrong order takes primary-failure priority over recoverable events. Contradictory human-success evidence requires adjudication; source outcomes are not overwritten.

Otherwise choose the earliest clearly observed specific failure that remains unrecovered; later achievement can recover it. Keep recovered/later events in the machine ledger. Generic absence/unknown categories apply only without a specific unrecovered event; enum order breaks equal-onset ties. Separate position/rotation misalignment and release-incomplete categories are removed. A human-anchored success with an early recording cutoff must preserve the binary outcome and request review rather than invent unseen stages/actions/timestamps.

Published definitions and exported schemas are immutable and hash-bound. The unpublished Routing v5 definition is corrected in place with refreshed hashes, not a new protocol. Existing hash guards still reject incompatible same-version content; never bypass publication guards or silently attach old predictions to corrected definitions. Old annotations, local saves, predictions, and their end-state fields retain their original version and meaning; nothing is silently migrated or deleted. Historical supervised end-state scores remain historical, not v2 metrics. Source-free human reviews do not automatically become evaluation gold: attribution and review-coverage requirements still apply.

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

## Retained history and local annotations

Unused intermediate Marker v5, Nut v4, and Routing v2/v3 draft files and their preview copies were removed; Git retains their history. Published legacy definitions and Marker v6, Nut v5, Routing v4 predecessors remain for replay and explicit annotation transfer. The current protocol/version IDs are unchanged.

The local pilot remains the same 20 episodes per task. Its explicit carry-forward operation appends new reviews without overwriting originals, backs up local storage first, and preserves stage timestamps, attempts, human outcomes, and notes. Ambiguous failure mappings and changed S6 semantics stay drafts for review. Routing transfers additionally require checking physical left/right identity and order; a previous confirmation is not certification of the corrected order rule. Original machine action ledgers are not passed off as new predictions. This browser-local operation does not publish reviews to the shared database.

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
