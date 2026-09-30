from alembic import op
from sqlalchemy import inspect, text

revision = "20260930_0002"
down_revision = "20260713_0001"
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    owner = connection.execute(text("SELECT id FROM users WHERE email = :email"),
                               {"email": "drkoby0803@gmail.com"}).scalar()
    if owner is None:
        return
    connection.execute(text("UPDATE users SET password_hash = NULL, is_verified = false WHERE id = :id"), {"id": owner})
    tables = set(inspect(connection).get_table_names())
    for table in ("auth_tokens", "collector_tokens", "verification_codes"):
        if table in tables:
            connection.execute(text(f"DELETE FROM {table} WHERE user_id = :id"), {"id": owner})


def downgrade():
    # Old passwords and login tokens cannot be recovered.
    pass
