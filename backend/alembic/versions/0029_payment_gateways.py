"""several payment gateways: longer provider references, client data, gateway health events

Revision ID: 0029
Revises: 0028
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("payments", "provider_order_id", type_=sa.String(100), existing_nullable=False)
    op.alter_column("payments", "provider_payment_id", type_=sa.String(100), existing_nullable=True)
    op.add_column("payments", sa.Column("client_data", JSONB(), nullable=True))
    op.create_table(
        "payment_gateway_events",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("gateway", sa.String(12), nullable=False),
        sa.Column("ok", sa.Boolean(), nullable=False),
        sa.Column("ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.String(300), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_payment_gateway_events_gateway_created_at", "payment_gateway_events", ["gateway", "created_at"])


def downgrade() -> None:
    op.drop_table("payment_gateway_events")
    op.drop_column("payments", "client_data")
