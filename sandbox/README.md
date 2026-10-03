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

## Hosted playground

Vercel **Preview** deployments include `/sandbox/stage-review.html` alongside
the normal app. Push this branch and use that path on its Vercel preview URL.
Vercel's existing deployment access protection still applies. The normal
production build excludes the playground; no shared backend deployment is needed.

To build it explicitly outside Vercel, run `npm run build:playground` and serve
`dist` as a static site. The preview reads the same public data and retains the
local-only save boundary. Saves are isolated by browser and origin: localhost
annotations do not appear on the hosted URL. Use **Export local saves** to keep
a copy before changing origins; automatic import/sync is not provided.

## Try the workflow

1. Choose a task and episode. The playground always uses the latest bundled
   definition (Marker v6, Square nut v5, Routing v4), without a version selector
   or links to older definitions. Older URLs keep their episode but open the
   latest definition without reusing an incompatible model prediction. Earlier
   saved annotations remain intact under their original definition and in local
   exports; nothing is migrated. Compatible prediction choices appear only when
   model runs are available. Routing's dataset selector
   also offers the UMI-relative dataset for annotation from scratch.
2. Play or scrub the synchronized cameras. Use **−1 frame / +1 frame**,
   slower playback, or **Enlarge** on the camera with the clearest evidence.
   Recorded stages appear as **S1, S2, …** on the progress bar. Click a marker
   to pause, seek, and edit it; hover for the full stage name, time, and attempt.
   The current recorded stage is filled teal, the selected mark is outlined,
   and nearby labels stagger into separate rows. Markers update after edits
   and remain visible during playback; unrecorded stages are not invented.
3. Directly below the video scrubber, choose the **Stage reached** and click
   **Mark S… here** to pause and capture the
   current frame (shortcut **M**). A new mark leaves the editor ready for the
   next unrecorded stage; it does not select or overwrite the previous mark.
   Existing marks require **Inspect S… mark** or a timeline click before
   **Move to current frame** can retime them. The suggestion follows recorded progress, not
   live video recognition; select another stage to skip an unobserved rung.
   Expand **What counts as this stage?** for its description and entry criteria.
4. Click a named stage below the video to seek and adjust its time, change its
   stage, or remove it. **Next stage** returns to marking the next milestone.
   **Undo last edit** restores the exact previous label. No action or detailed
   failure-event editor is shown for the structured trajectory tasks.
5. In the separate **Episode review** panel, **Success** or **Failure** is
   prefilled from the episode's existing human outcome, across task-definition
   versions. Timeout counts as binary failure. This changes only the new review's
   result, not stage progress, end state, failure cause or the original model
   response. Your saved reviews and in-progress edits are preserved. Unknown
   outcomes are not guessed. Check the result and select **How did the episode
   end?** The task-specific end states use
   readable names and show the selected state's definition.
   Selecting **Success** narrows the menu to the task's successful end states,
   including supported cutoff endings. A conflicting existing value remains
   visible and flagged until explicitly corrected; filtering never changes labels.
   Failed or undecided results keep all end states available. **Watch ending**
   jumps to the last policy frame, before reset footage; **What counts as
   success?** explains the task's criteria. If undecided, select **Not sure yet**
   and save as uncertain. For **Failure**, choose **Why did it fail?** from the
   task's primary failure modes and read its definition. Failure requires a
   non-none mode. Success sets the task-defined no-failure mode when saved;
   an undecided result leaves it unset. No stages or hidden event times are filled.
   Also check **Furthest stage reached in the episode**. New marks advance it if
   needed and removals recompute it. It must equal the highest recorded mark;
   a later failure does not erase earlier progress. S0 needs no time.
   **Retries and timeline settings** lets you start or select another attempt
   and explicitly reorder stage records after a time correction.
6. Add optional review notes, **Save draft**, or **Confirm review & next**.
   Confirmation checks stages/times, the binary task result, end state, and primary failure mode;
   hidden pipeline fields
   remain untouched and are not human-verified. **Export local saves**
   downloads your trial review history (Convex JSON encoding, including int64).

Existing source timestamps retain their original precision until explicitly
edited. New marks are inserted chronologically. Existing arrays remain intact
until edited or explicitly sorted. Out-of-order retiming exposes **Order stage
marks by time** next to the marking controls. The checklist blocks invalid stage
confirmations, including global time/attempt order and contradictory outcomes.
Previous-stage references are derived only within the explicitly edited attempt(s);
other retries remain untouched. No intermediate stages or
actions are invented. This does not change the model prediction schema.
Digit and `-`/`=` stage shortcuts are disabled for trajectory tasks; they remain
available in the legacy editor. M ignores typing, modifiers and held-key repeats.

## Review scope and rollout

Structured task reviews now use `review_protocol: stages-outcome-v2`. Completed
`review_coverage.reviewed_fields` covers the furthest stage, attempt count, and
stage transitions, plus `task_success`, `failure_mode` and `final_state` (the lossless review
projection of canonical `final_state_id`). Actions, failure times/secondary events,
source prose and confidence are retained but excluded. Drafts and uncertain
reviews have no completed coverage. Existing `stages-v1`, `stages-outcome-v1`,
`structured-v1` and historical reviews retain their previous semantics; nothing
is migrated in place. The older scoped protocols are retained for existing
playground histories/exports, not emitted by the new UI. In particular, v1 is
not redefined to imply that a reviewer supervised a previously hidden failure mode.

The new validator checks stage identities, attempts, ordering, maximum stage,
policy-time bounds, a boolean result, and a declared end state. It checks the
reviewed result against the task-defined successful stages/end states, including
the task's cutoff-success states, without consulting hidden action/event fields.
Later failures may retain a previously reached completed stage. Unresolved
judgments can be saved as drafts/uncertain, not confirmed. The separate dataset
outcome-review records are not overwritten by this review.
It does not require a model action to agree with a human correction.
A scoped saved row is **not** a
fully validated model response. Consumers must honor coverage; the existing
full-summary benchmark excludes these rows rather than scoring unreviewed
failure fields as gold. A coverage-aware partial benchmark is future work.
Before superseding their own full `structured-v1` review, a reviewer must
acknowledge that the latest row will lose full-summary gold eligibility. The
older row stays in history. The new UI cannot create new full structured gold.
The disagreement query compares jointly reviewed summary fields (including
primary failure mode) and stage transitions, allowing one frame of timing
difference. Rows with unknown historical coverage are returned separately via
`coverage_unknown`, not discarded or presumed to be verified disagreement.
Scoped saves discard stale `event_links`; original prediction events remain intact.

The local playground needs no backend deployment. Before deploying the shared
frontend, the backend must support the additive `stages-outcome-v2` protocol and its
coverage validator. The normal frontend checks the capability returned by
`stageReviews.latestForRepo`; an older backend leaves editing/saving disabled
with a visible explanation rather than trapping an unsavable draft.

Deployment is a separate, coordinated action: from the reviewed branch, push
the compatible backend with `npx convex dev --once` to the shared
`grandiose-rook-292` deployment **before merging this PR**, because Vercel
automatically deploys main. Verify `supported_review_protocols` includes v2,
then merge/deploy the frontend. Never use `convex deploy`. No shared deployment
was performed as part of this fix.

**Rollback hazard:** once a row using a new protocol exists, pushing an older
backend schema that omits its enum may fail schema validation. Keep the additive
protocol/coverage validators on backend rollback; roll back the frontend
independently if needed. Do not delete or relabel saved reviews to force a rollback.
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
- The HTML entry is available in development and preview builds, excluded from
  the normal production Vite build. Local
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

The review follow-up adds sequential M captures, primary failure save/reload,
scope-loss acknowledgment, old-backend read-only behavior, independent retries,
global timeline/maximum validation, disagreement coverage/timing, and 15-fps
policy/reset boundaries at 31, 62, 124 and 248 frames. Removed action-editor
utilities and their obsolete tests are no longer shipped; source-free failure,
fractional-URL and cross-schema save/navigation regressions are retained.

```sh
bun test
bun run lint
bun run build
bun x tsc --project tsconfig.sandbox.json --noEmit
```
