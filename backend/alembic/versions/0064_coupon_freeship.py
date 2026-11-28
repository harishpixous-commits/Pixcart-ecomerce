"""coupons.kind gains 'freeship': a typed platform code that makes delivery free for the order"""
from alembic import op

revision = "0064"
down_revision = "0063"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_coupons_kind"), "coupons", type_="check")
    op.create_check_constraint(op.f("ck_coupons_kind"), "coupons", "kind IN ('percent','flat','bxgy','bundle','volume','freeship')")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_coupons_kind"), "coupons", type_="check")
    op.create_check_constraint(op.f("ck_coupons_kind"), "coupons", "kind IN ('percent','flat','bxgy','bundle','volume')")
