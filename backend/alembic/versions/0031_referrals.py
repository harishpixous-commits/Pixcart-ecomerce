"""Referrals: a friend who joined with a customer's code (Admin -> Growth -> Referral rewards)."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "referrals",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("referrer_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("referee_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("status", sa.String(10), nullable=False, server_default="joined"),
        sa.Column("reward_paise", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("rewarded_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('joined','rewarded','capped')", name="ck_referrals_status"),
    )
    op.create_index("ix_referrals_referrer_id", "referrals", ["referrer_id"])


def downgrade() -> None:
    op.drop_table("referrals")
