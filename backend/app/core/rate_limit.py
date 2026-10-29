# backend/app/core/rate_limit.py
# Limits on how often an IP address or an account can do something (log in, sign up, upload,
# send messages...). Counted in Redis so every API server shares the same counts.
#
# Fixed windows: a counter per (limit, who, window number) that expires with its window. Simple
# and cheap (one INCR + EXPIRE); a burst at a window edge can get up to twice the limit, which
# is fine for abuse protection.
#
# If Redis is unreachable the limits are skipped (logged), so an outage there never locks
# everyone out of the app.

import hashlib
import logging
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request
from redis.asyncio import Redis

from app.config.settings import settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Limit:
    name: str
    times: int
    per_seconds: int
    message: str = "Too many attempts. Try again in {wait}."


MINUTE, HOUR, DAY = 60, 3600, 86400

# Sign-in and account recovery (per IP address, and per account where one is named)
LOGIN_PER_IP = Limit("login-ip", 30, 15 * MINUTE)
LOGIN_PER_ACCOUNT = Limit("login-account", 10, 15 * MINUTE)
REGISTER_PER_IP = Limit("register-ip", 10, HOUR)
VERIFY_EMAIL_PER_IP = Limit("verify-ip", 30, 15 * MINUTE)  # each account also locks after 5 wrong codes
RESEND_CODE_PER_IP = Limit("resend-ip", 10, HOUR)
FORGOT_PER_IP = Limit("forgot-ip", 10, HOUR)
FORGOT_PER_ACCOUNT = Limit("forgot-account", 3, HOUR)
RESET_PER_IP = Limit("reset-ip", 20, HOUR)

# Signed-in people (per account)
UPLOADS_PER_USER = Limit("upload", 120, 10 * MINUTE, "You're uploading too fast. Try again in {wait}.")
RECEIPT_SCANS_PER_USER = Limit("receipt-scan", 10, 10 * MINUTE, "Too many receipt scans at once. Try again in {wait}.")
USER_SEARCH_PER_USER = Limit("user-search", 60, MINUTE, "Too many searches. Try again in {wait}.")
NEW_CHATS_PER_USER = Limit("new-chat", 30, HOUR, "You've started a lot of chats. Try again in {wait}.")
DATA_EXPORTS_PER_USER = Limit("export", 5, HOUR, "You've downloaded your data a few times already. Try again in {wait}.")
DELETE_ACCOUNT_PER_USER = Limit("delete-account", 5, HOUR)
REPORTS_PER_USER = Limit("report", 20, HOUR, "You've sent a lot of reports. Try again in {wait}.")
SUPPORT_PER_USER = Limit("support", 10, DAY, "You've sent a lot of support requests today. We'll answer those first; try again in {wait}.")
MESSAGES_PER_USER = Limit("message", 40, 10, "You're sending messages too fast. Wait a moment.")


class _MemoryCounter:
    """Same behaviour as Redis, in this process only (tests)."""

    def __init__(self):
        self.counts: dict[str, int] = {}

    async def incr(self, key: str, ttl: int) -> int:
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key]


class _RedisCounter:
    def __init__(self):
        self.redis = Redis.from_url(settings.redis_dsn, decode_responses=True)

    async def incr(self, key: str, ttl: int) -> int:
        pipe = self.redis.pipeline(transaction=True)
        pipe.incr(key)
        pipe.expire(key, ttl, nx=True)
        count, _ = await pipe.execute()
        return int(count)


_counter: _RedisCounter | _MemoryCounter | None = None
_last_failure_log = 0.0


def use_memory_counter() -> _MemoryCounter:
    """Count in memory instead of Redis (tests). Returns the counter so tests can reset it."""
    global _counter
    _counter = _MemoryCounter()
    return _counter


def _who(value: str) -> str:
    """Accounts are counted by a hash, so emails and usernames never sit in Redis."""
    return hashlib.sha256(value.strip().lower().encode()).hexdigest()[:24]


def _wait_text(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds} seconds"
    minutes = (seconds + 59) // 60
    return f"{minutes} minute{'s' if minutes != 1 else ''}"


async def check(limit: Limit, who: str) -> int | None:
    """Count one attempt by `who`. Returns seconds to wait if over the limit, else None."""
    global _counter, _last_failure_log
    if not settings.RATE_LIMITS_ENABLED or not who:
        return None
    if _counter is None:
        _counter = _RedisCounter()
    now = int(time.time())
    window = now // limit.per_seconds
    key = f"papyris:rl:{limit.name}:{_who(who)}:{window}"
    try:
        count = await _counter.incr(key, limit.per_seconds)
    except Exception:
        if time.time() - _last_failure_log > 60:
            _last_failure_log = time.time()
            logger.exception("Rate limit check failed; allowing the request")
        return None
    if count <= limit.times:
        return None
    return max(1, (window + 1) * limit.per_seconds - now)


async def enforce(*checks: tuple[Limit, str]) -> None:
    """Count every check (so each limit sees the attempt); raise 429 if any is over."""
    waits = [(limit, wait) for limit, who in checks if (wait := await check(limit, who)) is not None]
    if waits:
        limit, wait = max(waits, key=lambda lw: lw[1])
        logger.warning("Rate limit %s reached", limit.name)
        raise HTTPException(
            status_code=429,
            detail=limit.message.format(wait=_wait_text(wait)),
            headers={"Retry-After": str(wait)},
        )


def client_ip(request: Request) -> str:
    """The caller's address. Behind a proxy, run uvicorn with --proxy-headers so this is the real one."""
    return request.client.host if request.client else "unknown"
