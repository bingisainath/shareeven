# backend/app/websocket/routes.py

import json
import uuid
import asyncio
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.db.session import async_session_maker
from app.websocket.manager import ENVELOPE_FIRST_PROTO, LEGACY_KEY, WSManager
from app.websocket.auth import get_token_from_ws, verify_ws_token
from app.websocket.pubsub import PubSub
from app.websocket.streams import RedisStreams
from app.models.message import Message
from app.models.conversation_member import ConversationMember
from app.models.user import User
from app.services.chat_service import ChatService
from app.services.message_service import MessageService
from app.services import media_storage
from app.services import e2e_mailbox
from app.core import rate_limit
from app.services import safety

router = APIRouter(prefix="/ws", tags=["WebSocket"])

logger = logging.getLogger(__name__)

# Initialize services
manager = WSManager()
pubsub = PubSub()
streams = RedisStreams()

# user_id -> number of open sockets (across all tabs/devices)
PRESENCE_KEY = "papyris:presence"
LEGACY_ONLINE_SET_KEY = "papyris:online_users"

MAX_TEXT_LENGTH = 5000
# Sent back when an app tries to send a message that isn't end-to-end encrypted
NOT_ENCRYPTED = ("This chat isn't end-to-end encrypted yet, so messages can't be sent in it. "
                 "Everyone in it needs to open the latest version of ShareEven once.")
# An encrypted envelope carries the sealed key for every member plus base64 overhead
MAX_ENCRYPTED_LENGTH = 200_000

# How long a read receipt waits for the worker to persist the message it refers to
READ_WAIT_ATTEMPTS = 15
READ_WAIT_SECONDS = 0.2

# Keeps references to fire-and-forget tasks so they aren't garbage collected
_background_tasks: set[asyncio.Task] = set()


async def publish_room(room_id: str, payload: dict):
    """Publish event to a room via Redis Pub/Sub"""
    await pubsub.publish({"roomId": room_id, "payload": payload})


async def publish_users(user_ids: list[str], payload: dict):
    """Publish event to every socket of the given users, on any backend instance"""
    await pubsub.publish({"userIds": user_ids, "payload": payload})


async def publish_message_v2(member_ids: list[str], rows: list, meta: dict, client_id: str | None):
    """Announce a new encrypted (v2) message: `meta` holds its details, `rows` the queued packets."""
    # Older apps: the marker row first, then the packets (the order they were built for)
    await publish_users(member_ids, {
        "type": "message", "clientId": client_id, "text": media_storage.V2_MARKER, "status": "sent",
        **meta, LEGACY_KEY: True,
    })
    # Every device shows the message once it has decrypted its own packet (like Signal)
    for uid, event in e2e_mailbox.events(rows, meta):
        await publish_users([uid], event)
    # The sending device (any of its tabs) links its copy to the timeline row
    await publish_users([meta["senderId"]], {
        "type": "message_sent", "roomId": meta["roomId"], "clientId": client_id, "messageId": meta["messageId"],
        "timestamp": meta["timestamp"], "fromDevice": meta["fromDevice"], "status": "sent",
    })


async def publish_global(payload: dict):
    """Publish event to every connected user"""
    await pubsub.publish({"roomId": "__global__", "payload": payload})


async def on_redis_event(evt: dict):
    """Handle events from Redis Pub/Sub"""
    room_id = evt.get("roomId")
    user_ids = evt.get("userIds")
    payload = evt.get("payload")

    if not payload:
        return

    if user_ids is not None:
        for user_id in user_ids:
            await manager.send_user(user_id, payload)
    elif room_id == "__global__":
        # Broadcast to ALL connected users
        for user_id, ws_set in list(manager.user_sockets.items()):
            for ws in list(ws_set):
                try:
                    await ws.send_json(payload)
                except Exception as e:
                    logger.debug("Failed to send global event to %s: %s", user_id, e)
    elif room_id:
        # Regular room broadcast
        await manager.broadcast_room(room_id, payload)


@router.on_event("startup")
async def _ws_start():
    """Initialize Redis Streams and start Pub/Sub listener"""
    await streams.init_stream()
    # Sockets don't survive a restart, so start presence from scratch.
    # NOTE: assumes a single backend instance; with several, track presence per instance.
    await pubsub.redis.delete(PRESENCE_KEY, LEGACY_ONLINE_SET_KEY)
    pubsub.start(on_redis_event)
    logger.info("WebSocket services started")


@router.on_event("shutdown")
async def _ws_stop():
    """Cleanup on shutdown"""
    await pubsub.stop()
    await streams.close()
    logger.info("WebSocket services stopped")


@router.websocket("/chat")
async def ws_chat(ws: WebSocket):
    """Main WebSocket endpoint for chat functionality"""

    # 1. Authenticate
    token = get_token_from_ws(ws)
    if not token:
        logger.info("WebSocket rejected: missing token")
        await ws.close(code=1008, reason="Missing token")
        return

    try:
        user_id_str = verify_ws_token(token)
        user_id = uuid.UUID(user_id_str)
    except Exception:
        logger.info("WebSocket rejected: invalid or expired token")
        await ws.close(code=1008, reason="Invalid token")
        return
    # A sign-in that was logged out (here or from another device) can't connect
    async with async_session_maker() as db:
        from app.services import sessions
        from jose import jwt as _jwt
        sid = _jwt.get_unverified_claims(token).get("sid")  # signature already checked above
        if not await sessions.is_active(db, sid, user_id):
            logger.info("WebSocket rejected: signed out session")
            await ws.close(code=1008, reason="Signed out")
            return
        account = await db.get(User, user_id)
        if account is None or account.suspended_now():
            logger.info("WebSocket rejected: suspended account")
            await ws.close(code=1008, reason="Suspended")
            return

    # 2. Accept connection and track presence
    try:
        proto = int(ws.query_params.get("proto") or 0)
    except ValueError:
        proto = 0
    await manager.accept(ws)
    manager.track_user(user_id_str, ws, proto)

    socket_count = await pubsub.redis.hincrby(PRESENCE_KEY, user_id_str, 1)
    if socket_count == 1:
        await publish_global({"type": "online", "userId": user_id_str})

    # Tell this client who is already online
    online_user_ids = await pubsub.redis.hkeys(PRESENCE_KEY)
    await ws.send_json({"type": "presence", "userIds": online_user_ids})

    logger.info("User %s connected (%d socket(s))", user_id_str, socket_count)

    try:
        while True:
            raw = await ws.receive_text()
            data = json.loads(raw)

            event_type = data.get("type")
            room_id = data.get("roomId")

            logger.debug("User %s sent %s for %s", user_id_str, event_type, room_id)

            # JOIN ROOM
            if event_type == "join" and room_id:
                async with async_session_maker() as db:
                    is_member = await _check_membership(db, user_id, room_id)

                    if not is_member:
                        logger.warning("User %s tried to join %s without being a member", user_id_str, room_id)
                        await ws.send_json({
                            "type": "error",
                            "message": "Not a member of this conversation"
                        })
                        continue

                manager.join_room(room_id, ws)
                await ws.send_json({"type": "joined", "roomId": room_id})
                logger.debug("User %s joined room %s", user_id_str, room_id)
                continue

            # LEAVE ROOM
            if event_type == "leave" and room_id:
                manager.room_sockets.get(room_id, set()).discard(ws)
                await ws.send_json({"type": "left", "roomId": room_id})
                logger.debug("User %s left room %s", user_id_str, room_id)
                continue

            # Too many messages in a few seconds (a script or a stuck client): refuse this one;
            # the app marks it as not sent and the person can retry
            if event_type in ("message", "message_v2") and room_id:
                if await rate_limit.check(rate_limit.MESSAGES_PER_USER, user_id_str):
                    await ws.send_json({"type": "error", "message": rate_limit.MESSAGES_PER_USER.message,
                                        "clientId": data.get("clientId"), "roomId": room_id})
                    continue
                # A block stops direct messages both ways
                try:
                    async with async_session_maker() as db:
                        # Suspended while connected: nothing more gets sent
                        account = await db.get(User, user_id)
                        if account is None or account.suspended_now():
                            await ws.close(code=1008, reason="Suspended")
                            break
                        refusal = await safety.direct_message_refusal(db, uuid.UUID(room_id), user_id)
                except ValueError:
                    refusal = None
                if refusal:
                    await ws.send_json({"type": "error", "message": refusal, "clientId": data.get("clientId"), "roomId": room_id})
                    continue

            # SEND MESSAGE (text and/or media)
            if event_type == "message" and room_id:
                client_id = data.get("clientId")

                async def reject(reason: str):
                    await ws.send_json({
                        "type": "error",
                        "message": reason,
                        "clientId": client_id,
                        "roomId": room_id,
                    })

                text = (data.get("text") or "").strip()
                media_url = data.get("mediaUrl") or None
                media_type = data.get("mediaType") or None

                encrypted = media_storage.is_encrypted(text)
                if len(text) > (MAX_ENCRYPTED_LENGTH if encrypted else MAX_TEXT_LENGTH):
                    await reject(f"Message too long (max {MAX_TEXT_LENGTH} characters)")
                    continue

                if media_url:
                    if media_type not in media_storage.MEDIA_TYPES:
                        await reject("Invalid media type")
                        continue
                    if not media_storage.is_stored_media_url(media_url):
                        await reject("Media not found. Upload the file first.")
                        continue
                else:
                    media_type = None

                if not text and not media_url:
                    await reject("Empty message")
                    continue
                # Everything people send is end-to-end encrypted: never store a readable message, even
                # from an old app or a chat where someone hasn't set up encryption yet
                if not encrypted:
                    await reject(NOT_ENCRYPTED)
                    continue

                media_size = data.get("mediaSize") if isinstance(data.get("mediaSize"), int) else None
                media_filename = (str(data.get("mediaFilename") or "")[:255] or None) if media_url else None
                media_width = _dimension(data.get("mediaWidth")) if media_type in ("image", "video") else None
                media_height = _dimension(data.get("mediaHeight")) if media_type in ("image", "video") else None
                if not (media_width and media_height):
                    media_width = media_height = None

                # Optional poster frame for videos (an uploaded image)
                duration = data.get("mediaDuration")
                media_duration = int(duration) if isinstance(duration, (int, float)) and media_type in ("audio", "video") and 0 < duration <= 36000 else None
                media_thumbnail = data.get("mediaThumbnail") or None
                # (encrypted posters are opaque uploads; the server can't check they're images)
                thumbnail_ok = bool(media_thumbnail) and (
                    media_storage.is_stored_media_url(media_thumbnail) if encrypted else media_storage.is_stored_image_url(media_thumbnail)
                )
                if media_thumbnail and (media_type != "video" or not thumbnail_ok):
                    media_thumbnail = None
                if encrypted:
                    # Size, name and dimensions travel inside the envelope; don't store them in the clear
                    media_size = media_filename = media_width = media_height = media_duration = None
                has_link = encrypted and data.get("hasLink") is True

                # Store plain URLs; every response signs them for the people who may see them
                media_url = media_storage.unsigned(media_url)
                media_thumbnail = media_storage.unsigned(media_thumbnail)

                async with async_session_maker() as db:
                    is_member = await _check_membership(db, user_id, room_id)

                    if not is_member:
                        logger.warning("User %s tried to send to %s without being a member", user_id_str, room_id)
                        await reject("Not a member of this conversation")
                        continue

                    # Get all conversation members
                    members_stmt = select(ConversationMember.user_id).where(
                        ConversationMember.conversation_id == uuid.UUID(room_id)
                    )
                    members_result = await db.execute(members_stmt)
                    member_ids = [str(m) for m in members_result.scalars().all()]

                    # Get sender info
                    sender = await db.get(User, user_id)
                    sender_name = sender.username if sender else "Unknown"
                    sender_avatar = sender.avatar if sender else None

                    # Reply: the original must be in this conversation (it may still be persisting)
                    reply_to = None
                    reply_to_id = data.get("replyToId")
                    if reply_to_id:
                        try:
                            original = await MessageService.get_message(db, uuid.UUID(reply_to_id), wait_seconds=2)
                        except ValueError:
                            original = None
                        if original is None or str(original.conversation_id) != room_id:
                            await reject("The message you replied to was not found")
                            continue
                        original_sender = await db.get(User, original.sender_id)
                        reply_to = {
                            "id": str(original.id),
                            "text": MessageService.preview_text(original),
                            "senderId": str(original.sender_id),
                            "senderName": original_sender.username if original_sender else None,
                            "messageType": original.message_type.value,
                            "isDeleted": original.is_deleted,
                        }

                msg_id = str(uuid.uuid4())
                timestamp = datetime.now(timezone.utc).isoformat()

                # Persist through the worker (same timestamp, so ordering matches the DB)
                await streams.add_message({
                    "messageId": msg_id,
                    "conversationId": room_id,
                    "senderId": user_id_str,
                    "senderName": sender_name,  # for the push notification
                    "text": text,
                    "mediaType": media_type,
                    "mediaUrl": media_url,
                    "mediaSize": media_size,
                    "mediaFilename": media_filename,
                    "mediaThumbnail": media_thumbnail,
                    "mediaWidth": media_width,
                    "mediaHeight": media_height,
                    "mediaDuration": media_duration,
                    "hasLink": has_link,
                    "replyToId": reply_to["id"] if reply_to else None,
                    "timestamp": timestamp,
                })

                payload = {
                    "type": "message",
                    "roomId": room_id,
                    "messageId": msg_id,
                    "clientId": client_id,
                    "senderId": user_id_str,
                    "senderName": sender_name,
                    "senderAvatar": media_storage.sign_url(sender_avatar),
                    "text": text,
                    "messageType": media_type or "text",
                    "mediaType": media_type,
                    "mediaUrl": media_storage.sign_url(media_url),
                    "mediaThumbnail": media_storage.sign_url(media_thumbnail),
                    "mediaWidth": media_width,
                    "mediaHeight": media_height,
                    "mediaDuration": media_duration,
                    "mediaSize": media_size,
                    "mediaFilename": media_filename,
                    "replyTo": reply_to,
                    "timestamp": timestamp,
                    "status": "sent"
                }

                await publish_users(member_ids, payload)
                logger.debug("Message %s published to %d members", msg_id, len(member_ids))
                continue

            # SEND MESSAGE, end-to-end encryption v2 (docs/encryption-design-v2.md). The content is in
            # per-device packets the server can't read; the timeline row only records that a message
            # of this kind was sent, and when (ordering, unread counts, replies, push "New message").
            if event_type == "message_v2" and room_id:
                client_id = data.get("clientId")

                async def reject_v2(reason: str, **details):
                    await ws.send_json({"type": "error", "message": reason, "clientId": client_id, "roomId": room_id, **details})

                message_type = data.get("messageType") or "text"
                attachments = [a for a in (data.get("attachments") or []) if isinstance(a, str)][:2]
                from_device = data.get("fromDevice")
                raw = data.get("envelopes")
                if message_type not in ("text", "image", "video", "audio", "file") or not isinstance(from_device, int) or not isinstance(raw, list):
                    await reject_v2("Invalid message")
                    continue
                attachments = [media_storage.unsigned(a) for a in attachments]
                if any(not media_storage.is_stored_media_url(a) or not a.endswith(media_storage.ENCRYPTED_EXTENSION) for a in attachments):
                    await reject_v2("Media not found. Upload the file first.")
                    continue
                if message_type != "text" and not attachments:
                    await reject_v2("Media message without a file")
                    continue
                try:
                    outgoing = [e2e_mailbox.Outgoing(uuid.UUID(e["to_user"]), int(e["to_device"]), e["packet"]) for e in raw if isinstance(e.get("packet"), dict)]
                    conv_uuid = uuid.UUID(room_id)
                except (KeyError, ValueError, TypeError, AttributeError):
                    await reject_v2("Invalid envelopes")
                    continue

                msg_id = str(uuid.uuid4())
                timestamp = datetime.now(timezone.utc).isoformat()
                async with async_session_maker() as db:
                    try:
                        # Apps on protocol 3 refresh device lists and resend when one is missing
                        rows = await e2e_mailbox.queue(db, user_id, conv_uuid, from_device, outgoing, uuid.UUID(msg_id),
                                                       complete=manager.proto(ws) >= ENVELOPE_FIRST_PROTO)
                    except e2e_mailbox.DevicesChanged as e:
                        await reject_v2(e.detail, **e.details())
                        continue
                    except e2e_mailbox.MailboxError as e:
                        await reject_v2(e.detail)
                        continue
                    reply_to = None
                    reply_to_id = data.get("replyToId")
                    if reply_to_id:
                        try:
                            original = await MessageService.get_message(db, uuid.UUID(reply_to_id), wait_seconds=2)
                        except ValueError:
                            original = None
                        if original is None or str(original.conversation_id) != room_id:
                            await reject_v2("The message you replied to was not found")
                            continue
                        original_sender = await db.get(User, original.sender_id)
                        reply_to = {
                            "id": str(original.id), "text": MessageService.preview_text(original), "senderId": str(original.sender_id),
                            "senderName": original_sender.username if original_sender else None,
                            "messageType": original.message_type.value, "isDeleted": original.is_deleted,
                        }
                    await db.commit()
                    member_ids = await MessageService.member_ids(db, conv_uuid)
                    sender = await db.get(User, user_id)

                media_type = message_type if message_type != "text" else None
                thumbnail = attachments[1] if media_type == "video" and len(attachments) > 1 else None
                await streams.add_message({
                    "messageId": msg_id, "conversationId": room_id, "senderId": user_id_str,
                    "senderName": sender.username if sender else "Unknown",
                    "text": media_storage.V2_MARKER, "mediaType": media_type, "mediaUrl": attachments[0] if attachments else None,
                    "mediaThumbnail": thumbnail, "hasLink": data.get("hasLink") is True,
                    "replyToId": reply_to["id"] if reply_to else None, "timestamp": timestamp,
                })
                meta = {
                    "messageId": msg_id, "roomId": room_id, "senderId": user_id_str,
                    "senderName": sender.username if sender else "Unknown",
                    "senderAvatar": media_storage.sign_url(sender.avatar if sender else None),
                    "messageType": message_type, "mediaType": media_type,
                    "mediaUrl": media_storage.sign_url(attachments[0]) if attachments else None,
                    "mediaThumbnail": media_storage.sign_url(thumbnail), "replyTo": reply_to,
                    "timestamp": timestamp, "fromDevice": from_device,
                }
                await publish_message_v2(member_ids, rows, meta, client_id)
                continue

            # TYPING INDICATOR
            if event_type == "typing" and room_id:
                is_typing = bool(data.get("isTyping", False))

                async with async_session_maker() as db:
                    is_member = await _check_membership(db, user_id, room_id)
                    if not is_member:
                        continue
                    others = [
                        uid for uid in await MessageService.member_ids(db, uuid.UUID(room_id))
                        if uid != user_id_str
                    ]
                    typist = await db.get(User, user_id)

                payload = {
                    "type": "typing",
                    "roomId": room_id,
                    "userId": user_id_str,
                    "userName": (typist.name or typist.username) if typist else None,
                    "isTyping": is_typing
                }

                # Every member (not just those with the chat open) so chat lists can show it
                await publish_users(others, payload)
                logger.debug("User %s typing=%s in %s", user_id_str, is_typing, room_id)
                continue

            # READ RECEIPT
            if event_type == "read" and room_id:
                last_msg_id = data.get("lastMessageId")

                if not last_msg_id or last_msg_id.startswith('temp-'):
                    continue

                # Runs in the background: it may wait for the worker to persist the message
                task = asyncio.create_task(_handle_read(user_id, room_id, last_msg_id))
                _background_tasks.add(task)
                task.add_done_callback(_background_tasks.discard)
                continue

            # DELIVERY RECEIPT: a message reached this device (two grey ticks for the sender)
            if event_type == "delivered" and room_id:
                last_msg_id = data.get("lastMessageId")
                if not last_msg_id or last_msg_id.startswith('temp-'):
                    continue
                task = asyncio.create_task(_handle_delivered(user_id, room_id, last_msg_id))
                _background_tasks.add(task)
                task.add_done_callback(_background_tasks.discard)
                continue

            # PING/PONG
            if event_type == "ping":
                await ws.send_json({"type": "pong"})
                continue

            logger.warning("User %s sent unknown event type %r", user_id_str, event_type)

    except WebSocketDisconnect:
        logger.debug("User %s disconnected", user_id_str)
    except Exception:
        logger.exception("WebSocket error for user %s", user_id_str)
    finally:
        manager.untrack(user_id_str, ws)

        # Only go offline when the user's last socket closes
        remaining = await pubsub.redis.hincrby(PRESENCE_KEY, user_id_str, -1)
        if remaining <= 0:
            await pubsub.redis.hdel(PRESENCE_KEY, user_id_str)
            await publish_global({"type": "offline", "userId": user_id_str})
            logger.info("User %s went offline", user_id_str)
        else:
            logger.debug("User %s closed a socket (%d still open)", user_id_str, remaining)


def _dimension(value) -> int | None:
    """A sane pixel dimension from the client, or None"""
    return value if isinstance(value, int) and 0 < value <= 20000 else None


async def _check_membership(db: AsyncSession, user_id: uuid.UUID, conversation_id: str) -> bool:
    """Check if user is a member of the conversation"""
    try:
        conv_uuid = uuid.UUID(conversation_id)
        result = await db.execute(
            select(ConversationMember).where(
                ConversationMember.conversation_id == conv_uuid,
                ConversationMember.user_id == user_id
            )
        )
        return result.scalar_one_or_none() is not None
    except Exception as e:
        logger.warning("Membership check failed for %s: %s", conversation_id, e)
        return False


async def _handle_read(user_id: uuid.UUID, conversation_id: str, last_message_id: str) -> None:
    """Mark read and tell every member (so senders can update their ticks)"""
    result = await _mark_read(user_id, conversation_id, last_message_id)
    if result is None:
        return

    member_ids, read_up_to = result
    await publish_users(member_ids, {
        "type": "read",
        "roomId": conversation_id,
        "userId": str(user_id),
        "lastMessageId": last_message_id,
        "readUpTo": read_up_to.isoformat() if read_up_to else None,
    })
    logger.debug("User %s read %s up to %s", user_id, conversation_id, last_message_id)


async def _handle_delivered(user_id: uuid.UUID, conversation_id: str, last_message_id: str) -> None:
    """Record that a message reached one of user_id's devices; tell members if everyone has it now"""
    try:
        conv_uuid = uuid.UUID(conversation_id)
        msg_uuid = uuid.UUID(last_message_id)
    except ValueError:
        return
    try:
        for _ in range(READ_WAIT_ATTEMPTS):
            async with async_session_maker() as db:
                if not await _check_membership(db, user_id, conversation_id):
                    return
                # The worker may not have persisted a just-sent message yet
                created_at = (await db.execute(
                    select(Message.created_at).where(Message.id == msg_uuid, Message.conversation_id == conv_uuid)
                )).scalar_one_or_none()
                if created_at is None:
                    await asyncio.sleep(READ_WAIT_SECONDS)
                    continue
                if await ChatService.mark_delivered(db, user_id, conv_uuid, created_at):
                    await publish_delivered(db, conv_uuid)
                return
    except Exception:
        logger.exception("Failed to mark %s as delivered", last_message_id)


async def publish_delivered(db: AsyncSession, conversation_id: uuid.UUID) -> None:
    """Tell every member how far the conversation has reached everyone's devices"""
    delivered_up_to = await ChatService.delivered_up_to(db, conversation_id)
    if delivered_up_to is None:
        return
    member_ids = [str(m) for m in (await db.execute(
        select(ConversationMember.user_id).where(ConversationMember.conversation_id == conversation_id)
    )).scalars().all()]
    await publish_users(member_ids, {
        "type": "delivered",
        "roomId": str(conversation_id),
        "deliveredUpTo": delivered_up_to.isoformat(),
    })


async def _mark_read(
    user_id: uuid.UUID,
    conversation_id: str,
    last_message_id: str,
) -> tuple[list[str], datetime | None] | None:
    """
    Mark the conversation read up to last_message_id.
    Returns (member ids, read-by-everyone-up-to timestamp), or None if nothing was marked.
    """
    try:
        conv_uuid = uuid.UUID(conversation_id)
        msg_uuid = uuid.UUID(last_message_id)
    except ValueError:
        return None

    try:
        for _ in range(READ_WAIT_ATTEMPTS):
            async with async_session_maker() as db:
                if not await _check_membership(db, user_id, conversation_id):
                    return None

                # The worker may not have persisted a just-sent message yet
                exists = (await db.execute(
                    select(Message.id).where(Message.id == msg_uuid)
                )).scalar_one_or_none()
                if exists is None:
                    await asyncio.sleep(READ_WAIT_SECONDS)
                    continue

                if await ChatService.mark_read(db, user_id, conv_uuid, msg_uuid) is None:
                    return None

                member_ids = [str(m) for m in (await db.execute(
                    select(ConversationMember.user_id).where(
                        ConversationMember.conversation_id == conv_uuid
                    )
                )).scalars().all()]
                return member_ids, await ChatService.read_up_to(db, conv_uuid)

        logger.warning("Read receipt for unknown message %s", last_message_id)
        return None
    except Exception:
        logger.exception("Failed to mark %s as read", last_message_id)
        return None
