"""bad weather bonus for delivery partners: an amount per trip finished while the bad weather fee is on

Revision ID: 0017
Revises: 0016
"""
import sqlalchemy as sa
from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("delivery_assignments", sa.Column("bonus_paise", sa.BigInteger(), server_default="0", nullable=False))
    op.drop_constraint(op.f("ck_delivery_assignments_money"), "delivery_assignments", type_="check")
    op.create_check_constraint(op.f("ck_delivery_assignments_money"), "delivery_assignments",
                               "cod_collected >= 0 AND cod_amount >= 0 AND fee_paise >= 0 AND bonus_paise >= 0")


def downgrade() -> None:
    # a bonus already earned stays earned: it moves into the trip fee
    op.execute("UPDATE delivery_assignments SET fee_paise = fee_paise + bonus_paise WHERE bonus_paise > 0")
    op.drop_constraint(op.f("ck_delivery_assignments_money"), "delivery_assignments", type_="check")
    op.create_check_constraint(op.f("ck_delivery_assignments_money"), "delivery_assignments", "cod_collected >= 0 AND cod_amount >= 0 AND fee_paise >= 0")
    op.drop_column("delivery_assignments", "bonus_paise")
