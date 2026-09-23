# Stage-review playground

Try the video-centered editor against real Routing, Marker, and Square nut
videos and imported predictions, without changing shared labels or signing in.

```sh
bun install --frozen-lockfile
bun run dev --host 127.0.0.1 --port 5174 --strictPort
```

Open <http://127.0.0.1:5174/sandbox/stage-review.html>. Node users can run
`npx --yes bun@1.3.6 install --frozen-lockfile` and `npm run dev -- --host
127.0.0.1 --port 5174 --strictPort` instead.

## Try the workflow

1. Choose a task, episode, and prediction version. **Routing · manual** opens
   a dataset without legacy predictions to try annotation from scratch.
2. Play or scrub the synchronized cameras. Use **−1 frame / +1 frame**,
   slower playback, or **Enlarge** on the camera with the clearest evidence.
   Recorded stages appear as **S1, S2, …** on the progress bar. Click a marker
   to pause, seek, and edit it; hover for the full stage name, time, and attempt.
   The current recorded stage is filled teal, the selected mark is outlined,
   and nearby labels stagger into separate rows. Markers update after edits
   and remain visible during playback; unrecorded stages are not invented.
3. Directly below the video scrubber, choose the **Stage reached** and click
   **Mark S… here** to pause and capture the
   current frame. **Move S… to this frame** corrects an existing mark instead
   of adding a duplicate. The suggested stage follows recorded progress, not
   live video recognition; select another stage to skip an unobserved rung.
   Expand **What counts as this stage?** for its description and entry criteria.
4. Click a named stage below the video to seek and adjust its time, change its
   stage, or remove it. **Next stage** returns to marking the next milestone.
   **Undo last edit** restores the exact previous label. No action or failure
   editor is shown for the structured trajectory tasks.
5. In the separate **Episode review** panel, choose **Success** or **Failure**
   and select **How did the episode end?** The task-specific end states use
   readable names and show the selected state's definition.
   Selecting **Success** narrows the menu to the task's successful end states,
   including supported cutoff endings. A conflicting existing value remains
   visible and flagged until explicitly corrected; filtering never changes labels.
   Failed or undecided results keep all end states available. **Watch ending**
   jumps to the last policy frame, before reset footage; **What counts as
   success?** explains the task's criteria. If undecided, select **Not sure yet**
   and save as uncertain. These edits do not auto-fill stages or hidden fields.
   Also check **Furthest stage reached in the episode**. New marks advance it if
   needed; a later failure does not erase earlier progress. S0 needs no time.
   **Retries and timeline settings** lets you start or select another attempt
   and explicitly reorder stage records after a time correction.
6. Add optional review notes, **Save draft**, or **Confirm review & next**.
   Confirmation checks stages/times, the binary task result, and end state;
   hidden pipeline fields
   remain untouched and are not human-verified. **Export local saves**
   downloads your trial review history (Convex JSON encoding, including int64).

Existing source timestamps retain their original precision until explicitly
edited. Time-sorted display does not reorder the source arrays. The checklist
still blocks invalid stage confirmations. Previous-stage references are derived
from the visible sequence after explicit edits; no intermediate stages or
actions are invented. This does not change the model prediction schema.

## Review scope and rollout

Structured task reviews now use `review_protocol: stages-outcome-v1`. Completed
`review_coverage.reviewed_fields` covers the furthest stage, attempt count, and
stage transitions, plus `task_success` and `final_state` (the lossless review
projection of canonical `final_state_id`). Actions, failure modes/times,
source prose and confidence are retained but excluded. Drafts and uncertain
reviews have no completed coverage. Existing `stages-v1`, `structured-v1` and historical
reviews retain their previous semantics; nothing is migrated in place.

The new validator checks stage identities, attempts, ordering, maximum stage,
policy-time bounds, a boolean result, and a declared end state. It checks the
reviewed result against the task-defined successful stages/end states, including
the task's cutoff-success states, without consulting hidden action/failure fields.
Later failures may retain a previously reached completed stage. Unresolved
judgments can be saved as drafts/uncertain, not confirmed. The separate dataset
outcome-review records are not overwritten by this review.
It does not require a model action to agree with a human correction.
A scoped saved row is **not** a
fully validated model response. Consumers must honor coverage; the existing
full-summary benchmark excludes these rows rather than scoring unreviewed
failure fields as gold. A coverage-aware partial benchmark is future work.

The local playground needs no backend deployment. Before deploying the shared
frontend, the backend must support the additive `stages-outcome-v1` protocol and its
coverage validator. Follow the repo's documented single-deployment procedure;
do not run `convex deploy`. This PR does not deploy the shared backend or UI.
Legacy non-trajectory taxonomies retain their existing editor and protocol.

## Safety and scope

- Only `/sandbox/stage-review.html` is the isolated playground. The normal
  app at `/` retains its usual authenticated shared-write behavior.
- The sandbox reads public queries from `grandiose-rook-292` and videos from
  Hugging Face. It needs network access and Chrome/Edge for verified frame marks.
- Its injected data source intercepts `stageReviews:save` into localStorage
  and rejects every other mutation. It never calls a remote mutation or reads
  shared stage-review drafts. Outcome metadata remains read-only.
- Trial saves live under `policy-arena-stage-playground-v1`, scoped to this
  browser and exact origin. Export before clearing site data. They are not
  uploaded, synced, backed up, or suitable as a shared labeling database.
- The HTML entry is dev-only, excluded from the production Vite build. Local
  exports include the same scoped coverage metadata as the new backend.

## Checks

The 2026-09-22 cross-task smoke check used the real episode 0 from each
playground link, in the in-app browser:

| Setup | Stage ladder | Checked in the live playground |
| --- | --- | --- |
| Routing R8 predictions | S0–S10 | Three cameras, stage seek, frame step, capture/retime, undo, local draft save |
| Marker R5 predictions | S0–S7 | Two cameras, second-attempt timestamp correction, undo, local draft save |
| Square nut R5 predictions | S0–S7 | Two cameras, stage seek, frame step, capture/retime, undo, local draft save |
| Routing manual / no predictions | S0–S10 | Three cameras, validated policy duration, new mark, undo to empty timeline, draft save and reload |

Smoke-test edits were undone before saving. Four browser-local drafts have
explicit UI-test notes; they are not accuracy judgments or shared reviews.
No shared mutations, model calls, or deployments were performed.

Automated regressions additionally cover every stage through each task's
maximum (including Routing S8–S10), precise timestamp save/reload, source-free
duration gating, outcome/end-state editing and persistence, and backend confirmation
with explicit scoped coverage. Older stage-only coverage is retained and tested. Both
Marker v3 and v4 are covered alongside Square v3 and Routing v1. These checks
verify editing and persistence, not the accuracy of the model predictions.

```sh
bun test
bun run lint
bun run build
bun x tsc --project tsconfig.sandbox.json --noEmit
```
