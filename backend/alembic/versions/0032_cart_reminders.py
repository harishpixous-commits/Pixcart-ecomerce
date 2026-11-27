"""Abandoned-cart reminders sent (Admin -> Growth -> Abandoned cart reminders)."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cart_reminders",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("stage", sa.Integer(), nullable=False),
        sa.Column("cart_paise", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_cart_reminders_user_id", "cart_reminders", ["user_id"])


def downgrade() -> None:
    op.drop_table("cart_reminders")
