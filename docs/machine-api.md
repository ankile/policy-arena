# Machine API authentication

Policy Arena keeps browser reads public and routes every write through an
authenticated Convex HTTP Action. Convex mutations that change data are
internal functions and cannot be called directly by an anonymous Convex
client.

## Credentials and scopes

A credential has the form `<key-id>.<secret>`. Store the complete credential
only on the machine that uses it. Convex stores a SHA-256 digest in the
`POLICY_ARENA_MACHINE_KEYS_JSON` environment variable:

```json
{
  "pa_example_2026_01": {
    "sha256": "64-lowercase-hex-characters",
    "scopes": ["ingest"]
  }
}
```

Available scopes are:

- `ingest`: register policies and datasets, submit sessions, append rounds,
  and update derived dataset statistics.
- `curate`: change descriptive metadata, links, notes, and exclusions.
- `admin`: delete records or remove a policy from a session.

Use one key per machine and keep admin access in a separate credential. A
leaked key can then be revoked without disrupting other machines, and an
ingest process cannot delete data.

## Python client

Set the credential outside the repository, then use the existing client:

```bash
export POLICY_ARENA_API_KEY='pa_example_2026_01.secret'
uv run python -m your_submission_module
```

```python
from policy_arena import PolicyArenaClient

arena = PolicyArenaClient("https://grandiose-rook-292.convex.cloud")
```

Queries do not require a key. Write methods fail before making a request when
`POLICY_ARENA_API_KEY` is missing. Session submission sends an idempotency key,
so retrying the same request with the same key returns the original session
instead of inserting a duplicate.

Check a credential without changing data:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $POLICY_ARENA_API_KEY" \
  https://grandiose-rook-292.convex.site/api/v1/auth/whoami
```

## Provisioning and rotation

1. Generate at least 256 random bits for the secret and choose a new,
   descriptive key ID.
2. Install `<key-id>.<secret>` in a user-only credential file on its machine.
3. Add its SHA-256 digest and least-privilege scopes to the Convex registry.
4. Run `npx convex dev --once` and verify `/api/v1/auth/whoami` from the target
   machine.
5. During rotation, add the replacement, update the machine, verify it, then
   remove the old registry entry and push Convex once more.

Never put raw credentials in source control, command examples, logs, or Convex
environment variables. Convex receives only the credential digest.
