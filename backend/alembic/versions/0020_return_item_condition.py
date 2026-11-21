"""a received return item is either back in sellable stock or damaged (kept out of stock)

Revision ID: 0020
Revises: 0019
"""
import sqlalchemy as sa
from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("return_items", sa.Column("condition", sa.String(length=10), server_default="", nullable=False))
    # returns received before this change were all put back in stock
    op.execute("UPDATE return_items SET condition = 'sellable' FROM return_requests r WHERE r.id = return_items.return_id "
               "AND r.status IN ('received', 'refunded')")
    op.create_check_constraint(op.f("ck_return_items_condition"), "return_items", "condition IN ('','sellable','damaged')")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_return_items_condition"), "return_items", type_="check")
    op.drop_column("return_items", "condition")
