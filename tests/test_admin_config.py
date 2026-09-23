from pathlib import Path
import subprocess
import sys

from app.config import Settings


def test_multiple_admin_emails_preserve_order_and_remove_duplicates() -> None:
    settings = Settings(
        admin_emails="First@Example.com,second@example.com,first@example.com"
    )
    assert settings.admin_email_list == [
        "first@example.com",
        "second@example.com",
    ]
    assert settings.admin_email_set == {
        "first@example.com",
        "second@example.com",
    }


def test_sync_admin_env_merges_existing_and_required_admins(tmp_path: Path) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text(
        "APP_NAME=TraceLens\n"
        "ADMIN_EMAILS=extra@example.com,drkoby0803@gmail.com\n"
        "FIRST_USER_IS_ADMIN=true\n",
        encoding="utf-8",
    )

    script = Path(__file__).resolve().parents[1] / "tools" / "sync_admin_env.py"
    result = subprocess.run(
        [
            sys.executable,
            str(script),
            str(env_path),
            "drkoby0803@gmail.com",
            "drkoby@naver.com",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    updated = env_path.read_text(encoding="utf-8")
    assert (
        "ADMIN_EMAILS=extra@example.com,drkoby0803@gmail.com,drkoby@naver.com"
        in updated
    )
    assert "FIRST_USER_IS_ADMIN=false" in updated
    assert "FIRST_USER_IS_ADMIN=true" not in updated
