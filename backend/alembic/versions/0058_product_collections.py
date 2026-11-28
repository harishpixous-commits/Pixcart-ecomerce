"""product_collections: pages of chosen products"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0058"
down_revision = "0057"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "product_collections",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("slug", sa.String(80), nullable=False, unique=True),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("description", sa.String(1000), nullable=False, server_default=""),
        sa.Column("image_url", sa.String(500), nullable=False, server_default=""),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("product_ids", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("category_slug", sa.String(120), nullable=False, server_default=""),
        sa.Column("brand", sa.String(80), nullable=False, server_default=""),
        sa.Column("min_price_paise", sa.BigInteger()),
        sa.Column("max_price_paise", sa.BigInteger()),
    )


def downgrade() -> None:
    op.drop_table("product_collections")
