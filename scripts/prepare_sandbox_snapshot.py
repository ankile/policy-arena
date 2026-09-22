"""Project a live Convex snapshot into the pre-pipeline review schema.

Does not connect to either database. Keeps document IDs and application records,
excludes authentication and jobs, and selects the original stage taxonomies.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import zipfile


def prepare(source: Path, fields_path: Path, destination: Path) -> dict:
    fields = json.loads(fields_path.read_text())
    tables = {
        "taskStatuses", "policies", "evalSessions", "operators", "roundResults",
        "outcomeReviews", "taskSpecs", "stageTaskSpecs", "stagePrefills",
        "stageReviews", "datasets",
    }
    with zipfile.ZipFile(source) as src:
        specs = [json.loads(line) for line in src.read("stageTaskSpecs/documents.jsonl").splitlines()]
        legacy = {(r["task"], r["taxonomy_version"]) for r in specs if "trajectory" not in r["spec"]}
        tasks = [task for task, _ in legacy]
        if len(tasks) != len(set(tasks)):
            raise ValueError("Expected exactly one original taxonomy per task")
        report = {"source": source.name, "tables": {}}
        with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as dst:
            registry = [json.loads(line) for line in src.read("_tables/documents.jsonl").splitlines()]
            selected_registry = [r for r in registry if r["name"] in fields]
            if {r["name"] for r in selected_registry} != set(fields):
                raise ValueError("Source snapshot is missing required application tables")
            dst.writestr("_tables/documents.jsonl", "\n".join(json.dumps(r) for r in selected_registry) + "\n")
            # Preserve table-number mappings for empty auth/job tables too.
            # Omitting them can collide with IDs retained in application rows.
            for table in set(fields) - tables:
                dst.writestr(f"{table}/documents.jsonl", "")
                dst.writestr(f"{table}/generated_schema.jsonl", '"uniform"\n')
            for table in sorted(tables):
                rows = [json.loads(line) for line in src.read(f"{table}/documents.jsonl").splitlines()]
                output = []
                removed = Counter()
                for row in rows:
                    if table in {"stageTaskSpecs", "stageReviews", "stagePrefills"} and (row["task"], row["taxonomy_version"]) not in legacy:
                        continue
                    allowed = set(fields[table]) | {"_id", "_creationTime"}
                    # Original reviewer names remain; auth identities are not copied.
                    allowed.discard("reviewer_user_id")
                    dropped = set(row) - allowed
                    expected_drops = {"reviewer_user_id"} if table in {"stageReviews", "outcomeReviews"} else set()
                    if table == "policies":
                        expected_drops = {"tags", "method", "round"}
                    if dropped - expected_drops:
                        raise ValueError(f"Unreviewed schema difference in {table}: {dropped - expected_drops}")
                    removed.update(dropped)
                    projected = {k: v for k, v in row.items() if k in allowed}
                    if table == "stageTaskSpecs":
                        projected["live"] = True
                    output.append(projected)
                dst.writestr(f"{table}/documents.jsonl", "\n".join(json.dumps(r) for r in output) + "\n")
                schema = src.read(f"{table}/generated_schema.jsonl")
                if schema.strip() != b'"uniform"':
                    raise ValueError(f"Expected uniform Convex export encoding for {table}")
                dst.writestr(f"{table}/generated_schema.jsonl", schema)
                report["tables"][table] = {"source_rows": len(rows), "copied_rows": len(output), "removed_fields": dict(removed)}
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("schema_fields", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source, args.schema_fields, args.destination), indent=2))
