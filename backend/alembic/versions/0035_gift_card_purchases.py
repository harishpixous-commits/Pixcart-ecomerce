"""Shoppers buying gift cards online: one row per purchase, issued only after the gateway confirms the money."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0035"
down_revision = "0034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "gift_card_purchases",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("amount_paise", sa.Integer(), nullable=False),
        sa.Column("gateway", sa.String(20), nullable=False),
        sa.Column("gateway_ref", sa.String(100), nullable=False),
        sa.Column("client_data", JSONB(), nullable=True),
        sa.Column("status", sa.String(8), nullable=False, server_default="created"),
        sa.Column("gift_card_id", UUID(as_uuid=True), sa.ForeignKey("gift_cards.id", ondelete="SET NULL"), nullable=True),
        sa.Column("error", sa.String(500), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('created','issued','failed')", name=op.f("ck_gift_card_purchases_status")),
        sa.UniqueConstraint("gateway", "gateway_ref", name="uq_gift_purchase_ref"),
    )
    op.create_index("ix_gift_card_purchases_user_id", "gift_card_purchases", ["user_id"])


def downgrade() -> None:
    op.drop_table("gift_card_purchases")
