"""own delivery fleet collects customers' returns: pickup trips linked to the return, the customer's pickup code

Revision ID: 0016
Revises: 0015
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("delivery_assignments", sa.Column("return_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(op.f("fk_delivery_assignments_return_id_return_requests"), "delivery_assignments", "return_requests", ["return_id"], ["id"],
                          ondelete="SET NULL")
    op.create_index(op.f("ix_delivery_assignments_return_id"), "delivery_assignments", ["return_id"])
    op.drop_constraint(op.f("ck_delivery_assignments_kind"), "delivery_assignments", type_="check")
    op.create_check_constraint(op.f("ck_delivery_assignments_kind"), "delivery_assignments", "kind IN ('delivery','return','pickup')")
    op.add_column("return_requests", sa.Column("fleet_requested_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("return_requests", sa.Column("fleet_alerted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("return_requests", sa.Column("pickup_otp", sa.String(length=6), server_default="", nullable=False))


def downgrade() -> None:
    op.drop_column("return_requests", "pickup_otp")
    op.drop_column("return_requests", "fleet_alerted_at")
    op.drop_column("return_requests", "fleet_requested_at")
    op.execute("DELETE FROM delivery_assignments WHERE kind = 'pickup'")
    op.drop_constraint(op.f("ck_delivery_assignments_kind"), "delivery_assignments", type_="check")
    op.create_check_constraint(op.f("ck_delivery_assignments_kind"), "delivery_assignments", "kind IN ('delivery','return')")
    op.drop_index(op.f("ix_delivery_assignments_return_id"), table_name="delivery_assignments")
    op.drop_constraint(op.f("fk_delivery_assignments_return_id_return_requests"), "delivery_assignments", type_="foreignkey")
    op.drop_column("delivery_assignments", "return_id")
