"""Refund references can be longer than Razorpay's (other gateways use longer ids)."""
import sqlalchemy as sa
from alembic import op

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("refunds", "provider_payment_id", type_=sa.String(100), existing_type=sa.String(40))
    op.alter_column("refunds", "provider_refund_id", type_=sa.String(100), existing_type=sa.String(40))


def downgrade() -> None:
    op.alter_column("refunds", "provider_refund_id", type_=sa.String(40), existing_type=sa.String(100))
    op.alter_column("refunds", "provider_payment_id", type_=sa.String(40), existing_type=sa.String(100))
