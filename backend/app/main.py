"""Sklenik API – FastAPI backend."""
import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

sys.path.insert(0, "/opt/webapps")

from app.config import sklenik_settings
from app.routers import (
    calendar,
    config_editor,
    dashboard,
    logs,
    profiles,
    scheduler,
    scripts,
    ssh_control,
    weather,
)
from app.services import scheduler_service

logging.basicConfig(
    level=getattr(logging, sklenik_settings.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("sklenik")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Sklenik API starting (DB=%s, SSH=%s@%s)",
                sklenik_settings.DB_NAME,
                sklenik_settings.SSH_USER, sklenik_settings.SSH_HOST)
    try:
        scheduler_service.start()
    except Exception:
        logger.exception("Scheduler start failed")
    yield
    try:
        scheduler_service.shutdown()
    except Exception:
        logger.exception("Scheduler shutdown failed")
    logger.info("Sklenik API stopping")


app = FastAPI(
    title="Sklenik API",
    description="API pro řízení automatizovaného skleníku",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://sklenik-web.local",
        "http://localhost",
        "http://localhost:5173",
        "http://portal.local",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(dashboard.router)
app.include_router(ssh_control.router)
app.include_router(config_editor.router)
app.include_router(logs.router)
app.include_router(scripts.router)
app.include_router(profiles.router)
app.include_router(scheduler.router)
app.include_router(calendar.router)
app.include_router(weather.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "app": "sklenik-backend", "version": "1.0.0"}


@app.get("/")
def root():
    return {"app": "Sklenik API", "docs": "/api/docs"}
