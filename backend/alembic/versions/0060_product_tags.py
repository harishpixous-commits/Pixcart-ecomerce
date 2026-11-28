"""products.tags: short lower-case labels for grouping and collection rules"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0060"
down_revision = "0059"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("products", sa.Column("tags", postgresql.JSONB(), nullable=False, server_default="[]"))
    op.add_column("product_collections", sa.Column("tag", sa.String(30), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("product_collections", "tag")
    op.drop_column("products", "tags")
