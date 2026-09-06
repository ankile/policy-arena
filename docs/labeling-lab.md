# Labeling Lab

Implementation date: 2026-09-06 UTC.

The `?tab=labeling` tab adds Python-derived prompt/settings versions, links to
the existing trajectory review UI, frozen gold snapshots, and summary-field
scoring. Its initial dataset is
`ankile/real01b-routing-d1-r8-bigdp-vs-deployed-testing-heldout-sobol50`.
The initial Routing preset was exported from SIR revision
`0f50745e45454ad5174548a0d6763e22989ed13d`. Its task definition was compared
with the live registered schema before registration. It uses the actual
`CampaignRunConfig` defaults, including `gemini-3.7-flash`; older hosting
notes referring to `gemini-3.5-flash` do not describe this preset.

## Available controls

Readers can inspect configurations and open prediction review links. Only
allowlisted Hugging Face editors can save new config versions, freeze a
benchmark, score a published run, submit a job, or request cancellation.
The existing OAuth subject allowlist is enforced in backend handlers.
Configuration edits never replace an earlier version. A prompt edit must
preserve its embedded task definition. New task schemas and allowed models
must come from an internal Python preset registration.

Presets are exported with SIR's `sir.tools.export_labeling_lab_preset`.
The output is JSON arguments to the internal `labelingLab:registerPreset`
mutation. This does not enable jobs. Do not put credentials in that JSON.

The registered dataset revision is copied into a job request. Duplicate
submission keys return the same job only for the same input. Admission caps
are 50 episodes, 5 attempts per episode, 32768 output tokens per call, and
one active job globally. These are count limits, not a verified dollar cap.
The fixed Cloud Run destination and dispatcher credential are server-only.

## Scoring contract and limits

Freeze uses all eligible reviews attributed to the chosen published baseline
within that dataset. It first folds every status by stable reviewer identity.
A later draft, uncertain review, or cleared review excludes the episode.
Multiple reviewers require adjudication and are excluded. Other-baseline
reviews are also recorded as excluded. Each included row pins its review ID,
prediction ID, media revision, schema, duration, and canonical human label.
Snapshots have a content digest; later edits do not change them.

The first scorer requires candidate coverage of every snapshot episode, with
matching media and schema. It reports maximum-stage, final-state, primary
failure, and attempt-count exact agreements with denominators, plus stage
MAE. It stores success agreement separately as an outcome-conditioned
consistency measure. These prediction-assisted labels become development
data when used to tune a prompt. This is not an independent held-out result.

Event matching/timing scores, confidence intervals, an agreed improvement
criterion, and the promotion mutation are unfinished. Every current score
has `promotion_eligible: false`. No Labeling Lab action selects predictions,
rewrites human reviews, or changes Hugging Face data.

## Worker integration remains disabled

Cloud Run has not been provisioned by this rollout. Read-only GCP project
access with the locally configured `soe-iris-gcp` account failed with
`UNAUTHENTICATED` / `ACCESS_TOKEN_TYPE_UNSUPPORTED`. A read-only Gemini model
lookup succeeded through the existing Developer API credential; no inference
call, paid canary, billing check, or quota measurement was performed.

The backend contains the dispatch and claim/heartbeat foundation, but there
is no hosted Python adapter or machine HTTP route for these worker handlers
yet. The server-only bridge token must never be installed on the worker.
Before execution can be enabled, finish and verify:

1. The project, billing, region, service identities, fixed container image,
   and Secret Manager bindings. The dispatcher uses an environment override
   for the durable request ID, so its job-specific IAM role needs
   `run.jobs.runWithOverrides` as well as `run.jobs.run`.
2. A dedicated labeling machine scope and authenticated HTTP routes. Do not
   grant a labeling worker the existing broad ingest key: ingest currently
   includes prediction activation. Publication must reuse the existing
   immutable publisher with job/config/episode checks and no activation right.
3. A Python adapter to the existing pinned-media materializer and
   `run_campaign`, including the complete frozen media/outcome/retry contract,
   per-call durable admission counters, cancellation, progress, and terminal
   publication receipts.
4. Private S3 checkpoints before subsequent provider calls, verified recovery
   in a fresh container, and delivery-only retries. The current lease API
   rejects takeover and expired leases; it does not implement recovery.
5. Local transport/fake-provider tests followed by an isolated cloud canary,
   resource measurements, and inspection of the resulting videos and labels.
6. An agreed gold scoring and editor-promotion contract, with its enforcement
   on the worker publication/activation path.

Leave `LABELING_ENABLED` absent or `0` until those requirements pass. The UI
also checks `LABELING_CLOUD_RUN_JOB`, `LABELING_DISPATCHER_JSON`, and
`LABELING_CANARY_RECEIPT`. Those are operator configuration gates, not a
substitute for the canary or the unfinished integration. Do not set them just
to make the Run button available. A lost invocation response is recorded as
ambiguous and never triggers an automatic redispatch.

The additive backend is deployed to `grandiose-rook-292`, which owns live
Arena data despite its development designation. Use `npx convex dev --once`,
never `npx convex deploy`. Preview frontend builds currently point to that
same live backend; use in-memory `convex-test` for mutation tests.

## Validation

The final full Arena suite passed 411 tests after incorporating the latest
round-number and successful-round step-summary changes. The new tests cover anonymous
and non-editor denial, immutable configuration saves, model/episode limits,
disabled dispatch, worker identity/fence/expiry checks, cancellation, latest
review folding, frozen snapshot attribution, score idempotency, and rejected
media mismatches. TypeScript, the Vite build, and ESLint passed. Desktop and
390-pixel mobile renders were inspected with a clean guest browser. The
guest prompt was read-only, Run was disabled, and no browser exception or
horizontal overflow was observed. Authenticated UI interaction and cloud
execution have not been browser-tested.

The UI was deployed and inspected at
[policy-eval.ankile.com/?tab=labeling](https://policy-eval.ankile.com/?tab=labeling)
on 2026-09-06 UTC, from Arena commit `189849f`. Vercel deployment ID:
`dpl_8QH2WV7uaEnBp4ACKrXeMW1g33F7`. The live Routing configuration is
`nh742wtjjwf7b133p1cvqmr3ss8dx9xg`. Live unauthenticated attempts to save a
configuration and submit a job both returned `Not signed in`. The live
availability query reported `enabled: false`. The deployed task inspector
rendered all 11 Routing stages. The existing Gemini key was absent from the
built frontend asset bytes. The only successful live data mutation performed
by this rollout was registering the new labeling preset.

Official API references: [Cloud Run job execution](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/run),
[service-account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account),
[Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key).
