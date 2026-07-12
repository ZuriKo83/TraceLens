from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator


class CollectorItem(BaseModel):
    external_id: str = Field(min_length=1, max_length=500)
    activity_type: str = Field(default="activity", min_length=1, max_length=80)
    title: str = Field(default="", max_length=2000)
    content: str = Field(default="", max_length=20000)
    source_url: str | None = Field(default=None, max_length=4000)
    occurred_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class CollectorImport(BaseModel):
    account_label: str | None = Field(default=None, max_length=160)
    collector_email: str | None = Field(default=None, max_length=320)
    platform: str = Field(min_length=1, max_length=50, pattern=r"^[a-z0-9_-]+$")
    source_url: str | None = Field(default=None, max_length=4000)
    status: str = Field(default="success", pattern=r"^(success|partial|login_required|error)$")
    scan_scope: str = Field(default="default", min_length=1, max_length=80, pattern=r"^[a-z0-9_-]+$")
    message: str = Field(default="", max_length=2000)
    items: list[CollectorItem] = Field(default_factory=list)

    @field_validator("items")
    @classmethod
    def prevent_empty_noise(cls, value: list[CollectorItem]) -> list[CollectorItem]:
        return [item for item in value if item.title.strip() or item.content.strip() or item.source_url]
