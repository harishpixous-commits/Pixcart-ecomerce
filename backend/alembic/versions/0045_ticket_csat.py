"""Ticket satisfaction rating: the customer rates a resolved or closed request once."""
import sqlalchemy as sa
from alembic import op

revision = "0045"
down_revision = "0044"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("support_tickets", sa.Column("csat_rating", sa.Integer(), nullable=True))
    op.add_column("support_tickets", sa.Column("csat_comment", sa.String(500), nullable=False, server_default=""))
    op.add_column("support_tickets", sa.Column("csat_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint("ck_support_tickets_csat", "support_tickets", "csat_rating IS NULL OR csat_rating BETWEEN 1 AND 5")


def downgrade() -> None:
    op.drop_constraint("ck_support_tickets_csat", "support_tickets", type_="check")
    op.drop_column("support_tickets", "csat_at")
    op.drop_column("support_tickets", "csat_comment")
    op.drop_column("support_tickets", "csat_rating")
