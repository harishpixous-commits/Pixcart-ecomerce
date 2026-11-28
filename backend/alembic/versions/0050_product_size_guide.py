"""A product can carry its own size guide, ahead of its category's."""
import sqlalchemy as sa
from alembic import op

revision = "0050"
down_revision = "0049"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("products", sa.Column("size_guide", sa.Text(), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("products", "size_guide")
