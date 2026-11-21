"""Asking a signed-in admin to prove it is them again before a sensitive change (keys, where data is sent)."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import totp
from app.core.deps import rate_limit
from app.core.errors import ApiError
from app.core.security import decrypt_field, verify_password
from app.models import User


async def confirm_identity(session: AsyncSession, user: User, password: str, code: str, *, purpose: str) -> None:
    """Passes only with the account password and, when two-step sign-in is on, the current authenticator code.

    Attempts are rate-limited per person and purpose. Call it before changing anything: a failed attempt
    commits the session so the rate-limit hit is kept.
    """
    await rate_limit(session, f"{purpose}:{user.id}", limit=30, window_seconds=600)
    if not verify_password(password, user.password_hash):
        await session.commit()  # keep the rate-limit hit
        raise ApiError("Your password is not correct", "wrong_password", 403, fields={"password": "Incorrect"})
    if user.totp_enabled and not totp.verify(decrypt_field(user.totp_secret_enc), code):
        await session.commit()
        raise ApiError("Enter the current 6-digit code from your authenticator app", "totp_required", 403, fields={"totp": "Required"})
