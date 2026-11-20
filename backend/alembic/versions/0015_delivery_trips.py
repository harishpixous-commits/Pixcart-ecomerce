"""delivery trips: the tip paid to the partner, and return-to-seller trips

Revision ID: 0015
Revises: 0014
"""
import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("delivery_assignments", sa.Column("kind", sa.String(length=8), server_default="delivery", nullable=False))
    op.add_column("delivery_assignments", sa.Column("tip_paise", sa.BigInteger(), server_default="0", nullable=False))
    op.create_check_constraint(op.f("ck_delivery_assignments_kind"), "delivery_assignments", "kind IN ('delivery','return')")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_delivery_assignments_kind"), "delivery_assignments", type_="check")
    op.drop_column("delivery_assignments", "tip_paise")
    op.drop_column("delivery_assignments", "kind")
