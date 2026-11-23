"""sign out of other devices: access tokens issued before this moment are refused

Revision ID: 0026
Revises: 0025
"""
import sqlalchemy as sa
from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("sessions_valid_after", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "sessions_valid_after")
