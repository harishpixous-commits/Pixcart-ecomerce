"""products.seo_title and seo_description: the search engine listing the seller can write"""
import sqlalchemy as sa
from alembic import op

revision = "0061"
down_revision = "0060"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("products", sa.Column("seo_title", sa.String(70), nullable=False, server_default=""))
    op.add_column("products", sa.Column("seo_description", sa.String(160), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("products", "seo_description")
    op.drop_column("products", "seo_title")
