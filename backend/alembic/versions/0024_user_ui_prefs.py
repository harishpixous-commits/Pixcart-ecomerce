"""admin panel: each staff member's own interface preferences (admin layout, collapsed menu groups, collapsed sidebar)

Revision ID: 0024
Revises: 0023
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("ui_prefs", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False))


def downgrade() -> None:
    op.drop_column("users", "ui_prefs")
