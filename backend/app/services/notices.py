# backend/app/services/notices.py

"""
Notices from the ShareEven team to one person (Settings → Notices, plus a push and a live event).

- A warning names the rule and the admin's reason. It never says who reported them, or that anyone
  did: that keeps reporters safe from retaliation.
- A report update tells the reporter the review is done and whether action was taken, never which
  action (the other person's privacy).
- A support reply is the team's answer to a support request.
"""

import logging
import uuid
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.safety import AccountNotice
from app.services import push
from app.websocket.routes import publish_users

logger = logging.getLogger(__name__)

# Report reasons as rules, for warnings ("... for <rule>")
RULES = {
    "spam": "sending spam or unwanted messages",
    "harassment": "harassing or bullying someone",
    "scam": "scams or fraud",
    "inappropriate": "inappropriate or offensive content",
    "impersonation": "pretending to be someone else",
    "other": "breaking ShareEven's rules",
}

WARNING_TITLE = "Warning from the ShareEven team"
UPDATE_TITLE = "Update on your report"


def warning(user_id: uuid.UUID, reason: str, message: Optional[str], report_id: Optional[uuid.UUID] = None) -> AccountNotice:
    rule = RULES.get(reason, RULES["other"])
    body = f"Your account got a warning for {rule}."
    if message and message.strip():
        body += f" {message.strip()}"
    body += (" If it happens again, your account may be suspended."
             " If you think this is a mistake, tell us from Settings → Help.")
    return AccountNotice(user_id=user_id, kind="warning", title=WARNING_TITLE, body=body, reason=reason, report_id=report_id)


def report_update(reporter_id: uuid.UUID, outcome: str, reported_name: Optional[str], report_id: uuid.UUID) -> AccountNotice:
    about = f" about {reported_name}" if reported_name else ""
    if outcome == "action_taken":
        body = (f"Thanks for your report{about}. We reviewed it and took action."
                " To protect everyone's privacy, we don't share what the action was.")
    else:
        body = (f"Thanks for your report{about}. We reviewed it and didn't find a breach of our rules this time."
                " You can still block anyone you don't want to hear from.")
    return AccountNotice(user_id=reporter_id, kind="report_update", title=UPDATE_TITLE, body=body, reason=outcome, report_id=report_id)


SUPPORT_TITLE = "Reply from ShareEven support"


def support_reply(user_id: uuid.UUID, subject: str, reply: str) -> AccountNotice:
    """The team answered a support request: the answer itself, under the request's subject."""
    return AccountNotice(user_id=user_id, kind="support_reply", title=SUPPORT_TITLE,
                         body=f"About “{subject}”: {reply.strip()}")


def view(n: AccountNotice) -> dict:
    return {
        "id": str(n.id), "kind": n.kind, "title": n.title, "body": n.body, "reason": n.reason,
        "created_at": n.created_at.isoformat() if n.created_at else None,
        "read": n.read_at is not None,
    }


async def deliver(db: AsyncSession, notices: list[AccountNotice]) -> None:
    """After commit: tell each person's open apps, and push to their phones. Never fails the caller."""
    for n in notices:
        try:
            await publish_users([str(n.user_id)], {"type": "account_notice", "notice": view(n)})
            await push.send_to_users(db, [n.user_id], n.title, n.body, {"type": "notice", "noticeId": str(n.id)})
        except Exception:
            logger.exception("Couldn't deliver notice %s", n.id)
