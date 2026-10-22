# backend/app/services/e2e_mailbox.py

"""
Queuing end-to-end encryption v2 packets for devices (used by the REST endpoint and the WebSocket).
The packets are opaque; this only checks who may send what to whom.
"""

import json
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.e2e_v2 import E2EDevice, E2EDeviceList, E2EEnvelope
from app.services.message_service import MessageService

MAX_PACKET_BYTES = 256 * 1024
MAX_PACKETS_PER_SEND = 200


class MailboxError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


class DevicesChanged(MailboxError):
    """The packets don't match the members' device lists: the sender refreshes them and encrypts again."""

    def __init__(self, missing: list[tuple[uuid.UUID, int]], extra: list[tuple[uuid.UUID, int]]):
        super().__init__(409, "Some devices were removed. Fetch the device lists again." if extra and not missing
                         else "Someone's devices changed. Fetch the device lists again.")
        self.missing = missing
        self.extra = extra

    def details(self) -> dict:
        view = lambda pairs: [{"user": str(u), "device": d} for u, d in sorted(pairs, key=lambda p: (str(p[0]), p[1]))]
        return {"code": "devices_changed", "missing": view(self.missing), "extra": view(self.extra)}


@dataclass
class Outgoing:
    to_user: uuid.UUID
    to_device: int
    packet: dict[str, Any]


async def listed_devices(db: AsyncSession, user_ids: set[uuid.UUID]) -> set[tuple[uuid.UUID, int]]:
    """(user, device) for every device on these users' signed device lists that hasn't logged out."""
    listed = set()
    for row in (await db.execute(select(E2EDeviceList).where(E2EDeviceList.user_id.in_(user_ids)))).scalars():
        listed |= {(row.user_id, d["id"]) for d in json.loads(row.signed_list).get("devices", []) if isinstance(d.get("id"), int)}
    if not listed:
        return listed
    active = set((await db.execute(select(E2EDevice.user_id, E2EDevice.device_id).where(
        E2EDevice.user_id.in_(user_ids), E2EDevice.removed_at.is_(None),
    ))).all())
    return listed & active


async def queue(db: AsyncSession, sender_id: uuid.UUID, conversation_id: uuid.UUID, from_device: int,
                packets: list[Outgoing], message_id: uuid.UUID | None, complete: bool = False) -> list[E2EEnvelope]:
    """
    Add the packets to the devices' mailboxes (not committed). Raises MailboxError.
    With `complete`, the packets must reach every listed device of every member except the sending one
    (a new message, like Signal's mismatched-devices check), so no device silently misses it.
    """
    if not packets or len(packets) > MAX_PACKETS_PER_SEND:
        raise MailboxError(422, "Nothing to send, or too many packets")
    sender_device = (await db.execute(select(E2EDevice.id).where(
        E2EDevice.user_id == sender_id, E2EDevice.device_id == from_device, E2EDevice.removed_at.is_(None),
    ))).scalar_one_or_none()
    if sender_device is None:
        raise MailboxError(404, "Device not found")
    members = {uuid.UUID(m) for m in await MessageService.member_ids(db, conversation_id)}
    if sender_id not in members:
        raise MailboxError(404, "Conversation not found")
    targets = {(p.to_user, p.to_device) for p in packets}
    if any(u not in members for u, _ in targets):
        raise MailboxError(422, "Packets can only go to members of this conversation")
    known = (await db.execute(select(E2EDevice.user_id, E2EDevice.device_id, E2EDevice.removed_at).where(
        E2EDevice.user_id.in_({u for u, _ in targets}),
    ))).all()
    active = {(u, d) for u, d, removed in known if removed is None}
    logged_out = {(u, d) for u, d, removed in known if removed is not None}
    if not targets <= active | logged_out:
        raise DevicesChanged([], list(targets - active - logged_out))
    # A device that logged out can never read anything: skip its packets instead of failing the message
    # (its owner's signed list may still name it until another of their devices signs a new one)
    packets = [p for p in packets if (p.to_user, p.to_device) in active]
    if not packets:
        raise DevicesChanged([], list(targets))
    if complete:
        expected = await listed_devices(db, members) - {(sender_id, from_device)}
        if expected - targets:
            raise DevicesChanged(list(expected - targets), [])
    rows = []
    for p in packets:
        raw = json.dumps(p.packet)
        if len(raw) > MAX_PACKET_BYTES:
            raise MailboxError(413, "Packet too large")
        rows.append(E2EEnvelope(
            recipient_user_id=p.to_user, recipient_device_id=p.to_device, sender_user_id=sender_id,
            sender_device_id=from_device, conversation_id=conversation_id, message_id=message_id, packet=raw,
        ))
    db.add_all(rows)
    await db.flush()
    return rows


def envelope_view(e: E2EEnvelope) -> dict:
    return {"id": str(e.id), "from": {"user": str(e.sender_user_id), "device": e.sender_device_id},
            "conversation_id": str(e.conversation_id) if e.conversation_id else None,
            "message_id": str(e.message_id) if e.message_id else None,
            "packet": json.loads(e.packet), "created_at": e.created_at.isoformat() if e.created_at else None}


def events(rows: list[E2EEnvelope], meta: dict | None = None) -> list[tuple[str, dict]]:
    """
    (recipient user id, WebSocket event) for each queued packet. `meta`: the new message's details
    (server id, time, sender, media links), so a device can show the message as soon as it has
    decrypted it, without waiting for anything else.
    """
    return [(str(e.recipient_user_id), {"type": "e2e_envelope", "deviceId": e.recipient_device_id, "envelope": envelope_view(e),
                                        **({"meta": meta} if meta else {})}) for e in rows]
