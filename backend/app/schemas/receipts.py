"""Request bodies for the receipts routes (app/api/v1/receipts.py)."""

import uuid
from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field


class CreateReceiptRequest(BaseModel):
    image_urls: list[str] = Field(..., min_length=1)
    note: Optional[str] = Field(None, max_length=500)


class Assignment(BaseModel):
    user_id: uuid.UUID
    value: str = Field("1", max_length=20)


class ItemIn(BaseModel):
    id: Optional[int] = None  # keeps what the AI read (raw text, confidence) for existing lines
    name: str = Field(..., min_length=1, max_length=200)
    quantity: str = Field("1", max_length=20)
    unit: Literal["each", "kg", "g", "l", "ml"] = "each"
    price: str = Field(..., max_length=20)  # line price before discounts
    category: Optional[str] = Field(None, max_length=40)
    flags: list[str] = Field(default_factory=list, max_length=6)
    split_mode: str = "equal"
    assignments: list[Assignment] = Field(default_factory=list, max_length=200)


class AdjustmentIn(BaseModel):
    kind: str
    label: str = Field(..., min_length=1, max_length=200)
    amount: Optional[str] = Field(None, max_length=20)  # negative = discount; ignored when percent is set on our own discounts
    percent: Optional[str] = Field(None, max_length=10)
    item_indexes: list[int] = Field(default_factory=list, max_length=500)
    allocation: str = "proportional"
    assignee_ids: list[uuid.UUID] = Field(default_factory=list, max_length=200)
    source: Literal["printed", "store_rule", "manual"] = "manual"
    enabled: bool = True


class PayerIn(BaseModel):
    user_id: uuid.UUID
    # Ignored when only one person paid: they always pay the whole bill
    amount: str = Field("0", max_length=20)


class UpdateReceiptRequest(BaseModel):
    store_name: Optional[str] = Field(None, max_length=120)
    currency: str = Field(..., min_length=3, max_length=3)
    printed_total: Optional[str] = Field(None, max_length=20)
    items: list[ItemIn] = Field(..., max_length=500)
    adjustments: list[AdjustmentIn] = Field(default_factory=list, max_length=100)
    # None = whoever uploaded it paid everything
    payers: Optional[list[PayerIn]] = Field(None, max_length=200)


class SaveReceiptRequest(BaseModel):
    description: Optional[str] = Field(None, max_length=200)
    category: str = "groceries"
    spent_at: Optional[datetime] = None


class SplitRuleBody(BaseModel):
    category: str = Field(max_length=40)
    user_ids: list[uuid.UUID] = Field(default_factory=list, max_length=100)  # empty = everyone


class SplitRulesRequest(BaseModel):
    rules: list[SplitRuleBody] = Field(default_factory=list, max_length=30)
