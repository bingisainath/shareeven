# backend/app/api/v1/e2e_keys.py

"""
End-to-end encryption keys. The server only holds public keys (see app/models/e2e_key.py).

- GET/PUT /keys/me: your public keys (set by your first device, or a fresh start).
- Linking a new device, like WhatsApp Web:
    1. the new device: POST /keys/link-requests with a one-off public key, then shows a QR code
       (or the 16-character code) and waits;
    2. a signed-in device: scans the QR (or finds the request by code), checks it, and
       POST /keys/link-requests/{id}/approve with the keys encrypted for that one-off key;
    3. the new device: GET /keys/link-requests/{id} collects them once.
  Requests belong to one account and expire after LINK_TTL.
- GET /conversations/{id}/keys: members' public keys, to encrypt a message for them.
- GET /keys?user_ids=: public keys (current and replaced) of people you share a chat with.
"""

import base64
import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_current_user
from app.db.session import get_db
from app.models.conversation_member import ConversationMember
from app.models.e2e_key import KeyLinkRequest, PreviousUserKeys, UserKeys
from app.models.e2e_v2 import E2EDeviceList
from app.models.user import User
from app.services.message_service import MessageService
from app.services import e2e_mailbox
from app.websocket.routes import publish_users
from app.schemas.e2e_keys import (
    SetKeysBody, LinkRequestBody, ApproveBody,
)

router = APIRouter(tags=["Encryption keys"])

LINK_TTL = timedelta(minutes=10)
MAX_PENDING_LINKS = 5


def link_code(ephemeral_public: str) -> str:
    """16 characters (80 bits) of the key's SHA-256 in base32: same as linkCode() in the apps."""
    return base64.b32encode(hashlib.sha256(base64.b64decode(ephemeral_public)).digest()).decode()[:16]


def _mine(keys: UserKeys | None) -> dict:
    if keys is None:
        return {"has_keys": False}
    return {
        "has_keys": True,
        "enc_public": keys.enc_public,
        "sign_public": keys.sign_public,
        "updated_at": keys.updated_at.isoformat() if keys.updated_at else None,
    }


async def _chat_partner_ids(db: AsyncSession, user_id: uuid.UUID) -> set[uuid.UUID]:
    """Everyone who shares at least one conversation with the user (including the user)."""
    mine = select(ConversationMember.conversation_id).where(ConversationMember.user_id == user_id)
    rows = await db.execute(select(ConversationMember.user_id).where(ConversationMember.conversation_id.in_(mine)).distinct())
    return set(rows.scalars().all()) | {user_id}


async def _public_keys(db: AsyncSession, user_ids: set[uuid.UUID]) -> dict[str, dict]:
    if not user_ids:
        return {}
    current = (await db.execute(select(UserKeys).where(UserKeys.user_id.in_(user_ids)))).scalars().all()
    previous = (await db.execute(
        select(PreviousUserKeys).where(PreviousUserKeys.user_id.in_(user_ids)).order_by(PreviousUserKeys.replaced_at.desc())
    )).scalars().all()
    out: dict[str, dict] = {}
    for k in current:
        out[str(k.user_id)] = {"enc": k.enc_public, "sign": k.sign_public, "previous_sign": []}
    for k in previous:
        entry = out.setdefault(str(k.user_id), {"enc": None, "sign": None, "previous_sign": []})
        entry["previous_sign"].append(k.sign_public)
    return out


def _now() -> datetime:
    return datetime.now(timezone.utc)


@router.get("/keys/me")
async def my_keys(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return {"success": True, "data": _mine(await db.get(UserKeys, current_user.id))}


@router.put("/keys/me")
async def set_my_keys(body: SetKeysBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """First device: publish the new keys. replace=true: start fresh (no other device to link from)."""
    existing = await db.get(UserKeys, current_user.id)
    now = _now()
    if existing and not body.replace:
        raise HTTPException(status_code=409, detail="Encryption is already set up for this account. Link this device instead.")
    if existing:
        db.add(PreviousUserKeys(
            user_id=current_user.id, enc_public=existing.enc_public, sign_public=existing.sign_public,
            created_at=existing.created_at or now,
        ))
        existing.enc_public, existing.sign_public = body.enc_public, body.sign_public
        existing.created_at = existing.updated_at = now
        keys = existing
        # Pending links would hand out the old keys
        await db.execute(delete(KeyLinkRequest).where(KeyLinkRequest.user_id == current_user.id))
    else:
        keys = UserKeys(user_id=current_user.id, enc_public=body.enc_public, sign_public=body.sign_public, created_at=now, updated_at=now)
        db.add(keys)
    await db.commit()

    # Chat partners' apps refresh their copy (new chats with this person become encrypted, or use the new key)
    partners = await _chat_partner_ids(db, current_user.id)
    await publish_users([str(u) for u in partners], {"type": "keys_changed", "userId": str(current_user.id)})
    return {"success": True, "data": _mine(keys)}


@router.delete("/keys/me")
async def retire_my_keys(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """
    Starting fresh with encryption v2 only: the version 1 keys are retired. Nobody encrypts to them any
    more; they're kept (as previous keys) so signatures on older messages can still be checked.
    """
    existing = await db.get(UserKeys, current_user.id)
    if existing is None:
        return {"success": True}
    db.add(PreviousUserKeys(
        user_id=current_user.id, enc_public=existing.enc_public, sign_public=existing.sign_public,
        created_at=existing.created_at or _now(),
    ))
    await db.delete(existing)
    await db.execute(delete(KeyLinkRequest).where(KeyLinkRequest.user_id == current_user.id))
    await db.commit()
    partners = await _chat_partner_ids(db, current_user.id)
    await publish_users([str(u) for u in partners], {"type": "keys_changed", "userId": str(current_user.id)})
    return {"success": True}


# ---- linking a new device

def _link_view(request: KeyLinkRequest) -> dict:
    return {
        "id": str(request.id),
        "ephemeral_public": request.ephemeral_public,
        "code": request.code,
        "device_name": request.device_name,
        "created_at": request.created_at.isoformat() if request.created_at else None,
        "expires_at": request.expires_at.isoformat(),
    }


async def _own_request(db: AsyncSession, request_id: uuid.UUID, user: User) -> KeyLinkRequest:
    request = await db.get(KeyLinkRequest, request_id)
    if request is None or request.user_id != user.id or request.expires_at < _now():
        raise HTTPException(status_code=404, detail="This link request has expired. Start again on the new device.")
    return request


@router.post("/keys/link-requests")
async def create_link_request(body: LinkRequestBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """New device: ask for the account's keys. Show the returned QR/code on screen."""
    if await db.get(UserKeys, current_user.id) is None:
        raise HTTPException(status_code=409, detail="Encryption isn't set up yet: this device can set it up instead.")
    now = _now()
    await db.execute(delete(KeyLinkRequest).where(KeyLinkRequest.expires_at < now))
    pending = await db.scalar(select(func.count()).select_from(KeyLinkRequest).where(KeyLinkRequest.user_id == current_user.id))
    if pending >= MAX_PENDING_LINKS:
        raise HTTPException(status_code=429, detail="Too many devices waiting to be linked. Try again in a few minutes.")
    request = KeyLinkRequest(
        user_id=current_user.id, ephemeral_public=body.ephemeral_public, code=link_code(body.ephemeral_public),
        device_name=body.device_name.strip() or "New device", created_at=now, expires_at=now + LINK_TTL,
    )
    db.add(request)
    await db.commit()
    return {"success": True, "data": _link_view(request)}


@router.get("/keys/link-requests")
async def find_link_request(
    code: str = Query(..., min_length=16, max_length=32),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Signed-in device: find your new device's request by the code it shows (typed instead of scanned)."""
    clean = code.upper().replace("-", "").replace(" ", "")
    request = (await db.execute(select(KeyLinkRequest).where(
        KeyLinkRequest.user_id == current_user.id, KeyLinkRequest.code == clean,
        KeyLinkRequest.expires_at >= _now(), KeyLinkRequest.payload.is_(None),
    ))).scalars().first()
    if request is None:
        raise HTTPException(status_code=404, detail="No device is waiting with that code. Check it, or start again on the new device.")
    return {"success": True, "data": _link_view(request)}


@router.get("/keys/link-requests/{request_id}")
async def link_request_status(request_id: uuid.UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """
    New device: has another device sent the keys yet? Returns them once (they're deleted from the
    server as soon as they're collected). The approving device also uses this to see the request.
    """
    request = await _own_request(db, request_id, current_user)
    view = _link_view(request)
    if request.payload is None:
        return {"success": True, "data": {**view, "status": "waiting"}}
    payload = json.loads(request.payload)
    await db.delete(request)
    await db.commit()
    return {"success": True, "data": {**view, "status": "approved", "payload": payload}}


@router.post("/keys/link-requests/{request_id}/approve")
async def approve_link_request(
    request_id: uuid.UUID, body: ApproveBody, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    """Signed-in device: hand over the keys, encrypted so only the waiting device can open them."""
    request = await _own_request(db, request_id, current_user)
    if request.payload is not None:
        raise HTTPException(status_code=409, detail="This device has already been linked")
    request.payload = json.dumps(body.payload)
    await db.commit()
    await publish_users([str(current_user.id)], {"type": "key_link_approved", "requestId": str(request.id)})
    return {"success": True, "message": "Device linked"}


@router.delete("/keys/link-requests/{request_id}")
async def cancel_link_request(request_id: uuid.UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    request = await db.get(KeyLinkRequest, request_id)
    if request is not None and request.user_id == current_user.id:
        await db.delete(request)
        await db.commit()
    return {"success": True}


# ---- other people's public keys

@router.get("/keys")
async def public_keys(
    user_ids: str = Query(..., max_length=4000, description="Comma-separated user IDs"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Public keys of people you share a chat with (others are left out)."""
    try:
        wanted = {uuid.UUID(u) for u in user_ids.split(",") if u.strip()}
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid user ID")
    allowed = wanted & await _chat_partner_ids(db, current_user.id)
    return {"success": True, "data": await _public_keys(db, allowed)}


@router.get("/conversations/{conversation_id}/keys")
async def conversation_keys(conversation_id: uuid.UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """
    Who can receive encrypted messages here. The chat is encrypted when every member has version 2
    (a signed device list) or every member has version 1 keys. `missing` lists the members holding
    that up (those without version 2, the way forward): until they sign in, the apps send this chat's
    messages unencrypted and say so. `members` and `v1_missing` are for sending with version 1.
    """
    if not await MessageService.is_member(db, conversation_id, current_user.id):
        raise HTTPException(status_code=404, detail="Conversation not found")
    members = {uuid.UUID(m) for m in await MessageService.member_ids(db, conversation_id)}
    keys = await _public_keys(db, members)
    ready = {uid: k for uid, k in keys.items() if k["enc"]}
    v1_missing = sorted(str(m) for m in members if str(m) not in ready)
    # Version 2 needs a signed device list with at least one device that hasn't logged out: someone whose
    # devices were all logged out can't receive anything until they sign in again
    with_v2 = {u for u, _ in await e2e_mailbox.listed_devices(db, members)}
    v2_missing = sorted(str(m) for m in members if m not in with_v2)
    return {
        "success": True,
        "data": {
            "members": ready,
            "v1_missing": v1_missing,
            "v2_ready": not v2_missing,
            "missing": [] if not v2_missing or not v1_missing else v2_missing,
        },
    }
