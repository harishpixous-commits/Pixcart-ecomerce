"""staff roles for the delivery fleet: a "Delivery manager" role, and the delivery permission for Operations

Revision ID: 0013
Revises: 0012
"""
import json

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None

MANAGER = ["dashboard", "assistant", "delivery", "orders", "customers", "support"]


def upgrade() -> None:
    conn = op.get_bind()
    if conn.execute(sa.text("SELECT count(*) FROM admin_roles")).scalar() == 0:
        return  # a new install: the app seeds every default role (including these) on first use
    if not conn.execute(sa.text("SELECT 1 FROM admin_roles WHERE code = 'delivery_manager'")).first():
        conn.execute(sa.text(
            "INSERT INTO admin_roles (code, name, description, permissions, is_locked, created_at, updated_at) "
            "VALUES ('delivery_manager', 'Delivery manager', :d, CAST(:p AS jsonb), false, now(), now())"),
            {"d": "Delivery partners, zones, assignment, live tracking and cash; orders and customers to help them.", "p": json.dumps(MANAGER)})
    row = conn.execute(sa.text("SELECT permissions FROM admin_roles WHERE code = 'operations'")).first()
    if row is not None:
        perms = list(row[0] or [])
        if "delivery" not in perms:
            conn.execute(sa.text("UPDATE admin_roles SET permissions = CAST(:p AS jsonb), updated_at = now() WHERE code = 'operations'"),
                         {"p": json.dumps([*perms, "delivery"])})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM admin_roles WHERE code = 'delivery_manager'"))
