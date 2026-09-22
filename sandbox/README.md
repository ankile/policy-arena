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
3. Directly below the video scrubber, choose the **Stage reached** and click
   **Mark S… here** to pause and capture the
   current frame. **Move S… to this frame** corrects an existing mark instead
   of adding a duplicate. The suggested stage follows recorded progress, not
   live video recognition; select another stage to skip an unobserved rung.
   Expand **What counts as this stage?** for its description and entry criteria.
4. Click a named stage below the video to seek and adjust its time, change its
   stage, or remove it. **Next stage** returns to marking the next milestone.
   **Undo stage edit** restores the exact previous label. No action or failure
   editor is shown for the structured trajectory tasks.
5. In the separate **Episode review** panel, check **Furthest stage reached in
   the episode**. New marks advance it if
   needed; a later failure does not erase earlier progress. S0 needs no time.
   **Retries and timeline settings** lets you start or select another attempt
   and explicitly reorder stage records after a time correction.
6. Add optional review notes, **Save draft**, or **Confirm stages & next**.
   Confirmation checks only stage judgments and times; hidden pipeline fields
   remain untouched and are not human-verified. **Export local saves**
   downloads your trial review history (Convex JSON encoding, including int64).

Existing source timestamps retain their original precision until explicitly
edited. Time-sorted display does not reorder the source arrays. The checklist
still blocks invalid stage confirmations. Previous-stage references are derived
from the visible sequence after explicit edits; no intermediate stages or
actions are invented. This does not change the model prediction schema.

## Review scope and rollout

Structured task reviews now use `review_protocol: stages-v1`. Completed
`review_coverage.reviewed_fields` covers the furthest stage, attempt count, and
stage transitions only. Actions, failure modes/times, outcome, final state,
source prose and confidence are retained but excluded. Drafts and uncertain
reviews have no completed coverage. Existing `structured-v1` and historical
reviews retain their previous semantics; nothing is migrated in place.

The new validator checks stage identities, attempts, ordering, maximum stage,
and policy-time bounds. It does not require a model action to agree with a
human stage correction. A stage-only saved row is a scoped review, **not** a
fully validated model response. Consumers must honor coverage; the existing
full-summary benchmark excludes these rows rather than scoring unreviewed
outcome/failure fields as gold. A stage-only benchmark is future work.

The local playground needs no backend deployment. Before deploying the shared
frontend, the backend must support the additive `stages-v1` protocol and its
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

```sh
bun test
bun run lint
bun run build
bun x tsc --project tsconfig.sandbox.json --noEmit
```
