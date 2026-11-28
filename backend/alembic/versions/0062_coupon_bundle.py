"""coupons.kind gains 'bundle': a percentage off when the cart holds every product of a set"""
from alembic import op

revision = "0062"
down_revision = "0061"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_coupons_kind"), "coupons", type_="check")
    op.create_check_constraint(op.f("ck_coupons_kind"), "coupons", "kind IN ('percent','flat','bxgy','bundle')")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_coupons_kind"), "coupons", type_="check")
    op.create_check_constraint(op.f("ck_coupons_kind"), "coupons", "kind IN ('percent','flat','bxgy')")
