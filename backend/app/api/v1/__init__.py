# backend/app/api/v1/__init__.py

from fastapi import APIRouter

from app.api.v1.auth import router as auth_router
from app.api.v1.chat import router as chat_router
from app.api.v1.media import router as media_router
from app.api.v1.messages import router as messages_router
from app.api.v1.groups import router as groups_router
from app.api.v1.safety import router as safety_router
from app.api.v1.support import router as support_router
from app.api.v1.admin import router as admin_router
from app.api.v1.expenses import router as expenses_router
from app.api.v1.receipts import router as receipts_router
from app.api.v1.ai_settings import router as ai_settings_router
from app.api.v1.shared_media import router as shared_media_router
from app.api.v1.devices import router as devices_router
from app.api.v1.e2e_keys import router as e2e_keys_router
from app.api.v1.e2e_v2 import router as e2e_v2_router
from app.api.v1.e2e_backup import router as e2e_backup_router
from app.api.v1.billing import router as billing_router

api_router = APIRouter()

# Auth routes
api_router.include_router(auth_router)

# Chat / Conversations routes
api_router.include_router(chat_router)

# Conversation details and group management
api_router.include_router(groups_router)

# Media uploads / downloads
api_router.include_router(media_router)

# Message actions (edit, delete, react)
api_router.include_router(messages_router)

# Expenses, settle up and balances
api_router.include_router(expenses_router)

# Receipt scanning
api_router.include_router(receipts_router)

# Scans used this month, store discounts, app admin (receipt model and limit)
api_router.include_router(ai_settings_router)

# Media, links and docs shared in a chat
api_router.include_router(shared_media_router)

# Phones' push notification tokens
api_router.include_router(devices_router)

# End-to-end encryption keys
api_router.include_router(e2e_keys_router)

# End-to-end encryption v2: device keys, prekeys, signed device lists, mailboxes
api_router.include_router(e2e_v2_router)

# Optional end-to-end encrypted backup
api_router.include_router(e2e_backup_router)


# Blocking people, reports, and report review for app admins
api_router.include_router(safety_router)

# The admin console (app admins only)
api_router.include_router(admin_router)

# Support requests (and app admins answering them)
api_router.include_router(support_router)

# ShareEven Pro: prices and features for the Plan page
api_router.include_router(billing_router)
