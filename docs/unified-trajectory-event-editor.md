# Unified trajectory event editor

Implementation date: 2026-09-06 UTC.

Pipeline follow-up: [self-improving-robots issue #71](https://github.com/ankile/self-improving-robots/issues/71).

## Reviewer workflow

The episode editor presents actions, stage transitions, and failures in one
chronological list. A physical event shared by an action and a stage has one
time control. A related stage with a conflicting prediction is shown inside
that event's card, with both original estimates available for video inspection.
The reviewer can choose either estimate or mark/type another observed time once.
This explicitly updates the action occurrence, its first-time summary, and the
stage timestamp together. Nothing is normalized when the form opens.

Conditional associations require a human decision. “Keep as separate events”
restores independent event cards, and the choice survives save/reload. Narrow
semantic equivalences whose existing times already agree display a shared editor.
Required-before constraints remain separate and cannot be bypassed by choosing
“distinct.” Multiple occurrences, ambiguous clip histories, and unknown task
pins retain independent events rather than guessing an association.

Pinned conditional pairs cover Routing clip arrival, Marker v3/v4 transport,
holder arrival, insertion and full depth, and Square v3 peg arrival, engagement,
partial retention after release and full seating. These present a human choice,
not an assumption of simultaneity. Marker lift alone cannot establish S2, which
also requires transport. Terminal S7 remains independent in Marker and Square
because release, clearance and cutoff evidence can establish different events.

Event details retain stage identities, attempts, and source evidence. Editing a
shared attempt updates both references together. Incomplete time/attempt text
stays in the editor and blocks navigation/saving until resolved. Chronological
display changes do not reorder the underlying arrays or replace focused inputs.
Structural changes and explicit timing resolutions support exact Undo.

Primary failure is selected from the failure event cards. Editing that selected
event updates the top summary; the summary no longer has independent mode/time
inputs. Removing the primary event clears the selection and requires a new
decision, without inventing a different failure or success. A no-primary-failure
choice remains subject to the existing successful-episode contract. Ambiguous
historical summaries remain visible until corrected; opening a review never
selects a failure on the user's behalf.

## Compatibility and integrity

The prediction label format, task definitions, prediction hashes, and append-only
history are unchanged. The UI continues to emit the existing occurrence/action/
stage/failure fields, so existing validation and label exports remain compatible.

Optional `stageReviews.event_links` stores human associations outside the label:
`{ action_id, stage_id, attempt_index, relation: "shared" | "distinct" }`.
References require a unique occurrence and transition in the same attempt.
Indices are not stored, so display ordering cannot redirect a reference. An
explicit structural edit invalidates affected associations instead of rebinding
them to another occurrence. The backend rejects stale, duplicate, or ambiguous
references on confirmation and requires equal shared timestamps. Drafts preserve
unfinished metadata for explicit recovery. Older rows and clients without this
field remain supported; there is no database backfill.

Metadata seeds only from the reviewer's own saved review or an explicitly copied
review. It never comes from a prediction. Metadata-only edits participate in the
same dirty-draft, navigation, and save guards as label edits. Original prediction
attribution remains fixed throughout the review.

Human notes and structured review coverage retain the existing behavior in
[trajectory-review-consistency.md](trajectory-review-consistency.md). Source
confidence and prose remain separate from human judgments and hidden where
necessary to preserve policy blindness.

## Pipeline work deferred to issue #71

The long-term contract should predict canonical events with stable event IDs,
stage-condition references, and a primary-failure event reference. Task specs
should declare equivalence, prerequisite, and conditional relations explicitly.
The current UI uses inspected task pins for those relations; it does not assume
all required actions are simultaneous with stage entry.

The follow-up must preserve raw model outputs, immutable histories, human-label
provenance, and compatible existing gold. New held-out human annotations remain
unseen to pipeline development; viewing predictions while labeling is intended,
while policy source stays blind. Do not tune on that set and continue to call it
unseen.

## Verification before release

- Complete suite: 540 tests passed, zero failed, 12,479 assertions.
- ESLint, production build, and the separate Convex TypeScript check passed.
- Independent final audit: 39 focused tests, 166 assertions, no blocking defects.
- Browser fixture inspection at 1,400px desktop, 760px tablet, and 390px phone:
  one shared time control, candidate resolution, failure selection, and no phone
  horizontal overflow. Fixture editing uses in-memory I/O, not the live database.
- Regression coverage includes all three reported Routing timing disagreements,
  shared/distinct persistence, exact Undo, primary event edits/removal, incomplete
  time/attempt guards, source attribution, chronology repair, malformed inputs,
  blind-field redaction, and conservative Marker/Square conditional relations.

## Live rollout

Deployed 2026-09-06 UTC from implementation `69dc159` and generated API types
`2cf7984` to the existing `grandiose-rook-292` backend and production frontend.
Vercel deployment `dpl_HU1pVqHGHwFWkGdHahBYokAe67sP` is ready at
<https://policy-eval.ankile.com/>.

The served JavaScript `/assets/index-CN-t2sGv.js` matches the tested local build
byte-for-byte, SHA-256
`d1ca7d0e4e5275157310d81e7cf9818eaf255cfa0980571c9e6e5b95e6d8e109`.
The release browser had no editor session; the live episode URL correctly
required editor sign-in. Form interactions were exercised in the isolated
browser fixture and DOM tests, not by creating test annotations in production.

Before/after Convex snapshots compared by document ID are exactly equal for
stageReviews (621), stagePredictions (5,770), stagePredictionRuns (68),
stageTaskSpecs (9), stagePrefills (4,325), labelingBenchmarks (0), and
labelingScores (0). The deployment performs no data migration or label rewrite.
