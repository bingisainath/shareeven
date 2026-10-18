"""Receipt scanning end to end with a fake AI reader (no network calls)."""

import uuid

import pytest
from sqlalchemy import select

from app.config.settings import settings
from app.models.ai import AppSetting, UserAISettings
from app.models.message import Message
from app.models.receipt import StoreDiscountRule
from app.services import secrets
from app.services.receipt_ai import pipeline
from app.services.receipt_ai.base import ExtractionError, ExtractionResult
from app.services.receipt_ai.schema import ReceiptExtraction
from tests.test_media import upload


def item(name, price, flags=(), category="other", quantity="1", confidence=0.97):
    return {"raw_text": f"{name.upper()} {price}", "name": name, "quantity": quantity, "unit": "each",
            "unit_price": None, "line_total": price, "category": category, "flags": list(flags),
            "tax_code": None, "confidence": confidence}


def adjustment(kind, label, amount, items=(), included=False):
    return {"kind": kind, "label": label, "amount": amount, "percent": None,
            "applies_to_items": list(items), "already_included_in_items": included}


TESCO = {
    "is_receipt": True, "store_name": "TESCO Ireland", "purchased_at": "2026-10-04", "currency": "EUR",
    "prices_include_tax": True,
    "items": [
        item("Milk", "1.80", category="dairy"),
        item("Cheese", "4.00", category="dairy"),
        item("Rice", "12.00", category="pantry"),
        item("Bread", "1.60", flags=["reduced"], category="bakery"),
        item("Croissants", "2.50", flags=["reduced"], category="bakery"),
    ],
    "adjustments": [
        adjustment("item_discount", "Reduced", "-1.20", [3]),
        adjustment("item_discount", "Reduced", "-2.50", [4]),
        adjustment("tax", "VAT incl.", "1.10", included=True),
    ],
    "subtotal": None, "total": "18.20", "payment_method": "card", "warnings": [],
}


class FakeExtractor:
    provider = "anthropic"

    def __init__(self):
        self.response = TESCO
        self.calls = []
        self.error = None

    async def extract(self, images, note, model, api_key):
        self.calls.append({"images": len(images), "model": model, "api_key": api_key})
        if self.error:
            raise ExtractionError(self.error)
        return ExtractionResult(ReceiptExtraction.model_validate(self.response), model, {"input_tokens": 1500, "output_tokens": 400})


@pytest.fixture
def fake_ai(monkeypatch):
    fake = FakeExtractor()
    monkeypatch.setitem(pipeline.EXTRACTORS, "anthropic", fake)
    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "sk-ant-server-key")
    return fake


@pytest.fixture
def six(make_user, make_group):
    async def _make():
        people = [await make_user(f"p{i}") for i in range(1, 7)]
        group = await make_group(people[0], people[1:], "Flat")
        return people, group
    return _make


async def scan(client, user, conversation_id, note=None):
    url = (await upload(client, user)).json()["data"]["url"]
    r = await client.post(f"/api/v1/conversations/{conversation_id}/receipts",
                          json={"image_urls": [url], "note": note}, headers=user.headers)
    assert r.status_code == 200, r.text
    r = await client.get(f"/api/v1/receipts/{r.json()['data']['id']}", headers=user.headers)
    return r.json()["data"]


def review_body(receipt, assign: dict[int, list], enable_rule=False, payers=None):
    """Turn a receipt response into the PUT body the review screen sends."""
    return {
        "store_name": receipt["store_name"],
        "currency": receipt["currency"],
        "printed_total": "18.20",
        "items": [
            {"id": i["id"], "name": i["name"], "quantity": i["quantity"], "unit": i["unit"],
             "price": f"{i['gross_minor'] / 100:.2f}", "category": i["category"], "flags": i["flags"],
             "split_mode": "equal", "assignments": [{"user_id": u, "value": "1"} for u in assign[n]]}
            for n, i in enumerate(receipt["items"])
        ],
        "adjustments": [
            {"kind": a["kind"], "label": a["label"], "amount": f"{a['amount_minor'] / 100:.2f}", "percent": a["percent"],
             "item_indexes": a["item_indexes"], "allocation": a["allocation"], "assignee_ids": a["assignee_ids"],
             "source": a["source"], "enabled": a["enabled"] or (enable_rule and a["source"] == "store_rule")}
            for a in receipt["adjustments"]
        ],
        "payers": payers,
    }


async def test_scan_review_and_save_the_tesco_example(client, six, fake_ai, events, db):
    people, group = await six()
    p1, p2, p3, p4, p5, p6 = people
    r = await client.post("/api/v1/store-discounts", json={"store_name": "Tesco", "percent": "10"}, headers=p1.headers)
    assert r.status_code == 200, r.text

    receipt = await scan(client, p1, group, note="weekly shop")
    assert fake_ai.calls == [{"images": 1, "model": "claude-opus-5", "api_key": "sk-ant-server-key"}]
    assert receipt["status"] == "ready", receipt["warnings"]
    assert receipt["model"] == "claude-opus-5" and receipt["key_source"] == "app"
    assert [i["name"] for i in receipt["items"]] == ["Milk", "Cheese", "Rice", "Bread", "Croissants"]
    assert all(len(i["assignments"]) == 6 for i in receipt["items"])  # everyone by default
    assert receipt["totals"]["computed_total_minor"] == 1820 and receipt["totals"]["difference_minor"] == 0
    assert not any(a["kind"] == "tax" for a in receipt["adjustments"])  # VAT already inside prices

    rule = next(a for a in receipt["adjustments"] if a["source"] == "store_rule")
    assert rule["enabled"] is False  # not printed -> off by default
    assert rule["item_indexes"] == [0, 1, 2]  # not on reduced items
    assert rule["amount_minor"] == -178

    assign = {0: [p1.id], 1: [p2.id, p3.id], 2: [p.id for p in people], 3: [p4.id], 4: [p5.id]}
    r = await client.put(f"/api/v1/receipts/{receipt['id']}", json=review_body(receipt, assign, enable_rule=True), headers=p2.headers)
    assert r.status_code == 200, r.text
    reviewed = r.json()["data"]
    totals = {p["user_id"]: p["amount_minor"] for p in reviewed["totals"]["people"]}
    assert totals == {p1.id: 342, p2.id: 360, p3.id: 360, p4.id: 220, p5.id: 180, p6.id: 180}
    assert reviewed["totals"]["computed_total_minor"] == 1642
    assert reviewed["totals"]["difference_minor"] == 0  # own discount isn't on the receipt, so no mismatch
    assert reviewed["payers"] == [{"user_id": p1.id, "amount_minor": 1642}]

    events.clear()
    r = await client.post(f"/api/v1/receipts/{receipt['id']}/save", json={}, headers=p1.headers)
    assert r.status_code == 200, r.text
    expense = r.json()["data"]
    assert expense["source"] == "receipt" and expense["split_mode"] == "itemized"
    assert expense["total_minor"] == 1642 and expense["description"] == "TESCO Ireland"
    assert {s["user_id"]: s["amount_minor"] for s in expense["shares"]} == totals
    assert len(expense["receipt_images"]) == 1 and "sig=" in expense["receipt_images"][0]
    assert any(p.get("expenseId") == expense["id"] for _, p in events)

    card = (await db.execute(select(Message).where(Message.expense_id == uuid.UUID(expense["id"])))).scalar_one()
    assert "TESCO Ireland" in card.text

    balances = (await client.get(f"/api/v1/conversations/{group}/balances", headers=p2.headers)).json()["data"]
    eur = balances["currencies"][0]
    assert eur["currency"] == "EUR" and eur["my_net_minor"] == -360
    assert sum(d["amount_minor"] for d in eur["debts"]) == 1642 - 342
    assert all(d["to_user"] == p1.id for d in eur["debts"])

    # The next receipt remembers who milk is for
    again = await scan(client, p1, group)
    milk = again["items"][0]
    assert [a["user_id"] for a in milk["assignments"]] == [p1.id]
    assert milk["suggestion"].startswith("Usually for")


async def test_two_payers_and_mismatch_needs_review(client, six, fake_ai):
    people, group = await six()
    fake_ai.response = {**TESCO, "total": "19.00", "adjustments": TESCO["adjustments"][:2]}
    receipt = await scan(client, people[0], group)
    assert receipt["status"] == "needs_review"
    assert any("add up to" in w for w in receipt["warnings"])

    everyone = {n: [p.id for p in people] for n in range(5)}
    body = review_body(receipt, everyone, payers=[{"user_id": people[0].id, "amount": "10.00"}, {"user_id": people[1].id, "amount": "5.00"}])
    body["printed_total"] = "18.20"
    r = await client.put(f"/api/v1/receipts/{receipt['id']}", json=body, headers=people[0].headers)
    assert r.status_code == 200
    r = await client.post(f"/api/v1/receipts/{receipt['id']}/save", json={}, headers=people[0].headers)
    assert r.status_code == 400 and "€18.20" in r.json()["message"]

    body["payers"][1]["amount"] = "8.20"
    await client.put(f"/api/v1/receipts/{receipt['id']}", json=body, headers=people[0].headers)
    r = await client.post(f"/api/v1/receipts/{receipt['id']}/save", json={"description": "Big shop"}, headers=people[0].headers)
    assert r.status_code == 200, r.text
    payers = {p["user_id"]: p["amount_minor"] for p in r.json()["data"]["payers"]}
    assert payers == {people[0].id: 1000, people[1].id: 820}


async def test_single_other_payer_covers_the_whole_bill(client, six, fake_ai):
    people, group = await six()
    receipt = await scan(client, people[0], group)
    everyone = {n: [p.id for p in people] for n in range(5)}
    body = review_body(receipt, everyone, payers=[{"user_id": people[2].id}])
    r = await client.put(f"/api/v1/receipts/{receipt['id']}", json=body, headers=people[0].headers)
    assert r.json()["data"]["payers"] == [{"user_id": people[2].id, "amount_minor": 1820}]


async def test_unassigned_items_block_saving(client, six, fake_ai):
    people, group = await six()
    receipt = await scan(client, people[0], group)
    assign = {n: [people[0].id] for n in range(5)}
    assign[2] = []
    r = await client.put(f"/api/v1/receipts/{receipt['id']}", json=review_body(receipt, assign), headers=people[0].headers)
    assert r.json()["data"]["totals"]["unassigned_item_indexes"] == [2]
    r = await client.post(f"/api/v1/receipts/{receipt['id']}/save", json={}, headers=people[0].headers)
    assert r.status_code == 400 and "who each item is for" in r.json()["message"]


async def test_not_a_receipt_and_ai_errors(client, six, fake_ai):
    people, group = await six()
    fake_ai.response = {**TESCO, "is_receipt": False, "items": [], "adjustments": []}
    receipt = await scan(client, people[0], group)
    assert receipt["status"] == "failed" and "doesn't look like a receipt" in receipt["error"]

    fake_ai.error = "The Claude API key was rejected"
    receipt = await scan(client, people[0], group)
    assert receipt["status"] == "failed" and receipt["error"] == "The Claude API key was rejected"

    fake_ai.error = None
    fake_ai.response = TESCO
    r = await client.post(f"/api/v1/receipts/{receipt['id']}/retry", headers=people[1].headers)
    assert r.status_code == 403
    r = await client.post(f"/api/v1/receipts/{receipt['id']}/retry", headers=people[0].headers)
    assert r.status_code == 200
    r = await client.get(f"/api/v1/receipts/{receipt['id']}", headers=people[0].headers)
    assert r.json()["data"]["status"] == "ready"


@pytest.fixture
async def scan_limit_one(db):
    row = await db.get(AppSetting, pipeline.SCAN_LIMIT_KEY)
    previous, row.value = row.value, "1"
    await db.commit()
    yield
    row.value = previous
    await db.commit()


async def test_monthly_limit(client, make_user, make_dm, fake_ai, db, scan_limit_one):
    a, b = await make_user(), await make_user()
    dm = await make_dm(a, b)
    await scan(client, a, dm)
    url = (await upload(client, a)).json()["data"]["url"]
    r = await client.post(f"/api/v1/conversations/{dm}/receipts", json={"image_urls": [url]}, headers=a.headers)
    assert r.status_code == 429 and "reset on the 1st" in r.json()["message"]

    # A key saved before own keys were removed is ignored: the app's key and limit apply
    db.add(UserAISettings(user_id=uuid.UUID(a.id), anthropic_key_encrypted=secrets.encrypt("sk-ant-users-own-key")))
    await db.commit()
    r = await client.post(f"/api/v1/conversations/{dm}/receipts", json={"image_urls": [url]}, headers=a.headers)
    assert r.status_code == 429


async def test_admin_sets_scans_per_person(client, make_user, make_dm, fake_ai, db, scan_limit_one):
    """App limit 1: a tester gets a custom limit, someone else extra scans this month, a third is paused."""
    from sqlalchemy import update
    from app.models.user import User
    admin, tester, other = await make_user("admin"), await make_user(), await make_user()
    await db.execute(update(User).where(User.id == uuid.UUID(admin.id)).values(is_app_admin=True))
    await db.commit()
    dm = await make_dm(tester, other)
    base = f"/api/v1/admin/users"

    # Only admins, and a reason is required
    assert (await client.post(f"{base}/{tester.id}/scan-limit", json={"limit": 3, "reason": "beta"}, headers=other.headers)).status_code == 403
    assert (await client.post(f"{base}/{tester.id}/scan-limit", json={"limit": 3}, headers=admin.headers)).status_code == 422

    r = await client.post(f"{base}/{tester.id}/scan-limit", json={"limit": 3, "reason": "Beta tester"}, headers=admin.headers)
    assert r.status_code == 200 and r.json()["data"]["limit"] == 3 and r.json()["data"]["app_limit"] == 1
    for _ in range(3):
        await scan(client, tester, dm)
    url = (await upload(client, tester)).json()["data"]["url"]
    assert (await client.post(f"/api/v1/conversations/{dm}/receipts", json={"image_urls": [url]}, headers=tester.headers)).status_code == 429
    usage = (await client.get("/api/v1/ai/settings", headers=tester.headers)).json()["data"]["usage"]
    assert usage == {"scans_this_month": 3, "monthly_limit": 3}

    # Extra scans add up within the month, on top of the app's limit
    await scan(client, other, dm)
    for count in (1, 2):
        r = await client.post(f"{base}/{other.id}/extra-scans", json={"count": count, "reason": "A scan went wrong"}, headers=admin.headers)
    assert r.json()["data"] == {"limit": 4, "app_limit": 1, "custom_limit": None, "extra_this_month": 3, "used": 1}
    await scan(client, other, dm)

    # Extra scans from an earlier month don't count
    await db.execute(update(User).where(User.id == uuid.UUID(other.id)).values(extra_scans_month=pipeline._month_start().date().replace(year=2020)))
    await db.commit()
    details = (await client.get(f"{base}/{other.id}", headers=admin.headers)).json()["data"]["scans"]
    assert details["extra_this_month"] == 0 and details["limit"] == 1 and details["used"] == 2

    # 0 pauses scanning with its own message; null goes back to the app's limit
    await client.post(f"{base}/{tester.id}/scan-limit", json={"limit": 0, "reason": "Abuse"}, headers=admin.headers)
    r = await client.post(f"/api/v1/conversations/{dm}/receipts", json={"image_urls": [url]}, headers=tester.headers)
    assert r.status_code == 429 and "paused" in r.json()["message"]
    r = await client.post(f"{base}/{tester.id}/scan-limit", json={"limit": None, "reason": "Resolved"}, headers=admin.headers)
    assert r.json()["data"]["custom_limit"] is None and r.json()["data"]["limit"] == 1

    log = [a["action"] for a in (await client.get("/api/v1/admin/actions", headers=admin.headers)).json()["data"]]
    assert log.count("scan_limit_set") == 3 and log.count("extra_scans") == 2


async def test_no_server_key_and_access(client, make_user, make_dm, fake_ai, monkeypatch):
    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "")
    a, b, outsider = await make_user(), await make_user(), await make_user()
    dm = await make_dm(a, b)
    url = (await upload(client, a)).json()["data"]["url"]
    r = await client.post(f"/api/v1/conversations/{dm}/receipts", json={"image_urls": [url]}, headers=a.headers)
    assert r.status_code == 503 and "isn't set up" in r.json()["message"]

    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "sk-ant-server-key")
    receipt = await scan(client, a, dm)
    r = await client.get(f"/api/v1/receipts/{receipt['id']}", headers=outsider.headers)
    assert r.status_code == 404
    r = await client.post(f"/api/v1/conversations/{dm}/receipts",
                          json={"image_urls": ["https://evil.example/x.png"]}, headers=a.headers)
    assert r.status_code == 400


async def test_app_model_only_and_store_rule_matching(client, six, fake_ai, db):
    people, group = await six()
    owner = people[0]
    # Chats can't pick a model any more: the old setting is ignored and the app default is used
    from app.models.expense import ConversationSettings
    settings_row = await db.get(ConversationSettings, uuid.UUID(group))
    if settings_row is None:
        settings_row = ConversationSettings(conversation_id=uuid.UUID(group))
        db.add(settings_row)
    settings_row.receipt_model_id = 3
    db.add(StoreDiscountRule(owner_id=uuid.UUID(owner.id), store_name="Lidl", store_key="lidl", percent=5))
    await db.commit()
    receipt = await scan(client, owner, group)
    assert fake_ai.calls[-1]["model"] == "claude-opus-5"
    assert not any(a["source"] == "store_rule" for a in receipt["adjustments"])  # Lidl rule, Tesco receipt


def test_workspace_header_only_for_the_server_key(monkeypatch):
    import httpx2
    import anthropic
    from app.services.receipt_ai import claude

    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "sk-ant-server")
    monkeypatch.setattr(settings, "ANTHROPIC_WORKSPACE_ID", "wrkspc_123")
    assert claude.make_client("sk-ant-server").default_headers.get("anthropic-workspace-id") == "wrkspc_123"
    assert "anthropic-workspace-id" not in claude.make_client("sk-ant-someone-else").default_headers

    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx2.Response(400, request=request)
    error = anthropic.BadRequestError("This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header", response=response, body=None)
    assert claude.is_workspace_error(error)


async def test_excel_export_summary_and_discounted_products(client, six, fake_ai, make_user):
    import io
    from openpyxl import load_workbook

    people, group = await six()
    p1, p2, p3, p4, p5, p6 = people
    receipt = await scan(client, p1, group)
    assign = {0: [p1.id], 1: [p2.id, p3.id], 2: [p.id for p in people], 3: [p4.id], 4: [p5.id]}
    r = await client.put(f"/api/v1/receipts/{receipt['id']}", json=review_body(receipt, assign), headers=p1.headers)
    assert r.status_code == 200, r.text
    assert (await client.post(f"/api/v1/receipts/{receipt['id']}/save", json={}, headers=p1.headers)).status_code == 200

    r = await client.get(f"/api/v1/conversations/{group}/expenses/export", headers=p2.headers)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats")
    assert 'filename="Flat-expenses-' in r.headers["content-disposition"]
    wb = load_workbook(io.BytesIO(r.content))
    assert wb.sheetnames == ["Summary", "Split", "Expenses", "Discounts"]

    split = list(wb["Split"].iter_rows(values_only=True))
    people_cols = split[0][6:]
    assert len(people_cols) == 6
    head = split[1]
    assert head[1].startswith("TESCO Ireland · paid by") and head[5] == 18.2 and round(sum(v for v in head[6:] if v), 2) == 18.2
    rows = {r[1].strip(): r for r in split[2:]}
    assert list(rows) == ["Milk", "Cheese", "Rice", "Bread", "Croissants"]
    assert rows["Rice"][3:6] == (12, None, 12) and sorted(v for v in rows["Rice"][6:] if v) == [2] * 6
    assert sorted(v for v in rows["Cheese"][6:] if v) == [2, 2]
    assert rows["Bread"][3:6] == (1.6, -1.2, 0.4) and [v for v in rows["Bread"][6:] if v] == [0.4]
    for p_col in range(6, 12):  # each person's column adds up to their share in the expense row
        assert round(sum(r[p_col] or 0 for r in split[2:]), 2) == (head[p_col] or 0)

    summary = [[c for c in row if c is not None] for row in wb["Summary"].iter_rows(values_only=True)]
    assert summary[0] == ["Flat · expenses"]
    assert ["EUR · total spent", 18.2] in summary
    assert ["Saved with discounts", 3.7, "on 2 products (see Discounts)"] in summary
    assert "To settle up" in [row[0] for row in summary if row]

    expenses = list(wb["Expenses"].iter_rows(min_row=2, values_only=True))
    assert len(expenses) == 1 and expenses[0][1] == "TESCO Ireland" and expenses[0][3] == 18.2

    discounts = list(wb["Discounts"].iter_rows(min_row=2, values_only=True))
    assert [(d[2], d[3], d[4], d[5], d[7]) for d in discounts] == [
        ("Bread", 1.6, 0.4, 1.2, "Reduced"),
        ("Croissants", 2.5, 0, 2.5, "Reduced"),
    ]
    assert discounts[1][6] == 1.0  # 100% off

    outsider = await make_user("outsider")
    r = await client.get(f"/api/v1/conversations/{group}/expenses/export", headers=outsider.headers)
    assert r.status_code == 404


# Tesco Ireland, bought after 9 PM (receipt 8 in developement/receipts, as the AI read it). The two
# colleague discounts are only in the totals: "Colleague Shop Discount" made the six Special Offer
# items free, and "Colleague Discount" is 10% off everything else.
LATE_TESCO_LINES = [  # name, quantity, line total, own discounts printed under it
    ("Eggs", "2", "8.50", []), ("Greek Yoghurt", "1", "4.50", [("item_discount", "Cc €3.75", "-0.75")]),
    ("0% Greek Yoghurt", "1", "4.50", [("item_discount", "Cc €3.75", "-0.75")]), ("Honey", "1", "1.25", []),
    ("Antipasti", "1", "4.99", [("promotion", "Cc Any 3 For 2", "-0.67"), ("promotion", "Special Offer", "-2.99")]),
    ("Milk 3l", "1", "3.25", []), ("Benylin", "1", "4.49", []),
    ("Cheese Snack Bar", "1", "2.80", [("promotion", "Special Offer", "-1.34")]), ("Milk 1l", "1", "1.15", []),
    ("Blueberries", "2", "4.00", []), ("Prawns", "3", "12.00", [("promotion", "Cc Any 3 For €10", "-2.00")]),
    ("Kalamata Antipasti", "2", "9.98", [("promotion", "Cc Any 3 For 2", "-1.28"), ("promotion", "Special Offer", "-6.08")]),
    ("Peppercorn Sauce", "1", "3.50", [("promotion", "Special Offer", "-1.75")]),
    ("Hummus", "5", "10.00", [("promotion", "Cc Any 3 For 2", "-0.86"), ("promotion", "Special Offer", "-5.70")]),
    ("Chicken", "1", "7.15", [("item_discount", "Cc €5.00", "-2.15")]),
    ("Mature Cheddar", "2", "7.00", [("promotion", "Special Offer", "-3.50")]),
    ("Onions", "3", "4.47", []), ("Tomatoes", "2", "2.58", []),
]
LATE_TESCO = {
    "is_receipt": True, "store_name": "Tesco Ireland", "purchased_at": "2026-10-14", "currency": "EUR",
    "prices_include_tax": True,
    "items": [item(name, price, quantity=qty) for name, qty, price, _ in LATE_TESCO_LINES],
    "adjustments": [adjustment(kind, label, amount, [n]) for n, (*_, own) in enumerate(LATE_TESCO_LINES) for kind, label, amount in own]
    + [adjustment("store_discount", "Colleague Discount", "-5.21"), adjustment("store_discount", "Colleague Shop Discount", "-14.10")],
    "subtotal": "96.11", "total": "46.98", "payment_method": "card", "warnings": [],
}
SPECIAL_OFFER = [4, 7, 11, 12, 13, 15]


async def test_bill_wide_discounts_are_matched_to_the_items_they_were_for(client, six, fake_ai):
    people, group = await six()
    p1, p2, p3 = people[:3]
    fake_ai.response = LATE_TESCO
    receipt = await scan(client, p1, group)
    assert receipt["status"] == "ready", receipt["warnings"]
    shop = next(a for a in receipt["adjustments"] if a["label"] == "Colleague Shop Discount")
    colleague = next(a for a in receipt["adjustments"] if a["label"] == "Colleague Discount")
    assert shop["item_indexes"] == SPECIAL_OFFER and shop["amount_minor"] == -1410  # made them free
    assert colleague["item_indexes"] == [n for n in range(18) if n not in SPECIAL_OFFER]
    assert colleague["amount_minor"] == -521 and colleague["percent"] == "10"  # printed amount kept
    assert any("10% of the other 12 items" in w for w in receipt["warnings"])

    # Eggs for p1 alone, the free items for p2, everything else for p3
    assign = {n: [p2.id] if n in SPECIAL_OFFER else [p3.id] for n in range(18)}
    assign[0] = [p1.id]
    body = review_body(receipt, assign)
    body["printed_total"] = "46.98"
    r = await client.put(f"/api/v1/receipts/{receipt['id']}", json=body, headers=p1.headers)
    assert r.status_code == 200, r.text
    totals = {p["user_id"]: p["amount_minor"] for p in r.json()["data"]["totals"]["people"]}
    assert totals[p1.id] == 765  # €8.50 less 10%, not €6.02
    assert totals.get(p2.id, 0) == 0  # the Special Offer items were free
    assert totals[p1.id] + totals[p3.id] == 4698


async def test_a_bill_discount_that_matches_nothing_stays_on_the_whole_bill(client, six, fake_ai):
    people, group = await six()
    fake_ai.response = {**TESCO, "adjustments": TESCO["adjustments"] + [adjustment("coupon", "Voucher", "-0.37")], "total": "17.83"}
    receipt = await scan(client, people[0], group)
    voucher = next(a for a in receipt["adjustments"] if a["label"] == "Voucher")
    assert voucher["item_indexes"] == [] and voucher["percent"] is None


async def test_the_10_percent_falls_on_the_other_items_when_the_ai_assigned_the_free_ones(client, six, fake_ai):
    """What the AI returned for receipt 8 with the uploader's note: the shop discount on the six
    Special Offer items, the 10% left on the whole bill and printed first."""
    people, group = await six()
    colleague = {**adjustment("store_discount", "Colleague Discount", "-5.21"), "percent": "10"}
    shop = adjustment("store_discount", "Colleague Shop Discount", "-14.10", SPECIAL_OFFER)
    fake_ai.response = {**LATE_TESCO, "adjustments": LATE_TESCO["adjustments"][:-2] + [colleague, shop]}
    receipt = await scan(client, people[0], group)
    assert receipt["status"] == "ready", receipt["warnings"]
    found = next(a for a in receipt["adjustments"] if a["label"] == "Colleague Discount")
    assert found["item_indexes"] == [n for n in range(18) if n not in SPECIAL_OFFER]
    nets = {i["name"]: i["net_minor"] for i in receipt["items"]}
    assert nets["Eggs"] == 765
    assert all(nets[LATE_TESCO_LINES[n][0]] == 0 for n in SPECIAL_OFFER)
    assert all(v >= 0 for v in nets.values()) and receipt["totals"]["difference_minor"] == 0


# ------------------------------------------------------------------ cheap path: OCR text -> small model

class OcrFakeExtractor(FakeExtractor):
    """Also reads OCR text, like ClaudeExtractor.extract_text."""

    def __init__(self):
        super().__init__()
        self.text_response = TESCO
        self.text_calls = []

    async def extract_text(self, pages, note, model, api_key):
        self.text_calls.append({"pages": pages, "model": model})
        return ExtractionResult(ReceiptExtraction.model_validate(self.text_response), model, {"input_tokens": 900, "output_tokens": 300})


@pytest.fixture
def ocr_ai(monkeypatch):
    from app.services.receipt_ai import ocr
    fake = OcrFakeExtractor()
    fake.ocr_confidence = 0.98
    monkeypatch.setitem(pipeline.EXTRACTORS, "anthropic", fake)
    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "sk-ant-server-key")
    monkeypatch.setattr(settings, "RECEIPT_OCR_MODEL", "claude-sonnet-5")
    monkeypatch.setattr(settings, "RECEIPT_OCR_DEBUG_DIR", "")  # a developer's .env may switch it on
    monkeypatch.setattr(ocr, "available", lambda: True)
    monkeypatch.setattr(ocr, "read_photo", lambda data: ocr.OcrPage(
        text="  TESCO\n  Milk  €1.80\n  Cheese  €4.00\n  Rice  €12.00\n  TOTAL  €18.20", confidence=fake.ocr_confidence,
        rows=5, unsure_rows=0, seconds=0.1, turned=0))
    return fake


async def _usage(db, receipt_id):
    from app.models.receipt import Receipt
    return (await db.execute(select(Receipt.usage).where(Receipt.id == uuid.UUID(receipt_id)))).scalar_one()


async def test_ocr_read_that_adds_up_skips_the_photo_model(client, six, ocr_ai, db):
    people, group = await six()
    receipt = await scan(client, people[0], group, note="weekly shop")
    assert ocr_ai.calls == []  # the expensive photo model never ran
    assert [c["model"] for c in ocr_ai.text_calls] == ["claude-sonnet-5"]
    assert "TOTAL  €18.20" in ocr_ai.text_calls[0]["pages"][0]
    assert receipt["status"] == "ready" and receipt["model"] == "claude-sonnet-5"
    usage = await _usage(db, receipt["id"])
    assert usage["path"] == "ocr" and usage["input_tokens"] == 900 and usage["output_tokens"] == 300
    assert usage["ocr"]["confidence"] == 0.98


async def test_ocr_read_that_doesnt_add_up_goes_to_the_photo_model(client, six, ocr_ai, db):
    people, group = await six()
    ocr_ai.text_response = {**TESCO, "total": "19.20"}  # a misread digit somewhere
    receipt = await scan(client, people[0], group)
    assert len(ocr_ai.text_calls) == 1 and ocr_ai.calls[0]["model"] == "claude-opus-5"
    assert receipt["status"] == "ready" and receipt["model"] == "claude-opus-5"
    usage = await _usage(db, receipt["id"])
    assert usage["path"] == "ocr_then_photos"
    assert usage["ocr"]["rejected"]["computed_total"] == "18.20" and usage["ocr"]["rejected"]["printed_total"] == "19.20"
    assert usage["input_tokens"] == 900 + 1500 and usage["output_tokens"] == 300 + 400  # both calls count
    assert [c["model"] for c in usage["calls"]] == ["claude-sonnet-5", "claude-opus-5"]


async def test_unclear_ocr_skips_the_text_model(client, six, ocr_ai, db):
    people, group = await six()
    ocr_ai.ocr_confidence = 0.90
    receipt = await scan(client, people[0], group)
    assert ocr_ai.text_calls == [] and len(ocr_ai.calls) == 1
    assert receipt["model"] == "claude-opus-5"
    assert (await _usage(db, receipt["id"]))["path"] == "ocr_then_photos"


async def test_photo_model_failing_keeps_the_ocr_read(client, six, ocr_ai):
    people, group = await six()
    ocr_ai.text_response = {**TESCO, "total": "19.20"}
    ocr_ai.error = "Claude is busy or the key is out of credit. Try again in a minute"
    receipt = await scan(client, people[0], group)
    assert receipt["status"] == "needs_review" and receipt["model"] == "claude-sonnet-5"
    assert any("add up to" in w for w in receipt["warnings"])


async def test_ocr_path_off_without_a_text_model(client, six, ocr_ai, monkeypatch):
    monkeypatch.setattr(settings, "RECEIPT_OCR_MODEL", "")
    people, group = await six()
    await scan(client, people[0], group)
    assert ocr_ai.text_calls == [] and len(ocr_ai.calls) == 1


def test_adds_up():
    data = ReceiptExtraction.model_validate(TESCO)
    assert pipeline.adds_up(data)  # 21.90 - 1.20 - 2.50 = 18.20; VAT inside prices not added
    unsigned = {**TESCO, "adjustments": [adjustment("item_discount", "Cc", "1.20", [3]), *TESCO["adjustments"][1:]]}
    assert pipeline.adds_up(ReceiptExtraction.model_validate(unsigned))  # faded minus sign
    assert not pipeline.adds_up(ReceiptExtraction.model_validate({**TESCO, "total": "18.21"}))
    assert not pipeline.adds_up(ReceiptExtraction.model_validate({**TESCO, "total": None}))
    unsure = {**TESCO, "items": [*TESCO["items"][:4], item("Croissants", "2.50", confidence=0.4)]}
    assert pipeline.adds_up(ReceiptExtraction.model_validate(unsure))  # only the money decides
    on_top = {**TESCO, "total": "19.30", "adjustments": [*TESCO["adjustments"][:2], adjustment("tax", "Tax", "1.10")]}
    assert pipeline.adds_up(ReceiptExtraction.model_validate(on_top))  # US-style tax added on top


def test_a_summary_line_counted_twice_is_dropped_only_when_that_makes_it_add_up():
    doubled = {**TESCO, "adjustments": [*TESCO["adjustments"], adjustment("promotion", "Promotions", "-3.70")]}
    fixed = pipeline.without_summary_lines(ReceiptExtraction.model_validate(doubled))
    assert pipeline.adds_up(fixed) and [a.label for a in fixed.adjustments] == ["Reduced", "Reduced", "VAT incl."]
    # Label cut off by the OCR ("IS:" for "Promotions:"): it equals the item discounts above it
    cut = {**TESCO, "adjustments": [*TESCO["adjustments"], adjustment("store_discount", "IS: Discount", "-3.70")]}
    assert pipeline.adds_up(pipeline.without_summary_lines(ReceiptExtraction.model_validate(cut)))
    # Cash "Change rounding" after the total isn't part of the bill
    cash = {**TESCO, "adjustments": [*TESCO["adjustments"], adjustment("rounding", "Change rounding", "0.01")]}
    assert pipeline.adds_up(pipeline.without_summary_lines(ReceiptExtraction.model_validate(cash)))
    rounded_total = {**cash, "total": "18.21"}  # rounding that is inside the total stays
    assert len(pipeline.without_summary_lines(ReceiptExtraction.model_validate(rounded_total)).adjustments) == 4
    # A real bill-wide discount stays, even when the receipt doesn't add up
    real = {**TESCO, "total": "17.00", "adjustments": [*TESCO["adjustments"], adjustment("store_discount", "Colleague Discount", "-1.00")]}
    assert len(pipeline.without_summary_lines(ReceiptExtraction.model_validate(real)).adjustments) == 4
    # A summary line whose removal doesn't fix the sum stays too (the review screen shows it)
    wrong = {**doubled, "total": "15.00"}
    assert len(pipeline.without_summary_lines(ReceiptExtraction.model_validate(wrong)).adjustments) == 4


async def test_unsure_names_that_add_up_stay_on_the_cheap_path_for_review(client, six, ocr_ai):
    people, group = await six()
    ocr_ai.text_response = {**TESCO, "items": [*TESCO["items"][:4], item("Unclear item", "2.50", confidence=0.3)]}
    receipt = await scan(client, people[0], group)
    assert ocr_ai.calls == [] and receipt["model"] == "claude-sonnet-5"
    assert receipt["status"] == "needs_review"
    assert any("Not sure about: Unclear item" in w for w in receipt["warnings"])


async def test_debug_folder_gets_the_ocr_text_and_model_outputs(client, six, ocr_ai, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "RECEIPT_OCR_DEBUG_DIR", str(tmp_path / "ocr_debug"))
    people, group = await six()
    ocr_ai.text_response = {**TESCO, "total": "19.20"}
    receipt = await scan(client, people[0], group)
    [folder] = list((tmp_path / "ocr_debug").iterdir())
    assert folder.name.endswith(receipt["id"])
    assert sorted(f.name for f in folder.iterdir()) == [
        "photo1_ocr.txt", "photo_model_claude-opus-5.json", "text_model_claude-sonnet-5.json", "usage.json"]
    assert "TOTAL  €18.20" in (folder / "photo1_ocr.txt").read_text()
