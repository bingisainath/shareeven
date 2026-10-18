# backend/app/services/receipt_ai/learning.py

"""
What a chat's receipts teach the next scan:
- where each item is printed on the photo (from the OCR), so the review screen can show that line;
- split rules: items of a category are for the same people every time ('household' -> everyone);
- corrections: what people fixed on an earlier receipt from the same store. Renames and categories
  are applied again directly; other fixes (a misread price, a missed discount) go to the AI as hints.
Everything stays inside the chat it was learnt in.
"""

import re
from difflib import SequenceMatcher

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.receipt import Receipt, ReceiptCorrection, SplitRule
from app.services.money import MoneyError, format_minor, to_minor

# Categories the AI picks from and split rules use (schema.ExtractedItem.category says the same)
RECEIPT_CATEGORIES = {
    "produce": "Fruit & veg", "dairy": "Dairy", "bakery": "Bakery", "meat": "Meat", "fish": "Fish",
    "frozen": "Frozen", "pantry": "Pantry", "snacks": "Snacks", "drinks": "Drinks", "alcohol": "Alcohol",
    "household": "Household & cleaning", "personal_care": "Personal care", "health": "Health", "baby": "Baby",
    "pet": "Pet", "bags": "Bags", "other": "Other",
}

# Learning from one receipt stops here: more fixes than this means it was read badly, not a pattern
MAX_CORRECTIONS_PER_RECEIPT = 15
HINT_KINDS = ("price", "not_item", "missed_item", "not_adjustment", "missed_adjustment", "adjustment_kind")


# ------------------------------------------------------------------ categories and rules

def rule_category(category: str | None, flags: list[str]) -> str | None:
    """Which split rule an item falls under: flags first (an alcohol flag beats 'drinks'), then its category."""
    if "alcohol" in flags:
        return "alcohol"
    if "bag" in flags:
        return "bags"
    category = (category or "").strip().lower().replace(" ", "_")
    return category if category in RECEIPT_CATEGORIES else None


async def split_rules(db: AsyncSession, conversation_id) -> dict[str, SplitRule]:
    rows = (await db.execute(select(SplitRule).where(SplitRule.conversation_id == conversation_id))).scalars().all()
    return {r.category: r for r in rows}


# ------------------------------------------------------------------ where each item is printed

def _squash(text: str | None) -> str:
    return re.sub(r"[^a-z0-9.,]", "", (text or "").lower())


def locate_items(raw_texts: list[str | None], pages: list) -> list[dict | None]:
    """
    Match each item's printed line (raw_text, from the AI) to the OCR rows it came from: one row, or
    two or three when a long name wraps. Items come in printed order, so the search starts after the
    previous item's rows (duplicates like two "Bananas Loose" lines land on the right ones).
    """
    rows = [(n, line) for n, page in enumerate(pages) for line in page.lines]
    if not rows:
        return [None] * len(raw_texts)
    squashed = [_squash(line["text"]) for _, line in rows]
    found: list[dict | None] = []
    start = 0
    for raw in raw_texts:
        target = _squash(raw)
        if len(target) < 3:
            found.append(None)
            continue
        best = None
        for first in (range(start, len(rows)), range(len(rows))):
            for i in first:
                for span in (1, 2, 3):
                    j = i + span
                    if j > len(rows) or rows[j - 1][0] != rows[i][0]:
                        break
                    score = SequenceMatcher(None, target, "".join(squashed[i:j]), autojunk=False).ratio()
                    if best is None or score > best[0]:
                        best = (score, i, j)
            if best and best[0] >= 0.75:
                break  # good enough ahead of the previous item; only look behind it if not
        if best is None or best[0] < 0.6:
            found.append(None)
            continue
        _, i, j = best
        start = j
        boxes = [rows[k][1]["box"] for k in range(i, j)]
        photo = rows[i][0]
        found.append({
            "photo": photo,
            "box": [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)],
            "turned": pages[photo].turned,
        })
    return found


# ------------------------------------------------------------------ corrections

PRICE = re.compile(r"[-−]?\s?[€$£₹]?\s?\d+(?:[.,]\d+)?\s?(?:each|kg|/kg)?")


def line_key(raw_text: str | None) -> str:
    """A printed line without its quantity and prices, so the same product matches on later receipts."""
    text = re.sub(r"^\s*\d+\s+", "", (raw_text or "").lower())
    text = PRICE.sub(" ", text)
    return re.sub(r"[^a-z0-9]", "", text)[:120]


def _minor(text, currency: str) -> int | None:
    try:
        return to_minor(text, currency) if text not in (None, "") else None
    except MoneyError:
        return None


def corrections_from(receipt: Receipt) -> list[tuple[str, str, str]]:
    """(kind, original, corrected) for what people changed compared with the AI's reading."""
    raw = receipt.raw_extraction or {}
    if not raw.get("is_receipt"):
        return []
    currency = receipt.currency or "EUR"
    changes: list[tuple[str, str, str]] = []

    # Items: the AI's lines keep their printed text (raw_text) through edits; lines people added have none
    left: dict[str, list] = {}
    for item in receipt.items:
        if item.raw_text:
            left.setdefault(item.raw_text, []).append(item)
    for ai in raw.get("items") or []:
        printed = (ai.get("raw_text") or "")[:300]
        key = line_key(printed)
        if not key:
            continue
        matches = left.get(printed)
        if not matches:
            changes.append(("not_item", printed.strip()[:300], ""))
            continue
        item = matches.pop(0)
        if item.name.strip().lower() != (ai.get("name") or "").strip().lower():
            changes.append(("rename", key, item.name.strip()[:300]))
        if item.category and item.category != (ai.get("category") or "").strip().lower():
            changes.append(("category", key, item.category))
        ai_price = _minor(ai.get("line_total"), currency)
        if ai_price is not None and item.gross_minor != ai_price:
            changes.append(("price", printed.strip()[:300], format_minor(item.gross_minor, currency)))
    for item in receipt.items:
        if not item.raw_text:
            changes.append(("missed_item", item.name.strip()[:300], format_minor(item.gross_minor, currency)))

    # Discounts and charges printed on the receipt, by label (amounts can be recalculated from a percent)
    ai_adjustments: dict[str, list[dict]] = {}
    for a in raw.get("adjustments") or []:
        if not a.get("already_included_in_items"):
            ai_adjustments.setdefault((a.get("label") or "").strip().lower(), []).append(a)
    for a in receipt.adjustments:
        if a.source != "printed":
            continue
        label = a.label.strip().lower()
        matches = ai_adjustments.get(label)
        if not matches:
            changes.append(("missed_adjustment", a.label.strip()[:300], f"{a.kind} {format_minor(a.amount_minor, currency)}"))
            continue
        ai = matches.pop(0)
        if ai.get("kind") != a.kind:
            changes.append(("adjustment_kind", a.label.strip()[:300], a.kind))
    for label, rest in ai_adjustments.items():
        for a in rest:
            changes.append(("not_adjustment", f"{a.get('label') or label} {a.get('amount') or ''}".strip()[:300], ""))
    return changes


async def learn_corrections(db: AsyncSession, receipt: Receipt) -> int:
    """Remember what people fixed on this receipt, for the next scan from the same store in this chat."""
    if not receipt.store_key:
        return 0
    changes = list(dict.fromkeys(corrections_from(receipt)))
    if not changes or len(changes) > MAX_CORRECTIONS_PER_RECEIPT:
        return 0
    for kind, original, corrected in changes:
        row = (await db.execute(select(ReceiptCorrection).where(
            ReceiptCorrection.conversation_id == receipt.conversation_id, ReceiptCorrection.store_key == receipt.store_key,
            ReceiptCorrection.kind == kind, ReceiptCorrection.original == original,
        ))).scalar_one_or_none()
        if row is None:
            db.add(ReceiptCorrection(conversation_id=receipt.conversation_id, store_key=receipt.store_key,
                                     store_name=receipt.store_name, kind=kind, original=original, corrected=corrected, times=1))
        else:
            row.corrected, row.store_name, row.times = corrected, receipt.store_name, row.times + 1
    return len(changes)


async def store_fixes(db: AsyncSession, conversation_id, store_key: str | None) -> tuple[dict[str, str], dict[str, str]]:
    """Renames and categories people chose for lines from this store: {line_key: name}, {line_key: category}."""
    if not store_key:
        return {}, {}
    rows = (await db.execute(select(ReceiptCorrection).where(
        ReceiptCorrection.conversation_id == conversation_id, ReceiptCorrection.store_key == store_key,
        ReceiptCorrection.kind.in_(("rename", "category")),
    ))).scalars().all()
    renames = {r.original: r.corrected for r in rows if r.kind == "rename" and r.corrected}
    categories = {r.original: r.corrected for r in rows if r.kind == "category" and r.corrected}
    return renames, categories


def _hint(row: ReceiptCorrection) -> str:
    original, corrected = row.original, row.corrected
    return {
        "price": f'the line "{original}" was misread; its price is {corrected}',
        "not_item": f'"{original}" is not an item',
        "missed_item": f'an item "{original}" ({corrected}) was missed',
        "not_adjustment": f'"{original}" is not a discount or charge to count',
        "missed_adjustment": f'"{original}" is a real {corrected} on the bill',
        "adjustment_kind": f'"{original}" is a {corrected}',
    }[row.kind]


async def correction_hints(db: AsyncSession, conversation_id, limit: int = 30) -> str | None:
    """What people fixed on earlier receipts in this chat, as notes for the AI (by store)."""
    rows = (await db.execute(
        select(ReceiptCorrection)
        .where(ReceiptCorrection.conversation_id == conversation_id, ReceiptCorrection.kind.in_(HINT_KINDS))
        .order_by(ReceiptCorrection.updated_at.desc()).limit(limit)
    )).scalars().all()
    if not rows:
        return None
    by_store: dict[str, list[str]] = {}
    for row in rows:
        by_store.setdefault(row.store_name or row.store_key, []).append(_hint(row))
    lines = [f"- {store}: " + "; ".join(hints) for store, hints in by_store.items()]
    return ("People in this group corrected earlier receipts. If this receipt is from one of these stores, "
            "use these notes (what is printed on this receipt still wins):\n" + "\n".join(lines))
