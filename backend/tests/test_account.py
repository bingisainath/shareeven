"""Download my data and delete my account."""

import uuid

from sqlalchemy import select

from app.models.message import Message, MessageType
from app.models.user import User


async def _add_expense(client, payer, group, amount, members):
    body = {"description": "Dinner", "currency": "EUR", "amount": amount, "split_mode": "equal",
            "splits": [{"user_id": m.id} for m in members]}
    r = await client.post(f"/api/v1/conversations/{group}/expenses", json=body, headers=payer.headers)
    assert r.status_code == 200, r.text


async def _balances(client, user, group):
    r = await client.get(f"/api/v1/conversations/{group}/balances", headers=user.headers)
    assert r.status_code == 200, r.text
    return r.json()["data"]["currencies"][0]


async def test_export_holds_profile_messages_and_expenses(client, make_user, make_group, add_message):
    a, b = await make_user("exp"), await make_user()
    group = await make_group(a, [b], "Flat")
    await add_message(group, a, "hello flat")
    await add_message(group, a, "e2e2:")  # an end-to-end encrypted message: no text on the server
    await _add_expense(client, a, group, "12.00", [a, b])

    r = await client.get("/api/v1/auth/me/export", headers=a.headers)
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    data = r.json()
    assert data["account"]["email"] == a.email
    texts = [m["text"] for m in data["messages_sent"]]
    assert "hello flat" in texts and None in texts
    assert any(m["end_to_end_encrypted"] for m in data["messages_sent"])
    assert data["expenses"][0]["total_minor"] == 1200
    assert data["chats"][0]["title"] == "Flat"


async def test_delete_needs_the_password_and_the_word(client, make_user):
    a = await make_user()
    r = await client.post("/api/v1/auth/me/delete", json={"password": "Passw0rd!23", "confirm": "yes"}, headers=a.headers)
    assert r.status_code == 400
    r = await client.post("/api/v1/auth/me/delete", json={"password": "nope", "confirm": "DELETE"}, headers=a.headers)
    assert r.status_code == 401


async def test_delete_keeps_everyone_elses_balances(client, db, make_user, make_group, make_dm, add_message, events):
    a, b, c = await make_user("gone"), await make_user(), await make_user()
    group = await make_group(a, [b, c], "Trip")
    dm = await make_dm(a, b)
    await _add_expense(client, a, group, "30.00", [a, b, c])  # b and c each owe a 10
    before = await _balances(client, b, group)
    await add_message(group, a, "see you there")
    email = a.email

    r = await client.post("/api/v1/auth/me/delete", json={"password": "Passw0rd!23", "confirm": "delete"}, headers=a.headers)
    assert r.status_code == 200, r.text

    # Shared money is untouched
    after = await _balances(client, b, group)
    assert after["debts"] == before["debts"]

    # Nothing personal is left
    db.expire_all()
    gone = await db.get(User, uuid.UUID(a.id))
    assert gone.name == "Deleted user" and gone.username.startswith("deleted_")
    assert gone.email != email and not gone.is_active and gone.deleted_at is not None
    said = (await db.execute(select(Message).where(
        Message.sender_id == gone.id, Message.message_type != MessageType.SYSTEM))).scalars().all()
    assert said and all(m.text == "" and m.is_deleted for m in said)

    # They left the group (b took over as admin) but the direct chat stays for b
    info = (await client.get(f"/api/v1/conversations/{group}", headers=b.headers)).json()["data"]
    assert a.id not in [m["id"] for m in info["members"]]
    assert any(m["role"] == "admin" for m in info["members"])
    chats = {c["id"]: c for c in (await client.get("/api/v1/conversations", headers=b.headers)).json()["data"]}
    assert chats[dm]["name"] == "Deleted user"

    # Their devices are told, their sign-ins stop working, and the email can sign up again
    assert any(p["type"] == "account_deleted" for _, p in events)
    assert any("deleted their account" in (p.get("text") or "") for _, p in events)
    assert (await client.get("/api/v1/auth/me", headers=a.headers)).status_code == 401
    r = await client.post("/api/v1/auth/register", json={"username": "comeback", "email": email, "password": "Passw0rd!23"})
    assert r.status_code == 201, r.text


async def test_delete_removes_the_profile_photo_file(client, make_user, upload_dir):
    a = await make_user()
    from PIL import Image
    import io
    img = io.BytesIO()
    Image.new("RGB", (40, 40), (10, 120, 60)).save(img, "JPEG")
    up = await client.post("/api/v1/media/upload", files={"file": ("me.jpg", img.getvalue(), "image/jpeg")}, headers=a.headers)
    url = up.json()["data"]["url"]
    assert (await client.patch("/api/v1/auth/me", json={"avatar": url}, headers=a.headers)).status_code == 200
    files_before = [p for p in upload_dir.rglob("*") if p.is_file()]
    assert files_before

    r = await client.post("/api/v1/auth/me/delete", json={"password": "Passw0rd!23", "confirm": "DELETE"}, headers=a.headers)
    assert r.status_code == 200
    assert not [p for p in upload_dir.rglob("*") if p.is_file()]


async def test_removing_or_replacing_the_profile_photo_deletes_the_old_file(client, make_user, upload_dir):
    a = await make_user()
    from PIL import Image
    import io

    async def upload(colour):
        img = io.BytesIO()
        Image.new("RGB", (40, 40), colour).save(img, "JPEG")
        up = await client.post("/api/v1/media/upload", files={"file": ("me.jpg", img.getvalue(), "image/jpeg")}, headers=a.headers)
        return up.json()["data"]["url"]

    files = lambda: {p.name for p in upload_dir.rglob("*") if p.is_file()}  # noqa: E731
    first = await upload((10, 120, 60))
    assert (await client.patch("/api/v1/auth/me", json={"avatar": first}, headers=a.headers)).status_code == 200
    with_first = files()
    second = await upload((200, 30, 30))
    assert (await client.patch("/api/v1/auth/me", json={"avatar": second}, headers=a.headers)).status_code == 200
    after_replace = files()
    assert len(after_replace) == len(with_first) and after_replace != with_first  # the first photo's file is gone
    # saving the profile without touching the photo keeps it
    assert (await client.patch("/api/v1/auth/me", json={"bio": "hi"}, headers=a.headers)).status_code == 200
    assert files() == after_replace
    assert (await client.patch("/api/v1/auth/me", json={"avatar": ""}, headers=a.headers)).status_code == 200
    assert not files()
