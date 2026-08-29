# Machine API authentication

Policy Arena reads remain public. Human writes use Hugging Face OAuth and the
editor allowlist. Automated writes use per-machine bearer credentials through
Convex HTTP Actions; raw machine credentials are never stored in Convex.

## Credentials and scopes

A credential has the form `<key-id>.<secret>`. Store the complete credential
only on the machine that uses it. Convex stores its SHA-256 digest in
`POLICY_ARENA_MACHINE_KEYS_JSON`:

```json
{
  "pa_example_2026_01": {
    "sha256": "64-lowercase-hex-characters",
    "scopes": ["ingest"]
  }
}
```

The scopes are:

- `ingest`: submit results, register data, publish task specifications and
  stage prefills, refresh statistics, and operate the apply worker.
- `curate`: edit lifecycle metadata, operators, and human review records.
- `admin`: delete records and run repair utilities.

Use one key per machine and a separate admin key. A leaked ingest key cannot
edit reviews or delete data, and revoking one host does not interrupt another.

`ARENA_SERVICE_TOKEN` is now a server-only bridge between the authenticated
HTTP Action and the existing mutation handlers. Never install it on a machine.

## Python client

The client reads `POLICY_ARENA_API_KEY`, then
`~/.config/sir/policy_arena_api_key` by default. On Linux, install a credential
from standard input with:

```bash
mkdir -p ~/.config/sir
install -m 600 /dev/stdin ~/.config/sir/policy_arena_api_key
```

macOS `install` does not accept `/dev/stdin`. When the credential is staged in
Keychain, install it without printing the secret:

```bash
(
  set -e
  umask 077
  credential_dir="$HOME/.config/sir"
  mkdir -p "$credential_dir"
  credential_tmp="$(mktemp "$credential_dir/.policy_arena_api_key.XXXXXX")"
  trap 'rm -f "$credential_tmp"' EXIT
  security find-generic-password \
    -s policy-arena-machine-api -a iris-ws-15 -w > "$credential_tmp"
  chmod 600 "$credential_tmp"
  mv -f "$credential_tmp" "$credential_dir/policy_arena_api_key"
)
```

```python
from policy_arena import PolicyArenaClient

arena = PolicyArenaClient("https://grandiose-rook-292.convex.cloud")
```

Queries do not require a key. A write fails locally when no credential exists.
Session submission also sends an idempotency key, so retrying the same body
with the same key returns the original session instead of creating a duplicate.

Check a credential without changing data:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $POLICY_ARENA_API_KEY" \
  https://grandiose-rook-292.convex.site/api/v1/auth/whoami
```

## Provisioning and rotation

1. Generate at least 256 random bits for the secret and choose a descriptive,
   versioned key ID.
2. Install `<key-id>.<secret>` in the target user's credential file with mode
   `0600`.
3. Add the SHA-256 digest and least-privilege scopes to the Convex registry.
4. Run `npx convex dev --once` and verify `/api/v1/auth/whoami` from the target
   machine.
5. During rotation, add the replacement, update and verify the machine, then
   remove the old registry entry.

Never put credentials in source control, command examples, logs, or Convex
environment variables. Convex receives only their digests.
