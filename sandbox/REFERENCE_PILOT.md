# Local stage-reference pilot

Open `http://127.0.0.1:5174/sandbox/stage-review.html?queue=pilot20`.
The fixed manifest is `data/stage-reference-pilot.json`. It contains 60 distinct
dataset/episode identities: 20 per task, with 7 human successes and 13 human
failures (including timeouts). The editor uses Marker v7, Square v6 and Routing
v5; historical model stages never prefill these labels. Protocol upgrades do not
resample this fixed queue.

## Selection

The candidate pool has 1,233 episodes with explicit human decisions, from nine
evaluation datasets: Marker R3/R4/R5, Square R3/R4/R5, and Routing R4/R6/R8.
An Arena confirmed outcome takes precedence over the pinned HF outcome-edit
record. Skipped/undecided episodes are excluded, not guessed from model results.
Derived training views are not sampled alongside their parent datasets.

Within each outcome quota, selection balances datasets and greedily covers
historical failure enums, maximum stages, policy arms, and single/multiple
attempts. A fixed hash seed breaks ties. Old model categories are **sampling
proxies, not ground truth under the new definitions**. Routing includes one
human failure whose old model failure enum is `none`; it remains a failure in
the sample. Provenance records HF revisions/file hashes and immutable model
run/row identities. This is an intentionally enriched development/reference
set, not an estimate of population accuracy or an unseen test set.

`scripts/build_stage_pilot.ts` is read-only: it fetches metadata and existing
predictions, then prints a proposed manifest. It makes no model calls, writes no
database records, and downloads no videos. Review a regenerated manifest before
replacing the fixed set, especially after annotation has begun.

## Annotation

Use task tabs and colored episode buttons to jump across sampled datasets, or
Previous/Next for the full task's set. The usual left queue shows only the
selected episodes of the current dataset; Confirm advances within that dataset.
Use the reference bar's Next to continue to the next dataset. Cross-dataset
navigation waits for a safe draft save; invalid/incomplete edits block leaving.
Confirmed/corrected reviews count toward progress; drafts/uncertain reviews do
not. Existing saved labels are preserved and matched by dataset, episode and
taxonomy, never by episode number alone.

Model stage predictions are withheld in this mode, while existing human binary
outcomes remain visible. Browser-local saves and the existing export format are
unchanged. Export after each session; this playground does not sync to the
shared database. Stay on the same browser/origin (`127.0.0.1:5174`) to retain
access to local saves. Full-dataset browsing is still available as a separate
mode. Source media/outcomes are read live, so revalidate the frozen sample if
the HF revisions or human outcome decisions change.

## Carry forward earlier local annotations

The explicit **Carry forward saved reviews** control copies the latest local
Marker v6, Nut v5, and Routing v4 reviews into the current protocol. Original
save records and a byte-for-byte pre-transfer storage backup remain intact;
repeating the transfer never overwrites an existing current-version review.
Stage times, attempts, binary outcomes, and human notes are preserved. This is
a named compatibility migration, not general numeric stage-ID remapping.

Unambiguous failure categories are mapped. Ambiguous categories retain the
stages as a draft and ask only for a new failure choice. Marker/Nut S6 release
timestamps are preserved with a request to check the earlier full-seating time;
they are not silently certified under the broader S6 definition. Routing's
stage IDs remain unchanged, but carried Routing reviews stay drafts until physical
LEFT/RIGHT identity and the terminal wrong-order rule have been checked. Earlier
incompatible stage ladders are untouched.
Source provenance is retained in export-only `local_migration` metadata, not a
fake new model prediction. Hidden machine ledgers stay in their old originals.
Only fully compatible, previously supervised reviews retain confirmed status.
The queue marks carried drafts with ↪; a short notice identifies what to check.

Local writes re-read storage under a browser lock so multiple open tabs do not
erase each other's saves. This operation never writes to the shared database.

The in-place insertion-failure refinement does not change any stage definitions.
An explicit transfer also handles affected current-version local reviews:
the old broad false-insertion and incomplete-insertion choices become drafts
requiring a failure-category check, while all stage marks, outcomes and notes
are copied unchanged. Original save records remain intact. Routing's partial-entry
category receives the same check. New saves include an export-only definition
content pin so this correction cannot repeatedly downgrade newly reviewed labels.
No machine-label fields, protocol IDs, or shared database records are changed by
this local transfer. Old TOP contact and Nut hole-miss categories are not guessed
into the new blocked-entry category without evidence of an insertion attempt.

Routing's current definition also separates grasp failures for LEFT and RIGHT
clip work: grasp not established versus loss after sustained control for each.
The physical work phase owns the event, not the count of pickups or the furthest
stage. Existing unqualified Routing grasp failures carry to a draft requiring
only that failure choice; stages, binary outcome, notes, and originals remain
intact. Previously rechecked partial-entry categories are not reopened. The
left-before-right terminal rule and all stage definitions are unchanged.

The subsequent Routing clarification keeps stage IDs but changes the S3/S8 and
S4/S9 boundaries: span the clip's work-surface position, then touch its entrance
in the correct insertion direction. A 90-degree-off push can achieve spanning
without engagement; correctly directed contact can achieve engagement without
entry. Seating is still independently required for success. Existing Routing
reviews carry to drafts with their marks, outcomes, and compatible failure
choices preserved, requesting a timing check rather than silently certifying
the changed criteria. Marker and Square gold references are unchanged.

Routing now separates a gross wrong approach angle for each physical clip
(`first_clip_wrong_approach_angle` / `second_clip_wrong_approach_angle`) from
ordinary missed entry. Roughly 45/90 degrees are illustrative, not numeric
thresholds inferred from camera projection. Stages are unchanged by this split.
Older entry-missed reviews need a cause-only recheck; compatible reviews under
the spanning/contact definition keep their confirmation when carried forward.
No saved review is overwritten, and wrong clip order remains terminal priority.

The per-clip “seated rope came out” categories are merged into “not fully seated.”
That category covers both partial-entry stalls and later loss of seating; an
earlier seating action or high stage remains historical evidence, not success
proof. Carry-forward maps the old loss category to the same physical clip's
`seating_incomplete` without changing stages, timestamps, outcome, or notes.
Compatible confirmed reviews keep confirmation; originals remain in the export.
