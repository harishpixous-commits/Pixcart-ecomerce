"""Indexes on foreign keys that are looked up by (cart, order, refund, ledger, review, audit pages)"""
from alembic import op

revision = "0067"
down_revision = "0066"
branch_labels = None
depends_on = None

INDEXES = [
    ("cart_items", "variant_id"), ("order_items", "variant_id"), ("refunds", "sub_order_id"), ("refunds", "payment_id"),
    ("order_events", "sub_order_id"), ("seller_ledger", "sub_order_id"), ("reviews", "user_id"), ("reviews", "sub_order_id"),
    ("wishlist_items", "product_id"), ("audit_logs", "actor_user_id"), ("support_tickets", "order_id"),
    ("stock_alerts", "variant_id"), ("saved_items", "variant_id"), ("sub_orders", "warehouse_id"), ("return_items", "order_item_id"),
]


def upgrade() -> None:
    for table, col in INDEXES:
        op.execute(f"CREATE INDEX IF NOT EXISTS ix_{table}_{col} ON {table} ({col})")


def downgrade() -> None:
    for table, col in INDEXES:
        op.execute(f"DROP INDEX IF EXISTS ix_{table}_{col}")
