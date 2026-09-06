# Compact trajectory review

Verified on 2026-09-06 UTC. Frontend source commits `1ee4b12` and `41e50a1`.

The trajectory form now uses stage buttons, the selected stage definition,
readable choices and compact action/time rows. Repeated occurrences and event
editing remain available in expandable sections. The reviewer uses the available
screen width, with video beside the form on wide screens and a persistent
verdict bar. It has no nested form scroll box. Prediction hashes and saved-label
attribution are in expandable provenance details.

Storage and validation contracts are unchanged. A full confirmation still
covers the summary and event history. Collapsed editors remain mounted, keeping
unfinished timestamp text and navigation guards. Add/remove/reorder controls are
disabled until unfinished timestamps are repaired. Space activates focused
buttons and section summaries; outside controls it retains video playback.
Blind validation uses allowlisted messages, never arbitrary payload keys or
unknown values. No backend deployment or human-review write was performed.

Human labels are reusable across prediction versions with compatible episode
sources and definitions. Original prediction attribution is audit provenance.
The SIR document `docs/policy-arena-gold-reuse-and-review.md` records the legacy
schema comparison, M01's checked v3/v4 projection and remaining benchmark-freeze
and cross-schema scoring limitations. This UI change does not migrate gold.

## Verification

- Final integrated suite: `bun test`, 436 passed, 0 failed, 12,016 assertions.
- `bun run lint` and `bun run build` passed. Build retains the bundle-size advisory.
- Independent agent reviewed save preservation, blinding and pending-input
  handling, and supplied adversarial validation-message tests.
- Offline browser inspection at 1280/1600 desktop widths and 390px phone width:
  compact controls, expanded event editors, no horizontal page overflow,
  visible verdict controls and zero fixture review writes while browsing.
- Live read-only inspection of Marker M01, Square S01 and Routing R01: all
  camera streams loaded, two each for Marker/Square and three for Routing;
  stage controls and the new form rendered. M01's
  original confirmed review `md7ffz7dspwbvdaat0r159j1qx8dxy6v` remains present
  under its original v3 schema and prediction attribution.

Production deployment `dpl_5ayrXjdxiNwZEf7igWpC9m7cTaSv` is ready at
`https://policy-eval.ankile.com/`. Served asset `/assets/index-RHo5Y9kP.js`
has SHA-256 `234f6b04ee86869609c4e98c1b20db4f57aaf3215bc44b6ac3a263ff102ea631`.
Content checks found the new stage controls, expanded reviewer width and the
intended `grandiose-rook-292` Convex endpoint. The unrelated Labeling Lab work
was retained when integrating with origin/main.
