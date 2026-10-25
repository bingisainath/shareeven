# backend/app/services/receipt_ai/remote_ocr.py

"""
Receipt OCR on other machines (e.g. a laptop at home), so this server's CPU stays free.

The agents (scripts/ocr_agent.py) can't be reached from here, so they ask for work: each one
keeps calling POST /ocr-agent/claim over HTTPS, which waits up to ~20 s for a photo. A scan puts
one job per photo in Redis and waits for the texts; any API server can hand a job out or take
its result, because everything is in Redis:

    papyris:ocr:queue         list of job ids (LPUSH here, BRPOP by the claim)
    papyris:ocr:job:<id>      the photo, sealed with the media key (taken once, GETDEL)
    papyris:ocr:claimed:<id>  which agent took it; the result is only accepted while this exists
    papyris:ocr:done:<id>     the agent's result, waited for with BLPOP
    papyris:ocr:agents        sorted set: agent name -> last time it asked for work

Photos never sit in Redis as plain bytes, and the agent never gets the media key: the server
unseals a photo only to send it to the agent that claimed it. When no agent has asked for work
lately, scans don't wait: they go straight to the fallback (RECEIPT_OCR_WHEN_AGENT_OFFLINE).
"""

import hmac
import json
import logging
import math
import time
import uuid
from typing import Literal

from pydantic import BaseModel, Field
from redis.asyncio import Redis

from app.config.settings import settings
from app.services import media_crypto
from app.services.receipt_ai import ocr

logger = logging.getLogger(__name__)

ONLINE_SECONDS = 60  # an agent that asked for work this recently counts as online
PURPOSE = b"papyris-ocr-job"


class AgentUnavailable(Exception):
    """No agent online, or none answered in time. Safe to log; the scan falls back."""


class RemoteOcrError(Exception):
    """The agent took the photo but its OCR failed."""


class AgentLine(BaseModel):
    text: str = Field(max_length=2000)
    box: list[float] = Field(min_length=4, max_length=4)


class AgentPage(BaseModel):
    """What an agent sends back for one photo: ocr.OcrPage, checked."""
    text: str = Field(max_length=100_000)
    confidence: float = Field(ge=0, le=1)
    rows: int = Field(ge=0, le=5000)
    unsure_rows: int = Field(ge=0, le=5000)
    seconds: float = Field(ge=0)
    turned: Literal[0, 90, -90]
    lines: list[AgentLine] = Field(default_factory=list, max_length=5000)


class AgentResult(BaseModel):
    page: AgentPage | None = None
    error: str | None = Field(None, max_length=500)


def enabled() -> bool:
    return bool(settings.RECEIPT_OCR_AGENT_TOKEN)


def token_ok(token: str) -> bool:
    expected = settings.RECEIPT_OCR_AGENT_TOKEN
    return bool(expected) and hmac.compare_digest(token.encode(), expected.encode())


class Queue:
    def __init__(self, redis: Redis | None = None, prefix: str = "papyris:ocr"):
        self.redis = redis or Redis.from_url(settings.redis_dsn)
        self.prefix = prefix

    def _key(self, *parts: str) -> str:
        return ":".join((self.prefix, *parts))

    def _ttl(self) -> int:
        return settings.RECEIPT_OCR_AGENT_TIMEOUT_SECONDS + 30

    # ------------------------------------------------------------ the scan's side

    async def agents_online(self) -> list[str]:
        now = time.time()
        agents = self._key("agents")
        await self.redis.zremrangebyscore(agents, 0, now - ONLINE_SECONDS * 10)  # forget long-gone names
        return [n.decode() if isinstance(n, bytes) else n
                for n in await self.redis.zrangebyscore(agents, now - ONLINE_SECONDS, "+inf")]

    async def read_photos(self, photos: list[bytes]) -> list[ocr.OcrPage]:
        """One job per photo, so several agent workers read a long receipt's photos at once."""
        if not await self.agents_online():
            raise AgentUnavailable("no OCR agent online")
        ids = [uuid.uuid4().hex for _ in photos]
        pipe = self.redis.pipeline(transaction=False)
        for job_id, photo in zip(ids, photos):
            pipe.set(self._key("job", job_id), media_crypto.seal(photo, PURPOSE), ex=self._ttl())
            pipe.lpush(self._key("queue"), job_id)
        await pipe.execute()
        deadline = time.monotonic() + settings.RECEIPT_OCR_AGENT_TIMEOUT_SECONDS
        try:
            pages = []
            for job_id in ids:
                left = deadline - time.monotonic()
                got = await self.redis.blpop(self._key("done", job_id), timeout=max(1, math.ceil(left))) if left > 0 else None
                if got is None:
                    raise AgentUnavailable(f"no OCR agent answered within {settings.RECEIPT_OCR_AGENT_TIMEOUT_SECONDS} s")
                result = json.loads(got[1])
                if result.get("error") or not result.get("page"):
                    raise RemoteOcrError(result.get("error") or "the agent sent no text")
                page = ocr.OcrPage(**result["page"])
                page.read_by = result.get("agent", "agent")
                pages.append(page)
            return pages
        finally:
            # Done or given up: jobs nobody took yet are dropped, and a late result is refused
            pipe = self.redis.pipeline(transaction=False)
            for job_id in ids:
                pipe.lrem(self._key("queue"), 0, job_id)
                pipe.delete(self._key("job", job_id), self._key("claimed", job_id), self._key("done", job_id))
            await pipe.execute()

    # ------------------------------------------------------------ the agent's side

    async def seen(self, agent: str) -> None:
        await self.redis.zadd(self._key("agents"), {agent: time.time()})

    async def claim(self, agent: str, wait: float) -> tuple[str, bytes] | None:
        """The next photo for this agent: (job id, photo bytes), or None after `wait` seconds."""
        await self.seen(agent)
        deadline = time.monotonic() + wait
        while (left := deadline - time.monotonic()) > 0:
            got = await self.redis.brpop(self._key("queue"), timeout=max(1, math.ceil(left)))
            if got is None:
                return None
            job_id = got[1].decode() if isinstance(got[1], bytes) else got[1]
            sealed = await self.redis.getdel(self._key("job", job_id))
            if sealed is None:  # the scan gave up on it already
                continue
            await self.redis.set(self._key("claimed", job_id), agent, ex=self._ttl())
            return job_id, media_crypto.unseal(sealed, PURPOSE)
        return None

    async def finish(self, job_id: str, agent: str, result: AgentResult) -> bool:
        """Hand the result to the waiting scan. False when nobody is waiting for it any more."""
        await self.seen(agent)
        if await self.redis.getdel(self._key("claimed", job_id)) is None:
            return False
        body = {"agent": agent, "page": result.page.model_dump() if result.page else None, "error": result.error}
        pipe = self.redis.pipeline(transaction=False)
        pipe.rpush(self._key("done", job_id), json.dumps(body))
        pipe.expire(self._key("done", job_id), self._ttl())
        await pipe.execute()
        return True


_queue: Queue | None = None


def queue() -> Queue:
    global _queue
    if _queue is None:
        _queue = Queue()
    return _queue


async def read_photos(photos: list[bytes]) -> list[ocr.OcrPage]:
    """
    The photos' text, read by an agent when they're on, else on this server. Raises AgentUnavailable
    when no agent took them and this server shouldn't read them itself (the scan sends the photos).
    """
    if not enabled():
        return await ocr.read_photos(photos)
    try:
        return await queue().read_photos(photos)
    except AgentUnavailable as e:
        if settings.RECEIPT_OCR_WHEN_AGENT_OFFLINE == "local" and ocr.available():
            logger.warning("Remote OCR: %s, reading on this server", e)
            return await ocr.read_photos(photos)
        logger.warning("Remote OCR: %s", e)
        raise
