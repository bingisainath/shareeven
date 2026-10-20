import logging
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

import app.models
from app.config.settings import settings
from app.core.errors import CatchUnhandledErrors
from app.core.logging import setup_logging
from app.api.v1 import api_router
from app.websocket.routes import router as ws_router

setup_logging()

_DEFAULT_JWT_SECRET = "your-secret-key-change-this-in-production"


def production_problems(s=settings) -> list[str]:
    """Settings that must not reach production (the API refuses to start with them)."""
    if s.ENV != "production":
        return []
    problems = []
    if not s.JWT_SECRET_KEY or s.JWT_SECRET_KEY == _DEFAULT_JWT_SECRET or len(s.JWT_SECRET_KEY) < 32:
        problems.append("JWT_SECRET_KEY is the default or too short")
    if not s.MEDIA_ENCRYPTION_KEY:
        problems.append("MEDIA_ENCRYPTION_KEY is empty (uploads would depend on JWT_SECRET_KEY)")
    if getattr(s, "RECEIPT_OCR_DEBUG_DIR", ""):
        problems.append("RECEIPT_OCR_DEBUG_DIR is set (it writes what receipts say to disk unencrypted)")
    if _password(getattr(s, "DATABASE_URL", "")) in DEV_PASSWORDS:
        problems.append("DATABASE_URL uses a development password")
    razorpay = [getattr(s, k, "") for k in ("RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET")]
    if any(razorpay) and not all(razorpay):
        problems.append("Set all three of RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET, or none")
    if razorpay[0].startswith("rzp_test_"):
        problems.append("RAZORPAY_KEY_ID is a test key (rzp_test_...)")
    return problems


DEV_PASSWORDS = {"papyris", "password", "postgres"}


def _password(url: str) -> str | None:
    """The password in postgresql+asyncpg://user:password@host/db, or None."""
    from urllib.parse import urlsplit
    try:
        return urlsplit(url).password
    except ValueError:
        return None


def production_warnings(s=settings) -> list[str]:
    """Worth fixing before real users, but not a reason to stay down."""
    if s.ENV != "production":
        return []
    warnings = []
    redis = getattr(s, "REDIS_URL", "")
    if redis and "@" not in redis and not redis.startswith(("redis://localhost", "redis://127.0.0.1")):
        warnings.append("REDIS_URL has no password")
    if any("localhost" in o or "127.0.0.1" in o for o in getattr(s, "CORS_ORIGINS", [])):
        warnings.append("CORS_ORIGINS still allows localhost")
    if not getattr(s, "RAZORPAY_KEY_ID", ""):
        warnings.append("RAZORPAY_* aren't set: nobody can pay for Pro, even with payments turned on")
    return warnings


def docs_urls(s=settings) -> dict:
    """The interactive API docs list every endpoint: only outside production."""
    if s.ENV == "production":
        return {"docs_url": None, "redoc_url": None, "openapi_url": None}
    return {}


if production_problems():
    raise RuntimeError("Refusing to start in production: " + "; ".join(production_problems()))
for _warning in production_warnings():
    logging.getLogger(__name__).warning("Production setting to fix: %s", _warning)

app = FastAPI(title=settings.APP_NAME, **docs_urls())


class SecurityHeaders:
    """Headers that stop browsers sniffing types or framing API responses (HTTP only, not WebSocket)."""

    HEADERS = [
        (b"x-content-type-options", b"nosniff"),
        (b"x-frame-options", b"DENY"),
        (b"referrer-policy", b"no-referrer"),
    ]

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def with_headers(message):
            if message["type"] == "http.response.start":
                names = {k.lower() for k, _ in message.get("headers", [])}
                message.setdefault("headers", [])
                message["headers"] = list(message["headers"]) + [h for h in self.HEADERS if h[0] not in names]
                if settings.ENV == "production" and b"strict-transport-security" not in names:
                    message["headers"].append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
            await send(message)

        await self.app(scope, receive, with_headers)


# Order matters: middleware added later wraps earlier ones, so CORS stays outermost
app.add_middleware(SecurityHeaders)
app.add_middleware(CatchUnhandledErrors)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ✅ Wrap FastAPI HTTPException -> {success:false, message, data:null}
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    # detail may be {"message": ..., "code": ...} when clients need to react to a specific case
    detail = exc.detail
    content = {"success": False, "message": detail, "data": None}
    if isinstance(detail, dict):
        content.update(message=detail.get("message"), code=detail.get("code"), data=detail.get("data"))
    return JSONResponse(status_code=exc.status_code, content=content, headers=getattr(exc, "headers", None))

def _first_validation_message(errors) -> str:
    for error in errors:
        message = str(error.get("msg") or "")
        if message.startswith("Value error, "):
            return message[len("Value error, "):]
    return "Please check the highlighted fields"


# ✅ Wrap validation errors too (422)
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "success": False,
            # The first problem in plain words (e.g. "Use 3-30 lowercase letters...")
            "message": _first_validation_message(exc.errors()),
            # Only plain fields: ctx can hold exception objects that can't be sent as JSON
            "data": [{k: e.get(k) for k in ("loc", "msg", "type")} for e in exc.errors()],
        },
    )

app.include_router(api_router, prefix="/api/v1")

app.include_router(ws_router, prefix="/api/v1")

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/")
async def root():
    return {"message": "Backend works"}
