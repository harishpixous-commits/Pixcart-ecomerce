"""Sellers can set their own free-delivery threshold."""
import sqlalchemy as sa
from alembic import op

revision = "0042"
down_revision = "0041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sellers", sa.Column("free_shipping_threshold_paise", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column("sellers", "free_shipping_threshold_paise")
