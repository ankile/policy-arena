#!/usr/bin/env python3
"""Compare local Convex export ZIPs without printing row contents or using the network.

Usage for an infrastructure-only cutover:
    python3 scripts/audit_convex_snapshots.py before.zip after.zip --require-empty-predictions

Exit 0 means preserved table identities and contents match. Exit 1 means a
preservation or empty-prediction check failed. Exit 2 means an export is invalid
or incomplete. Authentication, heartbeat, and export-metadata tables are
explicitly excluded; every other exported table is compared.
"""

from __future__ import annotations

import argparse
import hashlib
import json
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


def read_snapshot(path: str | Path) -> dict[str, dict[str, str]]:
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


def compare_snapshots(
    before_path: str | Path,
    after_path: str | Path,
    *,
    require_empty_predictions: bool = False,
) -> dict:
    before = read_snapshot(before_path)
    after = read_snapshot(after_path)
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
    args = parser.parse_args(argv)
    try:
        result = compare_snapshots(
            args.before,
            args.after,
            require_empty_predictions=args.require_empty_predictions,
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
