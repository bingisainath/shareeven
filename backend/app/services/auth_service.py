# backend/app/services/auth_service.py

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import secrets
import re

from app.models.user import User
from app.schemas.user import UserCreate
from app.schemas.auth import Token
from app.core.security import hash_password, verify_password, create_access_token, create_refresh_token

# Checked against when the account doesn't exist, so both failures take about as long
_DUMMY_HASH = hash_password("not-a-real-password")
from app.services import sessions
from app.services import admin as admin_service
from app.config.settings import settings
from app.core.email_check import email_problem


class AuthService:
    # -----------------------------
    # Helper: Email Detection
    # -----------------------------
    @staticmethod
    def is_email(identifier: str) -> bool:
        """Check if identifier is an email address"""
        email_pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
        return bool(re.match(email_pattern, identifier))

    # -----------------------------
    # Queries
    # -----------------------------
    @staticmethod
    async def get_user_by_email(db: AsyncSession, email: str) -> User | None:
        # Emails are case-insensitive (login, and the duplicate check at registration).
        # first() rather than one(): older data may hold case-variant duplicates.
        result = await db.execute(
            select(User).where(func.lower(User.email) == email.strip().lower()).order_by(User.created_at)
        )
        return result.scalars().first()

    @staticmethod
    async def get_user_by_username(db: AsyncSession, username: str) -> User | None:
        # Usernames are stored lowercase (schemas/user.py clean_username): "Alice" signs in as alice
        result = await db.execute(select(User).where(User.username == username.strip().lower()))
        return result.scalar_one_or_none()
    
    @staticmethod
    async def get_user_by_identifier(db: AsyncSession, identifier: str) -> User | None:
        """
        ✅ NEW: Get user by either username OR email
        This enables single-field login
        """
        if AuthService.is_email(identifier):
            return await AuthService.get_user_by_email(db, identifier)
        else:
            return await AuthService.get_user_by_username(db, identifier)
    
    @staticmethod
    def hash_reset_token(token: str) -> str:
        """Only this is stored: someone who reads the database can't use it to reset a password."""
        return hashlib.sha256(token.encode()).hexdigest()

    @staticmethod
    async def get_user_by_reset_token(db: AsyncSession, token: str) -> User | None:
        """Get user by password reset token (the one from the emailed link)"""
        if not token:
            return None
        result = await db.execute(select(User).where(User.reset_token == AuthService.hash_reset_token(token)))
        return result.scalar_one_or_none()

    # -----------------------------
    # Registration
    # -----------------------------
    @staticmethod
    async def create_user(db: AsyncSession, user_in: UserCreate) -> User:
        if settings.EMAIL_DOMAIN_CHECK:
            problem = await email_problem(user_in.email, user_in.email_typo_checked)
            if problem:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=problem)

        if await AuthService.get_user_by_email(db, user_in.email):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email already registered",
            )

        if await AuthService.get_user_by_username(db, user_in.username):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Username already taken",
            )

        user = User(
            username=user_in.username,
            email=user_in.email,
            hashed_password=hash_password(user_in.password),
            is_active=True,
        )

        db.add(user)
        await db.commit()
        await db.refresh(user)
        return user

    @staticmethod
    async def register_user(db: AsyncSession, user_in: UserCreate) -> User:
        return await AuthService.create_user(db, user_in)

    # -----------------------------
    # Authentication (Username OR Email)
    # -----------------------------
    @staticmethod
    async def authenticate_user(db: AsyncSession, identifier: str, password: str) -> User:
        """
        ✅ UPDATED: Authenticate with username OR email
        """
        user = await AuthService.get_user_by_identifier(db, identifier)

        # The same answer for an unknown account and a wrong password, so login can't be used
        # to find out which emails or usernames have accounts
        wrong = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Wrong username, email or password")
        if not user:
            verify_password(password, _DUMMY_HASH)  # same time either way
            raise wrong

        if not verify_password(password, user.hashed_password):
            raise wrong

        if not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="User account is inactive",
            )
        admin_service.refuse_sign_in_if_suspended(user)

        return user

    @staticmethod
    async def login_user(db: AsyncSession, identifier: str, password: str, user_agent: str | None = None) -> Token:
        """
        ✅ UPDATED: Login with username OR email
        """
        user = await AuthService.authenticate_user(db, identifier, password)
        if not user.email_verified:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "message": "Verify your email to continue. Enter the code we sent you",
                    "code": "email_not_verified",
                    "data": {"email": user.email},
                },
            )

        # Update last login; each sign-in is its own session
        user.last_login = datetime.now(timezone.utc)
        session_id = await sessions.start(db, user.id, user_agent)
        await db.commit()

        return AuthService.issue_tokens(user, session_id)

    # -----------------------------
    # Email verification codes
    # -----------------------------
    CODE_TTL = timedelta(minutes=10)
    CODE_MAX_ATTEMPTS = 5
    CODE_RESEND_SECONDS = 60

    @staticmethod
    def _code_hash(user: User, code: str) -> str:
        key = settings.JWT_SECRET_KEY.encode()
        return hmac.new(key, f"{user.id}:{code}".encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def new_email_code(user: User) -> str:
        """Create a fresh 6-digit code for the user (caller commits and emails it)."""
        code = f"{secrets.randbelow(1_000_000):06d}"
        now = datetime.now(timezone.utc)
        user.email_code_hash = AuthService._code_hash(user, code)
        user.email_code_expires = now + AuthService.CODE_TTL
        user.email_code_sent_at = now
        user.email_code_attempts = 0
        return code

    @staticmethod
    def resend_wait_seconds(user: User) -> int:
        if not user.email_code_sent_at:
            return 0
        elapsed = (datetime.now(timezone.utc) - user.email_code_sent_at).total_seconds()
        return max(0, int(AuthService.CODE_RESEND_SECONDS - elapsed))

    @staticmethod
    async def verify_email_code(db: AsyncSession, identifier: str, code: str) -> User:
        invalid = HTTPException(status_code=400, detail="That code isn't right. Check the email and try again")
        user = await AuthService.get_user_by_identifier(db, identifier)
        if user is None:
            raise invalid
        if user.email_verified:
            return user
        now = datetime.now(timezone.utc)
        if not user.email_code_hash or not user.email_code_expires or user.email_code_expires < now:
            raise HTTPException(status_code=400, detail="This code has expired. Send a new one")
        if user.email_code_attempts >= AuthService.CODE_MAX_ATTEMPTS:
            raise HTTPException(status_code=429, detail="Too many wrong codes. Send a new one")
        if not hmac.compare_digest(user.email_code_hash, AuthService._code_hash(user, code.strip())):
            user.email_code_attempts += 1
            await db.commit()
            raise invalid
        user.email_verified = True
        user.email_code_hash = None
        user.email_code_expires = None
        user.email_code_attempts = 0
        user.last_login = now
        await db.commit()
        return user

    @staticmethod
    def issue_tokens(user: User, session_id) -> Token:
        """Access + refresh token pair for one sign-in (session)"""
        sid = str(session_id)
        return Token(
            access_token=create_access_token(subject=str(user.id), session_id=sid),
            refresh_token=create_refresh_token(str(user.id), user.hashed_password, session_id=sid),
            token_type="bearer",
            expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        )

    # -----------------------------
    # ✅ NEW: Password Reset
    # -----------------------------
    @staticmethod
    async def request_password_reset(db: AsyncSession, identifier: str) -> tuple[bool, User | None, str | None]:
        """
        Request password reset (returns user if found, None otherwise)
        
        Returns:
            (success, user, token): the token goes in the emailed link and is never stored (only its hash)
        """
        user = await AuthService.get_user_by_identifier(db, identifier)
        
        if not user or user.deleted_at is not None:
            return (False, None, None)
        
        # Generate secure token
        reset_token = secrets.token_urlsafe(32)
        
        # Set expiration (1 hour)
        expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
        
        # Update user
        user.reset_token = AuthService.hash_reset_token(reset_token)
        user.reset_token_expires = expires_at
        await db.commit()
        
        return (True, user, reset_token)
    
    @staticmethod
    async def verify_reset_token(db: AsyncSession, token: str) -> User:
        """
        Verify reset token is valid and not expired
        
        Raises:
            HTTPException if token is invalid or expired
        """
        user = await AuthService.get_user_by_reset_token(db, token)
        
        if not user:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid or expired reset token"
            )
        
        # Check if expired
        now = datetime.now(timezone.utc)
        if user.reset_token_expires < now:
            # Clear expired token
            user.reset_token = None
            user.reset_token_expires = None
            await db.commit()
            
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Reset token has expired. Please request a new one."
            )
        
        return user
    
    @staticmethod
    async def reset_password(db: AsyncSession, token: str, new_password: str) -> User:
        """
        Reset password using valid token
        
        Token is single-use and will be cleared after successful reset
        """
        # Verify token
        user = await AuthService.verify_reset_token(db, token)
        
        # Hash new password
        user.hashed_password = hash_password(new_password)
        
        # Clear reset token (single-use)
        user.reset_token = None
        user.reset_token_expires = None
        
        await db.commit()
        await db.refresh(user)
        
        return user