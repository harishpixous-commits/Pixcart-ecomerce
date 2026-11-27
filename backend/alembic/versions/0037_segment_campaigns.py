"""In-app messages staff send to a customer segment, kept as a log."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0037"
down_revision = "0036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "segment_campaigns",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("segment", sa.String(20), nullable=False),
        sa.Column("title", sa.String(80), nullable=False),
        sa.Column("message", sa.String(300), nullable=False),
        sa.Column("link", sa.String(200), nullable=False, server_default=""),
        sa.Column("recipients", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL", name="fk_segment_campaigns_created_by_users"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_segment_campaigns_created_at", "segment_campaigns", ["created_at"])


def downgrade() -> None:
    op.drop_table("segment_campaigns")
