"""The admin console: overview, finding accounts, suspension, sign-out, deletion and the action log."""

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import update

from app.models.user import User
from app.services import sessions
from tests.conftest import PASSWORD


async def _admin(db, make_user):
    admin = await make_user("admin")
    await db.execute(update(User).where(User.id == uuid.UUID(admin.id)).values(is_app_admin=True))
    await db.commit()
    return admin


async def test_only_admins(client, make_user):
    someone = await make_user()
    for path in ("/api/v1/admin/overview", "/api/v1/admin/users", "/api/v1/admin/actions"):
        assert (await client.get(path, headers=someone.headers)).status_code == 403
    r = await client.post(f"/api/v1/admin/users/{someone.id}/suspend", json={"reason": "test"}, headers=someone.headers)
    assert r.status_code == 403


async def test_overview_counts(client, db, make_user, make_dm, add_message):
    admin = await _admin(db, make_user)
    other = await make_user()
    dm = await make_dm(admin, other)
    await add_message(dm, other)
    data = (await client.get("/api/v1/admin/overview?days=7", headers=admin.headers)).json()["data"]
    assert data["totals"]["users"] >= 2
    assert data["totals"]["active_today"] >= 1  # other sent a message
    assert len(data["series"]["signups"]) == 7
    assert data["series"]["messages"][-1]["count"] >= 1
    assert data["series"]["signups"][-1]["count"] >= 2


async def test_find_accounts(client, db, make_user):
    admin = await _admin(db, make_user)
    target = await make_user("findme")
    r = (await client.get(f"/api/v1/admin/users?q=@{target.username}", headers=admin.headers)).json()["data"]
    assert [u["id"] for u in r["users"]] == [target.id]
    details = (await client.get(f"/api/v1/admin/users/{target.id}", headers=admin.headers)).json()["data"]
    assert details["username"] == target.username and details["counts"]["signed_in_sessions"] == 2  # verify-email and log in
    # Viewing is logged, but hidden from the log unless asked for
    log = (await client.get("/api/v1/admin/actions", headers=admin.headers)).json()["data"]
    assert not any(a["action"] == "view_user" and a["target"]["id"] == target.id for a in log)
    log = (await client.get("/api/v1/admin/actions?include_views=true", headers=admin.headers)).json()["data"]
    assert any(a["action"] == "view_user" and a["target"]["id"] == target.id and a["by"] == admin.username for a in log)


async def test_suspend_and_lift(client, db, make_user, events):
    admin = await _admin(db, make_user)
    target = await make_user()
    r = await client.post(f"/api/v1/admin/users/{target.id}/suspend", json={"reason": "Spam in groups", "days": 7}, headers=admin.headers)
    assert r.status_code == 200, r.text
    assert ([target.id], {"type": "account_suspended"}) in events

    # Signed out (the apps sign out on 401 without wiping), can't refresh or sign in, and told why
    r = await client.get("/api/v1/auth/me", headers=target.headers)
    assert r.status_code == 401 and r.json()["message"] == "This account is suspended"
    r = await client.post("/api/v1/auth/refresh", json={"refresh_token": target.refresh_token})
    assert r.status_code == 401
    r = await client.post("/api/v1/auth/login", json={"identifier": target.username, "password": PASSWORD})
    assert r.status_code == 403 and r.json()["code"] == "account_suspended"
    assert "Spam in groups" in r.json()["message"] and "until" in r.json()["message"]
    # A wrong password still just says wrong password (suspension isn't revealed to strangers)
    r = await client.post("/api/v1/auth/login", json={"identifier": target.username, "password": "Wrong-pass1!"})
    assert r.status_code == 401

    listed = (await client.get("/api/v1/admin/users?show=suspended", headers=admin.headers)).json()["data"]["users"]
    assert target.id in [u["id"] for u in listed]

    assert (await client.post(f"/api/v1/admin/users/{target.id}/unsuspend", json={"reason": "Appeal accepted"}, headers=admin.headers)).status_code == 200
    # Their old sign-in still works: nothing was wiped
    assert (await client.get("/api/v1/auth/me", headers=target.headers)).status_code == 200

    log = [a["action"] for a in (await client.get("/api/v1/admin/actions", headers=admin.headers)).json()["data"]]
    assert log[:2] == ["unsuspend", "suspend"]


async def test_suspension_runs_out(client, db, make_user):
    admin = await _admin(db, make_user)
    target = await make_user()
    await client.post(f"/api/v1/admin/users/{target.id}/suspend", json={"reason": "Cool down", "days": 1}, headers=admin.headers)
    assert (await client.get("/api/v1/auth/me", headers=target.headers)).status_code == 401
    await db.execute(update(User).where(User.id == uuid.UUID(target.id))
                     .values(suspended_until=datetime.now(timezone.utc) - timedelta(minutes=1)))
    await db.commit()
    assert (await client.get("/api/v1/auth/me", headers=target.headers)).status_code == 200


async def test_cant_act_on_yourself_or_other_admins(client, db, make_user):
    admin = await _admin(db, make_user)
    other_admin = await _admin(db, make_user)
    r = await client.post(f"/api/v1/admin/users/{admin.id}/suspend", json={"reason": "oops"}, headers=admin.headers)
    assert r.status_code == 400
    r = await client.post(f"/api/v1/admin/users/{other_admin.id}/suspend", json={"reason": "takeover"}, headers=admin.headers)
    assert r.status_code == 400
    assert (await client.post(f"/api/v1/admin/users/{uuid.uuid4()}/suspend", json={"reason": "x" * 5}, headers=admin.headers)).status_code == 404
    r = await client.post(f"/api/v1/admin/users/{other_admin.id}/suspend", json={"reason": ""}, headers=admin.headers)
    assert r.status_code == 422  # a reason is required


async def test_sign_out_everywhere(client, db, make_user):
    admin = await _admin(db, make_user)
    target = await make_user()
    r = await client.post(f"/api/v1/admin/users/{target.id}/sign-out", json={"reason": "Account hijacked"}, headers=admin.headers)
    assert r.status_code == 200 and r.json()["data"]["sessions"] == 2
    r = await client.get("/api/v1/auth/me", headers=target.headers)
    assert r.status_code == 401 and r.json()["message"] == sessions.LOGGED_OUT
    # They can sign in again (it isn't a suspension)
    assert (await client.post("/api/v1/auth/login", json={"identifier": target.username, "password": PASSWORD})).status_code == 200


async def test_delete_account(client, db, make_user, events):
    admin = await _admin(db, make_user)
    target = await make_user()
    r = await client.post(f"/api/v1/admin/users/{target.id}/delete", json={"reason": "Scam ring", "confirm_username": "nope"}, headers=admin.headers)
    assert r.status_code == 400
    r = await client.post(f"/api/v1/admin/users/{target.id}/delete", json={"reason": "Scam ring", "confirm_username": target.username}, headers=admin.headers)
    assert r.status_code == 200, r.text
    assert ([target.id], {"type": "account_deleted"}) in events
    assert (await client.get("/api/v1/auth/me", headers=target.headers)).status_code == 401
    log = (await client.get("/api/v1/admin/actions", headers=admin.headers)).json()["data"]
    assert log[0]["action"] == "delete_account" and log[0]["details"]["username"] == target.username


async def test_search_wildcards_match_only_themselves(client, db, make_user):
    admin = await _admin(db, make_user)
    for q in ("%", "_"):
        r = (await client.get(f"/api/v1/admin/users?q={q.replace('%', '%25')}", headers=admin.headers)).json()["data"]
        assert all(q in (u["username"] + (u.get("name") or "") + u.get("email", "")) for u in r["users"]), q
