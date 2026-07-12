from __future__ import annotations

import sys
from pathlib import Path


ADMIN_KEY = "ADMIN_EMAILS"
FIRST_USER_KEY = "FIRST_USER_IS_ADMIN"


def read_text(path: Path) -> str:
    if not path.exists():
        return ""
    for encoding in ("utf-8-sig", "utf-8", "cp949"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    raise RuntimeError(f"Could not decode {path}")


def normalize_email(value: str) -> str:
    return value.strip().lower()


def update_env(path: Path, required_admins: list[str]) -> None:
    text = read_text(path)
    lines = text.splitlines()

    existing_admins: list[str] = []
    kept_lines: list[str] = []

    for line in lines:
        stripped = line.strip()
        upper = stripped.upper()

        if upper.startswith(f"{ADMIN_KEY}="):
            raw = stripped.split("=", 1)[1]
            existing_admins.extend(
                normalize_email(value)
                for value in raw.split(",")
                if normalize_email(value)
            )
            continue

        if upper.startswith(f"{FIRST_USER_KEY}="):
            continue

        kept_lines.append(line)

    merged: list[str] = []
    seen: set[str] = set()
    for email in [*existing_admins, *required_admins]:
        normalized = normalize_email(email)
        if normalized and normalized not in seen:
            seen.add(normalized)
            merged.append(normalized)

    while kept_lines and not kept_lines[-1].strip():
        kept_lines.pop()

    kept_lines.extend([
        "",
        f"{ADMIN_KEY}={','.join(merged)}",
        f"{FIRST_USER_KEY}=false",
        "",
    ])

    with path.open("w", encoding="utf-8", newline="\r\n") as handle:
        handle.write("\n".join(kept_lines))


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "Usage: sync_admin_env.py <env-path> <admin-email> [admin-email ...]",
            file=sys.stderr,
        )
        return 2

    env_path = Path(sys.argv[1])
    update_env(env_path, sys.argv[2:])
    print(f"Administrator settings updated: {env_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
