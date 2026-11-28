"""coupons: buy X get Y kind (buy_qty, get_qty; value = percent off the discounted units)"""
import sqlalchemy as sa
from alembic import op

revision = "0054"
down_revision = "0053"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("coupons", sa.Column("buy_qty", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("coupons", sa.Column("get_qty", sa.Integer(), nullable=False, server_default="0"))
    op.drop_constraint(op.f("ck_coupons_kind"), "coupons", type_="check")
    op.create_check_constraint(op.f("ck_coupons_kind"), "coupons", "kind IN ('percent','flat','bxgy')")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_coupons_kind"), "coupons", type_="check")
    op.create_check_constraint(op.f("ck_coupons_kind"), "coupons", "kind IN ('percent','flat')")
    op.drop_column("coupons", "get_qty")
    op.drop_column("coupons", "buy_qty")
