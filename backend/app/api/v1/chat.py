# backend/app/api/v1/chat.py 

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_, func
from sqlalchemy.orm import aliased
from typing import Optional
from uuid import UUID

from app.db.session import get_db
from app.models.user import User
# from app.models.conversation import Conversation, ConversationMember

from app.models.conversation import Conversation
from app.models.conversation_member import ConversationMember

from app.models.message import Message
from app.api.dependencies import get_current_user
from app.core import rate_limit as rl
from app.services import safety
from app.services.chat_service import ChatService
from app.services.message_service import MessageService
from app.services import media_storage
from app.websocket.routes import publish_delivered, publish_users
import logging

logger = logging.getLogger(__name__)

from app.api.v1.groups import muted_until_view  # noqa: E402
from app.schemas.chat import (
    CreateConversationRequest,
)

router = APIRouter()

MIN_USER_SEARCH_LENGTH = 2
USER_SEARCH_LIMIT = 20
USER_LIST_LIMIT = 50


@router.get("/conversations")
async def get_conversations(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get all conversations for the current user.
    Uses a fixed number of queries (not one batch per conversation).
    """
    try:
        # 1. My memberships + conversations, most recently active first
        rows = (await db.execute(
            select(Conversation, ConversationMember)
            .join(ConversationMember, ConversationMember.conversation_id == Conversation.id)
            .where(ConversationMember.user_id == current_user.id)
            .order_by(Conversation.updated_at.desc())
        )).all()
        if not rows:
            return {"success": True, "data": [], "message": "Conversations fetched successfully"}

        conversation_ids = [conv.id for conv, _ in rows]

        # 2. Members of all those conversations
        member_ids: dict[UUID, list[str]] = {cid: [] for cid in conversation_ids}
        for conv_id, user_id in (await db.execute(
            select(ConversationMember.conversation_id, ConversationMember.user_id)
            .where(ConversationMember.conversation_id.in_(conversation_ids))
        )).all():
            member_ids[conv_id].append(str(user_id))

        # 3. Latest message per conversation (Postgres DISTINCT ON)
        last_messages = {
            msg.conversation_id: msg
            for msg in (await db.execute(
                select(Message)
                .where(Message.conversation_id.in_(conversation_ids))
                .distinct(Message.conversation_id)
                .order_by(Message.conversation_id, Message.created_at.desc(), Message.id.desc())
            )).scalars().all()
        }

        # 4. Unread counts: messages from others newer than my read pointer
        #    (no read pointer yet = everything from others is unread)
        last_read = aliased(Message)
        unread_counts = dict((await db.execute(
            select(Message.conversation_id, func.count(Message.id))
            .join(
                ConversationMember,
                and_(
                    ConversationMember.conversation_id == Message.conversation_id,
                    ConversationMember.user_id == current_user.id,
                ),
            )
            .outerjoin(last_read, last_read.id == ConversationMember.last_read_message_id)
            .where(
                Message.conversation_id.in_(conversation_ids),
                Message.sender_id != current_user.id,
                or_(last_read.id.is_(None), Message.created_at > last_read.created_at),
            )
            .group_by(Message.conversation_id)
        )).all())

        # 5. The other person in each DM (for name and avatar)
        dm_partner_ids = {
            UUID(uid)
            for conv, _ in rows if conv.kind == "dm"
            for uid in member_ids[conv.id] if uid != str(current_user.id)
        }
        partners = {}
        if dm_partner_ids:
            partners = {
                str(u.id): u
                for u in (await db.execute(select(User).where(User.id.in_(dm_partner_ids)))).scalars().all()
            }

        # Fetching the list means everything in it reached this device: senders see two ticks
        newly_delivered = []
        for conv, my_membership in rows:
            latest = last_messages.get(conv.id)
            if latest is not None and latest.sender_id != current_user.id and (
                my_membership.last_delivered_at is None or my_membership.last_delivered_at < latest.created_at
            ):
                newly_delivered.append((conv.id, latest.created_at))

        # People I've blocked: their direct chat shows "You blocked this person" instead of a composer
        my_blocks = await safety.blocked_by(db, current_user.id)

        response_data = []
        for conv, my_membership in rows:
            other_user = None
            if conv.kind == "dm":
                other_id = next((uid for uid in member_ids[conv.id] if uid != str(current_user.id)), None)
                other_user = partners.get(other_id)

            last_message = last_messages.get(conv.id)
            response_data.append({
                "id": str(conv.id),
                "name": (other_user.name or other_user.username) if other_user else (conv.title or "Unknown"),
                "avatar": media_storage.sign_url(other_user.avatar if other_user else conv.avatar_url),
                "lastMessage": MessageService.preview_text(last_message) if last_message else "",
                "lastMessageTime": last_message.created_at.isoformat() if last_message else None,
                "lastMessageSenderId": str(last_message.sender_id) if last_message else None,
                "lastMessageType": last_message.message_type.value if last_message else None,
                "unreadCount": unread_counts.get(conv.id, 0),
                "isOnline": False,  # Will be updated by frontend based on online users
                "isGroup": conv.kind == "group",
                "members": member_ids[conv.id],
                "isPinned": my_membership.pinned_at is not None,
                "pinnedAt": my_membership.pinned_at.isoformat() if my_membership.pinned_at else None,
                "mutedUntil": muted_until_view(my_membership),
                "isArchived": my_membership.archived_at is not None,
                "isBlocked": bool(other_user and other_user.id in my_blocks),
                "otherUserId": str(other_user.id) if other_user else None,
                "isTyping": False,
            })

        if newly_delivered:
            everyone_has = await ChatService.mark_all_delivered(db, current_user.id, [cid for cid, _ in newly_delivered])
            for conv_id, (up_to, member_ids) in everyone_has.items():
                await publish_users(member_ids, {"type": "delivered", "roomId": str(conv_id), "deliveredUpTo": up_to.isoformat()})

        return {
            "success": True,
            "data": response_data,
            "message": "Conversations fetched successfully"
        }

    except Exception:
        # Logged by CatchUnhandledErrors; clients get a generic error, not internals
        raise


# GET /api/v1/conversations/:id/messages - Get messages
@router.get("/conversations/{conversation_id}/messages")
async def get_messages(
    conversation_id: UUID,
    limit: int = Query(50, ge=1, le=100),
    before: Optional[UUID] = Query(None, description="Return messages older than this message id"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get the newest `limit` messages (or the ones older than `before`),
    returned oldest-first. `has_more` tells whether older messages exist.
    """
    try:
        # Verify user is member
        member_stmt = (
            select(ConversationMember)
            .where(
                and_(
                    ConversationMember.conversation_id == conversation_id,
                    ConversationMember.user_id == current_user.id
                )
            )
        )
        member_result = await db.execute(member_stmt)
        member = member_result.scalar_one_or_none()

        if not member:
            raise HTTPException(
                status_code=403,
                detail="Not a member of this conversation"
            )

        # Newest first, then reversed for display
        stmt = (
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc(), Message.id.desc())
            .limit(limit + 1)
        )
        if before is not None:
            cursor = (await db.execute(
                select(Message.created_at).where(
                    Message.id == before,
                    Message.conversation_id == conversation_id,
                )
            )).scalar_one_or_none()
            if cursor is None:
                raise HTTPException(status_code=404, detail="Cursor message not found")
            stmt = stmt.where(Message.created_at < cursor)

        result = await db.execute(stmt)
        messages = list(result.scalars().all())
        has_more = len(messages) > limit
        messages = list(reversed(messages[:limit]))

        # Load all senders in one query
        sender_ids = {msg.sender_id for msg in messages}
        senders = {}
        if sender_ids:
            senders_result = await db.execute(select(User).where(User.id.in_(sender_ids)))
            senders = {u.id: u for u in senders_result.scalars().all()}

        # Opening a chat also means its messages reached this device
        newest_from_others = max((m.created_at for m in messages if m.sender_id != current_user.id), default=None)
        if newest_from_others and await ChatService.mark_delivered(db, current_user.id, conversation_id, newest_from_others):
            await publish_delivered(db, conversation_id)
        read_up_to = await ChatService.read_up_to(db, conversation_id)
        reached = await ChatService.reached_by_member(db, conversation_id)
        replies = await MessageService.reply_previews(db, {m.reply_to_id for m in messages if m.reply_to_id})
        reactions = await MessageService.reactions_for(db, [m.id for m in messages])

        response_data = []
        for msg in messages:
            sender = senders.get(msg.sender_id)
            is_read = read_up_to is not None and msg.created_at <= read_up_to
            # Two ticks once it reached every other member's devices
            is_delivered = all(t is not None and t >= msg.created_at for uid, t in reached.items() if uid != msg.sender_id)

            msg_data = {
                "id": str(msg.id),
                "conversation_id": str(msg.conversation_id),
                "sender_id": str(msg.sender_id),
                "text": msg.text,
                "message_type": msg.message_type.value,
                "is_deleted": msg.is_deleted,
                "edited_at": msg.updated_at.isoformat() if msg.updated_at and not msg.is_deleted else None,
                "reply_to": replies.get(msg.reply_to_id) if msg.reply_to_id else None,
                "reactions": reactions.get(msg.id, []),
                "media_type": msg.message_type.value if msg.media_url else None,
                "media_url": media_storage.sign_url(msg.media_url),
                "media_thumbnail": media_storage.sign_url(msg.media_thumbnail),
                "media_width": msg.media_width,
                "media_height": msg.media_height,
                "media_duration": msg.media_duration,
                "media_size": msg.media_size,
                "media_filename": msg.media_filename,
                "expense_id": str(msg.expense_id) if msg.expense_id else None,
                "created_at": msg.created_at.isoformat(),
                "status": "read" if is_read else "delivered" if is_delivered else "sent",
                "sender": {
                    "id": str(sender.id),
                    "username": sender.username,
                    "avatar": media_storage.sign_url(sender.avatar)
                } if sender else None
            }
            response_data.append(msg_data)

        return {
            "success": True,
            "data": response_data,
            "has_more": has_more,
            "message": "Messages fetched successfully"
        }

    except HTTPException:
        raise
    except Exception:
        # Logged by CatchUnhandledErrors; clients get a generic error, not internals
        raise


# backend/app/api/v1/chat.py - ADD MARK AS READ ENDPOINT

@router.post("/conversations/{conversation_id}/mark-read")
async def mark_conversation_read(
    conversation_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Mark all messages in conversation as read up to the latest message"""
    try:
        # Verify user is member
        member_stmt = select(ConversationMember).where(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id == current_user.id
        )
        member_result = await db.execute(member_stmt)
        member = member_result.scalar_one_or_none()

        if not member:
            raise HTTPException(status_code=403, detail="Not a member of this conversation")

        latest_message = await ChatService.mark_read(db, current_user.id, conversation_id)

        if latest_message:
            logger.debug("User %s marked %s as read", current_user.id, conversation_id)

            # Let the other members update their read ticks
            member_ids = [str(uid) for uid in (await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == conversation_id
                )
            )).scalars().all()]
            read_up_to = await ChatService.read_up_to(db, conversation_id)
            await publish_users(member_ids, {
                "type": "read",
                "roomId": str(conversation_id),
                "userId": str(current_user.id),
                "lastMessageId": str(latest_message.id),
                "readUpTo": read_up_to.isoformat() if read_up_to else None,
            })

            return {
                "success": True,
                "message": "Conversation marked as read",
                "last_read_message_id": str(latest_message.id)
            }
        else:
            return {
                "success": True,
                "message": "No messages to mark as read"
            }

    except HTTPException:
        raise
    except Exception:
        await db.rollback()
        # Logged by CatchUnhandledErrors; clients get a generic error, not internals
        raise


# POST /api/v1/conversations - Create new conversation
@router.post("/conversations")
async def create_conversation(
    request: CreateConversationRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a new conversation (DM or group)"""
    await rl.enforce((rl.NEW_CHATS_PER_USER, str(current_user.id)))
    try:
        # Validate kind
        if request.kind not in ['dm', 'group']:
            raise HTTPException(
                status_code=400,
                detail="Kind must be 'dm' or 'group'"
            )

        # For DM, check if conversation already exists
        if request.kind == 'dm':
            if len(request.participant_ids) != 1:
                raise HTTPException(
                    status_code=400,
                    detail="DM must have exactly 1 other participant"
                )

            other_user_id = UUID(request.participant_ids[0])

            # Check if DM already exists between these two users
            # This is a bit complex - we need to find conversations where
            # both users are members and it's a DM
            stmt = (
                select(Conversation.id)
                .join(ConversationMember)
                .where(
                    and_(
                        Conversation.kind == 'dm',
                        ConversationMember.user_id.in_([current_user.id, other_user_id])
                    )
                )
                .group_by(Conversation.id)
                .having(func.count(ConversationMember.user_id) == 2)
            )
            result = await db.execute(stmt)
            existing_conv_id = result.scalar_one_or_none()

            if existing_conv_id:
                return {
                    "success": True,
                    "data": {"id": str(existing_conv_id)},
                    "message": "Conversation already exists"
                }
            if await safety.is_blocked_either_way(db, current_user.id, other_user_id):
                raise HTTPException(status_code=403, detail="You can't start a chat with this person")

        # Create new conversation
        if request.kind == 'group':
            if not (request.title or '').strip():
                raise HTTPException(status_code=400, detail="Group name is required")
            if request.avatar_url and not media_storage.is_stored_image_url(request.avatar_url):
                raise HTTPException(status_code=400, detail="Group photo must be an uploaded image")

        new_conv = Conversation(
            kind=request.kind,
            title=request.title.strip() if request.title else None,
            description=((request.description or '').strip() or None) if request.kind == 'group' else None,
            avatar_url=(media_storage.unsigned(request.avatar_url) or '') if request.kind == 'group' else '',
            created_by=current_user.id,
        )
        db.add(new_conv)
        await db.flush()

        from app.models.conversation_member import MemberRole

        # Add current user as member
        member = ConversationMember(
            conversation_id=new_conv.id,
            user_id=current_user.id,
            role=MemberRole.ADMIN
        )
        db.add(member)

        # Add other participants (skip the creator and duplicates)
        participant_uuids = list(dict.fromkeys(
            UUID(pid) for pid in request.participant_ids if UUID(pid) != current_user.id
        ))
        if request.kind == 'group' and await safety.who_blocked(db, current_user.id, participant_uuids):
            await db.rollback()
            raise HTTPException(status_code=403, detail="Some of these people can't be added to a group by you")
        for participant_uuid in participant_uuids:
            member = ConversationMember(
                conversation_id=new_conv.id,
                user_id=participant_uuid,
                role=MemberRole.MEMBER
            )
            db.add(member)

        await db.commit()
        await db.refresh(new_conv)

        # Tell every member (including the creator's other tabs) so it shows up in their chat list
        await publish_users(
            [str(current_user.id)] + [str(u) for u in participant_uuids],
            {
                "type": "conversation_created",
                "conversationId": str(new_conv.id),
                "kind": new_conv.kind,
                "title": new_conv.title,
                "createdBy": str(current_user.id),
                "createdByName": current_user.username,
                "memberCount": len(participant_uuids) + 1,
            },
        )

        # Get other user info for DM
        other_user = None
        if new_conv.kind == 'dm':
            other_user_id = UUID(request.participant_ids[0])
            user_stmt = select(User).where(User.id == other_user_id)
            user_result = await db.execute(user_stmt)
            other_user_obj = user_result.scalar_one_or_none()
            if other_user_obj:
                other_user = {
                    "id": str(other_user_obj.id),
                    "username": other_user_obj.username,
                    "avatar": media_storage.sign_url(other_user_obj.avatar)
                }

        return {
            "success": True,
            "data": {
                "id": str(new_conv.id),
                "kind": new_conv.kind,
                "title": new_conv.title,
                "created_at": new_conv.created_at.isoformat(),
                "other_user": other_user
            },
            "message": "Conversation created successfully"
        }

    except HTTPException:
        raise
    except Exception:
        await db.rollback()
        # Logged by CatchUnhandledErrors; clients get a generic error, not internals
        raise


# GET /api/v1/users - List users
@router.get("/users")
async def get_users(
    search: Optional[str] = Query(None, max_length=100),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Find people to chat with.
    - With `search` (2+ characters): match on username or display name, or an exact email.
    - Without `search`: people you already share a conversation with.
    Emails are never returned, so this can't be used to collect them.
    """
    if search:
        await rl.enforce((rl.USER_SEARCH_PER_USER, str(current_user.id)))
    try:
        query = (search or "").strip()
        stmt = select(User).where(User.id != current_user.id, User.is_active.is_(True))

        if query:
            if len(query) < MIN_USER_SEARCH_LENGTH:
                return {"success": True, "data": [], "message": "Type at least 2 characters to search"}
            pattern = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            stmt = stmt.where(
                or_(
                    User.username.ilike(pattern, escape="\\"),
                    User.name.ilike(pattern, escape="\\"),
                    func.lower(User.email) == query.lower(),
                )
            ).order_by(func.length(User.username), User.username).limit(USER_SEARCH_LIMIT)
        else:
            my_conversations = select(ConversationMember.conversation_id).where(
                ConversationMember.user_id == current_user.id
            )
            contacts = select(ConversationMember.user_id).where(
                ConversationMember.conversation_id.in_(my_conversations)
            )
            stmt = stmt.where(User.id.in_(contacts)).order_by(User.username).limit(USER_LIST_LIMIT)

        users = (await db.execute(stmt)).scalars().all()

        response_data = [
            {
                "id": str(user.id),
                "username": user.username,
                "name": user.name or user.username,
                "avatar": media_storage.sign_url(user.avatar),
            }
            for user in users
        ]

        return {
            "success": True,
            "data": response_data,
            "message": "Users fetched successfully"
        }

    except Exception:
        # Logged by CatchUnhandledErrors; clients get a generic error, not internals
        raise