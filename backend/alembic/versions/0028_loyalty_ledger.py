"""loyalty points ledger

Revision ID: 0028
Revises: 0027
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "loyalty_ledger",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sub_order_id", UUID(as_uuid=True), sa.ForeignKey("sub_orders.id", ondelete="SET NULL"), nullable=True),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("points", sa.Integer(), nullable=False),
        sa.Column("note", sa.String(200), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('earn','redeem','expire','adjust','reverse')", name="ck_loyalty_ledger_kind"),
        sa.UniqueConstraint("sub_order_id", "kind", name="uq_loyalty_sub_kind"),
    )
    op.create_index("ix_loyalty_ledger_user_id", "loyalty_ledger", ["user_id"])


def downgrade() -> None:
    op.drop_table("loyalty_ledger")
