# backend/app/api/v1/admin.py
# The admin console (app admins only): the overview numbers, finding an account, suspending,
# signing out or deleting it, and the log of everything admins did. Report review is in safety.py.
#
# Admins see accounts and counts, never what messages say (they're end-to-end encrypted).

import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_app_admin
from app.api.v1.auth import delete_and_announce
from app.db.session import get_db
from app.models.admin import AdminAction
from app.models.auth_session import AuthSession
from app.models.conversation import Conversation
from app.models.conversation_member import ConversationMember
from app.models.e2e_v2 import E2EDevice
from app.models.expense import Expense
from app.models.message import Message
from app.models.receipt import Receipt
from app.models.safety import REPORT_REASONS, AccountNotice, Report, UserBlock
from app.models.user import User
from app.services import admin as admin_service
from app.services import media_storage
from app.services import notices as notice_service
from app.services.receipt_ai import pipeline
from app.websocket.routes import publish_users

router = APIRouter(prefix="/admin", tags=["Admin"])


class ReasonRequest(BaseModel):
    reason: str = Field(..., min_length=3, max_length=500)


class SuspendRequest(ReasonRequest):
    days: Optional[int] = Field(None, ge=1, le=3650)  # None: until an admin lifts it


class DeleteRequest(ReasonRequest):
    confirm_username: str


class ScanLimitRequest(ReasonRequest):
    limit: Optional[int] = Field(None, ge=0, le=10000)  # None: back to the app's limit; 0: scanning paused


class ExtraScansRequest(ReasonRequest):
    count: int = Field(..., ge=1, le=1000)


def _iso(value) -> Optional[str]:
    return value.isoformat() if value else None


def _suspension(u: User) -> Optional[dict]:
    if not u.suspended_now():
        return None
    return {"since": _iso(u.suspended_at), "until": _iso(u.suspended_until), "reason": u.suspension_reason}


def _summary(u: User, last_active=None, reports: int = 0) -> dict:
    return {
        "id": str(u.id), "username": u.username, "name": u.name, "email": u.email,
        "avatar": media_storage.sign_url(u.avatar) if u.avatar else None,
        "created_at": _iso(u.created_at), "last_active": _iso(last_active),
        "is_app_admin": u.is_app_admin, "deleted": u.deleted_at is not None,
        "suspension": _suspension(u), "reports_against": reports,
    }


async def _target(db: AsyncSession, user_id: uuid.UUID, admin: User, *, allow_admin: bool = False) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Account not found")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="You can't do this to your own account")
    if user.is_app_admin and not allow_admin:
        raise HTTPException(status_code=400, detail="This is an admin account. Remove its admin role first (scripts/make_admin.py --revoke).")
    if user.deleted_at is not None:
        raise HTTPException(status_code=400, detail="This account was deleted")
    return user


# ------------------------------------------------------------------ overview

@router.get("/overview")
async def overview(days: int = Query(30, ge=7, le=90), admin: User = Depends(get_app_admin), db: AsyncSession = Depends(get_db)):
    """Sign-ups, active people, messages, expenses and receipt scans (counts only)."""
    return {"success": True, "data": await admin_service.overview(db, days)}


# ------------------------------------------------------------------ accounts

@router.get("/users")
async def list_users(
    q: str = "",
    show: Literal["all", "suspended", "reported", "admins"] = "all",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    admin: User = Depends(get_app_admin),
    db: AsyncSession = Depends(get_db),
):
    """Find accounts by username, name or email; newest first."""
    last_active = select(E2EDevice.user_id, func.max(E2EDevice.last_seen_at).label("at")).group_by(E2EDevice.user_id).subquery()
    reports = select(Report.reported_user_id.label("uid"), func.count().label("n")).group_by(Report.reported_user_id).subquery()
    query = (select(User, last_active.c.at, func.coalesce(reports.c.n, 0))
             .outerjoin(last_active, last_active.c.user_id == User.id)
             .outerjoin(reports, reports.c.uid == User.id)
             .where(User.deleted_at.is_(None)))
    if q.strip():
        text = q.strip().lstrip('@').replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{text}%"  # % and _ typed in the box match themselves, not everything
        query = query.where(or_(User.username.ilike(like, escape="\\"), User.name.ilike(like, escape="\\"),
                                User.email.ilike(like, escape="\\")))
    if show == "suspended":
        query = query.where(User.suspended_at.is_not(None), or_(User.suspended_until.is_(None), User.suspended_until > func.now()))
    elif show == "reported":
        query = query.where(reports.c.n > 0).order_by(reports.c.n.desc())
    elif show == "admins":
        query = query.where(User.is_app_admin.is_(True))
    rows = (await db.execute(query.order_by(User.created_at.desc()).limit(limit + 1).offset(offset))).all()
    return {"success": True, "data": {
        "users": [_summary(u, at, n) for u, at, n in rows[:limit]],
        "more": len(rows) > limit,
    }}


@router.get("/users/{user_id}")
async def user_details(user_id: uuid.UUID, admin: User = Depends(get_app_admin), db: AsyncSession = Depends(get_db)):
    """One account: profile, counts, devices, reports against it and what admins did. Viewing is logged."""
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Account not found")

    count = lambda query: db.scalar(select(func.count()).select_from(query.subquery()))  # noqa: E731
    chats = (await db.execute(
        select(Conversation.kind, func.count()).join(ConversationMember, ConversationMember.conversation_id == Conversation.id)
        .where(ConversationMember.user_id == user.id).group_by(Conversation.kind)
    )).all()
    devices = (await db.execute(
        select(E2EDevice).where(E2EDevice.user_id == user.id, E2EDevice.removed_at.is_(None)).order_by(E2EDevice.last_seen_at.desc().nullslast())
    )).scalars().all()
    reports = (await db.execute(
        select(Report).where(Report.reported_user_id == user.id).order_by(Report.created_at.desc()).limit(20)
    )).scalars().all()
    actions = (await db.execute(
        select(AdminAction, User.username).outerjoin(User, User.id == AdminAction.admin_id)
        .where(AdminAction.target_user_id == user.id, AdminAction.action != "view_user")
        .order_by(AdminAction.created_at.desc()).limit(20)
    )).all()

    await admin_service.log(db, admin, "view_user", user.id)
    await db.commit()

    by_kind = dict(chats)
    return {"success": True, "data": {
        **_summary(user, max((d.last_seen_at for d in devices if d.last_seen_at), default=None), len(reports)),
        "email_verified": user.email_verified, "last_login": _iso(user.last_login),
        "counts": {
            "direct_chats": by_kind.get("direct", 0), "groups": by_kind.get("group", 0),
            "messages_sent": await count(select(Message.id).where(Message.sender_id == user.id)),
            "expenses_added": await count(select(Expense.id).where(Expense.created_by == user.id, Expense.deleted_at.is_(None))),
            "receipts_scanned": await count(select(Receipt.id).where(Receipt.uploaded_by == user.id)),
            "signed_in_sessions": await count(select(AuthSession.id).where(AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None))),
            "blocked_by": await count(select(UserBlock.blocker_id).where(UserBlock.blocked_id == user.id)),
            "reports_made": await count(select(Report.id).where(Report.reporter_id == user.id)),
            "warnings": await count(select(AccountNotice.id).where(AccountNotice.user_id == user.id, AccountNotice.kind == "warning")),
        },
        "scans": {**await pipeline.person_scan_limit(db, user), "used": await pipeline.scans_used(db, user.id)},
        "devices": [{"name": d.name, "added_at": _iso(d.created_at), "last_seen_at": _iso(d.last_seen_at)} for d in devices],
        "reports": [{"id": str(r.id), "reason": r.reason, "details": r.details, "status": r.status,
                     "created_at": _iso(r.created_at)} for r in reports],
        "admin_actions": [{"action": a.action, "reason": a.reason, "by": by, "at": _iso(a.created_at), "details": a.details}
                          for a, by in actions],
    }}


@router.post("/users/{user_id}/suspend")
async def suspend(user_id: uuid.UUID, body: SuspendRequest, admin: User = Depends(get_app_admin), db: AsyncSession = Depends(get_db)):
    """They're signed out everywhere and can't sign in until it ends; their devices keep their chats."""
    user = await _target(db, user_id, admin)
    await admin_service.suspend(db, user, body.reason.strip(), body.days)
    await admin_service.log(db, admin, "suspend", user.id, body.reason.strip(), days=body.days)
    await db.commit()
    await publish_users([str(user.id)], {"type": "account_suspended"})
    return {"success": True, "message": "Account suspended", "data": _summary(user)}


class WarnRequest(BaseModel):
    reason: str = Field(..., description="Which rule (a report reason)")
    message: Optional[str] = Field(None, max_length=500)


@router.post("/users/{user_id}/warn")
async def warn(user_id: uuid.UUID, body: WarnRequest, admin: User = Depends(get_app_admin), db: AsyncSession = Depends(get_db)):
    """A warning they'll see under Notices (and as a notification). It doesn't say who reported them."""
    if body.reason not in REPORT_REASONS:
        raise HTTPException(status_code=400, detail="Choose which rule was broken")
    user = await _target(db, user_id, admin)
    notice = notice_service.warning(user.id, body.reason, body.message)
    db.add(notice)
    await admin_service.log(db, admin, "warn", user.id, (body.message or "").strip() or None, rule=body.reason)
    await db.commit()
    await notice_service.deliver(db, [notice])
    return {"success": True, "message": "Warning sent", "data": _summary(user)}


@router.post("/users/{user_id}/unsuspend")
async def unsuspend(user_id: uuid.UUID, body: ReasonRequest, admin: User = Depends(get_app_admin), db: AsyncSession = Depends(get_db)):
    user = await _target(db, user_id, admin)
    admin_service.unsuspend(user)
    await admin_service.log(db, admin, "unsuspend", user.id, body.reason.strip())
    await db.commit()
    return {"success": True, "message": "Suspension lifted", "data": _summary(user)}


@router.post("/users/{user_id}/sign-out")
async def sign_out_everywhere(user_id: uuid.UUID, body: ReasonRequest, admin: User = Depends(get_app_admin), db: AsyncSession = Depends(get_db)):
    """For a hijacked account: every sign-in ends, and each device wipes its keys (like logging out)."""
    user = await _target(db, user_id, admin, allow_admin=True)
    ended = await admin_service.revoke_all_sessions(db, user.id)
    await admin_service.log(db, admin, "sign_out", user.id, body.reason.strip(), sessions=ended)
    await db.commit()
    return {"success": True, "message": f"Signed out of {ended} session{'s' if ended != 1 else ''}", "data": {"sessions": ended}}


@router.post("/users/{user_id}/delete")
async def delete_account(user_id: uuid.UUID, body: DeleteRequest, admin: User = Depends(get_app_admin), db: AsyncSession = Depends(get_db)):
    """The same deletion as the person's own (shared expenses stay as "Deleted user")."""
    user = await _target(db, user_id, admin)
    if body.confirm_username.strip().lstrip("@") != user.username:
        raise HTTPException(status_code=400, detail="Type the account's username to confirm")
    await admin_service.log(db, admin, "delete_account", user.id, body.reason.strip(), username=user.username)
    await db.flush()
    await delete_and_announce(db, user)  # commits
    return {"success": True, "message": "Account deleted", "data": {"deleted": True}}


# ------------------------------------------------------------------ receipt scans

async def _scan_target(db: AsyncSession, user_id: uuid.UUID) -> User:
    """Scan limits can be set for anyone with an account, admins included (it's logged)."""
    user = await db.get(User, user_id)
    if user is None or user.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Account not found")
    return user


@router.post("/users/{user_id}/scan-limit")
async def set_scan_limit(user_id: uuid.UUID, body: ScanLimitRequest, admin: User = Depends(get_app_admin), db: AsyncSession = Depends(get_db)):
    """This person's monthly receipt scans: a number, 0 to pause scanning, or null for the app's limit."""
    user = await _scan_target(db, user_id)
    before = user.scan_limit_override
    user.scan_limit_override = body.limit
    await admin_service.log(db, admin, "scan_limit_set", user.id, body.reason.strip(), before=before, after=body.limit)
    await db.commit()
    return {"success": True, "message": "Scan limit saved",
            "data": {**await pipeline.person_scan_limit(db, user), "used": await pipeline.scans_used(db, user.id)}}


@router.post("/users/{user_id}/extra-scans")
async def give_extra_scans(user_id: uuid.UUID, body: ExtraScansRequest, admin: User = Depends(get_app_admin), db: AsyncSession = Depends(get_db)):
    """Extra scans for this calendar month only (e.g. after a scan went wrong). They add up within the month."""
    user = await _scan_target(db, user_id)
    month = pipeline._month_start().date()
    user.extra_scans = (user.extra_scans if user.extra_scans_month == month else 0) + body.count
    user.extra_scans_month = month
    await admin_service.log(db, admin, "extra_scans", user.id, body.reason.strip(), count=body.count, month=month.isoformat())
    await db.commit()
    return {"success": True, "message": f"Gave {body.count} extra scan{'s' if body.count != 1 else ''} this month",
            "data": {**await pipeline.person_scan_limit(db, user), "used": await pipeline.scans_used(db, user.id)}}


# ------------------------------------------------------------------ action log

@router.get("/actions")
async def action_log(
    limit: int = Query(100, ge=1, le=500),
    include_views: bool = False,
    admin: User = Depends(get_app_admin),
    db: AsyncSession = Depends(get_db),
):
    """What admins did, newest first."""
    target = User.__table__.alias("target")
    query = (select(AdminAction, User.username, target.c.username)
             .outerjoin(User, User.id == AdminAction.admin_id)
             .outerjoin(target, target.c.id == AdminAction.target_user_id))
    if not include_views:
        query = query.where(AdminAction.action != "view_user")
    rows = (await db.execute(query.order_by(AdminAction.created_at.desc()).limit(limit))).all()
    return {"success": True, "data": [{
        "id": str(a.id), "action": a.action, "reason": a.reason, "details": a.details, "at": _iso(a.created_at),
        "by": by, "target": {"id": str(a.target_user_id), "username": tgt} if a.target_user_id else None,
    } for a, by, tgt in rows]}
