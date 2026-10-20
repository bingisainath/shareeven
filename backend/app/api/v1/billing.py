# backend/app/api/v1/billing.py
# ShareEven Pro for the Plan page: prices, features and who takes the payment (set by app admins in
# Admin → Pro & payments), and the signed-in person's plan. Checkout and the providers' webhooks
# come here too when payments are wired in.

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.services import billing

router = APIRouter(prefix="/billing", tags=["Billing"])


@router.get("/plan")
async def plan(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """The Pro plan as admins set it, and this person's plan (everyone is on Free until payments open)."""
    return {"success": True, "data": {"pro": billing.public_plan(await billing.get_plan(db)), "current": {"plan": "free"}}}
