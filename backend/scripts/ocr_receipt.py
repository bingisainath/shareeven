"""
Show what the receipt OCR (app/services/receipt_ai/ocr.py) reads from photos: the text laid out as
printed, which the cheap text model gets. Useful to check a receipt the OCR path got wrong.

    python scripts/ocr_receipt.py photo.jpg [more.jpg ...]    # local image files
    python scripts/ocr_receipt.py --receipts                  # every scanned receipt in the DB
    python scripts/ocr_receipt.py --receipts --out ocr_out/   # also save <photo>.txt and .json
    python scripts/ocr_receipt.py --download                  # fetch the models (~30 MB) while deploying

Rows starting with "?" hold a piece the OCR wasn't sure about.
"""

import argparse
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.receipt_ai import ocr  # noqa: E402


def receipt_sources() -> list[tuple[str, str]]:
    """(label, media url) for every photo of every receipt in the DB."""
    import psycopg2
    from app.config.settings import settings
    dsn = settings.DATABASE_URL.replace("+asyncpg", "")
    with psycopg2.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("select id, image_urls from receipts order by created_at")
        return [(f"{rid}#{i + 1}", url) for rid, urls in cur.fetchall() for i, url in enumerate(urls or [])]


def read_bytes(source: str) -> bytes:
    """A file path, or a /api/v1/media/... URL (decrypted like the real scan)."""
    if source.startswith("/api/"):
        from app.services import media_storage
        data = media_storage.read_bytes(source)
        if data is None:
            raise FileNotFoundError(source)
        return data
    return Path(source).read_bytes()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", nargs="*", help="image files or /api/v1/media/... URLs")
    ap.add_argument("--receipts", action="store_true", help="every receipt photo in the DB")
    ap.add_argument("--out", help="folder for <photo>.txt and .json")
    ap.add_argument("--download", action="store_true", help="only fetch the OCR models, so the first scan doesn't")
    args = ap.parse_args()
    if args.download:
        ocr.download_models()
        print("OCR models ready")
        return 0

    sources = [(Path(s).name, s) for s in args.images]
    if args.receipts:
        sources += receipt_sources()
    if not sources:
        ap.error("give image files or --receipts")
    out_dir = Path(args.out) if args.out else None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)

    for label, source in sources:
        page = ocr.read_photo(read_bytes(source))
        turned = f" | turned {page.turned}°" if page.turned else ""
        print(f"\n=== {label}{turned} | {page.seconds}s | {page.rows} rows, mean confidence {page.confidence:.3f}, "
              f"{page.unsure_rows} unsure (marked ?) ===")
        print(page.text)
        if out_dir:
            stem = label.replace("#", "_").replace("/", "_")
            (out_dir / f"{stem}.txt").write_text(page.text + "\n")
            (out_dir / f"{stem}.json").write_text(json.dumps({"source": source, **asdict(page)}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
