"""A bought gift card can be refunded by staff (status 'refunded', with the payment reference)."""
import sqlalchemy as sa
from alembic import op

revision = "0051"
down_revision = "0050"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_gift_card_purchases_status"), "gift_card_purchases", type_="check")
    op.create_check_constraint(op.f("ck_gift_card_purchases_status"), "gift_card_purchases", "status IN ('created','issued','failed','refunded')")
    op.add_column("gift_card_purchases", sa.Column("refund_reference", sa.String(100), nullable=False, server_default=""))
    op.add_column("gift_card_purchases", sa.Column("refunded_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("gift_card_purchases", "refunded_at")
    op.drop_column("gift_card_purchases", "refund_reference")
    op.drop_constraint(op.f("ck_gift_card_purchases_status"), "gift_card_purchases", type_="check")
    op.create_check_constraint(op.f("ck_gift_card_purchases_status"), "gift_card_purchases", "status IN ('created','issued','failed')")
