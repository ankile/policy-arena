# Stage labeling sandbox

This branch preserves the stage UI from `247ff91845480253bffe6ea7c365c0deef32d18c`
and adds anonymous review for collaborator testing. The untouched historical
branch is `stage-ui-before-labeling-pipeline`.

## Isolation

The sandbox uses a separate Convex project, `policy-arena-stage-sandbox`, with
deployment `watchful-swordfish-385`. Its API URL is
`https://watchful-swordfish-385.convex.cloud`.

The user's explicit request for an isolated database on 2026-09-21 overrides
the single-deployment rule in CLAUDE.md for this branch. Never deploy this
branch to `grandiose-rook-292`. `ARENA_REVIEW_SANDBOX=1` enables anonymous
review only when Convex's built-in `CONVEX_CLOUD_URL` matches the sandbox URL.
The browser's content security policy also allows only the sandbox Convex host.

Each browser receives a distinct anonymous Convex Auth account automatically.
The session survives reloads. Clearing browser storage or using another browser
creates another reviewer. Only outcome and stage review saves accept anonymous
reviewers. Administrative mutations retain the existing HF allowlist gate.
Hugging Face publishing is explicitly rejected in the sandbox, the commit
panel explains that reviews stay in the test database, and no HF token or live
machine credentials are installed. The sandbox has its own JWT signing keys.

## Copied data

The source was a read-only export from `grandiose-rook-292` on 2026-09-22 UTC,
snapshot timestamp `1790046485495323391`. Its exported records were projected
into the historical schema using `scripts/prepare_sandbox_snapshot.py`.

Copied records:

| Table | Count |
| --- | ---: |
| datasets | 369 |
| evalSessions | 131 |
| operators | 5 |
| outcomeReviews | 1,177 |
| policies | 239 |
| roundResults | 10,362 |
| stagePrefills | 4,325 |
| stageReviews | 618 |
| stageTaskSpecs | 5 |
| taskSpecs | 5 |
| taskStatuses | 13 |

Authentication records, jobs, and worker heartbeats were left empty. The new
trajectory pipeline's tables, four trajectory schemas, and six trajectory
reviews are outside this historical UI's schema and were excluded. Original
stage schemas are marked live in the sandbox. Original reviewer names remain;
their authentication user IDs were removed. Policy tags, methods, and round
fields added after the historical version were omitted, with counts recorded
in the copy report. Unexpected additional schema differences fail the script.

Keep Convex's `generated_schema.jsonl` files when preparing an import. Their
`uniform` encoding preserves integer values; omitting them causes int64 fields
to be imported as floats. Preserve table-number registry entries for empty
auth/job tables as well, or their IDs can collide with application records.

The seed import required `--replace-all` on the newly created sandbox because
schema creation assigned different table numbers. Do not repeat that import
after collaborators begin testing: it clears their sessions and reviews.

## Verification

On 2026-09-22 UTC:

- Build and ESLint passed; all 260 Bun tests passed, including deployment
  guards and anonymous review permission tests.
- A fresh browser acquired an anonymous identity, loaded the original marker
  S0–S7 form and 150 predictions, and played both camera videos.
- Editing episode 0's notes and confirming the label saved a sandbox review.
  Reloading the page preserved the identity and the confirmed edit.
- All 17,249 seeded application records were read back through a sandbox export
  and compared by ID and full document content against the prepared seed.
- A second live export was identical for stage reviews, prefills, schemas,
  outcome reviews, datasets, policies, sessions, and round results.

## Public sandbox

The stable collaborator URL is
[policy-arena-stage-sandbox.vercel.app](https://policy-arena-stage-sandbox.vercel.app/?tab=explorer&dataset=ankile%2Freal01b-md2-r5-repeat-base-dp-filmtiidk4-c200k-n32-s2026070704&view=stage).
It belongs to the separate Vercel project `policy-arena-stage-sandbox`, project ID
`prj_27hHLlG1b17o3fk67O1zKwPTPGNw`, under `ankiles-projects`. Deployment
`dpl_9iJx6FtEiVGJx3UZtoANqKGJwhiV` was published on 2026-09-22 UTC after owner
Vercel authorization. This replaces the one-hour temporary preview.

The canonical URL responds without a Vercel login gate. A fresh browser
received an anonymous reviewer identity, loaded both camera videos and the
original form, saved a confirmed edit, and recovered it after reloading.
The CSP permits only the sandbox backend. Vercel's `VITE_CONVEX_URL` is pinned
to the sandbox in Production, Preview, and Development environments.

Future frontend deployments must target the separate project explicitly:

```bash
bunx vercel deploy --project policy-arena-stage-sandbox --prod --yes
```

Here `--prod` means the sandbox project's stable frontend URL. It does not
refer to the main Policy Arena project or deploy any Convex backend code.

## Development

Use an ignored `.env.local` with `CONVEX_DEPLOYMENT=dev:watchful-swordfish-385`
and `VITE_CONVEX_URL=https://watchful-swordfish-385.convex.cloud`.
Run `bun run dev` for the frontend. `bunx convex dev --once` must announce the
isolated deployment before pushing any backend changes. Set sandbox secrets
only through the Convex environment CLI with an explicit
`--deployment watchful-swordfish-385` target.
