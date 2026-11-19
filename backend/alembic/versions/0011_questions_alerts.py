"""product questions and answers, back-in-stock alerts, wishlist price-drop alerts

Revision ID: 0011
Revises: 0010
"""
import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "product_questions",
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("text", sa.String(length=500), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("answer_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("report_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.CheckConstraint("status IN ('published','pending','hidden')", name=op.f("ck_product_questions_status")),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], name=op.f("fk_product_questions_product_id_products"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_product_questions_user_id_users"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product_questions")),
    )
    op.create_index(op.f("ix_product_questions_product_id"), "product_questions", ["product_id"], unique=False)
    op.create_index(op.f("ix_product_questions_status"), "product_questions", ["status"], unique=False)
    op.create_index("ix_product_questions_product_status", "product_questions", ["product_id", "status"], unique=False)
    op.create_table(
        "product_answers",
        sa.Column("question_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("role", sa.String(length=10), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("helpful_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("report_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.CheckConstraint("status IN ('published','pending','hidden')", name=op.f("ck_product_answers_status")),
        sa.CheckConstraint("role IN ('seller','buyer','customer','staff')", name=op.f("ck_product_answers_role")),
        sa.ForeignKeyConstraint(["question_id"], ["product_questions.id"], name=op.f("fk_product_answers_question_id_product_questions"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_product_answers_user_id_users"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product_answers")),
    )
    op.create_index(op.f("ix_product_answers_question_id"), "product_answers", ["question_id"], unique=False)
    op.create_index(op.f("ix_product_answers_status"), "product_answers", ["status"], unique=False)
    op.create_table(
        "answer_votes",
        sa.Column("answer_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["answer_id"], ["product_answers.id"], name=op.f("fk_answer_votes_answer_id_product_answers"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_answer_votes_user_id_users"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("answer_id", "user_id", name=op.f("pk_answer_votes")),
    )
    op.create_table(
        "stock_alerts",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("variant_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("notified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("active", sa.Boolean(), server_default="true", nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_stock_alerts_user_id_users"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["variant_id"], ["variants.id"], name=op.f("fk_stock_alerts_variant_id_variants"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "variant_id", name=op.f("pk_stock_alerts")),
    )
    op.create_index(op.f("ix_stock_alerts_notified_at"), "stock_alerts", ["notified_at"], unique=False)
    # wishlist price-drop alerts: the price when saved and the last price we alerted at
    op.add_column("wishlist_items", sa.Column("price_at_add", sa.BigInteger(), nullable=True))
    op.add_column("wishlist_items", sa.Column("alerted_price", sa.BigInteger(), nullable=True))
    op.execute("UPDATE wishlist_items w SET price_at_add = p.price_from FROM products p WHERE p.id = w.product_id")


def downgrade() -> None:
    op.drop_column("wishlist_items", "alerted_price")
    op.drop_column("wishlist_items", "price_at_add")
    op.drop_table("stock_alerts")
    op.drop_table("answer_votes")
    op.drop_table("product_answers")
    op.drop_table("product_questions")
