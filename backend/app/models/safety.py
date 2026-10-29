# backend/app/models/safety.py

"""Blocking people and reporting abuse."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserBlock(Base):
    """blocker_id blocked blocked_id: no direct messages either way, no new chats or group adds from them."""
    __tablename__ = "user_blocks"

    blocker_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    blocked_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


REPORT_REASONS = ("spam", "harassment", "scam", "inappropriate", "impersonation", "other")


class Report(Base):
    """Someone reported a person, a message or a group. App admins review these."""
    __tablename__ = "reports"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    reporter_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    reported_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("messages.id", ondelete="SET NULL"), nullable=True
    )
    reason: Mapped[str] = mapped_column(String(20))
    details: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Text the reporter chose to share: encrypted messages can only reach a reviewer this way
    evidence: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(10), default="open", index=True)  # open | resolved
    # What the review found (told to the reporter, without details): action_taken | no_violation
    outcome: Mapped[str | None] = mapped_column(String(20), nullable=True)
    resolution: Mapped[str | None] = mapped_column(String(500), nullable=True)  # admins' own note
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


REPORT_OUTCOMES = ("action_taken", "no_violation")
NOTICE_KINDS = ("warning", "report_update", "support_reply")


class AccountNotice(Base):
    """
    A message from the ShareEven team to one person, shown in the app under Notices:
    - warning: an admin warned them (says which rule and why; never who reported them)
    - report_update: a report they made was reviewed (the outcome only, never the penalty)
    - support_reply: the team answered a support request they sent
    """
    __tablename__ = "account_notices"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    title: Mapped[str] = mapped_column(String(120))
    body: Mapped[str] = mapped_column(Text)
    # warning: the rule broken (a report reason); report_update: the outcome
    reason: Mapped[str | None] = mapped_column(String(20), nullable=True)
    report_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("reports.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
