# backend/app/services/receipt_ai/schema.py

"""What the AI must return. Amounts are strings exactly as printed, so nothing is lost to floats."""

from typing import Literal

from pydantic import BaseModel, Field


class ExtractedItem(BaseModel):
    raw_text: str = Field(description="The line exactly as printed")
    name: str = Field(description="Clean, readable product name")
    quantity: str = Field(description="Units or weight, e.g. '2' or '0.535'; '1' if not printed")
    unit: Literal["each", "kg", "g", "l", "ml"]
    unit_price: str | None = Field(description="Price per unit if printed, else null")
    line_total: str = Field(description="Line price before any discount on later lines")
    category: str | None = Field(description="One of: produce, dairy, bakery, meat, fish, frozen, pantry, snacks, drinks, alcohol, household, personal_care, health, baby, pet, bags, other")
    flags: list[Literal["reduced", "deposit", "bag", "weighed", "voided", "alcohol"]]
    tax_code: str | None
    confidence: float = Field(description="0 to 1: how sure you are this line is read correctly")


class ExtractedAdjustment(BaseModel):
    kind: Literal["item_discount", "promotion", "store_discount", "coupon", "tax", "service_charge", "tip", "fee", "rounding"]
    label: str = Field(description="As printed, e.g. 'Clubcard Price', 'Meal deal saving', 'VAT 13.5%'")
    amount: str = Field(description="Negative for discounts and savings, positive for charges")
    percent: str | None
    applies_to_items: list[int] = Field(description="0-based indexes into items this belongs to; empty = whole bill")
    already_included_in_items: bool = Field(
        description="True if this amount is already inside the item prices (e.g. VAT in a European receipt) and must not be added again"
    )


class ReceiptExtraction(BaseModel):
    is_receipt: bool
    store_name: str | None
    purchased_at: str | None = Field(description="ISO 8601 date or datetime if printed")
    currency: str | None = Field(description="ISO 4217 code, inferred from symbols and the country")
    prices_include_tax: bool
    items: list[ExtractedItem]
    adjustments: list[ExtractedAdjustment]
    subtotal: str | None
    total: str | None = Field(description="The final amount paid, as printed")
    payment_method: str | None
    warnings: list[str] = Field(description="Anything unclear: torn, blurry, cut off, handwritten changes")
