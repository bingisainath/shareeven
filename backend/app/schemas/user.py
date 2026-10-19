# backend/app/schemas/user.py

import re

from pydantic import BaseModel, EmailStr, Field, field_serializer, field_validator
from uuid import UUID
from datetime import datetime
from typing import Optional

USERNAME_RE = re.compile(r"[a-z0-9._]{3,30}")


def clean_username(v: str) -> str:
    """Usernames, at sign-up and when changed: 3-30 lowercase letters, numbers, dots or underscores."""
    v = v.strip().lower()
    if not USERNAME_RE.fullmatch(v):
        raise ValueError("Use 3-30 lowercase letters, numbers, dots or underscores")
    return v


class UserCreate(BaseModel):
    username: str = Field(max_length=50)  # rules in clean_username
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    # True after "Did you mean …?" when the person kept their own address
    email_typo_checked: bool = False

    @field_validator('username')
    @classmethod
    def username_format(cls, v: str) -> str:
        return clean_username(v)

class UserLogin(BaseModel):
    """
    ✅ NEW: Accept either username OR email in a single 'identifier' field
    This makes the frontend simpler - just one input field
    """
    identifier: str = Field(description="Username or email")
    password: str
    
    @field_validator('identifier')
    @classmethod
    def validate_identifier(cls, v: str) -> str:
        if not v or len(v.strip()) < 3:
            raise ValueError('Identifier must be at least 3 characters')
        return v.strip()

class UserResponse(BaseModel):
    id: UUID
    username: str
    email: EmailStr
    name: Optional[str] = None
    bio: Optional[str] = None
    avatar: Optional[str] = None
    payment_handles: Optional[dict] = None
    display_currency: Optional[str] = None
    is_app_admin: bool = False  # reviews reports, manages AI models
    is_active: bool
    email_verified: bool = True
    created_at: datetime

    class Config:
        from_attributes = True

    @field_serializer("avatar")
    def sign_avatar(self, avatar: Optional[str]) -> Optional[str]:
        # Uploaded avatars are served through expiring signed links
        from app.services.media_storage import sign_url
        return sign_url(avatar)


class PaymentHandles(BaseModel):
    """Payment app usernames shown to people in your chats (empty string removes one)."""
    revolut: Optional[str] = Field(None, max_length=40, pattern=r"^$|^@?[A-Za-z0-9._-]{2,40}$")
    paypal: Optional[str] = Field(None, max_length=40, pattern=r"^$|^[A-Za-z0-9]{1,40}$")
    upi: Optional[str] = Field(None, max_length=100, pattern=r"^$|^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9]{2,32}$")

    def merged_into(self, current: Optional[dict]) -> Optional[dict]:
        """Apply the fields that were sent ("" removes one) to the saved ones."""
        out = dict(current or {})
        for key, value in self.model_dump(exclude_unset=True).items():
            value = (value or "").strip().lstrip("@")
            if value:
                out[key] = value
            else:
                out.pop(key, None)
        return out or None


class DeleteAccountRequest(BaseModel):
    """Deleting needs the password and the word DELETE typed out, so it never happens by accident."""
    password: str = Field(..., min_length=1, max_length=128)
    confirm: str = Field(..., max_length=20)


class UserUpdate(BaseModel):
    """Profile fields a user can change. Omitted fields are left as they are."""
    name: Optional[str] = Field(None, max_length=100)
    username: Optional[str] = Field(None, max_length=50)  # rules in clean_username
    bio: Optional[str] = Field(None, max_length=500)
    avatar: Optional[str] = Field(None, description="Uploaded image URL, or empty string to remove")
    payment_handles: Optional[PaymentHandles] = None
    # Also show expense totals in this currency ("" turns it off)
    display_currency: Optional[str] = Field(None, max_length=3)

    @field_validator('display_currency')
    @classmethod
    def known_currency(cls, v: Optional[str]) -> Optional[str]:
        from app.services.money import is_supported
        if v is None or v == "":
            return v
        v = v.upper()
        if not is_supported(v):
            raise ValueError('Unknown currency')
        return v

    @field_validator('name', 'username', 'bio')
    @classmethod
    def strip_text(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() if isinstance(v, str) else v

    @field_validator('username')
    @classmethod
    def username_format(cls, v: Optional[str]) -> Optional[str]:
        return None if v is None else clean_username(v)