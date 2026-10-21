
"""
User Model
"""
import uuid
import enum
from sqlalchemy import Column, String, Boolean, Date, DateTime, Integer, Text, Enum as SQLEnum
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.db.base import Base


class UserStatus(str, enum.Enum):
    """User account status"""
    ACTIVE = "active"
    INACTIVE = "inactive"
    SUSPENDED = "suspended"


class Gender(str, enum.Enum):
    """User gender options"""
    MALE = "male"
    FEMALE = "female"
    OTHER = "other"
    NOT_SPECIFIED = ""


class User(Base):
    """
    User model with comprehensive profile information.
    Enhanced from MongoDB version with proper PostgreSQL types.
    """
    __tablename__ = "users"

    # Core Identity
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    username = Column(String(50), nullable=False, unique=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    
    # Profile Information
    name = Column(String(100), nullable=True)  # Full display name
    phone = Column(String(20), nullable=True)
    date_of_birth = Column(DateTime(timezone=False), nullable=True)
    gender = Column(SQLEnum(Gender, name="gender_enum"), default=Gender.NOT_SPECIFIED)
    address = Column(Text, nullable=True)
    bio = Column(String(500), nullable=True)
    
    # Media
    avatar = Column(String, nullable=True)  # URL to profile picture

    # Where people in your chats can pay you: {"revolut": "...", "paypal": "...", "upi": "..."}
    payment_handles = Column(JSONB, nullable=True)

    # Expense totals are also shown converted to this currency (ISO code); None = off
    display_currency = Column(String(3), nullable=True)
    
    # Social IDs (for OAuth integration - future)
    google_id = Column(String, nullable=True, unique=True)
    facebook_id = Column(String, nullable=True, unique=True)
    
    # Account Status
    is_active = Column(Boolean, default=True)
    # Account deleted by its owner: personal data removed, the row kept as "Deleted user" so
    # shared expenses and payments still add up for everyone else
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    # App-wide admin (manages AI models and limits). Set with scripts/make_admin.py
    is_app_admin = Column(Boolean, default=False, server_default="false", nullable=False)
    # Suspended by an app admin: can't sign in or use the app until suspended_until (None = until
    # an admin lifts it). Local keys stay on their devices, so a lifted suspension loses nothing.
    suspended_at = Column(DateTime(timezone=True), nullable=True)
    suspended_until = Column(DateTime(timezone=True), nullable=True)
    suspension_reason = Column(String(500), nullable=True)
    # Receipt scans, set by app admins: a monthly limit for this person instead of the app's
    # (None = the app's), and extra scans that count only in the month they were given
    scan_limit_override = Column(Integer, nullable=True)
    extra_scans = Column(Integer, default=0, server_default="0", nullable=False)
    extra_scans_month = Column(Date, nullable=True)
    # ShareEven Pro is on until then (paid for or given by an admin; None or past = Free), and the
    # smallest "days before it ends" reminder already sent for that date (reset when it moves)
    pro_until = Column(DateTime(timezone=True), nullable=True, index=True)
    pro_reminded_days = Column(Integer, nullable=True)
    status = Column(SQLEnum(UserStatus, name="user_status_enum"), default=UserStatus.ACTIVE)
    
    # Email verification: a 6-digit code is emailed after sign-up (only its hash is stored)
    email_verified = Column(Boolean, default=False, server_default="false", nullable=False)
    email_code_hash = Column(String(64), nullable=True)
    email_code_expires = Column(DateTime(timezone=True), nullable=True)
    email_code_sent_at = Column(DateTime(timezone=True), nullable=True)
    email_code_attempts = Column(Integer, default=0, server_default="0", nullable=False)

    # Password Reset Fields
    reset_token = Column(String(255), nullable=True, index=True)
    reset_token_expires = Column(DateTime(timezone=True), nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    last_login = Column(DateTime(timezone=True), nullable=True)
    
    # Online Status (can be moved to Redis for real-time)
    is_online = Column(Boolean, default=False)
    last_seen = Column(DateTime(timezone=True), nullable=True)

    def suspended_now(self, now=None) -> bool:
        """Suspended, and the suspension hasn't run out."""
        from datetime import datetime, timezone
        if self.suspended_at is None:
            return False
        return self.suspended_until is None or self.suspended_until > (now or datetime.now(timezone.utc))

    def __repr__(self):
        return f"<User(id={self.id}, username={self.username}, email={self.email})>"