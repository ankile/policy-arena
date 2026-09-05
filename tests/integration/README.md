# Local prediction API roundtrip

`test_prediction_roundtrip.py` starts `prediction_server.ts` on a random
`127.0.0.1` port with an in-memory `convex-test` database. It runs the actual
machine HTTP router, credential and scope checks, mutation handlers, public query
handlers, and Python upload/read-back helper. The child receives a minimal
environment and synthetic credentials; Bun's dotenv loading is disabled. The
test stops the server and removes its temporary files when it finishes.

From the repository root, with Bun dependencies installed:

```bash
PYTHONPATH=python uv run --project python python tests/integration/test_prediction_roundtrip.py -v
```

When using an existing SIR environment, select that project explicitly while
keeping the current client first on `PYTHONPATH`:

```bash
PYTHONPATH=python uv run --project /path/to/self-improving-robots --frozen python tests/integration/test_prediction_roundtrip.py -v
```

The test uploads 51 episodes in multiple batches and pages, including a maximum
int64 episode index and nested Unicode/float evidence. It repeats the upload,
rejects changed content and reused run identities, publishes a second version,
checks stale compare-and-swap rejection and legacy rollback, and verifies that
old data and saved/copied review duration and provenance remain unchanged.

The Python SDK's default public-query client uses WebSockets. This test injects a
small HTTP transport for queries using the SDK's Convex JSON codecs and the
public `/api/query` format. Machine writes use `PolicyArenaClient` unchanged.
The test covers transport encoding, authentication, handlers, and hashes
together; it does not test WebSocket subscriptions or deployed infrastructure.
