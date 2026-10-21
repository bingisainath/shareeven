"""End-to-end encryption v2 server: device registry, prekeys, signed device lists, linking, mailboxes."""

import base64
import json
import uuid
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from app.services import e2e_v2 as checks

API = "/api/v1/e2e/v2"
RAW = (serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


class Device:
    """A device's keys, made the same way the apps make them (web/src/crypto/v2)."""

    def __init__(self):
        self.sign = Ed25519PrivateKey.generate()
        self.dh = X25519PrivateKey.generate()
        self.sign_pub = self.sign.public_key().public_bytes(*RAW)
        self.dh_pub = self.dh.public_key().public_bytes(*RAW)
        self.id = None

    def registration(self, name="Test device"):
        return {"sign": b64(self.sign_pub), "dh": b64(self.dh_pub), "dhSig": b64(self.sign.sign(self.dh_pub)), "name": name}

    def signed_prekey(self, key_id=1):
        pub = X25519PrivateKey.generate().public_key().public_bytes(*RAW)
        return {"id": key_id, "pub": b64(pub), "sig": b64(self.sign.sign(pub))}


def device_list(aik: Ed25519PrivateKey, user: str, version: int, devices: list[Device]) -> dict:
    entries = []
    for d in devices:
        created = 1760000000000
        cert = aik.sign(checks.cert_bytes(user, d.id, d.sign_pub, d.dh_pub, created))
        entries.append({"id": d.id, "sign": b64(d.sign_pub), "dh": b64(d.dh_pub), "dhSig": b64(d.sign.sign(d.dh_pub)),
                        "created": created, "cert": b64(cert)})
    unsigned = {"user": user, "aik": b64(aik.public_key().public_bytes(*RAW)), "version": version, "devices": entries}
    return {**unsigned, "sig": b64(aik.sign(("PapyrisDeviceList.v2" + checks.canonical_json(unsigned)).encode()))}


async def register(client, user, device: Device):
    r = await client.post(f"{API}/devices", json=device.registration(), headers=user.headers)
    assert r.status_code == 200, r.text
    device.id = r.json()["data"]["device_id"]
    return device


def test_server_checks_match_the_apps():
    """A list signed by the TypeScript code verifies here, and the link code matches."""
    fixture = json.loads((Path(__file__).parent / "fixtures" / "e2e_v2_device_list.json").read_text())
    aik, version, devices = checks.check_device_list(fixture["list"], "user-é")
    assert version == 3 and [d["id"] for d in devices] == [1]
    d = fixture["list"]["devices"][0]
    assert checks.link_code(base64.b64decode(fixture["link"]["ek"]), base64.b64decode(d["sign"]), base64.b64decode(d["dh"])) == fixture["link"]["code"]
    tampered = {**fixture["list"], "version": 4}
    try:
        checks.check_device_list(tampered, "user-é")
        raise AssertionError("tampered list accepted")
    except checks.KeyCheckError:
        pass


async def test_devices_and_prekeys(client, make_user, make_dm):
    a, b, outsider = await make_user(), await make_user(), await make_user()
    await make_dm(a, b)
    phone, laptop = await register(client, a, Device()), await register(client, a, Device())
    assert (phone.id, laptop.id) == (1, 2)

    bad = Device().registration()
    bad["dhSig"] = b64(Ed25519PrivateKey.generate().sign(b"x"))
    assert (await client.post(f"{API}/devices", json=bad, headers=a.headers)).status_code == 422

    # Signed prekey must be signed by the device; one-time prekeys counted
    forged = phone.signed_prekey()
    forged["sig"] = b64(laptop.sign.sign(base64.b64decode(forged["pub"])))
    assert (await client.put(f"{API}/devices/{phone.id}/prekeys", json={"signedPreKey": forged}, headers=a.headers)).status_code == 422
    opks = [{"id": i, "pub": b64(X25519PrivateKey.generate().public_key().public_bytes(*RAW))} for i in range(1, 4)]
    r = await client.put(f"{API}/devices/{phone.id}/prekeys", json={"signedPreKey": phone.signed_prekey(), "oneTimePreKeys": opks}, headers=a.headers)
    assert r.status_code == 200 and r.json()["data"]["one_time_left"] == 3

    # Bundles: each hands out a different one-time prekey, then none; strangers get nothing
    seen = set()
    for _ in range(3):
        bundle = (await client.get(f"{API}/users/{a.id}/devices/{phone.id}/bundle", headers=b.headers)).json()["data"]
        assert bundle["identitySign"] == b64(phone.sign_pub) and bundle["signedPreKey"]["id"] == 1
        seen.add(bundle["oneTimePreKey"]["id"])
    assert seen == {1, 2, 3}
    assert (await client.get(f"{API}/users/{a.id}/devices/{phone.id}/bundle", headers=b.headers)).json()["data"]["oneTimePreKey"] is None
    assert (await client.get(f"{API}/users/{a.id}/devices/{phone.id}/bundle", headers=outsider.headers)).status_code == 404
    assert (await client.get(f"{API}/devices/{phone.id}/prekeys", headers=b.headers)).status_code == 404  # not b's device

    # Logging a device out removes it everywhere
    assert (await client.delete(f"{API}/devices/{laptop.id}", headers=a.headers)).status_code == 200
    assert (await client.get(f"{API}/users/{a.id}/devices/{laptop.id}/bundle", headers=b.headers)).status_code == 404
    assert (await register(client, a, Device())).id == 3  # numbers are never reused


async def test_signed_device_lists(client, make_user, make_dm, events):
    a, b, outsider = await make_user(), await make_user(), await make_user()
    await make_dm(a, b)
    aik = Ed25519PrivateKey.generate()
    phone, laptop = await register(client, a, Device()), await register(client, a, Device())

    events.clear()
    r = await client.put(f"{API}/device-list", json={"device_list": device_list(aik, a.id, 1, [phone])}, headers=a.headers)
    assert r.status_code == 200, r.text
    assert any(p["type"] == "e2e_device_list" and b.id in ids for ids, p in events)
    got = (await client.get(f"{API}/users/{a.id}/device-list", headers=b.headers)).json()["data"]
    assert got["version"] == 1 and checks.check_device_list(got, a.id)[1] == 1
    assert (await client.get(f"{API}/users/{a.id}/device-list", headers=outsider.headers)).status_code == 404

    # Newer version with the laptop: fine. Same or older version: refused. Unregistered device: refused.
    assert (await client.put(f"{API}/device-list", json={"device_list": device_list(aik, a.id, 2, [phone, laptop])}, headers=a.headers)).status_code == 200
    assert (await client.put(f"{API}/device-list", json={"device_list": device_list(aik, a.id, 2, [phone])}, headers=a.headers)).status_code == 409
    stranger = Device()
    stranger.id = 9
    assert (await client.put(f"{API}/device-list", json={"device_list": device_list(aik, a.id, 3, [phone, stranger])}, headers=a.headers)).status_code == 422
    # Tampered signature, or someone else's user id
    tampered = device_list(aik, a.id, 3, [phone])
    tampered["version"] = 4
    assert (await client.put(f"{API}/device-list", json={"device_list": tampered}, headers=a.headers)).status_code == 422
    assert (await client.put(f"{API}/device-list", json={"device_list": device_list(aik, b.id, 3, [phone])}, headers=a.headers)).status_code == 422
    # A new account key only with replace (a fresh start)
    new_aik = Ed25519PrivateKey.generate()
    assert (await client.put(f"{API}/device-list", json={"device_list": device_list(new_aik, a.id, 1, [phone])}, headers=a.headers)).status_code == 409
    assert (await client.put(f"{API}/device-list", json={"device_list": device_list(new_aik, a.id, 1, [phone]), "replace": True}, headers=a.headers)).status_code == 200


async def test_link_a_device(client, make_user, events):
    a, other = await make_user(), await make_user()
    primary, new = await register(client, a, Device()), await register(client, a, Device())
    ek = X25519PrivateKey.generate().public_key().public_bytes(*RAW)
    r = await client.post(f"{API}/link-requests", json={"device_id": new.id, "ek": b64(ek)}, headers=a.headers)
    request = r.json()["data"]
    assert r.status_code == 200 and request["code"] == checks.link_code(ek, new.sign_pub, new.dh_pub)
    assert request["sign"] == b64(new.sign_pub)

    found = (await client.get(f"{API}/link-requests", params={"code": request["code"].lower()}, headers=a.headers)).json()["data"]
    assert found["id"] == request["id"] and found["ek"] == b64(ek)
    assert (await client.get(f"{API}/link-requests", params={"code": request["code"]}, headers=other.headers)).status_code == 404

    assert (await client.get(f"{API}/link-requests/{request['id']}", headers=a.headers)).json()["data"]["status"] == "waiting"
    grant = {"v": 2, "requestId": request["id"], "e": b64(b"e" * 32), "c": b64(b"c" * 80)}
    events.clear()
    assert (await client.post(f"{API}/link-requests/{request['id']}/grant", json={"grant": grant}, headers=a.headers)).status_code == 200
    assert any(p["type"] == "e2e_link_granted" for _, p in events)
    assert (await client.post(f"{API}/link-requests/{request['id']}/grant", json={"grant": grant}, headers=a.headers)).status_code == 409
    done = (await client.get(f"{API}/link-requests/{request['id']}", headers=a.headers)).json()["data"]
    assert done["status"] == "approved" and done["grant"] == grant
    assert (await client.get(f"{API}/link-requests/{request['id']}", headers=a.headers)).status_code == 404  # collected once
    assert primary.id == 1


async def test_one_tap_link_requests(client, make_user, events):
    """A new device's request shows up on the account's other devices; they can approve or deny it."""
    a, other = await make_user(), await make_user()
    await register(client, a, Device())
    new, newer = await register(client, a, Device()), await register(client, a, Device())
    ek = lambda: b64(X25519PrivateKey.generate().public_key().public_bytes(*RAW))  # noqa: E731

    events.clear()
    first = (await client.post(f"{API}/link-requests", json={"device_id": new.id, "ek": ek()}, headers=a.headers)).json()["data"]
    again = (await client.post(f"{API}/link-requests", json={"device_id": new.id, "ek": ek()}, headers=a.headers)).json()["data"]
    second = (await client.post(f"{API}/link-requests", json={"device_id": newer.id, "ek": ek()}, headers=a.headers)).json()["data"]
    assert any(p["type"] == "e2e_link_request" and p["requestId"] == first["id"] and ids == [a.id] for ids, p in events)

    pending = (await client.get(f"{API}/link-requests/pending", headers=a.headers)).json()["data"]
    assert [r["id"] for r in pending] == [second["id"], again["id"]]  # newest per device, newest first
    assert (await client.get(f"{API}/link-requests/pending", headers=other.headers)).json()["data"] == []

    # "Not me": the new device hears it, the code stops working, and it can't be granted any more
    events.clear()
    assert (await client.post(f"{API}/link-requests/{again['id']}/deny", headers=other.headers)).status_code == 404
    assert (await client.post(f"{API}/link-requests/{again['id']}/deny", headers=a.headers)).status_code == 200
    assert any(p["type"] == "e2e_link_denied" and p["requestId"] == again["id"] for _, p in events)
    assert (await client.get(f"{API}/link-requests/{again['id']}", headers=a.headers)).json()["data"]["status"] == "denied"
    assert (await client.get(f"{API}/link-requests", params={"code": again["code"]}, headers=a.headers)).status_code == 404
    grant = {"v": 2, "requestId": again["id"], "e": b64(b"e" * 32), "c": b64(b"c" * 80)}
    assert (await client.post(f"{API}/link-requests/{again['id']}/grant", json={"grant": grant}, headers=a.headers)).status_code == 409
    # The older request of the same device isn't offered again either way once the newest is answered
    left = [r["id"] for r in (await client.get(f"{API}/link-requests/pending", headers=a.headers)).json()["data"]]
    assert left == [second["id"]] and first["id"] not in left

    # Approving one ask of a device clears its other asks, so "Is this you?" doesn't come back
    older = (await client.post(f"{API}/link-requests", json={"device_id": newer.id, "ek": ek()}, headers=a.headers)).json()["data"]
    newest = (await client.post(f"{API}/link-requests", json={"device_id": newer.id, "ek": ek()}, headers=a.headers)).json()["data"]
    grant = {"v": 2, "requestId": older["id"], "e": b64(b"e" * 32), "c": b64(b"c" * 80)}
    assert (await client.post(f"{API}/link-requests/{older['id']}/grant", json={"grant": grant}, headers=a.headers)).status_code == 200
    assert (await client.get(f"{API}/link-requests/pending", headers=a.headers)).json()["data"] == []
    assert (await client.get(f"{API}/link-requests/{newest['id']}", headers=a.headers)).status_code == 404
    assert (await client.get(f"{API}/link-requests/{older['id']}", headers=a.headers)).json()["data"]["status"] == "approved"


async def test_mailboxes(client, make_user, make_group, add_message, events):
    a, b, c, outsider = await make_user(), await make_user(), await make_user(), await make_user()
    group = await make_group(a, [b, c])
    a1, b1, b2 = await register(client, a, Device()), await register(client, b, Device()), await register(client, b, Device())
    o1 = await register(client, outsider, Device())

    message_id = await add_message(group, a, "e2e2:")  # packets belong to one of the sender's own messages
    body = {"from_device": a1.id, "message_id": message_id, "packets": [
        {"to_user": b.id, "to_device": b1.id, "packet": {"v": 2, "kind": "pkmsg", "c": "for b1"}},
        {"to_user": b.id, "to_device": b2.id, "packet": {"v": 2, "kind": "pkmsg", "c": "for b2"}},
    ]}
    events.clear()
    r = await client.post(f"{API}/conversations/{group}/envelopes", json=body, headers=a.headers)
    assert r.status_code == 200, r.text
    assert sorted(p["deviceId"] for ids, p in events if p["type"] == "e2e_envelope" and ids == [b.id]) == [1, 2]

    # Only to members' active devices, only from my own device
    to_outsider = {"from_device": a1.id, "packets": [{"to_user": outsider.id, "to_device": o1.id, "packet": {"c": "x"}}]}
    assert (await client.post(f"{API}/conversations/{group}/envelopes", json=to_outsider, headers=a.headers)).status_code == 422
    assert (await client.post(f"{API}/conversations/{group}/envelopes", json={**body, "from_device": 99}, headers=a.headers)).status_code == 404
    assert (await client.post(f"{API}/conversations/{group}/envelopes", json=body, headers=outsider.headers)).status_code == 404
    gone = {"from_device": a1.id, "packets": [{"to_user": c.id, "to_device": 1, "packet": {"c": "x"}}]}  # c has no device
    assert (await client.post(f"{API}/conversations/{group}/envelopes", json=gone, headers=a.headers)).status_code == 409

    # Each device reads only its own queue; acknowledged packets are deleted
    inbox = (await client.get(f"{API}/mailbox/{b1.id}", headers=b.headers)).json()["data"]
    assert [e["packet"]["c"] for e in inbox] == ["for b1"]
    assert inbox[0]["from"] == {"user": a.id, "device": a1.id} and inbox[0]["message_id"] == message_id
    # Device numbers are per account: the outsider's device 1 is their own (empty) queue, not b's
    assert (await client.get(f"{API}/mailbox/{b1.id}", headers=outsider.headers)).json()["data"] == []
    await client.post(f"{API}/mailbox/{b1.id}/ack", json={"ids": [inbox[0]["id"]]}, headers=b.headers)
    assert (await client.get(f"{API}/mailbox/{b1.id}", headers=b.headers)).json()["data"] == []
    assert len((await client.get(f"{API}/mailbox/{b2.id}", headers=b.headers)).json()["data"]) == 1


async def test_link_history_file_is_deleted_once_downloaded(client, make_user):
    a = await make_user()
    primary, new = await register(client, a, Device()), await register(client, a, Device())
    aik = Ed25519PrivateKey.generate()
    r = await client.put(f"{API}/device-list", json={"device_list": device_list(aik, a.id, 1, [primary])}, headers=a.headers)
    assert "server_time" in r.json()["data"]  # devices compare it with message times
    ek = X25519PrivateKey.generate().public_key().public_bytes(*RAW)
    request = (await client.post(f"{API}/link-requests", json={"device_id": new.id, "ek": b64(ek)}, headers=a.headers)).json()["data"]
    uploaded = (await client.post("/api/v1/media/upload", params={"encrypted": "true", "kind": "backup"},
                                  files={"file": ("history.enc", b"\x01" * 4000, "application/octet-stream")}, headers=a.headers)).json()["data"]
    grant = {"v": 2, "requestId": request["id"], "e": b64(b"e" * 32), "c": b64(b"c" * 80)}
    bad = await client.post(f"{API}/link-requests/{request['id']}/grant", json={"grant": grant, "history_url": "/api/v1/media/x.jpg"}, headers=a.headers)
    assert bad.status_code == 422  # only an end-to-end encrypted upload
    assert (await client.post(f"{API}/link-requests/{request['id']}/grant", json={"grant": grant, "history_url": uploaded["signedUrl"]}, headers=a.headers)).status_code == 200
    assert (await client.get(uploaded["signedUrl"])).status_code == 200
    assert (await client.delete(f"{API}/devices/{new.id}/history", headers=a.headers)).status_code == 200
    assert (await client.get(uploaded["signedUrl"])).status_code == 404


async def test_chat_encryption_with_both_versions_and_retiring_v1(client, make_user, make_group, events):
    a, b, c = await make_user(), await make_user(), await make_user()
    group = await make_group(a, [b, c])

    async def keys():
        return (await client.get(f"/api/v1/conversations/{group}/keys", headers=a.headers)).json()["data"]

    async def give_v2(u):
        d = await register(client, u, Device())
        r = await client.put(f"{API}/device-list", json={"device_list": device_list(Ed25519PrivateKey.generate(), u.id, 1, [d])}, headers=u.headers)
        assert r.status_code == 200, r.text

    # Everyone on version 1 only: encrypted with version 1
    for u in (a, b, c):
        await client.put("/api/v1/keys/me", json={"enc_public": b64(b"e" * 32), "sign_public": b64(b"s" * 32)}, headers=u.headers)
    assert (await keys())["missing"] == []
    # a and b move to version 2 and c doesn't: still fine with version 1
    await give_v2(a)
    await give_v2(b)
    data = await keys()
    assert data["missing"] == [] and data["v2_ready"] is False
    # a starts fresh with version 2 only (retires version 1): c now holds things up until they sign in again
    events.clear()
    assert (await client.delete("/api/v1/keys/me", headers=a.headers)).status_code == 200
    assert any(p["type"] == "keys_changed" and p["userId"] == a.id for _, p in events)
    assert (await client.get("/api/v1/keys/me", headers=a.headers)).json()["data"]["has_keys"] is False
    data = await keys()
    assert data["v1_missing"] == [a.id] and data["missing"] == [c.id]
    await give_v2(c)
    data = await keys()
    assert data["missing"] == [] and data["v2_ready"] is True
    assert (await client.delete("/api/v1/keys/me", headers=a.headers)).status_code == 200  # nothing left to retire


async def test_remote_logout_ends_only_that_sign_in(client, make_user, events, db):
    from tests.conftest import PASSWORD
    a = await make_user()

    async def sign_in():
        r = await client.post("/api/v1/auth/login", json={"identifier": a.username, "password": PASSWORD})
        tokens = r.json()["data"]
        return {"Authorization": f"Bearer {tokens['access_token']}"}, tokens["refresh_token"]

    phone_headers, _ = await sign_in()
    laptop_headers, laptop_refresh = await sign_in()
    phone = Device()
    r = await client.post(f"{API}/devices", json=phone.registration(), headers=phone_headers)
    phone.id = r.json()["data"]["device_id"]
    laptop = Device()
    r = await client.post(f"{API}/devices", json=laptop.registration(), headers=laptop_headers)
    laptop.id = r.json()["data"]["device_id"]

    # The phone logs the laptop out (Settings → Sessions)
    events.clear()
    assert (await client.delete(f"{API}/devices/{laptop.id}", headers=phone_headers)).status_code == 200
    assert any(p == {"type": "session_revoked", "deviceId": laptop.id} for _, p in events)
    assert (await client.get("/api/v1/auth/me", headers=laptop_headers)).status_code == 401
    assert (await client.post("/api/v1/auth/refresh", json={"refresh_token": laptop_refresh})).status_code == 401
    assert (await client.get("/api/v1/auth/me", headers=phone_headers)).status_code == 200
    mine = (await client.get(f"{API}/devices/me", headers=phone_headers)).json()["data"]["devices"]
    assert [d["device_id"] for d in mine] == [phone.id]

    # Logging the phone out ends its own sign-in too
    assert (await client.delete(f"{API}/devices/{phone.id}", headers=phone_headers)).status_code == 200
    assert (await client.get("/api/v1/auth/me", headers=phone_headers)).status_code == 401


async def test_never_linked_devices_free_their_slots(client, make_user, db):
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import update
    from app.models.e2e_v2 import E2EDevice
    a = await make_user()
    primary = await register(client, a, Device())
    aik = Ed25519PrivateKey.generate()
    assert (await client.put(f"{API}/device-list", json={"device_list": device_list(aik, a.id, 1, [primary])}, headers=a.headers)).status_code == 200
    waiting = [await register(client, a, Device()) for _ in range(9)]  # signed in, never linked: 10 in all
    assert (await client.post(f"{API}/devices", json=Device().registration(), headers=a.headers)).status_code == 409

    # Nine idle for 20 minutes (longer than a link request): a new device can register; the primary stays
    await db.execute(update(E2EDevice).where(E2EDevice.device_id.in_([d.id for d in waiting])).values(
        last_seen_at=datetime.now(timezone.utc) - timedelta(minutes=20)))
    await db.commit()
    assert (await client.post(f"{API}/devices", json=Device().registration(), headers=a.headers)).status_code == 200
    mine = (await client.get(f"{API}/devices/me", headers=a.headers)).json()["data"]["devices"]
    assert primary.id in [d["device_id"] for d in mine] and len(mine) == 2



async def test_asking_again_replaces_a_devices_link_request(client, make_user):
    """A page that asks twice while loading, or a retry, mustn't use up the account's limit of 5."""
    user = await make_user()
    laptop = await register(client, user, Device())
    for _ in range(8):
        ek = X25519PrivateKey.generate().public_key().public_bytes(*RAW)
        r = await client.post(f"{API}/link-requests", json={"device_id": laptop.id, "ek": b64(ek)}, headers=user.headers)
        assert r.status_code == 200, r.text
    # ...but one device can't pile up requests without end
    for _ in range(2):
        ek = X25519PrivateKey.generate().public_key().public_bytes(*RAW)
        await client.post(f"{API}/link-requests", json={"device_id": laptop.id, "ek": b64(ek)}, headers=user.headers)
    ek = X25519PrivateKey.generate().public_key().public_bytes(*RAW)
    assert (await client.post(f"{API}/link-requests", json={"device_id": laptop.id, "ek": b64(ek)}, headers=user.headers)).status_code == 429

    # Five different devices waiting at once is still the limit
    for _ in range(4):
        other = await register(client, user, Device())
        ek = X25519PrivateKey.generate().public_key().public_bytes(*RAW)
        assert (await client.post(f"{API}/link-requests", json={"device_id": other.id, "ek": b64(ek)}, headers=user.headers)).status_code == 200
    sixth = await register(client, user, Device())
    ek = X25519PrivateKey.generate().public_key().public_bytes(*RAW)
    assert (await client.post(f"{API}/link-requests", json={"device_id": sixth.id, "ek": b64(ek)}, headers=user.headers)).status_code == 429


async def test_devices_say_whether_they_are_open_or_unused(client, db, make_user):
    """The link screen shows which devices can approve right now; Settings offers to remove unused ones."""
    from datetime import datetime, timedelta, timezone
    from jose import jwt
    from sqlalchemy import update
    from app.models.e2e_v2 import E2EDevice
    from app.websocket.routes import _touch_devices

    a = await make_user()
    phone = await register(client, a, Device())
    rows = lambda: client.get(f"{API}/devices/me", headers=a.headers)  # noqa: E731
    view = (await rows()).json()["data"]["devices"][0]
    assert view["active_now"] is True and view["unused"] is False  # just registered

    long_ago = datetime.now(timezone.utc) - timedelta(days=45)
    await db.execute(update(E2EDevice).where(E2EDevice.device_id == phone.id).values(last_seen_at=long_ago))
    await db.commit()
    view = (await rows()).json()["data"]["devices"][0]
    assert view["active_now"] is False and view["unused"] is True

    # Its sign-in connects over the WebSocket again: open now
    sid = jwt.get_unverified_claims(a.access_token)["sid"]
    await _touch_devices(uuid.UUID(a.id), sid)
    view = (await rows()).json()["data"]["devices"][0]
    assert view["active_now"] is True and view["unused"] is False
    await _touch_devices(uuid.UUID(a.id), "not-a-session")  # never raises
