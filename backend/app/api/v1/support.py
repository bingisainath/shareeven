# backend/app/api/v1/support.py
# Support requests: anyone signed in can ask the ShareEven team for help and see the answers;
# app admins read them and reply (the person gets the reply as a notice, with a push).

import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_app_admin, get_current_user
from app.core import rate_limit as rl
from app.db.session import get_db
from app.models.support import SupportTicket
from app.models.user import User
from app.services import admin as admin_service
from app.services import media_storage
from app.services import notices as notice_service

router = APIRouter(tags=["Support"])

# With this many requests still waiting for an answer, a person can't send another yet
OPEN_PER_USER = 5


class TicketRequest(BaseModel):
    category: Literal["bug", "payment", "account", "feedback", "other"]
    subject: str = Field(..., min_length=3, max_length=120)
    message: str = Field(..., min_length=10, max_length=3000)
    app_info: Optional[str] = Field(None, max_length=100)


class ReplyRequest(BaseModel):
    reply: str = Field(..., min_length=1, max_length=3000)
    close: bool = True


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _view(t: SupportTicket) -> dict:
    """What the person who sent it sees."""
    return {
        "id": str(t.id), "category": t.category, "subject": t.subject, "message": t.message,
        "status": t.status, "reply": t.reply, "replied_at": _iso(t.replied_at),
        "created_at": _iso(t.created_at), "closed_at": _iso(t.closed_at),
    }


@router.post("/support")
async def create_ticket(body: TicketRequest, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Ask the ShareEven team for help. Answers come back as a notice (and show on the request)."""
    await rl.enforce((rl.SUPPORT_PER_USER, str(current_user.id)))
    subject, message = body.subject.strip(), body.message.strip()
    if len(subject) < 3 or len(message) < 10:
        raise HTTPException(status_code=400, detail="Add a short subject and a few words about what happened")
    waiting = (await db.execute(select(func.count()).select_from(SupportTicket).where(
        SupportTicket.user_id == current_user.id, SupportTicket.status == "open",
    ))).scalar_one()
    if waiting >= OPEN_PER_USER:
        raise HTTPException(status_code=429, detail="You have a few requests waiting for an answer. We'll reply to those first.")
    ticket = SupportTicket(user_id=current_user.id, category=body.category, subject=subject, message=message,
                           app_info=(body.app_info or "").strip() or None)
    db.add(ticket)
    await db.commit()
    await db.refresh(ticket)
    return {"success": True, "message": "Sent. We'll reply here and in Notices.", "data": _view(ticket)}


@router.get("/support")
async def my_tickets(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Requests I sent, newest first, with the team's answers."""
    rows = (await db.execute(
        select(SupportTicket).where(SupportTicket.user_id == current_user.id)
        .order_by(SupportTicket.created_at.desc()).limit(50)
    )).scalars().all()
    return {"success": True, "data": [_view(t) for t in rows]}


# ------------------------------------------------------------------ app admins

@router.get("/admin/support")
async def list_tickets(
    status: Literal["open", "closed"] = "open",
    admin: User = Depends(get_app_admin),
    db: AsyncSession = Depends(get_db),
):
    """Requests to answer, oldest open first (newest closed first), with who sent each."""
    rows = (await db.execute(
        select(SupportTicket, User).join(User, User.id == SupportTicket.user_id).where(SupportTicket.status == status)
        .order_by(SupportTicket.created_at.asc() if status == "open" else SupportTicket.closed_at.desc().nulls_last())
        .limit(200)
    )).all()
    return {"success": True, "data": [{
        **_view(t), "app_info": t.app_info,
        "user": {"id": str(u.id), "username": u.username, "name": u.name, "avatar": media_storage.sign_url(u.avatar)},
    } for t, u in rows]}


@router.post("/admin/support/{ticket_id}/reply")
async def reply_to_ticket(
    ticket_id: uuid.UUID, body: ReplyRequest,
    admin: User = Depends(get_app_admin), db: AsyncSession = Depends(get_db),
):
    """Answer a request: the person gets it as a notice and a push. Closes it unless close is false."""
    t = await db.get(SupportTicket, ticket_id)
    if t is None:
        raise HTTPException(status_code=404, detail="Support request not found")
    reply = body.reply.strip()
    if not reply:
        raise HTTPException(status_code=400, detail="Write a reply")
    now = datetime.now(timezone.utc)
    t.reply, t.replied_by, t.replied_at = reply, admin.id, now
    if body.close:
        t.status, t.closed_at = "closed", now
    await admin_service.log(db, admin, "support_reply", t.user_id, None, ticket_id=str(t.id), closed=body.close)
    notice = notice_service.support_reply(t.user_id, t.subject, reply)
    db.add(notice)
    await db.commit()
    await notice_service.deliver(db, [notice])
    return {"success": True, "message": "Reply sent", "data": {"id": str(t.id), "status": t.status}}


@router.post("/admin/support/{ticket_id}/close")
async def close_ticket(ticket_id: uuid.UUID, admin: User = Depends(get_app_admin), db: AsyncSession = Depends(get_db)):
    """Close without replying (spam, a duplicate, or already sorted out another way)."""
    t = await db.get(SupportTicket, ticket_id)
    if t is None:
        raise HTTPException(status_code=404, detail="Support request not found")
    if t.status != "closed":
        t.status, t.closed_at = "closed", datetime.now(timezone.utc)
        await admin_service.log(db, admin, "support_close", t.user_id, None, ticket_id=str(t.id))
        await db.commit()
    return {"success": True, "message": "Closed", "data": {"id": str(t.id), "status": t.status}}
