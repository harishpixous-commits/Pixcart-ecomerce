"""products.publish_at: scheduled go-live time for an approved product"""
import sqlalchemy as sa
from alembic import op

revision = "0065"
down_revision = "0064"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("products", sa.Column("publish_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("products", "publish_at")
