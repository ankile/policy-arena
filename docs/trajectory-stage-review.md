# Generic trajectory stage review

The `trajectory-review/v1` adapter uses the existing stage review, draft, version selector, and append-only human review flow. It adds the complete `trajectory-label/v1` event ledger without changing legacy taxonomy rules or legacy prediction rows.

## Stored representation

The exported spec includes `trajectory.adapter_version`, the complete source `task_definition`, its `task_definition_sha256`, and the generated `response_schema`. The Arena taxonomy is `trajectory-review/v1/<source taxonomyVersion>`. The embedded task definition retains its native taxonomy version.

| Canonical prediction | Editable review field |
| --- | --- |
| `schema_version`, `task_id`, `taxonomy_version`, `sample_id` | `trajectory_identity` (source identity, not editable) |
| `max_stage.stage_index`, `max_stage.stage_id` | `max_stage`, `max_stage_id` |
| `primary_failure.failure_mode_id`, `primary_failure.time_s` | `failure_mode`, `primary_failure_time_s` |
| `final_state_id` | `final_state` |
| Remaining scalars and event arrays | Same names and complete values |

Remaining fields are `attempt_count`, `task_success`, `stage_transitions`, `key_action_observations`, `failure_events`, `confidence`, `needs_human_review`, `review_reasons`, and `notes`. Repeated occurrences, attempts, timestamps, confidence, and evidence stay intact. The immutable prediction additionally retains the complete original `canonical_response`.

Registration verifies the source definition's sorted compact UTF-8 JSON SHA-256 and the whole exported spec's Arena typed content digest. Import rejects unsupported identity or structural fields and requires lossless agreement between the editable representation and `canonical_response`. Supported semantic errors remain inspectable predictions with validation flags. Confirmed/corrected human reviews must pass the shared semantic, structural, and episode-duration checks.

The TypeScript semantic validator follows `sir/real/stage_labeling/trajectory_contract.py`; cross-language fixtures and the real local HTTP integration test check agreement. Source task definitions use integer stage indices. A fractional numeric extension to the task definition requires an explicit source serialization update.

## Reviewing and correcting

The form edits summary decisions, every transition, every key action occurrence, and every failure event. Its event history scrolls within a bounded panel with a visible playhead readout, keeping the surrounding video controls in place. Maximum historical progress and final outcome remain separate. Changing an endpoint or success value does not erase earlier events. The definition panel lists stages, success requirements, and decision rules.

Timestamp inputs preserve native precision. Focusing and leaving an unchanged field never rounds source values. Valid edits enter the draft immediately; unfinished numeric text blocks saving and navigation until corrected or cleared. Marking and seeking use the existing video controls. Adding, removing, or reordering events is explicit; validation checks action order, attempts, chronology, required actions, matching primary failure onset, and duration bounds with the source's 0.01-second endpoint tolerance.

A version switch saves an eligible draft before navigating. An existing own review remains authoritative and keeps its original source identity even while another model version is selected. Other available taxonomies are linked only when a published prediction exists for the current episode; each link shows that run's episode count. Separate schemas are never translated or blended.

Policy-blind mode hides free-text evidence, reasons, notes, raw prediction JSON, and pipeline identity until explicit unblinding. It does **not** hide predicted stages, structured decisions, or current outcome decisions. Unblinding is retained in the saved review attestation.

Prediction provenance shows the original source revision and duration. Outcome decisions are drawn from the current outcome records. The source revision is provenance: the browser's existing dataset metadata/media reads still use the current Hugging Face dataset. Before reviewing predictions against a changed dataset revision, verify that the video and frame coordinates still identify the original episode; differing source/current cutoffs must be documented separately.

## New annotations and later evaluation

An episode without a prediction starts with an explicit source-free identity, `<dataset_repo>#episode=<episode_index>`, unset maximum stage/success/final state, empty event ledgers, and the declared action inventory. It receives no success overlay from the legacy outcome-inheritance path. Before the form opens, the existing frame-signal reader must resolve the validated policy prefix; loading or errors block annotation. The prefix duration is captured in the draft attribution, and reset-tail timestamps cannot become confirmed labels. Raw episode length is not substituted when this lookup fails.

This remains the ordinary assisted review flow. Reviewing/correcting predictions, or labeling while current outcomes and model summaries are visible, does not produce an unseen independent evaluation set. Exclude those exposed episodes from the later unseen sample. Prediction-hidden annotation, mode-aware gold folding, a locked holdout sample, and scoring against that holdout are follow-up work; this change does not select or score episodes.

## Local verification

- `bun test` includes Python semantic fixtures, generic Convex import/review tests, and actual `StageReview` DOM tests.
- `tests/integration/test_prediction_roundtrip.py` exercises real local machine HTTP handlers and Python reverse conversion; see `tests/integration/README.md`.
- Run Vite locally and open `/tests/browser/stage-review.html?fixture=trajectory&episode=0&prediction=A` for the real review component with an archived Marker prediction fixture. The fixture has no camera, Convex, or Hugging Face calls; saves affect only its in-memory adapter. It is not an application route or production bypass.
