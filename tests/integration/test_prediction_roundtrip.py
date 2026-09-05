"""Real local HTTP machine-route test with a convex-test in-memory database.

Run from repo root, with the current Python client on PYTHONPATH. The public
query adapter speaks the actual Convex encoded-JSON HTTP format using SDK codecs.
This covers HTTP writes, public query encoding, hashes, and handlers together.
It does not emulate or test the production SDK's WebSocket subscription protocol.
"""

import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from convex import ConvexInt64, convex_to_json, json_to_convex

from policy_arena.client import (
    PolicyArenaAPIError,
    PolicyArenaClient,
    _normalize_convex_json_numbers,
)
from policy_arena.prediction_hashes import canonical_digest, prediction_digest
from sir.real.stage_labeling.arena_export import (
    build_trajectory_prediction_row,
    review_label_to_trajectory,
    trajectory_to_review_label,
)


ROOT = Path(__file__).resolve().parents[2]
KEY = "pa_local_integration.test-only-secret-never-valid-on-live"


def read(url):
    if urlparse(url).hostname != "127.0.0.1":
        raise ValueError("Integration requests must stay on loopback")
    with urlopen(url, timeout=10) as response:
        return json.loads(response.read())


class LocalPublicQueries:
    """Test-only transport injection; no replacement of application methods."""

    def __init__(self, url):
        if urlparse(url).hostname != "127.0.0.1":
            raise ValueError("Integration queries must stay on loopback")
        self.url = url

    def query(self, name, args):
        request = Request(
            self.url + "/api/query",
            data=json.dumps(
                {
                    "path": name,
                    "format": "convex_encoded_json",
                    "args": convex_to_json(args),
                }
            ).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=10) as response:
            result = json.loads(response.read())
        if result["status"] != "success":
            raise RuntimeError(result["errorMessage"])
        return json_to_convex(_normalize_convex_json_numbers(result["value"]))


class LocalPredictionRoundtrip(unittest.TestCase):
    def test_real_machine_routes_preserve_history_and_sources(self):
        bun = shutil.which("bun")
        self.assertIsNotNone(bun, "Bun is required for the local integration server")
        with tempfile.TemporaryDirectory(
            prefix="arena-prediction-integration-"
        ) as temp:
            ready = Path(temp) / "ready.json"
            with (Path(temp) / "server.log").open("w+") as log:
                server = subprocess.Popen(
                    [
                        bun,
                        "--no-env-file",
                        str(ROOT / "tests/integration/prediction_server.ts"),
                        str(ready),
                    ],
                    cwd=ROOT,
                    # No real machine/deployment credentials or dotenv files.
                    env={"PATH": os.environ["PATH"], "LANG": "C.UTF-8"},
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
                try:
                    deadline = time.monotonic() + 15
                    while not ready.exists():
                        if server.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            self.fail("Local server did not start:\n" + log.read())
                        time.sleep(0.02)
                    url = json.loads(ready.read_text())["url"]
                    self.exercise(url)
                    self.exercise_trajectory(url)
                except Exception:
                    log.flush()
                    log.seek(0)
                    print("Local integration server log:\n" + log.read())
                    raise
                finally:
                    server.terminate()
                    try:
                        server.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait(timeout=5)

    def exercise(self, url):
        self.assertEqual(urlparse(url).hostname, "127.0.0.1")
        client = PolicyArenaClient(url, api_key=KEY, api_url=url + "/api/v1")
        client.client = LocalPublicQueries(url)
        self.assertIn("ingest", client.whoami()["scopes"])
        fixture = read(url + "/_test/fixture")
        spec = fixture["spec"]
        repo = fixture["repo"]
        baseline = read(url + "/_test/snapshot")["value"]
        meta = {
            "run_key": "local-test/run1",
            "dataset_repo": repo,
            "task": "routing_d1",
            "taxonomy_version": spec["taxonomy_version"],
            "taxonomy_hash": spec["taxonomy_hash"],
            "pipeline": {"name": "local-test", "version": "v1", "git_commit": "a" * 40},
            "source": "local-integration-test",
            "provenance": {"unicode": "机器人", "nested": [True, None, 0.1]},
        }
        rows = [
            {
                "episode_index": i,
                "label": fixture["label"],
                "episode_duration_s": 20.0,
                "evidence": {"index": i, "retries": [1, 2], "at": 0.125},
                "canonical_response": {
                    "max_stage": {"stage_index": 10},
                    "text": "é\U00010000",
                    "minus_zero": -0.0,
                },
                "source_revision": "b" * 40,
            }
            for i in range(51)
        ]
        rows[-1]["episode_index"] = 2**63 - 1
        run1 = client.upload_stage_prediction_run(rows, **meta)
        stored1 = client.fetch_stage_predictions(run1, page_size=10)
        self.assertEqual(len(stored1), 51)
        self.assertEqual(stored1[-1]["episode_index"].value, 2**63 - 1)
        self.assertEqual(stored1[0]["canonical_response"]["text"], "é\U00010000")
        self.assertIsNone(
            client.list_stage_prediction_runs(
                repo, taxonomy_version=spec["taxonomy_version"]
            )["active_run_id"]
        )
        # An exact retry crosses every real route without changing row identities.
        self.assertEqual(client.upload_stage_prediction_run(rows, **meta), run1)
        self.assertEqual(client.fetch_stage_predictions(run1), stored1)
        changed = copy.deepcopy(rows[0])
        changed["evidence"]["at"] = 1.25
        with self.assertRaises(PolicyArenaAPIError):
            client.append_stage_predictions(run1, [changed])
        with self.assertRaises(PolicyArenaAPIError):
            client.upload_stage_prediction_run([changed, *rows[1:]], **meta)
        self.assertEqual(client.fetch_stage_predictions(run1), stored1)
        client.activate_stage_prediction_run(run1, expected_active_run_id=None)

        review_id = client.save_stage_review(
            task="routing_d1",
            dataset_repo=repo,
            episode_index=0,
            taxonomy_version=spec["taxonomy_version"],
            status="confirmed",
            label=fixture["label"],
            prediction_id=stored1[0]["_id"],
            prediction_sha256=stored1[0]["content_sha256"],
            reviewer_override="local-test-reviewer",
            episode_duration_s=999.0,
        )
        history = client.client.query(
            "stageReviews:historyForEpisode",
            {"dataset_repo": repo, "episode_index": ConvexInt64(0)},
        )
        review = next(r for r in history if r["_id"] == review_id)
        self.assertEqual(review["episode_duration_s"], 20.0)
        self.assertEqual(review["prediction_run_id"], run1)
        second = copy.deepcopy(rows)
        for row in second:
            row["episode_duration_s"] = 30.0
        run2 = client.upload_stage_prediction_run(
            second,
            **{
                **meta,
                "run_key": "local-test/run2",
                "pipeline": {**meta["pipeline"], "version": "v2"},
            },
        )
        with self.assertRaises(PolicyArenaAPIError):
            client.activate_stage_prediction_run(run2, expected_active_run_id=None)
        client.activate_stage_prediction_run(run2, expected_active_run_id=run1)
        history_after = client.client.query(
            "stageReviews:historyForEpisode",
            {"dataset_repo": repo, "episode_index": ConvexInt64(0)},
        )
        self.assertEqual(history_after, history)
        self.assertEqual(
            client.fetch_stage_prediction(stored1[0]["_id"])["episode_duration_s"], 20.0
        )
        copied_id = client.save_stage_review(
            task="routing_d1",
            dataset_repo=repo,
            episode_index=0,
            taxonomy_version=spec["taxonomy_version"],
            status="confirmed",
            label=review["label"],
            prediction_id=review["prediction_id"],
            prediction_sha256=review["prediction_sha256"],
            copied_from_review_id=review_id,
            prefill_pushed_at=review["prefill_pushed_at"],
            reviewer_override="local-copy-reviewer",
            episode_duration_s=999.0,
        )
        copied_history = client.client.query(
            "stageReviews:historyForEpisode",
            {"dataset_repo": repo, "episode_index": ConvexInt64(0)},
        )
        copied = next(r for r in copied_history if r["_id"] == copied_id)
        self.assertEqual(copied["episode_duration_s"], 20.0)
        self.assertEqual(copied["prediction_run_id"], run1)
        self.assertEqual(copied["copied_from_review_id"], review_id)
        versions = client.stage_prediction_history(
            repo, 0, taxonomy_version=spec["taxonomy_version"]
        )
        self.assertEqual(len(versions["predictions"]), 2)
        self.assertEqual(len(versions["legacy"]), 1)
        client.restore_legacy_stage_predictions(
            repo, taxonomy_version=spec["taxonomy_version"], expected_active_run_id=run2
        )
        self.assertIsNone(
            client.list_stage_prediction_runs(
                repo, taxonomy_version=spec["taxonomy_version"]
            )["active_run_id"]
        )
        self.assertEqual(
            len(
                client.fetch_stage_prediction_selection_history(
                    repo, taxonomy_version=spec["taxonomy_version"]
                )
            ),
            3,
        )
        final = read(url + "/_test/snapshot")
        for table in ("legacy", "specs", "outcomes", "applyJobs"):
            self.assertEqual(final["value"][table], baseline[table], table)
        old_review_id = baseline["reviews"][0]["_id"]
        self.assertEqual(
            next(r for r in final["value"]["reviews"] if r["_id"] == old_review_id),
            baseline["reviews"][0],
        )
        self.assertEqual(len(final["value"]["runs"]), 2)
        self.assertEqual(len(final["value"]["predictions"]), 102)
        print(
            "Local HTTP integration passed:",
            final["counters"],
            "102 immutable predictions; legacy records and review source duration preserved",
        )

    def exercise_trajectory(self, url):
        """Use the same live local server for the four actual generic contracts."""
        client = PolicyArenaClient(url, api_key=KEY, api_url=url + "/api/v1")
        client.client = LocalPublicQueries(url)
        fixtures = json.loads(
            (ROOT / "tests/fixtures/trajectory-review-fixtures.json").read_text()
        )
        baseline = read(url + "/_test/snapshot")["value"]
        for task in fixtures["synthetic"]["tasks"]:
            with self.subTest(taxonomy=task["source_name"]):
                spec = task["spec"]
                definition = spec["trajectory"]["task_definition"]
                # This goes through SDK JSON encoding, the authenticated HTTP
                # router and actual spec hash checks, rather than direct DB seed.
                client.upsert_stage_task_spec(
                    task=spec["task"],
                    taxonomy_version=spec["taxonomy_version"],
                    taxonomy_hash=spec["taxonomy_hash"],
                    live=False,
                    spec=spec,
                    source="local-integration-trajectory",
                )
                registered = next(
                    row
                    for row in client.get_stage_task_specs(spec["task"])
                    if row["taxonomy_version"] == spec["taxonomy_version"]
                )
                self.assertEqual(
                    canonical_digest(registered["spec"]), canonical_digest(spec)
                )
                self.assertFalse(registered["live"])
                fixture = next(
                    item
                    for item in task["cases"]
                    if item["name"] == "historical_high_stage_final_failure"
                )
                source_canonical = fixture["canonical"]
                invalid = copy.deepcopy(source_canonical)
                invalid["attempt_count"] = 0
                repo = f"test/local-native-{task['source_name']}"
                cases = [
                    (source_canonical, fixture["duration_s"]),
                    (invalid, fixture["duration_s"]),
                ]
                real = next(
                    (
                        item
                        for item in fixtures["real_campaign_cases"]
                        if item["source_name"] == task["source_name"]
                    ),
                    None,
                )
                if real is not None:
                    cases.append((real["canonical"], real["duration_s"]))
                rows = [
                    build_trajectory_prediction_row(
                        canonical,
                        definition,
                        episode_index=index,
                        episode_duration_s=duration_s,
                        source_revision="c" * 40,
                        evidence={"fixture": task["source_name"], "case": index},
                    )
                    for index, (canonical, duration_s) in enumerate(cases)
                ]
                meta = {
                    "run_key": "local-native/" + task["source_name"],
                    "dataset_repo": repo,
                    "task": spec["task"],
                    "taxonomy_version": spec["taxonomy_version"],
                    "taxonomy_hash": spec["taxonomy_hash"],
                    "pipeline": {
                        "name": "local-native",
                        "version": "v1",
                        "git_commit": "a" * 40,
                    },
                    "source": "local-integration-trajectory",
                    "provenance": {"adapter_version": "trajectory-review/v1"},
                }
                run_id = client.upload_stage_prediction_run(rows, **meta)
                stored = client.fetch_stage_predictions(run_id, page_size=1)
                self.assertEqual(len(stored), len(cases))
                for row, (canonical, duration_s) in zip(stored, cases, strict=True):
                    self.assertEqual(
                        prediction_digest(row, stored=True), row["content_sha256"]
                    )
                    self.assertEqual(
                        review_label_to_trajectory(row["label"], definition), canonical
                    )
                    self.assertEqual(row["canonical_response"], canonical)
                    self.assertEqual(row["episode_duration_s"], duration_s)
                self.assertIn("trajectory_contract", stored[1]["validation_codes"])
                self.assertIn(
                    "trajectory_semantic_invalid", stored[1]["violation_codes"]
                )
                self.assertEqual(
                    client.upload_stage_prediction_run(rows, **meta), run_id
                )
                self.assertEqual(client.fetch_stage_predictions(run_id), stored)

                edited_canonical = copy.deepcopy(source_canonical)
                edited_canonical.update(
                    notes="Human edited source notes — repeated events stay intact.",
                    confidence="low",
                    needs_human_review=True,
                    review_reasons=["Human request for an additional review"],
                )
                events = [
                    *edited_canonical["stage_transitions"],
                    *edited_canonical["failure_events"],
                ]
                for action in edited_canonical["key_action_observations"]:
                    events.extend(action["occurrences"])
                for index, event in enumerate(events):
                    event["confidence"] = "medium"
                    event["evidence"] = f"Human evidence for event {index}: 保留"
                saved_id = client.save_stage_review(
                    task=spec["task"],
                    dataset_repo=repo,
                    episode_index=0,
                    taxonomy_version=spec["taxonomy_version"],
                    status="confirmed",
                    label=trajectory_to_review_label(edited_canonical, definition),
                    prediction_id=stored[0]["_id"],
                    prediction_sha256=stored[0]["content_sha256"],
                    reviewer_override="local-native-reviewer",
                    episode_duration_s=999,
                )
                history = client.client.query(
                    "stageReviews:historyForEpisode",
                    {
                        "dataset_repo": repo,
                        "episode_index": ConvexInt64(0),
                    },
                )
                saved = next(row for row in history if row["_id"] == saved_id)
                self.assertEqual(
                    review_label_to_trajectory(saved["label"], definition),
                    edited_canonical,
                )
                self.assertEqual(saved["episode_duration_s"], fixture["duration_s"])
                self.assertEqual(saved["prediction_run_id"], run_id)
                self.assertEqual(saved["taxonomy_hash"], spec["taxonomy_hash"])

                invalid_review = {
                    "task": spec["task"],
                    "dataset_repo": repo,
                    "episode_index": 1,
                    "taxonomy_version": spec["taxonomy_version"],
                    "label": stored[1]["label"],
                    "prediction_id": stored[1]["_id"],
                    "prediction_sha256": stored[1]["content_sha256"],
                    "reviewer_override": "local-native-reviewer",
                }
                with self.assertRaises(PolicyArenaAPIError):
                    client.save_stage_review(**invalid_review, status="confirmed")
                client.save_stage_review(**invalid_review, status="uncertain")

                # Source-free is a provenance statement, not a claim of an
                # independent/blind evaluation; this test creates no exposure log.
                annotation = copy.deepcopy(edited_canonical)
                annotation_episode = 2**63 - 1
                annotation["sample_id"] = f"{repo}#episode={annotation_episode}"
                annotation_id = client.save_stage_review(
                    task=spec["task"],
                    dataset_repo=repo,
                    episode_index=annotation_episode,
                    taxonomy_version=spec["taxonomy_version"],
                    status="confirmed",
                    label=trajectory_to_review_label(annotation, definition),
                    reviewer_override="local-source-free-reviewer",
                    episode_duration_s=fixture["duration_s"],
                )
                annotations = client.client.query(
                    "stageReviews:historyForEpisode",
                    {
                        "dataset_repo": repo,
                        "episode_index": ConvexInt64(annotation_episode),
                    },
                )
                saved_annotation = next(
                    row for row in annotations if row["_id"] == annotation_id
                )
                self.assertEqual(
                    review_label_to_trajectory(saved_annotation["label"], definition),
                    annotation,
                )
                for field in (
                    "prediction_id",
                    "prediction_sha256",
                    "prediction_run_id",
                    "legacy_prefill_id",
                ):
                    self.assertNotIn(field, saved_annotation)
                self.assertEqual(client.fetch_stage_predictions(run_id), stored)
                self.assertIsNone(
                    client.list_stage_prediction_runs(
                        repo, taxonomy_version=spec["taxonomy_version"]
                    )["active_run_id"]
                )

        final = read(url + "/_test/snapshot")
        for table in ("legacy", "outcomes", "applyJobs", "selections"):
            self.assertEqual(final["value"][table], baseline[table], table)
        for table in ("specs", "reviews", "runs", "predictions"):
            by_id = {row["_id"]: row for row in final["value"][table]}
            for row in baseline[table]:
                self.assertEqual(by_id[row["_id"]], row, table)
        self.assertEqual(len(final["value"]["specs"]) - len(baseline["specs"]), 4)
        self.assertEqual(
            len(final["value"]["predictions"]) - len(baseline["predictions"]), 11
        )
        print(
            "Local native HTTP integration passed:",
            final["counters"],
            "four registered trajectory schemas; eleven lossless predictions; human edits and source-free review roundtrips",
        )


if __name__ == "__main__":
    unittest.main()
