"""returns: one line per item in a return request; the return window saved on each order item

Revision ID: 0019
Revises: 0017
"""
import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # A request could name the same item twice. Merge such lines into one (quantities and amounts added up), never
    # more units than were ordered, and set the refund of a return still in progress to the sum of its lines.
    op.execute("""
        UPDATE return_items ri SET qty = t.qty, amount = t.amount
        FROM (SELECT return_id, order_item_id, sum(qty) AS qty, sum(amount) AS amount
              FROM return_items GROUP BY return_id, order_item_id HAVING count(*) > 1) t
        WHERE ri.return_id = t.return_id AND ri.order_item_id = t.order_item_id
    """)
    op.execute("""
        DELETE FROM return_items a USING return_items b
        WHERE a.return_id = b.return_id AND a.order_item_id = b.order_item_id AND a.id::text > b.id::text
    """)
    op.execute("""
        UPDATE return_items ri SET qty = oi.qty, amount = oi.line_total - oi.seller_discount - oi.platform_discount
        FROM order_items oi WHERE oi.id = ri.order_item_id AND ri.qty > oi.qty
    """)
    op.execute("""
        UPDATE return_requests r SET refund_amount = t.amount
        FROM (SELECT return_id, sum(amount) AS amount FROM return_items GROUP BY return_id) t
        WHERE r.id = t.return_id AND r.refund_amount <> t.amount AND r.status IN ('requested', 'approved', 'picked_up')
    """)
    op.create_unique_constraint("uq_return_items_return_order_item", "return_items", ["return_id", "order_item_id"])

    # The return window promised at the sale is kept on the order item. Orders placed before this have only the
    # listing's current window to go by.
    op.add_column("order_items", sa.Column("return_window_days", sa.Integer(), server_default="0", nullable=False))
    op.execute("UPDATE order_items oi SET return_window_days = p.return_window_days FROM products p WHERE p.id = oi.product_id")


def downgrade() -> None:
    op.drop_column("order_items", "return_window_days")
    op.drop_constraint("uq_return_items_return_order_item", "return_items", type_="unique")
