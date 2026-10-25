# backend/app/api/v1/ocr_agent.py

"""
For OCR agents (scripts/ocr_agent.py), not people: they ask for receipt photos and send back the
text. Signed in with RECEIPT_OCR_AGENT_TOKEN; without it set, these routes don't exist (404).
See app/services/receipt_ai/remote_ocr.py.
"""

import re

from fastapi import APIRouter, Header, HTTPException, Query, Response

from app.services.receipt_ai import remote_ocr

router = APIRouter(prefix="/ocr-agent", tags=["OCR agent"], include_in_schema=False)

AGENT_NAME = re.compile(r"^[A-Za-z0-9._-]{1,40}$")
JOB_ID = re.compile(r"^[0-9a-f]{32}$")


def _agent(authorization: str, agent: str) -> str:
    if not remote_ocr.enabled():
        raise HTTPException(status_code=404, detail="Not Found")
    token = authorization.removeprefix("Bearer ").strip()
    if not remote_ocr.token_ok(token):
        raise HTTPException(status_code=401, detail="Wrong OCR agent token")
    if not AGENT_NAME.match(agent):
        raise HTTPException(status_code=400, detail="X-Agent-Name: 1-40 letters, digits, dots, dashes or underscores")
    return agent


@router.post("/claim")
async def claim(wait: float = Query(20, ge=0, le=25), authorization: str = Header(""), x_agent_name: str = Header("")):
    """The next photo to read (body: its bytes, header X-Job-Id), or 204 when none came within `wait` s."""
    agent = _agent(authorization, x_agent_name)
    job = await remote_ocr.queue().claim(agent, wait)
    if job is None:
        return Response(status_code=204)
    job_id, photo = job
    return Response(content=photo, media_type="application/octet-stream",
                    headers={"X-Job-Id": job_id, "Cache-Control": "no-store"})


@router.post("/jobs/{job_id}/result")
async def result(job_id: str, body: remote_ocr.AgentResult, authorization: str = Header(""), x_agent_name: str = Header("")):
    """What the photo says (or why it couldn't be read). 410 when the scan stopped waiting for it."""
    agent = _agent(authorization, x_agent_name)
    if not JOB_ID.match(job_id):
        raise HTTPException(status_code=404, detail="No such job")
    if not await remote_ocr.queue().finish(job_id, agent, body):
        raise HTTPException(status_code=410, detail="The scan stopped waiting for this photo")
    return {"success": True, "message": "Thanks", "data": None}
