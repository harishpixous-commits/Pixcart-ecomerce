"""users.staff_note and users.staff_tags: private staff notes and labels on a customer"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0055"
down_revision = "0054"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("staff_note", sa.Text(), nullable=False, server_default=""))
    op.add_column("users", sa.Column("staff_tags", postgresql.JSONB(), nullable=False, server_default="[]"))


def downgrade() -> None:
    op.drop_column("users", "staff_tags")
    op.drop_column("users", "staff_note")
