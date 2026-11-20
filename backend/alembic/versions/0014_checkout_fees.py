"""checkout fees: the marketplace's own fees and the delivery tip on orders, buyer GSTIN for business purchases,
address name and delivery instructions

Revision ID: 0014
Revises: 0013
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("addresses", sa.Column("label", sa.String(length=40), server_default="", nullable=False))
    op.add_column("addresses", sa.Column("instructions", sa.String(length=300), server_default="", nullable=False))
    op.add_column("orders", sa.Column("fees", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False))
    op.add_column("orders", sa.Column("fees_total", sa.BigInteger(), server_default="0", nullable=False))
    op.add_column("orders", sa.Column("tip_paise", sa.BigInteger(), server_default="0", nullable=False))
    op.add_column("orders", sa.Column("buyer_gstin", sa.String(length=15), server_default="", nullable=False))
    op.add_column("orders", sa.Column("buyer_business", sa.String(length=160), server_default="", nullable=False))
    # the order total now includes the marketplace's fees and the tip
    op.drop_constraint(op.f("ck_orders_totals"), "orders", type_="check")
    op.create_check_constraint(op.f("ck_orders_totals"), "orders", "grand_total = items_total + shipping_total + cod_fee + fees_total + tip_paise - discount_total")
    op.create_check_constraint(op.f("ck_orders_fees"), "orders", "fees_total >= 0 AND tip_paise >= 0")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_orders_fees"), "orders", type_="check")
    op.drop_constraint(op.f("ck_orders_totals"), "orders", type_="check")
    op.create_check_constraint(op.f("ck_orders_totals"), "orders", "grand_total = items_total + shipping_total + cod_fee - discount_total")
    op.drop_column("orders", "buyer_business")
    op.drop_column("orders", "buyer_gstin")
    op.drop_column("orders", "tip_paise")
    op.drop_column("orders", "fees_total")
    op.drop_column("orders", "fees")
    op.drop_column("addresses", "instructions")
    op.drop_column("addresses", "label")
