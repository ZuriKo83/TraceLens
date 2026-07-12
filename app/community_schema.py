from __future__ import annotations

from sqlalchemy import inspect, text

from app.db import Base, engine


def ensure_community_schema() -> None:
    """Create community tables and patch columns missing from older deployments."""
    Base.metadata.create_all(engine)
    dialect = engine.dialect.name
    bool_default = "0" if dialect == "sqlite" else "FALSE"
    datetime_type = "DATETIME" if dialect == "sqlite" else "TIMESTAMP"

    with engine.begin() as connection:
        inspector = inspect(connection)
        tables = set(inspector.get_table_names())

        if "community_chat_messages" in tables:
            columns = {column["name"] for column in inspector.get_columns("community_chat_messages")}
            if "is_hidden" not in columns:
                connection.execute(text(
                    f"ALTER TABLE community_chat_messages ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT {bool_default}"
                ))

        if "community_reports" in tables:
            columns = {column["name"] for column in inspector.get_columns("community_reports")}
            if "resolved_by" not in columns:
                connection.execute(text("ALTER TABLE community_reports ADD COLUMN resolved_by INTEGER"))
            if "resolved_at" not in columns:
                connection.execute(text(
                    f"ALTER TABLE community_reports ADD COLUMN resolved_at {datetime_type}"
                ))

        if "community_chat_messages" in tables:
            connection.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_community_chat_hidden_id ON community_chat_messages (is_hidden, id)"
            ))

    Base.metadata.create_all(engine)
