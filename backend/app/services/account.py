# backend/app/services/account.py
# A person's rights over their data: download everything the server holds about them, and
# delete their account.
#
# Deleting doesn't remove the user row. Their shares in group expenses and the payments they
# made or received are other people's records too, and removing them would silently change
# everyone else's balances. So the row stays as "Deleted user" with every personal field wiped,
# and everything that is only theirs (sign-ins, devices, keys, backups, settings, files, the
# content of their messages) is removed.

import logging
import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.models.ai import UserAISettings
from app.models.auth_session import AuthSession
from app.models.conversation import Conversation
from app.models.conversation_member import ConversationMember, MemberRole
from app.models.device import DeviceToken
from app.models.e2e_key import KeyLinkRequest, PreviousUserKeys, UserKeys
from app.models.e2e_v2 import (
    E2EBackup, E2EDevice, E2EDeviceList, E2EEnvelope, E2ELinkRequest, E2EOneTimePreKey, E2ESignedPreKey,
)
from app.models.expense import Expense, ExpensePayer, ExpenseShare, Settlement
from app.models.message import Message
from app.models.message_reaction import MessageReaction
from app.models.message_receipt import MessageReceipt
from app.models.receipt import Receipt, StoreDiscountRule
from app.models.safety import AccountNotice, UserBlock
from app.models.support import SupportTicket
from app.models.user import User
from app.services import expense_service, media_storage

logger = logging.getLogger(__name__)

DELETED_NAME = "Deleted user"


def _iso(value) -> str | None:
    return value.isoformat() if value else None


# ------------------------------------------------------------------ export

async def export_data(db: AsyncSession, user: User) -> dict:
    """Everything the server holds about this person, as plain JSON (media as signed links)."""
    uid = user.id
    sessions = (await db.execute(select(AuthSession).where(AuthSession.user_id == uid).order_by(AuthSession.created_at))).scalars().all()
    devices = (await db.execute(select(E2EDevice).where(E2EDevice.user_id == uid).order_by(E2EDevice.device_id))).scalars().all()

    memberships = (await db.execute(
        select(ConversationMember, Conversation)
        .join(Conversation, Conversation.id == ConversationMember.conversation_id)
        .where(ConversationMember.user_id == uid)
    )).all()

    messages = (await db.execute(
        select(Message).where(Message.sender_id == uid).order_by(Message.created_at)
    )).scalars().all()

    expense_ids = select(ExpensePayer.expense_id).where(ExpensePayer.user_id == uid).union(
        select(ExpenseShare.expense_id).where(ExpenseShare.user_id == uid),
        select(Expense.id).where(Expense.created_by == uid),
    )
    expenses = (await db.execute(select(Expense).where(Expense.id.in_(expense_ids)).order_by(Expense.spent_at))).scalars().all()
    settlements = (await db.execute(
        select(Settlement).where(or_(Settlement.from_user == uid, Settlement.to_user == uid, Settlement.created_by == uid))
        .order_by(Settlement.created_at)
    )).scalars().all()
    receipts = (await db.execute(select(Receipt).where(Receipt.uploaded_by == uid).order_by(Receipt.created_at))).scalars().all()
    discounts = (await db.execute(select(StoreDiscountRule).where(StoreDiscountRule.owner_id == uid))).scalars().all()
    notices = (await db.execute(select(AccountNotice).where(AccountNotice.user_id == uid).order_by(AccountNotice.created_at))).scalars().all()
    tickets = (await db.execute(select(SupportTicket).where(SupportTicket.user_id == uid).order_by(SupportTicket.created_at))).scalars().all()

    def message_view(m: Message) -> dict:
        encrypted = (m.text or "").startswith(media_storage.V2_MARKER)
        return {
            "id": str(m.id), "conversation_id": str(m.conversation_id), "sent_at": _iso(m.created_at),
            "type": m.message_type.value, "deleted": m.is_deleted, "end_to_end_encrypted": encrypted,
            "text": None if encrypted else m.text,
            "media": media_storage.sign_url(m.media_url) if m.media_url else None,
            "file_name": m.media_filename,
        }

    return {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "about": (
            "Everything ShareEven's server holds about you. End-to-end encrypted messages can't be read by "
            "the server, so their text is only on your devices. Media links work for a limited time."
        ),
        "account": {
            "id": str(uid), "username": user.username, "email": user.email, "name": user.name, "bio": user.bio,
            "photo": media_storage.sign_url(user.avatar) if user.avatar else None,
            "payment_handles": user.payment_handles or {}, "display_currency": user.display_currency,
            "email_verified": user.email_verified, "created_at": _iso(user.created_at),
        },
        "sign_ins": [{"device": s.user_agent, "signed_in_at": _iso(s.created_at), "signed_out_at": _iso(s.revoked_at)} for s in sessions],
        "devices": [{"name": d.name, "added_at": _iso(d.created_at), "last_seen_at": _iso(d.last_seen_at),
                     "removed_at": _iso(d.removed_at)} for d in devices],
        "chats": [{
            "id": str(conv.id), "kind": conv.kind, "title": conv.title if conv.kind == "group" else None,
            "role": member.role.value if member.role else None, "joined_at": _iso(member.joined_at),
            "muted_until": _iso(member.muted_until), "archived": member.archived_at is not None,
            "pinned": member.pinned_at is not None,
        } for member, conv in memberships],
        "messages_sent": [message_view(m) for m in messages],
        "expenses": [expense_service.serialize(e) for e in expenses],
        "payments": [{
            "id": str(s.id), "conversation_id": str(s.conversation_id), "from_user": str(s.from_user),
            "to_user": str(s.to_user), "currency": s.currency, "amount_minor": s.amount_minor, "note": s.note,
            "recorded_at": _iso(s.created_at), "undone": s.deleted_at is not None,
        } for s in settlements],
        "receipts_uploaded": [{
            "id": str(r.id), "conversation_id": str(r.conversation_id), "store": r.store_name, "status": r.status,
            "uploaded_at": _iso(r.created_at), "photos": [media_storage.sign_url(u) for u in r.image_urls or []],
            "read_by_model": r.model,
        } for r in receipts],
        "notices_from_shareeven": [{"kind": n.kind, "title": n.title, "body": n.body, "sent_at": _iso(n.created_at)} for n in notices],
        "support_requests": [{
            "category": t.category, "subject": t.subject, "message": t.message, "status": t.status,
            "sent_at": _iso(t.created_at), "reply": t.reply, "replied_at": _iso(t.replied_at),
        } for t in tickets],
        "settings": {
            "store_discounts": [{"store": d.store_name, "percent": float(d.percent)} for d in discounts],
        },
    }


# ------------------------------------------------------------------ delete

async def delete_account(db: AsyncSession, user: User) -> dict:
    """
    Remove everything personal and keep the shared records as "Deleted user". Returns what the
    caller needs afterwards: files to remove and the groups to notify.
    """
    uid = user.id
    old_name = user.username
    files: set[str] = set()

    # Files that are only theirs: profile photo, what they sent, their backup and device history
    if user.avatar:
        files.add(user.avatar)
    for media_url, thumbnail in (await db.execute(
        select(Message.media_url, Message.media_thumbnail).where(Message.sender_id == uid)
    )).all():
        files.update(u for u in (media_url, thumbnail) if u)
    backup = await db.get(E2EBackup, uid)
    if backup and backup.url:
        files.add(backup.url)
    files.update(h for (h,) in (await db.execute(
        select(E2EDevice.history_url).where(E2EDevice.user_id == uid, E2EDevice.history_url.is_not(None))
    )).all())

    # Leave every group (a group never ends up without an admin); direct chats stay so the other
    # person keeps their history and their shared expenses
    left_groups: list[tuple[uuid.UUID, list[str]]] = []
    for member, conv in (await db.execute(
        select(ConversationMember, Conversation)
        .join(Conversation, Conversation.id == ConversationMember.conversation_id)
        .where(ConversationMember.user_id == uid, Conversation.kind == "group")
    )).all():
        await db.delete(member)
        await db.flush()
        remaining = list((await db.execute(
            select(ConversationMember).where(ConversationMember.conversation_id == conv.id).order_by(ConversationMember.joined_at)
        )).scalars().all())
        if not remaining:
            await db.delete(conv)
            continue
        if not any(m.role == MemberRole.ADMIN for m in remaining):
            remaining[0].role = MemberRole.ADMIN
        left_groups.append((conv.id, [str(m.user_id) for m in remaining]))

    # What they wrote: kept as "deleted" so replies and the timeline still make sense
    now = datetime.now(timezone.utc)
    await db.execute(
        update(Message).where(Message.sender_id == uid).values(
            is_deleted=True, text="", media_url=None, media_thumbnail=None, media_filename=None,
            media_size=None, media_duration=None, media_width=None, media_height=None, updated_at=now,
        )
    )
    for model, column in (
        (MessageReaction, MessageReaction.user_id), (MessageReceipt, MessageReceipt.user_id),
        (AuthSession, AuthSession.user_id), (DeviceToken, DeviceToken.user_id),
        (E2EBackup, E2EBackup.user_id), (E2EDeviceList, E2EDeviceList.user_id), (E2EDevice, E2EDevice.user_id),
        (E2ELinkRequest, E2ELinkRequest.user_id), (E2ESignedPreKey, E2ESignedPreKey.user_id),
        (E2EOneTimePreKey, E2EOneTimePreKey.user_id), (KeyLinkRequest, KeyLinkRequest.user_id),
        (PreviousUserKeys, PreviousUserKeys.user_id), (UserKeys, UserKeys.user_id),
        (UserAISettings, UserAISettings.user_id), (StoreDiscountRule, StoreDiscountRule.owner_id),
        (AccountNotice, AccountNotice.user_id), (SupportTicket, SupportTicket.user_id),
    ):
        await db.execute(delete(model).where(column == uid))
    await db.execute(delete(E2EEnvelope).where(or_(E2EEnvelope.sender_user_id == uid, E2EEnvelope.recipient_user_id == uid)))
    await db.execute(delete(UserBlock).where(or_(UserBlock.blocker_id == uid, UserBlock.blocked_id == uid)))

    # The row stays for shared expenses; nothing personal is left in it. The email is freed so
    # the person can sign up again with it.
    tag = uid.hex[:10]
    user.username = f"deleted_{tag}"
    user.email = f"deleted-{tag}@deleted.invalid"
    user.name = DELETED_NAME
    user.hashed_password = hash_password(secrets.token_urlsafe(32))
    for field in ("phone", "date_of_birth", "address", "bio", "avatar", "payment_handles", "display_currency",
                  "google_id", "facebook_id", "email_code_hash", "email_code_expires", "email_code_sent_at",
                  "reset_token", "reset_token_expires"):
        setattr(user, field, None)
    user.is_active = False
    user.email_verified = False
    user.deleted_at = now
    await db.commit()
    logger.info("Account %s deleted", uid)
    return {"files": files, "left_groups": left_groups, "old_name": old_name}


async def unused_files(db: AsyncSession, urls: set[str]) -> set[str]:
    """The files nobody else still uses (a forwarded photo can be shared by several messages)."""
    from app.models.conversation import Conversation as Conv
    keep = set()
    for url in urls:
        used = (await db.execute(
            select(Message.id).where(or_(Message.media_url == url, Message.media_thumbnail == url)).limit(1)
        )).scalar_one_or_none() or (await db.execute(
            select(Receipt.id).where(Receipt.image_urls.any(url)).limit(1)
        )).scalar_one_or_none() or (await db.execute(
            select(Conv.id).where(Conv.avatar_url == url).limit(1)
        )).scalar_one_or_none()
        if used is None:
            keep.add(url)
    return keep


def remove_files(urls: set[str]) -> None:
    """Best effort: a file that's already gone is fine."""
    for url in urls:
        key = media_storage.key_from_url(url)
        path = media_storage.path_for_key(key) if key else None
        if path is None:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Couldn't remove a deleted account's file %s", key)
