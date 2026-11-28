"""url_redirects: old address to new address"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0059"
down_revision = "0058"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "url_redirects",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("from_path", sa.String(300), nullable=False, unique=True),
        sa.Column("to_path", sa.String(500), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=False, server_default="301"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("hits", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_table("url_redirects")
