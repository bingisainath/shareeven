"""
Envelope-first delivery for encrypted (v2) messages (docs/encryption-design-v2.md §4.7): devices show a
message once they've decrypted their own packet, the server refuses sends that miss a listed device,
and a device that can't decrypt asks the sender's device to encrypt the message again.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy import update

from app.models.message import Message
from app.services import e2e_mailbox, media_storage
from app.websocket import routes as ws_routes
from app.websocket.manager import LEGACY_KEY, WSManager
from tests.test_e2e_v2 import API, Device, device_list, register


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send_json(self, payload):
        self.sent.append(payload)


async def publish_list(client, user, devices):
    r = await client.put(f"{API}/device-list", json={"device_list": device_list(Ed25519PrivateKey.generate(), user.id, 1, devices)},
                         headers=user.headers)
    assert r.status_code == 200, r.text


def packet(user, device):
    return e2e_mailbox.Outgoing(uuid.UUID(user.id), device.id, {"v": 2, "kind": "msg", "c": f"for {device.id}"})


async def test_legacy_events_skip_sockets_on_protocol_3():
    manager = WSManager()
    old, new = FakeSocket(), FakeSocket()
    manager.track_user("u", old)
    manager.track_user("u", new, proto=3)

    await manager.send_user("u", {"type": "message", "text": "e2e2:", LEGACY_KEY: True})
    await manager.send_user("u", {"type": "e2e_envelope"})

    assert old.sent == [{"type": "message", "text": "e2e2:"}, {"type": "e2e_envelope"}]  # the marker key never goes out
    assert new.sent == [{"type": "e2e_envelope"}]
    manager.untrack("u", new)
    assert manager.proto(new) == 0


async def test_new_messages_must_reach_every_listed_device(client, db, make_user, make_dm):
    a, b = await make_user(), await make_user()
    dm = uuid.UUID(await make_dm(a, b))
    a1, a2 = await register(client, a, Device()), await register(client, a, Device())
    b1, b2 = await register(client, b, Device()), await register(client, b, Device())
    await publish_list(client, a, [a1, a2])
    await publish_list(client, b, [b1, b2])
    sender = uuid.UUID(a.id)

    # Forgot b2 (a stale device list): refused with the device to add
    with pytest.raises(e2e_mailbox.DevicesChanged) as missing:
        await e2e_mailbox.queue(db, sender, dm, a1.id, [packet(b, b1), packet(a, a2)], uuid.uuid4(), complete=True)
    assert missing.value.details() == {"code": "devices_changed", "missing": [{"user": b.id, "device": b2.id}], "extra": []}
    await db.rollback()

    # Everyone except the sending device: accepted
    rows = await e2e_mailbox.queue(db, sender, dm, a1.id, [packet(b, b1), packet(b, b2), packet(a, a2)], uuid.uuid4(), complete=True)
    assert len(rows) == 3
    await db.rollback()

    # Without `complete` (older apps, edits, resends) a partial send is still fine
    assert len(await e2e_mailbox.queue(db, sender, dm, a1.id, [packet(b, b1)], uuid.uuid4())) == 1
    await db.rollback()

    # A device that logged out (its owner's list may still name it): its packet is skipped, the rest go
    assert (await client.delete(f"{API}/devices/{b2.id}", headers=b.headers)).status_code == 200
    rows = await e2e_mailbox.queue(db, sender, dm, a1.id, [packet(b, b1), packet(b, b2), packet(a, a2)], uuid.uuid4(), complete=True)
    assert sorted(r.recipient_device_id for r in rows) == sorted([b1.id, a2.id])
    await db.rollback()

    # A device that never existed is still refused
    ghost = Device()
    ghost.id = 9999
    with pytest.raises(e2e_mailbox.DevicesChanged) as extra:
        await e2e_mailbox.queue(db, sender, dm, a1.id, [packet(b, b1), packet(b, ghost), packet(a, a2)], uuid.uuid4(), complete=True)
    assert extra.value.details()["extra"] == [{"user": b.id, "device": 9999}] and extra.value.status == 409
    await db.rollback()


async def test_someone_whose_devices_all_logged_out_holds_up_encryption(client, db, make_user, make_dm):
    """Their signed list still names devices that logged out: the chat says they need to sign in, instead of every send failing."""
    a, b = await make_user(), await make_user()
    dm = await make_dm(a, b)
    a1, b1 = await register(client, a, Device()), await register(client, b, Device())
    await publish_list(client, a, [a1])
    await publish_list(client, b, [b1])
    keys = lambda: client.get(f"/api/v1/conversations/{dm}/keys", headers=a.headers)  # noqa: E731
    assert (await keys()).json()["data"]["v2_ready"] is True

    assert (await client.delete(f"{API}/devices/{b1.id}", headers=b.headers)).status_code == 200
    data = (await keys()).json()["data"]
    assert data["v2_ready"] is False
    assert data["missing"] == [b.id]  # the banner names them; nothing is sent until they sign in again


async def test_publish_order_and_meta(events):
    rows = [
        type("Row", (), {"id": uuid.uuid4(), "recipient_user_id": "b", "recipient_device_id": 1, "sender_user_id": "a",
                         "sender_device_id": 2, "conversation_id": None, "message_id": None, "packet": '{"c": "x"}', "created_at": None})(),
    ]
    meta = {"messageId": "m1", "roomId": "r1", "senderId": "a", "timestamp": "2026-10-17T00:00:00+00:00", "fromDevice": 2, "messageType": "text"}
    await ws_routes.publish_message_v2(["a", "b"], rows, meta, "client-1")

    kinds = [(ids, p["type"]) for ids, p in events]
    assert kinds == [(["a", "b"], "message"), (["b"], "e2e_envelope"), (["a"], "message_sent")]
    legacy, envelope, sent = (p for _, p in events)
    assert legacy[LEGACY_KEY] is True and legacy["text"] == media_storage.V2_MARKER and legacy["clientId"] == "client-1"
    assert envelope["meta"] == meta and envelope["deviceId"] == 1
    assert sent == {"type": "message_sent", "roomId": "r1", "clientId": "client-1", "messageId": "m1",
                    "timestamp": meta["timestamp"], "fromDevice": 2, "status": "sent"}


async def test_follow_ups_only_for_own_messages(client, make_user, make_dm, add_message):
    a, b = await make_user(), await make_user()
    dm = await make_dm(a, b)
    a1, b1 = await register(client, a, Device()), await register(client, b, Device())
    mine = await add_message(dm, a, media_storage.V2_MARKER)
    theirs = await add_message(dm, b, media_storage.V2_MARKER)
    body = lambda message_id: {"from_device": a1.id, "message_id": message_id,
                               "packets": [{"to_user": b.id, "to_device": b1.id, "packet": {"c": "x"}}]}

    assert (await client.post(f"{API}/conversations/{dm}/envelopes", json=body(mine), headers=a.headers)).status_code == 200
    # Someone else's message, or one that doesn't exist: a packet can't be attached to it
    assert (await client.post(f"{API}/conversations/{dm}/envelopes", json=body(theirs), headers=a.headers)).status_code == 404
    assert (await client.post(f"{API}/conversations/{dm}/envelopes", json=body(str(uuid.uuid4())), headers=a.headers)).status_code == 404


async def test_retry_requests(client, db, make_user, make_dm, add_message, events):
    a, b, outsider = await make_user(), await make_user(), await make_user()
    dm = await make_dm(a, b)
    a1, a2, b1 = await register(client, a, Device()), await register(client, a, Device()), await register(client, b, Device())
    o1 = await register(client, outsider, Device())
    message = await add_message(dm, a, media_storage.V2_MARKER)
    plain = await add_message(dm, a, "not encrypted")
    ask = lambda user, device, message_id=message, sender_device=a1.id: client.post(
        f"{API}/retry-requests", json={"device_id": device.id, "message_id": message_id, "sender_device": sender_device}, headers=user.headers)

    events.clear()
    r = await ask(b, b1)
    assert r.status_code == 200, r.text
    request = r.json()["data"]
    assert request["requester"] == {"user": b.id, "device": b1.id} and request["sender_device"] == a1.id and request["attempts"] == 1
    assert events == [([a.id], {"type": "e2e_retry_request", "request": request})]

    # Only for v2 messages, only by members, only to a device of the message's sender, not to itself
    assert (await ask(b, b1, message_id=plain)).status_code == 404
    assert (await ask(outsider, o1)).status_code == 404
    assert (await ask(b, b1, sender_device=99)).status_code == 404
    assert (await ask(a, a1)).status_code == 422
    assert (await ask(a, a2)).status_code == 200  # my other device missed my own message

    # The sending device sees what's waiting for it (not its other device), and marks it done
    pending = (await client.get(f"{API}/retry-requests/{a1.id}", headers=a.headers)).json()["data"]
    assert sorted(p["requester"]["device"] for p in pending) == sorted([b1.id, a2.id])
    assert (await client.get(f"{API}/retry-requests/{a2.id}", headers=a.headers)).json()["data"] == []
    assert (await client.get(f"{API}/retry-requests/99", headers=a.headers)).status_code == 404  # not one of a's devices
    await client.post(f"{API}/retry-requests/{request['id']}/done", headers=b.headers)  # not the sender: ignored
    assert len((await client.get(f"{API}/retry-requests/{a1.id}", headers=a.headers)).json()["data"]) == 2
    await client.post(f"{API}/retry-requests/{request['id']}/done", headers=a.headers)
    assert [p["requester"]["device"] for p in (await client.get(f"{API}/retry-requests/{a1.id}", headers=a.headers)).json()["data"]] == [a2.id]

    # Handled requests still count: at most three tries per message and device, so a broken one can't loop
    assert (await ask(b, b1)).json()["data"]["attempts"] == 2
    assert (await ask(b, b1)).json()["data"]["attempts"] == 3
    assert (await ask(b, b1)).status_code == 429

    # Old messages aren't sent again
    old = await add_message(dm, a, media_storage.V2_MARKER)
    await db.execute(update(Message).where(Message.id == uuid.UUID(old)).values(created_at=datetime.now(timezone.utc) - timedelta(days=31)))
    await db.commit()
    assert (await ask(b, b1, message_id=old)).status_code == 410


async def test_sender_gets_the_photos_address_with_message_sent(events):
    """The sender's bubble swaps its upload preview for the server address (it stays readable after the preview is released)."""
    row = type("Row", (), {"id": uuid.uuid4(), "recipient_user_id": "b", "recipient_device_id": 1, "sender_user_id": "a",
                           "sender_device_id": 2, "conversation_id": None, "message_id": None, "packet": '{"c": "x"}', "created_at": None})()
    meta = {"messageId": "m1", "roomId": "r1", "senderId": "a", "timestamp": "2026-10-22T00:00:00+00:00", "fromDevice": 2,
            "messageType": "image", "mediaUrl": "/api/v1/media/x.enc?exp=1&sig=s", "mediaThumbnail": None}
    await ws_routes.publish_message_v2(["a", "b"], [row], meta, "client-1")
    sent = next(p for _, p in events if p["type"] == "message_sent")
    assert sent["mediaUrl"] == "/api/v1/media/x.enc?exp=1&sig=s" and sent["mediaThumbnail"] is None
