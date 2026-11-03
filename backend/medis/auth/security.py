"""
MEDIS Security & Authentication Utilities
Handles password hashing, JWT token generation/validation, and tamper-evident audit logging.
"""

import os
import hashlib
import hmac
import secrets
import csv
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
import jwt

SECRET_KEY = os.environ.get("MEDIS_SECRET_KEY", "medis-clinical-platform-secure-key-2026")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 24 hours

AUDIT_CSV_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "logs", "audit.csv"))
os.makedirs(os.path.dirname(AUDIT_CSV_PATH), exist_ok=True)


def hash_password(password: str) -> str:
    """Hashes a password with salt using PBKDF2-HMAC-SHA256."""
    salt = secrets.token_hex(16)
    pwd_hash = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        iterations=100000
    ).hex()
    return f"{salt}${pwd_hash}"


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verifies a plain password against the stored salt$hash."""
    try:
        salt, pwd_hash = hashed_password.split("$", 1)
        test_hash = hashlib.pbkdf2_hmac(
            "sha256",
            plain_password.encode("utf-8"),
            salt.encode("utf-8"),
            iterations=100000
        ).hex()
        return hmac.compare_digest(pwd_hash, test_hash)
    except Exception:
        return False


def create_access_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    """Generates a signed JWT access token."""
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta if expires_delta else timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire, "iat": datetime.utcnow()})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
    """Decodes and validates a JWT token."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except Exception:
        return None


def log_audit_event(
    actor_id: str,
    actor_role: str,
    action: str,
    resource: str,
    details: str = "",
    ip_address: str = "127.0.0.1",
    db=None
):
    """
    Logs an action to both database audit_logs table and cryptographic audit.csv log chain.
    """
    now = datetime.utcnow()
    iso_time = now.isoformat()
    raw_payload = f"{iso_time}|{actor_id}|{actor_role}|{action}|{resource}|{details}"
    event_hash = hashlib.sha256(raw_payload.encode("utf-8")).hexdigest()

    # 1. Append to CSV log chain
    file_exists = os.path.exists(AUDIT_CSV_PATH)
    try:
        with open(AUDIT_CSV_PATH, mode="a", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            if not file_exists:
                writer.writerow(["timestamp", "actor_id", "actor_role", "action", "resource", "details", "ip_address", "tamper_hash"])
            writer.writerow([iso_time, actor_id, actor_role, action, resource, details, ip_address, event_hash])
    except Exception as e:
        print(f"[Warning] Could not write audit CSV: {e}")

    # 2. Append to database table if db session provided
    if db is not None:
        try:
            from medis.database.models import AuditLog
            audit_entry = AuditLog(
                timestamp=now,
                actor_id=actor_id,
                actor_role=actor_role,
                action=action,
                resource=resource,
                details=details,
                ip_address=ip_address,
                tamper_hash=event_hash
            )
            db.add(audit_entry)
            db.commit()
        except Exception as e:
            db.rollback()
            print(f"[Warning] Could not write database audit log: {e}")

    return event_hash

