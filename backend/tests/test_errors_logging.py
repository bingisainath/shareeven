import logging
import uuid

from jose import jwt

from app.config.settings import settings
from app.main import app


async def test_unexpected_errors_are_generic_and_keep_cors(client):
    async def boom():
        raise RuntimeError("secret internal detail")

    app.add_api_route("/api/v1/_test_boom", boom)
    try:
        r = await client.get("/api/v1/_test_boom", headers={"Origin": "http://localhost:3000"})
    finally:
        app.router.routes = [route for route in app.router.routes if getattr(route, "path", "") != "/api/v1/_test_boom"]
    assert r.status_code == 500
    assert r.json()["success"] is False
    assert "secret" not in r.text
    # browsers can read the error (CORS headers present on the 500)
    assert r.headers.get("access-control-allow-origin") == "http://localhost:3000"


async def test_reset_token_never_logged_by_auth(client, db, make_user, caplog, monkeypatch):
    from app.models.user import User

    from app.api.v1 import auth as auth_api

    user = await make_user()
    links = []
    monkeypatch.setattr(auth_api.email_service, "send_password_reset_email", lambda to, name, link: links.append(link) or True)
    with caplog.at_level(logging.DEBUG, logger="app.api.v1.auth"):
        r = await client.post("/api/v1/auth/forgot-password", json={"identifier": user.email})
    assert r.status_code == 200
    token = links[0].split("token=")[1]
    auth_logs = [rec.getMessage() for rec in caplog.records if rec.name == "app.api.v1.auth"]
    assert auth_logs and not any(token in m for m in auth_logs)

    # Only a hash is stored: the database alone can't reset anyone's password
    stored = (await db.get(User, uuid.UUID(user.id), populate_existing=True)).reset_token
    assert stored and stored != token and len(stored) == 64
    r = await client.post("/api/v1/auth/reset-password", json={"token": stored, "new_password": "An0ther!Passw0rd"})
    assert r.status_code >= 400
    r = await client.post("/api/v1/auth/reset-password", json={"token": token, "new_password": "An0ther!Passw0rd"})
    assert r.status_code == 200, r.text
    r = await client.post("/api/v1/auth/reset-password", json={"token": token, "new_password": "Th1rd!Passw0rd"})
    assert r.status_code >= 400  # single use


async def test_malformed_subject_is_401_not_500(client):
    token = jwt.encode({"sub": "not-a-uuid", "type": "access"}, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    r = await client.get("/api/v1/conversations", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_tokens_and_signatures_are_redacted_in_server_logs():
    from app.core.logging import RedactSecrets

    record = logging.LogRecord(
        "uvicorn.error", logging.INFO, __file__, 1, '%s - "WebSocket %s" [accepted]',
        (("127.0.0.1", 5000), "/api/v1/ws/chat?token=eyJsecret.payload.sig"), None,
    )
    RedactSecrets().filter(record)
    assert "eyJsecret" not in record.getMessage() and "token=[redacted]" in record.getMessage()

    record = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1, "GET %s", ("/api/v1/media/a.png?exp=1&sig=abc123",), None,
    )
    RedactSecrets().filter(record)
    assert record.getMessage() == "GET /api/v1/media/a.png?exp=1&sig=[redacted]"


async def test_security_headers(client):
    r = await client.get("/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"


def test_production_settings_are_checked():
    from types import SimpleNamespace
    from app.main import docs_urls, production_problems
    dev = SimpleNamespace(ENV="local", JWT_SECRET_KEY="", MEDIA_ENCRYPTION_KEY="")
    assert production_problems(dev) == [] and docs_urls(dev) == {}
    weak = SimpleNamespace(ENV="production", JWT_SECRET_KEY="your-secret-key-change-this-in-production", MEDIA_ENCRYPTION_KEY="")
    assert len(production_problems(weak)) == 2
    good = SimpleNamespace(ENV="production", JWT_SECRET_KEY="x" * 44, MEDIA_ENCRYPTION_KEY="k" * 44,
                           DATABASE_URL="postgresql+asyncpg://app:Long-Random-1@db:5432/shareeven", RECEIPT_OCR_DEBUG_DIR="")
    assert production_problems(good) == []
    leaky = SimpleNamespace(**{**vars(good), "RECEIPT_OCR_DEBUG_DIR": "ocr_debug", "DATABASE_URL": "postgresql+asyncpg://papyris:papyris@db/x"})
    assert [p.split(" ")[0] for p in production_problems(leaky)] == ["RECEIPT_OCR_DEBUG_DIR", "DATABASE_URL"]
    assert docs_urls(good) == {"docs_url": None, "redoc_url": None, "openapi_url": None}


def test_production_warnings():
    from types import SimpleNamespace
    from app.main import production_warnings
    loose = SimpleNamespace(ENV="production", REDIS_URL="redis://redis:6379/0", CORS_ORIGINS=["http://localhost:3000", "https://shareeven.com"])
    assert production_warnings(loose) == ["REDIS_URL has no password", "CORS_ORIGINS still allows localhost",
                                          "RAZORPAY_* aren't set: nobody can pay for Pro, even with payments turned on"]
    tight = SimpleNamespace(ENV="production", REDIS_URL="redis://:secret@redis:6379/0", CORS_ORIGINS=["https://shareeven.com"],
                            RAZORPAY_KEY_ID="rzp_live_abc")
    assert production_warnings(tight) == []
