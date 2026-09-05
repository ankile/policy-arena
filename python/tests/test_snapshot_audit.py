"""Local synthetic ZIP tests for the read-only deployment preservation audit."""

import importlib.util
from copy import deepcopy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "audit_convex_snapshots.py"
module_spec = importlib.util.spec_from_file_location("audit_convex_snapshots", SCRIPT)
assert module_spec is not None and module_spec.loader is not None
audit = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(audit)


class SnapshotAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def write(self, filename, tables=None, omit=(), raw=None, reverse=False):
        contents = {
            name: []
            for name in audit.REQUIRED_PRESERVED_TABLES + audit.PREDICTION_TABLES
        }
        contents.update(tables or {})
        path = self.directory / filename
        names = sorted(contents, reverse=reverse)
        with ZipFile(path, "w") as archive:
            for table in names:
                if table in omit:
                    continue
                rows = reversed(contents[table]) if reverse else contents[table]
                payload = "\n".join(json.dumps(row, sort_keys=reverse) for row in rows)
                archive.writestr(
                    table + "/documents.jsonl", (raw or {}).get(table, payload)
                )
        return path

    def test_unchanged_rows_ignore_table_row_and_object_serialization_order(self):
        tables = {
            "stagePrefills": [
                {"_id": "b", "label": {"z": 4, "a": 1}},
                {"_id": "a", "label": {"stage": 2}},
            ]
        }
        before = self.write("before.zip", tables)
        after = self.write("after.zip", tables, reverse=True)
        result = audit.compare_snapshots(before, after, require_empty_predictions=True)
        self.assertTrue(result["ok"])
        self.assertEqual(
            result["tables"]["stagePrefills"]["before"]["sha256"],
            result["tables"]["stagePrefills"]["after"]["sha256"],
        )

    def test_changed_values_report_ids_and_digests_without_raw_rows(self):
        before = self.write(
            "before.zip",
            {"stageReviews": [{"_id": "review-a", "notes": "secret-before"}]},
        )
        after = self.write(
            "after.zip",
            {"stageReviews": [{"_id": "review-a", "notes": "secret-after"}]},
        )
        result = audit.compare_snapshots(before, after)
        self.assertFalse(result["ok"])
        table = result["tables"]["stageReviews"]
        self.assertEqual(table["changed_ids"], ["review-a"])
        self.assertNotEqual(table["before"]["sha256"], table["after"]["sha256"])
        self.assertNotIn("secret-", json.dumps(result))

    def test_added_and_removed_rows_fail_for_each_required_preserved_table(self):
        for table in audit.REQUIRED_PRESERVED_TABLES:
            with self.subTest(table=table):
                before = self.write("before.zip", {table: [{"_id": "old"}]})
                after = self.write("after.zip", {table: [{"_id": "new"}]})
                result = audit.compare_snapshots(before, after)
                self.assertFalse(result["ok"])
                self.assertEqual(result["tables"][table]["removed_ids"], ["old"])
                self.assertEqual(result["tables"][table]["added_ids"], ["new"])

    def test_missing_required_table_never_looks_like_an_empty_table(self):
        good = self.write("good.zip")
        for table in ("stagePrefills", "stagePredictionMembers"):
            missing = self.write("missing.zip", omit=(table,))
            for before, after in ((missing, good), (good, missing)):
                with self.subTest(table=table, before=before):
                    with self.assertRaisesRegex(
                        audit.SnapshotError, "missing required table"
                    ):
                        audit.compare_snapshots(before, after)

    def test_optional_prediction_gate_checks_both_exports(self):
        empty = self.write("empty.zip")
        for table in audit.PREDICTION_TABLES:
            populated = self.write("populated.zip", {table: [{"_id": "prediction-a"}]})
            for before, after in (
                (empty, populated),
                (populated, empty),
                (populated, populated),
            ):
                with self.subTest(table=table, before=before, after=after):
                    self.assertTrue(audit.compare_snapshots(before, after)["ok"])
                    self.assertFalse(
                        audit.compare_snapshots(
                            before, after, require_empty_predictions=True
                        )["ok"]
                    )

    def test_authentication_and_heartbeats_are_ignored_but_unknown_tables_are_preserved(
        self,
    ):
        before = self.write(
            "before.zip",
            {
                "users": [{"_id": "old"}],
                "workerHeartbeats": [{"_id": "heartbeat"}],
                "eloHistory": [],
            },
        )
        after = self.write(
            "after.zip",
            {"users": [{"_id": "new"}], "workerHeartbeats": [], "eloHistory": []},
        )
        self.assertTrue(audit.compare_snapshots(before, after)["ok"])
        added = self.write("added.zip", {"eloHistory": [{"_id": "unexpected"}]})
        self.assertFalse(audit.compare_snapshots(before, added)["ok"])
        missing = self.write("missing.zip")
        self.assertFalse(audit.compare_snapshots(before, missing)["ok"])

    def test_duplicate_ids_and_malformed_rows_fail_without_exposing_content(self):
        for raw in (
            '{"_id":"a"}\n{"_id":"a"}',
            '{"_id":"a","secret":"unclosed',
            '{"_id":"a","value":NaN}',
            '{"_id":"a","value":1,"value":2}',
        ):
            invalid = self.write("invalid.zip", raw={"stagePrefills": raw})
            with self.assertRaises(audit.SnapshotError) as error:
                audit.read_snapshot(invalid)
            self.assertNotIn("unclosed", str(error.exception))
            self.assertIn("stagePrefills/documents.jsonl line", str(error.exception))

    def test_cli_exit_codes_distinguish_match_change_and_incomplete_export(self):
        before = self.write("before.zip")
        changed = self.write("changed.zip", {"datasets": [{"_id": "added"}]})
        missing = self.write("missing.zip", omit=("datasets",))
        for after, expected in ((before, 0), (changed, 1), (missing, 2)):
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    str(before),
                    str(after),
                    "--require-empty-predictions",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, expected, result.stderr)
            self.assertEqual(json.loads(result.stdout)["ok"], expected == 0)

    @staticmethod
    def planned_spec(task, version, live=True):
        return {
            "task": task,
            "taxonomy_version": version,
            "taxonomy_hash": "a" * 64,
            "spec": {
                "task": task,
                "taxonomy_version": version,
                "taxonomy_hash": "a" * 64,
                "ladder": [{"index": 1, "description": "preserve-source-payload"}],
            },
            "live": live,
            "source": "immutable-campaign-source",
        }

    @staticmethod
    def registered_spec(planned, identity):
        return {
            **deepcopy(planned),
            "_id": identity,
            "_creationTime": 100,
            "exported_at": 200,
        }

    def planned_snapshots(self):
        expected = [
            self.planned_spec("marker", "trajectory/v3"),
            self.planned_spec("marker", "trajectory/v4", live=False),
            self.planned_spec("square", "trajectory/v3"),
            self.planned_spec("routing", "trajectory/v1"),
        ]
        old = [
            self.registered_spec(self.planned_spec(task, "legacy/v1"), "old-" + task)
            for task in ("marker", "square", "routing")
        ]
        old.append(
            self.registered_spec(
                self.planned_spec("marker", "legacy/candidate", live=False),
                "old-candidate",
            )
        )
        after = [{**row, "live": False} for row in old]
        after.extend(
            self.registered_spec(row, f"new-{index}")
            for index, row in enumerate(expected)
        )
        return old, after, expected

    def compare_specs(self, old, new, expected, *, other_before=None, other_after=None):
        before = self.write(
            "before.zip", {**(other_before or {}), "stageTaskSpecs": old}
        )
        after = self.write("after.zip", {**(other_after or {}), "stageTaskSpecs": new})
        return audit.compare_snapshots(before, after, expected_stage_specs=expected)

    def test_exact_four_planned_additions_and_three_live_demotions_pass(self):
        old, new, expected = self.planned_snapshots()
        result = self.compare_specs(old, new, expected)
        self.assertTrue(result["ok"])
        changes = result["tables"]["stageTaskSpecs"]["planned_changes"]
        self.assertEqual(changes["allowed_added_ids"], [f"new-{i}" for i in range(4)])
        self.assertEqual(
            changes["allowed_demoted_ids"], ["old-marker", "old-routing", "old-square"]
        )
        self.assertNotIn("preserve-source-payload", json.dumps(result))
        self.assertNotIn("immutable-campaign-source", json.dumps(result))
        # Convex serializes number fields as float64; planned JSON may use ints.
        new[4]["spec"]["ladder"][0]["index"] = 1.0
        self.assertTrue(self.compare_specs(old, new, expected)["ok"])
        # Without explicit authorization the same additions/demotions still fail.
        self.assertFalse(self.compare_specs(old, new, None)["ok"])

    def test_planned_registration_rejects_changed_source_payload_or_metadata(self):
        old, baseline, expected = self.planned_snapshots()
        changes = [
            ("spec", {**old[0]["spec"], "ladder": []}),
            ("source", "changed-producer"),
            ("exported_at", old[0]["exported_at"] + 1),
            ("taxonomy_hash", "b" * 64),
            ("_creationTime", old[0]["_creationTime"] + 1),
            ("unexpected", "added-metadata"),
        ]
        for field, value in changes:
            with self.subTest(field=field):
                new = deepcopy(baseline)
                new[0][field] = value
                result = self.compare_specs(old, new, expected)
                self.assertFalse(result["ok"])
                self.assertIn(
                    "old-marker",
                    result["tables"]["stageTaskSpecs"]["planned_changes"][
                        "unexpected_changed_ids"
                    ],
                )
        # Even a number serialization change is forbidden in preserved rows.
        new = deepcopy(baseline)
        new[0]["spec"]["ladder"][0]["index"] = 1.0
        self.assertFalse(self.compare_specs(old, new, expected)["ok"])

    def test_planned_registration_requires_exact_new_payload_and_metadata_shape(self):
        old, baseline, expected = self.planned_snapshots()
        bad_fields = [
            ("source", "unexpected-source"),
            ("taxonomy_hash", "b" * 64),
            ("spec", {**expected[0]["spec"], "ladder": []}),
            ("live", False),
            ("extra", "unexpected"),
            ("task", ["malformed", "unhashable"]),
            ("_creationTime", True),
            ("exported_at", -1),
        ]
        for field, value in bad_fields:
            with self.subTest(field=field):
                new = deepcopy(baseline)
                new[4][field] = value
                result = self.compare_specs(old, new, expected)
                self.assertFalse(result["ok"])
                self.assertIn(
                    "new-0",
                    result["tables"]["stageTaskSpecs"]["planned_changes"][
                        "unexpected_added_ids"
                    ],
                )
        new = deepcopy(baseline)
        new[4]["spec"]["ladder"][0]["index"] = True
        self.assertFalse(self.compare_specs(old, new, expected)["ok"])
        del new[4]["exported_at"]
        self.assertFalse(self.compare_specs(old, new, expected)["ok"])

    def test_planned_registration_rejects_missing_duplicate_or_extra_new_rows(self):
        old, baseline, expected = self.planned_snapshots()
        cases = {
            "missing": baseline[:-1],
            "duplicate": [*baseline, {**baseline[-1], "_id": "duplicate"}],
            "extra": [
                *baseline,
                self.registered_spec(self.planned_spec("extra", "v1"), "extra"),
            ],
        }
        for name, new in cases.items():
            with self.subTest(name=name):
                self.assertFalse(self.compare_specs(old, new, expected)["ok"])
        result = self.compare_specs(old, baseline[:-1], expected)
        self.assertEqual(
            result["tables"]["stageTaskSpecs"]["planned_changes"][
                "missing_expected_specs"
            ],
            [{"task": "routing", "taxonomy_version": "trajectory/v1"}],
        )

    def test_demotions_require_a_matched_new_live_version_of_the_same_task(self):
        old, baseline, expected = self.planned_snapshots()
        # Keeping the old live schema would produce two live versions.
        new = deepcopy(baseline)
        new[0]["live"] = True
        result = self.compare_specs(old, new, expected)
        self.assertFalse(result["ok"])
        self.assertEqual(
            result["tables"]["stageTaskSpecs"]["planned_changes"][
                "unexpected_live_ids"
            ],
            ["old-marker"],
        )
        candidate = self.planned_spec("marker", "candidate/v2", live=False)
        candidate_row = self.registered_spec(candidate, "new-candidate")
        # Candidate addition permits no old live demotion.
        self.assertTrue(
            self.compare_specs(old, [*old, candidate_row], [candidate])["ok"]
        )
        self.assertFalse(
            self.compare_specs(old, [*baseline[:4], candidate_row], [candidate])["ok"]
        )
        self.assertFalse(self.compare_specs(old, baseline[:4], [])["ok"])
        other = self.registered_spec(self.planned_spec("other", "v1"), "old-other")
        self.assertFalse(
            self.compare_specs(
                [*old, other], [*baseline, {**other, "live": False}], expected
            )["ok"]
        )

    def test_planned_registration_never_allows_deletion_or_other_table_changes(self):
        old, new, expected = self.planned_snapshots()
        self.assertFalse(self.compare_specs(old, new[1:], expected)["ok"])
        for table in audit.REQUIRED_PRESERVED_TABLES:
            if table == "stageTaskSpecs":
                continue
            with self.subTest(table=table):
                result = self.compare_specs(
                    old,
                    new,
                    expected,
                    other_before={table: [{"_id": "protected", "value": "before"}]},
                    other_after={table: [{"_id": "protected", "value": "after"}]},
                )
                self.assertFalse(result["ok"])
        # The existing prediction-table policy is independent of schema additions.
        result = self.compare_specs(
            old,
            new,
            expected,
            other_after={"stagePredictions": [{"_id": "new-prediction"}]},
        )
        self.assertTrue(result["ok"])

    def test_expected_plan_must_be_exact_new_unique_schema_identities(self):
        old, new, expected = self.planned_snapshots()
        malformed = [
            {},
            [None],
            [{**expected[0], "unknown": True}],
            [{**expected[0], "live": 1}],
            [{**expected[0], "source": ""}],
            [{**expected[0], "spec": {**expected[0]["spec"], "task": "other"}}],
            [expected[0], expected[0]],
            [expected[0], {**expected[1], "live": True}],
            [self.planned_spec("marker", "legacy/v1")],
        ]
        for plan in malformed:
            with self.subTest(plan=plan):
                with self.assertRaises(audit.SnapshotError):
                    self.compare_specs(old, new, plan)

    def test_cli_expected_specs_is_explicit_strict_json_and_keeps_safe_reporting(self):
        old, new, expected = self.planned_snapshots()
        before = self.write("before.zip", {"stageTaskSpecs": old})
        after = self.write("after.zip", {"stageTaskSpecs": new})
        plan_path = self.directory / "plan.json"
        for payload, status in (
            (json.dumps(expected), 0),
            ("[]", 1),
            ("null", 2),
            ("{}", 2),
            ('[{"secret":"unclosed', 2),
            ('[{"a":1,"a":2}]', 2),
        ):
            with self.subTest(payload=payload):
                plan_path.write_text(payload)
                result = subprocess.run(
                    [
                        sys.executable,
                        str(SCRIPT),
                        str(before),
                        str(after),
                        "--expected-stage-specs",
                        str(plan_path),
                    ],
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertEqual(json.loads(result.stdout)["ok"], status == 0)
                self.assertNotIn("unclosed", result.stdout)
                self.assertNotIn("preserve-source-payload", result.stdout)


if __name__ == "__main__":
    unittest.main()
