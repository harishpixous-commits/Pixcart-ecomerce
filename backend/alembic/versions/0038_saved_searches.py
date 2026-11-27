"""Searches shoppers follow, to be told about new matching products."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0038"
down_revision = "0037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "saved_searches",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("query", sa.String(120), nullable=False),
        sa.Column("max_price_paise", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_notified_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_saved_searches_user_id", "saved_searches", ["user_id"])


def downgrade() -> None:
    op.drop_table("saved_searches")
