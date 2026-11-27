"""Scheduled campaigns can repeat."""
import sqlalchemy as sa
from alembic import op

revision = "0043"
down_revision = "0042"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("segment_campaigns", sa.Column("repeat_days", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("segment_campaigns", sa.Column("repeats_left", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("segment_campaigns", "repeats_left")
    op.drop_column("segment_campaigns", "repeat_days")
