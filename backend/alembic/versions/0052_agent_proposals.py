"""AI agents: proposals waiting for owner approval."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0052"
down_revision = "0051"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_proposals",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("agent", sa.String(30), nullable=False),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("dedupe_key", sa.String(120), nullable=False),
        sa.Column("summary", sa.String(500), nullable=False),
        sa.Column("details", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("params", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("permission", sa.String(30), nullable=False),
        sa.Column("status", sa.String(10), nullable=False, server_default="pending"),
        sa.Column("result", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decided_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.UniqueConstraint("dedupe_key", name=op.f("uq_agent_proposals_dedupe_key")),
        sa.CheckConstraint("status IN ('pending','running','done','rejected','expired','failed')", name=op.f("ck_agent_proposals_status")),
    )
    op.create_index(op.f("ix_agent_proposals_agent"), "agent_proposals", ["agent"])
    op.create_index(op.f("ix_agent_proposals_status"), "agent_proposals", ["status"])


def downgrade() -> None:
    op.drop_table("agent_proposals")
