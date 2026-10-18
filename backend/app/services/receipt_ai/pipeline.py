# backend/app/services/receipt_ai/pipeline.py

"""
From uploaded photos to a reviewable receipt:

  choose model and key -> read photos -> AI transcribes (OCR text + cheap model when that
  adds up, else the photos to the admins' model) -> convert to integer money
  -> add the uploader's store discount (switched OFF unless printed) -> suggest who
  each item is for -> check the lines add up to the printed total -> ready / needs_review

The AI never decides who pays what; the split engine does that from the review screen.
"""

import asyncio
import logging
import re
import uuid
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config.settings import settings
from app.db.session import async_session_maker
from app.models.ai import AIModel, AppSetting
from app.models.expense import ConversationSettings
from app.models.receipt import ItemPreference, Receipt, ReceiptAdjustment, ReceiptItem, StoreDiscountRule
from app.models.user import User
from app.services import media_storage
from app.services.money import MoneyError, allocate, format_minor, is_supported, to_minor
from app.services.receipt_ai import ocr
from app.services.receipt_ai.base import ExtractionError, ExtractionResult, ReceiptExtractor
from app.services.receipt_ai.claude import ClaudeExtractor
from app.services.receipt_ai.images import prepare
from app.services.receipt_ai.openai_provider import OpenAIExtractor
from app.services.receipt_ai.schema import ReceiptExtraction
from app.services.split_engine import STAGES, EngineAdjustment, EngineItem, SplitResult, split_receipt

logger = logging.getLogger(__name__)

EXTRACTORS: dict[str, ReceiptExtractor] = {"anthropic": ClaudeExtractor(), "openai": OpenAIExtractor()}
PROVIDER_NAMES = {"anthropic": "Claude", "openai": "OpenAI"}
LOW_CONFIDENCE = 0.6
SCAN_LIMIT_KEY = "receipt_scans_per_month"


class ScanSetupError(Exception):
    """Can't start a scan (no model, no key, over the limit). Safe to show."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


# ------------------------------------------------------------------ model, key, quota

async def resolve_model(db: AsyncSession, conversation_id: uuid.UUID, user: User) -> AIModel:
    """The model app admins chose (the default). People and chats don't pick one."""
    model = (await db.execute(
        select(AIModel).where(AIModel.enabled.is_(True))
        .order_by(AIModel.is_default.desc(), AIModel.sort_order, AIModel.id).limit(1)
    )).scalar_one_or_none()
    if model is None:
        raise ScanSetupError("Receipt scanning is turned off", 503)
    return model


async def resolve_key(db: AsyncSession, user: User, provider: str) -> tuple[str, str]:
    """(key_source, api_key): always the app's key."""
    app_key = settings.ANTHROPIC_API_KEY if provider == "anthropic" else settings.OPENAI_API_KEY
    if app_key:
        return "app", app_key
    raise ScanSetupError(f"{PROVIDER_NAMES.get(provider, provider)} scanning isn't set up on this server", 503)


async def scan_limit(db: AsyncSession) -> int:
    row = await db.get(AppSetting, SCAN_LIMIT_KEY)
    try:
        return int(row.value) if row else settings.RECEIPT_SCANS_PER_MONTH
    except ValueError:
        return settings.RECEIPT_SCANS_PER_MONTH


async def person_scan_limit(db: AsyncSession, user: User) -> dict:
    """This person's scans this month: the app's limit or theirs, plus extra scans given this month."""
    app_limit = await scan_limit(db)
    base = user.scan_limit_override if user.scan_limit_override is not None else app_limit
    extra = user.extra_scans if user.extra_scans_month == _month_start().date() else 0
    return {"limit": base + extra, "app_limit": app_limit, "custom_limit": user.scan_limit_override, "extra_this_month": extra}


def _month_start() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def scans_used(db: AsyncSession, user_id: uuid.UUID) -> int:
    """Scans on the app's key this calendar month (failed ones don't count)."""
    return (await db.execute(
        select(func.count()).select_from(Receipt).where(
            Receipt.uploaded_by == user_id,
            Receipt.key_source == "app",
            Receipt.status != "failed",
            Receipt.created_at >= _month_start(),
        )
    )).scalar_one()


async def prepare_scan(db: AsyncSession, receipt: Receipt, user: User) -> str:
    """Pick model and key, check the limit, stamp them on the receipt. Returns the key."""
    model = await resolve_model(db, receipt.conversation_id, user)
    if model.provider not in EXTRACTORS:
        raise ScanSetupError("That model's provider isn't supported", 503)
    key_source, api_key = await resolve_key(db, user, model.provider)
    if key_source == "app":
        limit = (await person_scan_limit(db, user))["limit"]
        if limit <= 0:
            raise ScanSetupError("Receipt scanning is paused on your account. Questions? Write to support@shareeven.com", 429)
        if await scans_used(db, user.id) >= limit:
            raise ScanSetupError(
                f"You've used all {limit} receipt scans for this month. They reset on the 1st; "
                "until then, add the expense manually", 429
            )
    receipt.provider = model.provider
    receipt.model = model.model_id
    receipt.key_source = key_source
    receipt.status = "processing"
    receipt.error = None
    return api_key


# ------------------------------------------------------------------ the scan itself

def _read_photos(urls: list[str]) -> list[bytes]:
    photos = []
    for url in urls:
        data = media_storage.read_bytes(url)  # decrypted
        if data is None:
            raise ExtractionError("A receipt photo is missing. Upload it again")
        photos.append(data)
    return photos


DISCOUNT_KINDS = ("item_discount", "promotion", "store_discount", "coupon")


def _amount(text: str | None) -> Decimal:
    cleaned = re.sub(r"[^0-9.\-]", "", str(text or "").replace(",", "."))
    return Decimal(cleaned)


def _computed_total(data: ReceiptExtraction) -> Decimal:
    total = sum((_amount(i.line_total) for i in data.items), Decimal(0))
    for a in data.adjustments:
        if a.already_included_in_items:
            continue
        amount = _amount(a.amount)
        total += -abs(amount) if a.kind in DISCOUNT_KINDS else amount
    return total


def adds_up(data: ReceiptExtraction) -> bool:
    """
    Do the lines add up to the printed total, with every line read confidently? The same sum the
    split engine checks later; decides whether the cheap OCR read is trusted.
    """
    if not data.is_receipt or not data.items or not data.total:
        return False
    if any(i.confidence < LOW_CONFIDENCE for i in data.items):
        return False
    try:
        return _computed_total(data) == _amount(data.total)
    except InvalidOperation:
        return False


SUMMARY_LABEL = re.compile(r"\b(promotions?|savings|you saved)\b", re.IGNORECASE)


def without_summary_lines(data: ReceiptExtraction) -> ReceiptExtraction:
    """
    Models sometimes report a summary line ("Promotions: -1.26" under the subtotal, repeating the
    item discounts above it) as one more bill-wide discount, so it counts twice. Drop such lines,
    but only when that makes the lines add up to the printed total exactly.
    """
    if adds_up(data):
        return data
    kept = [a for a in data.adjustments if a.applies_to_items or not SUMMARY_LABEL.search(a.label or "")]
    if len(kept) == len(data.adjustments):
        return data
    fixed = data.model_copy(update={"adjustments": kept})
    return fixed if adds_up(fixed) else data


def _ocr_path_on(receipt: Receipt, extractor: ReceiptExtractor) -> bool:
    return bool(settings.RECEIPT_OCR_MODEL) and receipt.provider == "anthropic" \
        and hasattr(extractor, "extract_text") and ocr.available()


async def _read_with_ocr(receipt: Receipt, extractor, photos: list[bytes], api_key: str) -> tuple[ExtractionResult | None, dict]:
    """OCR on our CPU, then the cheap text model. (None, notes) when the photos aren't clear enough."""
    try:
        pages = await asyncio.to_thread(lambda: [ocr.read_photo(p) for p in photos])
    except Exception:
        logger.exception("Receipt %s: OCR crashed, reading the photos instead", receipt.id)
        return None, {"ocr": {"error": True}}
    notes = {"ocr": {
        "seconds": round(sum(p.seconds for p in pages), 2),
        "confidence": round(min(p.confidence for p in pages), 3),
        "unsure_rows": sum(p.unsure_rows for p in pages),
    }}
    if any(p.confidence < settings.RECEIPT_OCR_MIN_CONFIDENCE or p.rows < 5 for p in pages):
        logger.info("Receipt %s: OCR not clear enough (%s), reading the photos instead", receipt.id, notes["ocr"])
        return None, notes
    try:
        result = await extractor.extract_text([p.text for p in pages], receipt.note, settings.RECEIPT_OCR_MODEL, api_key)
    except ExtractionError as e:
        logger.info("Receipt %s: text model failed (%s), reading the photos instead", receipt.id, e)
        return None, notes
    return result, notes


def _combined_usage(path: str, notes: dict, *results: ExtractionResult) -> dict:
    """Token totals across every model call (admin stats sum these), plus what each call used."""
    calls = [{"model": r.model, **r.usage} for r in results]
    return {
        "input_tokens": sum(c.get("input_tokens") or 0 for c in calls),
        "output_tokens": sum(c.get("output_tokens") or 0 for c in calls),
        "cache_read_input_tokens": sum(c.get("cache_read_input_tokens") or 0 for c in calls),
        "path": path,
        **notes,
        "calls": calls,
    }


async def read_receipt(receipt: Receipt, extractor: ReceiptExtractor, photos: list[bytes], api_key: str) -> ExtractionResult:
    """
    Cheap path first: OCR text -> cheaper text model (~3 cents). Trusted only when every line was
    read confidently and the lines add up to the printed total; otherwise the photos go to the
    model the admins chose, as before.
    """
    cheap, notes = None, {}
    if _ocr_path_on(receipt, extractor):
        cheap, notes = await _read_with_ocr(receipt, extractor, photos, api_key)
        if cheap is not None:
            cheap.data = without_summary_lines(cheap.data)
        if cheap is not None and adds_up(cheap.data):
            cheap.usage = _combined_usage("ocr", notes, cheap)
            return cheap
        if cheap is not None:
            logger.info("Receipt %s: OCR read doesn't add up, reading the photos with %s", receipt.id, receipt.model)

    images = await asyncio.to_thread(lambda: [prepare(p) for p in photos])
    try:
        result = await extractor.extract(images, receipt.note, receipt.model, api_key)
        result.data = without_summary_lines(result.data)
    except ExtractionError:
        if cheap is None:
            raise
        # The cheap read didn't add up, but it's better than nothing: the review screen flags the lines
        cheap.usage = _combined_usage("ocr", notes, cheap)
        return cheap
    if notes:
        result.usage = _combined_usage("ocr_then_photos", notes, *([cheap] if cheap else []), result)
    return result


async def run_scan(receipt_id: uuid.UUID, api_key: str) -> None:
    """Background task: read the photos, fill in the receipt, tell the uploader."""
    from app.websocket.routes import publish_users  # avoid import cycle at startup

    async with async_session_maker() as db:
        receipt = await db.get(Receipt, receipt_id)
        if receipt is None:
            return
        extractor = EXTRACTORS[receipt.provider]
        try:
            photos = await asyncio.to_thread(_read_photos, receipt.image_urls)
            result = await read_receipt(receipt, extractor, photos, api_key)
            receipt.model = result.model or receipt.model
            receipt.usage = result.usage
            await apply_extraction(db, receipt, result.data)
        except ExtractionError as e:
            receipt.status, receipt.error = "failed", str(e)[:500]
        except Exception:
            logger.exception("Receipt scan %s crashed", receipt_id)
            receipt.status, receipt.error = "failed", "Something went wrong reading this receipt. Try again"
        receipt.updated_at = datetime.now(timezone.utc)
        await db.commit()
        logger.info("Receipt %s scanned with %s (%s key): %s", receipt_id, receipt.model, receipt.key_source, receipt.status)
        if receipt.uploaded_by:
            await publish_users([str(receipt.uploaded_by)], {
                "type": "receipt_scan_ready",
                "conversationId": str(receipt.conversation_id),
                "receiptId": str(receipt.id),
                "status": receipt.status,
                "error": receipt.error,
            })


def store_key(name: str | None) -> str | None:
    key = re.sub(r"[^a-z0-9]", "", (name or "").lower())
    return key[:60] or None


def item_key(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", name.lower())).strip()[:120]


def _quantity(text: str | None) -> Decimal:
    try:
        value = Decimal(str(text).replace(",", ".")) if text else Decimal(1)
    except InvalidOperation:
        value = Decimal(1)
    return value if value > 0 else Decimal(1)


async def apply_extraction(db: AsyncSession, receipt: Receipt, data: ReceiptExtraction) -> None:
    receipt.raw_extraction = data.model_dump(mode="json")
    if not data.is_receipt:
        receipt.status, receipt.error = "failed", "This doesn't look like a receipt"
        return

    warnings = list(data.warnings)[:10]
    chat = await db.get(ConversationSettings, receipt.conversation_id)
    currency = (data.currency or "").upper()
    if not is_supported(currency):
        currency = chat.default_currency if chat else "EUR"
        warnings.append(f"Currency not clear on the receipt, using {currency}")
    receipt.currency = currency
    receipt.store_name = (data.store_name or "")[:120] or None
    receipt.store_key = store_key(data.store_name)
    receipt.prices_include_tax = data.prices_include_tax
    if data.purchased_at:
        try:
            parsed = datetime.fromisoformat(data.purchased_at)
            receipt.purchased_at = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass

    def money(text: str | None, what: str) -> int | None:
        if text is None or not str(text).strip():
            return None
        try:
            return to_minor(text, currency)
        except MoneyError:
            warnings.append(f"Couldn't read the {what} '{text}'")
            return None

    receipt.printed_total_minor = money(data.total, "total")

    member_ids = {str(m) for m in await _member_ids(db, receipt.conversation_id)}
    prefs = {
        p.item_key: p for p in (await db.execute(
            select(ItemPreference).where(ItemPreference.conversation_id == receipt.conversation_id)
        )).scalars().all()
    }
    names = await _usernames(db, member_ids)
    everyone = [{"user_id": u, "value": "1"} for u in sorted(member_ids, key=lambda u: names.get(u, ""))]

    receipt.items = []
    receipt.adjustments = []
    items: list[ReceiptItem] = []
    for position, extracted in enumerate(data.items):
        gross = money(extracted.line_total, "price") or 0
        assignments, reason = everyone, None
        pref = prefs.get(item_key(extracted.name))
        if pref and pref.user_ids and set(pref.user_ids) <= member_ids:
            assignments = [{"user_id": u, "value": "1"} for u in pref.user_ids]
            reason = "Usually for " + ", ".join(names.get(u, "someone") for u in pref.user_ids)
        item = ReceiptItem(
            position=position,
            raw_text=(extracted.raw_text or "")[:300],
            name=(extracted.name or extracted.raw_text or "Item")[:200],
            quantity=_quantity(extracted.quantity),
            unit=extracted.unit,
            unit_price_minor=money(extracted.unit_price, "unit price"),
            gross_minor=gross,
            category=(extracted.category or None) and extracted.category[:40].lower(),
            flags=list(dict.fromkeys(extracted.flags)),
            tax_code=(extracted.tax_code or None) and extracted.tax_code[:10],
            confidence=max(0.0, min(1.0, extracted.confidence)),
            split_mode="equal",
            assignments=assignments,
            ai_suggestion_reason=reason,
        )
        items.append(item)
        receipt.items.append(item)
    await db.flush()  # item ids

    for position, extracted in enumerate(data.adjustments):
        if extracted.already_included_in_items:
            continue  # e.g. VAT inside European prices: shown on the receipt, not added again
        amount = money(extracted.amount, "adjustment")
        if not amount:
            continue
        if extracted.kind in ("item_discount", "promotion", "store_discount", "coupon") and amount > 0:
            amount = -amount  # discounts are always negative
        targets = [items[i].id for i in extracted.applies_to_items if 0 <= i < len(items)]
        scope = "bill" if not targets else ("item" if len(targets) == 1 else "group")
        receipt.adjustments.append(ReceiptAdjustment(
            position=position,
            kind=extracted.kind,
            label=(extracted.label or extracted.kind)[:200],
            amount_minor=amount,
            percent=_percent(extracted.percent),
            scope=scope,
            item_ids=targets,
            # A deal over several items ("any 3 for 2"): each item in it costs the same per unit
            allocation="per_unit" if extracted.kind == "promotion" and scope == "group" else "proportional",
            assignee_ids=[],
            source="printed",
            enabled=True,
        ))

    await db.flush()  # adjustment ids
    warnings.extend(match_bill_discounts(receipt))
    await _add_store_rule(db, receipt)
    await db.flush()
    result, error = compute(receipt)
    if error:
        warnings.append(error)
    if result and result.difference not in (None, 0):
        warnings.append(
            f"The lines add up to {format_minor(result.computed_total, currency)} but the receipt total is "
            f"{format_minor(receipt.printed_total_minor, currency)}. Check the highlighted lines"
        )
    if receipt.printed_total_minor is None:
        warnings.append("Couldn't find the total on the receipt")
    low = [i.name for i in items if i.confidence is not None and i.confidence < LOW_CONFIDENCE]
    if low:
        warnings.append("Not sure about: " + ", ".join(low[:5]))
    if not items:
        warnings.append("No items found")

    clean = result is not None and result.difference == 0 and not low and items and not error
    receipt.status = "ready" if clean else "needs_review"
    receipt.warnings = [w[:300] for w in warnings[:15]]


def _percent(text: str | None) -> Decimal | None:
    if not text:
        return None
    try:
        return Decimal(str(text).replace("%", "").replace(",", ".").strip())
    except InvalidOperation:
        return None


async def _member_ids(db: AsyncSession, conversation_id: uuid.UUID) -> list[uuid.UUID]:
    from app.models.conversation_member import ConversationMember
    return list((await db.execute(
        select(ConversationMember.user_id).where(ConversationMember.conversation_id == conversation_id)
    )).scalars().all())


async def _usernames(db: AsyncSession, user_ids) -> dict[str, str]:
    if not user_ids:
        return {}
    rows = (await db.execute(select(User.id, User.username).where(User.id.in_([uuid.UUID(u) for u in user_ids])))).all()
    return {str(i): n for i, n in rows}


# ------------------------------------------------------------------ store discount rules

STORE_RULE_EXCLUDED_FLAGS = {"voided", "deposit", "bag"}
DISCOUNT_KINDS = {"item_discount", "promotion", "store_discount", "coupon"}


async def _add_store_rule(db: AsyncSession, receipt: Receipt) -> None:
    """
    The uploader's own store discount (e.g. Tesco 10%) when the receipt doesn't show it.
    Added switched OFF: the receipt is the source of truth, the person turns it on.
    """
    if not receipt.store_key or not receipt.uploaded_by:
        return
    if any(a.kind == "store_discount" for a in receipt.adjustments):
        return  # already applied at the till
    rules = (await db.execute(
        select(StoreDiscountRule).where(StoreDiscountRule.owner_id == receipt.uploaded_by, StoreDiscountRule.active.is_(True))
    )).scalars().all()
    rule = next((r for r in rules if r.store_key and r.store_key in receipt.store_key), None)
    if rule is None:
        return
    discounted = {i for a in receipt.adjustments if STAGES.get(a.kind) == 1 and a.amount_minor < 0 for i in a.item_ids}
    excluded = {c.lower() for c in rule.excluded_categories or []}
    eligible = [
        item.id for item in receipt.items
        if not (set(item.flags or []) & STORE_RULE_EXCLUDED_FLAGS)
        and (item.category or "") not in excluded
        and (rule.stacks_with_reduced or ("reduced" not in (item.flags or []) and item.id not in discounted))
    ]
    if not eligible:
        return
    adjustment = ReceiptAdjustment(
        position=len(receipt.adjustments),
        kind="store_discount",
        label=f"{rule.store_name} discount",  # the rate is shown and adjustable separately
        amount_minor=0,
        percent=Decimal(rule.percent),
        scope="bill",
        item_ids=eligible,
        allocation="proportional",
        assignee_ids=[],
        source="store_rule",
        enabled=False,
    )
    receipt.adjustments.append(adjustment)
    refresh_percent_amounts(receipt)


def _plain_percent(value: Decimal) -> str:
    """10 -> "10", 12.50 -> "12.5" (never "1E+1")."""
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


# Usual rates for staff, member and coupon discounts, tried when a bill-wide discount isn't explained
COMMON_PERCENTS = [Decimal(p) for p in ("5", "10", "12.5", "15", "20", "25", "30", "33.33", "40", "50")]


def match_bill_discounts(receipt: Receipt) -> list[str]:
    """
    Work out which items a printed bill-wide discount was for, when the receipt doesn't say
    (Tesco prints colleague discounts only in the totals). Pure arithmetic on what was printed:
    - it equals exactly what a set of items cost after their own discounts (e.g. the "Special Offer"
      items it made free), or
    - it is a usual percentage of the items not already covered (e.g. 10% of everything else).
    The amounts are never changed; only the items each discount is spread over. Returns notes for
    the review screen. A discount that matches nothing stays on the whole bill.
    """
    open_discounts = [
        a for a in receipt.adjustments
        if a.source == "printed" and a.enabled and not a.item_ids and a.kind in ("store_discount", "coupon") and a.amount_minor < 0
    ]
    if not open_discounts:
        return []
    net = after_own_discounts(receipt)
    eligible = [i for i in receipt.items if i.id in net and not (set(i.flags or []) & STORE_RULE_EXCLUDED_FLAGS)]
    if not eligible:
        return []
    own: dict[int, list[ReceiptAdjustment]] = {i.id: [] for i in eligible}
    for a in receipt.adjustments:
        if a.enabled and STAGES.get(a.kind) == 1 and a.amount_minor < 0:
            for t in a.item_ids:
                if t in own:
                    own[t].append(a)

    # Sets of items a store might have discounted together, most specific first
    groups: list[list[int]] = []
    for label in dict.fromkeys(re.sub(r"\s+", " ", a.label.strip().lower()) for adjs in own.values() for a in adjs):
        groups.append([i.id for i in eligible if any(re.sub(r"\s+", " ", a.label.strip().lower()) == label for a in own[i.id])])
    groups.append([i.id for i in eligible if "reduced" in (i.flags or [])])
    groups.append([i.id for i in eligible if own[i.id]])
    groups.append([i.id for i in eligible if not own[i.id]])

    currency = receipt.currency or "EUR"
    notes: list[str] = []
    # Items a bill-stage discount already points at (the AI read it from the receipt or the note):
    # treated as covered, so e.g. 10% is looked for among the other items
    claimed: set[int] = {
        t for a in receipt.adjustments
        if a.enabled and STAGES.get(a.kind) == 2 and a.item_ids and a.amount_minor < 0 for t in a.item_ids
    }
    unmatched: list[ReceiptAdjustment] = []

    def assign(a: ReceiptAdjustment, ids: list[int]) -> None:
        a.item_ids = ids
        a.scope = "item" if len(ids) == 1 else "group"
        a.allocation = "proportional"

    # 1. It made a set of items free: the amount is exactly what they still cost
    for a in sorted(open_discounts, key=lambda x: x.amount_minor):
        group = next((g for g in groups if g and not claimed & set(g)
                      and abs(sum(max(net[t], 0) for t in g) + a.amount_minor) <= 1), None)
        if group is None:
            unmatched.append(a)
            continue
        assign(a, group)
        claimed |= set(group)
        notes.append(f"{a.label} ({format_minor(a.amount_minor, currency)}) is exactly what {len(group)} "
                     f"item{'s' if len(group) != 1 else ''} still cost, so it's applied to those")

    # 2. A usual percentage of what's left (rounding at the till can differ by a cent or two)
    for a in unmatched:
        rest = [i.id for i in eligible if i.id not in claimed]
        bases = [rest, [t for t in rest if not own[t]]]
        found = None
        for base in bases:
            total = sum(max(net[t], 0) for t in base)
            for percent in COMMON_PERCENTS:
                if base and abs(Decimal(total) * percent / 100 + a.amount_minor) <= max(Decimal(2), Decimal(-a.amount_minor) / 200):
                    found = (base, percent)
                    break
            if found:
                break
        if not found:
            continue
        base, percent = found
        assign(a, base)
        a.percent = a.percent or percent
        everything = len(base) == len(eligible)
        notes.append(f"{a.label} ({format_minor(a.amount_minor, currency)}) is {_plain_percent(percent)}% of "
                     f"{'all the items' if everything else f'the other {len(base)} items'}, so it's applied to "
                     f"{'them' if everything else 'those'}")
    return notes


def after_own_discounts(receipt: Receipt) -> dict[int, int]:
    """Price of each item after its own discounts (same allocation the engine uses)."""
    stage1: dict[int, int] = {i.id: i.gross_minor for i in receipt.items if "voided" not in (i.flags or [])}
    for a in sorted(receipt.adjustments, key=lambda x: (0 if len(x.item_ids or []) == 1 else 1, x.position)):  # as the engine
        if not a.enabled or STAGES.get(a.kind) != 1:
            continue
        targets = [t for t in a.item_ids if t in stage1] or list(stage1)
        for t, part in zip(targets, allocate(a.amount_minor, [max(stage1[t], 0) for t in targets])):
            stage1[t] += part
    return stage1


def refresh_percent_amounts(receipt: Receipt) -> None:
    """Percentage discounts we added (not printed) follow the items they cover."""
    stage1 = after_own_discounts(receipt)
    for a in receipt.adjustments:
        if a.source == "printed" or a.percent is None or a.kind not in DISCOUNT_KINDS:
            continue
        base = sum(max(stage1.get(t, 0), 0) for t in a.item_ids) if a.item_ids else sum(max(v, 0) for v in stage1.values())
        a.amount_minor = -int((Decimal(base) * Decimal(a.percent) / 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


# ------------------------------------------------------------------ split + serialization

def engine_inputs(receipt: Receipt) -> tuple[list[EngineItem], list[EngineAdjustment]]:
    items = [
        EngineItem(
            id=i.id,
            gross=i.gross_minor,
            split_mode=i.split_mode,
            quantity=Decimal(i.quantity) if i.quantity else Decimal(1),
            assignments=[(a["user_id"], _quantity(a.get("value"))) for a in (i.assignments or [])],
            voided="voided" in (i.flags or []),
        )
        for i in receipt.items
    ]
    adjustments = [
        EngineAdjustment(
            id=a.id, kind=a.kind, amount=a.amount_minor, scope=a.scope, item_ids=list(a.item_ids or []),
            allocation=a.allocation, assignee_ids=list(a.assignee_ids or []), enabled=a.enabled, position=a.position,
        )
        for a in receipt.adjustments
    ]
    return items, adjustments


def compute(receipt: Receipt) -> tuple[SplitResult | None, str | None]:
    items, adjustments = engine_inputs(receipt)
    try:
        return split_receipt(items, adjustments, receipt.printed_total_minor), None
    except MoneyError as e:
        return None, str(e)


def outside_receipt_minor(receipt: Receipt) -> int:
    return sum(a.amount_minor for a in receipt.adjustments if a.enabled and a.source != "printed")


def effective_payers(receipt: Receipt, total: int) -> list[dict]:
    """Several payers keep their amounts; one payer (or none = the uploader) pays the whole bill."""
    if receipt.payers and len(receipt.payers) > 1:
        return receipt.payers
    if receipt.payers:
        return [{"user_id": receipt.payers[0]["user_id"], "amount_minor": total}]
    return [{"user_id": str(receipt.uploaded_by), "amount_minor": total}] if receipt.uploaded_by else []


def serialize(receipt: Receipt) -> dict:
    result, error = compute(receipt) if receipt.items else (None, None)
    index_of = {item.id: idx for idx, item in enumerate(receipt.items)}
    currency = receipt.currency or "EUR"
    totals = None
    if result:
        outside = outside_receipt_minor(receipt)
        totals = {
            "computed_total_minor": result.computed_total,
            "computed_total_display": format_minor(result.computed_total, currency),
            "printed_total_minor": result.printed_total,
            # Compared without the extras people added that aren't on the receipt (own discounts, tips...)
            "difference_minor": None if result.printed_total is None else result.printed_total - (result.computed_total - outside),
            "outside_receipt_minor": outside,
            "unassigned_minor": result.unassigned_amount,
            "unassigned_item_indexes": [index_of[i] for i in result.unassigned_items],
            "people": [
                {
                    "user_id": user_id,
                    "amount_minor": amount,
                    "amount_display": format_minor(amount, currency),
                    "breakdown": [
                        {**part, "id": index_of.get(part["id"], part["id"])} if part["type"] == "item" else
                        {**part, "id": next((n for n, a in enumerate(receipt.adjustments) if a.id == part["id"]), None)}
                        for part in result.person_breakdown.get(user_id, [])
                    ],
                }
                for user_id, amount in sorted(result.person_totals.items(), key=lambda x: -x[1])
            ],
        }
    return {
        "id": str(receipt.id),
        "conversation_id": str(receipt.conversation_id),
        "uploaded_by": str(receipt.uploaded_by) if receipt.uploaded_by else None,
        "status": receipt.status,
        "error": receipt.error,
        "images": [media_storage.sign_url(u) for u in receipt.image_urls or []],
        "note": receipt.note,
        "provider": receipt.provider,
        "model": receipt.model,
        "key_source": receipt.key_source,
        "store_name": receipt.store_name,
        "purchased_at": receipt.purchased_at.isoformat() if receipt.purchased_at else None,
        "currency": receipt.currency,
        "printed_total_minor": receipt.printed_total_minor,
        "prices_include_tax": receipt.prices_include_tax,
        "warnings": receipt.warnings or [],
        "items": [
            {
                "id": i.id,
                "name": i.name,
                "raw_text": i.raw_text,
                "quantity": f"{Decimal(i.quantity).normalize():f}" if i.quantity is not None else "1",
                "unit": i.unit,
                "unit_price_minor": i.unit_price_minor,
                "gross_minor": i.gross_minor,
                "net_minor": result.item_net.get(i.id) if result else None,
                "category": i.category,
                "flags": i.flags or [],
                "confidence": float(i.confidence) if i.confidence is not None else None,
                "split_mode": i.split_mode,
                "assignments": i.assignments or [],
                "suggestion": i.ai_suggestion_reason,
            }
            for i in receipt.items
        ],
        "adjustments": [
            {
                "id": a.id,
                "kind": a.kind,
                "label": a.label,
                "amount_minor": a.amount_minor,
                "percent": f"{Decimal(a.percent).normalize():f}" if a.percent is not None else None,
                "scope": a.scope,
                "item_indexes": [index_of[i] for i in a.item_ids or [] if i in index_of],
                "allocation": a.allocation,
                "assignee_ids": a.assignee_ids or [],
                "source": a.source,
                "enabled": a.enabled,
            }
            for a in receipt.adjustments
        ],
        "payers": effective_payers(receipt, result.computed_total if result else 0),
        "totals": totals,
        "calc_error": error,
        "expense_id": str(receipt.expense_id) if receipt.expense_id else None,
        "created_at": receipt.created_at.isoformat() if receipt.created_at else None,
    }
