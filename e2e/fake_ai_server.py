"""
Runs the backend with a FAKE receipt reader (no AI calls, no API key, no cost) for browser tests.
Every scan returns the same Tesco receipt.

    cd backend && python ../e2e/fake_ai_server.py      # serves http://localhost:8000
"""

import os
import sys

BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
sys.path.insert(0, os.path.abspath(BACKEND))
os.chdir(BACKEND)

import uvicorn  # noqa: E402

from app.config.settings import settings  # noqa: E402

# Browser tests sign in many times from one address: no rate limits on this test server
settings.RATE_LIMITS_ENABLED = False
from app.main import app  # noqa: E402
from app.services.receipt_ai import pipeline  # noqa: E402
from app.services.receipt_ai.base import ExtractionResult  # noqa: E402
from app.services.receipt_ai.schema import ReceiptExtraction  # noqa: E402


def _item(name, price, flags=(), category="other"):
    return {"raw_text": f"{name.upper()} {price}", "name": name, "quantity": "1", "unit": "each", "unit_price": None,
            "line_total": price, "category": category, "flags": list(flags), "tax_code": None, "confidence": 0.97}


TESCO = {
    "is_receipt": True, "store_name": "Tesco", "purchased_at": None, "currency": "EUR", "prices_include_tax": True,
    "items": [
        _item("Milk", "1.80", category="dairy"), _item("Cheese", "4.00", category="dairy"),
        _item("Rice", "12.00", category="pantry"), _item("Bread", "1.60", ["reduced"], "bakery"),
        _item("Croissants", "2.50", ["reduced"], "bakery"),
    ],
    "adjustments": [
        {"kind": "item_discount", "label": "Reduced", "amount": "-1.20", "percent": None, "applies_to_items": [3], "already_included_in_items": False},
        {"kind": "item_discount", "label": "Reduced", "amount": "-2.50", "percent": None, "applies_to_items": [4], "already_included_in_items": False},
    ],
    "subtotal": None, "total": "18.20", "payment_method": "card", "warnings": [],
}


class FakeExtractor:
    provider = "anthropic"

    async def extract(self, images, note, model, api_key, hints=None):
        return ExtractionResult(ReceiptExtraction.model_validate(TESCO), model, {"input_tokens": 0, "output_tokens": 0})


pipeline.EXTRACTORS["anthropic"] = FakeExtractor()
settings.ANTHROPIC_API_KEY = "fake-key-for-e2e"

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8000")))
