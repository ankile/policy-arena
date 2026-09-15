# Policy tags

Policies have an optional training `round`, an optional `method`, and a list of
custom `tags`. Round 0 is valid. Empty fields remove a classification. Method
names are editable text, with suggestions from existing policies and the three
main method families. Tags are trimmed and deduplicated on save.

The leaderboard displays tags under each policy and supports combined round,
method, and custom-tag filters. Filters are stored in the URL. They select rows
without refitting ratings or changing the Mainline/All evaluation lens. The
comparison count continues to describe that lens and task selection.

Choose **Sort by → Round, then method** to order rounds numerically from Round 0
up, then methods alphabetically within each round. Unassigned values sort last;
policy names break ties. The sort choice is saved in the URL as `sort=roundMethod`.

Sign in as an editor, expand a policy, and choose **Edit tags**. The public read
API includes tags in `policies:get` and `policies:leaderboard`.
`policies:tagOptions` returns existing rounds, methods, and custom tags.
The machine API exposes `policies/setTags` with the `curate` scope. Python:

```python
arena.set_policy_tags(
    model_id,
    round=2,
    method="HG-DAgger mulligan",
    tags=["UMI relative"],
)
```

This replaces all three classification fields. Policy registration and eval
ingestion preserve existing tags.

## Initial classification, 2026-09-15

The [reviewed manifest](policy-tags-2026-09-15.json) records 83 mainline
policies across Marker D2, Square D2, and Routing D1, including their exact model
identities and classification evidence. Eleven entries from the initial 94-policy
snapshot moved to Testing or Ablation during preparation and were omitted before
applying the tags. Round means the policy's training round, not the round of an
evaluation in which it appeared.

Method names follow the SIR paper's arm mapping, using the requested wording.
Round 0 method labels identify campaign lineage; their additional `R0
demonstrations` tag identifies the initial demonstration-only data. No-CF and
pooled-correction variants use distinct method names. Lifecycle statuses are
preserved.

Review or reapply the manifest with:

```sh
bun scripts/backfill_policy_tags.ts docs/policy-tags-2026-09-15.json
bun scripts/backfill_policy_tags.ts docs/policy-tags-2026-09-15.json --apply
```

The backfill checks identities and statuses, rejects conflicting existing tags,
skips already-matching entries, and verifies saved values by reading them back.
It does not automatically classify future registrations.

## Routing D2 migration, 2026-09-15

The 15 UMI-relative routing policies now belong to mainline `routing_d2`.
Their round tags map original lineage rounds 0/2/4/6/8/9 to paper rounds
0/1/2/3/4/5. The R0 baseline inherits Mainline instead of its former Testing
override. `routing_d1` is Retired with `superseded_by: routing_d2`.

The [migration record](routing-d2-migration-2026-09-15.json) preserves the
original policy metadata, mapping, and evaluation-results hash. Policy names,
model IDs, evaluation results, and source dataset task metadata retain their
original identifiers. The initial classification manifest above is historical;
its Routing D1 entries predate this migration and must not be reapplied.
