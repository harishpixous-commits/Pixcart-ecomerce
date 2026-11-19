"""saved for later (cart)

Revision ID: 0010
Revises: 0009
"""
import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "saved_items",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("variant_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_saved_items_user_id_users"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["variant_id"], ["variants.id"], name=op.f("fk_saved_items_variant_id_variants"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "variant_id", name=op.f("pk_saved_items")),
    )


def downgrade() -> None:
    op.drop_table("saved_items")
