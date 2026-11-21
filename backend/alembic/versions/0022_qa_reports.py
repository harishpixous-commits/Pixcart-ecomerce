"""product questions and answers: who reported each post, so every person counts once towards hiding it

Revision ID: 0022
Revises: 0017
"""
import sqlalchemy as sa
from alembic import op

revision = "0022"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "question_reports",
        sa.Column("question_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["question_id"], ["product_questions.id"], name=op.f("fk_question_reports_question_id_product_questions"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_question_reports_user_id_users"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("question_id", "user_id", name=op.f("pk_question_reports")),
    )
    op.create_table(
        "answer_reports",
        sa.Column("answer_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["answer_id"], ["product_answers.id"], name=op.f("fk_answer_reports_answer_id_product_answers"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_answer_reports_user_id_users"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("answer_id", "user_id", name=op.f("pk_answer_reports")),
    )


def downgrade() -> None:
    op.drop_table("answer_reports")
    op.drop_table("question_reports")
