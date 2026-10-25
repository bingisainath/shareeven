"""
Reads receipt photos for a ShareEven server on this machine's CPU (e.g. a laptop at home), so the
server doesn't run OCR itself. It only makes outbound HTTPS calls: no ports to open, any network
(Wi-Fi, ethernet, phone tethering) works, and it picks up again by itself after the network drops.

    cd backend && OCR_AGENT_TOKEN=... ./venv/bin/python scripts/ocr_agent.py --api https://api.shareeven.com/api/v1

    --workers N     photos read at once (default: one per 4 CPU cores); each uses RECEIPT_OCR_THREADS threads
    --name NAME     how the server lists this machine (default: the hostname)

The token is the server's RECEIPT_OCR_AGENT_TOKEN, from the environment only (never a command-line
argument, which other users of the machine can see). Photos stay in memory and are never saved, and
receipt text is never logged. Exits with code 2 when the server refuses the token.
See infra/ocr-agent/README.md for running it as a service, and app/services/receipt_ai/remote_ocr.py.
"""

import argparse
import logging
import multiprocessing as mp
import os
import re
import signal
import socket
import sys
import time
from dataclasses import asdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

logger = logging.getLogger("ocr_agent")

WAIT = 20  # seconds the server holds each claim open
BAD_TOKEN = 2


def _setup_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(processName)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)


def _send(http, job_id: str, body: dict) -> None:
    for attempt in range(3):
        try:
            r = http.post(f"/ocr-agent/jobs/{job_id}/result", json=body)
            if r.status_code == 410:
                logger.info("Job %s: the scan stopped waiting (it took too long)", job_id[:8])
            else:
                r.raise_for_status()
            return
        except Exception as e:
            logger.warning("Job %s: couldn't send the result (%s), try %d of 3", job_id[:8], e, attempt + 1)
            time.sleep(2 ** attempt)


def work(api: str, token: str, name: str) -> None:
    """One worker: claim a photo, read it, send the text back, forever."""
    import httpx

    from app.services.receipt_ai import ocr
    _setup_logging()
    signal.signal(signal.SIGINT, signal.SIG_IGN)  # the main process stops us
    ocr.download_models()  # load the models before asking for work, so the first photo isn't slow
    headers = {"Authorization": f"Bearer {token}", "X-Agent-Name": name}
    backoff = 1
    with httpx.Client(base_url=api, headers=headers, timeout=httpx.Timeout(15, read=WAIT + 20)) as http:
        logger.info("Ready, asking %s for photos", api)
        while True:
            try:
                r = http.post("/ocr-agent/claim", params={"wait": WAIT})
                if r.status_code == 401:
                    logger.error("The server refused the token (check OCR_AGENT_TOKEN)")
                    sys.exit(BAD_TOKEN)
                if r.status_code == 404:
                    logger.warning("Remote OCR is off on the server (RECEIPT_OCR_AGENT_TOKEN unset); asking again in a minute")
                    time.sleep(60)
                    continue
                r.raise_for_status()
                backoff = 1
                if r.status_code == 204:
                    continue
                job_id = r.headers["X-Job-Id"]
                try:
                    page = ocr.read_photo(r.content)
                    body = {"page": {k: v for k, v in asdict(page).items() if k != "read_by"}}
                    logger.info("Job %s: %d rows in %.1f s", job_id[:8], page.rows, page.seconds)
                except Exception as e:
                    logger.exception("Job %s: OCR failed", job_id[:8])
                    body = {"error": f"{type(e).__name__}: {e}"[:500]}
                _send(http, job_id, body)
            except httpx.HTTPError as e:
                logger.warning("Server unreachable (%s), trying again in %d s", e, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, 30)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", default=os.environ.get("SHAREEVEN_API", ""), help="e.g. https://api.shareeven.com/api/v1")
    ap.add_argument("--workers", type=int, default=int(os.environ.get("OCR_AGENT_WORKERS", 0)) or max(1, (os.cpu_count() or 4) // 4))
    ap.add_argument("--name", default=os.environ.get("OCR_AGENT_NAME", "") or socket.gethostname())
    args = ap.parse_args()
    _setup_logging()
    token = os.environ.get("OCR_AGENT_TOKEN", "")
    if not args.api or not token:
        ap.error("set --api (or SHAREEVEN_API) and OCR_AGENT_TOKEN")
    if not args.api.startswith("https://") and "localhost" not in args.api and "127.0.0.1" not in args.api:
        ap.error("--api must be https:// (the photos and the token travel over it)")
    base = re.sub(r"[^A-Za-z0-9._-]", "-", args.name)[:36]

    ctx = mp.get_context("spawn")  # each worker loads its own OCR engine
    procs: dict[int, mp.Process] = {}
    stopping = False

    def start(i: int) -> None:
        p = ctx.Process(target=work, args=(args.api.rstrip("/"), token, f"{base}-{i}"), name=f"worker-{i}", daemon=True)
        p.start()
        procs[i] = p

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    for i in range(1, args.workers + 1):
        start(i)
    logger.info("%d workers as %s-1..%d", args.workers, base, args.workers)
    while not stopping:
        time.sleep(1)
        for i, p in list(procs.items()):
            if p.is_alive():
                continue
            if p.exitcode == BAD_TOKEN:
                stopping = True
                break
            logger.warning("Worker %d stopped (exit %s), starting it again", i, p.exitcode)
            time.sleep(5)
            start(i)
    for p in procs.values():
        p.terminate()
    for p in procs.values():
        p.join(5)
    return BAD_TOKEN if any(p.exitcode == BAD_TOKEN for p in procs.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
