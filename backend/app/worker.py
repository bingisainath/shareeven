# backend/app/worker.py

import asyncio
import json
import socket
import uuid
from datetime import datetime, timezone

import logging

from app.core.logging import setup_logging
from app.db.session import async_session_maker
from app.websocket.streams import RedisStreams
from app.models.conversation import Conversation
from app.models.message import Message, MessageType
from app.models.message_receipt import MessageReceipt
from app.models.conversation_member import ConversationMember
from sqlalchemy import select, update

from app.config.settings import settings
from app.services import media_storage, notices, payments, push
from app.services import safety

logger = logging.getLogger("app.worker")

# Entries a worker took but hasn't acknowledged for this long are handed to another worker (or
# retried by the same one): it crashed mid-save, or the save failed.
STALE_AFTER_MS = 60_000
RECLAIM_EVERY_SECONDS = 60
# "Your Pro ends in 7 days / tomorrow" (each sent once per end date; several workers don't double up)
PRO_REMINDERS_EVERY_SECONDS = 3600
# Paid Razorpay orders nobody confirmed (page closed, webhook lost) get Pro anyway
RECONCILE_PAYMENTS_EVERY_SECONDS = 600
# After this many tries an entry goes to the dead-letter stream instead of being retried forever
MAX_DELIVERIES = 5
# Consumer names with nothing pending that haven't been seen for a day are removed
FORGET_CONSUMERS_AFTER_MS = 24 * 3600 * 1000


class MessageWorker:
    def __init__(self):
        self.streams = RedisStreams()
        # A stable name: after a restart the worker picks up what it was given before it stopped.
        # Run several workers on one machine with WORKER_NAME=worker-1, worker-2, ...
        self.consumer_name = settings.WORKER_NAME or f"worker-{socket.gethostname()}"
        self.running = False

    async def start(self):
        """Start the worker"""
        logger.info("Starting message worker %s", self.consumer_name)
        await self.streams.init_stream()
        self.running = True
        await self.recover()
        
        try:
            await self.consume_loop()
        except KeyboardInterrupt:
            logger.info("Interrupted")
        finally:
            await self.stop()

    async def stop(self):
        """Stop the worker"""
        logger.info("Stopping message worker")
        self.running = False
        await self.streams.close()

    async def consume_loop(self):
        """Main consumption loop: new entries, plus a sweep for stuck ones every minute"""
        logger.info("Listening for messages as %s", self.consumer_name)
        loop = asyncio.get_running_loop()
        next_reclaim = loop.time() + RECLAIM_EVERY_SECONDS
        next_reminders = loop.time()
        next_reconcile = loop.time() + 60

        while self.running:
            try:
                if loop.time() >= next_reclaim:
                    await self.reclaim_stale()
                    next_reclaim = loop.time() + RECLAIM_EVERY_SECONDS
                if loop.time() >= next_reminders:
                    next_reminders = loop.time() + PRO_REMINDERS_EVERY_SECONDS
                    await self.send_pro_reminders()
                if loop.time() >= next_reconcile:
                    next_reconcile = loop.time() + RECONCILE_PAYMENTS_EVERY_SECONDS
                    await self.reconcile_payments()

                results = await self.streams.read_messages(
                    consumer_name=self.consumer_name,
                    count=10,
                    block=5000
                )
                for _stream, messages in results or []:
                    for msg_id, fields in messages:
                        await self.handle(msg_id, fields)

            except Exception:
                logger.exception("Error in consume loop")
                await asyncio.sleep(1)

    async def recover(self):
        """At start: finish what this worker was given before it stopped, then take over stuck entries"""
        try:
            own = await self.streams.read_own_pending(self.consumer_name)
            if own:
                logger.warning("Resuming %d unacknowledged message(s) from before the restart", len(own))
            for msg_id, fields in own:
                await self.handle(msg_id, fields)
            await self.reclaim_stale()
            removed = await self.streams.forget_idle_consumers(keep=self.consumer_name, idle_ms=FORGET_CONSUMERS_AFTER_MS)
            if removed:
                logger.info("Removed %d old worker name(s) with nothing pending", removed)
        except Exception:
            logger.exception("Recovering unacknowledged messages failed; the minute sweep will try again")

    async def reclaim_stale(self):
        """Take over entries left unacknowledged for a minute (by any worker) and process them again"""
        stale = await self.streams.claim_stale(self.consumer_name, STALE_AFTER_MS)
        if stale:
            logger.warning("Retrying %d message(s) left unacknowledged for over %ds", len(stale), STALE_AFTER_MS // 1000)
        for msg_id, fields in stale:
            await self.handle(msg_id, fields)

    async def send_pro_reminders(self) -> int:
        """A notice (Settings → Notices) and a push for everyone whose Pro ends within 7 days, then 1."""
        try:
            async with async_session_maker() as db:
                due = await payments.due_reminders(db)
                await db.commit()
                if due:
                    await notices.deliver(db, due)
                    logger.info("Sent %d Pro reminder(s)", len(due))
                return len(due)
        except Exception:
            logger.exception("Sending Pro reminders failed; trying again in an hour")
            return 0

    async def reconcile_payments(self) -> int:
        """Ask Razorpay about recent unpaid orders, in case a payment was never confirmed."""
        try:
            async with async_session_maker() as db:
                return await payments.reconcile(db)
        except Exception:
            logger.exception("Checking unconfirmed payments failed; trying again in 10 minutes")
            return 0

    async def handle(self, msg_id: str, fields: dict):
        """Process one entry. On failure it stays pending and is retried by the sweep, up to MAX_DELIVERIES."""
        try:
            await self.process_message(msg_id, fields)
        except Exception as error:
            attempts = await self.streams.delivery_count(msg_id)
            if attempts >= MAX_DELIVERIES:
                logger.exception("Giving up on stream entry %s after %d tries; moved to the dead-letter stream", msg_id, attempts)
                await self.streams.dead_letter(msg_id, fields, f"{type(error).__name__}: {error}")
            else:
                logger.exception("Failed to save stream entry %s (try %d of %d); retrying in about a minute",
                                 msg_id, attempts, MAX_DELIVERIES)

    async def notify(self, db, message: Message, data: dict, recipient_ids: list) -> None:
        """Push "Alice: see you at 8" (DM) or "Flat 4B / Alice: ..." (group) to the other members' phones."""
        if not push.enabled() or not recipient_ids:
            return
        # Nobody gets notified about someone they've blocked (in groups too)
        blocked = await safety.who_blocked(db, message.sender_id, recipient_ids)
        recipient_ids = [r for r in recipient_ids if r not in blocked]
        if not recipient_ids:
            return
        conversation = await db.get(Conversation, message.conversation_id)
        sender = data.get("senderName") or "Someone"
        if settings.PUSH_SHOW_MESSAGE_TEXT:
            preview = media_storage.preview_text(message.message_type.value, message.text, message.media_filename)
        else:
            preview = "New message"
        if conversation is not None and conversation.kind == "group":
            title, body = conversation.title or "Group", f"{sender}: {preview}"
        else:
            title, body = sender, preview
        await push.send_to_users(db, recipient_ids, title, body, {
            "type": "message",
            "conversationId": str(message.conversation_id),
            "messageId": str(message.id),
            # For phones that show the notification themselves (after decrypting the message)
            "sender": sender,
            "chat": (conversation.title or "Group") if conversation is not None and conversation.kind == "group" else "",
            "encrypted": "1" if media_storage.is_encrypted(message.text) else "",
            "hideText": "" if settings.PUSH_SHOW_MESSAGE_TEXT else "1",  # the phone keeps "New message" too
        }, app_renders=True)

    async def process_message(self, msg_id: str, fields: dict):
        """Process a single message from the stream"""
        # ✅ FIX: fields is already decoded, no .decode() needed
        data_json = fields.get('data', '{}')
        data = json.loads(data_json)
        
        message_id = data.get('messageId')
        conversation_id = data.get('conversationId')
        sender_id_str = data.get('senderId')
        text = data.get('text') or ''
        media_type = data.get('mediaType')
        media_url = data.get('mediaUrl')
        
        if not all([message_id, conversation_id, sender_id_str]) or not (text or media_url):
            logger.warning("Dropping invalid stream entry %s: missing fields", msg_id)
            await self.streams.ack_message(msg_id)
            return
        
        logger.debug("Processing message %s from %s", message_id, sender_id_str)
        
        async with async_session_maker() as db:
            try:
                # ✅ Convert to UUIDs
                sender_id = uuid.UUID(sender_id_str)
                message_uuid = uuid.UUID(message_id)
                conversation_uuid = uuid.UUID(conversation_id)
                
                # Check if message already exists
                result = await db.execute(
                    select(Message).where(Message.id == message_uuid)
                )
                if result.scalar_one_or_none():
                    logger.debug("Message %s already saved, skipping", message_id)
                    await self.streams.ack_message(msg_id)
                    return
                
                timestamp_str = data.get('timestamp')
                created_at = datetime.fromisoformat(timestamp_str) if timestamp_str else datetime.now(timezone.utc)

                # Create message
                message = Message(
                    id=message_uuid,
                    conversation_id=conversation_uuid,
                    sender_id=sender_id,
                    text=text,
                    message_type=MessageType(media_type) if media_url else MessageType.TEXT,
                    media_url=media_url,
                    media_size=data.get('mediaSize'),
                    media_filename=data.get('mediaFilename'),
                    media_thumbnail=data.get('mediaThumbnail'),
                    media_width=data.get('mediaWidth'),
                    media_height=data.get('mediaHeight'),
                    media_duration=data.get('mediaDuration'),
                    has_link=bool(data.get('hasLink')),
                    reply_to_id=uuid.UUID(data['replyToId']) if data.get('replyToId') else None,
                    created_at=created_at,
                )
                db.add(message)
                await db.flush()

                # Sending implies the sender has read the conversation up to here
                await db.execute(
                    update(ConversationMember)
                    .where(
                        ConversationMember.conversation_id == conversation_uuid,
                        ConversationMember.user_id == sender_id,
                    )
                    .values(last_read_message_id=message_uuid, last_read_at=created_at)
                )

                # Keep conversation ordering in sync with its latest message
                await db.execute(
                    update(Conversation)
                    .where(Conversation.id == conversation_uuid)
                    .values(updated_at=created_at)
                )
                
                # Create delivery receipts
                members_result = await db.execute(
                    select(ConversationMember).where(
                        ConversationMember.conversation_id == conversation_uuid,
                        ConversationMember.user_id != sender_id
                    )
                )
                members = members_result.scalars().all()
                
                for member in members:
                    receipt = MessageReceipt(
                        message_id=message_uuid,
                        user_id=member.user_id,
                        status="delivered"
                    )
                    db.add(receipt)
                
                await db.commit()
                
                logger.debug("Saved message %s (%d receipts)", message_id, len(members))
                await self.streams.ack_message(msg_id)

                # Phones get a notification; a failure here never affects the saved message
                try:
                    now = datetime.now(timezone.utc)
                    await self.notify(db, message, data, [m.user_id for m in members if not (m.muted_until and m.muted_until > now)])
                except Exception:
                    logger.exception("Push notification for %s failed", message_id)
                
            except Exception:
                await db.rollback()
                raise


async def main():
    """Main entry point"""
    setup_logging()
    worker = MessageWorker()
    await worker.start()


if __name__ == "__main__":
    asyncio.run(main())