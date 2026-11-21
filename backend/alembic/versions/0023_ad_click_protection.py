"""sponsored products: one-use click links tied to the impression and visitor they were shown to, limits on charged
clicks per address and network, invalid clicks in the reports

Revision ID: 0023
Revises: 0022
"""
import sqlalchemy as sa
from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ad_impressions",
        sa.Column("visitor", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("clicked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ad_impressions")),
    )
    op.create_index(op.f("ix_ad_impressions_created_at"), "ad_impressions", ["created_at"], unique=False)
    op.add_column("ad_stats", sa.Column("invalid_clicks", sa.Integer(), server_default="0", nullable=False))
    op.add_column("ad_clicks", sa.Column("ip_hash", sa.String(length=32), server_default="", nullable=False))
    op.add_column("ad_clicks", sa.Column("net_hash", sa.String(length=32), server_default="", nullable=False))
    op.create_index(op.f("ix_ad_clicks_campaign_day"), "ad_clicks", ["campaign_id", "created_at"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_ad_clicks_campaign_day"), table_name="ad_clicks")
    op.drop_column("ad_clicks", "net_hash")
    op.drop_column("ad_clicks", "ip_hash")
    op.drop_column("ad_stats", "invalid_clicks")
    op.drop_index(op.f("ix_ad_impressions_created_at"), table_name="ad_impressions")
    op.drop_table("ad_impressions")
