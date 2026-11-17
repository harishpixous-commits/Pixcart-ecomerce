"""Create (or reset the password of) an admin account.

    python -m scripts.create_admin --email ops@yourdomain.in --name "Ops Admin"
The password is read from the ADMIN_PASSWORD environment variable or prompted for (never echoed).
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import os
import re
import sys

from sqlalchemy import select

from app.core.security import hash_password
from app.db import SessionLocal, engine
from app.models import User


def strong(pw: str) -> bool:
    return len(pw) >= 12 and re.search(r"[a-z]", pw) and re.search(r"[A-Z]", pw) and re.search(r"\d", pw) is not None


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--name", default="Admin")
    args = ap.parse_args()
    pw = os.environ.get("ADMIN_PASSWORD") or getpass.getpass("Admin password (min 12 chars, upper, lower, digit): ")
    if not strong(pw):
        sys.exit("Password is too weak")
    async with SessionLocal() as s:
        user = (await s.execute(select(User).where(User.email == args.email.lower()))).scalar_one_or_none()
        if user is None:
            user = User(email=args.email.lower(), name=args.name)
            s.add(user)
        user.password_hash = hash_password(pw)
        user.is_admin = True
        user.is_active = True
        await s.commit()
    await engine.dispose()
    print(f"Admin ready: {args.email.lower()}")


if __name__ == "__main__":
    asyncio.run(main())
