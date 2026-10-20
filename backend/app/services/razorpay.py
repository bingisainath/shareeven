# backend/app/services/razorpay.py

"""
Razorpay, through its REST API (https://razorpay.com/docs/api/): orders, payments, and the two
signatures that prove a message really came from Razorpay.

The key secret and webhook secret are only ever used to sign or authenticate here: never logged,
never returned, never in an error message (Razorpay's own error description is logged instead).
"""

import hashlib
import hmac
import logging

import httpx

from app.config.settings import settings

logger = logging.getLogger(__name__)

API = "https://api.razorpay.com/v1"


class RazorpayError(Exception):
    """Razorpay refused or couldn't be reached. The message is safe to log (no secrets)."""


def configured() -> bool:
    return bool(settings.RAZORPAY_KEY_ID and settings.RAZORPAY_KEY_SECRET)


def _sign(secret: str, message: bytes) -> str:
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def checkout_signature_ok(order_id: str, payment_id: str, signature: str) -> bool:
    """What checkout.js hands back on success: HMAC-SHA256("<order_id>|<payment_id>", key secret)."""
    if not (settings.RAZORPAY_KEY_SECRET and order_id and payment_id and signature):
        return False
    expected = _sign(settings.RAZORPAY_KEY_SECRET, f"{order_id}|{payment_id}".encode())
    return hmac.compare_digest(expected, signature)


def webhook_signature_ok(raw_body: bytes, signature: str) -> bool:
    """X-Razorpay-Signature: HMAC-SHA256 of the exact request body, with the webhook secret."""
    if not (settings.RAZORPAY_WEBHOOK_SECRET and signature):
        return False
    return hmac.compare_digest(_sign(settings.RAZORPAY_WEBHOOK_SECRET, raw_body), signature)


async def _call(method: str, path: str, json: dict | None = None) -> dict:
    if not configured():
        raise RazorpayError("Razorpay keys aren't set")
    try:
        async with httpx.AsyncClient(timeout=15, auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET)) as client:
            r = await client.request(method, API + path, json=json)
    except httpx.HTTPError as e:
        raise RazorpayError(f"Razorpay unreachable ({type(e).__name__})") from None
    if r.status_code >= 400:
        try:
            description = r.json().get("error", {}).get("description", "")
        except ValueError:
            description = ""
        raise RazorpayError(f"Razorpay {method} {path.split('/')[1]}: {r.status_code} {description}"[:300])
    return r.json()


async def create_order(amount_minor: int, currency: str, receipt: str, notes: dict) -> dict:
    return await _call("POST", "/orders", {"amount": amount_minor, "currency": currency, "receipt": receipt, "notes": notes})


async def fetch_payment(payment_id: str) -> dict:
    return await _call("GET", f"/payments/{payment_id}")


async def order_payments(order_id: str) -> list[dict]:
    """Every payment attempt on an order (failed ones too)."""
    return (await _call("GET", f"/orders/{order_id}/payments")).get("items", [])


async def capture_payment(payment_id: str, amount_minor: int, currency: str) -> dict:
    """Only needed when the Razorpay account doesn't capture payments by itself."""
    return await _call("POST", f"/payments/{payment_id}/capture", {"amount": amount_minor, "currency": currency})
