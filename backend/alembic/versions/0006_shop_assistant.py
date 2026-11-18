"""shop assistant: customer chat sessions, messages, actions and its own help knowledge base

Separate from the admin assistant's tables. Starter help articles are added by the app the first time the
knowledge base is used (app/shop_assistant/starter.py). Also grants the new shop assistant permissions.

Revision ID: 0006
Revises: 0005
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

_PERMS = {
    "owner": ["shop_assistant", "shop_assistant_kb", "shop_assistant_chats"],
    "operations": ["shop_assistant_kb", "shop_assistant_chats"],
    "support": ["shop_assistant_kb", "shop_assistant_chats"],
    "marketing": ["shop_assistant_kb"],
}


def upgrade() -> None:
    for code, perms in _PERMS.items():
        for p in perms:
            op.execute(f"UPDATE admin_roles SET permissions = permissions || '[\"{p}\"]'::jsonb WHERE code = '{code}' AND NOT permissions ? '{p}'")
    op.create_table(
        "shop_kb_articles",
        sa.Column("title", sa.String(length=160), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("keywords", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("topic", sa.String(length=20), nullable=False),
        sa.Column("link", sa.String(length=300), nullable=False),
        sa.Column("is_published", sa.Boolean(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("uses", sa.Integer(), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("topic IN ('orders','delivery','payments','returns','account','offers','selling','other')", name=op.f("ck_shop_kb_articles_topic")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_shop_kb_articles")),
    )
    op.create_table(
        "shop_chat_sessions",
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("guest_key_hash", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("language", sa.String(length=10), nullable=False),
        sa.Column("page", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("ticket_id", sa.UUID(), nullable=True),
        sa.Column("feedback", sa.SmallInteger(), nullable=True),
        sa.Column("message_count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.CheckConstraint("feedback IS NULL OR feedback IN (-1, 1)", name=op.f("ck_shop_chat_sessions_feedback")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_shop_chat_sessions_user_id_users"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["ticket_id"], ["support_tickets.id"], name=op.f("fk_shop_chat_sessions_ticket_id_support_tickets"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_shop_chat_sessions")),
    )
    op.create_index(op.f("ix_shop_chat_sessions_user_id"), "shop_chat_sessions", ["user_id"], unique=False)
    op.create_index(op.f("ix_shop_chat_sessions_updated_at"), "shop_chat_sessions", ["updated_at"], unique=False)
    op.create_table(
        "shop_chat_messages",
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("role", sa.String(length=10), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("blocks", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("model_content", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("intent", sa.String(length=30), nullable=False),
        sa.Column("mode", sa.String(length=10), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("voice", sa.Boolean(), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.CheckConstraint("role IN ('user','assistant')", name=op.f("ck_shop_chat_messages_role")),
        sa.ForeignKeyConstraint(["session_id"], ["shop_chat_sessions.id"], name=op.f("fk_shop_chat_messages_session_id_shop_chat_sessions"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_shop_chat_messages")),
    )
    op.create_index(op.f("ix_shop_chat_messages_session_id"), "shop_chat_messages", ["session_id"], unique=False)
    op.create_index(op.f("ix_shop_chat_messages_created_at"), "shop_chat_messages", ["created_at"], unique=False)
    op.create_table(
        "shop_chat_actions",
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=30), nullable=False),
        sa.Column("params", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("summary", sa.String(length=300), nullable=False),
        sa.Column("status", sa.String(length=12), nullable=False),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.CheckConstraint("status IN ('pending','done','cancelled','failed','expired')", name=op.f("ck_shop_chat_actions_status")),
        sa.ForeignKeyConstraint(["session_id"], ["shop_chat_sessions.id"], name=op.f("fk_shop_chat_actions_session_id_shop_chat_sessions"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_shop_chat_actions_user_id_users"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_shop_chat_actions")),
    )
    op.create_index(op.f("ix_shop_chat_actions_session_id"), "shop_chat_actions", ["session_id"], unique=False)


def downgrade() -> None:
    for code, perms in _PERMS.items():
        for p in perms:
            op.execute(f"UPDATE admin_roles SET permissions = permissions - '{p}' WHERE code = '{code}'")
    op.drop_table("shop_chat_actions")
    op.drop_table("shop_chat_messages")
    op.drop_table("shop_chat_sessions")
    op.drop_table("shop_kb_articles")
