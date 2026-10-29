# backend/app/models/support.py

"""Support requests: someone asks the ShareEven team for help (a bug, a payment, their account...)."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

SUPPORT_CATEGORIES = ("bug", "payment", "account", "feedback", "other")
SUPPORT_STATUSES = ("open", "closed")


class SupportTicket(Base):
    """One request and the team's answer. Deleting the account deletes its requests."""
    __tablename__ = "support_tickets"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    category: Mapped[str] = mapped_column(String(20))
    subject: Mapped[str] = mapped_column(String(120))
    message: Mapped[str] = mapped_column(Text)
    # Where it was sent from, e.g. "Android 0.9.11-beta" (helps reproduce bugs)
    app_info: Mapped[str | None] = mapped_column(String(100), nullable=True)
    status: Mapped[str] = mapped_column(String(10), default="open", index=True)
    # The team's answer, shown to the person (also sent to them as a notice)
    reply: Mapped[str | None] = mapped_column(Text, nullable=True)
    replied_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    replied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
