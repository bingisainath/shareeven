"""Push notifications: device registration, Firebase HTTP v1 requests (faked), token cleanup."""

import json
import uuid

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import select

from app.config.settings import settings
from app.models.device import DeviceToken
from app.services import push


@pytest.fixture
def firebase(tmp_path, monkeypatch):
    """A throwaway service account and a fake Google/Firebase that records what it receives."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    account = {"project_id": "papyris-test", "client_email": "push@papyris-test.iam.gserviceaccount.com",
               "private_key": pem, "token_uri": "https://oauth2.googleapis.com/token"}
    path = tmp_path / "firebase.json"
    path.write_text(json.dumps(account))
    monkeypatch.setattr(settings, "FIREBASE_SERVICE_ACCOUNT_FILE", str(path))
    monkeypatch.setattr(push, "_account", None)
    monkeypatch.setattr(push, "_access_token", None)

    calls = {"token": 0, "sent": []}

    def handler(request: httpx.Request):
        if request.url.host == "oauth2.googleapis.com":
            assertion = dict(x.split("=", 1) for x in request.content.decode().split("&"))["assertion"]
            claims = jwt.decode(assertion, key.public_key(), algorithms=["RS256"], audience=account["token_uri"])
            assert claims["scope"] == push.SCOPE and claims["iss"] == account["client_email"]
            calls["token"] += 1
            return httpx.Response(200, json={"access_token": "ya29.fake", "expires_in": 3600})
        assert request.url.path == "/v1/projects/papyris-test/messages:send"
        assert request.headers["authorization"] == "Bearer ya29.fake"
        message = json.loads(request.content)["message"]
        calls["sent"].append(message)
        if message["token"].startswith("gone"):
            return httpx.Response(404, json={"error": {"status": "NOT_FOUND", "details": [{"errorCode": "UNREGISTERED"}]}})
        if message["token"].startswith("oldproject"):  # a token from another Firebase project
            return httpx.Response(403, json={"error": {"status": "PERMISSION_DENIED", "details": [{"errorCode": "SENDER_ID_MISMATCH"}]}})
        return httpx.Response(200, json={"name": "projects/papyris-test/messages/1"})

    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient

    def patched(*args, **kwargs):
        kwargs["transport"] = transport  # never reach the real Google servers in tests
        return original(*args, **kwargs)

    monkeypatch.setattr(push.httpx, "AsyncClient", patched)
    return calls


async def test_register_move_and_remove_device(client, make_user, db):
    a, b = await make_user(), await make_user()
    token = "fcm-token-" + "x" * 40
    r = await client.post("/api/v1/devices", json={"token": token, "platform": "android"}, headers=a.headers)
    assert r.status_code == 200
    # Same phone, someone else signs in: the token now belongs to them
    await client.post("/api/v1/devices", json={"token": token, "platform": "android"}, headers=b.headers)
    rows = (await db.execute(select(DeviceToken).where(DeviceToken.token == token))).scalars().all()
    assert len(rows) == 1 and str(rows[0].user_id) == b.id
    # a can't remove b's phone; b can
    await client.post("/api/v1/devices/remove", json={"token": token}, headers=a.headers)
    assert (await db.execute(select(DeviceToken).where(DeviceToken.token == token))).scalar_one_or_none()
    await client.post("/api/v1/devices/remove", json={"token": token}, headers=b.headers)
    db.expire_all()
    assert (await db.execute(select(DeviceToken).where(DeviceToken.token == token))).scalar_one_or_none() is None


async def test_disabled_without_service_account(db, monkeypatch):
    monkeypatch.setattr(settings, "FIREBASE_SERVICE_ACCOUNT_FILE", "")
    monkeypatch.setattr(push, "_account", None)
    assert not push.enabled()
    assert await push.send_to_users(db, [uuid.uuid4()], "t", "b", {}) == 0


async def test_send_and_forget_uninstalled_phones(firebase, make_user, db):
    user = await make_user()
    db.add_all([
        DeviceToken(user_id=uuid.UUID(user.id), token="good-" + "a" * 30, platform="android"),
        DeviceToken(user_id=uuid.UUID(user.id), token="gone-" + "b" * 30, platform="ios"),
        DeviceToken(user_id=uuid.UUID(user.id), token="oldproject-" + "c" * 30, platform="android"),
    ])
    await db.commit()
    sent = await push.send_to_users(db, [uuid.UUID(user.id)], "Flat 4B", "bob: dinner?", {"conversationId": "c1"})
    assert sent == 1 and firebase["token"] == 1
    android = next(m for m in firebase["sent"] if m["token"].startswith("good"))
    assert android["notification"] == {"title": "Flat 4B", "body": "bob: dinner?"}
    assert android["data"] == {"conversationId": "c1"} and android["android"]["priority"] == "high"
    tokens = (await db.execute(select(DeviceToken.token))).scalars().all()
    assert not any(t.startswith(("gone", "oldproject")) for t in tokens)

    # The Google access token is reused
    await push.send_to_users(db, [uuid.UUID(user.id)], "t", "b", {})
    assert firebase["token"] == 1


async def test_worker_notifies_other_members(firebase, make_user, make_group, db):
    from datetime import datetime, timezone
    from app.worker import MessageWorker
    from tests.test_worker import FakeStreams

    alice, bob = await make_user("alice"), await make_user("bob")
    group = await make_group(alice, [bob], "Flat 4B")
    db.add(DeviceToken(user_id=uuid.UUID(bob.id), token="bobs-phone-" + "c" * 30, platform="android"))
    db.add(DeviceToken(user_id=uuid.UUID(alice.id), token="alices-phone-" + "d" * 30, platform="android"))
    await db.commit()

    worker = MessageWorker.__new__(MessageWorker)
    worker.streams = FakeStreams()
    await worker.process_message("1-0", {"data": json.dumps({
        "messageId": str(uuid.uuid4()), "conversationId": group, "senderId": alice.id, "senderName": alice.username,
        "text": "Dinner at 8?", "timestamp": datetime.now(timezone.utc).isoformat(),
    })})
    assert [m["token"][:10] for m in firebase["sent"]] == ["bobs-phone"]  # not the sender
    # A message that isn't encrypted (an old app's) never puts its text in a notification
    assert firebase["sent"][0]["notification"] == {"title": "Flat 4B", "body": f"{alice.username}: New message"}
    assert "Dinner" not in json.dumps(firebase["sent"])
    assert firebase["sent"][0]["data"]["conversationId"] == group


async def test_phones_that_show_notifications_themselves_get_data_only(firebase, client, make_user, make_group, db):
    from datetime import datetime, timezone
    from app.worker import MessageWorker
    from tests.test_worker import FakeStreams

    alice, bob = await make_user("alice"), await make_user("bob")
    group = await make_group(alice, [bob], "Flat 4B")
    new_phone, old_phone = "bobs-new-phone-" + "e" * 30, "bobs-old-phone-" + "f" * 30
    await client.post("/api/v1/devices", json={"token": new_phone, "platform": "android", "renders_messages": True}, headers=bob.headers)
    await client.post("/api/v1/devices", json={"token": old_phone, "platform": "android"}, headers=bob.headers)

    worker = MessageWorker.__new__(MessageWorker)
    worker.streams = FakeStreams()
    message_id = str(uuid.uuid4())
    await worker.process_message("1-0", {"data": json.dumps({
        "messageId": message_id, "conversationId": group, "senderId": alice.id, "senderName": alice.username,
        "text": "e2e2:", "timestamp": datetime.now(timezone.utc).isoformat(),
    })})
    sent = {m["token"]: m for m in firebase["sent"]}
    # The new app decrypts and shows it itself: no notification part, the fallback text rides in data
    new = sent[new_phone]
    assert "notification" not in new and new["android"] == {"priority": "high"}
    assert new["data"] | {} == {
        "type": "message", "conversationId": group, "messageId": message_id, "sender": alice.username, "chat": "Flat 4B",
        "encrypted": "1", "hideText": "", "title": "Flat 4B", "body": f"{alice.username}: New message",
    }
    # An older app still gets a notification Android shows by itself
    assert sent[old_phone]["notification"] == {"title": "Flat 4B", "body": f"{alice.username}: New message"}
