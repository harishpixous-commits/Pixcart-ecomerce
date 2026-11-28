"""products.publish_notified_at: the seller was told a scheduled product went live"""
import sqlalchemy as sa
from alembic import op

revision = "0066"
down_revision = "0065"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("products", sa.Column("publish_notified_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("products", "publish_notified_at")
