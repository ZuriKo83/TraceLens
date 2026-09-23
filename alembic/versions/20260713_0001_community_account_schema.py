from __future__ import annotations

from alembic import op
from sqlalchemy import inspect, text

from app.db import Base

# Register all tables in metadata.
import app.models  # noqa: F401,E402
import app.community_models  # noqa: F401,E402
import app.account_admin_hardened  # noqa: F401,E402

revision = "20260713_0001"
down_revision = None
branch_labels = None
depends_on = None


def _add_column_if_missing(connection, table: str, column: str, ddl: str) -> None:
    inspector = inspect(connection)
    if table not in inspector.get_table_names():
        return
    columns = {item["name"] for item in inspector.get_columns(table)}
    if column not in columns:
        connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {ddl}"))


def upgrade() -> None:
    connection = op.get_bind()
    dialect = connection.dialect.name
    bool_default = "0" if dialect == "sqlite" else "FALSE"
    datetime_type = "DATETIME" if dialect == "sqlite" else "TIMESTAMP"

    # Creates only missing tables; existing data and tables are preserved.
    Base.metadata.create_all(bind=connection)

    _add_column_if_missing(connection, "users", "is_admin", f"is_admin BOOLEAN NOT NULL DEFAULT {bool_default}")
    _add_column_if_missing(connection, "users", "password_hash", "password_hash VARCHAR(512)")
    _add_column_if_missing(connection, "users", "last_login_at", f"last_login_at {datetime_type}")
    _add_column_if_missing(connection, "users", "deleted_at", f"deleted_at {datetime_type}")

    _add_column_if_missing(connection, "activities", "collector_email", "collector_email VARCHAR(320)")
    _add_column_if_missing(connection, "activities", "account_label", "account_label VARCHAR(160)")
    _add_column_if_missing(connection, "activities", "content_fingerprint", "content_fingerprint VARCHAR(64)")
    _add_column_if_missing(connection, "scan_logs", "collector_email", "collector_email VARCHAR(320)")
    _add_column_if_missing(connection, "scan_logs", "account_label", "account_label VARCHAR(160)")
    _add_column_if_missing(connection, "scan_logs", "scan_scope", "scan_scope VARCHAR(80) NOT NULL DEFAULT 'default'")
    _add_column_if_missing(connection, "scan_logs", "archived_batch_id", "archived_batch_id INTEGER")

    _add_column_if_missing(connection, "community_chat_messages", "is_hidden", f"is_hidden BOOLEAN NOT NULL DEFAULT {bool_default}")
    _add_column_if_missing(connection, "community_reports", "resolved_by", "resolved_by INTEGER")
    _add_column_if_missing(connection, "community_reports", "resolved_at", f"resolved_at {datetime_type}")

    for statement in (
        "CREATE INDEX IF NOT EXISTS ix_activities_user_imported ON activities (user_id, imported_at)",
        "CREATE INDEX IF NOT EXISTS ix_activities_platform_imported ON activities (platform, imported_at)",
        "CREATE INDEX IF NOT EXISTS ix_scan_logs_user_scanned ON scan_logs (user_id, scanned_at)",
        "CREATE INDEX IF NOT EXISTS ix_scan_logs_platform_scanned ON scan_logs (platform, scanned_at)",
        "CREATE INDEX IF NOT EXISTS ix_community_chat_hidden_id ON community_chat_messages (is_hidden, id)",
    ):
        try:
            connection.execute(text(statement))
        except Exception:
            # Some databases may not support IF NOT EXISTS for every index form.
            pass


def downgrade() -> None:
    # This migration is intentionally non-destructive because it may be adopted
    # by installations containing production user and community data.
    pass
