"""Photos a customer attaches to a return request."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0046"
down_revision = "0045"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("return_requests", sa.Column("photos", JSONB(), nullable=False, server_default="[]"))


def downgrade() -> None:
    op.drop_column("return_requests", "photos")
