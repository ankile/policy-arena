# Prediction history rollout: 2026-09-05

Implemented and deployed commit `fb7983878b91c0185ea71e808d66035133deb8c6`.
The campaign predictions were not imported and no defaults were activated.
All six new prediction tables were empty after deployment.

## Validation

- 317 Bun tests passed, with 11,457 assertions. An independent agent reran the
  suite and reviewed prediction attribution, copied-review duration, blind
  provenance, and the global navigation guard.
- 39 Python client/snapshot-audit tests passed.
- The local HTTP roundtrip passed with 102 synthetic predictions in two runs,
  30 queries, and 20 mutations. It exercised the real machine HTTP router and
  mutation/query handlers in `convex-test`, including retries, conflicts,
  publication, selection, rollback, and preserved legacy/review sources.
  Its query transport uses the Convex JSON HTTP format; it does not exercise
  the Python SDK's WebSocket transport or hosted mutation runtime.
- TypeScript, ESLint, and the production build passed. The build reports a
  JavaScript chunk above 500 kB; bundle splitting was outside this change.
- SIR's publisher/backfill tests passed (24 tests) using the updated submodule
  through its normal uv environment; scoped Ruff checks passed.
- The actual StageReview component was inspected in local Chrome with a
  synthetic I/O adapter. Version A showed stage 3 with a 12-second bound;
  version B showed stage 7 with a 20-second bound. A browser interaction
  switched A to B, explicitly unblinded, and expanded the canonical response
  and provenance. The fixture recorded zero saves. These fixtures omit media.

## Deployment and live integrity

The backend deployed to `grandiose-rook-292` using
`bunx convex dev --once --typecheck enable --tail-logs disable`.
The live Python client query for the user-supplied Routing R8 dataset returned
an empty version list, null active run, and zero legacy predictions, matching
the pre-import state. This read used the client's default SDK transport.

The local Vercel CLI deployment returned `Not authorized`. The repository's
existing GitHub/Vercel integration deployed the same commit successfully:
[production deployment](https://policy-arena-a7xclad2r-ankiles-projects.vercel.app),
GitHub deployment ID `6285661751`.
The custom domain serves `index-DHhoWgRh.js`; its SHA-256 matches the local
tested bundle: `5abcbc219c3b212ba73a90812a4592b94f59ea270a512e0f735ca214890674c1`.

Read-only Convex exports were captured before and after rollout. The
[committed comparison report](audits/2026-09-05-prediction-history.json)
passes for every protected table: no added, removed, or changed records.
The auditor explicitly excludes authentication/profile, heartbeat, and export
metadata tables. It checks all six new prediction tables remain empty.

| Protected table | Before | After |
| --- | ---: | ---: |
| Legacy stage predictions | 4,325 | 4,325 |
| Stage review records | 618 | 618 |
| Stage taxonomy records | 5 | 5 |
| Outcome reviews | 369 | 369 |
| Apply jobs | 23 | 23 |
| Registered datasets | 361 | 361 |

Other compared tables include policies, evaluation sessions, round results,
operators, task specs, and lifecycle statuses. Counts alone were not the gate:
the script compared every stored row ID and canonicalized row content.

The exports are available through the deployment's
[Convex snapshot dashboard](https://dashboard.convex.dev/d/grandiose-rook-292/settings/snapshots).
The local ZIPs were kept in restricted temporary storage and were not committed.

| Export | Snapshot timestamp | ZIP SHA-256 |
| --- | --- | --- |
| Before | `1788640807139239497` | `7294619cf0692825e27fd60f1d0b2c8f179b85fff666f6720628a43c21b978ba` |
| After | `1788641614261369255` | `b63c740b2f0c46bbad42e0b30ff6b8b397a76ca5c0ea5ea6cbedb945bc51b2d3` |

The deployed anonymous browser view was visually inspected and correctly
requires an editor account for stage review. The shared signed-in browser's
inspection commands timed out during final acceptance. Consequently, signed-in
live form rendering and camera playback remain unverified after deployment.
No live review save, prediction mutation, or Hugging Face apply was performed.

## Next phase

Follow [the import and independent annotation preparations](stage-prediction-versions.md#preparing-the-campaign-import-and-direct-pipeline-integration).
Resolve the generic campaign's taxonomy mapping, preserve original attempts and
reruns, and audit complete dataset coverage before importing predictions. The
independent annotation workflow and held-out scoring have not been started.
