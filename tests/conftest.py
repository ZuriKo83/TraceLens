import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

TEST_DB = ROOT / "test_footprint.db"
if TEST_DB.exists():
    TEST_DB.unlink()

os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB.as_posix()}"
os.environ["SESSION_SECRET"] = "test-session-secret"
os.environ["DEBUG_MAGIC_LINKS"] = "true"
os.environ["FIRST_USER_IS_ADMIN"] = "false"
os.environ["PUBLIC_BASE_URL"] = "http://testserver"
os.environ["ADMIN_EMAILS"] = "owner@example.com"
