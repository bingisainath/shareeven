# backend/app/services/payments.py

"""
Paying for ShareEven Pro with Razorpay. The server is the only one who decides:

1. checkout: the price comes from the saved plan (Admin → Pro & payments), never from the app.
   A Razorpay order is made for it and a `payments` row remembers it.
2. Pro turns on only for a payment Razorpay confirms: the checkout's signature (POST /billing/verify,
   then the payment is fetched back from Razorpay) or a signed webhook. Both run apply_captured(),
   which locks the order's row, so the same payment is counted once whichever arrives first.
3. Pro is a one-off month or year: paying again adds it on after the current end date. A refund
   takes back its share of the days that payment bought (never ending Pro in the past).
"""

import logging
import re
import uuid
from calendar import monthrange
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config.settings import settings
from app.models.payment import Payment
from app.models.safety import AccountNotice
from app.models.user import User
from app.services import billing, razorpay

logger = logging.getLogger(__name__)

MONTHS = {"monthly": 1, "yearly": 12}
PAID = ("paid", "partially_refunded", "refunded")
PAYMENT_ID = re.compile(r"pay_[A-Za-z0-9]{6,40}")
# Unpaid orders the worker asks Razorpay about: old enough that the checkout has had its chance,
# young enough to still matter (Razorpay refunds an uncaptured payment by itself after a few days)
RECONCILE_AFTER = timedelta(minutes=5)
RECONCILE_FOR = timedelta(hours=24)
RECONCILE_BATCH = 50
# Reminders before Pro ends, in days (largest first)
REMINDERS = (7, 1)
REMINDER_TITLE = "Your ShareEven Pro is ending"


class CheckoutError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message, self.status = message, status


def _now() -> datetime:
    return datetime.now(timezone.utc)


def add_months(start: datetime, months: int) -> datetime:
    """The same day `months` later, or that month's last day (31 Jan + 1 month = 28/29 Feb)."""
    month0 = start.month - 1 + months
    year, month = start.year + month0 // 12, month0 % 12 + 1
    return start.replace(year=year, month=month, day=min(start.day, monthrange(year, month)[1]))


def is_pro(user: User, now: datetime | None = None) -> bool:
    return user.pro_until is not None and user.pro_until > (now or _now())


def current_plan(user: User) -> dict:
    if is_pro(user):
        return {"plan": "pro", "until": user.pro_until.isoformat()}
    return {"plan": "free"}


def extend(user: User, start_at_least: datetime, months: int = 0, days: int = 0) -> tuple[datetime, datetime]:
    """Pro from the later of now and its current end, for this long. Returns (from, until)."""
    start = max(start_at_least, user.pro_until or start_at_least)
    until = add_months(start, months) + timedelta(days=days)
    user.pro_until = until
    user.pro_reminded_days = None  # a new end date gets its own reminders
    return start, until


# ------------------------------------------------------------------ checkout

async def start_checkout(db: AsyncSession, user: User, period: str, currency: str) -> dict:
    """Make a Razorpay order for the plan's price and return what checkout.js needs."""
    plan = await billing.get_plan(db)
    currency = (currency or "").upper()
    if period not in MONTHS:
        raise CheckoutError("Choose monthly or yearly")
    if not plan.payments_enabled:
        raise CheckoutError("Payments aren't open yet. Pro will be available soon.", 409)
    price = plan.prices.get(currency)
    if price is None or not price.enabled:
        raise CheckoutError(f"Pro can't be bought in {currency or 'that currency'}", 400)
    if not plan.providers.razorpay or currency not in plan.providers.razorpay_currencies:
        raise CheckoutError(f"Payments in {currency} aren't available yet", 400)
    if not razorpay.configured():
        logger.error("Checkout asked for but RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET aren't set")
        raise CheckoutError("Payments are unavailable right now. Try again later.", 503)

    amount = price.monthly if period == "monthly" else price.yearly
    row_id = uuid.uuid4()
    try:
        order = await razorpay.create_order(amount, currency, receipt=f"pro_{row_id.hex[:24]}",
                                            notes={"user_id": str(user.id), "billing": period})
    except razorpay.RazorpayError as e:
        logger.error("Creating a Razorpay order failed: %s", e)
        raise CheckoutError("Couldn't start the payment. Try again in a minute.", 502)
    if order.get("amount") != amount or order.get("currency") != currency or not order.get("id"):
        logger.error("Razorpay order %s doesn't match what was asked for", order.get("id"))
        raise CheckoutError("Couldn't start the payment. Try again in a minute.", 502)

    db.add(Payment(id=row_id, user_id=user.id, provider="razorpay", order_id=order["id"], billing=period,
                   currency=currency, amount_minor=amount, status="created"))
    await db.commit()
    return {
        "provider": "razorpay",
        "key_id": settings.RAZORPAY_KEY_ID,
        "order_id": order["id"],
        "amount": amount,
        "currency": currency,
        "name": "ShareEven",
        "description": "ShareEven Pro for a month" if period == "monthly" else "ShareEven Pro for a year",
        "prefill": {"name": user.name or user.username, "email": user.email},
    }


async def _locked_order(db: AsyncSession, order_id: str) -> Payment | None:
    return (await db.execute(select(Payment).where(Payment.order_id == order_id).with_for_update())).scalar_one_or_none()


async def apply_captured(db: AsyncSession, entity: dict) -> Payment | None:
    """
    A Razorpay payment entity (fetched from the API or in a signed webhook). If it's captured for one
    of our orders, for its exact amount and currency, Pro is extended. Safe to call any number of
    times. The caller commits.
    """
    order_id, payment_id = entity.get("order_id"), entity.get("id")
    if not order_id or not payment_id:
        return None
    payment = await _locked_order(db, order_id)
    if payment is None:
        logger.info("Razorpay payment for an order that isn't ours; ignored")
        return None
    if payment.status in PAID or payment.status == "mismatch":
        if payment.payment_id != payment_id:
            logger.error("Order %s was paid twice (%s, then %s): refund one in the Razorpay dashboard",
                         order_id, payment.payment_id, payment_id)
        return payment
    if entity.get("status") != "captured":
        return payment
    if entity.get("amount") != payment.amount_minor or entity.get("currency") != payment.currency:
        logger.error("Payment %s for order %s is %s %s, not the order's %s %s: Pro not turned on",
                     payment_id, order_id, entity.get("amount"), entity.get("currency"), payment.amount_minor, payment.currency)
        payment.status, payment.payment_id, payment.raw_event = "mismatch", payment_id, entity
        payment.error = "Paid amount or currency doesn't match the order"
        return payment

    now = _now()
    payment.status, payment.payment_id, payment.paid_at, payment.raw_event, payment.error = "paid", payment_id, now, entity, None
    user = await db.get(User, payment.user_id, with_for_update=True) if payment.user_id else None
    if user is None or user.deleted_at is not None:
        logger.warning("Payment %s is for a deleted account: refund it in the Razorpay dashboard", payment_id)
        return payment
    payment.pro_from, payment.pro_until = extend(user, now, months=MONTHS[payment.billing])
    logger.info("Pro extended for a %s payment", payment.billing)
    return payment


async def mark_failed(db: AsyncSession, entity: dict) -> None:
    """A failed attempt. The person can try again on the same order, so this never undoes a payment."""
    payment = await _locked_order(db, entity.get("order_id") or "")
    if payment is not None and payment.status in ("created", "failed"):
        payment.status = "failed"
        payment.error = (entity.get("error_description") or "Payment failed")[:300]
        payment.raw_event = entity


async def apply_refund(db: AsyncSession, refund: dict) -> Payment | None:
    """A processed refund: take back its share of the Pro that payment bought. Each refund id counts once."""
    refund_id, payment_id, amount = refund.get("id"), refund.get("payment_id"), refund.get("amount")
    if not refund_id or not payment_id or not isinstance(amount, int):
        return None
    payment = (await db.execute(select(Payment).where(Payment.payment_id == payment_id).with_for_update())).scalar_one_or_none()
    if payment is None or payment.status not in PAID or refund_id in (payment.refunds or {}):
        return payment

    before = payment.refunded_minor
    payment.refunds = {**(payment.refunds or {}), refund_id: amount}
    payment.refunded_minor = min(payment.amount_minor, sum(payment.refunds.values()))
    payment.status = "refunded" if payment.refunded_minor >= payment.amount_minor else "partially_refunded"
    payment.raw_event = refund

    user = await db.get(User, payment.user_id, with_for_update=True) if payment.user_id else None
    if user is not None and user.pro_until and payment.pro_from and payment.pro_until:
        bought = payment.pro_until - payment.pro_from
        take_back = bought * (payment.refunded_minor - before) / payment.amount_minor
        user.pro_until = max(_now(), user.pro_until - take_back)  # now = ended
        user.pro_reminded_days = None
    logger.info("Refund recorded (%s of %s)", payment.refunded_minor, payment.amount_minor)
    return payment


async def verify_checkout(db: AsyncSession, user: User, order_id: str, payment_id: str, signature: str) -> Payment:
    """What checkout.js hands back on success. Checked with the signature, then with Razorpay itself."""
    payment = (await db.execute(select(Payment).where(Payment.order_id == order_id, Payment.user_id == user.id))).scalar_one_or_none()
    if payment is None:
        raise CheckoutError("That payment wasn't found", 404)
    if not PAYMENT_ID.fullmatch(payment_id or "") or not razorpay.checkout_signature_ok(order_id, payment_id, signature):
        logger.warning("Checkout signature didn't match for order %s", order_id)
        raise CheckoutError("That payment couldn't be confirmed", 400)
    try:
        entity = await razorpay.fetch_payment(payment_id)
        if entity.get("order_id") != order_id:
            raise CheckoutError("That payment couldn't be confirmed", 400)
        if entity.get("status") == "authorized":  # the account doesn't capture by itself
            entity = await razorpay.capture_payment(payment_id, payment.amount_minor, payment.currency)
    except razorpay.RazorpayError as e:
        logger.error("Confirming payment %s with Razorpay failed: %s", payment_id, e)
        raise CheckoutError("We got your payment but couldn't confirm it yet. Pro turns on within a few minutes.", 502)
    payment = await apply_captured(db, entity)
    await db.commit()
    return payment


async def handle_webhook(db: AsyncSession, event: dict) -> str:
    """A signed Razorpay webhook. Returns what was done (for the log). Raises RazorpayError to be retried."""
    kind = event.get("event", "")
    payload = event.get("payload") or {}
    entity = (payload.get("payment") or {}).get("entity") or {}
    if kind in ("payment.captured", "order.paid"):
        await apply_captured(db, entity)
    elif kind == "payment.authorized":
        payment = await _locked_order(db, entity.get("order_id") or "")
        if payment is not None and payment.status in ("created", "failed"):
            await _capture_and_apply(db, payment, entity)
    elif kind == "payment.failed":
        await mark_failed(db, entity)
    elif kind == "refund.processed":
        await apply_refund(db, (payload.get("refund") or {}).get("entity") or {})
    else:
        return "ignored"
    await db.commit()
    return kind


async def _capture_and_apply(db: AsyncSession, payment: Payment, entity: dict) -> None:
    if entity.get("status") == "authorized" and PAYMENT_ID.fullmatch(entity.get("id") or ""):
        entity = await razorpay.capture_payment(entity["id"], payment.amount_minor, payment.currency)
    await apply_captured(db, entity)


async def reconcile(db: AsyncSession, now: datetime | None = None) -> int:
    """
    The safety net for a paid order nobody told us about (the page closed before /verify and the
    webhook never came): ask Razorpay about recent unpaid orders and apply what it says. Uses the
    same apply_captured(), so nothing is counted twice. Returns how many orders turned paid.
    """
    now = now or _now()
    if not razorpay.configured():
        return 0
    orders = (await db.execute(
        select(Payment.id, Payment.order_id).where(
            Payment.provider == "razorpay", Payment.status.in_(("created", "failed")),
            Payment.created_at <= now - RECONCILE_AFTER, Payment.created_at >= now - RECONCILE_FOR,
        ).order_by(Payment.created_at.desc()).limit(RECONCILE_BATCH)
    )).all()
    paid = 0
    for row_id, order_id in orders:
        try:
            attempts = await razorpay.order_payments(order_id)
            wanted = [e for e in attempts if e.get("status") in ("captured", "authorized")]
            if not wanted:
                continue
            payment = await db.get(Payment, row_id)
            for entity in wanted:
                await _capture_and_apply(db, payment, entity)
            await db.commit()
            await db.refresh(payment)
            if payment.status == "paid":
                paid += 1
                logger.warning("Order %s was paid but never confirmed (page closed and no webhook): Pro turned on now", order_id)
        except razorpay.RazorpayError as e:
            await db.rollback()
            logger.error("Checking order %s with Razorpay failed: %s", order_id, e)
    return paid


# ------------------------------------------------------------------ admins

def admin_grant(user: User, days: int) -> datetime:
    return extend(user, _now(), days=days)[1]


def admin_end(user: User) -> None:
    if is_pro(user):
        user.pro_until = _now()
    user.pro_reminded_days = None


def view(p: Payment) -> dict:
    iso = lambda d: d.isoformat() if d else None  # noqa: E731
    return {
        "id": str(p.id), "provider": p.provider, "order_id": p.order_id, "payment_id": p.payment_id,
        "billing": p.billing, "currency": p.currency, "amount": p.amount_minor, "refunded": p.refunded_minor,
        "status": p.status, "error": p.error, "pro_from": iso(p.pro_from), "pro_until": iso(p.pro_until),
        "created_at": iso(p.created_at), "paid_at": iso(p.paid_at),
    }


# ------------------------------------------------------------------ reminders

def _reminder_body(days_left: int, until: datetime) -> str:
    when = "tomorrow" if days_left <= 1 else f"in {days_left} days"
    return (f"Your ShareEven Pro ends {when} ({until.day} {until:%B %Y}). It doesn't renew by itself: "
            "to keep your extra receipt scans, get another month or year in Settings → ShareEven Pro.")


async def due_reminders(db: AsyncSession, now: datetime | None = None) -> list[AccountNotice]:
    """Notices for everyone whose Pro ends within 7 days, then within 1, once each. The caller commits and delivers."""
    now = now or _now()
    users = (await db.execute(
        select(User).where(User.pro_until > now, User.pro_until <= now + timedelta(days=REMINDERS[0]),
                           User.deleted_at.is_(None)).with_for_update(skip_locked=True)
    )).scalars().all()
    notices = []
    for user in users:
        left = user.pro_until - now
        stage = min(d for d in REMINDERS if left <= timedelta(days=d))
        if user.pro_reminded_days is not None and user.pro_reminded_days <= stage:
            continue
        user.pro_reminded_days = stage
        days_left = max(1, -(-left // timedelta(days=1)))  # whole days, rounded up
        notice = AccountNotice(user_id=user.id, kind="pro_reminder", title=REMINDER_TITLE,
                               body=_reminder_body(days_left, user.pro_until))
        db.add(notice)
        notices.append(notice)
    return notices
