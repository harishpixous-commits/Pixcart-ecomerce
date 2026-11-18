"""product videos for the gallery and its video player

Revision ID: 0007
Revises: 0006
"""
import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "product_videos",
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("url", sa.String(length=400), nullable=False),
        sa.Column("poster_url", sa.String(length=400), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("duration_s", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], name=op.f("fk_product_videos_product_id_products"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product_videos")),
    )
    op.create_index(op.f("ix_product_videos_product_id"), "product_videos", ["product_id"], unique=False)


def downgrade() -> None:
    op.drop_table("product_videos")
