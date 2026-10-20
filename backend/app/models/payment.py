# backend/app/models/payment.py

"""
Payments for ShareEven Pro: one row per checkout (a Razorpay order), created before the person pays.

Pro is a one-off payment for a month or a year (no auto-renew). A paid row records the stretch of
Pro it bought (pro_from → pro_until), so a refund can take back the right number of days.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Payment(Base):
    __tablename__ = "payments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Kept when the account is deleted (accounts and tax need the payment), without the person
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    provider: Mapped[str] = mapped_column(String(20))  # razorpay
    order_id: Mapped[str] = mapped_column(String(64), unique=True)
    payment_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    billing: Mapped[str] = mapped_column(String(10))  # monthly | yearly
    currency: Mapped[str] = mapped_column(String(3))
    amount_minor: Mapped[int] = mapped_column(Integer)  # the server's price when the order was made
    # created → paid | failed (the person can retry the same order) | mismatch (paid the wrong amount:
    # never turns Pro on, look at it by hand); paid → refunded | partially_refunded
    status: Mapped[str] = mapped_column(String(20), default="created", server_default="created")
    error: Mapped[str | None] = mapped_column(String(300), nullable=True)
    pro_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    pro_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # {refund_id: amount_minor}: each refund counted once however often Razorpay tells us
    refunds: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    refunded_minor: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    raw_event: Mapped[dict | None] = mapped_column(JSONB, nullable=True)  # the last thing Razorpay said about it
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
