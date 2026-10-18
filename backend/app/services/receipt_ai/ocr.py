# backend/app/services/receipt_ai/ocr.py

"""
Reads receipt photos with open-source OCR on the server's CPU (PaddleOCR's PP-OCRv6 models, run by
RapidOCR), keeping the printed layout: one printed row per line, prices in their column, discount
lines under their item. A cheap text model then turns that text into the receipt.

Measured on 8 real receipts (2026-10): every price right on 7, ~4-6 s per photo, ~14 s sideways.
The bigger "medium" models were 20-60x slower and no better. The models (~30 MB) download on
first use into rapidocr's package folder.
"""

import io
import logging
import math
import statistics
import threading
import time
from dataclasses import dataclass

from PIL import Image, ImageOps

from app.config.settings import settings
from app.services.receipt_ai.images import MAX_EDGE

logger = logging.getLogger(__name__)

LOW_CONFIDENCE = 0.85  # a row holding a piece below this is marked "?" for the text model

_engine = None
_lock = threading.Lock()  # one photo at a time: OCR uses every thread it's given


@dataclass
class OcrPage:
    text: str  # the receipt laid out as printed; rows with an unsure piece start with "?"
    confidence: float  # mean over all pieces, 0..1
    rows: int
    unsure_rows: int
    seconds: float
    turned: int  # degrees the photo was turned to read it (sideways photos)


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


def layout(boxes, texts, scores) -> tuple[str, list[dict]]:
    """
    Group OCR pieces into printed rows and place each at its column, so tables keep their shape.
    Receipts curl, so one angle for the whole photo puts prices half a row off. Instead each row
    follows the slant of its own widest piece (the item text): a price joins the row whose line,
    extended to the right, passes through it.
    """
    pieces = []
    for box, text, score in zip(boxes, texts, scores):
        (x0, y0), (x1, y1), _, (x3, y3) = box[0], box[1], box[2], box[3]
        pieces.append({
            "text": text, "score": float(score),
            "slope": (y1 - y0) / (x1 - x0) if x1 != x0 else 0.0,
            "x": float(min(p[0] for p in box)), "right": float(max(p[0] for p in box)),
            "cx": float(sum(p[0] for p in box) / 4), "cy": float(sum(p[1] for p in box) / 4),
            "w": float(math.hypot(x1 - x0, y1 - y0)), "h": float(math.hypot(x3 - x0, y3 - y0)),
        })
    if not pieces:
        return "", []

    line_h = statistics.median(p["h"] for p in pieces)

    def y_at(row: list[dict], x: float) -> float:
        anchor = max(row, key=lambda p: p["w"])
        return anchor["cy"] + anchor["slope"] * (x - anchor["cx"])

    rows: list[list[dict]] = []
    for p in sorted(pieces, key=lambda p: p["x"]):
        best, best_gap = None, line_h * 0.5
        for row in rows:
            if p["x"] < max(q["right"] for q in row) - line_h * 0.3:
                continue  # overlaps what's already on that row
            gap = abs(p["cy"] - y_at(row, p["cx"]))
            if gap < best_gap:
                best, best_gap = row, gap
        if best is None:
            rows.append([p])
        else:
            best.append(p)

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
        out_rows.append({"text": line, "unsure": unsure, "cells": [{"text": p["text"], "score": round(p["score"], 3)} for p in row]})
    return "\n".join(lines), out_rows


def read_photo(data: bytes) -> OcrPage:
    """One photo's bytes -> its text laid out as printed. Blocking: call it from a thread."""
    img = prepare(data)
    with _lock:
        started = time.perf_counter()
        boxes, texts, scores, mean, turned = read_image(img)
        seconds = time.perf_counter() - started
    text, rows = layout(boxes, texts, scores)
    return OcrPage(text=text, confidence=mean, rows=len(rows), unsure_rows=sum(r["unsure"] for r in rows),
                   seconds=round(seconds, 2), turned=turned)


def available() -> bool:
    try:
        import rapidocr  # noqa: F401
        return True
    except ImportError:
        return False
