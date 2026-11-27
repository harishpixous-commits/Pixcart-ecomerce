"""Ship reminders: remember which package the seller was already reminded about."""
import sqlalchemy as sa
from alembic import op

revision = "0044"
down_revision = "0043"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sub_orders", sa.Column("ship_reminded_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("sub_orders", "ship_reminded_at")
