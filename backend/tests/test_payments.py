"""Paying for ShareEven Pro with Razorpay (faked: no network), webhooks, refunds, reminders and admins."""

import hashlib
import hmac
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, update

from app.config.settings import settings
from app.models.admin import AdminAction
from app.models.ai import AppSetting
from app.models.payment import Payment
from app.models.safety import AccountNotice
from app.models.user import User
from app.services import billing, payments, razorpay
from app.services.receipt_ai import pipeline

KEY_SECRET = "test-key-secret"
WEBHOOK_SECRET = "test-webhook-secret"


@pytest.fixture
async def plan(db):
    """Payments open: INR and USD through Razorpay, EUR switched off, GBP on but not for Razorpay."""
    row = await db.get(AppSetting, billing.PLAN_KEY)
    previous = row.value if row else None
    await billing.save_plan(db, billing.PlanConfig(
        payments_enabled=True, scans_per_month=250,
        prices={"INR": billing.Price(monthly=9900, yearly=99900), "USD": billing.Price(monthly=299, yearly=2999),
                "EUR": billing.Price(monthly=299, yearly=2999, enabled=False), "GBP": billing.Price(monthly=249, yearly=2499)},
        features=["{scans} receipt scans a month"],
        providers=billing.Providers(razorpay=True, card=False, razorpay_currencies=["INR", "USD"]),
    ))
    await db.commit()
    yield
    row = await db.get(AppSetting, billing.PLAN_KEY)
    if previous is None:
        await db.delete(row)
    else:
        row.value = previous
    await db.commit()


@pytest.fixture
def rzp(monkeypatch):
    """A fake Razorpay: orders it made, and the payment entities it will report."""
    monkeypatch.setattr(settings, "RAZORPAY_KEY_ID", "rzp_test_fake")
    monkeypatch.setattr(settings, "RAZORPAY_KEY_SECRET", KEY_SECRET)
    monkeypatch.setattr(settings, "RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET)

    class Fake:
        orders: dict = {}
        payments: dict = {}
        captured: list = []

        def pay(self, order_id, status="captured", amount=None, currency=None):
            order = self.orders[order_id]
            pid = "pay_" + uuid.uuid4().hex[:14]
            self.payments[pid] = {"id": pid, "entity": "payment", "order_id": order_id, "status": status,
                                  "amount": order["amount"] if amount is None else amount,
                                  "currency": currency or order["currency"]}
            return self.payments[pid]

    fake = Fake()
    fake.orders, fake.payments, fake.captured = {}, {}, []

    async def create_order(amount_minor, currency, receipt, notes):
        oid = "order_" + uuid.uuid4().hex[:14]
        fake.orders[oid] = {"id": oid, "amount": amount_minor, "currency": currency, "receipt": receipt, "notes": notes}
        return fake.orders[oid]

    async def fetch_payment(payment_id):
        return dict(fake.payments[payment_id])

    async def capture_payment(payment_id, amount_minor, currency):
        fake.captured.append(payment_id)
        fake.payments[payment_id]["status"] = "captured"
        return dict(fake.payments[payment_id])

    monkeypatch.setattr(razorpay, "create_order", create_order)
    monkeypatch.setattr(razorpay, "fetch_payment", fetch_payment)
    async def order_payments(order_id):
        if order_id in fake.broken:
            raise razorpay.RazorpayError("Razorpay unreachable (ConnectError)")
        return [dict(p) for p in fake.payments.values() if p["order_id"] == order_id]

    fake.broken = set()
    monkeypatch.setattr(razorpay, "capture_payment", capture_payment)
    monkeypatch.setattr(razorpay, "order_payments", order_payments)
    return fake


def _sig(secret: str, message: bytes) -> str:
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


async def checkout(client, user, billing_="monthly", currency="INR"):
    r = await client.post("/api/v1/billing/checkout", json={"billing": billing_, "currency": currency}, headers=user.headers)
    assert r.status_code == 200, r.text
    return r.json()["data"]


async def verify(client, user, order_id, payment_id, signature=None):
    return await client.post("/api/v1/billing/verify", headers=user.headers, json={
        "razorpay_order_id": order_id, "razorpay_payment_id": payment_id,
        "razorpay_signature": signature or _sig(KEY_SECRET, f"{order_id}|{payment_id}".encode()),
    })


async def webhook(client, event: str, secret=WEBHOOK_SECRET, **entities):
    body = json.dumps({"event": event, "payload": {k: {"entity": v} for k, v in entities.items()}}).encode()
    return await client.post("/api/v1/billing/webhook/razorpay", content=body,
                             headers={"X-Razorpay-Signature": _sig(secret, body), "Content-Type": "application/json"})


async def current(client, user):
    return (await client.get("/api/v1/billing/plan", headers=user.headers)).json()["data"]["current"]


async def pro_until(db, user) -> datetime | None:
    db.expire_all()
    return (await db.get(User, uuid.UUID(user.id))).pro_until


# ------------------------------------------------------------------ signatures

def test_signatures(monkeypatch):
    monkeypatch.setattr(settings, "RAZORPAY_KEY_SECRET", KEY_SECRET)
    monkeypatch.setattr(settings, "RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET)
    good = _sig(KEY_SECRET, b"order_1|pay_1")
    assert razorpay.checkout_signature_ok("order_1", "pay_1", good)
    assert not razorpay.checkout_signature_ok("order_1", "pay_2", good)  # another payment
    assert not razorpay.checkout_signature_ok("order_1", "pay_1", _sig(WEBHOOK_SECRET, b"order_1|pay_1"))  # wrong secret
    assert not razorpay.checkout_signature_ok("order_1", "pay_1", "")

    body = b'{"event":"payment.captured"}'
    assert razorpay.webhook_signature_ok(body, _sig(WEBHOOK_SECRET, body))
    assert not razorpay.webhook_signature_ok(body + b" ", _sig(WEBHOOK_SECRET, body))  # body changed
    assert not razorpay.webhook_signature_ok(body, _sig(KEY_SECRET, body))

    monkeypatch.setattr(settings, "RAZORPAY_WEBHOOK_SECRET", "")
    assert not razorpay.webhook_signature_ok(body, _sig("", body))  # no secret set: nothing is trusted


# ------------------------------------------------------------------ checkout

async def test_checkout_charges_the_saved_price(client, db, make_user, plan, rzp):
    someone = await make_user()
    data = await checkout(client, someone, "yearly", "inr")
    assert data["amount"] == 99900 and data["currency"] == "INR" and data["key_id"] == "rzp_test_fake"
    assert data["prefill"]["email"] == someone.email
    assert rzp.orders[data["order_id"]]["amount"] == 99900
    assert KEY_SECRET not in json.dumps(data)

    # The app can't name its own price
    r = await client.post("/api/v1/billing/checkout", json={"billing": "monthly", "currency": "INR", "amount": 1}, headers=someone.headers)
    assert r.json()["data"]["amount"] == 9900

    row = (await db.execute(select(Payment).where(Payment.order_id == data["order_id"]))).scalar_one()
    assert (row.status, row.billing, row.amount_minor, str(row.user_id)) == ("created", "yearly", 99900, someone.id)


async def test_checkout_refusals(client, db, make_user, plan, rzp, monkeypatch):
    someone = await make_user()
    ask = lambda currency, b="monthly": client.post(  # noqa: E731
        "/api/v1/billing/checkout", json={"billing": b, "currency": currency}, headers=someone.headers)
    assert (await ask("EUR")).status_code == 400  # switched off
    assert (await ask("GBP")).status_code == 400  # on, but not for Razorpay
    assert (await ask("JPY")).status_code == 400  # no price
    assert (await ask("INR", "weekly")).status_code == 422
    assert (await client.post("/api/v1/billing/checkout", json={"billing": "monthly", "currency": "INR"})).status_code in (401, 403)

    monkeypatch.setattr(settings, "RAZORPAY_KEY_SECRET", "")
    assert (await ask("INR")).status_code == 503

    plan_now = await billing.get_plan(db)
    plan_now.payments_enabled = False
    await billing.save_plan(db, plan_now)
    await db.commit()
    assert (await ask("INR")).status_code == 409
    assert not rzp.orders


# ------------------------------------------------------------------ verify

async def test_verify_turns_pro_on_once(client, db, make_user, plan, rzp):
    someone = await make_user()
    assert await current(client, someone) == {"plan": "free"}
    order = await checkout(client, someone)
    paid = rzp.pay(order["order_id"])

    before = datetime.now(timezone.utc)
    r = await verify(client, someone, order["order_id"], paid["id"])
    assert r.status_code == 200, r.text
    assert r.json()["data"]["payment"] == "paid" and r.json()["data"]["current"]["plan"] == "pro"
    until = await pro_until(db, someone)
    assert payments.add_months(before, 1) <= until <= payments.add_months(datetime.now(timezone.utc), 1)
    assert (await current(client, someone)) == {"plan": "pro", "until": until.isoformat()}

    # The same payment again (verify twice, then the webhooks) counts once
    assert (await verify(client, someone, order["order_id"], paid["id"])).status_code == 200
    assert (await webhook(client, "payment.captured", payment=paid)).status_code == 200
    assert (await webhook(client, "order.paid", payment=paid, order=rzp.orders[order["order_id"]])).status_code == 200
    assert await pro_until(db, someone) == until

    # A failure reported late doesn't undo it
    await webhook(client, "payment.failed", payment={**paid, "id": "pay_late0failure", "status": "failed"})
    assert await pro_until(db, someone) == until


async def test_verify_refuses_bad_signatures_and_other_peoples_orders(client, db, make_user, plan, rzp):
    someone, other = await make_user(), await make_user()
    order = await checkout(client, someone)
    paid = rzp.pay(order["order_id"])
    assert (await verify(client, someone, order["order_id"], paid["id"], signature="0" * 64)).status_code == 400
    assert (await verify(client, other, order["order_id"], paid["id"])).status_code == 404
    # A real payment for a different order can't be passed off as this one
    other_order = await checkout(client, someone)
    elsewhere = rzp.pay(other_order["order_id"])
    assert (await verify(client, someone, order["order_id"], elsewhere["id"])).status_code == 400
    assert await pro_until(db, someone) is None


async def test_a_tampered_amount_never_turns_pro_on(client, db, make_user, plan, rzp):
    someone = await make_user()
    order = await checkout(client, someone, "yearly")
    cheap = rzp.pay(order["order_id"], amount=100)
    r = await verify(client, someone, order["order_id"], cheap["id"])
    assert r.json()["data"] == {"payment": "mismatch", "current": {"plan": "free"}}
    other = rzp.pay((await checkout(client, someone))["order_id"], currency="USD")  # right number, wrong currency
    await verify(client, someone, other["order_id"], other["id"])
    assert await pro_until(db, someone) is None


async def test_authorized_payments_are_captured(client, db, make_user, plan, rzp):
    someone = await make_user()
    order = await checkout(client, someone)
    paid = rzp.pay(order["order_id"], status="authorized")
    assert (await verify(client, someone, order["order_id"], paid["id"])).json()["data"]["payment"] == "paid"
    assert rzp.captured == [paid["id"]]


# ------------------------------------------------------------------ webhooks

async def test_webhook_needs_the_signature(client, db, make_user, plan, rzp):
    someone = await make_user()
    order = await checkout(client, someone)
    paid = rzp.pay(order["order_id"])
    assert (await webhook(client, "payment.captured", secret="guess", payment=paid)).status_code == 400
    r = await client.post("/api/v1/billing/webhook/razorpay", json={"event": "payment.captured", "payload": {"payment": {"entity": paid}}})
    assert r.status_code == 400
    assert await pro_until(db, someone) is None


async def test_webhook_alone_turns_pro_on_once(client, db, make_user, plan, rzp):
    """The person closed the app right after paying: the webhook is enough."""
    someone = await make_user()
    order = await checkout(client, someone, "yearly")
    paid = rzp.pay(order["order_id"], status="authorized")
    assert (await webhook(client, "payment.authorized", payment=paid)).status_code == 200  # captured by the server
    until = await pro_until(db, someone)
    assert until is not None
    for _ in range(3):
        assert (await webhook(client, "payment.captured", payment=rzp.payments[paid["id"]])).status_code == 200
    assert await pro_until(db, someone) == until
    assert (await webhook(client, "payment.captured", payment={**paid, "order_id": "order_notours"})).status_code == 200
    assert (await webhook(client, "subscription.charged")).status_code == 200  # ignored


async def test_failed_then_paid_on_the_same_order(client, db, make_user, plan, rzp):
    someone = await make_user()
    order = await checkout(client, someone)
    failed = rzp.pay(order["order_id"], status="failed")
    await webhook(client, "payment.failed", payment={**failed, "error_description": "Card declined"})
    row = (await db.execute(select(Payment).where(Payment.order_id == order["order_id"]))).scalar_one()
    assert (row.status, row.error) == ("failed", "Card declined")
    await webhook(client, "payment.captured", payment=rzp.pay(order["order_id"]))
    assert await pro_until(db, someone) is not None


# ------------------------------------------------------------------ the safety net

async def test_unconfirmed_payments_are_found(client, db, make_user, plan, rzp):
    """Paid, but the page closed before /verify and no webhook came: the worker's check turns Pro on."""
    someone, other = await make_user(), await make_user()
    paid = await checkout(client, someone)
    rzp.pay(paid["order_id"])
    authorized = await checkout(client, other, "yearly")
    rzp.pay(authorized["order_id"], status="authorized")
    abandoned = await checkout(client, someone)  # opened and closed: nothing to do
    broken = await checkout(client, other)
    rzp.pay(broken["order_id"])
    rzp.broken.add(broken["order_id"])  # Razorpay unreachable for this one: the others still go through

    now = datetime.now(timezone.utc)
    assert await payments.reconcile(db, now) == 0  # too new: the checkout may still confirm it
    later = now + timedelta(minutes=10)
    assert await payments.reconcile(db, later) == 2
    assert await pro_until(db, someone) is not None
    assert (await current(client, other))["plan"] == "pro"
    assert len(rzp.captured) == 1  # the authorized one was captured

    until = await pro_until(db, someone)
    rzp.broken.clear()
    assert await payments.reconcile(db, later) == 1  # the broken one, now that Razorpay answers
    assert await pro_until(db, someone) == until  # nothing counted twice
    row = (await db.execute(select(Payment).where(Payment.order_id == abandoned["order_id"]))).scalar_one()
    assert row.status == "created"

    rzp.pay(abandoned["order_id"])
    assert await payments.reconcile(db, now + timedelta(days=2)) == 0  # older than a day: left alone


# ------------------------------------------------------------------ extending and refunds

def test_month_and_year_maths():
    d = lambda *a: datetime(*a, tzinfo=timezone.utc)  # noqa: E731
    assert payments.add_months(d(2026, 1, 31, 9), 1) == d(2026, 2, 28, 9)
    assert payments.add_months(d(2028, 1, 31), 1) == d(2028, 2, 29)
    assert payments.add_months(d(2026, 11, 15), 3) == d(2027, 2, 15)
    assert payments.add_months(d(2028, 2, 29), 12) == d(2029, 2, 28)

    now = d(2026, 10, 20)
    user = User(pro_until=None, pro_reminded_days=7)
    assert payments.extend(user, now, months=1) == (now, d(2026, 11, 20))
    assert user.pro_reminded_days is None
    assert payments.extend(user, now, months=12) == (d(2026, 11, 20), d(2027, 11, 20))  # after the current end
    user.pro_until = d(2026, 1, 1)  # long over: starts now
    assert payments.extend(user, now, days=10) == (now, d(2026, 10, 30))


async def test_paying_again_adds_on_and_refunds_take_back_the_days(client, db, make_user, plan, rzp):
    someone = await make_user()
    first = await checkout(client, someone, "monthly")
    p1 = rzp.pay(first["order_id"])
    await verify(client, someone, first["order_id"], p1["id"])
    after_first = await pro_until(db, someone)

    second = await checkout(client, someone, "yearly")
    p2 = rzp.pay(second["order_id"])
    await verify(client, someone, second["order_id"], p2["id"])
    after_second = await pro_until(db, someone)
    assert after_second == payments.add_months(after_first, 12)

    # Half the year back: half its days go (counted once however often Razorpay says so)
    half = {"id": "rfnd_half", "entity": "refund", "payment_id": p2["id"], "amount": 99900 // 2, "currency": "INR"}
    for _ in range(2):
        assert (await webhook(client, "refund.processed", refund=half, payment=p2)).status_code == 200
    bought = after_second - after_first
    assert abs((await pro_until(db, someone)) - (after_second - bought * (49950 / 99900))) < timedelta(seconds=1)

    # The rest back: back to the end of the first month
    rest = {**half, "id": "rfnd_rest", "amount": 99900 - 49950}
    await webhook(client, "refund.processed", refund=rest, payment=p2)
    assert abs((await pro_until(db, someone)) - after_first) < timedelta(seconds=1)
    row = (await db.execute(select(Payment).where(Payment.payment_id == p2["id"]))).scalar_one()
    assert (row.status, row.refunded_minor) == ("refunded", 99900)

    # The first month refunded too: Pro ends now, not in the past
    await webhook(client, "refund.processed", refund={**half, "id": "rfnd_first", "payment_id": p1["id"], "amount": 9900}, payment=p1)
    assert await current(client, someone) == {"plan": "free"}
    assert await pro_until(db, someone) > datetime.now(timezone.utc) - timedelta(minutes=1)


# ------------------------------------------------------------------ what Pro gives

async def test_scan_limit_while_pro(db, make_user, plan):
    someone = await make_user()
    user = await db.get(User, uuid.UUID(someone.id))
    app_limit = await pipeline.scan_limit(db)
    assert (await pipeline.person_scan_limit(db, user))["limit"] == app_limit

    user.pro_until = datetime.now(timezone.utc) + timedelta(days=3)
    limits = await pipeline.person_scan_limit(db, user)
    assert limits["pro"] is True and limits["limit"] == max(app_limit, 250)

    user.extra_scans, user.extra_scans_month = 5, pipeline._month_start().date()
    assert (await pipeline.person_scan_limit(db, user))["limit"] == max(app_limit, 250) + 5  # extras still add up
    user.scan_limit_override = 0
    assert (await pipeline.person_scan_limit(db, user))["limit"] == 5  # an admin's own limit still wins

    user.scan_limit_override, user.pro_until = None, datetime.now(timezone.utc) - timedelta(seconds=1)
    assert (await pipeline.person_scan_limit(db, user))["limit"] == app_limit + 5  # Pro over
    await db.rollback()


# ------------------------------------------------------------------ reminders

async def test_reminders_7_days_and_1_day_before(db, make_user, events):
    someone = await make_user()
    uid = uuid.UUID(someone.id)
    now = datetime.now(timezone.utc)
    await db.execute(update(User).where(User.id == uid).values(pro_until=now + timedelta(days=6, hours=20)))
    await db.commit()

    async def remind(at):
        due = [n for n in await payments.due_reminders(db, at) if n.user_id == uid]
        await db.commit()
        return due

    first = await remind(now)
    assert len(first) == 1 and "in 7 days" in first[0].body and first[0].kind == "pro_reminder"
    assert await remind(now + timedelta(hours=1)) == []  # once
    last = await remind(now + timedelta(days=6))
    assert len(last) == 1 and "tomorrow" in last[0].body
    assert await remind(now + timedelta(days=6, hours=2)) == []
    assert await remind(now + timedelta(days=8)) == []  # over: nothing more

    # Paying again gives the new end date its own reminders
    user = await db.get(User, uid)
    payments.extend(user, now, months=1)
    await db.commit()
    assert len(await remind(user.pro_until - timedelta(days=5))) == 1

    from app.worker import MessageWorker
    worker = MessageWorker.__new__(MessageWorker)
    assert await worker.send_pro_reminders() >= 0  # runs end to end (pushes are off in tests)
    notices = (await db.execute(select(AccountNotice).where(AccountNotice.user_id == uid))).scalars().all()
    assert len(notices) == 3


# ------------------------------------------------------------------ admins

async def _admin(db, make_user):
    admin = await make_user("admin")
    await db.execute(update(User).where(User.id == uuid.UUID(admin.id)).values(is_app_admin=True))
    await db.commit()
    return admin


async def test_admin_grants_and_ends_pro(client, db, make_user, plan, rzp):
    admin, someone = await _admin(db, make_user), await make_user()
    url = f"/api/v1/admin/users/{someone.id}/pro"
    assert (await client.post(url, json={"action": "grant", "days": 30, "reason": "beta"}, headers=someone.headers)).status_code == 403
    assert (await client.post(url, json={"action": "grant", "days": 30}, headers=admin.headers)).status_code == 422
    assert (await client.post(url, json={"action": "grant", "reason": "beta tester"}, headers=admin.headers)).status_code == 400
    assert (await client.post(url, json={"action": "end", "reason": "nothing to end"}, headers=admin.headers)).status_code == 400

    r = await client.post(url, json={"action": "grant", "days": 30, "reason": "Beta tester"}, headers=admin.headers)
    assert r.status_code == 200 and r.json()["data"]["plan"] == "pro" and r.json()["data"]["scans"]["pro"] is True
    assert (await current(client, someone))["plan"] == "pro"

    order = await checkout(client, someone)
    await verify(client, someone, order["order_id"], rzp.pay(order["order_id"])["id"])
    details = (await client.get(f"/api/v1/admin/users/{someone.id}", headers=admin.headers)).json()["data"]
    assert details["pro"]["plan"] == "pro" and details["pro_until"]
    assert [(p["status"], p["amount"], p["currency"]) for p in details["pro"]["payments"]] == [("paid", 9900, "INR")]

    r = await client.post(url, json={"action": "end", "reason": "Asked to stop"}, headers=admin.headers)
    assert r.status_code == 200 and r.json()["data"]["plan"] == "free"
    logged = (await db.execute(select(AdminAction.action, AdminAction.reason).where(
        AdminAction.target_user_id == uuid.UUID(someone.id), AdminAction.action.like("pro_%")).order_by(AdminAction.created_at))).all()
    assert logged == [("pro_granted", "Beta tester"), ("pro_ended", "Asked to stop")]


# ------------------------------------------------------------------ settings

def test_production_razorpay_settings():
    from types import SimpleNamespace
    from app.main import production_problems, production_warnings
    base = dict(ENV="production", JWT_SECRET_KEY="x" * 40, MEDIA_ENCRYPTION_KEY="k", DATABASE_URL="postgresql+asyncpg://u:strong@db/x")
    ok = SimpleNamespace(**base, RAZORPAY_KEY_ID="rzp_live_abc", RAZORPAY_KEY_SECRET="s", RAZORPAY_WEBHOOK_SECRET="w")
    assert production_problems(ok) == []
    half = SimpleNamespace(**base, RAZORPAY_KEY_ID="rzp_live_abc", RAZORPAY_KEY_SECRET="s", RAZORPAY_WEBHOOK_SECRET="")
    assert [p.split(" ")[0] for p in production_problems(half)] == ["Set"]
    test_key = SimpleNamespace(**base, RAZORPAY_KEY_ID="rzp_test_abc", RAZORPAY_KEY_SECRET="s", RAZORPAY_WEBHOOK_SECRET="w")
    assert "test key" in production_problems(test_key)[0]
    none = SimpleNamespace(**base, RAZORPAY_KEY_ID="", RAZORPAY_KEY_SECRET="", RAZORPAY_WEBHOOK_SECRET="", REDIS_URL="", CORS_ORIGINS=[])
    assert production_problems(none) == [] and any("RAZORPAY" in w for w in production_warnings(none))
