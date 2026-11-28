"""coupons.kind gains 'volume': a percentage off when the cart holds at least buy_qty units of the chosen products"""
from alembic import op

revision = "0063"
down_revision = "0062"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_coupons_kind"), "coupons", type_="check")
    op.create_check_constraint(op.f("ck_coupons_kind"), "coupons", "kind IN ('percent','flat','bxgy','bundle','volume')")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_coupons_kind"), "coupons", type_="check")
    op.create_check_constraint(op.f("ck_coupons_kind"), "coupons", "kind IN ('percent','flat','bxgy','bundle')")
