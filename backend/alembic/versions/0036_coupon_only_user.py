"""A coupon can belong to one user (codes made from loyalty points and gift cards)."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0036"
down_revision = "0035"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("coupons", sa.Column("only_user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE", name="fk_coupons_only_user_id_users"), nullable=True))


def downgrade() -> None:
    op.drop_column("coupons", "only_user_id")
