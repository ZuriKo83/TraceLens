import hashlib


def session_identity(user) -> str:
    """Bind a server session to this registration and its current password."""
    return hashlib.sha256(f"{user.id}|{user.email}|{user.password_hash}".encode("utf-8")).hexdigest()
