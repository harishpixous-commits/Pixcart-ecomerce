"""order money: a duplicate gateway payment is refunded against its own payment id (the order's payment is never
overwritten); the marketplace's own tax invoice for the fees on an order

Revision ID: 0018
Revises: 0017
"""
import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("refunds", sa.Column("provider_payment_id", sa.String(length=40), nullable=True))
    op.create_unique_constraint(op.f("uq_refunds_provider_payment_id"), "refunds", ["provider_payment_id"])
    op.add_column("orders", sa.Column("fee_invoice_number", sa.String(length=16), server_default="", nullable=False))
    op.add_column("orders", sa.Column("fee_invoice_date", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("orders", "fee_invoice_date")
    op.drop_column("orders", "fee_invoice_number")
    op.drop_constraint(op.f("uq_refunds_provider_payment_id"), "refunds", type_="unique")
    op.drop_column("refunds", "provider_payment_id")
