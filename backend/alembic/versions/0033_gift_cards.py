"""Gift cards issued by staff and the balance moved into coupons (Admin -> Growth -> Gift cards)."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "gift_cards",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("code", sa.String(20), nullable=False, unique=True),
        sa.Column("initial_paise", sa.Integer(), nullable=False),
        sa.Column("balance_paise", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(8), nullable=False, server_default="active"),
        sa.Column("note", sa.String(200), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('active','void')", name="ck_gift_cards_status"),
        sa.CheckConstraint("balance_paise >= 0", name="ck_gift_cards_balance"),
    )
    op.create_table(
        "gift_card_uses",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("gift_card_id", UUID(as_uuid=True), sa.ForeignKey("gift_cards.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("coupon_code", sa.String(30), nullable=False),
        sa.Column("amount_paise", sa.Integer(), nullable=False),
        sa.Column("restored", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_gift_card_uses_gift_card_id", "gift_card_uses", ["gift_card_id"])


def downgrade() -> None:
    op.drop_table("gift_card_uses")
    op.drop_table("gift_cards")
