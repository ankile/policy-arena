# Consistent event review and separate human notes

Implementation date: 2026-09-06 UTC.

The first three annotation audit found correctly saved human action corrections
alongside stale stage times and source explanations. New trajectory reviews now
separate structured human judgments from retained source metadata. The original
prediction format, immutable prediction records, and earlier reviews remain
unchanged.

## Editing and confirmation

The form shows contradictory action/stage/failure times together, with buttons
to inspect each time in the video. When a single event in the same attempt can
be identified, the reviewer can explicitly set either timestamp to the other.
Undo restores the exact prior label. Other timestamps can still be entered in
the ordinary event editors. Multiple occurrences and ambiguous attempts require
manual review; the UI does not choose an occurrence for the annotator.

Some stages require an earlier action without being the same event. Their
constraint is a lower bound, not timestamp equality. Narrowly equivalent events
use inspected task-definition pins. Matching equivalent times follow explicit
edits together; existing disagreement is never normalized on load. Automatic
linking is suspended while a timestamp editor contains unfinished text.

The new consistency gate runs in the browser and in `stageReviews:save` for
new confirmed/corrected trajectory reviews. Draft and uncertain saves remain
lossless. Prediction import validation is unchanged, so model errors can still
be published for human review. Historical reviews are not rewritten or silently
removed from gold when this code is deployed. Reconcile their flagged event
facts before using the complete timeline for scoring.

## Human notes and coverage

`Your review notes` is available while policy identity remains hidden. It saves
in the existing top-level `stageReviews.notes`, never in prediction-shaped
`label.notes`. Reopening a review or changing the inspected prediction preserves
the human notes and original prediction attribution. Copying another review's
label preserves the current annotator's own separate notes.

The starting label's free-text evidence, notes, review reasons, and confidence
remain preserved for compatibility. Source prose is read-only in the form and
hidden while blind because it may reveal policy identity. It is not evidence
that the reviewer endorsed those explanations. Older starting labels may already
include human edits, so the UI calls this retained source text rather than
claiming all of it was authored by the model.

The new UI sends `review_protocol: "structured-v1"`. The server derives
`review_coverage` with a fixed set of reviewed structured fields on committed
reviews and an empty reviewed-field list on draft/uncertain reviews. Exclusions
explicitly include all retained prose/confidence and transport identity. This is
a whole-form attestation at confirmation, not an inference that each unchanged
field was individually assessed. The exact paths are single-sourced in
`convex/stageReviewCoverage.ts`.

Historical clients remain accepted without the protocol, and historical rows
without coverage do not acquire invented metadata. Scorers must retain this
provenance and score semantically compatible, human-reviewed fields. Do not use
retained prose or confidence as human gold. The summary scorer continues to score
summary judgments; it does not evaluate event timing or explanations.

New frozen benchmarks retain `review_coverage` and `human_notes` alongside the
canonical label and original review ID. Coverage paths refer to that original
review-label representation, as defined by the protocol; the canonical snapshot
has different nesting for some fields. These metadata fields participate in
the new snapshot's digest. Existing benchmarks and their digests are unchanged.

## Release verification

Release evidence is recorded after the complete test suite, independent review,
visual inspection, and live integrity comparison finish. No review save is needed
for deployment verification; write-path tests use the in-memory Convex test backend.
