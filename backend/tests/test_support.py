"""Support requests: people ask for help, app admins read them and reply (as a notice)."""

import uuid

from sqlalchemy import select, update

from app.api.v1 import support
from app.models.support import SupportTicket
from app.models.user import User
from tests.conftest import PASSWORD

TICKET = {"category": "bug", "subject": "Tabs don't swipe", "message": "Swiping left on Chats does nothing.", "app_info": "Android 0.9.11"}


async def _admin(db, make_user):
    admin = await make_user("admin")
    await db.execute(update(User).where(User.id == uuid.UUID(admin.id)).values(is_app_admin=True))
    await db.commit()
    return admin


async def test_send_and_see_my_requests(client, make_user):
    me, other = await make_user(), await make_user()
    r = await client.post("/api/v1/support", json=TICKET, headers=me.headers)
    assert r.status_code == 200
    assert r.json()["data"]["status"] == "open"
    mine = (await client.get("/api/v1/support", headers=me.headers)).json()["data"]
    assert [t["subject"] for t in mine] == ["Tabs don't swipe"]
    assert "app_info" not in mine[0]  # only the team needs it
    assert (await client.get("/api/v1/support", headers=other.headers)).json()["data"] == []  # nobody else's


async def test_request_needs_real_content(client, make_user):
    me = await make_user()
    for bad in ({**TICKET, "category": "nope"}, {**TICKET, "subject": "  "}, {**TICKET, "message": "help"},
                {**TICKET, "subject": "   hi    ", "message": "          a          "}):
        assert (await client.post("/api/v1/support", json=bad, headers=me.headers)).status_code in (400, 422)


async def test_too_many_waiting(client, make_user):
    me = await make_user()
    for _ in range(support.OPEN_PER_USER):
        assert (await client.post("/api/v1/support", json=TICKET, headers=me.headers)).status_code == 200
    assert (await client.post("/api/v1/support", json=TICKET, headers=me.headers)).status_code == 429


async def test_only_admins_see_and_answer(client, db, make_user):
    me = await make_user()
    ticket = (await client.post("/api/v1/support", json=TICKET, headers=me.headers)).json()["data"]["id"]
    assert (await client.get("/api/v1/admin/support", headers=me.headers)).status_code == 403
    r = await client.post(f"/api/v1/admin/support/{ticket}/reply", json={"reply": "x"}, headers=me.headers)
    assert r.status_code == 403
    assert (await client.post(f"/api/v1/admin/support/{ticket}/close", headers=me.headers)).status_code == 403


async def test_admin_replies_and_person_is_told(client, db, make_user, events):
    admin, me = await _admin(db, make_user), await make_user()
    ticket = (await client.post("/api/v1/support", json=TICKET, headers=me.headers)).json()["data"]["id"]
    inbox = (await client.get("/api/v1/admin/support", headers=admin.headers)).json()["data"]
    row = next(t for t in inbox if t["id"] == ticket)
    assert row["user"]["id"] == me.id and row["app_info"] == "Android 0.9.11"
    assert "email" not in row["user"]

    r = await client.post(f"/api/v1/admin/support/{ticket}/reply", json={"reply": "Fixed in the next update."}, headers=admin.headers)
    assert r.status_code == 200 and r.json()["data"]["status"] == "closed"
    mine = (await client.get("/api/v1/support", headers=me.headers)).json()["data"]
    assert mine[0]["reply"] == "Fixed in the next update." and mine[0]["status"] == "closed"
    notices = (await client.get("/api/v1/notices", headers=me.headers)).json()["data"]["notices"]
    assert notices[0]["kind"] == "support_reply" and "Fixed in the next update." in notices[0]["body"]
    assert any(p["type"] == "account_notice" for ids, p in events if ids == [me.id])
    assert ticket not in [t["id"] for t in (await client.get("/api/v1/admin/support", headers=admin.headers)).json()["data"]]
    closed = (await client.get("/api/v1/admin/support?status=closed", headers=admin.headers)).json()["data"]
    assert ticket in [t["id"] for t in closed]
    actions = (await client.get("/api/v1/admin/actions", headers=admin.headers)).json()["data"]
    assert any(a["action"] == "support_reply" and a["target"]["id"] == me.id for a in actions)


async def test_reply_without_closing_and_close_later(client, db, make_user):
    admin, me = await _admin(db, make_user), await make_user()
    ticket = (await client.post("/api/v1/support", json=TICKET, headers=me.headers)).json()["data"]["id"]
    r = await client.post(f"/api/v1/admin/support/{ticket}/reply", json={"reply": "Which phone?", "close": False}, headers=admin.headers)
    assert r.json()["data"]["status"] == "open"
    assert (await client.post(f"/api/v1/admin/support/{ticket}/close", headers=admin.headers)).json()["data"]["status"] == "closed"
    assert (await client.post(f"/api/v1/admin/support/{uuid.uuid4()}/close", headers=admin.headers)).status_code == 404


async def test_export_and_delete_cover_requests(client, db, make_user):
    me = await make_user()
    await client.post("/api/v1/support", json=TICKET, headers=me.headers)
    export = (await client.get("/api/v1/auth/me/export", headers=me.headers)).json()
    assert export["support_requests"][0]["subject"] == "Tabs don't swipe"
    # Deleting the account keeps the user row (for shared expenses) but not their requests
    r = await client.post("/api/v1/auth/me/delete", json={"password": PASSWORD, "confirm": "delete"}, headers=me.headers)
    assert r.status_code == 200
    left = (await db.execute(select(SupportTicket).where(SupportTicket.user_id == uuid.UUID(me.id)))).scalars().all()
    assert left == []
