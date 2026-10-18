# backend/app/models/receipt.py

"""
Scanned receipts: the AI's reading of a bill, editable line by line, plus who each
line is for. The split engine (app/services/split_engine.py) turns this into shares.
"""

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Receipt(Base):
    __tablename__ = "receipts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Plain media URLs of the photos (one receipt may span several photos)
    image_urls: Mapped[list[str]] = mapped_column(ARRAY(String(500)), default=list)
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # processing | ready | needs_review | failed | saved
    status: Mapped[str] = mapped_column(String(15), default="processing")
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Which AI read it, and whose key paid for it (app | user)
    provider: Mapped[str | None] = mapped_column(String(20), nullable=True)
    model: Mapped[str | None] = mapped_column(String(80), nullable=True)
    key_source: Mapped[str | None] = mapped_column(String(10), nullable=True)
    usage: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    raw_extraction: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    store_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    store_key: Mapped[str | None] = mapped_column(String(60), nullable=True)
    purchased_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    printed_total_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    prices_include_tax: Mapped[bool] = mapped_column(Boolean, default=True)
    warnings: Mapped[list[str]] = mapped_column(ARRAY(String(300)), default=list)
    # Payers chosen in the review screen: [{"user_id": ..., "amount_minor": ...}]; empty = uploader paid
    payers: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    expense_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    items = relationship(
        "ReceiptItem", cascade="all, delete-orphan", order_by="ReceiptItem.position", lazy="selectin"
    )
    adjustments = relationship(
        "ReceiptAdjustment", cascade="all, delete-orphan", order_by="ReceiptAdjustment.position", lazy="selectin"
    )


class ReceiptItem(Base):
    __tablename__ = "receipt_items"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    receipt_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("receipts.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer)
    raw_text: Mapped[str | None] = mapped_column(String(300), nullable=True)
    name: Mapped[str] = mapped_column(String(200))
    quantity: Mapped[float] = mapped_column(Numeric(12, 3), default=1)
    unit: Mapped[str] = mapped_column(String(10), default="each")  # each | kg | g | l | ml
    unit_price_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # Line price before any discount, as printed
    gross_minor: Mapped[int] = mapped_column(BigInteger)
    category: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # reduced | deposit | bag | weighed | voided | alcohol | ...
    flags: Mapped[list[str]] = mapped_column(ARRAY(String(20)), default=list)
    tax_code: Mapped[str | None] = mapped_column(String(10), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Numeric(4, 3), nullable=True)
    # How to split this item: equal (among selected people) | quantity | weight
    split_mode: Mapped[str] = mapped_column(String(10), default="equal")
    # [{"user_id": ..., "value": "1"}] - value = units (quantity) or weight; ignored for equal
    assignments: Mapped[list] = mapped_column(JSONB, default=list)
    ai_suggestion_reason: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # Where the line is printed: {"photo": index into image_urls, "box": [x0, y0, x1, y1] as fractions of
    # the photo, "turned": degrees to turn the strip so it reads upright}. Only when the OCR read it.
    source_box: Mapped[dict | None] = mapped_column(JSONB, nullable=True)


class ReceiptAdjustment(Base):
    """Discounts, promotions, tax, fees, tips, rounding - anything that isn't an item."""
    __tablename__ = "receipt_adjustments"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    receipt_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("receipts.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer)
    # item_discount | promotion | store_discount | coupon | tax | service_charge | tip | fee | rounding
    kind: Mapped[str] = mapped_column(String(20))
    label: Mapped[str] = mapped_column(String(200))
    # Negative = discount, positive = extra charge
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    percent: Mapped[float | None] = mapped_column(Numeric(6, 3), nullable=True)
    # item | group | bill
    scope: Mapped[str] = mapped_column(String(10), default="bill")
    # receipt_items.id values this applies to (item/group scope, or the eligible items for a bill discount)
    item_ids: Mapped[list[int]] = mapped_column(ARRAY(Integer), default=list)
    # proportional (by item price) | equal (among people) | assign (to specific people)
    allocation: Mapped[str] = mapped_column(String(15), default="proportional")
    assignee_ids: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)
    # printed (on the receipt) | store_rule (from a saved discount, not printed) | manual
    source: Mapped[str] = mapped_column(String(12), default="printed")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class StoreDiscountRule(Base):
    """A person's own store discount, e.g. 'Tesco 10%, not on reduced items'."""
    __tablename__ = "store_discount_rules"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    store_name: Mapped[str] = mapped_column(String(80))
    store_key: Mapped[str] = mapped_column(String(60), index=True)
    percent: Mapped[float] = mapped_column(Numeric(5, 2))
    excluded_categories: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)
    stacks_with_reduced: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ItemPreference(Base):
    """Remembers who an item is usually for in a chat ('oat milk' -> Asha)."""
    __tablename__ = "item_preferences"

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True
    )
    item_key: Mapped[str] = mapped_column(String(120), primary_key=True)
    user_ids: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)
    times_used: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())



class SplitRule(Base):
    """A chat's standing rule: items of a category are for these people ('household' -> everyone)."""
    __tablename__ = "split_rules"

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True
    )
    category: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_ids: Mapped[list[str]] = mapped_column(ARRAY(String(40)), default=list)  # empty = everyone
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ReceiptCorrection(Base):
    """
    Something people fixed on a scanned receipt from a store, kept per chat and reused on the next
    scan: renames and categories are applied directly, the rest is told to the AI as a hint.
    kind: rename | category | price | not_item | missed_item | not_adjustment | missed_adjustment | adjustment_kind
    """
    __tablename__ = "receipt_corrections"
    __table_args__ = (UniqueConstraint("conversation_id", "store_key", "kind", "original", name="uq_receipt_correction"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    store_key: Mapped[str] = mapped_column(String(60))
    store_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    kind: Mapped[str] = mapped_column(String(20))
    original: Mapped[str] = mapped_column(String(300))  # what the AI read (normalised printed line, or a label)
    corrected: Mapped[str] = mapped_column(String(300), default="")  # what people changed it to
    times: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
