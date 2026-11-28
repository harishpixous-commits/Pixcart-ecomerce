"""A size guide table per category, shown on product pages."""
import sqlalchemy as sa
from alembic import op

revision = "0047"
down_revision = "0046"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("categories", sa.Column("size_guide", sa.Text(), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("categories", "size_guide")
