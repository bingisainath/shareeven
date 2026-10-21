# backend/app/api/v1/e2e_v2.py

"""
End-to-end encryption v2 (docs/encryption-design-v2.md): the key directory and mailboxes.

Devices
  POST   /e2e/v2/devices                         register this phone/browser's identity keys -> device id
  GET    /e2e/v2/devices/me                      my registered devices
  DELETE /e2e/v2/devices/{device_id}             log a device out (drops its prekeys and mail)
  PUT    /e2e/v2/devices/{device_id}/prekeys     upload a signed prekey and/or one-time prekeys
  GET    /e2e/v2/devices/{device_id}/prekeys     how many one-time prekeys are left
Device lists (signed by the account key on the primary device)
  PUT    /e2e/v2/device-list                     publish a newer list
  GET    /e2e/v2/users/{user_id}/device-list     someone's list (people you share a chat with)
  GET    /e2e/v2/users/{user_id}/devices/{d}/bundle   prekeys to start a session (uses up one one-time prekey)
Linking (the new device registers first, then asks the primary to certify it)
  POST   /e2e/v2/link-requests  ·  GET /e2e/v2/link-requests?code=  ·  GET/POST /e2e/v2/link-requests/{id}[/grant]
  GET    /e2e/v2/link-requests/pending  ·  POST /e2e/v2/link-requests/{id}/deny   (one-tap approval)
Mailboxes (one queue per device; packets are deleted once acknowledged)
  POST   /e2e/v2/conversations/{id}/envelopes    deliver packets to devices
  GET    /e2e/v2/mailbox/{device_id}             pending packets for one of my devices
  POST   /e2e/v2/mailbox/{device_id}/ack         done with these
Retry requests (a device couldn't decrypt a message: the sending device encrypts it again)
  POST   /e2e/v2/retry-requests                  ask the sender's device
  GET    /e2e/v2/retry-requests/{device_id}      requests waiting for one of my devices
  POST   /e2e/v2/retry-requests/{request_id}/done   handled (sent again, or can't be)
"""

import logging
import base64
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_current_user
from app.db.session import get_db
from app.models.conversation_member import ConversationMember
from app.models.e2e_v2 import E2EDevice, E2EDeviceList, E2EEnvelope, E2ELinkRequest, E2EOneTimePreKey, E2ERetryRequest, E2ESignedPreKey
from app.models.message import Message
from app.services.message_service import MessageService
from app.models.user import User
from app.services import e2e_v2 as checks
from app.services import e2e_mailbox as mailbox_service
from app.services import media_storage
from app.services import push, sessions
from app.websocket.routes import publish_users
from app.schemas.e2e_v2 import (
    MAX_ONE_TIME_PREKEYS, RegisterDevice, PreKeyUpload, PublishList, LinkRequestBody, GrantBody, SendBody, AckBody, RetryRequestBody,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/e2e/v2", tags=["Encryption v2"])

MAX_DEVICES = 10
LINK_TTL = timedelta(minutes=10)
MAILBOX_PAGE = 200
# Retry requests: only for recent messages, a few times per message and device
RETRY_MAX_AGE = timedelta(days=30)
RETRY_MAX_ATTEMPTS = 3
RETRY_PAGE = 100
STALE_UNLINKED = timedelta(days=1)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _bad(error: Exception):
    raise HTTPException(status_code=422, detail=str(error))


async def _partner_ids(db: AsyncSession, user_id: uuid.UUID) -> set[uuid.UUID]:
    mine = select(ConversationMember.conversation_id).where(ConversationMember.user_id == user_id)
    rows = await db.execute(select(ConversationMember.user_id).where(ConversationMember.conversation_id.in_(mine)).distinct())
    return set(rows.scalars().all()) | {user_id}


async def _my_device(db: AsyncSession, user: User, device_id: int) -> E2EDevice:
    device = (await db.execute(select(E2EDevice).where(
        E2EDevice.user_id == user.id, E2EDevice.device_id == device_id, E2EDevice.removed_at.is_(None),
    ))).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


async def _current_list(db: AsyncSession, user_id: uuid.UUID) -> Optional[dict]:
    row = await db.get(E2EDeviceList, user_id)
    return json.loads(row.signed_list) if row else None


# Open right now: seen within this (open apps are marked about once a minute over their WebSocket)
ACTIVE_NOW = timedelta(minutes=3)
# Not used for this long: offered for removal in Settings → Linked devices
UNUSED_AFTER = timedelta(days=30)


def _device_view(d: E2EDevice) -> dict:
    seen = d.last_seen_at
    return {"device_id": d.device_id, "name": d.name, "sign": d.sign_public, "dh": d.dh_public, "dhSig": d.dh_signature,
            "created_at": d.created_at.isoformat() if d.created_at else None,
            "last_seen_at": seen.isoformat() if seen else None,
            "active_now": bool(seen and seen >= _now() - ACTIVE_NOW),
            "unused": bool(seen and seen < _now() - UNUSED_AFTER)}


# ---- devices


async def _free_stale_devices(db: AsyncSession, user_id: uuid.UUID, idle: timedelta) -> None:
    """
    Devices that signed in but were never linked (not on the account's list) and haven't been seen for
    `idle`: they can't read anything, so they shouldn't use up the account's device slots.
    """
    signed = await _current_list(db, user_id)
    listed = {d["id"] for d in (signed or {}).get("devices", [])}
    stale = (await db.execute(select(E2EDevice).where(
        E2EDevice.user_id == user_id, E2EDevice.removed_at.is_(None), E2EDevice.last_seen_at < _now() - idle,
    ))).scalars().all()
    for device in stale:
        if device.device_id not in listed:
            await _log_out(db, user_id, device)


async def _log_out(db: AsyncSession, user_id: uuid.UUID, device: E2EDevice) -> None:
    """Remove a device and end the sign-in that registered it."""
    device.removed_at = _now()
    for model in (E2ESignedPreKey, E2EOneTimePreKey):
        await db.execute(delete(model).where(model.user_id == user_id, model.device_id == device.device_id))
    await db.execute(delete(E2EEnvelope).where(E2EEnvelope.recipient_user_id == user_id, E2EEnvelope.recipient_device_id == device.device_id))
    _remove_history(device)
    # End its sign-in (each phone or browser has its own), unless another active device still uses it
    if device.session_id and not await db.scalar(select(func.count()).select_from(E2EDevice).where(
        E2EDevice.session_id == device.session_id, E2EDevice.removed_at.is_(None), E2EDevice.id != device.id,
    )):
        await sessions.revoke(db, device.session_id)


@router.post("/devices")
async def register_device(body: RegisterDevice, request: Request, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """A new phone or browser registers its identity keys and gets its device number."""
    try:
        sign_pub, dh_pub = checks.key32(body.sign), checks.key32(body.dh)
        if not checks.verify(sign_pub, dh_pub, checks.signature(body.dhSig)):
            raise checks.KeyCheckError("The device's keys don't belong together")
    except checks.KeyCheckError as e:
        _bad(e)
    count = lambda: db.scalar(select(func.count()).select_from(E2EDevice).where(E2EDevice.user_id == user.id, E2EDevice.removed_at.is_(None)))  # noqa: E731
    await _free_stale_devices(db, user.id, STALE_UNLINKED)
    if await count() >= MAX_DEVICES:
        # Full: also free never-linked devices idle for a few minutes (a link request lasts 10)
        await _free_stale_devices(db, user.id, LINK_TTL + timedelta(minutes=5))
    if await count() >= MAX_DEVICES:
        raise HTTPException(status_code=409, detail=f"At most {MAX_DEVICES} devices. Log one out in Settings → Sessions first.")
    # Lock this user's device rows so two registrations can't get the same number
    await db.execute(select(E2EDevice.id).where(E2EDevice.user_id == user.id).with_for_update())
    highest = await db.scalar(select(func.max(E2EDevice.device_id)).where(E2EDevice.user_id == user.id)) or 0
    device = E2EDevice(user_id=user.id, device_id=highest + 1, name=body.name.strip() or "Device",
                       sign_public=body.sign, dh_public=body.dh, dh_signature=body.dhSig,
                       session_id=sessions.id_from_request(request))
    db.add(device)
    await db.commit()
    return {"success": True, "data": _device_view(device)}


@router.get("/devices/me")
async def my_devices(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """This account's signed-in phones and browsers (Settings → Sessions), and its device list."""
    rows = (await db.execute(select(E2EDevice).where(E2EDevice.user_id == user.id, E2EDevice.removed_at.is_(None)).order_by(E2EDevice.device_id))).scalars().all()
    signed = await _current_list(db, user.id)
    listed = {d["id"] for d in (signed or {}).get("devices", [])}
    return {"success": True, "data": {
        "devices": [{**_device_view(d), "linked": d.device_id in listed} for d in rows],
        "device_list": signed,
    }}


@router.delete("/devices/{device_id}")
async def remove_device(device_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """
    Log a device out: this one (logging out) or another of yours (Settings → Sessions). Its sign-in
    ends too, and it's told to sign out right away if it's online. The device that asked publishes
    the new device list without it (only devices hold the account key).
    """
    device = await _my_device(db, user, device_id)
    await _log_out(db, user.id, device)
    await db.commit()
    await publish_users([str(user.id)], {"type": "session_revoked", "deviceId": device_id})
    return {"success": True}


def _remove_history(device: E2EDevice) -> None:
    if device.history_url:
        key = media_storage.key_from_url(device.history_url)
        path = media_storage.path_for_key(key) if key else None
        if path is not None:
            path.unlink(missing_ok=True)
        device.history_url = None


@router.delete("/devices/{device_id}/history")
async def history_downloaded(device_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """The newly linked device has its message history: delete the encrypted copy."""
    _remove_history(await _my_device(db, user, device_id))
    await db.commit()
    return {"success": True}


@router.put("/devices/{device_id}/prekeys")
async def upload_prekeys(device_id: int, body: PreKeyUpload, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    device = await _my_device(db, user, device_id)
    try:
        if body.signedPreKey is not None:
            spk = body.signedPreKey
            if not isinstance(spk.get("id"), int):
                raise checks.KeyCheckError("Signed prekey needs an id")
            if not checks.verify(checks.key32(device.sign_public), checks.key32(spk.get("pub"), "Signed prekey"), checks.signature(spk.get("sig"))):
                raise checks.KeyCheckError("Signed prekey signature is invalid")
        for k in body.oneTimePreKeys:
            if not isinstance(k.get("id"), int):
                raise checks.KeyCheckError("One-time prekey needs an id")
            checks.key32(k.get("pub"), "One-time prekey")
    except checks.KeyCheckError as e:
        _bad(e)

    if body.signedPreKey is not None:
        existing = (await db.execute(select(E2ESignedPreKey).where(
            E2ESignedPreKey.user_id == user.id, E2ESignedPreKey.device_id == device_id, E2ESignedPreKey.key_id == body.signedPreKey["id"],
        ))).scalar_one_or_none()
        if existing is None:
            db.add(E2ESignedPreKey(user_id=user.id, device_id=device_id, key_id=body.signedPreKey["id"],
                                   public=body.signedPreKey["pub"], signature=body.signedPreKey["sig"]))
    stored = await db.scalar(select(func.count()).select_from(E2EOneTimePreKey).where(
        E2EOneTimePreKey.user_id == user.id, E2EOneTimePreKey.device_id == device_id))
    if stored + len(body.oneTimePreKeys) > MAX_ONE_TIME_PREKEYS:
        raise HTTPException(status_code=409, detail="Too many one-time prekeys stored")
    known = set((await db.execute(select(E2EOneTimePreKey.key_id).where(
        E2EOneTimePreKey.user_id == user.id, E2EOneTimePreKey.device_id == device_id))).scalars().all())
    for k in body.oneTimePreKeys:
        if k["id"] not in known:
            db.add(E2EOneTimePreKey(user_id=user.id, device_id=device_id, key_id=k["id"], public=k["pub"]))
            known.add(k["id"])
    device.last_seen_at = _now()
    await db.commit()
    return await prekey_status(device_id, user, db)


@router.get("/devices/{device_id}/prekeys")
async def prekey_status(device_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _my_device(db, user, device_id)
    left = await db.scalar(select(func.count()).select_from(E2EOneTimePreKey).where(
        E2EOneTimePreKey.user_id == user.id, E2EOneTimePreKey.device_id == device_id))
    latest = (await db.execute(select(E2ESignedPreKey).where(
        E2ESignedPreKey.user_id == user.id, E2ESignedPreKey.device_id == device_id,
    ).order_by(E2ESignedPreKey.created_at.desc()).limit(1))).scalar_one_or_none()
    return {"success": True, "data": {
        "one_time_left": left,
        "signed_prekey": {"id": latest.key_id, "created_at": latest.created_at.isoformat()} if latest else None,
    }}


# ---- device lists


@router.put("/device-list")
async def publish_device_list(body: PublishList, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        aik, version, devices = checks.check_device_list(body.device_list, str(user.id))
    except checks.KeyCheckError as e:
        _bad(e)
    current = await db.get(E2EDeviceList, user.id)
    aik_b64 = base64.b64encode(aik).decode()
    if current is not None:
        if current.aik != aik_b64 and not body.replace:
            raise HTTPException(status_code=409, detail="Signed by a different account key")
        if current.aik == aik_b64 and version <= current.version:
            raise HTTPException(status_code=409, detail="A newer device list is already published")
    # Every device on the list must be one of this account's registered, active devices, with the same keys
    registered = {d.device_id: d for d in (await db.execute(select(E2EDevice).where(
        E2EDevice.user_id == user.id, E2EDevice.removed_at.is_(None)))).scalars().all()}
    for d in devices:
        r = registered.get(d["id"])
        if r is None or r.sign_public != d["sign"] or r.dh_public != d["dh"]:
            raise HTTPException(status_code=422, detail=f"Device {d['id']} isn't registered with these keys")
    if current is None:
        db.add(E2EDeviceList(user_id=user.id, aik=aik_b64, version=version, signed_list=json.dumps(body.device_list), updated_at=_now()))
    else:
        current.aik, current.version, current.signed_list, current.updated_at = aik_b64, version, json.dumps(body.device_list), _now()
    await db.commit()
    partners = await _partner_ids(db, user.id)
    await publish_users([str(u) for u in partners], {"type": "e2e_device_list", "userId": str(user.id), "version": version})
    # The server's clock: devices compare it with message times to tell which messages predate them
    return {"success": True, "data": {"server_time": _now().isoformat()}}


@router.get("/users/{user_id}/device-list")
async def device_list(user_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if user_id not in await _partner_ids(db, user.id):
        raise HTTPException(status_code=404, detail="Not found")
    signed = await _current_list(db, user_id)
    if signed is None:
        raise HTTPException(status_code=404, detail="This person hasn't set up encryption v2")
    return {"success": True, "data": signed}


@router.get("/users/{user_id}/devices/{device_id}/bundle")
async def prekey_bundle(user_id: uuid.UUID, device_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Prekeys to start a session with one device. Each call uses up one one-time prekey (if any are left)."""
    if user_id not in await _partner_ids(db, user.id):
        raise HTTPException(status_code=404, detail="Not found")
    device = (await db.execute(select(E2EDevice).where(
        E2EDevice.user_id == user_id, E2EDevice.device_id == device_id, E2EDevice.removed_at.is_(None),
    ))).scalar_one_or_none()
    spk = (await db.execute(select(E2ESignedPreKey).where(
        E2ESignedPreKey.user_id == user_id, E2ESignedPreKey.device_id == device_id,
    ).order_by(E2ESignedPreKey.created_at.desc(), E2ESignedPreKey.id.desc()).limit(1))).scalar_one_or_none()
    if device is None or spk is None:
        raise HTTPException(status_code=404, detail="This device has no prekeys")
    # Take one one-time prekey; SKIP LOCKED so two senders never get the same one
    opk = (await db.execute(select(E2EOneTimePreKey).where(
        E2EOneTimePreKey.user_id == user_id, E2EOneTimePreKey.device_id == device_id,
    ).order_by(E2EOneTimePreKey.key_id).limit(1).with_for_update(skip_locked=True))).scalar_one_or_none()
    one_time = None
    if opk is not None:
        one_time = {"id": opk.key_id, "pub": opk.public}
        await db.delete(opk)
    await db.commit()
    return {"success": True, "data": {
        "user": str(user_id), "deviceId": device_id,
        "identitySign": device.sign_public, "identityDh": device.dh_public, "identityDhSig": device.dh_signature,
        "signedPreKey": {"id": spk.key_id, "pub": spk.public, "sig": spk.signature},
        "oneTimePreKey": one_time,
    }}


# ---- linking


def _link_view(r: E2ELinkRequest, device: E2EDevice) -> dict:
    return {"id": str(r.id), "device_id": r.device_id, "name": device.name, "ek": r.ephemeral_public,
            "sign": device.sign_public, "dh": device.dh_public, "dhSig": device.dh_signature,
            "code": r.code, "expires_at": r.expires_at.isoformat()}


@router.post("/link-requests")
async def create_link_request(body: LinkRequestBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """The new device (registered, not yet on the list) asks the primary to certify it."""
    device = await _my_device(db, user, body.device_id)
    try:
        ek = checks.key32(body.ek, "Link key")
    except checks.KeyCheckError as e:
        _bad(e)
    now = _now()
    await db.execute(delete(E2ELinkRequest).where(E2ELinkRequest.expires_at < now))
    # The limit is on devices waiting, not requests: a device asking again (a retry, or the page
    # asking twice while it loads) doesn't use it up. Its earlier requests stay valid until they
    # expire, so whichever code is on its screen still works.
    waiting = await db.scalar(
        select(func.count(func.distinct(E2ELinkRequest.device_id)))
        .where(E2ELinkRequest.user_id == user.id, E2ELinkRequest.device_id != device.device_id)
    )
    mine = await db.scalar(
        select(func.count()).select_from(E2ELinkRequest)
        .where(E2ELinkRequest.user_id == user.id, E2ELinkRequest.device_id == device.device_id)
    )
    if waiting >= 5 or mine >= 10:
        raise HTTPException(status_code=429, detail="Too many devices waiting to be linked. Try again in a few minutes.")
    code = checks.link_code(ek, checks.key32(device.sign_public), checks.key32(device.dh_public))
    request = E2ELinkRequest(user_id=user.id, device_id=device.device_id, ephemeral_public=body.ek, code=code,
                             created_at=now, expires_at=now + LINK_TTL)
    db.add(request)
    await db.commit()
    # The account's other devices show "Is this you?" right away (and phones get a notification)
    await publish_users([str(user.id)], {"type": "e2e_link_request", "requestId": str(request.id), "name": device.name})
    try:
        await push.send_to_users(db, [user.id], "Is this you?", f"{device.name} wants to link to your ShareEven account",
                                 {"type": "e2e_link_request", "requestId": str(request.id)})
    except Exception:
        logger.warning("Couldn't send the link request notification", exc_info=True)
    return {"success": True, "data": _link_view(request, device)}


@router.get("/link-requests/pending")
async def pending_link_requests(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Devices waiting to be approved, for the "Is this you?" prompt on the account's linked devices."""
    rows = (await db.execute(select(E2ELinkRequest).where(
        E2ELinkRequest.user_id == user.id, E2ELinkRequest.expires_at >= _now(),
        E2ELinkRequest.grant.is_(None), E2ELinkRequest.denied_at.is_(None),
    ).order_by(E2ELinkRequest.created_at.desc()))).scalars().all()
    out, seen = [], set()
    for r in rows:
        if r.device_id in seen:
            continue  # a device that asked twice: only its newest request
        device = (await db.execute(select(E2EDevice).where(
            E2EDevice.user_id == user.id, E2EDevice.device_id == r.device_id, E2EDevice.removed_at.is_(None),
        ))).scalar_one_or_none()
        if device is not None:
            seen.add(r.device_id)
            out.append(_link_view(r, device))
    return {"success": True, "data": out}


async def _own_link(db: AsyncSession, request_id: uuid.UUID, user: User) -> tuple[E2ELinkRequest, E2EDevice]:
    request = await db.get(E2ELinkRequest, request_id)
    if request is None or request.user_id != user.id or request.expires_at < _now():
        raise HTTPException(status_code=404, detail="This link request has expired. Start again on the new device.")
    return request, await _my_device(db, user, request.device_id)


@router.get("/link-requests")
async def find_link_request(code: str = Query(..., min_length=16, max_length=32), user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    clean = code.upper().replace("-", "").replace(" ", "")
    request = (await db.execute(select(E2ELinkRequest).where(
        E2ELinkRequest.user_id == user.id, E2ELinkRequest.code == clean, E2ELinkRequest.expires_at >= _now(), E2ELinkRequest.grant.is_(None),
        E2ELinkRequest.denied_at.is_(None),
    ))).scalars().first()
    if request is None:
        raise HTTPException(status_code=404, detail="No device is waiting with that code. Check it, or start again on the new device.")
    return {"success": True, "data": _link_view(request, await _my_device(db, user, request.device_id))}


@router.get("/link-requests/{request_id}")
async def link_request(request_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """The new device polls this; the grant is returned once and then deleted."""
    request, device = await _own_link(db, request_id, user)
    view = _link_view(request, device)
    if request.denied_at is not None:
        return {"success": True, "data": {**view, "status": "denied"}}
    if request.grant is None:
        return {"success": True, "data": {**view, "status": "waiting"}}
    grant = json.loads(request.grant)
    await db.delete(request)
    await db.commit()
    return {"success": True, "data": {**view, "status": "approved", "grant": grant}}


@router.post("/link-requests/{request_id}/grant")
async def grant_link(request_id: uuid.UUID, body: GrantBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """The primary hands over the encrypted grant (it publishes the new device list separately)."""
    request, _ = await _own_link(db, request_id, user)
    if request.grant is not None:
        raise HTTPException(status_code=409, detail="This device has already been linked")
    if request.denied_at is not None:
        raise HTTPException(status_code=409, detail="This device was turned down. Start again on the new device.")
    if len(json.dumps(body.grant)) > 64 * 1024 or not {"v", "requestId", "e", "c"} <= body.grant.keys():
        raise HTTPException(status_code=422, detail="Invalid grant")
    request.grant = json.dumps(body.grant)
    if body.history_url:
        url = media_storage.unsigned(body.history_url)
        if not media_storage.is_stored_media_url(url) or not url.endswith(media_storage.ENCRYPTED_EXTENSION):
            raise HTTPException(status_code=422, detail="Invalid history file")
        device = await _my_device(db, user, request.device_id)
        _remove_history(device)
        device.history_url = url
    # It's linked now: its other asks (the screen may ask more than once) mustn't pop up "Is this you?" again
    await db.execute(delete(E2ELinkRequest).where(
        E2ELinkRequest.user_id == user.id, E2ELinkRequest.device_id == request.device_id,
        E2ELinkRequest.id != request.id, E2ELinkRequest.grant.is_(None),
    ))
    await db.commit()
    await publish_users([str(user.id)], {"type": "e2e_link_granted", "requestId": str(request.id)})
    return {"success": True}


@router.post("/link-requests/{request_id}/deny")
async def deny_link(request_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """"Not me" (or the wrong number) on a linked device: the new device is told, and nothing is sent to it."""
    request, _ = await _own_link(db, request_id, user)
    if request.grant is not None:
        raise HTTPException(status_code=409, detail="This device has already been linked")
    # Every waiting request from that device (it may have asked more than once)
    await db.execute(update(E2ELinkRequest).where(
        E2ELinkRequest.user_id == user.id, E2ELinkRequest.device_id == request.device_id,
        E2ELinkRequest.grant.is_(None), E2ELinkRequest.denied_at.is_(None),
    ).values(denied_at=_now()))
    await db.commit()
    await publish_users([str(user.id)], {"type": "e2e_link_denied", "requestId": str(request.id)})
    return {"success": True}


# ---- mailboxes


async def deliver(db: AsyncSession, user: User, conversation_id: uuid.UUID, body: SendBody) -> list[str]:
    """Queue packets for devices of the conversation's members (and the sender's own devices)."""
    if body.message_id is not None:
        # Follow-ups (edits, resends) belong to one of the sender's own messages in this chat
        message = await MessageService.get_message(db, body.message_id, wait_seconds=2)
        if message is None or message.conversation_id != conversation_id or message.sender_id != user.id:
            raise HTTPException(status_code=404, detail="Message not found")
    try:
        rows = await mailbox_service.queue(db, user.id, conversation_id, body.from_device,
                                           [mailbox_service.Outgoing(p.to_user, p.to_device, p.packet) for p in body.packets], body.message_id)
    except mailbox_service.MailboxError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)
    await db.commit()
    for user_id, event in mailbox_service.events(rows):
        await publish_users([user_id], event)
    return [str(e.id) for e in rows]


@router.post("/conversations/{conversation_id}/envelopes")
async def send_envelopes(conversation_id: uuid.UUID, body: SendBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    ids = await deliver(db, user, conversation_id, body)
    return {"success": True, "data": {"ids": ids}}


@router.get("/mailbox/{device_id}")
async def mailbox(device_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    device = await _my_device(db, user, device_id)
    device.last_seen_at = _now()
    rows = (await db.execute(select(E2EEnvelope).where(
        E2EEnvelope.recipient_user_id == user.id, E2EEnvelope.recipient_device_id == device_id,
    ).order_by(E2EEnvelope.created_at, E2EEnvelope.id).limit(MAILBOX_PAGE + 1))).scalars().all()
    await db.commit()
    return {"success": True, "data": [mailbox_service.envelope_view(e) for e in rows[:MAILBOX_PAGE]], "has_more": len(rows) > MAILBOX_PAGE}


def _retry_view(r: E2ERetryRequest) -> dict:
    return {"id": str(r.id), "message_id": str(r.message_id), "conversation_id": str(r.conversation_id),
            "requester": {"user": str(r.requester_user_id), "device": r.requester_device_id},
            "sender_device": r.sender_device_id, "attempts": r.attempts,
            "created_at": r.created_at.isoformat() if r.created_at else None}


@router.post("/retry-requests")
async def request_retry(body: RetryRequestBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """This device couldn't decrypt a message: ask the device that sent it to encrypt it again."""
    await _my_device(db, user, body.device_id)
    message = await db.get(Message, body.message_id)
    if message is None or message.text != media_storage.V2_MARKER or message.sender_id is None:
        raise HTTPException(status_code=404, detail="Message not found")
    if user.id not in {uuid.UUID(m) for m in await MessageService.member_ids(db, message.conversation_id)}:
        raise HTTPException(status_code=404, detail="Message not found")
    created = message.created_at if message.created_at.tzinfo else message.created_at.replace(tzinfo=timezone.utc)
    if _now() - created > RETRY_MAX_AGE:
        raise HTTPException(status_code=410, detail="This message is too old to send again")
    sender_device = (await db.execute(select(E2EDevice).where(
        E2EDevice.user_id == message.sender_id, E2EDevice.device_id == body.sender_device, E2EDevice.removed_at.is_(None),
    ))).scalar_one_or_none()
    if sender_device is None:
        raise HTTPException(status_code=404, detail="The device that sent this message is no longer signed in")
    if message.sender_id == user.id and body.sender_device == body.device_id:
        raise HTTPException(status_code=422, detail="A device can't ask itself")
    request = (await db.execute(select(E2ERetryRequest).where(
        E2ERetryRequest.message_id == message.id, E2ERetryRequest.requester_user_id == user.id,
        E2ERetryRequest.requester_device_id == body.device_id,
    ))).scalar_one_or_none()
    if request is None:
        request = E2ERetryRequest(message_id=message.id, conversation_id=message.conversation_id, requester_user_id=user.id,
                                  requester_device_id=body.device_id, sender_user_id=message.sender_id,
                                  sender_device_id=body.sender_device, attempts=1)
        db.add(request)
    elif request.attempts >= RETRY_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Already asked several times")
    else:
        request.attempts += 1
        request.sender_device_id = body.sender_device
        request.handled_at = None
    await db.commit()
    await db.refresh(request)
    await publish_users([str(message.sender_id)], {"type": "e2e_retry_request", "request": _retry_view(request)})
    return {"success": True, "data": _retry_view(request)}


@router.get("/retry-requests/{device_id}")
async def retry_requests(device_id: int, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Requests waiting for one of my devices (fetched on every connect; live ones also come over the WebSocket)."""
    await _my_device(db, user, device_id)
    mine = (E2ERetryRequest.sender_user_id == user.id, E2ERetryRequest.sender_device_id == device_id)
    await db.execute(delete(E2ERetryRequest).where(*mine, E2ERetryRequest.created_at < _now() - RETRY_MAX_AGE))
    rows = (await db.execute(select(E2ERetryRequest).where(*mine, E2ERetryRequest.handled_at.is_(None))
                             .order_by(E2ERetryRequest.created_at).limit(RETRY_PAGE))).scalars().all()
    await db.commit()
    return {"success": True, "data": [_retry_view(r) for r in rows]}


@router.post("/retry-requests/{request_id}/done")
async def retry_done(request_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await db.execute(update(E2ERetryRequest).where(E2ERetryRequest.id == request_id, E2ERetryRequest.sender_user_id == user.id)
                     .values(handled_at=_now()))
    await db.commit()
    return {"success": True}


@router.post("/mailbox/{device_id}/ack")
async def ack(device_id: int, body: AckBody, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await _my_device(db, user, device_id)
    await db.execute(delete(E2EEnvelope).where(
        E2EEnvelope.recipient_user_id == user.id, E2EEnvelope.recipient_device_id == device_id, E2EEnvelope.id.in_(body.ids),
    ))
    await db.commit()
    return {"success": True}
