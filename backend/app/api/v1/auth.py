# backend/app/api/v1/auth.py - FIXED LOGGING VERSION

from fastapi import APIRouter, Depends, HTTPException, Request, status, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
import logging

from app.db.session import get_db
from app.schemas.user import DeleteAccountRequest, UserCreate, UserLogin, UserResponse, UserUpdate
from app.services import media_storage
from sqlalchemy import select, func
from app.schemas.auth import Token, RefreshTokenRequest, ForgotPasswordRequest, VerifyResetTokenRequest, ResetPasswordRequest
from app.core.security import decode_token, password_fingerprint
from uuid import UUID
from app.schemas.response import APIResponse
from app.services.auth_service import AuthService
from app.services import sessions
from app.services import admin as admin_service
from app.services.email_service import email_service
from app.config.settings import settings
from app.api.dependencies import get_current_user
from app.core import rate_limit as rl
from app.core.security import verify_password
from app.services import account
from app.services.message_service import MessageService
from app.websocket.routes import publish_users
from fastapi.responses import JSONResponse
from datetime import date
from app.models.user import User
from app.schemas.auth import (
    VerifyEmailRequest, ResendCodeRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Auth"])

# ============================================
# REGISTRATION
# ============================================
@router.post("/register", response_model=APIResponse[UserResponse], status_code=201)
async def register(payload: UserCreate, request: Request, background: BackgroundTasks, db: AsyncSession = Depends(get_db)):
    """Register a new user and email them a 6-digit code to verify their address"""
    await rl.enforce((rl.REGISTER_PER_IP, rl.client_ip(request)))
    user = await AuthService.register_user(db, payload)
    code = AuthService.new_email_code(user)
    await db.commit()
    background.add_task(email_service.send_verification_code, user.email, user.username, code)
    logger.info("Verification code sent to new user %s", user.id)
    return APIResponse(
        success=True,
        message="Account created. Enter the code we emailed you",
        data=user,
    )


@router.post("/verify-email", response_model=APIResponse[Token])
async def verify_email(payload: VerifyEmailRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """Check the emailed code; on success the person is signed in"""
    await rl.enforce((rl.VERIFY_EMAIL_PER_IP, rl.client_ip(request)))
    user = await AuthService.verify_email_code(db, payload.identifier, payload.code)
    logger.info("Email verified for user %s", user.id)
    admin_service.refuse_sign_in_if_suspended(user)
    session_id = await sessions.start(db, user.id, request.headers.get("user-agent"))
    await db.commit()
    return APIResponse(success=True, message="Email verified", data=AuthService.issue_tokens(user, session_id))


@router.post("/resend-code", response_model=APIResponse[dict])
async def resend_code(payload: ResendCodeRequest, request: Request, background: BackgroundTasks, db: AsyncSession = Depends(get_db)):
    """Email a new code. Same answer whether or not the account exists."""
    await rl.enforce((rl.RESEND_CODE_PER_IP, rl.client_ip(request)))
    user = await AuthService.get_user_by_identifier(db, payload.identifier)
    if user is not None and not user.email_verified:
        wait = AuthService.resend_wait_seconds(user)
        if wait:
            raise HTTPException(status_code=429, detail=f"Wait {wait} seconds before asking for another code")
        code = AuthService.new_email_code(user)
        await db.commit()
        background.add_task(email_service.send_verification_code, user.email, user.username, code)
    return APIResponse(success=True, message="If that account needs a code, we've sent a new one", data={"sent": True})

# ============================================
# LOGIN (✅ Username OR Email)
# ============================================
@router.post("/login", response_model=APIResponse[Token])
async def login(payload: UserLogin, request: Request, db: AsyncSession = Depends(get_db)):
    """
    ✅ UPDATED: Login with username OR email
    
    The frontend sends 'identifier' which can be either username or email
    """
    await rl.enforce((rl.LOGIN_PER_IP, rl.client_ip(request)), (rl.LOGIN_PER_ACCOUNT, payload.identifier))
    token = await AuthService.login_user(db, payload.identifier, payload.password, request.headers.get("user-agent"))
    return APIResponse(
        success=True,
        message="Login successful",
        data=token,
    )


@router.post("/refresh", response_model=APIResponse[Token])
async def refresh(payload: RefreshTokenRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """
    Exchange a refresh token for a new access + refresh token pair.
    Fails if the token expired, the user is inactive, or the password changed since.
    """
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Session expired. Please log in again.",
    )
    try:
        claims = decode_token(payload.refresh_token)
    except HTTPException:
        raise invalid
    if claims.get("type") != "refresh" or not claims.get("sub"):
        raise invalid

    user = await db.get(User, UUID(claims["sub"]))
    if user is None or not user.is_active or claims.get("pwd") != password_fingerprint(user.hashed_password):
        raise invalid
    if user.suspended_now():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=admin_service.SUSPENDED)
    # Same sign-in as before; logged out (here or from another device) means signing in again
    if not await sessions.is_active(db, claims.get("sid"), user.id):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=sessions.LOGGED_OUT)
    session_id = claims.get("sid") or await sessions.start(db, user.id, request.headers.get("user-agent"))
    await db.commit()

    return APIResponse(
        success=True,
        message="Token refreshed",
        data=AuthService.issue_tokens(user, session_id),
    )

# ============================================
# GET CURRENT USER
# ============================================
@router.get("/me", response_model=APIResponse[UserResponse])
async def me(current_user: User = Depends(get_current_user)):
    """Get current authenticated user"""
    return APIResponse(
        success=True,
        message="User fetched successfully",
        data=current_user,
    )


@router.patch("/me", response_model=APIResponse[UserResponse])
async def update_me(
    payload: UserUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update the current user's profile (name, username, bio, avatar)"""
    if payload.username is not None and payload.username.lower() != current_user.username.lower():
        taken = (await db.execute(
            select(User.id).where(func.lower(User.username) == payload.username.lower(), User.id != current_user.id)
        )).scalar_one_or_none()
        if taken:
            raise HTTPException(status_code=409, detail="Username is already taken")
        current_user.username = payload.username

    if payload.name is not None:
        current_user.name = payload.name or None
    if payload.bio is not None:
        current_user.bio = payload.bio or None
    if payload.avatar is not None:
        if payload.avatar and not media_storage.is_stored_image_url(payload.avatar):
            raise HTTPException(status_code=400, detail="Avatar must be an uploaded image")
        current_user.avatar = media_storage.unsigned(payload.avatar) or None
    if payload.payment_handles is not None:
        current_user.payment_handles = payload.payment_handles.merged_into(current_user.payment_handles)
    if payload.display_currency is not None:
        current_user.display_currency = payload.display_currency or None

    db.add(current_user)
    await db.commit()
    await db.refresh(current_user)

    return APIResponse(
        success=True,
        message="Profile updated successfully",
        data=current_user,
    )

# ============================================
# YOUR DATA: download it, or delete the account
# ============================================
@router.get("/me/export")
async def export_my_data(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Everything the server holds about you, as a JSON file (GDPR / DPDP data access)"""
    await rl.enforce((rl.DATA_EXPORTS_PER_USER, str(current_user.id)))
    data = await account.export_data(db, current_user)
    filename = f"shareeven-data-{current_user.username}-{date.today().isoformat()}.json"
    return JSONResponse(content=data, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.post("/me/delete", response_model=APIResponse[dict])
async def delete_my_account(
    payload: DeleteAccountRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Delete your account: sign-ins, devices, keys, backups, settings, photos and what your
    messages said are removed. Shared expenses and payments stay, shown as "Deleted user", so
    other people's balances don't change. Every signed-in device is signed out.
    """
    await rl.enforce((rl.DELETE_ACCOUNT_PER_USER, str(current_user.id)))
    if payload.confirm.strip().upper() != "DELETE":
        raise HTTPException(status_code=400, detail="Type DELETE to confirm")
    if not verify_password(payload.password, current_user.hashed_password):
        raise HTTPException(status_code=401, detail="Wrong password")

    await delete_and_announce(db, current_user)
    return APIResponse(success=True, message="Your account has been deleted", data={"deleted": True})


async def delete_and_announce(db: AsyncSession, user: User) -> None:
    """Delete the account (services/account.py), then sign out its devices and tell its groups."""
    user_id = str(user.id)
    result = await account.delete_account(db, user)
    account.remove_files(await account.unused_files(db, result["files"]))

    # Every device of this account signs out and wipes its keys; groups see a note
    await publish_users([user_id], {"type": "account_deleted"})
    for conversation_id, member_ids in result["left_groups"]:
        try:
            note = await MessageService.post_system_message(
                db, conversation_id, user, f"{result['old_name']} deleted their account")
            await publish_users(member_ids, note)
            await publish_users(member_ids, {"type": "conversation_updated", "conversationId": str(conversation_id)})
        except Exception:
            logger.exception("Couldn't tell group %s about a deleted account", conversation_id)


# ============================================
# ✅ NEW: FORGOT PASSWORD
# ============================================
@router.post("/forgot-password", response_model=APIResponse[dict])
async def forgot_password(
    payload: ForgotPasswordRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db)
):
    """
    Email a password-reset link. Says plainly when no account matches: sign-up already tells
    people an email is taken, so hiding it here protected nothing. Rate limits (per IP and per
    account) stop anyone using this to check emails in bulk.
    """
    await rl.enforce((rl.FORGOT_PER_IP, rl.client_ip(request)), (rl.FORGOT_PER_ACCOUNT, payload.identifier))
    success, user, token = await AuthService.request_password_reset(db, payload.identifier)
    if not (success and user):
        logger.info("Password reset requested for an unknown account")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"message": "We couldn't find a ShareEven account with that username or email.", "code": "account_not_found"},
        )

    reset_link = f"{settings.FRONTEND_URL}/reset-password?token={token}"
    # Never log the link or token: anyone reading logs could reset the password.
    # (Without SMTP configured, email_service logs the email in dev mode instead.)
    logger.info("Password reset requested for user %s", user.id)
    background_tasks.add_task(email_service.send_password_reset_email, user.email, user.username, reset_link)
    return APIResponse(
        success=True,
        message="Reset link sent",
        # Partly hidden: someone who typed a username only learns where to look
        data={"email_sent": True, "email": mask_email(user.email)},
    )


def mask_email(email: str) -> str:
    """bingisainath27@gmail.com -> bi•••@gmail.com"""
    local, _, domain = email.partition("@")
    return f"{local[:2]}•••@{domain}" if domain else "your email"


# ============================================
# ✅ NEW: VERIFY RESET TOKEN
# ============================================
@router.post("/verify-reset-token", response_model=APIResponse[dict])
async def verify_reset_token(
    payload: VerifyResetTokenRequest,
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    Verify if reset token is valid and not expired
    
    Called when user clicks reset link to check if they can proceed
    """
    await rl.enforce((rl.RESET_PER_IP, rl.client_ip(request)))
    try:
        user = await AuthService.verify_reset_token(db, payload.token)
        

        return APIResponse(
            success=True,
            message="Token is valid",
            data={
                "valid": True,
                "email": user.email,
                "username": user.username
            }
        )
    except HTTPException as e:
        raise e
    except Exception:
        logger.exception("verify-reset-token failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server error while verifying token"
        )

# ============================================
# ✅ NEW: RESET PASSWORD
# ============================================
@router.post("/reset-password", response_model=APIResponse[dict])
async def reset_password(
    payload: ResetPasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    Reset password using valid token
    
    Token is single-use and will be cleared after successful reset
    """
    await rl.enforce((rl.RESET_PER_IP, rl.client_ip(request)))
    try:
        user = await AuthService.reset_password(db, payload.token, payload.new_password)
        
        logger.info("Password reset completed for user %s", user.id)

        return APIResponse(
            success=True,
            message="Password has been reset successfully",
            data={"password_reset": True}
        )
    except HTTPException as e:
        raise e
    except Exception:
        logger.exception("reset-password failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to reset password"
        )

# ============================================
# HEALTH CHECK
# ============================================
@router.get("/ping", response_model=APIResponse[dict])
async def ping():
    """Health check endpoint"""
    return APIResponse(
        success=True, 
        message="auth alive", 
        data={"message": "auth alive"}
    )