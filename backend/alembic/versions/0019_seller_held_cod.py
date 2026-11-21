"""cash on delivery collected by a seller's own courier is a ledger debit, so the payout nets it off

Revision ID: 0019
Revises: 0018
"""
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None

_KINDS = ("'sale','commission','commission_gst','tcs','tds','return','commission_reversal','commission_gst_reversal','tcs_reversal','tds_reversal',"
          "'adjustment','payout_reversal','ad_spend'")


def upgrade() -> None:
    op.drop_constraint(op.f("ck_seller_ledger_kind"), "seller_ledger", type_="check")
    op.create_check_constraint(op.f("ck_seller_ledger_kind"), "seller_ledger", f"kind IN ({_KINDS},'cod_collected')")


def downgrade() -> None:
    # a debit for cash the seller holds stays on the books as an adjustment
    op.execute("UPDATE seller_ledger SET kind = 'adjustment' WHERE kind = 'cod_collected'")
    op.drop_constraint(op.f("ck_seller_ledger_kind"), "seller_ledger", type_="check")
    op.create_check_constraint(op.f("ck_seller_ledger_kind"), "seller_ledger", f"kind IN ({_KINDS})")
