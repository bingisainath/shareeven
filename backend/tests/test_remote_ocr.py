"""Receipt OCR on agent machines (app/services/receipt_ai/remote_ocr.py, app/api/v1/ocr_agent.py)."""

import asyncio
import time
import uuid

import pytest

from app.config.settings import settings
from app.services.receipt_ai import ocr, remote_ocr
from app.services.receipt_ai.remote_ocr import AgentPage, AgentResult, AgentUnavailable, RemoteOcrError
from tests.test_receipts import ocr_ai, scan, six, _usage  # noqa: F401  (fixtures)

TOKEN = "t" * 40
PAGE = AgentPage(text="  TESCO\n  TOTAL  €18.20", confidence=0.98, rows=2, unsure_rows=0, seconds=4.2, turned=0,
                 lines=[{"text": "TESCO", "box": [0.1, 0.1, 0.9, 0.12]}])


@pytest.fixture
async def queue(monkeypatch):
    """A queue under its own prefix in Redis database 15, so tests never touch the app's keys."""
    from redis.asyncio import Redis
    redis = Redis.from_url("redis://localhost:6379/15")
    try:
        await redis.ping()
    except Exception:
        pytest.skip("Redis isn't running on localhost:6379")
    prefix = f"test:ocr:{uuid.uuid4().hex[:8]}"
    q = remote_ocr.Queue(redis=redis, prefix=prefix)
    monkeypatch.setattr(remote_ocr, "_queue", q)
    monkeypatch.setattr(settings, "RECEIPT_OCR_AGENT_TOKEN", TOKEN)
    monkeypatch.setattr(settings, "RECEIPT_OCR_AGENT_TIMEOUT_SECONDS", 5)
    yield q
    keys = [k async for k in redis.scan_iter(f"{prefix}:*")]
    if keys:
        await redis.delete(*keys)
    await redis.aclose()


async def fake_agent(q, name="laptop-1", jobs=1, result=None):
    """Claims `jobs` photos and answers each with its bytes as the text."""
    for _ in range(jobs):
        job_id, photo = await q.claim(name, wait=5)
        page = result or PAGE.model_copy(update={"text": photo.decode()})
        assert await q.finish(job_id, name, page if isinstance(page, AgentResult) else AgentResult(page=page))


async def test_no_agent_online_falls_back_at_once(queue):
    started = time.monotonic()
    with pytest.raises(AgentUnavailable, match="no OCR agent online"):
        await queue.read_photos([b"photo"])
    assert time.monotonic() - started < 1  # nobody waits for an agent that isn't there


async def test_agent_reads_every_photo_in_order(queue):
    await queue.seen("laptop-1")
    agent = asyncio.create_task(fake_agent(queue, jobs=2))
    pages = await queue.read_photos([b"first photo", b"second photo"])
    await agent
    assert [p.text for p in pages] == ["first photo", "second photo"]
    assert pages[0].read_by == "laptop-1" and pages[0].lines[0]["box"] == [0.1, 0.1, 0.9, 0.12]
    assert [k async for k in queue.redis.scan_iter(f"{queue.prefix}:*") if b":agents" not in k] == []


async def test_photos_are_sealed_in_redis(queue):
    await queue.seen("laptop-1")
    scan_task = asyncio.create_task(queue.read_photos([b"PLAIN RECEIPT BYTES"]))
    await asyncio.sleep(0.2)
    job_ids = await queue.redis.lrange(f"{queue.prefix}:queue", 0, -1)
    stored = await queue.redis.get(f"{queue.prefix}:job:{job_ids[0].decode()}")
    assert stored and b"PLAIN RECEIPT BYTES" not in stored
    await fake_agent(queue)
    assert (await scan_task)[0].text == "PLAIN RECEIPT BYTES"


async def test_no_answer_in_time_gives_up_and_refuses_the_late_result(queue, monkeypatch):
    monkeypatch.setattr(settings, "RECEIPT_OCR_AGENT_TIMEOUT_SECONDS", 1)
    await queue.seen("laptop-1")  # online, but never claims
    with pytest.raises(AgentUnavailable, match="within 1 s"):
        await queue.read_photos([b"photo"])
    assert await queue.redis.llen(f"{queue.prefix}:queue") == 0
    assert await queue.claim("laptop-1", wait=0.5) is None  # the job is gone, not handed out late


async def test_claimed_but_too_slow_result_is_refused(queue, monkeypatch):
    monkeypatch.setattr(settings, "RECEIPT_OCR_AGENT_TIMEOUT_SECONDS", 1)
    await queue.seen("laptop-1")
    scan_task = asyncio.create_task(queue.read_photos([b"photo"]))
    job_id, _ = await queue.claim("laptop-1", wait=2)
    with pytest.raises(AgentUnavailable):
        await scan_task
    assert await queue.finish(job_id, "laptop-1", AgentResult(page=PAGE)) is False


async def test_agent_error_is_reported(queue):
    await queue.seen("laptop-1")
    agent = asyncio.create_task(fake_agent(queue, result=AgentResult(error="RuntimeError: onnx")))
    with pytest.raises(RemoteOcrError, match="onnx"):
        await queue.read_photos([b"photo"])
    await agent


async def test_offline_agent_can_fall_back_to_this_server(queue, monkeypatch):
    monkeypatch.setattr(settings, "RECEIPT_OCR_WHEN_AGENT_OFFLINE", "local")
    monkeypatch.setattr(ocr, "available", lambda: True)
    monkeypatch.setattr(ocr, "read_photo", lambda data: ocr.OcrPage(text="local", confidence=1, rows=1, unsure_rows=0,
                                                                     seconds=0, turned=0))
    pages = await remote_ocr.read_photos([b"photo"])
    assert pages[0].text == "local" and pages[0].read_by == "server"


# ------------------------------------------------------------------ the agent routes

def agent_headers(token=TOKEN, name="laptop-1"):
    return {"Authorization": f"Bearer {token}", "X-Agent-Name": name}


async def test_routes_are_hidden_without_a_token(client, monkeypatch):
    monkeypatch.setattr(settings, "RECEIPT_OCR_AGENT_TOKEN", "")
    r = await client.post("/api/v1/ocr-agent/claim?wait=0", headers=agent_headers())
    assert r.status_code == 404


async def test_wrong_token_and_bad_names_are_refused(client, queue):
    assert (await client.post("/api/v1/ocr-agent/claim?wait=0", headers=agent_headers(token="x" * 40))).status_code == 401
    assert (await client.post("/api/v1/ocr-agent/claim?wait=0", headers=agent_headers(name="a b/c"))).status_code == 400
    assert (await client.post("/api/v1/ocr-agent/jobs/../result", json={}, headers=agent_headers())).status_code in (404, 405)


async def test_claim_over_http_then_send_the_text(client, queue):
    assert (await client.post("/api/v1/ocr-agent/claim?wait=0", headers=agent_headers())).status_code == 204
    scan_task = asyncio.create_task(queue.read_photos([b"\xff\xd8jpeg bytes"]))
    r = await client.post("/api/v1/ocr-agent/claim?wait=5", headers=agent_headers())
    assert r.status_code == 200 and r.content == b"\xff\xd8jpeg bytes"
    job_id = r.headers["x-job-id"]
    r = await client.post(f"/api/v1/ocr-agent/jobs/{job_id}/result", json={"page": PAGE.model_dump()}, headers=agent_headers())
    assert r.status_code == 200
    page = (await scan_task)[0]
    assert page.text == PAGE.text and page.read_by == "laptop-1"
    # Sending again: the scan already has it
    r = await client.post(f"/api/v1/ocr-agent/jobs/{job_id}/result", json={"page": PAGE.model_dump()}, headers=agent_headers())
    assert r.status_code == 410


async def test_result_is_checked(client, queue):
    bad = {**PAGE.model_dump(), "confidence": 7, "turned": 45}
    r = await client.post(f"/api/v1/ocr-agent/jobs/{'a' * 32}/result", json={"page": bad}, headers=agent_headers())
    assert r.status_code == 422


# ------------------------------------------------------------------ whole scans

async def test_scan_with_no_agent_sends_the_photos(client, six, ocr_ai, db, queue):  # noqa: F811
    people, group = await six()
    receipt = await scan(client, people[0], group)
    assert ocr_ai.text_calls == [] and len(ocr_ai.calls) == 1  # straight to the photo model
    assert receipt["status"] == "ready"
    usage = await _usage(db, receipt["id"])
    assert usage["path"] == "photos" and usage["ocr"] == {"skipped": "no OCR agent online"}


async def test_scan_read_by_an_agent_uses_the_text_model(client, six, ocr_ai, db, queue):  # noqa: F811
    await queue.seen("laptop-1")
    agent = asyncio.create_task(fake_agent(queue, result=PAGE.model_copy(update={
        "text": "  TESCO\n  Milk  €1.80\n  Cheese  €4.00\n  Rice  €12.00\n  TOTAL  €18.20", "rows": 5})))
    people, group = await six()
    receipt = await scan(client, people[0], group)
    await agent
    assert ocr_ai.calls == [] and "TOTAL  €18.20" in ocr_ai.text_calls[0]["pages"][0]
    usage = await _usage(db, receipt["id"])
    assert usage["path"] == "ocr" and usage["ocr"]["read_by"] == ["laptop-1"]
