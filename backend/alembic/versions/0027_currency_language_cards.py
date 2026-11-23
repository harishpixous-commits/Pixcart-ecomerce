"""currencies, languages and saved cards

- orders.currency / orders.fx_rate: the shopper's currency and the rate fixed when the order was placed
  (the books stay in rupees; grand_total and every other amount are still paise)
- payments.currency / payments.charge_amount: what Razorpay charged, in that currency's smallest unit
- users.razorpay_customer_id: the shopper's Razorpay customer, for cards saved with Razorpay (tokenised, never stored here)
- translations: the site's words in each language, from the AI or corrected by staff

Revision ID: 0027
Revises: 0026
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("orders", sa.Column("currency", sa.String(3), nullable=False, server_default="INR"))
    op.add_column("orders", sa.Column("fx_rate", sa.Numeric(20, 10), nullable=False, server_default="1"))
    op.add_column("payments", sa.Column("currency", sa.String(3), nullable=False, server_default="INR"))
    op.add_column("payments", sa.Column("charge_amount", sa.BigInteger(), nullable=True))
    op.add_column("users", sa.Column("razorpay_customer_id", sa.String(40), nullable=True))
    op.create_table(
        "translations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("lang", sa.String(12), nullable=False),
        sa.Column("source_hash", sa.String(40), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("origin", sa.String(8), nullable=False, server_default="ai"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("lang", "source_hash", name="uq_translations_lang_source"),
    )
    op.create_index("ix_translations_lang_origin", "translations", ["lang", "origin"])


def downgrade() -> None:
    op.drop_index("ix_translations_lang_origin", table_name="translations")
    op.drop_table("translations")
    op.drop_column("users", "razorpay_customer_id")
    op.drop_column("payments", "charge_amount")
    op.drop_column("payments", "currency")
    op.drop_column("orders", "fx_rate")
    op.drop_column("orders", "currency")
