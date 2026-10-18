# backend/app/config/settings.py

from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List


class Settings(BaseSettings):
    # Environment
    ENV: str = "local"  # local, staging, production
    
    # Application
    APP_NAME: str = "ShareEven API"
    DEBUG: bool = True
    LOG_LEVEL: str = "INFO"  # DEBUG shows every WebSocket event and worker step
    SQL_ECHO: bool = False  # log every SQL statement (very noisy)
    
    # Database
    DATABASE_URL: str = "postgresql+asyncpg://postgres:password@localhost:5432/papyris"
    
    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"
    redis_dsn: str = "redis://localhost:6379/0"  # Alias for compatibility
    
    # JWT Authentication
    JWT_SECRET_KEY: str = "your-secret-key-change-this-in-production"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60  # 1 hour; clients renew via /auth/refresh
    REFRESH_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days
    
    # CORS
    CORS_ORIGINS: List[str] = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
    ]
    
    # Media uploads (stored on local disk, served by /api/v1/media)
    MAX_UPLOAD_SIZE: int = 10 * 1024 * 1024  # 10MB - images and documents
    MAX_VIDEO_UPLOAD_SIZE: int = 50 * 1024 * 1024  # 50MB
    UPLOAD_DIR: str = "uploads"  # relative paths resolve against the backend/ directory
    # Encrypts uploaded files on disk: 32 random bytes, base64. Generate with
    #   python -c "import secrets,base64;print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
    # Never change or lose it once files exist (they can't be read without it).
    # Empty = derived from JWT_SECRET_KEY (then never change that either).
    MEDIA_ENCRYPTION_KEY: str = ""
    
    # Receipt scanning. Keys live only here on the server, never in the app.
    ANTHROPIC_API_KEY: str = ""
    # Needed only when ANTHROPIC_API_KEY isn't scoped to a workspace (Console > Settings > Workspaces)
    ANTHROPIC_WORKSPACE_ID: str = ""
    OPENAI_API_KEY: str = ""
    # Encrypts the AI keys people add themselves; falls back to one derived from JWT_SECRET_KEY
    AI_KEY_ENCRYPTION_SECRET: str = ""
    RECEIPT_SCANS_PER_MONTH: int = 100  # per person; admins can change it in the admin console
    # Measured on real receipts (2026-10): Opus 5 at medium read all 7 right, cheaper and faster than at high
    RECEIPT_AI_EFFORT: str = "medium"
    RECEIPT_AI_TIMEOUT_SECONDS: int = 120
    RECEIPT_MAX_IMAGES: int = 4
    # Cheap path: OCR on this server's CPU (receipt_ai/ocr.py), then this text model (~3 cents a scan).
    # Photos go to the admins' model only when the OCR read doesn't add up. Empty = always photos.
    # Measured on 8 real receipts (2026-10): Sonnet 5 at low effort added up on 6, Haiku 4.5 on 2.
    RECEIPT_OCR_MODEL: str = "claude-sonnet-5"
    RECEIPT_OCR_EFFORT: str = "low"
    RECEIPT_OCR_MIN_CONFIDENCE: float = 0.95  # below this, the photo is too unclear for the text path
    RECEIPT_OCR_THREADS: int = 4  # CPU threads for OCR; one photo is read at a time

    # Email (sign-up codes, password resets). With SMTP_USER and SMTP_PASSWORD set, emails are
    # really sent; without them (local development) they are written to the backend log instead.
    # Production: a sending service for shareeven.com (e.g. Resend: smtp.resend.com, port 465,
    # user "resend", password = its API key) with FROM_EMAIL=noreply@shareeven.com.
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587  # 587 = STARTTLS, 465 = TLS from the start
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    FROM_EMAIL: str = ""  # defaults to SMTP_USER
    FROM_NAME: str = "ShareEven"
    REPLY_TO: str = "support@shareeven.com"  # replies to noreply@ reach a person
    # Sign-up: refuse email domains that can't receive mail, and suggest fixes for typos (gmial.com)
    EMAIL_DOMAIN_CHECK: bool = True
    FRONTEND_URL: str = "http://localhost:3000"  # used in password-reset links

    # Push notifications (Firebase Cloud Messaging). Path to the service-account JSON downloaded
    # from Firebase console > Project settings > Service accounts. Empty = no push notifications.
    FIREBASE_SERVICE_ACCOUNT_FILE: str = ""
    PUSH_SHOW_MESSAGE_TEXT: bool = True  # False: notifications only say "New message"

    # WebSocket
    WS_HEARTBEAT_INTERVAL: int = 30  # seconds
    WS_MAX_CONNECTIONS_PER_USER: int = 5
    
    # Limits on logins, sign-ups, uploads, messages... (app/core/rate_limit.py), counted in Redis
    RATE_LIMITS_ENABLED: bool = True

    # Message worker's name in the Redis consumer group. Empty = "worker-<hostname>".
    # Give each worker a different name when running several on one machine.
    WORKER_NAME: str = ""

    # Redis Streams
    STREAM_KEY: str = "papyris:messages"
    CONSUMER_GROUP: str = "papyris-workers"
    STREAM_MAX_LEN: int = 100000
    
    # ✅ Pydantic v2 configuration - allows extra fields from .env
    model_config = SettingsConfigDict(
        env_file=".env",
        case_sensitive=True,
        extra='ignore'  # ✅ This ignores unknown fields from .env
    )


# Create global settings instance
settings = Settings()