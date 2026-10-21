"""
Create a ready-to-use test account (email already verified), for trying the app with several people.

    python scripts/create_test_user.py <username> [--email EMAIL] [--password PASSWORD] [--name NAME]

Without --email it uses <username>@example.com (a domain reserved for examples: no real mailbox, and unlike
.test or .local it passes the email check on /auth/me). Only someone with access to
the server and its database can run this. Don't use it on a production server.
"""

import argparse
import asyncio
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import func, or_, select  # noqa: E402

from app.core.security import hash_password  # noqa: E402
from app.db.session import async_session_maker, engine  # noqa: E402
from app.models import User  # noqa: E402


async def main(username: str, email: str, password: str, name: str | None) -> int:
    if not re.fullmatch(r"[a-z0-9._]{3,30}", username):
        print("Usernames are 3-30 lowercase letters, numbers, dots or underscores")
        return 1
    if len(password) < 8:
        print("Use a password of at least 8 characters")
        return 1
    async with async_session_maker() as db:
        taken = (await db.execute(select(User).where(or_(User.username == username, func.lower(User.email) == email.lower())))).scalar_one_or_none()
        if taken is not None:
            print(f"There's already an account with the username {username!r} or email {email!r}")
            return 1
        db.add(User(username=username, email=email.lower(), hashed_password=hash_password(password), name=name or username,
                    email_verified=True, is_active=True))
        await db.commit()
    await engine.dispose()
    print(f"Created {username!r} ({email}). Sign in with that username and the password you chose.")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Create a verified test account")
    parser.add_argument("username")
    parser.add_argument("--email")
    parser.add_argument("--password", default="Passw0rd!23")
    parser.add_argument("--name")
    args = parser.parse_args()
    sys.exit(asyncio.run(main(args.username, args.email or f"{args.username}@example.com", args.password, args.name)))
