# backend/app/api/v1/billing.py
# ShareEven Pro for the Plan page: prices, features and who takes the payment (set by app admins in
# Admin → Pro & payments), the signed-in person's plan, and paying with Razorpay (checkout, the
# checkout's confirmation, and Razorpay's webhook). See app/services/payments.py for the flow.

import json
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_current_user
from app.core import rate_limit
from app.db.session import get_db
from app.models.user import User
from app.services import billing, payments, razorpay

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/billing", tags=["Billing"])

CHECKOUTS_PER_USER = rate_limit.Limit("checkout", 20, rate_limit.HOUR, "Too many payment attempts. Try again in {wait}.")
WEBHOOK_MAX_BYTES = 256 * 1024


class CheckoutRequest(BaseModel):
    billing: Literal["monthly", "yearly"]
    currency: str = Field(..., min_length=3, max_length=3)
    provider: Literal["razorpay"] = "razorpay"


class VerifyRequest(BaseModel):
    razorpay_order_id: str = Field(..., max_length=64)
    razorpay_payment_id: str = Field(..., max_length=64)
    razorpay_signature: str = Field(..., max_length=128)


def _raise(e: payments.CheckoutError):
    raise HTTPException(status_code=e.status, detail=e.message)


@router.get("/plan")
async def plan(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """The Pro plan as admins set it, and this person's plan ({plan: 'pro', until} or {plan: 'free'})."""
    return {"success": True, "data": {"pro": billing.public_plan(await billing.get_plan(db)),
                                      "current": payments.current_plan(current_user)}}


@router.post("/checkout")
async def checkout(body: CheckoutRequest, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """A Razorpay order for the plan's price in this currency; the app opens checkout.js with it."""
    await rate_limit.enforce((CHECKOUTS_PER_USER, str(current_user.id)))
    try:
        return {"success": True, "data": await payments.start_checkout(db, current_user, body.billing, body.currency)}
    except payments.CheckoutError as e:
        _raise(e)


@router.post("/verify")
async def verify(body: VerifyRequest, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """checkout.js succeeded: confirm it with Razorpay and turn Pro on. Returns the person's plan."""
    try:
        payment = await payments.verify_checkout(db, current_user, body.razorpay_order_id,
                                                 body.razorpay_payment_id, body.razorpay_signature)
    except payments.CheckoutError as e:
        _raise(e)
    await db.refresh(current_user)
    return {"success": True, "data": {"payment": payment.status, "current": payments.current_plan(current_user)}}


@router.post("/webhook/razorpay", include_in_schema=False)
async def razorpay_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """Razorpay → Settings → Webhooks: payment.captured, payment.authorized, payment.failed, order.paid, refund.processed."""
    raw = await request.body()
    if len(raw) > WEBHOOK_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Too large")
    if not razorpay.webhook_signature_ok(raw, request.headers.get("X-Razorpay-Signature", "")):
        logger.warning("Razorpay webhook with a bad signature from %s", rate_limit.client_ip(request))
        raise HTTPException(status_code=400, detail="Bad signature")
    try:
        event = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Not JSON")
    try:
        done = await payments.handle_webhook(db, event)
    except razorpay.RazorpayError as e:
        await db.rollback()
        logger.error("Razorpay webhook %s failed, Razorpay will retry: %s", event.get("event"), e)
        raise HTTPException(status_code=502, detail="Try again")
    logger.info("Razorpay webhook %s: %s", event.get("event"), done)
    return {"success": True}
