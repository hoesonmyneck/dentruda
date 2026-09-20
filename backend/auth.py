"""Authentication: password hashing (stdlib pbkdf2), JWT httponly cookie, current-user dependency.

Упрощённая версия: только пароль + JWT-cookie. Без ЭЦП/SSO/белого списка.
"""
import os
import hmac
import base64
import hashlib
from datetime import datetime, timedelta, timezone

from fastapi import Request, HTTPException, Depends
from sqlalchemy.orm import Session
from jose import jwt, JWTError

from database import engine, User

JWT_SECRET = os.environ.get("JWT_SECRET", "change-me-in-prod-9f3a2b7c1d8e4f60")
JWT_ALGORITHM = "HS256"
ACCESS_TTL_HOURS = 12
COOKIE_NAME = "access_token"


# ── Password hashing (stdlib pbkdf2, no extra deps) ──────────────────────────
def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return "pbkdf2_sha256$200000$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_password(password: str, stored: str) -> bool:
    try:
        _algo, iters, salt_b64, dk_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(dk_b64)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(iters))
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


# ── Access token (JWT in httponly cookie) ────────────────────────────────────
def create_access_token(user: User) -> str:
    payload = {
        "sub": "access",
        "uid": user.id,
        "login": user.login,
        "role": user.role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=ACCESS_TTL_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def set_auth_cookie(response, token: str):
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=ACCESS_TTL_HOURS * 3600,
        path="/",
    )


def clear_auth_cookie(response):
    response.delete_cookie(COOKIE_NAME, path="/")


def _decode_access(token: str) -> dict:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Недействительная сессия")
    if payload.get("sub") != "access":
        raise HTTPException(status_code=401, detail="Недействительная сессия")
    return payload


def current_user(request: Request) -> User:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    payload = _decode_access(token)
    with Session(engine) as db:
        user = db.get(User, payload.get("uid"))
        if not user:
            raise HTTPException(status_code=401, detail="Пользователь не найден")
        db.expunge(user)
        return user


def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Доступ только для администратора")
    return user


# ── Seed first admin ─────────────────────────────────────────────────────────
def seed_admin():
    """Create the initial admin from env (or defaults) if no admin exists yet."""
    login = os.environ.get("ADMIN_LOGIN", "admin")
    password = os.environ.get("ADMIN_PASSWORD", "crtr2026")
    with Session(engine) as db:
        exists = db.query(User).filter(User.role == "admin").first()
        if exists:
            return
        db.add(User(login=login, password_hash=hash_password(password), role="admin"))
        db.commit()
        print(f"Seeded admin user '{login}'")
