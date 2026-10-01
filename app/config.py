from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "TraceLens"
    database_url: str = "sqlite:///./tracelens.db"
    session_secret: str = "change-this-before-public-deployment"
    public_base_url: str = "http://127.0.0.1:8021"
    extension_store_url: str = ""
    admin_emails: str = ""
    first_user_is_admin: bool = False
    secure_cookies: bool = False
    debug_magic_links: bool = True
    login_token_minutes: int = 20
    verification_code_minutes: int = 5
    verification_max_attempts: int = 5
    collector_token_days: int = 30
    collector_max_items: int = 1000
    redis_url: str = "redis://127.0.0.1:6379/0"
    queue_name: str = "collector"
    session_cookie_name: str = "tracelens_session"
    session_max_age_seconds: int = 2592000
    session_redis_prefix: str = "session:"
    rate_limit_login_per_minute: int = 10
    rate_limit_verification_per_hour: int = 5
    rate_limit_collector_per_minute: int = 30
    scan_log_retention_days: int = 30
    scan_archive_dir: str = "./archives"
    scan_archive_delete_delay_hours: int = 24
    backup_dir: str = "./backups"
    backup_retention_days: int = 14

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def admin_email_list(self) -> list[str]:
        result: list[str] = []
        seen: set[str] = set()
        for value in self.admin_emails.split(","):
            email = value.strip().lower()
            if email and email not in seen:
                seen.add(email)
                result.append(email)
        return result

    @property
    def admin_email_set(self) -> set[str]:
        return set(self.admin_email_list)


@lru_cache
def get_settings() -> Settings:
    return Settings()
