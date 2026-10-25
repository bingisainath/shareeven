# backend/app/services/receipt_ai/ocr.py

"""
Reads receipt photos with open-source OCR on the server's CPU (PaddleOCR's PP-OCRv6 models, run by
RapidOCR), keeping the printed layout: one printed row per line, prices in their column, discount
lines under their item. A cheap text model then turns that text into the receipt.

Measured on 8 real receipts (2026-10): every price right on 7, ~4-6 s per photo, ~14 s sideways.
The bigger "medium" models were 20-60x slower and no better. The models (~30 MB) download on
first use into rapidocr's package folder.
"""

import asyncio
import io
import logging
import math
import re
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from PIL import Image, ImageOps

from app.config.settings import settings
from app.services.receipt_ai.images import MAX_EDGE

logger = logging.getLogger(__name__)

LOW_CONFIDENCE = 0.85  # a row holding a piece below this is marked "?" for the text model

_engine = None
_lock = threading.Lock()  # one photo at a time: OCR uses every thread it's given
# Scans queue here, not in the shared thread pool other background work needs
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="receipt-ocr")


@dataclass
class OcrPage:
    text: str  # the receipt laid out as printed; rows with an unsure piece start with "?"
    confidence: float  # mean over all pieces, 0..1
    rows: int
    unsure_rows: int
    seconds: float
    turned: int  # degrees the photo was turned to read it (sideways photos)
    # Each printed row and where it is on the stored (upright) photo: {"text", "box": [x0, y0, x1, y1]}
    # as fractions of its width and height, so a screen can show that line of the receipt
    lines: list = field(default_factory=list)
    read_by: str = "server"  # or the name of the OCR agent that read it (remote_ocr.py)


def _get_engine():
    global _engine
    if _engine is None:
        from rapidocr import LangDet, LangRec, ModelType, OCRVersion, RapidOCR
        _engine = RapidOCR(params={
            "Global.log_level": "warning",
            "EngineConfig.onnxruntime.intra_op_num_threads": settings.RECEIPT_OCR_THREADS,
            "Det.ocr_version": OCRVersion.PPOCRV6, "Det.model_type": ModelType.SMALL, "Det.lang_type": LangDet.EN,
            "Rec.ocr_version": OCRVersion.PPOCRV6, "Rec.model_type": ModelType.SMALL, "Rec.lang_type": LangRec.EN,
        })
    return _engine


def prepare(data: bytes) -> Image.Image:
    """Upright, at most 2576px; small chat-app photos (720x1280) doubled, as their text is ~8px tall."""
    with Image.open(io.BytesIO(data)) as raw:
        img = ImageOps.exif_transpose(raw).convert("RGB")
    img.thumbnail((MAX_EDGE, MAX_EDGE))
    if max(img.size) < MAX_EDGE / 2:
        img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)
    return img


def _run(engine, img: Image.Image):
    r = engine(img)
    boxes = [] if r.boxes is None else r.boxes.tolist()
    texts, scores = list(r.txts or []), [float(s) for s in (r.scores or [])]
    return boxes, texts, scores, (statistics.mean(scores) if scores else 0.0)


def read_image(img: Image.Image) -> tuple[list, list[str], list[float], float, int]:
    """OCR one photo; when the text runs vertically (photographed sideways), turn it upright first."""
    engine = _get_engine()
    boxes, texts, scores, mean = _run(engine, img)
    long_pieces = [b for b, t in zip(boxes, texts) if len(t) >= 4]
    sideways = sum(1 for b in long_pieces if _span(b, 1) > _span(b, 0))
    if long_pieces and sideways > len(long_pieces) / 2:
        # The direction classifier only knows 0/180 degrees, so try both quarter turns and keep the better read
        tries = [(_run(engine, img.rotate(angle, expand=True)), angle) for angle in (90, -90)]
        (boxes, texts, scores, mean), angle = max(tries, key=lambda t: t[0][3])
        return boxes, texts, scores, mean, angle
    return boxes, texts, scores, mean, 0


def _span(box, axis: int) -> float:
    return max(p[axis] for p in box) - min(p[axis] for p in box)


ITEM_ROW = re.compile(r"^\d+(?:[.,]\d+)?\s+\S*[A-Za-z]")  # "1 Barilla ...", "0.595 Bananas"
# Discount lines printed under an item (not summary lines like "Savings", whose minus may have faded)
DISCOUNT_ROW = re.compile(r"^(cc\b|special offer|clubcard price|reduced|price cut|rabatt)", re.IGNORECASE)
MINUS_AMOUNT = re.compile(r"^[-\u2212]\s?[€$£₹]?\d")
PLUS_AMOUNT = re.compile(r"^[€$£₹]?\d+[.,]\d{2}$")


def _mismatch(row: list[dict], other: list[dict], minus_printed: bool) -> bool:
    """
    A lone amount next to the wrong kind of row: minus on an item line, or a price on a discount
    line. The second only counts when this receipt shows minus signs at all (faded print loses them).
    """
    if len(other) != 1:
        return False
    amount, start = other[0]["text"].strip(), min(row, key=lambda p: p["x"])["text"].strip()
    if MINUS_AMOUNT.match(amount):
        return bool(ITEM_ROW.match(start))
    if PLUS_AMOUNT.match(amount) and minus_printed:
        return bool(DISCOUNT_ROW.match(start))
    return False


def layout(boxes, texts, scores) -> tuple[str, list[dict]]:
    """
    Group OCR pieces into printed rows and place each at its column, so tables keep their shape.
    Receipts curl, so one angle for the whole photo puts prices half a row off. Instead each row
    follows the slant of its widest piece, and closest pairs join first: a price joins the row whose
    line, extended to the right, passes closest to it. A box's slant can be a few pixels off, so
    what the text says breaks near-ties: a minus amount belongs on a discount row, a price on an
    item row (_mismatch).
    """
    pieces = []
    for box, text, score in zip(boxes, texts, scores):
        (x0, y0), (x1, y1), _, (x3, y3) = box[0], box[1], box[2], box[3]
        pieces.append({
            "text": text, "score": float(score),
            "slope": (y1 - y0) / (x1 - x0) if x1 != x0 else 0.0,
            "x": float(min(p[0] for p in box)), "right": float(max(p[0] for p in box)),
            "top": float(min(p[1] for p in box)), "bottom": float(max(p[1] for p in box)),
            "cx": float(sum(p[0] for p in box) / 4), "cy": float(sum(p[1] for p in box) / 4),
            "w": float(math.hypot(x1 - x0, y1 - y0)), "h": float(math.hypot(x3 - x0, y3 - y0)),
        })
    if not pieces:
        return "", []

    line_h = statistics.median(p["h"] for p in pieces)
    minus_printed = any(MINUS_AMOUNT.match(p["text"].strip()) for p in pieces)

    def y_at(row: list[dict], x: float) -> float:
        anchor = max(row, key=lambda p: p["w"])
        return anchor["cy"] + anchor["slope"] * (x - anchor["cx"])

    def gap(a: list[dict], b: list[dict]) -> float | None:
        """How far b sits from a's line (a = the row with the wider piece); None if they overlap."""
        if any(p["x"] < q["right"] - line_h * 0.3 and q["x"] < p["right"] - line_h * 0.3 for p in a for q in b):
            return None
        if max(p["w"] for p in b) > max(p["w"] for p in a):
            a, b = b, a
        distance = max(abs(q["cy"] - y_at(a, q["cx"])) for q in b)
        return distance + (line_h * 0.4 if _mismatch(a, b, minus_printed) else 0)

    # Closest pairs merge first across the whole receipt, so a price joins the row it fits best
    # even when a neighbouring row's discount sits a few pixels further left.
    rows: list[list[dict]] = [[p] for p in sorted(pieces, key=lambda p: p["cy"])]
    while True:
        best = None
        for i, a in enumerate(rows):
            a_cy = statistics.mean(p["cy"] for p in a)
            for j in range(i + 1, len(rows)):
                b = rows[j]
                if abs(statistics.mean(p["cy"] for p in b) - a_cy) > line_h * 2:
                    continue
                g = gap(a, b)
                if g is not None and g < line_h * 0.6 and (best is None or g < best[0]):
                    best = (g, i, j)
        if best is None:
            break
        _, i, j = best
        rows[i] += rows.pop(j)

    left = min(p["x"] for p in pieces)
    rows.sort(key=lambda row: y_at(row, left))
    char_w = statistics.median(p["w"] / max(len(p["text"]), 1) for p in pieces)
    lines, out_rows = [], []
    for row in rows:
        row.sort(key=lambda p: p["x"])
        line = ""
        for p in row:
            col = round((p["x"] - left) / char_w)
            line += " " * max(col - len(line), 1 if line else 0) + p["text"]
        unsure = min(p["score"] for p in row) < LOW_CONFIDENCE
        lines.append(("? " if unsure else "  ") + line)
        out_rows.append({
            "text": line, "unsure": unsure,
            "cells": [{"text": p["text"], "score": round(p["score"], 3)} for p in row],
            "box": [min(p["x"] for p in row), min(p["top"] for p in row), max(p["right"] for p in row), max(p["bottom"] for p in row)],
        })
    return "\n".join(lines), out_rows


def upright_box(box: list[float], turned: int, width: int, height: int) -> list[float]:
    """
    A box found on the photo as OCR read it (turned 90° either way for sideways photos) -> the same
    box on the upright photo, as fractions of its width and height. width/height: the upright photo.
    """
    x0, y0, x1, y1 = box
    corners = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
    if turned == 90:  # PIL turned it anticlockwise: (x, y) -> (y, W - x), so back is (x', y') -> (W - y', x')
        corners = [(width - y, x) for x, y in corners]
    elif turned == -90:  # clockwise: (x, y) -> (H - y, x), so back is (x', y') -> (y', H - x')
        corners = [(y, height - x) for x, y in corners]
    xs, ys = [c[0] for c in corners], [c[1] for c in corners]
    clamp = lambda v: round(min(max(v, 0.0), 1.0), 4)  # noqa: E731
    return [clamp(min(xs) / width), clamp(min(ys) / height), clamp(max(xs) / width), clamp(max(ys) / height)]


def read_photo(data: bytes) -> OcrPage:
    """One photo's bytes -> its text laid out as printed. Blocking: call it from a thread."""
    img = prepare(data)
    with _lock:
        started = time.perf_counter()
        boxes, texts, scores, mean, turned = read_image(img)
        seconds = time.perf_counter() - started
    text, rows = layout(boxes, texts, scores)
    lines = [{"text": r["text"], "box": upright_box(r["box"], turned, img.width, img.height)} for r in rows]
    return OcrPage(text=text, confidence=mean, rows=len(rows), unsure_rows=sum(r["unsure"] for r in rows),
                   seconds=round(seconds, 2), turned=turned, lines=lines)


async def read_photos(photos: list[bytes]) -> list[OcrPage]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_executor, lambda: [read_photo(p) for p in photos])


def download_models() -> None:
    """Fetch the models now (e.g. while deploying) instead of on the first scan."""
    with _lock:
        _get_engine()


def available() -> bool:
    try:
        import rapidocr  # noqa: F401
        return True
    except ImportError:
        return False
