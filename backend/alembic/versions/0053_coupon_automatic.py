"""coupons.is_automatic: a coupon applied at checkout with no code (Growth, Automatic discounts)"""
import sqlalchemy as sa
from alembic import op

revision = "0053"
down_revision = "0052"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("coupons", sa.Column("is_automatic", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("coupons", "is_automatic")
