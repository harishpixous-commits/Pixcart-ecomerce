"""deals (lightning, deal of the day, limited time) and sponsored products

Revision ID: 0009
Revises: 0008
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def _ts():
    return [sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)]


def upgrade() -> None:
    # sponsored-product charges go to the seller ledger; the home page gets new block types
    op.drop_constraint(op.f("ck_seller_ledger_kind"), "seller_ledger", type_="check")
    op.create_check_constraint(op.f("ck_seller_ledger_kind"), "seller_ledger", "kind IN ('sale','commission','commission_gst','tcs','tds','return','commission_reversal','commission_gst_reversal','tcs_reversal','tds_reversal','adjustment','payout_reversal','ad_spend')")
    op.drop_constraint(op.f("ck_home_sections_kind"), "home_sections", type_="check")
    op.create_check_constraint(op.f("ck_home_sections_kind"), "home_sections", "kind IN ('hero','categories','products','banner','banner_grid','text','usp','recent','cards','deals','sponsored','countdown','signin','inspired','buy_again')")

    op.create_table(
        "deals",
        sa.Column("seller_id", sa.UUID(), nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("variant_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=12), nullable=False),
        sa.Column("deal_price_paise", sa.BigInteger(), nullable=False),
        sa.Column("regular_price_paise", sa.BigInteger(), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("qty_limit", sa.Integer(), nullable=True),
        sa.Column("sold_qty", sa.Integer(), server_default="0", nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("note", sa.String(length=300), server_default="", nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        *_ts(),
        sa.CheckConstraint("kind IN ('lightning','deal_of_day','limited')", name=op.f("ck_deals_kind")),
        sa.CheckConstraint("status IN ('pending','approved','rejected','active','ended','cancelled')", name=op.f("ck_deals_status")),
        sa.CheckConstraint("deal_price_paise > 0", name=op.f("ck_deals_price")),
        sa.CheckConstraint("ends_at > starts_at", name=op.f("ck_deals_window")),
        sa.ForeignKeyConstraint(["seller_id"], ["sellers.id"], name=op.f("fk_deals_seller_id_sellers"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], name=op.f("fk_deals_product_id_products"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["variant_id"], ["variants.id"], name=op.f("fk_deals_variant_id_variants"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_deals")),
    )
    for col in ("seller_id", "product_id", "variant_id", "status"):
        op.create_index(op.f(f"ix_deals_{col}"), "deals", [col], unique=False)
    op.create_index("ix_deals_status_starts_at", "deals", ["status", "starts_at"], unique=False)

    op.create_table(
        "ad_campaigns",
        sa.Column("seller_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("placements", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("keywords", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("bid_paise", sa.BigInteger(), nullable=False),
        sa.Column("daily_budget_paise", sa.BigInteger(), nullable=False),
        sa.Column("total_budget_paise", sa.BigInteger(), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("spend_paise", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("note", sa.String(length=300), server_default="", nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        *_ts(),
        sa.CheckConstraint("status IN ('pending','active','paused','rejected','ended')", name=op.f("ck_ad_campaigns_status")),
        sa.CheckConstraint("bid_paise > 0 AND daily_budget_paise > 0", name=op.f("ck_ad_campaigns_money")),
        sa.ForeignKeyConstraint(["seller_id"], ["sellers.id"], name=op.f("fk_ad_campaigns_seller_id_sellers"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ad_campaigns")),
    )
    op.create_index(op.f("ix_ad_campaigns_seller_id"), "ad_campaigns", ["seller_id"], unique=False)
    op.create_index(op.f("ix_ad_campaigns_status"), "ad_campaigns", ["status"], unique=False)

    op.create_table(
        "ad_campaign_products",
        sa.Column("campaign_id", sa.UUID(), nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(["campaign_id"], ["ad_campaigns.id"], name=op.f("fk_ad_campaign_products_campaign_id_ad_campaigns"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], name=op.f("fk_ad_campaign_products_product_id_products"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("campaign_id", "product_id", name=op.f("pk_ad_campaign_products")),
    )
    op.create_table(
        "ad_stats",
        sa.Column("campaign_id", sa.UUID(), nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("impressions", sa.Integer(), server_default="0", nullable=False),
        sa.Column("clicks", sa.Integer(), server_default="0", nullable=False),
        sa.Column("spend_paise", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("billed", sa.Boolean(), server_default="false", nullable=False),
        sa.ForeignKeyConstraint(["campaign_id"], ["ad_campaigns.id"], name=op.f("fk_ad_stats_campaign_id_ad_campaigns"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], name=op.f("fk_ad_stats_product_id_products"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("campaign_id", "product_id", "day", name=op.f("pk_ad_stats")),
    )
    op.create_table(
        "ad_clicks",
        sa.Column("campaign_id", sa.UUID(), nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("placement", sa.String(length=10), nullable=False),
        sa.Column("visitor", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("cost_paise", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(["campaign_id"], ["ad_campaigns.id"], name=op.f("fk_ad_clicks_campaign_id_ad_campaigns"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], name=op.f("fk_ad_clicks_product_id_products"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_ad_clicks_user_id_users"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ad_clicks")),
    )
    for col in ("campaign_id", "visitor", "user_id", "created_at"):
        op.create_index(op.f(f"ix_ad_clicks_{col}"), "ad_clicks", [col], unique=False)


def downgrade() -> None:
    op.execute("DELETE FROM seller_ledger WHERE kind = 'ad_spend'")
    op.drop_constraint(op.f("ck_seller_ledger_kind"), "seller_ledger", type_="check")
    op.create_check_constraint(op.f("ck_seller_ledger_kind"), "seller_ledger", "kind IN ('sale','commission','commission_gst','tcs','tds','return','commission_reversal','commission_gst_reversal','tcs_reversal','tds_reversal','adjustment','payout_reversal')")
    op.execute("DELETE FROM home_sections WHERE kind IN ('cards','deals','sponsored','countdown','signin','inspired','buy_again')")
    op.drop_constraint(op.f("ck_home_sections_kind"), "home_sections", type_="check")
    op.create_check_constraint(op.f("ck_home_sections_kind"), "home_sections", "kind IN ('hero','categories','products','banner','banner_grid','text','usp','recent')")
    op.drop_table("ad_clicks")
    op.drop_table("ad_stats")
    op.drop_table("ad_campaign_products")
    op.drop_table("ad_campaigns")
    op.drop_table("deals")
