# backend/app/api/v1/receipts.py

"""
Receipt scanning: upload photos -> AI reads them in the background -> people review
who each item is for -> save as an itemized expense. Anyone in the chat can review.
"""

import uuid
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_current_user
from app.config.settings import settings
from app.core import rate_limit as rl
from app.db.session import get_db
from app.models.expense import Expense
from app.models.receipt import ItemPreference, Receipt, ReceiptAdjustment, ReceiptItem, SplitRule
from app.models.user import User
from app.services import expense_service as svc
from app.services import media_storage
from app.services.money import MoneyError, format_minor, is_supported, to_minor
from app.services.receipt_ai import learning, pipeline
from app.services.split_engine import ADJUSTMENT_KINDS, ALLOCATIONS, ITEM_SPLIT_MODES, validate_payers
from app.websocket.routes import publish_users
from app.schemas.receipts import (
    SplitRulesRequest,
    CreateReceiptRequest, UpdateReceiptRequest, SaveReceiptRequest,
)

router = APIRouter(tags=["Receipts"])

ITEM_FLAGS = {"reduced", "deposit", "bag", "weighed", "voided", "alcohol"}


def _ok(data, message: str = "OK") -> dict:
    return {"success": True, "message": message, "data": data}


async def _load(db: AsyncSession, receipt_id: uuid.UUID, user: User) -> tuple[Receipt, svc.Access]:
    receipt = await db.get(Receipt, receipt_id)
    if receipt is None:
        raise HTTPException(status_code=404, detail="Receipt not found")
    return receipt, await svc.load_access(db, receipt.conversation_id, user)


def _setup_error(e: pipeline.ScanSetupError) -> HTTPException:
    return HTTPException(status_code=e.status_code, detail=str(e))


@router.post("/conversations/{conversation_id}/receipts")
async def create_receipt(
    conversation_id: uuid.UUID,
    body: CreateReceiptRequest,
    background: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await rl.enforce((rl.RECEIPT_SCANS_PER_USER, str(current_user.id)))
    await svc.load_access(db, conversation_id, current_user)
    if len(body.image_urls) > settings.RECEIPT_MAX_IMAGES:
        raise HTTPException(status_code=400, detail=f"Up to {settings.RECEIPT_MAX_IMAGES} photos per receipt")
    urls = [media_storage.unsigned(u) for u in body.image_urls]
    if not all(media_storage.is_stored_image_url(u) for u in urls):
        raise HTTPException(status_code=400, detail="Upload the receipt photos first")

    now = datetime.now(timezone.utc)
    receipt = Receipt(
        id=uuid.uuid4(), conversation_id=conversation_id, uploaded_by=current_user.id, image_urls=urls,
        note=(body.note or "").strip() or None, status="processing", warnings=[], created_at=now, updated_at=now,
        items=[], adjustments=[],
    )
    db.add(receipt)
    try:
        api_key = await pipeline.prepare_scan(db, receipt, current_user)
    except pipeline.ScanSetupError as e:
        await db.rollback()
        raise _setup_error(e)
    await db.commit()
    background.add_task(pipeline.run_scan, receipt.id, api_key)
    return _ok(pipeline.serialize(receipt), "Reading the receipt…")


@router.get("/conversations/{conversation_id}/receipts")
async def list_open_receipts(
    conversation_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Receipts still being read or reviewed (not saved as an expense yet)."""
    await svc.load_access(db, conversation_id, current_user)
    rows = (await db.execute(
        select(Receipt).where(Receipt.conversation_id == conversation_id, Receipt.status != "saved")
        .order_by(Receipt.created_at.desc()).limit(20)
    )).scalars().all()
    return _ok([
        {"id": str(r.id), "status": r.status, "store_name": r.store_name, "uploaded_by": str(r.uploaded_by) if r.uploaded_by else None,
         "images": [media_storage.sign_url(u) for u in r.image_urls[:1]], "created_at": r.created_at.isoformat()}
        for r in rows
    ])


@router.get("/receipts/{receipt_id}")
async def get_receipt(
    receipt_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    receipt, _ = await _load(db, receipt_id, current_user)
    return _ok(pipeline.serialize(receipt))


def _minor(value: Optional[str], currency: str, what: str) -> Optional[int]:
    if value is None or not value.strip():
        return None
    try:
        return to_minor(value, currency)
    except MoneyError:
        raise HTTPException(status_code=400, detail=f"{what} '{value}' isn't a valid number")


def _decimal(value: Optional[str], what: str) -> Optional[Decimal]:
    if value is None or not value.strip():
        return None
    try:
        number = Decimal(value.replace(",", ".").replace("%", "").strip())
    except InvalidOperation:
        raise HTTPException(status_code=400, detail=f"{what} '{value}' isn't a valid number")
    if number < 0:
        raise HTTPException(status_code=400, detail=f"{what} can't be negative")
    return number


async def _editable(db: AsyncSession, receipt: Receipt) -> None:
    if receipt.status == "processing":
        raise HTTPException(status_code=409, detail="Still reading this receipt")
    if receipt.expense_id:
        expense = await db.get(Expense, receipt.expense_id)
        if expense and expense.locked:
            raise HTTPException(status_code=403, detail="This expense is locked. Ask an admin to unlock it")


@router.put("/receipts/{receipt_id}")
async def update_receipt(
    receipt_id: uuid.UUID,
    body: UpdateReceiptRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Save the review screen (items, who they're for, discounts, payers) and recompute the split."""
    receipt, _ = await _load(db, receipt_id, current_user)
    await _editable(db, receipt)
    currency = body.currency.upper()
    if not is_supported(currency):
        raise HTTPException(status_code=400, detail=f"Unsupported currency: {currency}")
    members = await svc.member_users(db, receipt.conversation_id)

    old_items = {i.id: i for i in receipt.items}
    new_items: list[ReceiptItem] = []
    for position, item in enumerate(body.items):
        if item.split_mode not in ITEM_SPLIT_MODES:
            raise HTTPException(status_code=400, detail=f"Unknown split mode: {item.split_mode}")
        svc.require_members([a.user_id for a in item.assignments], members, "Everyone an item is for")
        for a in item.assignments:
            _decimal(a.value, "Quantity")
        old = old_items.get(item.id) if item.id else None
        new_items.append(ReceiptItem(
            position=position,
            raw_text=old.raw_text if old else None,
            name=item.name.strip(),
            quantity=_decimal(item.quantity, "Quantity") or Decimal(1),
            unit=item.unit,
            unit_price_minor=old.unit_price_minor if old else None,
            gross_minor=_minor(item.price, currency, "Price") or 0,
            category=(item.category or "").strip().lower() or None,
            flags=[f for f in dict.fromkeys(item.flags) if f in ITEM_FLAGS],
            tax_code=old.tax_code if old else None,
            confidence=old.confidence if old else None,
            split_mode=item.split_mode,
            assignments=[{"user_id": str(a.user_id), "value": a.value} for a in item.assignments],
            ai_suggestion_reason=old.ai_suggestion_reason if old else None,
            source_box=old.source_box if old else None,
        ))

    receipt.items = new_items
    receipt.adjustments = []
    await db.flush()  # new item ids

    for position, adj in enumerate(body.adjustments):
        if adj.kind not in ADJUSTMENT_KINDS:
            raise HTTPException(status_code=400, detail=f"Unknown adjustment: {adj.kind}")
        if adj.allocation not in ALLOCATIONS:
            raise HTTPException(status_code=400, detail=f"Unknown allocation: {adj.allocation}")
        if any(i < 0 or i >= len(new_items) for i in adj.item_indexes):
            raise HTTPException(status_code=400, detail=f"'{adj.label}' points at an item that isn't there")
        svc.require_members(adj.assignee_ids, members, "Everyone a charge is assigned to")
        percent = _decimal(adj.percent, "Percent")
        amount = _minor(adj.amount, currency, "Amount") or 0
        if adj.kind in pipeline.DISCOUNT_KINDS:
            amount = -abs(amount)
        item_ids = [new_items[i].id for i in dict.fromkeys(adj.item_indexes)]
        scope = "bill" if adj.allocation in ("equal", "assign") or not item_ids else ("item" if len(item_ids) == 1 else "group")
        receipt.adjustments.append(ReceiptAdjustment(
            position=position, kind=adj.kind, label=adj.label.strip(), amount_minor=amount, percent=percent,
            scope=scope, item_ids=item_ids, allocation=adj.allocation,
            assignee_ids=[str(u) for u in adj.assignee_ids], source=adj.source, enabled=adj.enabled,
        ))
    pipeline.refresh_percent_amounts(receipt)

    receipt.currency = currency
    receipt.store_name = (body.store_name or "").strip() or None
    receipt.store_key = pipeline.store_key(receipt.store_name)
    receipt.printed_total_minor = _minor(body.printed_total, currency, "Total")
    if body.payers is None:
        receipt.payers = None
    else:
        svc.require_members([p.user_id for p in body.payers], members, "Everyone who paid")
        payers: dict[str, int] = {}
        for p in body.payers:
            payers[str(p.user_id)] = payers.get(str(p.user_id), 0) + (_minor(p.amount, currency, "Paid amount") or 0)
        receipt.payers = [{"user_id": u, "amount_minor": a} for u, a in payers.items()]
    if receipt.status in ("ready", "needs_review", "failed"):
        receipt.status = "needs_review" if receipt.status == "failed" else receipt.status
    receipt.updated_at = datetime.now(timezone.utc)
    await db.flush()
    data = pipeline.serialize(receipt)
    await db.commit()
    return _ok(data, "Saved")


@router.post("/receipts/{receipt_id}/retry")
async def retry_receipt(
    receipt_id: uuid.UUID,
    background: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Read the photos again (replaces any edits). Only the uploader, since it uses their scans."""
    await rl.enforce((rl.RECEIPT_SCANS_PER_USER, str(current_user.id)))
    receipt, _ = await _load(db, receipt_id, current_user)
    if receipt.uploaded_by != current_user.id:
        raise HTTPException(status_code=403, detail="Only the person who uploaded it can scan it again")
    if receipt.status in ("processing", "saved"):
        raise HTTPException(status_code=409, detail="This receipt can't be scanned again now")
    try:
        api_key = await pipeline.prepare_scan(db, receipt, current_user)
    except pipeline.ScanSetupError as e:
        await db.rollback()
        raise _setup_error(e)
    receipt.updated_at = datetime.now(timezone.utc)
    await db.commit()
    background.add_task(pipeline.run_scan, receipt.id, api_key)
    return _ok(pipeline.serialize(receipt), "Reading the receipt again…")


@router.delete("/receipts/{receipt_id}")
async def discard_receipt(
    receipt_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    receipt, access = await _load(db, receipt_id, current_user)
    if receipt.status == "saved" or receipt.expense_id:
        raise HTTPException(status_code=400, detail="This receipt is part of an expense; delete the expense instead")
    if not (access.is_admin or receipt.uploaded_by == current_user.id):
        raise HTTPException(status_code=403, detail="Only the person who uploaded it or an admin can discard it")
    await db.delete(receipt)
    await db.commit()
    return _ok(None, "Receipt discarded")


async def _remember_assignments(db: AsyncSession, receipt: Receipt) -> None:
    """
    Next time 'oat milk' appears in this chat, suggest the same people. Only what differs from the
    default (the chat's rule for its category, else everyone) is remembered, so rules keep working.
    """
    member_ids = sorted(str(u) for u in await pipeline._member_ids(db, receipt.conversation_id))
    rules = await learning.split_rules(db, receipt.conversation_id)
    for item in receipt.items:
        user_ids = sorted({a["user_id"] for a in item.assignments or []})
        if not user_ids or "voided" in (item.flags or []):
            continue
        key = pipeline.item_key(item.name)
        if not key:
            continue
        rule = rules.get(learning.rule_category(item.category, item.flags or []) or "")
        default = sorted(u for u in rule.user_ids if u in member_ids) if rule and rule.user_ids else member_ids
        pref = await db.get(ItemPreference, (receipt.conversation_id, key))
        if user_ids == (default or member_ids):
            if pref is not None:
                await db.delete(pref)  # back to the default: nothing to remember
            continue
        if pref is None:
            db.add(ItemPreference(conversation_id=receipt.conversation_id, item_key=key, user_ids=user_ids, times_used=1))
        else:
            pref.user_ids = user_ids
            pref.times_used += 1


@router.post("/receipts/{receipt_id}/save")
async def save_receipt(
    receipt_id: uuid.UUID,
    body: SaveReceiptRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Turn the reviewed receipt into an itemized expense (or update the one it already made)."""
    receipt, _ = await _load(db, receipt_id, current_user)
    await _editable(db, receipt)
    if receipt.status == "failed" or not receipt.items:
        raise HTTPException(status_code=400, detail="There's nothing to save on this receipt")
    result, error = pipeline.compute(receipt)
    if error:
        raise HTTPException(status_code=400, detail=error)
    if result.unassigned_items:
        raise HTTPException(status_code=400, detail="Choose who each item is for first")
    if result.computed_total <= 0:
        raise HTTPException(status_code=400, detail="The total must be more than zero")
    currency = receipt.currency or "EUR"
    total = result.computed_total
    members = await svc.member_users(db, receipt.conversation_id)
    payers = {p["user_id"]: p["amount_minor"] for p in pipeline.effective_payers(receipt, total)}
    svc.require_members(payers, members, "Everyone who paid")
    try:
        validate_payers(total, payers)
    except MoneyError:
        raise HTTPException(
            status_code=400,
            detail=f"What people paid must add up to {format_minor(total, currency)}",
        )
    shares = {u: a for u, a in result.person_totals.items() if a != 0}
    svc.require_members(shares, members, "Everyone in the split")

    description = (body.description or receipt.store_name or "Receipt").strip()[:200]
    category = body.category if body.category in svc.CATEGORIES else "groceries"
    now = datetime.now(timezone.utc)
    expense = await db.get(Expense, receipt.expense_id) if receipt.expense_id else None
    if expense is not None and expense.deleted_at is None:
        before = svc.snapshot(expense)
        expense.description, expense.category, expense.currency, expense.total_minor = description, category, currency, total
        if body.spent_at:
            expense.spent_at = body.spent_at
        svc.set_parties(expense, payers, shares)
        expense.version += 1
        expense.updated_at = now
        await db.flush()
        after = svc.snapshot(expense)
        summary = "updated the receipt split: " + svc.describe_changes(before, after, members)
        svc.record(db, expense, current_user, "updated", summary, before, after)
        action, text = "updated", f"{current_user.username} updated '{description}' · {format_minor(total, currency)}"
    else:
        expense = Expense(
            id=uuid.uuid4(), conversation_id=receipt.conversation_id, description=description, category=category,
            currency=currency, total_minor=total, source="receipt", split_mode="itemized", receipt_id=receipt.id,
            created_by=current_user.id, spent_at=body.spent_at or receipt.purchased_at or now,
            version=1, created_at=now, updated_at=now,
        )
        svc.set_parties(expense, payers, shares)
        db.add(expense)
        await db.flush()
        svc.record(db, expense, current_user, "created",
                   f"added '{description}' from a receipt ({format_minor(total, currency)})", after=svc.snapshot(expense))
        action, text = "created", f"{current_user.username} added '{description}' · {format_minor(total, currency)} (receipt)"

    receipt.expense_id = expense.id
    receipt.status = "saved"
    receipt.updated_at = now
    await _remember_assignments(db, receipt)
    await learning.learn_corrections(db, receipt)
    member_ids, payload = await svc.post_card(db, expense, current_user, text)
    await publish_users(member_ids, payload)
    await publish_users(member_ids, svc.changed_event(expense, action))
    return _ok(svc.serialize(expense, receipt), "Expense saved")


# ------------------------------------------------------------------ split rules (per chat)

async def _rules_data(db: AsyncSession, conversation_id: uuid.UUID, access) -> dict:
    rules = await learning.split_rules(db, conversation_id)
    return {
        "categories": [{"key": k, "label": v} for k, v in learning.RECEIPT_CATEGORIES.items()],
        "rules": [
            {"category": c, "label": learning.RECEIPT_CATEGORIES.get(c, c), "user_ids": r.user_ids}
            for c, r in sorted(rules.items(), key=lambda kv: list(learning.RECEIPT_CATEGORIES).index(kv[0])
                               if kv[0] in learning.RECEIPT_CATEGORIES else 99)
        ],
        "can_edit": access.is_admin,
    }


@router.get("/conversations/{conversation_id}/split-rules")
async def get_split_rules(
    conversation_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Who items of each category are for by default when a receipt is scanned in this chat."""
    access = await svc.load_access(db, conversation_id, current_user)
    return _ok(await _rules_data(db, conversation_id, access))


@router.put("/conversations/{conversation_id}/split-rules")
async def update_split_rules(
    conversation_id: uuid.UUID,
    body: SplitRulesRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Replace the chat's rules. An empty people list means everyone, split equally."""
    access = await svc.load_access(db, conversation_id, current_user)
    if not access.is_admin:
        raise HTTPException(status_code=403, detail="Only group admins can change split rules")
    members = await svc.member_users(db, conversation_id)
    wanted: dict[str, list[str]] = {}
    for rule in body.rules:
        category = rule.category.strip().lower()
        if category not in learning.RECEIPT_CATEGORIES:
            raise HTTPException(status_code=400, detail=f"Unknown category: {rule.category}")
        svc.require_members(rule.user_ids, members, "Everyone in a rule")
        wanted[category] = sorted({str(u) for u in rule.user_ids})
    existing = await learning.split_rules(db, conversation_id)
    for category, row in existing.items():
        if category not in wanted:
            await db.delete(row)
    for category, user_ids in wanted.items():
        row = existing.get(category)
        if row is None:
            db.add(SplitRule(conversation_id=conversation_id, category=category, user_ids=user_ids, updated_by=current_user.id))
        else:
            row.user_ids, row.updated_by = user_ids, current_user.id
    await db.flush()
    data = await _rules_data(db, conversation_id, access)
    await db.commit()
    return _ok(data, "Rules saved")
