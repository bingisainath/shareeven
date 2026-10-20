"""ShareEven Pro: the plan the apps show, and admins changing it in the admin console."""

import uuid

from sqlalchemy import delete, update

from app.models.ai import AppSetting

from app.models.user import User


async def _admin(db, make_user):
    admin = await make_user("admin")
    await db.execute(update(User).where(User.id == uuid.UUID(admin.id)).values(is_app_admin=True))
    await db.commit()
    return admin


def _plan(**changes):
    plan = {
        "payments_enabled": True,
        "scans_per_month": 250,
        "prices": {"inr": {"monthly": 14900, "yearly": 149900}, "EUR": {"monthly": 399, "yearly": 3999}},
        "features": ["{scans} receipt scans a month", "  Everything in Free  ", ""],
        "providers": {"razorpay": True, "card": False, "razorpay_currencies": ["inr"]},
    }
    plan.update(changes)
    return plan


async def test_default_plan_until_an_admin_saves_one(client, db, make_user):
    await db.execute(delete(AppSetting).where(AppSetting.key == "pro_plan"))  # tests share one database
    await db.commit()
    someone = await make_user()
    data = (await client.get("/api/v1/billing/plan", headers=someone.headers)).json()["data"]
    assert data["current"] == {"plan": "free"}
    assert data["pro"]["payments_enabled"] is False
    assert data["pro"]["prices"]["INR"] == {"monthly": 9900, "yearly": 99900}
    assert data["pro"]["features"][0] == "100 receipt scans a month"  # {scans} filled in


async def test_plan_needs_sign_in(client):
    assert (await client.get("/api/v1/billing/plan")).status_code in (401, 403)


async def test_only_admins_change_the_plan(client, make_user):
    someone = await make_user()
    assert (await client.get("/api/v1/admin/billing", headers=someone.headers)).status_code == 403
    assert (await client.put("/api/v1/admin/billing", json=_plan(), headers=someone.headers)).status_code == 403


async def test_admin_saves_the_plan_and_apps_see_it(client, db, make_user):
    admin = await _admin(db, make_user)
    r = await client.put("/api/v1/admin/billing", json=_plan(), headers=admin.headers)
    assert r.status_code == 200, r.text
    saved = r.json()["data"]
    assert set(saved["prices"]) == {"INR", "EUR"}  # codes upper-cased
    assert saved["features"] == ["{scans} receipt scans a month", "Everything in Free"]  # trimmed, blanks dropped
    assert saved["providers"]["razorpay_currencies"] == ["INR"]

    someone = await make_user()
    pro = (await client.get("/api/v1/billing/plan", headers=someone.headers)).json()["data"]["pro"]
    assert pro["payments_enabled"] is True and pro["scans_per_month"] == 250
    assert pro["features"][0] == "250 receipt scans a month"
    assert pro["prices"]["INR"] == {"monthly": 14900, "yearly": 149900}
    assert pro["providers"]["card"] is False

    log = (await client.get("/api/v1/admin/actions", headers=admin.headers)).json()["data"]
    entry = next(a for a in log if a["action"] == "plan_changed")
    assert entry["by"] == admin.username and "prices" in entry["details"]["changed"]


async def test_bad_plans_are_refused(client, db, make_user):
    admin = await _admin(db, make_user)
    before = (await client.get("/api/v1/admin/billing", headers=admin.headers)).json()["data"]
    bad = [
        _plan(prices={}),  # no price at all
        _plan(prices={"RUPEES": {"monthly": 100, "yearly": 1000}}),  # not a currency code
        _plan(prices={"INR": {"monthly": 0, "yearly": 1000}}),  # free isn't a price
        _plan(prices={"INR": {"monthly": 100, "yearly": 1300}}),  # a year dearer than 12 months
        _plan(features=["", "  "]),  # no features
        _plan(features=["x" * 121]),
        _plan(scans_per_month=0),
        _plan(providers={"razorpay": False, "card": False}),  # nobody to pay
    ]
    for body in bad:
        r = await client.put("/api/v1/admin/billing", json=body, headers=admin.headers)
        assert r.status_code == 422, (body, r.text)
    # Nothing was saved
    assert (await client.get("/api/v1/admin/billing", headers=admin.headers)).json()["data"] == before
