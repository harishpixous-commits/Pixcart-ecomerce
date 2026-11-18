"""product page and reviews: product information (Legal Metrology), unit price, dispatch cut-off,
review photos/videos, helpful votes, review and product reports

Revision ID: 0008
Revises: 0007
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # product information and unit price
    op.add_column("products", sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False))
    op.add_column("variants", sa.Column("net_qty", sa.Numeric(12, 3), nullable=True))
    op.add_column("categories", sa.Column("required_details", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False))
    op.add_column("sellers", sa.Column("dispatch_cutoff", sa.String(length=5), server_default="", nullable=False))
    op.create_index(op.f("ix_order_items_product_id"), "order_items", ["product_id"], unique=False)

    # reviews: photos and videos, verified flag, reports, a "pending" state
    op.alter_column("reviews", "sub_order_id", existing_type=sa.UUID(), nullable=True)
    op.add_column("reviews", sa.Column("verified", sa.Boolean(), server_default="true", nullable=False))
    op.add_column("reviews", sa.Column("media", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False))
    op.add_column("reviews", sa.Column("media_status", sa.String(length=10), server_default="published", nullable=False))
    op.add_column("reviews", sa.Column("report_count", sa.Integer(), server_default="0", nullable=False))
    op.drop_constraint(op.f("ck_reviews_status"), "reviews", type_="check")
    # Reviews held for moderation used to be stored as "hidden"; they are "pending" from now on.
    op.execute("UPDATE reviews SET status = 'pending' WHERE status = 'hidden' AND seller_reply = '' AND helpful_count = 0 "
               "AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.entity_id = reviews.id::text AND a.action = 'review.hide')")
    op.create_check_constraint(op.f("ck_reviews_status"), "reviews", "status IN ('published','pending','hidden')")
    op.create_check_constraint(op.f("ck_reviews_media_status"), "reviews", "media_status IN ('published','pending','hidden')")
    op.create_index("ix_reviews_product_status", "reviews", ["product_id", "status"], unique=False)

    op.create_table(
        "review_votes",
        sa.Column("review_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["review_id"], ["reviews.id"], name=op.f("fk_review_votes_review_id_reviews"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_review_votes_user_id_users"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("review_id", "user_id", name=op.f("pk_review_votes")),
    )
    op.create_table(
        "review_reports",
        sa.Column("review_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("reason", sa.String(length=20), nullable=False),
        sa.Column("note", sa.String(length=500), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(["review_id"], ["reviews.id"], name=op.f("fk_review_reports_review_id_reviews"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_review_reports_user_id_users"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_review_reports")),
        sa.UniqueConstraint("review_id", "user_id", name="uq_review_reports_review_user"),
    )
    op.create_index(op.f("ix_review_reports_review_id"), "review_reports", ["review_id"], unique=False)
    op.create_index(op.f("ix_review_reports_status"), "review_reports", ["status"], unique=False)

    op.create_table(
        "product_reports",
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("seller_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("reason", sa.String(length=20), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("url", sa.String(length=400), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("admin_note", sa.Text(), nullable=False),
        sa.Column("seller_note", sa.Text(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by", sa.UUID(), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("status IN ('open','resolved','dismissed')", name=op.f("ck_product_reports_status")),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], name=op.f("fk_product_reports_product_id_products"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["seller_id"], ["sellers.id"], name=op.f("fk_product_reports_seller_id_sellers"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_product_reports_user_id_users"), ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["resolved_by"], ["users.id"], name=op.f("fk_product_reports_resolved_by_users"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product_reports")),
    )
    op.create_index(op.f("ix_product_reports_product_id"), "product_reports", ["product_id"], unique=False)
    op.create_index(op.f("ix_product_reports_seller_id"), "product_reports", ["seller_id"], unique=False)
    op.create_index(op.f("ix_product_reports_status"), "product_reports", ["status"], unique=False)


def downgrade() -> None:
    op.drop_table("product_reports")
    op.drop_table("review_reports")
    op.drop_table("review_votes")
    op.drop_index("ix_reviews_product_status", table_name="reviews")
    op.drop_constraint(op.f("ck_reviews_media_status"), "reviews", type_="check")
    op.drop_constraint(op.f("ck_reviews_status"), "reviews", type_="check")
    op.execute("UPDATE reviews SET status = 'hidden' WHERE status = 'pending'")
    op.create_check_constraint(op.f("ck_reviews_status"), "reviews", "status IN ('published','hidden')")
    op.drop_column("reviews", "report_count")
    op.drop_column("reviews", "media_status")
    op.drop_column("reviews", "media")
    op.drop_column("reviews", "verified")
    op.execute("DELETE FROM reviews WHERE sub_order_id IS NULL")
    op.alter_column("reviews", "sub_order_id", existing_type=sa.UUID(), nullable=False)
    op.drop_index(op.f("ix_order_items_product_id"), table_name="order_items")
    op.drop_column("sellers", "dispatch_cutoff")
    op.drop_column("categories", "required_details")
    op.drop_column("variants", "net_qty")
    op.drop_column("products", "details")
