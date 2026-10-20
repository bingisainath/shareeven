# backend/app/services/billing.py
# ShareEven Pro: its prices, features and payment providers, set by app admins in the admin console
# (Admin → Pro & payments) and read by the Plan page on web and phone (GET /billing/plan).
# Stored as one JSON value in app_settings; until an admin saves one, DEFAULT_PLAN is used
# (the same numbers as web/mobile src/utils/plans.ts, which the apps fall back to when offline).

import json
import re
from typing import Dict, List

from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai import AppSetting

PLAN_KEY = "pro_plan"


class Price(BaseModel):
    monthly: int = Field(..., ge=1, le=100_000_000)  # minor units (paise, cents)
    yearly: int = Field(..., ge=1, le=1_000_000_000)


class Providers(BaseModel):
    razorpay: bool = True
    card: bool = True
    # Razorpay is offered only for these currencies (it settles in rupees)
    razorpay_currencies: List[str] = Field(default_factory=lambda: ["INR"], max_length=20)

    @field_validator("razorpay_currencies")
    @classmethod
    def _codes(cls, v: List[str]) -> List[str]:
        return _currency_codes(v)


class PlanConfig(BaseModel):
    # Off: the Plan page shows the plans but the button says payments aren't open yet
    payments_enabled: bool = False
    scans_per_month: int = Field(100, ge=1, le=10_000)
    prices: Dict[str, Price] = Field(..., min_length=1, max_length=20)
    features: List[str] = Field(..., min_length=1, max_length=8)
    providers: Providers = Field(default_factory=Providers)

    @field_validator("prices")
    @classmethod
    def _price_codes(cls, v: Dict[str, Price]) -> Dict[str, Price]:
        out = {}
        for code, price in v.items():
            out[_currency_codes([code])[0]] = price
        return out

    @field_validator("features")
    @classmethod
    def _features(cls, v: List[str]) -> List[str]:
        out = [f.strip() for f in v if f and f.strip()]
        if not out:
            raise ValueError("Add at least one feature")
        if any(len(f) > 120 for f in out):
            raise ValueError("Keep each feature under 120 characters")
        return out

    @model_validator(mode="after")
    def _sane(self) -> "PlanConfig":
        for code, p in self.prices.items():
            if p.yearly > p.monthly * 12:
                raise ValueError(f"{code}: a year costs more than twelve months")
        if not (self.providers.razorpay or self.providers.card):
            raise ValueError("Turn on at least one payment provider")
        return self


def _currency_codes(codes: List[str]) -> List[str]:
    out = []
    for c in codes:
        c = (c or "").strip().upper()
        if not re.fullmatch(r"[A-Z]{3}", c):
            raise ValueError(f"'{c}' isn't a currency code (3 letters, e.g. INR)")
        if c not in out:
            out.append(c)
    return out


DEFAULT_PLAN = PlanConfig(
    payments_enabled=False,
    scans_per_month=100,
    prices={
        "INR": Price(monthly=9900, yearly=99900),
        "EUR": Price(monthly=299, yearly=2999),
        "USD": Price(monthly=299, yearly=2999),
        "GBP": Price(monthly=249, yearly=2499),
    },
    features=[
        "{scans} receipt scans a month",
        "Everything in Free",
        "Helps keep ShareEven independent, ad-free and end-to-end encrypted",
    ],
)


async def get_plan(db: AsyncSession) -> PlanConfig:
    row = await db.get(AppSetting, PLAN_KEY)
    if row is None:
        return DEFAULT_PLAN
    try:
        return PlanConfig.model_validate(json.loads(row.value))
    except (ValueError, TypeError):
        return DEFAULT_PLAN  # a broken saved value never breaks the Plan page


async def save_plan(db: AsyncSession, plan: PlanConfig) -> None:
    value = plan.model_dump_json()
    row = await db.get(AppSetting, PLAN_KEY)
    if row is None:
        db.add(AppSetting(key=PLAN_KEY, value=value))
    else:
        row.value = value


def public_plan(plan: PlanConfig) -> dict:
    """What the apps get: features with {scans} filled in."""
    data = plan.model_dump()
    data["features"] = [f.replace("{scans}", str(plan.scans_per_month)) for f in plan.features]
    return data
