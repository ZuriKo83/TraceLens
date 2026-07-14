from __future__ import annotations

import argparse

from sqlalchemy import inspect, text

from app.db import Base, engine
import app.delete_credits  # noqa: F401  # register deletion tables in Base.metadata


REQUIRED_COLUMNS = {
    "deletion_jobs": {
        "id",
        "public_id",
        "user_id",
        "status",
        "requested_count",
        "successful_count",
        "failed_count",
        "error_message",
        "created_at",
        "completed_at",
    },
    "deletion_job_items": {
        "id",
        "job_id",
        "activity_id",
        "status",
        "error_message",
        "diagnostics_json",
        "credit_reserved",
        "charged",
        "original_activity_type",
        "created_at",
        "completed_at",
    },
}


def _columns(connection, table_name: str) -> set[str]:
    inspector = inspect(connection)
    if table_name not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(table_name)}


def _row_count(connection, table_name: str) -> int:
    if not _columns(connection, table_name):
        return 0
    return int(connection.execute(text(f'SELECT COUNT(*) FROM "{table_name}"')).scalar_one())


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reset incompatible legacy deletion job tables and recreate the current schema."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Allow deletion of existing rows in legacy deletion job tables.",
    )
    args = parser.parse_args()

    incompatible: dict[str, set[str]] = {}
    row_counts: dict[str, int] = {}

    with engine.begin() as connection:
        for table_name, required in REQUIRED_COLUMNS.items():
            existing = _columns(connection, table_name)
            if existing and not required.issubset(existing):
                incompatible[table_name] = required - existing
                row_counts[table_name] = _row_count(connection, table_name)

        if incompatible:
            total_rows = sum(row_counts.values())
            print("Legacy deletion schema detected:")
            for table_name, missing in incompatible.items():
                print(f"- {table_name}: missing={sorted(missing)}, rows={row_counts.get(table_name, 0)}")

            if total_rows and not args.force:
                print("Existing deletion-job rows were found. Re-run with --force after confirming they may be discarded.")
                return 2

            cascade = " CASCADE" if engine.dialect.name == "postgresql" else ""
            connection.execute(text(f'DROP TABLE IF EXISTS "deletion_job_items"{cascade}'))
            connection.execute(text(f'DROP TABLE IF EXISTS "deletion_jobs"{cascade}'))
            print("Removed incompatible legacy deletion job tables.")

    Base.metadata.create_all(engine)

    with engine.connect() as connection:
        failures = []
        for table_name, required in REQUIRED_COLUMNS.items():
            existing = _columns(connection, table_name)
            missing = required - existing
            if missing:
                failures.append(f"{table_name}: {sorted(missing)}")

    if failures:
        print("Schema recreation failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("Deletion job schema is ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
