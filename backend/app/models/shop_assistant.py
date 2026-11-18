"""Tables of the customer-facing shop assistant (the chat on the storefront).

Kept apart from the admin assistant's tables on purpose: nothing here is shared with staff conversations,
uploads or actions, and the admin assistant's tables are never read by the shop assistant.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, SmallInteger, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdMixin, TimestampMixin

KB_TOPICS = ("orders", "delivery", "payments", "returns", "account", "offers", "selling", "other")


class ShopKbArticle(IdMixin, TimestampMixin, Base):
    """A help article the shop assistant may quote to customers. Written for customers; edited by staff."""

    __tablename__ = "shop_kb_articles"

    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(Text)  # plain text / light Markdown
    keywords: Mapped[list] = mapped_column(JSONB, default=list)  # extra words customers use (any language)
    topic: Mapped[str] = mapped_column(String(20), default="other")
    link: Mapped[str] = mapped_column(String(300), default="")  # a storefront page to open, e.g. /pages/returns-policy
    is_published: Mapped[bool] = mapped_column(Boolean, default=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    uses: Mapped[int] = mapped_column(Integer, default=0)  # how often it answered a question

    __table_args__ = (CheckConstraint(f"topic IN ({','.join(repr(t) for t in KB_TOPICS)})", name="topic"),)


class ShopChatSession(IdMixin, Base):
    """One chat on the storefront. Belongs to a signed-in customer, or to a guest holding the session key."""

    __tablename__ = "shop_chat_sessions"

    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    guest_key_hash: Mapped[str] = mapped_column(String(64), default="")  # sha256 of the key only the guest's browser has
    title: Mapped[str] = mapped_column(String(120), default="New chat")
    language: Mapped[str] = mapped_column(String(10), default="")
    page: Mapped[dict] = mapped_column(JSONB, default=dict)  # where the chat was opened
    ticket_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("support_tickets.id", ondelete="SET NULL"))
    feedback: Mapped[int | None] = mapped_column(SmallInteger)  # 1 helpful, -1 not helpful
    message_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)

    __table_args__ = (CheckConstraint("feedback IS NULL OR feedback IN (-1, 1)", name="feedback"),)


class ShopChatMessage(IdMixin, Base):
    """A turn: ``blocks`` is what the customer sees (text and cards); ``model_content`` is what the model saw."""

    __tablename__ = "shop_chat_messages"

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("shop_chat_sessions.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(10))
    text: Mapped[str] = mapped_column(Text, default="")
    blocks: Mapped[list] = mapped_column(JSONB, default=list)
    model_content: Mapped[list] = mapped_column(JSONB, default=list)
    intent: Mapped[str] = mapped_column(String(30), default="")
    mode: Mapped[str] = mapped_column(String(10), default="")  # live | guided
    status: Mapped[str] = mapped_column(String(10), default="done")
    voice: Mapped[bool] = mapped_column(Boolean, default=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)

    __table_args__ = (CheckConstraint("role IN ('user','assistant')", name="role"),)


class ShopChatAction(IdMixin, Base):
    """A change the assistant prepared for the customer (e.g. cancel a package). Runs only on the customer's Confirm."""

    __tablename__ = "shop_chat_actions"

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("shop_chat_sessions.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(30))
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    summary: Mapped[str] = mapped_column(String(300))
    status: Mapped[str] = mapped_column(String(12), default="pending")
    result: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (CheckConstraint("status IN ('pending','done','cancelled','failed','expired')", name="status"),)
