#!/usr/bin/env python3
"""Compare local Convex export ZIPs without printing row contents or using the network.

Usage for an infrastructure-only cutover:
    python3 scripts/audit_convex_snapshots.py before.zip after.zip --require-empty-predictions

For planned new schema registrations, add --expected-stage-specs specs.json.
The file lists the exact six registration fields (task, taxonomy_version,
taxonomy_hash, spec, live, source). Only those new rows and the live=true to
false demotions of prior versions for their tasks are permitted.

Exit 0 means preserved table identities and contents match. Exit 1 means a
preservation or empty-prediction check failed. Exit 2 means an export is invalid
or incomplete. Authentication, heartbeat, and export-metadata tables are
explicitly excluded; every other exported table is compared.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from zipfile import BadZipFile, ZipFile

REQUIRED_PRESERVED_TABLES = (
    "stagePrefills",
    "stageTaskSpecs",
    "stageReviews",
    "outcomeReviews",
    "applyJobs",
    "datasets",
    "taskSpecs",
    "policies",
    "evalSessions",
    "roundResults",
    "taskStatuses",
    "operators",
)
PREDICTION_TABLES = (
    "stagePredictionRuns",
    "stagePredictions",
    "stagePredictionCatalog",
    "stagePredictionMembers",
    "stagePredictionSelections",
    "stagePredictionSelectionHistory",
)
IGNORED_TABLES = {
    "_tables": "Convex export table metadata",
    "users": "Authentication profile state",
    "authAccounts": "Authentication state",
    "authSessions": "Authentication state",
    "authRefreshTokens": "Authentication state",
    "authVerificationCodes": "Authentication state",
    "authVerifiers": "Authentication state",
    "authRateLimits": "Authentication state",
    "workerHeartbeats": "Transient worker heartbeats",
}
MEMBER_SUFFIX = "/documents.jsonl"


class SnapshotError(ValueError):
    """An export cannot support a trustworthy comparison."""


def _object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise SnapshotError("duplicate JSON object key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise SnapshotError("non-finite JSON number")


def _digest(value: object) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def read_snapshot(
    path: str | Path, *, _stage_spec_rows: dict | None = None
) -> dict[str, dict[str, str]]:
    """Read table ID → canonical-content digest maps. Never return raw rows."""
    try:
        with ZipFile(path) as archive:
            members = [
                name for name in archive.namelist() if name.endswith(MEMBER_SUFFIX)
            ]
            if len(members) != len(set(members)):
                raise SnapshotError("duplicate table member in export ZIP")
            table_members = {name[: -len(MEMBER_SUFFIX)]: name for name in members}
            missing = sorted(
                set(REQUIRED_PRESERVED_TABLES + PREDICTION_TABLES)
                - table_members.keys()
            )
            if missing:
                raise SnapshotError(
                    "missing required table members: " + ", ".join(missing)
                )
            tables = {}
            for table, member in sorted(table_members.items()):
                if table in IGNORED_TABLES:
                    continue
                hashes = {}
                with archive.open(member) as stream:
                    for line_number, line in enumerate(stream, 1):
                        if not line.strip():
                            continue
                        try:
                            row = json.loads(
                                line,
                                object_pairs_hook=_object,
                                parse_constant=_reject_constant,
                            )
                            if (
                                not isinstance(row, dict)
                                or not isinstance(row.get("_id"), str)
                                or not row["_id"]
                            ):
                                raise SnapshotError(
                                    "row requires a nonempty string _id"
                                )
                            row_id = row["_id"]
                            if row_id in hashes:
                                raise SnapshotError("duplicate row identity")
                            hashes[row_id] = _digest(row)
                            if (
                                table == "stageTaskSpecs"
                                and _stage_spec_rows is not None
                            ):
                                _stage_spec_rows[row_id] = row
                        except (ValueError, TypeError, UnicodeError) as error:
                            # JSONDecodeError includes source excerpts. Report
                            # location only so snapshots cannot leak raw rows.
                            reason = (
                                str(error)
                                if isinstance(error, SnapshotError)
                                else "invalid JSON row"
                            )
                            raise SnapshotError(
                                f"{member} line {line_number}: {reason}"
                            ) from None
                tables[table] = hashes
            return tables
    except (OSError, BadZipFile) as error:
        raise SnapshotError(f"cannot read export ZIP: {type(error).__name__}") from None


def _json_equal(left: object, right: object) -> bool:
    """Compare JSON values with Convex's number semantics, preserving bool types."""
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            _json_equal(value, right[key]) for key, value in left.items()
        )
    if isinstance(left, list):
        return len(left) == len(right) and all(
            _json_equal(a, b) for a, b in zip(left, right)
        )
    return left == right


EXPECTED_SPEC_FIELDS = frozenset(
    {"task", "taxonomy_version", "taxonomy_hash", "spec", "live", "source"}
)
NEW_SPEC_SERVER_FIELDS = frozenset({"_id", "_creationTime", "exported_at"})


def _expected_specs_by_key(expected: list[dict]) -> dict[tuple[str, str], dict]:
    if not isinstance(expected, list):
        raise SnapshotError("expected stage specs must be a JSON list")
    by_key = {}
    live_tasks = set()
    for row in expected:
        if not isinstance(row, dict) or set(row) != EXPECTED_SPEC_FIELDS:
            raise SnapshotError("expected stage spec has missing or unexpected fields")
        if any(
            not isinstance(row[field], str) or not row[field]
            for field in ("task", "taxonomy_version", "taxonomy_hash", "source")
        ):
            raise SnapshotError(
                "expected stage spec identity fields must be nonempty strings"
            )
        if not isinstance(row["spec"], dict) or type(row["live"]) is not bool:
            raise SnapshotError(
                "expected stage spec requires an object spec and boolean live"
            )
        if any(
            row["spec"].get(field) != row[field]
            for field in ("task", "taxonomy_version", "taxonomy_hash")
        ):
            raise SnapshotError(
                "expected stage spec payload identity does not match its row"
            )
        key = (row["task"], row["taxonomy_version"])
        if key in by_key:
            raise SnapshotError(
                "expected stage specs contain duplicate task/version identity"
            )
        if row["live"] and row["task"] in live_tasks:
            raise SnapshotError(
                "expected stage specs request multiple live versions for one task"
            )
        if row["live"]:
            live_tasks.add(row["task"])
        by_key[key] = row
    # Also rejects NaN and values not representable in the comparison report.
    try:
        _digest(expected)
    except (ValueError, TypeError, UnicodeError):
        raise SnapshotError(
            "expected stage specs contain invalid JSON values"
        ) from None
    return by_key


def _spec_key(row: dict) -> tuple[str, str] | None:
    """Malformed snapshot identities cannot authorize a planned change."""
    fields = (row.get("task"), row.get("taxonomy_version"))
    return fields if all(isinstance(value, str) and value for value in fields) else None


def _valid_timestamp(value: object) -> bool:
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def _audit_stage_spec_plan(previous: dict, current: dict, expected: list[dict]) -> dict:
    planned = _expected_specs_by_key(expected)
    old_keys = {_spec_key(row) for row in previous.values()}
    if planned.keys() & old_keys:
        raise SnapshotError("expected stage specs must be new task/version identities")
    matches = {key: [] for key in planned}
    unexpected_added = []
    for row_id in sorted(current.keys() - previous.keys()):
        row = current[row_id]
        key = _spec_key(row)
        timestamps_valid = all(
            _valid_timestamp(row.get(field))
            for field in ("_creationTime", "exported_at")
        )
        if (
            key not in planned
            or set(row) != EXPECTED_SPEC_FIELDS | NEW_SPEC_SERVER_FIELDS
            or not timestamps_valid
            or not _json_equal(
                {field: row[field] for field in EXPECTED_SPEC_FIELDS}, planned[key]
            )
        ):
            unexpected_added.append(row_id)
        else:
            matches[key].append(row_id)
    duplicated = [row_id for ids in matches.values() if len(ids) > 1 for row_id in ids]
    unexpected_added.extend(duplicated)
    allowed_added = [ids[0] for ids in matches.values() if len(ids) == 1]
    live_tasks = {
        key[0] for key, ids in matches.items() if len(ids) == 1 and planned[key]["live"]
    }
    allowed_demoted = []
    unexpected_changed = []
    unexpected_live = []
    for row_id in sorted(previous.keys() & current.keys()):
        before, after = previous[row_id], current[row_id]
        old_key = _spec_key(before)
        has_new_live = old_key is not None and old_key[0] in live_tasks
        if has_new_live and after.get("live") is True:
            # Registration of a new live version demotes every old live
            # sibling. A snapshot with both live is not the planned state.
            unexpected_live.append(row_id)
        if _digest(before) == _digest(after):
            continue
        if (
            has_new_live
            and before.get("live") is True
            and after.get("live") is False
            # All original payload and metadata bytes still use the strict
            # snapshot digest; only the one boolean is allowed to differ.
            and _digest({**before, "live": False}) == _digest(after)
        ):
            allowed_demoted.append(row_id)
        else:
            unexpected_changed.append(row_id)
    missing = [key for key, ids in matches.items() if len(ids) != 1]
    removed = sorted(previous.keys() - current.keys())
    return {
        "ok": not (
            unexpected_added
            or unexpected_changed
            or unexpected_live
            or missing
            or removed
        ),
        "expected_plan_sha256": _digest(expected),
        "expected_count": len(planned),
        "allowed_added_ids": sorted(allowed_added),
        "allowed_demoted_ids": sorted(allowed_demoted),
        "unexpected_added_ids": sorted(unexpected_added),
        "unexpected_changed_ids": sorted(unexpected_changed),
        "unexpected_live_ids": sorted(unexpected_live),
        "missing_expected_specs": [
            {"task": task, "taxonomy_version": version}
            for task, version in sorted(missing)
        ],
    }


def compare_snapshots(
    before_path: str | Path,
    after_path: str | Path,
    *,
    require_empty_predictions: bool = False,
    expected_stage_specs: list[dict] | None = None,
) -> dict:
    previous_specs, current_specs = {}, {}
    before = read_snapshot(
        before_path,
        _stage_spec_rows=previous_specs if expected_stage_specs is not None else None,
    )
    after = read_snapshot(
        after_path,
        _stage_spec_rows=current_specs if expected_stage_specs is not None else None,
    )
    planned_specs = (
        _audit_stage_spec_plan(previous_specs, current_specs, expected_stage_specs)
        if expected_stage_specs is not None
        else None
    )
    tables = {}
    ok = True
    for table in sorted(before.keys() | after.keys()):
        previous = before.get(table, {})
        current = after.get(table, {})
        added = sorted(current.keys() - previous.keys())
        removed = sorted(previous.keys() - current.keys())
        changed = sorted(
            key
            for key in previous.keys() & current.keys()
            if previous[key] != current[key]
        )
        is_prediction = table in PREDICTION_TABLES
        present = table in before and table in after
        preserved = present and not (added or removed or changed)
        empty = not previous and not current
        passes = (
            (present and (empty or not require_empty_predictions))
            if is_prediction
            else preserved
        )
        if table == "stageTaskSpecs" and planned_specs is not None:
            passes = present and planned_specs["ok"]
        ok = ok and passes
        tables[table] = {
            "check": "prediction_empty"
            if is_prediction and require_empty_predictions
            else "prediction_changes_allowed"
            if is_prediction
            else "preserve",
            "ok": passes,
            "before": {
                "present": table in before,
                "count": len(previous),
                "sha256": _digest(sorted(previous.items())),
            },
            "after": {
                "present": table in after,
                "count": len(current),
                "sha256": _digest(sorted(current.items())),
            },
            "added_ids": added,
            "removed_ids": removed,
            "changed_ids": changed,
        }
        if table == "stageTaskSpecs" and planned_specs is not None:
            tables[table]["check"] = "planned_stage_specs"
            tables[table]["planned_changes"] = planned_specs
    return {
        "format": "arena-snapshot-audit/v1",
        "ok": ok,
        "require_empty_predictions": require_empty_predictions,
        "ignored_tables": IGNORED_TABLES,
        "tables": tables,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "before", type=Path, help="Local Convex export ZIP before deployment"
    )
    parser.add_argument(
        "after", type=Path, help="Local Convex export ZIP after deployment"
    )
    parser.add_argument(
        "--require-empty-predictions",
        action="store_true",
        help="Require all six prediction tables to be empty in both exports",
    )
    parser.add_argument(
        "--expected-stage-specs",
        type=Path,
        help="JSON list of exact new registered specs; permit only those additions and old live-only demotions",
    )
    args = parser.parse_args(argv)
    try:
        expected = None
        if args.expected_stage_specs is not None:
            try:
                expected = json.loads(
                    args.expected_stage_specs.read_text(),
                    object_pairs_hook=_object,
                    parse_constant=_reject_constant,
                )
            except (OSError, ValueError, UnicodeError):
                raise SnapshotError(
                    "cannot read valid expected stage specs JSON"
                ) from None
            _expected_specs_by_key(expected)
        result = compare_snapshots(
            args.before,
            args.after,
            require_empty_predictions=args.require_empty_predictions,
            expected_stage_specs=expected,
        )
    except SnapshotError as error:
        print(
            json.dumps(
                {"format": "arena-snapshot-audit/v1", "ok": False, "error": str(error)}
            )
        )
        return 2
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
