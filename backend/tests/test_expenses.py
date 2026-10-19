"""Manual expenses, permissions, history, settle up, balances and AI settings."""

import uuid

import pytest
from sqlalchemy import update

from app.models.user import User


async def add(client, user, conversation_id, amount="30.00", **fields):
    body = {"description": "Dinner", "currency": "EUR", "amount": amount, "split_mode": "equal", **fields}
    return await client.post(f"/api/v1/conversations/{conversation_id}/expenses", json=body, headers=user.headers)


async def balances(client, user, conversation_id, **params):
    r = await client.get(f"/api/v1/conversations/{conversation_id}/balances", params=params, headers=user.headers)
    assert r.status_code == 200, r.text
    return r.json()["data"]


@pytest.fixture
def trio(make_user, make_group):
    async def _make():
        a, b, c = await make_user("alice"), await make_user("bob"), await make_user("carol")
        return a, b, c, await make_group(a, [b, c], "Trip")
    return _make


async def test_equal_split_default_payer_and_balances(client, trio, events):
    a, b, c, group = await trio()
    r = await add(client, a, group, "10.00", splits=[{"user_id": u.id} for u in (a, b, c)])
    assert r.status_code == 200, r.text
    expense = r.json()["data"]
    assert expense["payers"] == [{"user_id": a.id, "amount_minor": 1000}]
    assert sorted(s["amount_minor"] for s in expense["shares"]) == [333, 333, 334]
    assert any(p.get("type") == "expense_changed" for _, p in events)
    assert any(p.get("expenseId") == expense["id"] for _, p in events)  # chat card

    data = await balances(client, b, group)
    eur = data["currencies"][0]
    assert eur["my_net_minor"] == -333
    assert {(d["from_user"], d["to_user"]) for d in eur["debts"]} == {(b.id, a.id), (c.id, a.id)}
    assert set(data["users"]) == {a.id, b.id, c.id}


async def test_multiple_payers_and_validation(client, trio, make_user):
    a, b, c, group = await trio()
    outsider = await make_user()
    split = [{"user_id": u.id} for u in (a, b, c)]
    r = await add(client, a, group, "60.00", splits=split, payers=[{"user_id": a.id, "amount": "40"}, {"user_id": b.id, "amount": "10"}])
    assert r.status_code == 400 and "add up" in r.json()["message"]
    r = await add(client, a, group, "60.00", splits=split + [{"user_id": outsider.id}])
    assert r.status_code == 400 and "in this chat" in r.json()["message"]
    r = await add(client, a, group, "60.00", splits=split, payers=[{"user_id": a.id, "amount": "40"}, {"user_id": b.id, "amount": "20"}])
    assert r.status_code == 200
    debts = (await balances(client, c, group))["currencies"][0]["debts"]
    assert [(d["from_user"], d["to_user"], d["amount_minor"]) for d in debts] == [(c.id, a.id, 2000)]

    r = await add(client, a, group, "10", split_mode="percent",
                  splits=[{"user_id": a.id, "value": "50"}, {"user_id": b.id, "value": "40"}])
    assert r.status_code == 400 and "100" in r.json()["message"]
    r = await add(client, a, group, "10", split_mode="exact",
                  splits=[{"user_id": a.id, "value": "7.50"}, {"user_id": b.id, "value": "2,50"}])
    assert r.status_code == 200
    assert {s["user_id"]: s["amount_minor"] for s in r.json()["data"]["shares"]} == {a.id: 750, b.id: 250}
    r = await add(client, a, group, "1000", currency="JPY", split_mode="shares",
                  splits=[{"user_id": a.id, "value": "2"}, {"user_id": c.id, "value": "1"}])
    assert {s["user_id"]: s["amount_minor"] for s in r.json()["data"]["shares"]} == {a.id: 667, c.id: 333}
    currencies = {cur["currency"] for cur in (await balances(client, a, group))["currencies"]}
    assert currencies == {"EUR", "JPY"}


async def test_edit_history_conflicts_and_permissions(client, trio):
    a, b, c, group = await trio()
    expense = (await add(client, b, group, "30", splits=[{"user_id": u.id} for u in (a, b, c)])).json()["data"]
    url = f"/api/v1/expenses/{expense['id']}"
    edit = {"description": "Pizza", "currency": "EUR", "amount": "36", "split_mode": "equal",
            "splits": [{"user_id": u.id} for u in (a, b, c)], "payers": [{"user_id": b.id, "amount": "36"}]}

    r = await client.put(url, json={**edit, "version": 1}, headers=c.headers)  # any member can edit
    assert r.status_code == 200, r.text
    assert r.json()["data"]["version"] == 2
    r = await client.put(url, json={**edit, "version": 1}, headers=a.headers)  # stale
    assert r.status_code == 409

    r = await client.delete(url, headers=c.headers)  # not the creator, not admin
    assert r.status_code == 403
    r = await client.put(f"{url}/lock", json={"locked": True}, headers=b.headers)  # b isn't an admin
    assert r.status_code == 403
    r = await client.put(f"{url}/lock", json={"locked": True}, headers=a.headers)  # a created the group
    assert r.status_code == 200
    r = await client.put(url, json={**edit, "version": 3}, headers=b.headers)
    assert r.status_code == 403 and "locked" in r.json()["message"]
    await client.put(f"{url}/lock", json={"locked": False}, headers=a.headers)

    r = await client.delete(url, headers=b.headers)  # creator can delete
    assert r.status_code == 200
    assert (await balances(client, a, group))["currencies"] == []
    r = await client.post(f"{url}/restore", headers=a.headers)
    assert r.status_code == 200
    assert (await balances(client, a, group))["currencies"][0]["my_net_minor"] == -1200

    history = (await client.get(f"{url}/history", headers=a.headers)).json()["data"]
    actions = [h["action"] for h in history]
    assert actions == ["restored", "deleted", "unlocked", "locked", "updated", "created"]
    updated = history[4]
    assert updated["actor"]["id"] == c.id
    assert "'Dinner' to 'Pizza'" in updated["summary"] and "€30.00 to €36.00" in updated["summary"]
    assert updated["before"]["total_minor"] == 3000 and updated["after"]["total_minor"] == 3600

    listed = (await client.get(f"/api/v1/conversations/{group}/expenses", headers=a.headers)).json()["data"]
    assert [e["description"] for e in listed] == ["Pizza"]


async def test_dm_both_people_are_admins(client, make_user, make_dm):
    a, b = await make_user(), await make_user()
    dm = await make_dm(a, b)
    expense = (await add(client, a, dm, "20", splits=[{"user_id": a.id}, {"user_id": b.id}])).json()["data"]
    r = await client.delete(f"/api/v1/expenses/{expense['id']}", headers=b.headers)
    assert r.status_code == 200


async def test_settle_up_and_simplify_setting(client, trio, events):
    a, b, c, group = await trio()
    await add(client, b, group, "10", splits=[{"user_id": a.id}])  # a owes b 10
    await add(client, c, group, "10", splits=[{"user_id": b.id}])  # b owes c 10
    simplified = (await balances(client, a, group))["currencies"][0]["debts"]
    assert [(d["from_user"], d["to_user"]) for d in simplified] == [(a.id, c.id)]

    r = await client.put(f"/api/v1/conversations/{group}/expense-settings", json={"simplify_debts": False}, headers=a.headers)
    assert r.status_code == 200
    raw = (await balances(client, a, group))["currencies"][0]["debts"]
    assert {(d["from_user"], d["to_user"]) for d in raw} == {(a.id, b.id), (b.id, c.id)}

    r = await client.post(f"/api/v1/conversations/{group}/settlements",
                          json={"from_user": a.id, "to_user": b.id, "currency": "EUR", "amount": "10"}, headers=a.headers)
    assert r.status_code == 200
    assert any("paid" in (p.get("text") or "") for _, p in events)
    raw = (await balances(client, a, group))["currencies"][0]["debts"]
    assert [(d["from_user"], d["to_user"]) for d in raw] == [(b.id, c.id)]

    settlement = r.json()["data"]["id"]
    assert (await client.delete(f"/api/v1/settlements/{settlement}", headers=c.headers)).status_code == 403
    assert (await client.delete(f"/api/v1/settlements/{settlement}", headers=a.headers)).status_code == 200


async def test_payee_can_fix_or_undo_a_payment(client, trio, events):
    a, b, c, group = await trio()
    await add(client, b, group, "30", splits=[{"user_id": a.id}])  # a owes b 30
    r = await client.post(f"/api/v1/conversations/{group}/settlements",
                          json={"from_user": a.id, "to_user": b.id, "currency": "EUR", "amount": "30"}, headers=a.headers)
    settlement = r.json()["data"]["id"]

    # Bob only got 20: he fixes it, and the chat is told
    r = await client.patch(f"/api/v1/settlements/{settlement}", json={"amount": "20"}, headers=b.headers)
    assert r.status_code == 200 and r.json()["data"]["amount_minor"] == 2000
    assert any("changed a payment" in (p.get("text") or "") and "(was €30.00)" in p["text"] for _, p in events)
    debts = (await balances(client, a, group))["currencies"][0]["debts"]
    assert [(d["from_user"], d["to_user"], d["amount_minor"]) for d in debts] == [(a.id, b.id, 1000)]

    assert (await client.patch(f"/api/v1/settlements/{settlement}", json={"amount": "0"}, headers=b.headers)).status_code == 400
    assert (await client.patch(f"/api/v1/settlements/{settlement}", json={"amount": "5"}, headers=c.headers)).status_code == 403

    # Then undoes it: the whole 30 is owed again
    assert (await client.delete(f"/api/v1/settlements/{settlement}", headers=b.headers)).status_code == 200
    assert any("undid a payment" in (p.get("text") or "") for _, p in events)
    debts = (await balances(client, a, group))["currencies"][0]["debts"]
    assert [d["amount_minor"] for d in debts] == [3000]
    assert (await client.patch(f"/api/v1/settlements/{settlement}", json={"amount": "5"}, headers=b.headers)).status_code == 404


async def test_outsider_sees_nothing(client, trio, make_user):
    a, b, c, group = await trio()
    expense = (await add(client, a, group, "5", splits=[{"user_id": a.id}])).json()["data"]
    outsider = await make_user()
    assert (await client.get(f"/api/v1/expenses/{expense['id']}", headers=outsider.headers)).status_code == 404
    assert (await client.get(f"/api/v1/conversations/{group}/balances", headers=outsider.headers)).status_code == 404
    assert (await add(client, outsider, group, "5", splits=[{"user_id": outsider.id}])).status_code == 404


# ------------------------------------------------------------------ AI settings

async def test_ai_settings_show_only_usage(client, make_user):
    """ShareEven picks the model; people can't choose one or add their own keys."""
    user = await make_user()
    data = (await client.get("/api/v1/ai/settings", headers=user.headers)).json()["data"]
    assert data == {"usage": {"scans_this_month": 0, "monthly_limit": data["usage"]["monthly_limit"]}}
    assert (await client.put("/api/v1/ai/settings", json={"preferred_model_id": 2}, headers=user.headers)).status_code == 405
    assert (await client.put("/api/v1/ai/keys/anthropic", json={"api_key": "sk-ant-" + "x" * 40}, headers=user.headers)).status_code == 404


async def test_store_discounts_are_private(client, make_user):
    a, b = await make_user(), await make_user()
    r = await client.post("/api/v1/store-discounts", json={"store_name": "Tesco", "percent": "10", "excluded_categories": ["Alcohol"]}, headers=a.headers)
    rule = r.json()["data"]
    assert rule["percent"] == "10" and rule["excluded_categories"] == ["alcohol"]
    assert (await client.get("/api/v1/store-discounts", headers=b.headers)).json()["data"] == []
    assert (await client.delete(f"/api/v1/store-discounts/{rule['id']}", headers=b.headers)).status_code == 404
    r = await client.put(f"/api/v1/store-discounts/{rule['id']}", json={"store_name": "Tesco", "percent": "15"}, headers=a.headers)
    assert r.json()["data"]["percent"] == "15"


async def test_admin_only_model_management(client, make_user, db):
    user, admin = await make_user(), await make_user()
    assert (await client.get("/api/v1/admin/ai", headers=user.headers)).status_code == 403
    await db.execute(update(User).where(User.id == uuid.UUID(admin.id)).values(is_app_admin=True))
    await db.commit()

    data = (await client.get("/api/v1/admin/ai", headers=admin.headers)).json()["data"]
    assert data["receipt_scans_per_month"] == 50
    sonnet = next(m for m in data["models"] if m["model_id"] == "claude-sonnet-5")
    body = {**{k: sonnet[k] for k in ("provider", "model_id", "label", "description", "sort_order")}, "enabled": True, "is_default": True}
    r = await client.put(f"/api/v1/admin/ai/models/{sonnet['id']}", json=body, headers=admin.headers)
    defaults = [m["model_id"] for m in r.json()["data"]["models"] if m["is_default"]]
    assert defaults == ["claude-sonnet-5"]

    r = await client.put("/api/v1/admin/ai/scan-limit", json={"receipt_scans_per_month": 80}, headers=user.headers)
    assert r.status_code == 403
    r = await client.put("/api/v1/admin/ai/scan-limit", json={"receipt_scans_per_month": 80}, headers=admin.headers)
    assert r.json()["data"]["receipt_scans_per_month"] == 80

    # put things back for other tests
    opus = next(m for m in data["models"] if m["model_id"] == "claude-opus-5")
    body = {**{k: opus[k] for k in ("provider", "model_id", "label", "description", "sort_order")}, "enabled": True, "is_default": True}
    await client.put(f"/api/v1/admin/ai/models/{opus['id']}", json=body, headers=admin.headers)
    await client.put("/api/v1/admin/ai/scan-limit", json={"receipt_scans_per_month": 50}, headers=admin.headers)


async def test_conversations_with_expenses(client, trio, make_user, make_dm):
    a, b, c, group = await trio()
    dm = await make_dm(a, b)
    empty_dm = await make_dm(a, c)
    await add(client, a, dm, "10", splits=[{"user_id": a.id}, {"user_id": b.id}])
    ids = (await client.get("/api/v1/expenses/conversations", headers=a.headers)).json()["data"]
    assert dm in ids and empty_dm not in ids and group not in ids
    outsider = await make_user()
    assert (await client.get("/api/v1/expenses/conversations", headers=outsider.headers)).json()["data"] == []


async def test_summary_and_filtered_history(client, trio, make_user):
    a, b, c, group = await trio()
    everyone = [{"user_id": u.id} for u in (a, b, c)]
    assert (await add(client, a, group, "30.00", category="food", splits=everyone, spent_at="2026-09-10T12:00:00Z")).status_code == 200
    assert (await add(client, b, group, "12.00", category="groceries", description="Milk and bread", splits=everyone,
                      payers=[{"user_id": b.id, "amount": "12.00"}], spent_at="2026-10-02T12:00:00Z")).status_code == 200
    assert (await add(client, a, group, "5.00", currency="USD", category="drinks", splits=[{"user_id": a.id}, {"user_id": c.id}], spent_at="2026-08-01T12:00:00Z")).status_code == 200
    r = await client.post(f"/api/v1/conversations/{group}/settlements",
                          json={"from_user": c.id, "to_user": a.id, "currency": "EUR", "amount": "5.00"}, headers=c.headers)
    assert r.status_code == 200, r.text

    s = (await client.get(f"/api/v1/conversations/{group}/expenses/summary", headers=c.headers)).json()["data"]
    eur = next(x for x in s["currencies"] if x["currency"] == "EUR")
    assert eur["total_minor"] == 4200 and eur["count"] == 2
    assert [x["category"] for x in eur["by_category"]] == ["food", "groceries"]
    assert [x["month"] for x in eur["by_month"]] == ["2026-10", "2026-09"]
    members = {m["user_id"]: m for m in eur["members"]}
    assert members[a.id]["paid_minor"] == 3000 and members[a.id]["share_minor"] == 1400
    assert members[c.id]["sent_minor"] == 500 and members[a.id]["received_minor"] == 500
    assert sum(m["net_minor"] for m in eur["members"]) == 0  # the group's books balance
    # Every member's balance matches the balances endpoint
    nets = {n["user_id"]: n["amount_minor"] for n in (await balances(client, c, group))["currencies"][0]["nets"]}
    assert all(members[u]["net_minor"] == nets.get(u, 0) for u in members)
    assert eur["me"]["user_id"] == c.id and eur["me"]["net_minor"] == members[c.id]["net_minor"]
    assert set(s["users"]) == {a.id, b.id, c.id}

    def history(**params):
        return client.get(f"/api/v1/conversations/{group}/history", params=params, headers=a.headers)

    items = (await history()).json()["data"]["items"]
    assert [i["kind"] for i in items].count("settlement") == 1 and len(items) == 4
    assert [i["at"] for i in items] == sorted((i["at"] for i in items), reverse=True)
    assert [i["description"] for i in (await history(category="groceries")).json()["data"]["items"]] == ["Milk and bread"]
    october = (await history(date_from="2026-10-01T00:00:00Z", date_to="2026-11-01T00:00:00Z", kind="expense")).json()["data"]["items"]
    assert [i["description"] for i in october] == ["Milk and bread"]
    by_c = (await history(member=c.id)).json()["data"]["items"]
    assert len(by_c) == 4  # c shares everything and made the payment
    outsider = await make_user("outsider")
    assert (await client.get(f"/api/v1/conversations/{group}/history", headers=outsider.headers)).status_code == 404


async def test_overview_across_chats_reminders_and_payment_details(client, trio, make_user, make_dm, events):
    a, b, c, group = await trio()
    dm = await make_dm(a, b)
    everyone = [{"user_id": u.id} for u in (a, b, c)]
    assert (await add(client, a, group, "30.00", splits=everyone)).status_code == 200  # b and c owe a 10 each
    assert (await add(client, b, dm, "8.00", splits=[{"user_id": a.id}, {"user_id": b.id}],
                      payers=[{"user_id": b.id, "amount": "8.00"}])).status_code == 200  # a owes b 4
    assert (await add(client, a, group, "6.00", currency="USD", splits=[{"user_id": a.id}, {"user_id": c.id}])).status_code == 200

    o = (await client.get("/api/v1/expenses/overview", headers=a.headers)).json()["data"]
    eur = next(x for x in o["currencies"] if x["currency"] == "EUR")
    assert (eur["owed_minor"], eur["owe_minor"], eur["net_minor"]) == (2000, 400, 1600)
    people = {(p["user_id"], p["currency"]): p for p in o["people"]}
    assert people[(b.id, "EUR")]["net_minor"] == 1000 - 400  # owes a in the group, a owes b in the DM
    assert sorted(ch["amount_minor"] for ch in people[(b.id, "EUR")]["chats"]) == [-400, 1000]
    assert people[(c.id, "USD")]["net_minor"] == 300
    assert next(ch for ch in people[(b.id, "EUR")]["chats"] if ch["is_group"])["title"] == "Trip"
    assert set(o["users"]) == {b.id, c.id}

    # Payment details: saved on the profile, shown to chat partners, bad formats refused
    r = await client.patch("/api/v1/auth/me", json={"payment_handles": {"revolut": "@alice", "paypal": "AliceP", "upi": "alice@okbank"}}, headers=a.headers)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["payment_handles"] == {"revolut": "alice", "paypal": "AliceP", "upi": "alice@okbank"}
    assert (await client.patch("/api/v1/auth/me", json={"payment_handles": {"upi": "not a upi"}}, headers=a.headers)).status_code == 422
    r = await client.patch("/api/v1/auth/me", json={"payment_handles": {"paypal": ""}}, headers=a.headers)  # one at a time
    assert r.json()["data"]["payment_handles"] == {"revolut": "alice", "upi": "alice@okbank"}
    await client.patch("/api/v1/auth/me", json={"payment_handles": {"paypal": "AliceP"}}, headers=a.headers)
    seen = (await balances(client, b, group))["users"][a.id]["pay"]
    assert seen == {"revolut": "alice", "paypal": "AliceP", "upi": "alice@okbank"}
    await client.patch("/api/v1/auth/me", json={"payment_handles": {"revolut": "", "paypal": "", "upi": ""}}, headers=a.headers)
    assert (await balances(client, b, group))["users"][a.id]["pay"] == {}

    # Reminders: only to someone who owes you, once a day
    events.clear()
    r = await client.post(f"/api/v1/conversations/{group}/remind", json={"user_id": c.id, "currency": "EUR"}, headers=a.headers)
    assert r.status_code == 200, r.text
    sent = [p for ids, p in events if p.get("type") == "expense_reminder"]
    assert sent and sent[0]["amountMinor"] == 1000 and "in Trip" in sent[0]["text"]
    assert (await client.post(f"/api/v1/conversations/{group}/remind", json={"user_id": c.id, "currency": "EUR"}, headers=a.headers)).status_code == 429
    assert (await client.post(f"/api/v1/conversations/{group}/remind", json={"user_id": a.id, "currency": "EUR"}, headers=c.headers)).status_code == 400
    outsider = await make_user("outsider")
    assert (await client.post(f"/api/v1/conversations/{group}/remind", json={"user_id": c.id, "currency": "EUR"}, headers=outsider.headers)).status_code == 404


# ------------------------------------------------------------------ Expenses home, display currency

async def test_recent_activity_across_chats(client, trio, make_user, make_dm):
    a, b, c, group = await trio()
    dm = await make_dm(a, b)
    await add(client, a, group, "12", splits=[{"user_id": b.id}])
    await add(client, b, dm, "8", splits=[{"user_id": a.id}])
    await client.post(f"/api/v1/conversations/{group}/settlements",
                      json={"from_user": b.id, "to_user": a.id, "currency": "EUR", "amount": "5"}, headers=b.headers)
    data = (await client.get("/api/v1/expenses/activity", headers=a.headers)).json()["data"]
    assert [i["kind"] for i in data["items"]] == ["settlement", "expense", "expense"]
    assert data["chats"][group]["is_group"] and data["chats"][dm] == {"name": b.username, "is_group": False}
    assert data["items"][1]["can_edit"] is True
    assert {a.id, b.id} <= set(data["users"])

    # Someone outside both chats sees none of it
    outsider = await make_user()
    assert (await client.get("/api/v1/expenses/activity", headers=outsider.headers)).json()["data"]["items"] == []


async def test_display_currency_setting(client, make_user):
    user = await make_user()
    r = await client.patch("/api/v1/auth/me", json={"display_currency": "usd"}, headers=user.headers)
    assert r.status_code == 200 and r.json()["data"]["display_currency"] == "USD"
    assert (await client.patch("/api/v1/auth/me", json={"display_currency": "XYZ"}, headers=user.headers)).status_code == 422
    r = await client.patch("/api/v1/auth/me", json={"display_currency": ""}, headers=user.headers)
    assert r.json()["data"]["display_currency"] is None


async def test_exchange_rates_relative_to_base(client, make_user, monkeypatch):
    from app.services import fx_rates

    async def fake_usd_rates():
        return {"USD": 1.0, "EUR": 0.5, "INR": 80.0}, "Sat, 11 Oct 2026 00:00:01 +0000"
    monkeypatch.setattr(fx_rates, "usd_rates", fake_usd_rates)
    user = await make_user()
    data = (await client.get("/api/v1/exchange-rates", params={"base": "eur"}, headers=user.headers)).json()["data"]
    assert data["base"] == "EUR" and data["rates"]["USD"] == 2.0 and data["rates"]["INR"] == 160.0

    async def broken():
        raise fx_rates.RatesUnavailable("down")
    monkeypatch.setattr(fx_rates, "usd_rates", broken)
    assert (await client.get("/api/v1/exchange-rates", params={"base": "EUR"}, headers=user.headers)).status_code == 503


def test_export_never_writes_formulas():
    from openpyxl import Workbook
    from app.services.expense_export import _no_formulas
    wb = Workbook()
    ws = wb.active
    ws["A1"] = '=HYPERLINK("https://evil.example","Click")'
    ws["A2"] = "Tesco"
    assert ws["A1"].data_type == "f"  # what openpyxl would have saved
    _no_formulas(wb)
    assert ws["A1"].data_type == "s" and ws["A1"].value.startswith("=HYPERLINK")
    assert ws["A2"].data_type == "s"
