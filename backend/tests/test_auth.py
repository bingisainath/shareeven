import uuid

from sqlalchemy import update

from app.core.security import hash_password
from app.models.user import User


async def test_login_returns_access_and_refresh_tokens(client, make_user):
    user = await make_user()
    assert user.access_token and user.refresh_token
    r = await client.get("/api/v1/auth/me", headers=user.headers)
    assert r.status_code == 200
    assert r.json()["data"]["username"] == user.username


async def test_login_with_email_is_case_insensitive(client, make_user):
    user = await make_user()
    r = await client.post("/api/v1/auth/login", json={"identifier": user.email.upper(), "password": "Passw0rd!23"})
    assert r.status_code == 200


async def test_wrong_password_rejected(client, make_user):
    user = await make_user()
    r = await client.post("/api/v1/auth/login", json={"identifier": user.username, "password": "nope-nope"})
    assert r.status_code == 401


async def test_refresh_rotates_tokens(client, make_user):
    user = await make_user()
    r = await client.post("/api/v1/auth/refresh", json={"refresh_token": user.refresh_token})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["access_token"] and data["refresh_token"]
    me = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {data['access_token']}"})
    assert me.status_code == 200


async def test_access_token_cannot_be_used_to_refresh(client, make_user):
    user = await make_user()
    r = await client.post("/api/v1/auth/refresh", json={"refresh_token": user.access_token})
    assert r.status_code == 401


async def test_refresh_token_cannot_be_used_as_access_token(client, make_user):
    user = await make_user()
    headers = {"Authorization": f"Bearer {user.refresh_token}"}
    assert (await client.get("/api/v1/auth/me", headers=headers)).status_code == 401
    assert (await client.get("/api/v1/conversations", headers=headers)).status_code == 401


async def test_password_change_revokes_refresh_tokens(client, db, make_user):
    user = await make_user()
    await db.execute(update(User).where(User.id == uuid.UUID(user.id)).values(hashed_password=hash_password("Another1!pass")))
    await db.commit()
    r = await client.post("/api/v1/auth/refresh", json={"refresh_token": user.refresh_token})
    assert r.status_code == 401


async def test_update_profile(client, make_user):
    user = await make_user()
    r = await client.patch("/api/v1/auth/me", json={"name": "Display Name", "bio": "Hi"}, headers=user.headers)
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["name"] == "Display Name" and data["bio"] == "Hi"


async def test_update_profile_rejects_taken_username(client, make_user):
    a, b = await make_user(), await make_user()
    r = await client.patch("/api/v1/auth/me", json={"username": b.username.upper()}, headers=a.headers)
    assert r.status_code == 409


async def test_update_profile_rejects_external_avatar(client, make_user):
    user = await make_user()
    r = await client.patch("/api/v1/auth/me", json={"avatar": "https://evil.example/x.png"}, headers=user.headers)
    assert r.status_code == 400


async def test_email_registration_is_case_insensitive(client, make_user):
    user = await make_user()
    r = await client.post("/api/v1/auth/register", json={
        "username": user.username + "x", "email": user.email.upper(), "password": "Passw0rd!23",
    })
    assert r.status_code in (400, 409)


async def test_signup_rejects_usernames_with_special_characters(client):
    for username in ["x'; DROP TABLE users;--", "<script>alert(1)</script>", "two words", "ålice", "bad-name", "ab", "x" * 31, "a%b"]:
        r = await client.post("/api/v1/auth/register", json={
            "username": username, "email": f"{uuid.uuid4().hex[:8]}@example.com", "password": "Passw0rd!23"})
        assert r.status_code == 422, (username, r.text)
        assert "lowercase letters, numbers, dots or underscores" in r.json()["message"]


async def test_usernames_ignore_case(client, make_user):
    user = await make_user("case")
    r = await client.post("/api/v1/auth/login", json={"identifier": user.username.upper(), "password": "Passw0rd!23"})
    assert r.status_code == 200
    # "CASE_…" is the same name as "case_…": it can't be taken a second time
    r = await client.post("/api/v1/auth/register", json={
        "username": user.username.upper(), "email": f"{uuid.uuid4().hex[:8]}@example.com", "password": "Passw0rd!23"})
    assert r.status_code == 409
