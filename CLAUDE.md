# Policy Arena

A leaderboard web app for comparing robot policies via Bradley-Terry ratings fit from head-to-head evaluations.

## Ratings (Bradley-Terry, since 2026-08-20)

Ratings are **fit on read, never stored**. `convex/bradleyTerry.ts` (pure,
shared by frontend and Convex functions) fits a Bradley-Terry model by
minorization-maximization over the SET of pairwise round outcomes — order-
independent and deterministic, displayed as `1500 + 400·log10(p)` with the
view's mean at 1500. Draws count half a win each; a small pseudo-game prior
keeps all-win policies finite.

- `ratings:sessionOutcomes` returns compact per-session pair outcomes +
  per-policy success aggregates; the frontend filters by the current lens
  (mainline/all) and fits live (`src/lib/arenaRatings.ts`) — ratings, W/D/L,
  success rates, and the PolicyDetail rating trajectory are always
  self-consistent with the visible session set.
- `recommendations:getOpponents` runs the same fit server-side over
  effectively-mainline sessions (the `elo` response key is kept for Python
  API compatibility).
- There is NO stored elo/wins/losses/draws and NO eloHistory table anymore;
  submit/delete/removePolicy do plain writes with no replay. Unit tests:
  `src/lib/bradleyTerry.test.ts`.

## CRITICAL: Convex Deployment

**We use a SINGLE Convex deployment for everything: `grandiose-rook-292` (dev).**

- All data (policies, eval sessions, ELO history, datasets) lives here
- The Vercel production site (policy-eval.ankile.com) points here
- Local development points here
- Python scripts should use this URL: `https://grandiose-rook-292.convex.cloud`

**NEVER use `npx convex deploy`** — that pushes to the prod deployment (`ideal-pig-506`) which we do NOT use.

Instead, to push schema/function changes:
```bash
npx convex dev --once    # pushes to dev (grandiose-rook-292) once, no watcher
```

After pushing Convex changes, redeploy the frontend:
```bash
npx vercel --prod
```

## Outcome-review apply (NATIVE since 2026-08-21)

Web-captured outcome reviews are applied to HuggingFace by a **scheduled
Convex action** — `applyJobs:enqueue` runs `ctx.scheduler.runAfter(0,
internal.applyWorker.run)`; there is NO polling worker anymore.

- `convex/apply/` is a value-parity TS port of the Python
  `sir/tools/outcome_editor.headless_apply_and_push` path (parquet rewrite of
  success/reward/done/is_valid via parquet-wasm + apache-arrow, LeRobot
  RunningQuantileStats refresh of per-episode meta cells + meta/stats.json,
  ledger repair, results.json canonicalization + eval-time backup,
  progress-record merge, label-history append). One ATOMIC HF commit pinned
  on the pre-apply sha (`parentCommit` — a concurrent push fails the job
  loudly), then the v3.0 tag advances.
- Parity gate: `experiments/2026-08-21/01_ts_apply_parity_harness.py` in the
  sir repo runs both implementations on the same snapshot and value-compares
  every file. It passed on routing_d1 (subtask marks), marker_d2 collection
  (ledgers), and marker_d2 + insert_marker_d1 evals (results.json) before
  cutover. Re-run it after touching `convex/apply/` or the Python editor.
- Node-runtime deps (`parquet-wasm`, `apache-arrow`, `@huggingface/hub`) are
  `externalPackages` in `convex.json`; `convex/apply/{hf,parquetIO,pipeline}`
  carry `"use node"` and must never be imported from default-runtime
  functions. Pure-logic modules (progress/stats/results/ledgers/labelHistory/
  frames/pyjson) are runtime-neutral.
- Deployment env var **`HF_TOKEN`** (write access to the datasets) is
  required by the action.
- Session sync: `evalSessions:correctOutcomes` patches roundResults
  success/num_frames IN PLACE after each apply (ratings are fit on read, so
  this fully replaces the legacy delete-and-resubmit
  `sir/tools/arena_resubmit.py` replay).
- Rollback: set `APPLY_NATIVE=0` on the deployment (enqueue stops scheduling)
  and start the deprecated Python `sir.tools.arena_review_worker` poller —
  claims are atomic, so the two paths cannot double-apply.
- Offline runner for debugging: `bun scripts/apply_local.ts <snapshot_dir>
  <config.json> <out_dir>` runs the pipeline on a local snapshot, no network.

## Eval-session operators (added 2026-08-21)

`evalSessions.operator` records WHO physically ran the eval, as an **HF
username** validated against the `operators` table (`operators:list/add`,
internal `operators:seed`). Stored as a username (not a users id) so
operators can be recorded before they ever sign in; once they authenticate
via HF OAuth, `users.username` joins the string to their account. Registered:
`ankile`, `rtbhowmik` (rtbhowmik's OIDC sub `669ecd73eab5069c62b91d17` is
already in `ARENA_EDITOR_SUBS`). All 124 pre-existing sessions were
backfilled to `ankile` on 2026-08-21 (`evalSessions:backfillDefaultOperator`);
correct non-ankile ones by hand via the editor select in Eval Sessions or
`client.set_session_operator`. `submit_eval_session(..., operator=...)` sets
it at submit time — new eval tooling SHOULD pass it.

## Authentication (added 2026-08-18)

Reads (queries) are public. **Every mutation is auth-gated** via
`convex/access.ts` with two principals:

- **Humans:** "Sign in with Hugging Face" (OAuth via `@convex-dev/auth`,
  provider in `convex/auth.ts`). Only HF accounts whose OIDC `sub` (the
  stable account id, NOT the mutable username) appears in the
  `ARENA_EDITOR_SUBS` deployment env var (comma-separated) may write.
  Find a user's sub at https://huggingface.co/api/users/<name>/overview
  (`_id`) or in the `authAccounts` table after their first sign-in.
- **Robot pipeline:** a `serviceToken` mutation argument matched against the
  `ARENA_SERVICE_TOKEN` deployment env var. The Python client
  (`python/policy_arena/client.py`) attaches it automatically from
  `POLICY_ARENA_TOKEN` or `~/.config/sir/policy_arena_token`.

Required deployment env vars (`npx convex env set NAME value`):
`SITE_URL` (https://policy-eval.ankile.com), `AUTH_HUGGINGFACE_ID` /
`AUTH_HUGGINGFACE_SECRET` (HF OAuth app; callback URL
`https://grandiose-rook-292.convex.site/api/auth/callback/huggingface`,
scopes `openid profile`), `JWT_PRIVATE_KEY` + `JWKS` (generated by
`npx @convex-dev/auth` setup), `ARENA_SERVICE_TOKEN`, `ARENA_EDITOR_SUBS`.

`seed:clearAll` is an `internalMutation` — reachable only via
`npx convex run` with deploy credentials, never from the public API.
DataExplorer's stats write-back fires only for signed-in allowlisted editors.

## Tech Stack

- React + TypeScript + Convex (backend)
- Vite (build tool)
- Tailwind CSS v4 (via `@tailwindcss/vite` plugin)
- Bun (package manager / runtime)
- Vercel (frontend hosting)

## Project Structure

### Frontend (`src/`)

- `App.tsx` — Main app with 4 tabs: Leaderboard, Eval Sessions, Pairings, Data Explorer
- `components/DataExplorer.tsx` — Browse registered datasets and view episodes
- `components/EvalSessions.tsx` — Eval session list and detail views
- `components/Pairings.tsx` — Head-to-head policy pairing comparisons
- `components/EpisodeViewer.tsx` — HuggingFace episode video viewer
- `components/PolicyDetail.tsx` — Expanded policy info and ELO history
- `components/RolloutSection.tsx` — Rollout display within eval sessions
- `components/RoundVideos.tsx` — Video display for evaluation rounds
- `lib/hf-api.ts` — HuggingFace Datasets API client

### Convex Backend (`convex/`)

- `schema.ts` — Database schema (policies, evalSessions, roundResults, datasets, taskStatuses)
- `statusShared.ts` / `statuses.ts` — Lifecycle statuses (see below)
- `bradleyTerry.ts` / `ratings.ts` — Rating model + per-session outcome query (see Ratings above)
- `evalSessions.ts` — Eval session submission
- `policies.ts` — Policy CRUD operations
- `recommendations.ts` — Opponent recommendation logic
- `pairings.ts` — Policy pairing queries
- `roundResults.ts` — Round result queries
- `datasets.ts` — Dataset register mutation and list query

### Python Client (`python/policy_arena/`)

- `client.py` — Main client for submitting eval results, managing eval/rollout sessions, getting opponent recommendations, and registering datasets
- `types.py` — Shared type definitions
- `get_datasets.py` — Dataset listing utility

### Scripts (`scripts/`)

- `backfill_datasets.py` — Register existing datasets
- `backfill_rollout_sessions.py` — Backfill rollout session data
- `backfill_pi05_rollout_sessions.py` — Backfill Pi0.5 rollout sessions
- `backfill_stats.py` — Backfill computed statistics

## Lifecycle Statuses (added 2026-08-20)

Every task line, policy, eval session, and dataset has a lifecycle status:
`mainline | retired | ablation | testing`. Resolution is
**per-entity override ?? task-level status ?? mainline**
(`convex/statusShared.ts`; task rows live in the `taskStatuses` table because
`taskSpecs`/`stageTaskSpecs` are `db.replace`d by the Python exporters).

- The UI defaults to a **Mainline** lens (`?show=all` reveals everything);
  the header toggle applies to Leaderboard, Sessions, Pairings, and the
  Data Explorer list. Editors get a "Task statuses" manager panel plus
  per-entity override selects on detail views.
- `recommendations:getOpponents` / `getPairCounts` only return effectively
  mainline policies — the eval planner never proposes retired ones.
- Python: `set_task_status` / `set_policy_status` / `set_session_status` /
  `set_dataset_status` on the client; `submit_eval_session(..., status=...)`
  tags an ablation/testing session at submit time.
- `statuses:seedDefaults` (internal, idempotent) seeds a row per observed task
  string; it ran 2026-08-20 (mainline = marker_d2, square_d2, routing_d1) and
  also migrated the legacy `evalSessions.excluded` flag into `status`.

## Design

- Light theme with warm cream background, white card surfaces
- Fonts: DM Serif Display (headings), DM Sans (body), JetBrains Mono (numbers)
- Custom color palette defined in `@theme` block in `index.css`

## Commands

- `bun run dev` — Start dev server
- `bun run build` — Production build
- `bun run lint` — ESLint
- `npx convex dev` — Start Convex dev watcher (hot-reload functions)
- `npx convex dev --once` — Push Convex changes once (use this instead of `npx convex deploy`)
- `npx vercel --prod` — Deploy frontend to Vercel
