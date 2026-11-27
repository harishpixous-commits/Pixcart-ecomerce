"""Campaigns can be scheduled for later."""
import sqlalchemy as sa
from alembic import op

revision = "0039"
down_revision = "0038"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("segment_campaigns", sa.Column("status", sa.String(10), nullable=False, server_default="sent"))
    op.add_column("segment_campaigns", sa.Column("send_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("segment_campaigns", "send_at")
    op.drop_column("segment_campaigns", "status")
