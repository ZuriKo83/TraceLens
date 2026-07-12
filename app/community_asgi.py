from fastapi import FastAPI

from app.community import router


community_app = FastAPI(
    title="TraceLens Community",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
community_app.include_router(router)
