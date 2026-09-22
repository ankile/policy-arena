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
3. In **What happens here?**, review the recorded progress at the playhead.
   **Mark S… here** pauses and captures the next milestone in one click. If it
   already has a mark, **Move S… to this frame** corrects that mark instead of
   duplicating it. At most three related actions are offered nearby; completed
   actions drop out. The checked, visible summary option only advances the
   episode's furthest stage; it never lowers it. Uncheck it for an event-only edit.
4. Click a stage on the progress strip or open **All marks** to seek and inspect
   an existing observation in **This moment**. Position the video and use
   **Move to current frame** to correct its timestamp.
   Unresolved conditional action/stage pairs are not silently retimed together;
   choose a shared timestamp explicitly if they describe the same event.
5. Use **Something went wrong** to capture a failure. **Other label / retry**
   offers every stage/action, an attempt override, and **Start another attempt**.
   Starting an attempt records no events. Suggestions follow task-defined
   stage/action links and recorded times, not live video recognition; they do
   not enforce a strict path or invent skipped stages. Stages and actions remain
   independent. **Undo last mark** restores the preceding edit exactly.
6. Open **Episode summary** for endpoint judgments and human notes, or
   **All fields** for the complete editor. Use **Save draft** for partial work,
   or review the full structured label
   before confirming. Reload to verify persistence. **Export local saves**
   downloads your trial review history (Convex JSON encoding, including int64).

Existing source timestamps retain their original precision until explicitly
edited. Time-sorted display does not reorder the source arrays. The checklist
still blocks invalid confirmations; use **Update recorded event order** when
an edit requires chronological array order. This first pass does not add
per-event gold/reviewed status, timeline dragging, or change the prediction schema.

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
- The HTML entry is dev-only, excluded from the production Vite build. No
  Convex/schema deployment is needed for these frontend changes.

## Checks

```sh
bun test
bun run lint
bun run build
bun x tsc --project tsconfig.sandbox.json --noEmit
```
