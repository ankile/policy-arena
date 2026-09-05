# Trajectory review rollout

Last updated: 2026-09-05.

Commit `8443761cd7cfa55a538770991d5aef2710ae9366` adds the generic trajectory
review form and lossless validation adapter. Backend and frontend deployment
completed on 2026-09-05. Campaign predictions have not been uploaded or selected.
The import is waiting for eleven final Marker source archives containing 24
predictions to be recovered from the producing Mac.

## Verification

The final suite passed 398 tests with 11,808 assertions. Full ESLint, production
build, and Convex TypeScript checks passed. The local machine HTTP roundtrip
passed with 102 legacy-format versioned predictions and eleven generic
trajectory predictions across the four actual review schemas. It checked exact
retry, immutable history, canonical conversion, human edits, and source-free
annotations. An independent agent audited timestamp navigation guards, Clear
recovery, source attribution, and policy-duration bounds.

The actual review component was visually inspected with a local archived
Marker fixture. Summary decisions, six transitions, repeated action occurrences,
evidence, and version controls remained accessible in the bounded form. The
fixture recorded no writes while browsing and one draft on a version change,
preserving the original version's source. These fixture writes were local.

## Deployment and preservation

The backend deployed to `grandiose-rook-292` using
`bunx convex dev --once --typecheck enable --tail-logs disable`.
GitHub's Vercel integration deployed the same commit successfully, deployment
ID `6286653114`:
[production deployment](https://policy-arena-lc2fxfl33-ankiles-projects.vercel.app).

The custom domain's served assets matched the tested local build byte for byte:

| Asset | SHA-256 |
| --- | --- |
| `index-B8Ax1uUT.js` | `5207d242cb6cb0acfbfe0ab7fbea171103e64610a85d91d34355d8caf3f664b9` |
| `index-CTrne7-9.css` | `601fe17aaba1e1e08d68ab2e2ca5ee016d4497ee5bd49f9f0edd0cffe902f232` |

The [snapshot comparison](audits/2026-09-05-trajectory-review-rollout.json)
verified every protected row's identity and contents unchanged. Authentication,
profile, heartbeat, and export metadata tables are explicitly excluded. All six
versioned prediction tables remained empty. Counts remained 4,325 legacy stage
predictions, 618 stage reviews, five stage task specs, 369 outcome reviews, 23
apply jobs, and 361 registered datasets.

Before and after exports have snapshot timestamps `1788648024946559995` and
`1788648163000570902`. Both ZIPs have SHA-256
`98efbb9eafd386fa9fc4925475475c28d9a7b34c852bba74174847c17f701eaa`.
The ZIPs remain in restricted local storage; the export snapshots are available
through the Convex dashboard.

The signed-in live Routing page was inspected without editing a review. The
editor account, legacy prediction selector, and three loaded camera streams
were present. Generic prediction review on the live site still requires the
campaign import and its separate acceptance check. No live review save or
Hugging Face apply was performed during this rollout.
