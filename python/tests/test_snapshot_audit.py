"""Local synthetic ZIP tests for the read-only deployment preservation audit."""

import importlib.util
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


if __name__ == "__main__":
    unittest.main()
