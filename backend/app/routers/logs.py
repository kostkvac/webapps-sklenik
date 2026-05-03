"""Logs router – tail logs over SSH."""
from fastapi import APIRouter, HTTPException, Query

from app.services import ssh_service

router = APIRouter(prefix="/api/logs", tags=["logs"])


@router.get("/available")
def available_logs():
    return {"logs": sorted(ssh_service.ALLOWED_LOGS)}


@router.get("/{log_name}")
def get_log(log_name: str, lines: int = Query(50, ge=1, le=500)):
    try:
        content = ssh_service.tail_log(log_name, lines)
    except ssh_service.SSHError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"log": log_name, "lines": lines, "content": content}
