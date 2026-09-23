from __future__ import annotations

import sys

import httpx

BASE = "http://127.0.0.1:8000"
PATHS = ["/community", "/community/chat", "/community/health"]


def main() -> int:
    failed = False
    with httpx.Client(base_url=BASE, follow_redirects=False, timeout=10) as client:
        for path in PATHS:
            try:
                response = client.get(path)
                ok = response.status_code in {200, 303, 401, 403}
                print(f"{path}: {response.status_code} {'OK' if ok else 'FAIL'}")
                failed = failed or not ok
            except Exception as exc:
                failed = True
                print(f"{path}: ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
